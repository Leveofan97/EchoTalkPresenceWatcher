// presence-name-resolver.mjs (ESM + DEBUG logs)

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import vdf from 'vdf';
import plist from 'plist';

const DEBUG = false;
const HOME = os.homedir();

function debug(...args) {
  if (!DEBUG) return;
  console.log('[resolver]', ...args);
}

export function createNameResolver({
                                     userDataDir,
                                     knownMap = new Map(),
                                     platform = process.platform,       // 'win32' | 'darwin' | 'linux'
                                   } = {}) {

  const cachePath = path.join(userDataDir, 'presence-cache.json');
  let cache = { byExe: {}, byPath: {}, updatedAt: Date.now() };

  // ---- helpers ----
  const exeBase = fp => (fp ? path.basename(fp).toLowerCase() : '');
  const lower = s => (s || '').toLowerCase();

  const loadCache = async () => {
    try {
      const txt = await fsp.readFile(cachePath, 'utf8');
      const json = JSON.parse(txt);
      if (json && typeof json === 'object') {
        cache = { ...cache, ...json };
        debug('cache loaded', {
          byExe: Object.keys(cache.byExe).length,
          byPath: Object.keys(cache.byPath).length,
          updatedAt: new Date(cache.updatedAt).toISOString(),
        });
      }
    } catch (e) {
      debug('cache load: none/failed → starting fresh', String(e?.message || e));
    }
  };

  const saveCacheSoon = (() => {
    let timer = null;
    return () => {
      if (timer) return;
      timer = setTimeout(async () => {
        try {
          await fsp.mkdir(path.dirname(cachePath), { recursive: true });
          await fsp.writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf8');
          debug('cache saved', {
            byExe: Object.keys(cache.byExe).length,
            byPath: Object.keys(cache.byPath).length,
          });
        } catch (e) {
          debug('cache save error', String(e?.message || e));
        }
        timer = null;
      }, 500);
    };
  })();

  const putCache = (exePath, name) => {
    if (!name) return;
    const ex = exeBase(exePath);
    let touched = 0;
    if (ex && cache.byExe[ex] !== name) {
      cache.byExe[ex] = name;
      touched++;
    }
    const pLower = exePath ? lower(exePath) : null;
    if (pLower && cache.byPath[pLower] !== name) {
      cache.byPath[pLower] = name;
      touched++;
    }
    if (touched) {
      cache.updatedAt = Date.now();
      debug('cache put', { ex, exePath, name });
      saveCacheSoon();
    }
  };

  // ---- кросплатформенный обход директорий известных лаунчеров ----
  const steamCandidates = (() => {
    // типичные места Steam
    const win = [
      'C:\\Program Files (x86)\\Steam\\steamapps',
      'C:\\Program Files\\Steam\\steamapps',
      path.join(HOME, 'AppData', 'Local', 'Steam', 'steamapps'),
    ];
    const mac = [
      path.join(HOME, 'Library', 'Application Support', 'Steam', 'steamapps'),
    ];
    const lin = [
      path.join(HOME, '.local', 'share', 'Steam', 'steamapps'),
      '/usr/local/share/Steam/steamapps',
    ];
    return platform === 'win32' ? win : platform === 'darwin' ? mac : lin;
  })();

  async function scanSteam() {
    const t0 = Date.now();
    const result = new Map(); // exePathLower -> DisplayName
    let libFoldersRead = 0;
    let manifestsProcessed = 0;
    let resolvedExecs = 0;

    for (const sap of steamCandidates) {
      try {
        const libPath = path.join(sap, 'libraryfolders.vdf');
        const txt = await fsp.readFile(libPath, 'utf8');
        libFoldersRead++;
        const jf = vdf.parse(txt);

        const libs = Object.values(jf.libraryfolders || {}).map(v => v.path || v).filter(Boolean);
        const libDirs = [path.dirname(libPath), ...libs.map(p => path.join(p, 'steamapps'))];

        for (const dir of libDirs) {
          let files = [];
          try { files = await fsp.readdir(dir); } catch { continue; }
          for (const f of files) {
            if (!f.startsWith('appmanifest_') || !f.endsWith('.acf')) continue;
            try {
              const t = await fsp.readFile(path.join(dir, f), 'utf8');
              const man = vdf.parse(t).AppState || {};
              manifestsProcessed++;

              const name = man.name;
              const installdir = man.installdir;
              if (!name || !installdir) continue;

              // Путь до папки игры
              const commonDir = path.join(dir, 'common', installdir);

              let foundExe = null;
              if (platform === 'win32') {
                const exes = await findExecutablesWindows(commonDir, 2);
                foundExe = exes[0] || null;
              } else if (platform === 'darwin') {
                const appPath = await findAppBundleMac(commonDir, 2);
                foundExe = appPath || null;
              }
              if (foundExe) {
                result.set(lower(foundExe), name);
                resolvedExecs++;
                if (DEBUG && resolvedExecs <= 5) {
                  debug('steam exec', { name, exe: foundExe });
                }
              }
            } catch (e) {
              if (DEBUG) debug('steam manifest parse error', f, String(e?.message || e));
            }
          }
        }
      } catch (e) {
        if (DEBUG) debug('steam library read fail', sap, String(e?.message || e));
      }
    }

    debug('steam scan done', {
      candidatesRoots: steamCandidates.length,
      libFoldersRead,
      manifestsProcessed,
      resolvedExecs,
      ms: Date.now() - t0,
    });
    return result;
  }

  async function findExecutablesWindows(dir, depth = 1) {
    const out = [];
    async function dfs(d, lvl) {
      if (lvl < 0) return;
      let entries = [];
      try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (['redist','_commonredist'].includes(e.name.toLowerCase())) continue;
          await dfs(p, lvl - 1);
        } else if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) {
          out.push(p);
        }
      }
    }
    await dfs(dir, depth);
    if (DEBUG && out.length) debug('win exe candidates', dir, out.slice(0, 3));
    return out;
  }

  async function findAppBundleMac(dir, depth = 1) {
    let found = null;
    async function dfs(d, lvl) {
      if (found || lvl < 0) return;
      let entries = [];
      try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name.endsWith('.app')) { found = p; return; }
          await dfs(p, lvl - 1);
        }
      }
    }
    await dfs(dir, depth);
    if (DEBUG && found) debug('mac app found', found);
    return found;
  }

  async function scanEpic() {
    const t0 = Date.now();
    const result = new Map(); // exePathLower -> DisplayName
    if (platform !== 'win32') {
      debug('epic scan skipped (not win32)');
      return result;
    }
    const manifestDir = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';
    let files = [];
    try { files = await fsp.readdir(manifestDir); } catch (e) {
      debug('epic manifest dir not found', manifestDir, String(e?.message || e));
      return result;
    }

    let parsed = 0, resolved = 0;
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.item')) continue;
      try {
        const t = await fsp.readFile(path.join(manifestDir, f), 'utf8');
        const j = JSON.parse(t);
        parsed++;
        const name = j.DisplayName;
        const install = j.InstallLocation;
        const exeRel = j.LaunchExecutable;
        if (!name || !install || !exeRel) continue;
        const exeAbs = path.join(install, exeRel);
        result.set(lower(exeAbs), name);
        resolved++;
        if (DEBUG && resolved <= 5) debug('epic exec', { name, exe: exeAbs });
      } catch (e) {
        if (DEBUG) debug('epic parse error', f, String(e?.message || e));
      }
    }
    debug('epic scan done', { files: files.length, parsed, resolved, ms: Date.now() - t0 });
    return result;
  }

  async function fileDescriptionWindows(exePath) {
    return new Promise((resolve) => {
      const ps = spawn('powershell.exe', [
        '-NoProfile', '-Command',
        `(Get-Item -LiteralPath '${exePath.replace(/'/g, "''")}').VersionInfo.FileDescription`
      ], { windowsHide: true });
      let out = '';
      ps.stdout.on('data', d => out += d.toString());
      ps.on('close', () => {
        const s = out.trim();
        if (DEBUG) debug('win file description', { exePath, description: s || null });
        resolve(s || null);
      });
      ps.on('error', (e) => {
        if (DEBUG) debug('win file description error', exePath, String(e?.message || e));
        resolve(null);
      });
    });
  }

  async function macBundleName(appPath) {
    try {
      const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
      const txt = await fsp.readFile(infoPlist, 'utf8');
      const p = plist.parse(txt);
      const name = p.CFBundleDisplayName || p.CFBundleName || path.basename(appPath, '.app');
      if (DEBUG) debug('mac bundle name', { appPath, name });
      return name;
    } catch (e) {
      if (DEBUG) debug('mac bundle name error', appPath, String(e?.message || e));
      return null;
    }
  }

  async function linuxDesktopName(exePath) {
    const candidates = [
      '/usr/share/applications',
      '/usr/local/share/applications',
      path.join(HOME, '.local', 'share', 'applications'),
    ];
    const base = path.basename(exePath);
    for (const dir of candidates) {
      let files = [];
      try { files = await fsp.readdir(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.desktop')) continue;
        try {
          const t = await fsp.readFile(path.join(dir, f), 'utf8');
          if (!t.includes('Name=') || !t.includes('Exec=')) continue;
          if (!t.toLowerCase().includes(base.toLowerCase())) continue;
          const nameLine = t.split('\n').find(l => l.startsWith('Name='));
          if (nameLine) {
            const name = nameLine.slice(5).trim();
            if (DEBUG) debug('linux .desktop name', { exePath, name, desktop: f });
            return name;
          }
        } catch {}
      }
    }
    if (DEBUG) debug('linux .desktop name not found', exePath);
    return null;
  }

  // ---- init scans (выполняются один раз при старте) ----
  let precomputedPaths = new Map(); // pathLower -> DisplayName
  async function warmup() {
    debug('warmup start');
    await loadCache();

    try {
      const steam = await scanSteam();
      for (const [p, n] of steam) precomputedPaths.set(p, n);
      debug('warmup steam loaded', { entries: steam.size });
    } catch (e) {
      debug('warmup steam error', String(e?.message || e));
    }

    try {
      const epic = await scanEpic();
      for (const [p, n] of epic) precomputedPaths.set(p, n);
      debug('warmup epic loaded', { entries: epic.size });
    } catch (e) {
      debug('warmup epic error', String(e?.message || e));
    }

    debug('warmup done', { precomputed: precomputedPaths.size });
  }

  // ---- основной резолвер ----
  async function resolveDisplayName({ exePath, processName, windowTitle }) {
    const ex = exeBase(exePath) || lower(processName);

    // 1) KNOWN
    if (ex && knownMap.has(ex)) {
      const name = knownMap.get(ex);
      DEBUG && debug('resolve: KNOWN', { ex, name });
      return name;
    }

    // 2) CACHE
    if (ex && cache.byExe[ex]) {
      const name = cache.byExe[ex];
      DEBUG && debug('resolve: CACHE byExe', { ex, name });
      return name;
    }
    if (exePath) {
      const byPath = cache.byPath[lower(exePath)];
      if (byPath) {
        DEBUG && debug('resolve: CACHE byPath', { exePath, name: byPath });
        return byPath;
      }
    }

    // 3) PRECOMPUTED (Steam/Epic)
    if (exePath && precomputedPaths.size) {
      const p = lower(exePath);
      const found = precomputedPaths.get(p);
      if (found) {
        DEBUG && debug('resolve: PRECOMPUTED', { exePath, name: found });
        putCache(exePath, found);
        return found;
      }
    }

    // 4) FILE METADATA
    if (platform === 'win32' && exePath) {
      const fd = await fileDescriptionWindows(exePath);
      if (fd && fd.length >= 3) {
        DEBUG && debug('resolve: FILEDESC', { exePath, name: fd });
        putCache(exePath, fd);
        return fd;
      }
    }
    if (platform === 'darwin' && exePath && exePath.endsWith('.app')) {
      const nm = await macBundleName(exePath);
      if (nm) {
        DEBUG && debug('resolve: MAC BUNDLE', { exePath, name: nm });
        putCache(exePath, nm);
        return nm;
      }
    }
    if (platform === 'linux' && exePath) {
      const nm = await linuxDesktopName(exePath);
      if (nm) {
        DEBUG && debug('resolve: LINUX DESKTOP', { exePath, name: nm });
        putCache(exePath, nm);
        return nm;
      }
    }

    // 5) WINDOW TITLE (как fallback)
    if (windowTitle && windowTitle.trim().length >= 3) {
      const t = windowTitle.trim().slice(0, 80);
      DEBUG && debug('resolve: WINDOW TITLE', { title: t });
      putCache(exePath || ex, t);
      return t;
    }

    // 6) Эвристика Steam по пути
    if (exePath) {
      const m = lower(exePath).replace(/\\/g, '/').match(/steamapps\/common\/([^/]+)/);
      if (m?.[1]) {
        const name = decodeURI(m[1]).replace(/[_-]+/g, ' ');
        DEBUG && debug('resolve: STEAM PATH HINT', { exePath, name });
        putCache(exePath, name);
        return name;
      }
    }

    // 7) Fallback — базовое имя без .exe
    const fallback = ex.replace(/\.exe$/, '');
    const titled = fallback ? fallback.charAt(0).toUpperCase() + fallback.slice(1) : 'Unknown App';
    DEBUG && debug('resolve: FALLBACK', { ex, titled });
    putCache(exePath || ex, titled);
    return titled;
  }

  return { warmup, resolveDisplayName };
}
