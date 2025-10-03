import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createNameResolver } from './presence-name-resolver.js';

let activeWin = null;

// ---- session/heartbeat state
let currentActive = null;
const ACTIVE_STALE_MS = 5000;
const HEARTBEAT_MS    = 5000;
let lastHeartbeatAt   = 0;

async function ensureDeps() {
  if (!activeWin) {
    const esmImport = new Function('s', 'return import(s)');
    activeWin = (await esmImport('active-win')).default;
  }
}

const userDataDir =
  process.env.ECHOTALK_USER_DATA ||
  join(homedir(), '.echotalk');

const POLL_ACTIVE_MS = 1000;

// лаунчеры игнорируем
const LAUNCHER_BASES = new Set([
  'steam.exe',
  'epicgameslauncher.exe',
  'battle.net.exe',
  'origin.exe',
  'ea desktop.exe'
]);

// явный стоп-лист «не игр»
const NON_GAME_BASES = new Set([
  // браузеры
  'chrome.exe','msedge.exe','firefox.exe','opera.exe','opera_gx.exe','brave.exe','vivaldi.exe','iexplore.exe','safari.exe',
  // мессенджеры/клиенты
  'discord.exe','telegram.exe','slack.exe','teams.exe','skype.exe',
  // офис/почта
  'outlook.exe','winword.exe','excel.exe','powerpnt.exe','thunderbird.exe',
  // IDE/редакторы (подстраховка поверх KNOWN_GEEK_SET)
  'code.exe','goland64.exe','idea64.exe','pycharm64.exe','webstorm64.exe','clion64.exe','studio64.exe','devenv.exe',
  'sublime_text.exe','notepad++.exe',
]);

const KNOWN_EXE_MAP = new Map([
  ['cs2.exe', 'Counter-Strike 2'],
  ['csgo.exe', 'Counter-Strike: Global Offensive'],
  ['dota2.exe', 'Dota 2'],
  ['eldenring.exe', 'ELDEN RING'],
  ['witcher3.exe', 'The Witcher 3'],
  ['steam.exe', 'Steam'],
  ['epicgameslauncher.exe', 'Epic Games Launcher'],
  ['battle.net.exe', 'Battle.net'],
  ['code.exe', 'Visual Studio Code'],
  ['discord.exe', 'Discord'],
  ['electron', 'Electron App'],
  ['terminal', 'Terminal'],
]);

const KNOWN_GEEK_SET = new Set([
  // IDE/редакторы
  'code.exe','goland64.exe','idea64.exe','pycharm64.exe','webstorm64.exe','clion64.exe',
  'studio64.exe','devenv.exe','sublime_text.exe','notepad++.exe',
  // инструменты
  'powershell.exe','wt.exe','windowsterminal.exe','conhost.exe','cmd.exe','wsl.exe',
  'git.exe','gitkraken.exe','sourceTree.exe','docker desktop.exe','docker.exe','kubectl.exe',
  'postman.exe','insomnia.exe','dbeaver.exe','tableplus.exe','heidisql.exe','pgadmin4.exe',
  'obsidian.exe','figma.exe','unity.exe','ue4editor.exe','unrealeditor.exe','blender.exe',
  // коммуникации
  'discord.exe','telegram.exe','slack.exe'
]);

// подсказки по путям библиотек игр (используются только в классификации активного окна)
const GAME_PATH_HINTS = [
  /steamapps[\/\\]common[\/\\]/i,
  /\\steam\\.*\\common\\*/i,
  /epic\s*games/i,
  /gog\s*galaxy[\/\\]games/i,
  /ubisoft\s*(connect|game\s*launcher)/i,
  /battle\.net/i,
  /origin[\/\\]|ea\s*(games|desktop)/i,
  /riot\s*games/i,
  /rockstar\s*games/i,
  /xboxgames|microsoft\\xbox/i,
  /games[\/\\](?=.*\.(exe|app))/i
];

function exeBase(fpOrName) {
  if (!fpOrName) return '';
  return basename(fpOrName).toLowerCase().trim();
}

function hasGameHint(p) {
  const lp = (p || '').toLowerCase();
  return GAME_PATH_HINTS.some(rx => rx.test(lp));
}

function classify(base, fullPath) {
  const b = (base || '').toLowerCase();
  if (KNOWN_EXE_MAP.has(b)) return { category: 'game', confidence: 0.9 };
  if (KNOWN_GEEK_SET.has(b)) return { category: 'geek', confidence: 0.8 };
  if (hasGameHint(fullPath)) return { category: 'game', confidence: 0.6 };
  return { category: 'other', confidence: 0.3 };
}

function buildPresencePayload({ source, exe, title, app, pid, displayName }) {
  return {
    source,
    pid: pid ?? null,
    exePath: exe || null,
    exeName: exeBase(exe) || null,
    displayName: displayName || null,
    title: title || null,
    app: app?.name || null,
    extra: null,
    ts: Date.now(),
  };
}

const resolver = createNameResolver({
  userDataDir,
  knownMap: KNOWN_EXE_MAP,
  platform: process.platform,
});

// -------- ACTIVE WINDOW ONLY --------
async function pollActive() {
  try {
    await ensureDeps();
    const aw = await activeWin();
    const now = Date.now();

    const finishCurrentIfStale = () => {
      if (currentActive && (now - currentActive.lastSeen) > ACTIVE_STALE_MS) {
        process.send?.({ type: 'presence:ended', payload: { ...currentActive.payload, endedAt: now } });
        currentActive = null;
      }
    };

    if (!aw) { finishCurrentIfStale(); return; }

    const exePath  = aw.owner?.path || aw.owner?.name || '';
    const procName = aw.owner?.name || '';
    const title    = aw.title || '';
    const base     = exeBase(exePath || procName);
    const cls      = classify(base, exePath);

    // не считаем лаунчеры/явные не-игры активной «игровой» сессией
    if (LAUNCHER_BASES.has(base) || NON_GAME_BASES.has(base)) { finishCurrentIfStale(); return; }
    // интересуют игры/«гиковское» или явные игровые пути
    if (!(cls.category === 'game' || cls.category === 'geek' || hasGameHint(exePath))) { finishCurrentIfStale(); return; }

    const signature = [exePath, title, procName, aw.owner?.processId ?? ''].join('|');

    if (!currentActive || currentActive.signature !== signature) {
      // завершаем предыдущую сессию, если была
      if (currentActive) {
        process.send?.({ type: 'presence:ended', payload: { ...currentActive.payload, endedAt: now } });
      }

      // красивое имя (Steam/Epic/кэш/метаданные)
      const displayName = await resolver.resolveDisplayName({
        exePath,
        processName: procName,
        windowTitle: title,
      });

      const payload = {
        ...buildPresencePayload({
          source: 'active',
          exe: exePath,
          title,
          app: { name: procName },
          pid: aw.owner?.processId ?? null,
          displayName,
        }),
        category: cls.category,
        confidence: cls.confidence,
      };

      process.send?.({ type: 'presence:update', payload });
      currentActive = { signature, pid: aw.owner?.processId, startedAt: now, lastSeen: now, payload };
      lastHeartbeatAt = now;
    } else {
      // то же окно — обновляем lastSeen + редкий heartbeat
      currentActive.lastSeen = now;
      if (now - lastHeartbeatAt >= HEARTBEAT_MS) {
        process.send?.({ type: 'presence:heartbeat', payload: { ...currentActive.payload } });
        lastHeartbeatAt = now;
      }
    }
  } catch (e) {
    console.error('[presence-worker] pollActive error:', e);
  }
}

// ---- IPC и ошибки ----
process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'shutdown') process.exit(0);
});
process.on('uncaughtException', (e) => console.error('[presence-worker] uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('[presence-worker] unhandledRejection:', e));

// -------- BOOT --------
async function start() {
  await resolver.warmup(); // индекс Steam/Epic + загрузка кеша
  process.send?.({ type: 'presence:ready' });

  const activeTick = setInterval(pollActive, POLL_ACTIVE_MS);

  const shutdown = () => {
    clearInterval(activeTick);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start();
