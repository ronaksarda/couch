// PRD section 9 "What leaves this machine", plus the device row. Rendered on the privacy page and the permissions screen.
export const PRIVACY: [data: string, goesTo: string, when: string][] = [
  ['Voice audio', 'ElevenLabs speech-to-text', 'Every spoken request, only while "Use voice" is on. Never written to disk.'],
  ['Your request text, date, taste profile, last turns', 'Gemma on local Ollama', 'Every request in the default local mode. Stays on this machine.'],
  ['File names, folders, dates, snippets, extracted file text', 'Gemma on local Ollama', 'When a plan or an answer needs them, in local mode. Stays on this machine.'],
  ['Your request text, date, taste profile, last turns', 'Gemma via the Gemini API', 'Every request, only if you chose the cloud brain.'],
  ['File names, folders, dates, snippets of search candidates', 'Gemma via the Gemini API', 'Cloud brain only, only with "send file names to the AI" on.'],
  ['Relevant parts of one file\'s text', 'Gemma via the Gemini API', 'Cloud brain only, with "send file contents" on, after a one-time notice per session.'],
  ['The guy\'s reply text', 'ElevenLabs text-to-speech', 'Every reply while voice is on. Never file contents; file names only if "speak file names" is on (off by default).'],
  ['Search keywords and the named site\'s domain', 'SerpApi', 'Web find and media search. Never file names, paths or contents.'],
  ['Page URLs to open', 'Browserbase cloud browser', 'Web find checks, page reading, YouTube fallback. No local files.'],
  ['Download URL', 'The website itself (direct HTTPS)', 'Web download, after you tap Yes.'],
  ['Taste profile, things you asked him to remember, habit counts (tool names only), chosen media titles', 'MongoDB Atlas', 'After setup and on use, only if MONGODB_URI is set.'],
  ['Error traces: tool names, step names, durations, error types', 'Sentry', 'Only if SENTRY_DSN is set. No text, paths, URLs or device names.'],
  ['One screenshot of the display the couch is on', 'Gemma: local Ollama, or the Gemini API in cloud mode', 'Only when you ask him to look and tap Yes on the sheet that shows it. Never saved, never spoken.'],
  ['Video ids of search results', 'YouTube image host (i.ytimg.com)', 'Thumbnails on video and song cards.'],
  ['Device commands', 'Devices on your home network (LAN) only', 'When you ask. Hosts must be private addresses. Cloud-only devices are not supported.'],
];

export function renderPrivacy(el: HTMLElement) {
  const table = document.createElement('table');
  table.className = 'privacy';
  const head = table.createTHead().insertRow();
  for (const h of ['Data', 'Goes to', 'When']) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = h;
    head.append(th);
  }
  const body = table.createTBody();
  for (const row of PRIVACY) {
    const tr = body.insertRow();
    for (const c of row) tr.insertCell().textContent = c;
  }
  el.replaceChildren(table);
}
