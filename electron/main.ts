import { app, BrowserWindow, powerSaveBlocker, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, session, shell, Tray, type IpcMainEvent, type MenuItemConstructorOptions, type Rectangle } from 'electron';
import { config as loadEnv } from 'dotenv';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { loadSettings, saveSettings, type Settings } from './settings';
import { line, type LineKind } from './persona';
import { isNoise, speak, sttReady, transcribe, ttsReady } from './voice';
import * as drive from './drive';
import type { CardItem, CouchEvent, DeviceView, GuyState, Rect } from './preload';
import * as workflow from './workflow';
import { brainStatus, ollamaTag, pullModel, setProvider, setRateLimitHook, TAG_SIZES } from './gemma';
import { initRegistry, listDevices, setSimVisible, type DeviceState } from './devices/registry';
import { addFact, closeMemory, forgetMe, initMemory, knowsAnything } from './memory';
import * as onboarding from './onboarding';
import { flushTrace, initTrace } from './trace';
import type { Step } from './policy';
import { getChaos, initSim, simState } from './devices/sim';
import { adapterFor } from './devices/adapters';
import { onDeviceState } from './tools/devices';
import { cardAction, fileTools, resetIndex, setRoots, startIndex } from './tools/files';
import { dim } from './tools/local';
import { playerBounds } from './tools/media';
import { cancelSchedule, listSchedules, startSchedules } from './tools/schedule';
import { cleanupSessions } from './tools/web';
import { rt, type Item } from './tools/rt';

// Chromium gives audio "focus" to one player at a time: a video starting paused his voice. Both play now.
app.commandLine.appendSwitch('disable-features', 'AudioFocusEnforcement,MediaSessionService,HardwareMediaKeyHandling');

// Keys: a .env next to the app (dev), or in the user data folder (installed build). Never sent to the renderer.
loadEnv({ path: [join(app.getAppPath(), '.env'), join(app.getPath('userData'), '.env')], quiet: true });
initTrace(); // Sentry must start before the app is ready; it is a no-op without SENTRY_DSN

const DEV_URL = process.env.VITE_DEV_SERVER_URL; // set only by `npm run dev`
const COUCH_W = 240;
const COUCH_H = 210;
const HOTKEYS = ['Control+Alt+Space', 'Control+Shift+Space', 'Alt+`', 'Control+Alt+C', 'F9'];
const SLEEP_MS = 5 * 60_000;
// The public download page. Set COUCH_SITE_URL once the .tech domain points at Render.
const SITE_URL = process.env.COUCH_SITE_URL ?? '';

let settings: Settings;
let couch: BrowserWindow;
let results: BrowserWindow;
let devices: BrowserWindow;
let setup: BrowserWindow | null = null;
let privacy: BrowserWindow | null = null;
let indexing = false;
const tileRects = new Map<string, Rect>();
// Every card ever shown, by key, so an older card's buttons act on that card's own file. Bounded.
const cardItems = new Map<string, Item>();
let setNo = 0;
let undoTimer: NodeJS.Timeout | null = null;
let tray: Tray;
let quitting = false;
let osReducedMotion = false;

let guy: GuyState = 'idle';
let phase: drive.Phase = 'idle';
let listening = false;
let skipAudio = false; // the user typed instead of talking: drop the half-recording
let sayId = 0;
let popupMoved = false; // the user dragged the results popup somewhere: keep it there
let sleepTimer: NodeJS.Timeout | null = null;
let sulkTimer: NodeJS.Timeout | null = null;

// ---------- helpers ----------

const pageUrl = (page: 'index' | 'results' | 'devices' | 'onboarding' | 'privacy') =>
  DEV_URL ? new URL(`${page}.html`, DEV_URL).href : `file://${join(__dirname, '../renderer', `${page}.html`).replace(/\\/g, '/')}`;
const appOrigin = () => (DEV_URL ? new URL(DEV_URL).origin : 'file://');
const isAppUrl = (url: string) => (DEV_URL ? url.startsWith(new URL(DEV_URL).origin + '/') : url.startsWith('file://'));

function emit(target: BrowserWindow | null, ev: CouchEvent) {
  if (target && !target.isDestroyed()) target.webContents.send('evt', ev);
}

function pushState() {
  emit(couch, { t: 'state', state: phase !== 'idle' ? phase : guy });
}

function setGuy(s: GuyState) {
  guy = s;
  pushState();
  if (sleepTimer) clearTimeout(sleepTimer);
  if (s === 'idle') sleepTimer = setTimeout(() => guy === 'idle' && phase === 'idle' && setGuy('asleep'), SLEEP_MS);
}

function sulk() {
  setGuy('sulking');
  if (sulkTimer) clearTimeout(sulkTimer);
  sulkTimer = setTimeout(() => guy === 'sulking' && setGuy('idle'), 6000);
}

/** Bubble first, voice after. Every voice line also shows as text. */
function say(text: string, cacheAudio = false) {
  const id = ++sayId;
  emit(couch, { t: 'say', id, text });
  demoLog({ say: text, id });
  if (text.length > 100 && results) showCard('Mr. Couch', text); // the bubble fits about 3 lines: the whole answer goes in the popup too
  if (guy === 'idle') setGuy('talking');
  if (!settings.voice) return;
  void speak(text, cacheAudio).then((bytes) => {
    if (!bytes) return;
    emit(couch, { t: 'audio', id, bytes }); // the couch queues lines in order
    if (process.env.COUCH_DEMO) writeFileSync(`${process.env.COUCH_DEMO}.say-${id}.mp3`, bytes), demoLog({ audio: id });
  });
}
const sayKind = (k: LineKind) => say(line(k), true); // fixed lines repeat: cache their audio. Dynamic replies are never cached.

function failed(e: unknown) {
  console.error('[couch] error:', e instanceof Error ? e.name : 'unknown'); // never messages: they can hold text or paths (edge 51)
  sayKind('error');
  sulk();
}

// ---------- windows ----------

const secure = {
  preload: join(__dirname, 'preload.js'),
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webviewTag: false,
  spellcheck: false,
};

function createCouch() {
  const home = drive.cornerPoint(screen.getPrimaryDisplay().workArea, settings.homeCorner.corner, COUCH_W, COUCH_H);
  couch = new BrowserWindow({
    ...home,
    width: COUCH_W,
    height: COUCH_H,
    useContentSize: true,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false, // idle couch never takes focus; the text box turns it on briefly
    show: false,
    title: 'Couch',
    webPreferences: { ...secure, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false },
  });
  // Z-order: 'floating' = HWND_TOPMOST on Windows. Stays above normal and borderless-fullscreen windows,
  // and lets exclusive-fullscreen games and video players cover it instead of fighting them.
  couch.setAlwaysOnTop(true, 'floating');
  couch.setIgnoreMouseEvents(true, { forward: true });
  // Windows can nudge the size when crossing monitors with different scaling; force it back.
  couch.on('resize', () => {
    const [w, h] = couch.getSize();
    if (w !== COUCH_W || h !== COUCH_H) couch.setBounds({ ...couch.getBounds(), width: COUCH_W, height: COUCH_H });
  });
  couch.once('ready-to-show', () => couch.showInactive());
  couch.on('close', (e) => !quitting && e.preventDefault());
  void couch.loadURL(pageUrl('index'));
}

const POP_SMALL = { width: 300, height: 48 };
const POP_BIG = { width: 360, height: 460 };

function createResults() {
  // A small popup beside the couch, not an app window: no frame, no taskbar button, expands when clicked.
  results = new BrowserWindow({
    ...POP_SMALL,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'Couch',
    icon: trayIcon(),
    backgroundColor: '#fffaf0',
    webPreferences: secure,
  });
  results.setAlwaysOnTop(true, 'floating');
  results.on('will-move', () => (popupMoved = true)); // user drags only; our own setBounds does not fire it
  results.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    results.hide();
  });
  void results.loadURL(pageUrl('results'));
}

/** Place the popup beside the couch at a given size, bottoms aligned, inside the screen. */
function placePopup(size: { width: number; height: number }) {
  const c = drive.couchBounds();
  const { width: w, height: h } = size;
  const area = screen.getDisplayMatching(c).workArea;
  const fit = (x: number, y: number) => ({ x: Math.min(Math.max(x, area.x), area.x + area.width - w), y: Math.min(Math.max(y, area.y), area.y + area.height - h), width: w, height: h });
  // Dragged by the user: keep their spot, only the size changes.
  if (popupMoved) return results.setBounds(fit(results.getBounds().x, results.getBounds().y + results.getBounds().height - h));
  let b = fit(c.x - w - 12 >= area.x ? c.x - w - 12 : c.x + c.width + 12, c.y + c.height - h);
  // Never on top of the video player: slide left of it if they overlap.
  const p = playerBounds();
  if (p && b.x < p.x + p.width && p.x < b.x + w && b.y < p.y + p.height && p.y < b.y + h) b = fit(p.x - w - 12, b.y);
  results.setBounds(b);
}

/** Show the results popup beside the couch without taking focus. */
function showResults(focus = false) {
  if (!results.isVisible()) placePopup(results.getSize()[1] > POP_SMALL.height ? POP_BIG : POP_SMALL);
  if (focus) {
    results.show();
    results.focus();
  } else results.showInactive();
}

function showCard(title: string, body: string) {
  showResults();
  emit(results, { t: 'card', title, body });
}

// ---------- devices panel ----------

function createDevices() {
  devices = new BrowserWindow({
    width: 380,
    height: 440,
    show: false,
    frame: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    title: 'Couch devices',
    icon: trayIcon(),
    backgroundColor: '#fffaf0',
    webPreferences: secure,
  });
  devices.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    devices.hide();
    saveAndApply({ devicesPanel: false });
  });
  devices.once('ready-to-show', () => settings.devicesPanel && devices.showInactive());
  void devices.loadURL(pageUrl('devices'));
}

const view = (id: string, state: DeviceState, online = true): DeviceView | null => {
  const d = listDevices().find((x) => x.id === id);
  return d ? { id, name: d.name, room: d.room, kind: d.kind, adapter: d.adapter, state, online } : null;
};

function pushDevice(id: string, state: DeviceState, online = true) {
  emit(devices, { t: 'device', id, state, online });
}

/** Full list for the panel. Real devices are read with a short timeout; silence shows as offline, never as a guess. */
async function pushDeviceList() {
  const list = await Promise.all(
    listDevices().map(async (d) => {
      if (d.adapter === 'sim') return view(d.id, getChaos(d.id).offline ? {} : simState(d.id), !getChaos(d.id).offline);
      try {
        const s = await Promise.race([adapterFor(d).getState(), new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), 3500))]);
        return view(d.id, s);
      } catch {
        return view(d.id, {}, false);
      }
    }),
  );
  emit(devices, { t: 'devices', list: list.filter((x): x is DeviceView => x !== null) });
}

// ---------- setup and privacy windows ----------

/** Lost him? Tray click brings the couch above everything (fullscreen browsers included) for 10 s, then back to normal. */
function summon() {
  couch.showInactive();
  couch.setAlwaysOnTop(true, 'screen-saver');
  couch.moveTop();
  say('Here. Still sitting.');
  setTimeout(() => couch.setAlwaysOnTop(true, 'floating'), 10_000);
}

function setupWindow(): BrowserWindow {
  if (setup && !setup.isDestroyed()) return setup;
  setup = new BrowserWindow({ width: 640, height: 720, show: false, title: 'Couch setup', icon: trayIcon(), autoHideMenuBar: true, webPreferences: secure });
  setup.on('closed', onboarding.stopQuestions);
  void setup.loadURL(pageUrl('onboarding'));
  return setup;
}

function showPrivacy() {
  if (!privacy || privacy.isDestroyed()) {
    privacy = new BrowserWindow({ width: 720, height: 640, title: 'What leaves this machine', icon: trayIcon(), autoHideMenuBar: true, webPreferences: secure });
    void privacy.loadURL(pageUrl('privacy'));
  }
  privacy.show();
  privacy.focus();
}

/** Index and watch only after the folder consent. Called once onboarding saves, or at boot when already set up. */
function startFiles() {
  if (indexing) return setRoots(settings.roots);
  indexing = true;
  startIndex();
}

/** Edge 48: name each missing key once (ever), say what still works. Never the key values. */
function keyNotices() {
  const file = join(app.getPath('userData'), 'key-notices.json');
  let told: string[] = [];
  try {
    told = JSON.parse(readFileSync(file, 'utf8')) as string[];
  } catch {
    // first time
  }
  const missing: [string, boolean, string][] = [
    ['ELEVENLABS_API_KEY', !process.env.ELEVENLABS_API_KEY, 'voice. Type instead'],
    ['ELEVENLABS_VOICE_ID', !!process.env.ELEVENLABS_API_KEY && !ttsReady(), 'my voice. Bubbles only'],
    ['SERPAPI_API_KEY', !process.env.SERPAPI_API_KEY, 'web search and YouTube search'],
    ['BROWSERBASE_API_KEY', !process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID, 'the cloud browser (checking pages, reading pages)'],
    ['GEMINI_API_KEY', settings.brain === 'gemini' && !process.env.GEMINI_API_KEY, 'the cloud brain'],
  ];
  const now = missing.filter(([k, gone]) => gone && !told.includes(k));
  if (!now.length) return;
  showCard('Missing keys', now.map(([k, , what]) => `No ${k}: no ${what}. Paste it in tray, Redo setup.`).join('\n'));
  writeFileSync(file, JSON.stringify([...told, ...now.map(([k]) => k)]));
}

async function doForgetMe() {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Forget me', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Forget me',
    message: 'Delete your taste profile, habits and play history, the install id, and the file index?',
    detail: 'Your files are not touched. Couch rebuilds the index next time.',
  });
  if (response !== 0) return;
  await forgetMe();
  await resetIndex();
  indexing = false;
  saveAndApply({ shortcuts: [] });
  startFiles();
  say("Forgot you. Who are you again?");
}

async function addFolder() {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  const p = r.filePaths[0];
  if (r.canceled || !p) return;
  if (p.startsWith('\\\\')) return say("Network drives aren't allowed. Local folders only.");
  if (!settings.roots.includes(p)) saveAndApply({ roots: [...settings.roots, p] });
  startFiles();
}

function about() {
  void dialog
    .showMessageBox({
      type: 'info',
      title: 'About Couch',
      message: `Couch ${app.getVersion()}`,
      detail: `A lazy pixel guy on a driving couch. Brain: open-weight Gemma, local through Ollama by default.\nMIT license.${SITE_URL ? `\n${SITE_URL}` : ''}`,
      buttons: SITE_URL ? ['Open website', 'Close'] : ['Close'],
    })
    .then(({ response }) => SITE_URL && response === 0 && void shell.openExternal(SITE_URL));
}

/** Tray actions reuse the workflow with a fixed plan: same policy check, same confirm sheet. */
const runSteps = (label: string, steps: Step[]) => void workflow.request(label, false, steps);

// ---------- requests ----------

const QUIT_LINES = ['Fine. Leaving. Finally.', 'Okay, shutting down. Wake me up later.', 'Bye. Lights off on my way out.'];

function quitWithGoodbye() {
  say(QUIT_LINES[Math.floor(Math.random() * QUIT_LINES.length)]);
  setTimeout(() => app.quit(), 2200); // let the goodbye bubble show first
}

const pickLine = (xs: string[]) => xs[Math.floor(Math.random() * xs.length)];

async function handleText(raw: string, stalled = false) {
  const text = raw.trim();
  if (isNoise(text)) {
    sayKind('huh');
    setGuy('idle');
    return;
  }
  if (onboarding.answer(text)) return void setGuy('idle'); // one of the five setup questions is open
  // Memory, answered here: saving a fact, re-asking the questions, or admitting he knows nothing yet.
  const rem = /^(?:hey |couch |please )*(?:remember|don'?t forget|note to self|keep in mind)(?: that)?[:,]? (.{3,200})$/i.exec(text);
  if (rem) {
    addFact(rem[1].replace(/[.!]+$/, ''));
    return void say(pickLine(['Got it. Remembered.', "Noted. I'll remember that.", 'Filed away. In my head. On the couch.']));
  }
  if (/\b(ask me|redo|update|change|set up|setup)\b.*\b(preferences|taste|questions|likes)\b/i.test(text)) {
    say('Fine. Five questions. Answer each one, or say skip.');
    return void setTimeout(() => onboarding.askAgain(), 2500);
  }
  if (/\b(what do you know about me|what do i like|my (\w+ )?(preferences|taste|favou?rites?)|do you (know|remember) (me|what i like))\b/i.test(text) && !knowsAnything()) {
    return void say("I don't know much yet. Say 'remember I love sci-fi', or 'ask me my preferences'.");
  }
  // "close yourself", "quit", "go away": everything shuts down, nothing left running.
  if (/^(please )?(close|quit|exit|shut ?down|turn off|go away|leave|kill|stop)( (yourself|the app|couch|now|everything|it all))*( please)?[.!]*$/i.test(text) && !/^stop[.!]*$/i.test(text)) {
    return quitWithGoodbye();
  }
  try {
    await workflow.request(text, stalled);
  } catch (e) {
    failed(e);
  }
}

async function handleAudio(bytes: Uint8Array, mime: string) {
  if (skipAudio) return void (skipAudio = false);
  listening = false;
  emit(couch, { t: 'listen', on: false });
  if (!settings.voice) return setGuy('idle'); // voice off: no audio leaves the machine
  if (!sttReady()) {
    say('No voice key set up. Type it instead.');
    emit(couch, { t: 'openInput' });
    return setGuy('idle');
  }
  setGuy('thinking'); // he scratches his head while listening back; no "on it" line before the answer
  let text: string;
  try {
    text = await transcribe(bytes, mime);
  } catch (e) {
    console.error('[couch] stt failed:', e instanceof Error ? e.name : 'unknown');
    say('Voice service is down. Type it for me.');
    emit(couch, { t: 'openInput' });
    return setGuy('idle');
  }
  await handleText(text, true);
}

function onHotkey() {
  emit(couch, { t: 'stopAudio' }); // edge 4: talking gets cut off, we listen
  if (guy === 'asleep') {
    setGuy('idle');
    sayKind('wake');
  }
  if (!settings.voice || settings.pauseListening) {
    emit(couch, { t: 'openInput' });
    return;
  }
  listening = !listening; // globalShortcut has no key-up: press to start, press to stop
  emit(couch, { t: 'listen', on: listening });
  setGuy(listening ? 'listening' : 'thinking');
}

function registerHotkey(): boolean {
  globalShortcut.unregisterAll();
  let ok = false;
  try {
    ok = globalShortcut.register(settings.hotkey, onHotkey);
  } catch {
    ok = false;
  }
  if (!ok) say(`Can't grab ${settings.hotkey}. Something else has it. Pick one in the tray.`, false);
  tray?.setToolTip(ok ? `Couch (${settings.hotkey})` : 'Couch: hotkey taken, change it here');
  return ok;
}

// ---------- IPC ----------

const Cmd = z.discriminatedUnion('c', [
  z.object({ c: z.literal('ready'), osReducedMotion: z.boolean() }),
  z.object({ c: z.literal('hit'), over: z.boolean() }),
  z.object({
    c: z.literal('drag'),
    phase: z.enum(['start', 'move', 'end']),
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  z.object({ c: z.literal('input'), on: z.boolean() }),
  z.object({ c: z.literal('text'), text: z.string().max(500) }),
  z.object({
    c: z.literal('audio'),
    bytes: z.instanceof(Uint8Array).refine((b) => b.byteLength > 0 && b.byteLength <= 5_000_000),
    mime: z.string().regex(/^audio\/[\w.+-]+(;\s*codecs=[\w.,-]+)?$/),
  }),
  z.object({ c: z.literal('micError') }),
  z.object({ c: z.literal('mic') }),
  z.object({ c: z.literal('expand'), on: z.boolean() }),
  z.object({ c: z.literal('closeResults') }),
  z.object({ c: z.literal('hideDevices') }),
  z.object({ c: z.literal('spoken'), id: z.number().int() }),
  z.object({ c: z.literal('confirm'), id: z.string().uuid(), yes: z.boolean() }),
  z.object({ c: z.literal('pick'), index: z.number().int().min(-1).max(9) }),
  z.object({ c: z.literal('cardAction'), key: z.string().regex(/^\d{1,6}:r[1-9]$/), action: z.enum(['open', 'reveal', 'copyPath']) }),
  z.object({ c: z.literal('undo') }),
  z.object({ c: z.literal('menu') }),
  z.object({ c: z.literal('quit') }),
  z.object({ c: z.literal('devicesReady') }),
  z.object({ c: z.literal('obCheck') }),
  z.object({ c: z.literal('obInstall') }),
  z.object({ c: z.literal('obDownload') }),
  z.object({ c: z.literal('obPermissions') }),
  z.object({ c: z.literal('obAddFolder') }),
  z.object({
    c: z.literal('obSave'),
    roots: z.array(z.string().max(500)).max(20),
    voice: z.boolean(),
    simHome: z.boolean(),
    lanDiscovery: z.boolean(),
    sendFileNames: z.boolean(),
    sendFileContents: z.boolean(),
  }),
  z.object({ c: z.literal('obAnswer'), text: z.string().max(300) }),
  z.object({ c: z.literal('obSkip') }),
  z.object({ c: z.literal('obPrivacy') }),
  z.object({ c: z.literal('obKeys'), keys: z.partialRecord(z.enum(onboarding.KEY_NAMES), z.string().regex(/^[\w\-.]{0,200}$/)) }),
  z.object({
    c: z.literal('tiles'),
    rects: z.record(z.string().max(40), z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(0), height: z.number().finite().min(0) })),
  }),
]);

function onCmd(e: IpcMainEvent, raw: unknown) {
  const fromCouch = e.sender === couch.webContents;
  const fromResults = e.sender === results.webContents;
  const fromDevices = e.sender === devices.webContents;
  const fromSetup = !!setup && !setup.isDestroyed() && e.sender === setup.webContents;
  if (!fromCouch && !fromResults && !fromDevices && !fromSetup) return;
  const parsed = Cmd.safeParse(raw);
  if (!parsed.success) return console.warn('[couch] dropped invalid IPC payload');
  const cmd = parsed.data;
  if (fromSetup) {
    if (cmd.c === 'obCheck') return void onboarding.checkBrain();
    if (cmd.c === 'obInstall') return void onboarding.installOllama();
    if (cmd.c === 'obDownload') return void onboarding.download();
    if (cmd.c === 'obPermissions') return onboarding.permissions();
    if (cmd.c === 'obAddFolder') return void onboarding.addFolder();
    if (cmd.c === 'obSave') return onboarding.savePermissions(cmd);
    if (cmd.c === 'obAnswer') return void handleText(cmd.text);
    if (cmd.c === 'obSkip') return void onboarding.answer(null);
    if (cmd.c === 'obPrivacy') return showPrivacy();
    if (cmd.c === 'obKeys') return onboarding.saveKeys(cmd.keys);
    return;
  }
  if (fromDevices) {
    if (cmd.c === 'devicesReady') return void pushDeviceList();
    if (cmd.c === 'hideDevices') {
      devices.hide();
      return saveAndApply({ devicesPanel: false });
    }
    if (cmd.c === 'tiles') {
      tileRects.clear();
      for (const [id, r] of Object.entries(cmd.rects)) tileRects.set(id, r);
    }
    return;
  }
  if (fromResults) {
    if (cmd.c === 'expand') return placePopup(cmd.on ? POP_BIG : POP_SMALL);
    if (cmd.c === 'closeResults') return results.hide();
    if (cmd.c === 'confirm') return workflow.answerConfirm(cmd.id, cmd.yes);
    if (cmd.c === 'pick') return workflow.answerPick(cmd.index);
    if (cmd.c === 'cardAction') {
      const it = cardItems.get(cmd.key);
      if (it?.kind === 'file') void cardAction(it, cmd.action).then((ok) => !ok && say("Can't reach that file anymore."));
      return;
    }
    if (cmd.c === 'undo') {
      const ctx = { requestId: 'undo', userText: '', signal: new AbortController().signal, prev: null, last: [] };
      void fileTools['file.undo']
        .run({}, ctx)
        .then((o) => say(o.say ?? 'Undone.'))
        .catch((err: Error & { line?: string }) => say(err.line ?? "Couldn't undo."))
        .finally(() => emit(results, { t: 'undo', on: false }));
    }
    return;
  }

  // From the couch window: right-click menu and the ✕ button. ✕ quits at once, no speech.
  if (cmd.c === 'menu') return void trayMenu?.popup({ window: couch });
  if (cmd.c === 'quit') return app.quit();

  switch (cmd.c) {
    case 'ready':
      osReducedMotion = cmd.osReducedMotion;
      pushSettings();
      return pushState();
    case 'hit':
      return couch.setIgnoreMouseEvents(!cmd.over, { forward: true });
    case 'drag':
      if (cmd.phase === 'start') drive.dragStart({ x: cmd.x, y: cmd.y });
      else if (cmd.phase === 'move') drive.dragMove({ x: cmd.x, y: cmd.y });
      else {
        const home = drive.dragEnd();
        if (home) saveAndApply({ homeCorner: home });
      }
      return;
    case 'input':
      couch.setFocusable(cmd.on);
      if (cmd.on) couch.focus();
      return;
    case 'text':
      if (listening) {
        // The recorder ended with nothing (silence), or the user typed while the mic was on: the next mic press must start, not stop.
        skipAudio = !!cmd.text;
        listening = false;
        emit(couch, { t: 'listen', on: false });
      }
      return void handleText(cmd.text);
    case 'mic':
      return onHotkey(); // same as the hotkey: press to talk, press again (or go quiet) to stop
    case 'audio':
      return void handleAudio(cmd.bytes, cmd.mime);
    case 'micError':
      listening = false;
      say('No mic I can use. Type it.');
      emit(couch, { t: 'openInput' });
      return setGuy('idle');
    case 'spoken':
      if (cmd.id === sayId && guy === 'talking') setGuy('idle');
      return;
  }
}

// ---------- settings + tray ----------

function pushSettings() {
  emit(couch, { t: 'settings', reducedMotion: settings.reducedMotion || osReducedMotion, voice: settings.voice });
}

function saveAndApply(patch: Partial<Settings>) {
  settings = { ...settings, ...patch };
  saveSettings(settings);
  pushSettings();
  buildTray();
}

function trayIcon() {
  // 16x16 BGRA couch drawn in code: no image assets.
  const buf = Buffer.alloc(16 * 16 * 4);
  const px = (x: number, y: number, [r, g, b]: number[]) => {
    const i = (y * 16 + x) * 4;
    buf[i] = b;
    buf[i + 1] = g;
    buf[i + 2] = r;
    buf[i + 3] = 255;
  };
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      if (y >= 4 && y <= 9 && x >= 1 && x <= 4) px(x, y, [150, 70, 40]); // backrest
      if (y >= 8 && y <= 11 && x >= 1 && x <= 14) px(x, y, [180, 90, 50]); // seat
      if (y >= 6 && y <= 11 && x >= 13 && x <= 14) px(x, y, [150, 70, 40]); // arm
      if (y >= 12 && y <= 14 && (x === 3 || x === 4 || x === 11 || x === 12)) px(x, y, [30, 30, 30]); // wheels
    }
  return nativeImage.createFromBitmap(buf, { width: 16, height: 16 });
}

async function checkBrain(announce: boolean) {
  const s = await brainStatus();
  if (s.ok) return void (announce && say(settings.brain === 'ollama' ? 'Local brain is up.' : 'Cloud brain is up.'));
  const lines = {
    'not-installed': "My brain's offline. Install Ollama from ollama.com, then Check brain in the tray.",
    'not-running': "My brain's offline. Start Ollama, then Check brain in the tray.",
    'model-missing': `My brain isn't downloaded. Tray, Brain, Download (${s.size}).`,
    'no-key': 'Cloud brain needs GEMINI_API_KEY in .env. Or switch back to local.',
  };
  say(lines[s.problem]);
}

/** The pull only starts after an explicit yes on a dialog that shows the size. */
async function downloadBrain() {
  const tag = ollamaTag();
  const size = TAG_SIZES[tag] ?? 'several GB';
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Download', 'Not now'],
    defaultId: 1,
    cancelId: 1,
    title: 'Couch brain',
    message: `Download ${tag} (${size}) through Ollama?`,
    detail: 'It runs on this computer. Big download, one time.',
  });
  if (response !== 0) return;
  let shown = -5;
  try {
    await pullModel((f) => {
      const pct = Math.floor(f * 100);
      if (pct >= shown + 5) emit(couch, { t: 'say', id: ++sayId, text: `Downloading my brain... ${(shown = pct)}%` });
    });
    say('Brain downloaded. I can think now. Barely.');
  } catch {
    say('Brain download failed. Disk space or network. Try again later.');
  }
}

function chaosMenu() {
  return listDevices()
    .filter((d) => d.adapter === 'sim')
    .map((d) => {
      const c = getChaos(d.id);
      const flip = (k: 'offline' | 'slow' | 'failNext') => () => {
        c[k] = !c[k];
        if (k === 'offline') pushDevice(d.id, c.offline ? {} : simState(d.id), !c.offline);
        buildTray();
      };
      return {
        label: d.name,
        submenu: [
          { label: 'Offline', type: 'checkbox' as const, checked: c.offline, click: flip('offline') },
          { label: 'Slow response', type: 'checkbox' as const, checked: c.slow, click: flip('slow') },
          { label: 'Fail next command', type: 'checkbox' as const, checked: c.failNext, click: flip('failNext') },
        ],
      };
    });
}

function setBrain(brain: Settings['brain']) {
  saveAndApply({ brain });
  setProvider(brain);
  void checkBrain(true);
}

let trayMenu: Menu | null = null; // also shown on a right-click on the guy

function buildTray() {
  tray ??= new Tray(trayIcon());
  const found = workflow.lastItems().filter((i) => i.kind === 'found');
  const schedules = listSchedules();
  const devs = listDevices();
  const menu: MenuItemConstructorOptions[] = [
    {
      label: settings.brain === 'ollama' ? 'Brain: Local Ollama' : 'Brain: Cloud Gemini API',
      submenu: [
        { label: 'Local (Ollama)', type: 'radio', checked: settings.brain === 'ollama', click: () => setBrain('ollama') },
        { label: 'Cloud (Gemini API)', type: 'radio', checked: settings.brain === 'gemini', click: () => setBrain('gemini') },
        { type: 'separator' },
        { label: 'Check brain', click: () => void checkBrain(true) },
        { label: `Download ${ollamaTag()} (${TAG_SIZES[ollamaTag()] ?? 'several GB'})`, enabled: settings.brain === 'ollama', click: () => void downloadBrain() },
      ],
    },
    { label: 'Use voice', type: 'checkbox', checked: settings.voice, click: (i) => saveAndApply({ voice: i.checked }) },
    { label: 'Speak file names', type: 'checkbox', checked: settings.speakFileNames, click: (i) => saveAndApply({ speakFileNames: i.checked }) },
    {
      label: 'Allowed folders',
      submenu: [
        ...settings.roots.map((r) => ({
          label: r,
          type: 'checkbox' as const,
          checked: true,
          click: () => {
            saveAndApply({ roots: settings.roots.filter((x) => x !== r) });
            startFiles();
          },
        })),
        { type: 'separator' },
        { label: 'Add folder...', click: () => void addFolder() },
      ],
    },
    {
      label: 'Devices',
      submenu: [
        {
          label: 'Devices panel',
          type: 'checkbox',
          checked: settings.devicesPanel,
          click: (i) => {
            saveAndApply({ devicesPanel: i.checked });
            if (i.checked) {
              devices.showInactive();
              void pushDeviceList();
            } else devices.hide();
          },
        },
        { label: 'Look for devices on my network', enabled: settings.lanDiscovery, click: () => runSteps('look for devices', [{ tool: 'device.discover', args: {} }]) },
        {
          label: 'Add a found device',
          enabled: found.length > 0,
          submenu: found.map((f) => ({ label: `${f.title} (${f.detail})`, click: () => runSteps('add device', [{ tool: 'device.add', args: { ref: f.id, name: f.title.slice(0, 40) } }]) })),
        },
        {
          label: 'Remove a device',
          enabled: devs.length > 0,
          submenu: devs.map((d) => ({ label: d.name, click: () => runSteps('remove device', [{ tool: 'device.remove', args: { device: d.name } }]) })),
        },
        {
          label: 'Sim home',
          type: 'checkbox',
          checked: settings.simHome,
          click: (i) => {
            saveAndApply({ simHome: i.checked });
            setSimVisible(i.checked);
            void pushDeviceList();
          },
        },
        { label: 'Sim chaos', submenu: chaosMenu() },
      ],
    },
    {
      label: 'Scheduled items',
      submenu: schedules.length
        ? schedules.map((x) => ({ label: `Cancel: ${x.label}`.slice(0, 80), click: () => (cancelSchedule(x.id), say('Cancelled.'), buildTray()) }))
        : [{ label: 'Nothing scheduled', enabled: false }],
    },
    {
      label: 'Shortcuts',
      submenu: settings.shortcuts.length
        ? settings.shortcuts.map((st) => ({ label: `${st.tool} ${Object.values(st.args).join(' ')}`.slice(0, 60), click: () => runSteps(st.tool, [st as Step]) }))
        : [{ label: 'None yet', enabled: false }],
    },
    { label: 'Where is he? (show the couch)', click: summon },
    {
      label: 'Move him to bottom-right',
      click: () => {
        saveAndApply({ homeCorner: { corner: 'br' } });
        drive.parkHome();
        summon();
      },
    },
    { label: 'Show recent results', click: () => showResults(true) },
    { label: 'Dim screen', click: () => dim(60) },
    { label: 'Undim screen', click: () => dim(0) },
    { type: 'separator' },
    { label: 'Pause listening', type: 'checkbox', checked: settings.pauseListening, click: (i) => saveAndApply({ pauseListening: i.checked }) },
    {
      label: 'Change hotkey',
      submenu: HOTKEYS.map((k) => ({
        label: k,
        type: 'radio' as const,
        checked: settings.hotkey === k,
        click: () => {
          saveAndApply({ hotkey: k });
          registerHotkey();
        },
      })),
    },
    { label: 'Reduced motion', type: 'checkbox', checked: settings.reducedMotion, click: (i) => saveAndApply({ reducedMotion: i.checked }) },
    { type: 'separator' },
    { label: 'What leaves this machine', click: showPrivacy },
    { label: 'Redo setup', click: () => onboarding.startOnboarding() },
    { label: 'Forget me', click: () => void doForgetMe() },
    { label: 'About', click: about },
    { label: 'Quit', click: () => app.quit() },
  ];
  trayMenu = Menu.buildFromTemplate(menu);
  tray.setContextMenu(trayMenu);
  // Rebuild so "Add a found device" and "Scheduled items" stay current.
  tray.removeAllListeners('right-click');
  tray.removeAllListeners('click');
  tray.on('click', summon);
  tray.on('right-click', () => buildTray());
}

// ---------- security ----------

function lockDown() {
  // Mic only for our own pages, audio only, and only while "Use voice" is on. Everything else: no.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const audioOnly =
      permission === 'media' &&
      'mediaTypes' in details &&
      (details.mediaTypes ?? []).length > 0 &&
      (details.mediaTypes ?? []).every((t) => t === 'audio');
    cb(audioOnly && settings.voice && wc === couch.webContents && isAppUrl(details.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler(
    (wc, permission, origin) => permission === 'media' && settings.voice && wc === couch?.webContents && origin === appOrigin(),
  );
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('will-redirect', (e) => e.preventDefault());
    wc.on('will-attach-webview', (e) => e.preventDefault());
    // Only the "get a key" links in setup open, and only in the user's own browser.
    wc.setWindowOpenHandler(({ url }) => {
      if (KEY_PAGES.some((k) => url.startsWith(k))) void shell.openExternal(url);
      return { action: 'deny' };
    });
  });
}

const KEY_PAGES = ['https://aistudio.google.com/apikey', 'https://elevenlabs.io/app/settings/api-keys', 'https://serpapi.com/manage-api-key', 'https://www.browserbase.com/settings'];

// ---------- demo run (for recording): COUCH_DEMO=<file>, one request per line, "#wait N" pauses N seconds ----------

const demoT0 = Date.now();
const demoLog = (rec: object) => process.env.COUCH_DEMO && appendFileSync(`${process.env.COUCH_DEMO}.log.jsonl`, JSON.stringify({ t: Date.now() - demoT0, ...rec }) + '\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runDemo(file: string) {
  powerSaveBlocker.start('prevent-display-sleep'); // an idle laptop locks mid-recording otherwise
  for (const text of readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    if (text.startsWith('#wait ')) {
      await sleep(Number(text.slice(6)) * 1000);
      continue;
    }
    demoLog({ ask: text });
    await handleText(text);
    demoLog({ done: text });
    await sleep(5000); // let him finish talking
  }
}

// ---------- boot ----------

// One Couch at a time: a second launch just brings the first one forward.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.setAppUserModelId('tech.couch.app'); // taskbar says Couch, not Electron
app.on('second-instance', () => couch && summon());

app.whenReady().then(() => {
  settings = loadSettings();
  const userData = app.getPath('userData');
  void initMemory(userData).then((note) => note && say(note)); // edges 46-47: one line, then carry on
  setProvider(settings.brain); // only the user's choice; failures never switch it
  setRateLimitHook((s) => rt.progress(`Cloud brain wants a breather. ${s} seconds.`));
  initRegistry(userData);
  setSimVisible(settings.simHome);
  initSim(userData, (id, s) => devices && pushDevice(id, s));
  onDeviceState((id, s) => pushDevice(id, s));
  Object.assign(rt, {
    userData,
    settings: () => settings,
    say: (t: string) => say(t),
    progress: (t: string) => emit(couch, { t: 'say', id: ++sayId, text: t }),
    raise: () => couch.moveTop(),
    hideResults: () => results.hide(),
    runScheduled: workflow.runScheduled,
  });
  onboarding.initOnboarding({ win: setupWindow, settings: () => settings, save: saveAndApply, say: (t) => say(t), done: startFiles });
  lockDown();
  ipcMain.on('cmd', onCmd);
  createCouch();
  createResults();
  createDevices();
  workflow.initWorkflow({
    say: (t) => say(t),
    progress: (t) => rt.progress(t),
    thinking: () => setGuy('thinking'),
    idle: () => void ((guy === 'thinking' || guy === 'delivering') && setGuy('idle')),
    sulk,
    cards: (items, picking) => {
      setNo++;
      for (const it of items) cardItems.set(`${setNo}:${it.id}`, it);
      while (cardItems.size > 200) cardItems.delete(cardItems.keys().next().value!);
      showResults();
      const cards: CardItem[] = items.map(({ id, kind, title, detail, snippet, cloud, data }) => ({
        id,
        key: `${setNo}:${id}`,
        kind,
        title,
        detail,
        snippet,
        cloud,
        // Video thumbnails come straight from YouTube's image host, built from the id (never a URL from a result).
        thumb: (kind === 'video' || kind === 'song') && /^[\w-]{11}$/.test(String(data.videoId)) ? `https://i.ytimg.com/vi/${String(data.videoId)}/mqdefault.jpg` : undefined,
      }));
      emit(results, { t: 'cards', items: cards, picking });
    },
    card: (title, body) => {
      showCard(title, body);
      if (title === 'Copied' || title === 'Moved') {
        emit(results, { t: 'undo', on: true });
        if (undoTimer) clearTimeout(undoTimer);
        undoTimer = setTimeout(() => emit(results, { t: 'undo', on: false }), 10 * 60_000);
      }
    },
    confirm: (id, info) => {
      showResults(true);
      emit(results, { t: 'confirm', id, ...info });
    },
    closeConfirm: () => emit(results, { t: 'closeConfirm' }),
    screenPoint: () => {
      // Errands with no window to visit (dim, launch, timer, note, clipboard): the middle of the edge the couch lives on.
      const area = screen.getPrimaryDisplay().workArea;
      return { x: area.x + Math.round(area.width / 2), y: settings.homeCorner.corner.startsWith('t') ? area.y + 120 : area.y + area.height - 110 };
    },
    offerShortcut: (step) => {
      if (settings.shortcuts.some((x) => x.tool === step.tool)) return;
      saveAndApply({ shortcuts: [...settings.shortcuts, step].slice(-5) });
      say('You do that a lot around now. Made you a shortcut in the tray.');
    },
    showTarget: (t) => {
      if (t.kind === 'resultsWindow') showResults();
      if (t.kind === 'devicePanelTile' && !devices.isVisible()) {
        devices.showInactive();
        void pushDeviceList();
      }
    },
  });
  drive.initDrive(couch, {
    windowRect: (kind, id) => {
      if (kind === 'playerWindow') return playerBounds();
      if (kind === 'devicePanelTile') {
        if (!devices.isVisible()) return null;
        const c = devices.getContentBounds();
        const r = id ? tileRects.get(id) : undefined;
        return r ? ({ x: Math.round(c.x + r.x), y: Math.round(c.y + r.y), width: Math.round(r.width), height: Math.round(r.height) } satisfies Rectangle) : devices.getBounds();
      }
      return results.isVisible() ? results.getBounds() : null;
    },

    home: () => settings.homeCorner,
    reducedMotion: () => settings.reducedMotion || osReducedMotion,
    onPhase: (p) => {
      phase = p;
      if (p === 'idle' && (guy === 'delivering' || guy === 'thinking')) guy = 'idle';
      pushState();
    },
    onMotion: (m) => emit(couch, { t: 'motion', ...m }),
    say: (t) => say(t),
  });
  drive.parkHome();
  buildTray();
  registerHotkey();
  setGuy('idle');
  startSchedules();
  if (settings.onboarded || settings.roots.length) startFiles(); // folders were picked already, even if the questions were skipped
  else onboarding.startOnboarding(); // the index waits for the folder consent
  keyNotices();
  void cleanupSessions();
  void checkBrain(false);
  if (process.env.COUCH_DEMO) void runDemo(process.env.COUCH_DEMO);
  // Real devices have no push channel here: refresh the panel every 15 s while it is visible.
  setInterval(() => devices.isVisible() && listDevices().some((d) => d.adapter !== 'sim') && void pushDeviceList(), 15_000).unref();
});

app.on('before-quit', () => {
  quitting = true;
  drive.cancelAll();
  void closeMemory();
  void flushTrace();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
