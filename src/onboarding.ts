import type { CouchApi } from '../electron/preload';
import { renderPrivacy } from './privacy';

const api = (window as unknown as { couch: CouchApi }).couch;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const check = (id: string) => $<HTMLInputElement>(id);

function show(step: number) {
  for (let i = 0; i <= 3; i++) $(`s${i}`).hidden = i !== step;
  $(`s${step}`).querySelector<HTMLElement>('button.primary:not([hidden]), input')?.focus();
}

function folderRow(path: string, checked: boolean) {
  const label = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.value = path;
  label.append(box, ` ${path}`); // text node: never HTML
  $('folders').append(label);
}

renderPrivacy($('privacy'));

$('check').addEventListener('click', () => api.send({ c: 'obCheck' }));
$('install').addEventListener('click', () => api.send({ c: 'obInstall' }));
$('download').addEventListener('click', () => {
  $<HTMLButtonElement>('download').disabled = true;
  $('bar').hidden = false;
  api.send({ c: 'obDownload' });
});
$('next0').addEventListener('click', () => api.send({ c: 'obPermissions' }));
$('keysForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const keys: Record<string, string> = {};
  for (const i of $('keysForm').querySelectorAll<HTMLInputElement>('input')) {
    const v = i.value.trim();
    if (!v) continue;
    if (!/^[\w\-.]{8,200}$/.test(v)) return void ($('keysErr').textContent = `${i.name} looks wrong. Copy it again, no spaces.`);
    keys[i.name] = v;
    i.value = ''; // the page never keeps a key
  }
  $('keysErr').textContent = '';
  api.send({ c: 'obKeys', keys });
});
$('addFolder').addEventListener('click', () => api.send({ c: 'obAddFolder' }));
$('save').addEventListener('click', () =>
  api.send({
    c: 'obSave',
    roots: [...$('folders').querySelectorAll<HTMLInputElement>('input:checked')].map((b) => b.value),
    voice: check('voice').checked,
    simHome: check('simHome').checked,
    lanDiscovery: check('lan').checked,
    sendFileNames: check('sendNames').checked,
    sendFileContents: check('sendContents').checked,
  }),
);
$('qForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = check('qInput').value.trim();
  if (!v) return;
  check('qInput').value = '';
  api.send({ c: 'obAnswer', text: v });
});
$('skip').addEventListener('click', () => api.send({ c: 'obSkip' }));
$('close').addEventListener('click', () => window.close());

const BRAIN: Record<string, string> = {
  ok: 'The local brain is ready. Your files and its thinking stay on this machine.',
  'not-installed': 'Ollama is not installed. It runs the brain (Gemma) on this computer. Get it, start it, then check again.',
  'not-running': 'Ollama is installed but not running. Start it, then check again.',
  'model-missing': 'Ollama runs, but the Gemma model is not downloaded yet.',
  'no-key': 'You picked the cloud brain, but there is no Gemini key yet. Paste one below, or switch back to local in the tray.',
};

api.on((ev) => {
  if (ev.t === 'obStep') show(ev.step);
  else if (ev.t === 'obBrain') {
    $('brainText').textContent =
      ev.status === 'ok' && ev.provider === 'gemini' ? 'The cloud brain (Gemma via the Gemini API) is ready. Requests go to Google; files only if you allow it below.' : BRAIN[ev.status];
    $('install').hidden = ev.status !== 'not-installed';
    const dl = $<HTMLButtonElement>('download');
    dl.hidden = ev.status !== 'model-missing';
    dl.disabled = false;
    dl.textContent = `Download ${ev.tag} (${ev.size})`;
    // The brain is not required to finish setup: buttons like dim and pause still work without it.
    $<HTMLButtonElement>('next0').disabled = false;
    $<HTMLButtonElement>('next0').textContent = ev.status === 'ok' ? 'Next' : 'Skip for now';
  } else if (ev.t === 'obProgress') {
    $<HTMLProgressElement>('bar').value = ev.pct;
    $('brainText').textContent = `Downloading the brain... ${ev.pct}%`;
  } else if (ev.t === 'obSettings') {
    $('folders').replaceChildren();
    for (const r of ev.roots) folderRow(r.path, r.checked);
    check('voice').checked = ev.voice;
    check('simHome').checked = ev.simHome;
    check('lan').checked = ev.lanDiscovery;
    $('cloudBox').hidden = !ev.cloud; // the cloud toggles exist only when the cloud brain is chosen
    check('sendNames').checked = ev.sendFileNames;
    check('sendContents').checked = ev.sendFileContents;
  } else if (ev.t === 'obFolder') folderRow(ev.path, true);
  else if (ev.t === 'obKeys') {
    for (const [k, on] of Object.entries(ev.set)) $(`k-${k}`).textContent = on ? '(saved)' : '';
  } else if (ev.t === 'obQuestion') {
    $('qText').textContent = `${ev.index + 1}/5. ${ev.text}`;
    check('qInput').focus();
  }
});
