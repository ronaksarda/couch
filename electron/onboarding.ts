// First run: 0 brain check, 1 permissions (clicks), 2 five spoken questions. "Redo setup" runs it again.
import { app, BrowserWindow, dialog, shell } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brainStatus, complete, getProvider, ollamaTag, parseJson, pullModel, setProvider, TAG_SIZES } from './gemma';
import { saveProfile, splitList } from './memory';
import type { CouchEvent } from './preload';
import type { Settings } from './settings';

export const QUESTIONS = [
  'What shows or channels do you love?',
  'What do you do when you are doing nothing?',
  'Dark and moody, or bright and cozy?',
  'What music do you put on when you are sad?',
  'What makes you laugh?',
];

export interface ObDeps {
  win: () => BrowserWindow;
  settings: () => Settings;
  save: (patch: Partial<Settings>) => void;
  say: (text: string) => void;
  done: () => void; // start the index etc. once consent is given
}

let deps: ObDeps;
let question = -1; // >= 0 while the spoken questions run
const answers: string[] = [];
const offered = new Set<string>(); // the only folders the renderer may ask for
let pulling = false;

const emit = (ev: CouchEvent) => {
  const w = deps.win();
  if (!w.isDestroyed()) w.webContents.send('evt', ev);
};

export function initOnboarding(d: ObDeps) {
  deps = d;
}

export function startOnboarding() {
  question = -1;
  answers.length = 0;
  const w = deps.win();
  // First run must be seen: bring setup to the front even over a fullscreen browser.
  const front = () => {
    w.show();
    w.moveTop();
    w.focus();
    app.focus({ steal: true });
  };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', front);
  else front();
  emit({ t: 'obStep', step: 0 });
  emitKeys();
  void checkBrain();
}

// ---------- API keys: typed once in setup, kept in %APPDATA%\couch\.env, never sent back to the page ----------

export const KEY_NAMES = ['GEMINI_API_KEY', 'ELEVENLABS_API_KEY', 'SERPAPI_API_KEY', 'BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'] as const;
const emitKeys = () => emit({ t: 'obKeys', set: Object.fromEntries(KEY_NAMES.map((k) => [k, !!process.env[k]])) });

/** Empty fields keep the old key. A Gemini key means the user wants the cloud brain: no 3 GB download on a friend's laptop. */
export function saveKeys(keys: Partial<Record<(typeof KEY_NAMES)[number], string>>) {
  const file = join(app.getPath('userData'), '.env');
  let lines: string[] = [];
  try {
    lines = readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    // first save
  }
  for (const k of KEY_NAMES) {
    const v = keys[k]?.trim();
    if (!v) continue;
    lines = lines.filter((l) => !l.startsWith(`${k}=`));
    lines.push(`${k}=${v}`);
    process.env[k] = v;
  }
  writeFileSync(file, lines.filter(Boolean).join('\n') + '\n');
  if (keys.GEMINI_API_KEY?.trim()) {
    deps.save({ brain: 'gemini' });
    setProvider('gemini');
  }
  emitKeys();
  void checkBrain();
}

export async function checkBrain() {
  const s = await brainStatus();
  emit({ t: 'obBrain', status: s.ok ? 'ok' : s.problem, provider: getProvider(), tag: ollamaTag(), size: TAG_SIZES[ollamaTag()] ?? 'several GB' });
}

/** The download starts only from the button that shows the size: that click is the explicit yes. */
export async function download() {
  if (pulling || getProvider() !== 'ollama') return;
  pulling = true;
  try {
    await pullModel((f) => emit({ t: 'obProgress', pct: Math.round(f * 100) }));
    emit({ t: 'obProgress', pct: 100 });
  } catch {
    deps.say('Brain download failed. Disk space or network.');
  } finally {
    pulling = false;
    await checkBrain();
  }
}

export const installOllama = () => shell.openExternal('https://ollama.com/download');

export function permissions() {
  const s = deps.settings();
  const defaults = (['documents', 'downloads', 'desktop'] as const).map((n) => app.getPath(n));
  const all = [...new Set([...defaults, ...s.roots])];
  for (const r of all) offered.add(r);
  emit({ t: 'obStep', step: 1 });
  emit({
    t: 'obSettings',
    roots: all.map((path) => ({ path, checked: s.onboarded ? s.roots.includes(path) : defaults.includes(path) })),
    voice: s.voice,
    simHome: s.simHome,
    lanDiscovery: s.lanDiscovery,
    cloud: s.brain === 'gemini',
    sendFileNames: s.sendFileNames,
    sendFileContents: s.sendFileContents,
  });
}

export async function addFolder() {
  const r = await dialog.showOpenDialog(deps.win(), { properties: ['openDirectory'] });
  const p = r.filePaths[0];
  if (r.canceled || !p) return;
  if (p.startsWith('\\\\')) return deps.say("Network drives aren't allowed. Local folders only."); // PRD 6.2
  offered.add(p);
  emit({ t: 'obFolder', path: p });
}

export function savePermissions(c: { roots: string[]; voice: boolean; simHome: boolean; lanDiscovery: boolean; sendFileNames: boolean; sendFileContents: boolean }) {
  const roots = c.roots.filter((r) => offered.has(r)); // never a path the renderer made up
  const cloud = deps.settings().brain === 'gemini';
  deps.save({
    roots,
    voice: c.voice,
    simHome: c.simHome,
    lanDiscovery: c.lanDiscovery,
    sendFileNames: cloud && c.sendFileNames,
    sendFileContents: cloud && c.sendFileContents,
    onboarded: true,
  });
  deps.done();
  question = 0;
  emit({ t: 'obStep', step: 2 });
  ask();
}

function ask() {
  emit({ t: 'obQuestion', index: question, text: QUESTIONS[question] });
  deps.say(QUESTIONS[question]);
}

export const asking = () => question >= 0;
/** "ask me my preferences again": the five questions in the couch bubble, answers typed or spoken to him. */
export function askAgain() {
  answers.length = 0;
  question = 0;
  ask();
}
/** Window closed mid-questions: stop, so later speech is a normal request again. */
export const stopQuestions = () => (question = -1);

/** A typed or spoken answer, or "skip". Returns true when it was consumed here. */
export function answer(text: string | null): boolean {
  if (question < 0) return false;
  if (text && !/^\s*skip\s*$/i.test(text)) answers[question] = text.slice(0, 300);
  question++;
  if (question < QUESTIONS.length) {
    ask();
    return true;
  }
  question = -1;
  emit({ t: 'obStep', step: 3 });
  deps.say('Okay. I know you a little now. Unfortunately.');
  void buildProfile();
  return true;
}

async function buildProfile() {
  const given = answers.map((a, i) => (a ? `${QUESTIONS[i]} -> ${a}` : '')).filter(Boolean);
  if (!given.length) return;
  // Every show the user named, straight from their words: the model may merge or drop some.
  const named = answers[0] ? splitList(answers[0]) : [];
  let out: Record<string, unknown> = {};
  try {
    out = parseJson(
      await complete(
        'Turn the answers into a taste profile. Output JSON only: {"likes":[every show/channel/topic named, up to 10, one per item],"vibe":"dark and moody" or "bright and cozy" or short phrase,"sadMusic":[up to 5],"funny":[up to 5]}. No names of people the user knows.',
        given.join('\n'),
        { json: 'json' },
      ),
    ) as Record<string, unknown>;
  } catch {
    // brain offline: keep the shows the user named anyway
  }
  const theirs = Array.isArray(out.likes) ? out.likes : typeof out.likes === 'string' ? splitList(out.likes) : [];
  // Speech has no commas ("the office friends dark and taskmaster"): then the model's split wins over one long string.
  const mine = named.length > 1 || !theirs.length ? named : [];
  await saveProfile({ ...out, likes: [...mine, ...theirs] } as never);
}
