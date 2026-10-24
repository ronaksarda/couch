// File tools: search (index worker), read, open, reveal, copy, move, undo. Paths only ever come from index results.
import { clipboard, dialog, shell } from 'electron';
import MiniSearch from 'minisearch';
import { constants } from 'node:fs';
import { copyFile, lstat, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { answer, getProvider, rank } from '../gemma';
import type { FromWorker, Hit, Query, ToWorker } from '../index-worker';
import { guardPath, resolveDestRoot } from '../policy';
import { chunks, extractText, fileAttrs } from './extract';
import { fmtDate, fmtSize, ids, ref, rt, ToolError, type Ctx, type Item, type Tool } from './rt';

// "Open" must never run a program: that is T3 (shell/script execution, installing software).
const EXECUTABLE = /\.(exe|com|bat|cmd|msi|msix|appx|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|scr|pif|cpl|lnk|url|reg|jar|dll|sys|inf|application|gadget|msc|appref-ms|settingcontent-ms)$/i;
export const isExecutable = (p: string) => EXECUTABLE.test(p);

let worker: Worker | null = null;
let restarts = 0;
let reqId = 0;
const waiting = new Map<number, (r: { hits: Hit[]; partial: boolean }) => void>();
let lastQuery: Query | null = null;
let contentsNoticeShown = false;

const roots = () => rt.settings().roots;

// v2: smaller text per file. The v1 cache (up to tens of MB) is dropped once and rebuilt.
const indexFile = () => join(rt.userData, 'file-index-v2.json');

export function startIndex() {
  void rm(join(rt.userData, 'file-index.json'), { force: true }); // old v1 cache
  worker = new Worker(join(__dirname, '..', 'index-worker.js'), { workerData: { roots: roots(), indexFile: indexFile() } });
  worker.on('message', (m: FromWorker) => {
    if (m.t === 'result') waiting.get(m.id)?.(m), waiting.delete(m.id); // search results carry their own "partial" flag
  });
  worker.on('error', (e: Error) => console.error('[couch] index worker error:', e.name)); // never the message: it can hold a path
  worker.on('exit', (code) => {
    worker = null;
    if (code !== 0 && restarts++ < 3) setTimeout(startIndex, 30_000);
  });
}


/** Forget me: stop the worker and delete the index file. Started again only by the caller. */
export async function resetIndex() {
  worker?.removeAllListeners('exit'); // a deliberate stop is not a crash: no restart
  await worker?.terminate();
  worker = null;
  await rm(indexFile(), { force: true });
}
export const setRoots = (r: string[]) => worker?.postMessage({ t: 'roots', roots: r } satisfies ToWorker);

function query(q: Query): Promise<{ hits: Hit[]; partial: boolean }> {
  if (!worker) return Promise.resolve({ hits: [], partial: true });
  const id = ++reqId;
  worker.postMessage({ t: 'search', id, q } satisfies ToWorker);
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    setTimeout(() => waiting.delete(id) && resolve({ hits: [], partial: true }), 5000);
  });
}

const toItem = (h: Hit): Omit<Item, 'id'> => ({
  kind: 'file',
  title: h.name,
  detail: `${basename(h.folder)} · ${fmtDate(h.mtime)} · ${fmtSize(h.size)}${h.cloud ? ' · in the cloud' : ''}`,
  snippet: h.snippet,
  cloud: h.cloud,
  data: { path: h.path, size: h.size, mtime: h.mtime },
});

async function runSearch(q: Query, ctx: Ctx, again = false): Promise<{ items: Item[]; chosen?: Item; say?: string; failed?: boolean }> {
  if (!worker) throw new ToolError('Finish setup first, so I know which folders I may look in.', 'clarify');
  lastQuery = q;
  const { hits, partial } = await query(q);
  const pre = partial ? 'Still counting your files. ' : again ? 'That one moved. ' : '';
  if (!hits.length) return { items: [], say: `${pre}Nothing. Try a wider date, or another folder.`, failed: true };
  let ordered = hits;
  const clearWinner = hits.length === 1 || hits[0].score >= 1.5 * hits[1].score;
  // Local brain: Gemma reranks the top 10 (nothing leaves the machine). Cloud brain: code order only.
  if (!clearWinner && hits.length > 2 && (getProvider() === 'ollama' || rt.settings().sendFileNames)) {
    const desc = [...q.keywords, ...q.nameHints].join(' ');
    const best = await rank(desc, hits.map((h) => `${h.name} | ${basename(h.folder)} | ${fmtDate(h.mtime)} | ${h.snippet}`), 5, ctx.signal);
    if (best.length) ordered = [...best.map((i) => hits[i]), ...hits.filter((_, i) => !best.includes(i))];
  }
  const items = ids(ordered.map(toItem));
  // "open the DLC assignment": do it with the best match; the others stay in the popup to click instead.
  const decide = clearWinner || /\b(open|show|pull up|bring up|read)\b/i.test(ctx.userText);
  return { items, chosen: decide ? items[0] : undefined, say: pre ? `${pre}${decide ? 'Got it.' : 'Pick one.'}` : undefined };
}

/** Real path check for a result item. A file that vanished leaves the index and we search once more. */
async function resolveFile(it: Item, ctx: Ctx, exactNamed = false, again = false): Promise<string | { retry: Item[]; say?: string }> {
  if (it.kind !== 'file') throw new ToolError('That one is not a file.', 'refuse');
  const p = String(it.data.path);
  // exactNamed paths skip the hidden check, so the attribute lookup (a PowerShell start) is only paid when it matters.
  const g = await guardPath(p, roots(), { attrs: exactNamed ? 0 : await fileAttrs(p), exactNamed });
  if (g.ok) return g.real;
  if (g.reason === 'missing') {
    worker?.postMessage({ t: 'remove', path: p } satisfies ToWorker);
    if (lastQuery) {
      const r = await runSearch(lastQuery, ctx, true);
      // One clear match after the re-search: do what was asked with it (edge 21). Otherwise show the new cards.
      if (r.chosen && !again) return resolveFile(r.chosen, ctx, exactNamed, true);
      return { retry: r.items, say: r.say };
    }
    throw new ToolError('That file is gone. Moved or deleted.');
  }
  if (g.reason === 'outside') throw new ToolError('That is outside the folders I can look in. Add the folder from the tray.', 'refuse');
  throw new ToolError("That one's off limits.", 'refuse');
}

// ---------- undo log: 10 minutes, only if the file is unchanged since ----------

type Undo = { kind: 'copy' | 'move'; from: string; to: string; size: number; mtime: number; at: number };
const UNDO_MS = 10 * 60_000;
const undoFile = () => join(rt.userData, 'undo.json');
async function readUndo(): Promise<Undo[]> {
  try {
    return (JSON.parse(await readFile(undoFile(), 'utf8')) as Undo[]).filter((u) => Date.now() - u.at < UNDO_MS);
  } catch {
    return [];
  }
}
const writeUndo = (u: Undo[]) => writeFile(undoFile(), JSON.stringify(u)).catch(() => undefined);

/** "name (1).ext", "name (2).ext"... never overwrite. */
/** Opens a local file in the user's default web browser (read from the Windows URL association). False if none found. */
async function openInBrowser(path: string): Promise<boolean> {
  const url = pathToFileURL(path).href;
  const reg = (args: string[]) => new Promise<string>((res) => execFile('reg', args, { windowsHide: true }, (_e, out) => res(String(out ?? ''))));
  const prog = /ProgId\s+REG_SZ\s+(\S+)/.exec(await reg(['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId']))?.[1];
  const cmd = prog && /REG_\w+\s+"([^"]+\.exe)"/i.exec(await reg(['query', `HKCR\\${prog}\\shell\\open\\command`, '/ve']))?.[1];
  const exe = cmd || 'msedge.exe'; // Edge ships with Windows
  return new Promise((res) => {
    const child = spawn(exe, [url], { detached: true, stdio: 'ignore', windowsHide: false, shell: !cmd });
    child.on('error', () => res(false));
    child.on('spawn', () => (child.unref(), res(true)));
  });
}

export async function freeName(dir: string, name: string): Promise<string> {
  const e = extname(name);
  const stem = name.slice(0, name.length - e.length);
  for (let i = 0; i < 1000; i++) {
    const p = join(dir, i === 0 ? name : `${stem} (${i})${e}`);
    if (!(await lstat(p).catch(() => null))) return p;
  }
  throw new ToolError('Too many copies with that name already.');
}

async function destDir(dest: string): Promise<string> {
  const d = resolveDestRoot(dest, roots());
  if (!d) throw new ToolError("I can only put things in your allowed folders. Like Desktop.", 'refuse');
  const g = await guardPath(d, roots());
  if (!g.ok) throw new ToolError(g.reason === 'missing' ? "That folder doesn't exist." : "That folder's off limits.", 'refuse');
  if (!(await stat(g.real)).isDirectory()) throw new ToolError("That's not a folder.", 'refuse');
  return g.real;
}

const fp = async (src: string, dir: string) => {
  const s = await stat(src).catch(() => null);
  return `${src}|${s?.size}|${s?.mtimeMs}|${dir}`;
};

type CopyArgs = { ref: string; dest: string; newName?: string };

async function change(kind: 'copy' | 'move', a: CopyArgs, ctx: Ctx) {
  const src = await resolveFile(ref(a.ref, ctx), ctx);
  if (typeof src !== 'string') throw new ToolError('That file moved. Find it again first.');
  const dir = await destDir(a.dest);
  const st = await stat(src);
  return { src, dir, st, name: a.newName ? a.newName + (extname(a.newName) ? '' : extname(src)) : basename(src) };
}

async function doChange(kind: 'copy' | 'move', a: CopyArgs, ctx: Ctx) {
  const { src, dir, st, name } = await change(kind, a, ctx);
  const to = await freeName(dir, name);
  try {
    if (kind === 'copy') await copyFile(src, to, constants.COPYFILE_EXCL);
    else {
      try {
        await rename(src, to);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
        // Across drives: copy, verify size, then remove the source. A failure leaves the source untouched.
        await copyFile(src, to, constants.COPYFILE_EXCL);
        if ((await stat(to)).size !== st.size) throw new Error('size-mismatch');
        await unlink(src);
      }
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Never leave a partial copy while the source still exists. EEXIST means someone else's file took the name: leave it alone.
    if (code !== 'EEXIST' && (await lstat(src).catch(() => null))) await unlink(to).catch(() => undefined);
    throw new ToolError(code === 'EBUSY' || code === 'EPERM' ? "That file is locked. Close it and ask again." : `The ${kind} failed. Nothing changed.`);
  }
  const done = await stat(to);
  await writeUndo([...(await readUndo()), { kind, from: src, to, size: done.size, mtime: done.mtimeMs, at: Date.now() }]);
  return { card: { title: kind === 'copy' ? 'Copied' : 'Moved', body: `${src}\n→ ${to}\nUndo works for 10 minutes.` }, say: kind === 'copy' ? 'Copied. Undo is there if you panic.' : 'Moved. Undo is there for ten minutes.' };
}

export const fileTools: Record<string, Tool<any>> = {
  'file.search': {
    run: async (q: Query, ctx) => runSearch(q, ctx),
  },
  'file.read': {
    async run(a: { ref: string; question: string }, ctx) {
      const r = await resolveFile(ref(a.ref, ctx), ctx);
      if (typeof r !== 'string') return { items: r.retry, say: r.say };
      if (getProvider() === 'gemini') {
        // Cloud brain: file text leaves only with the toggle on, and after a one-time notice per session.
        if (!rt.settings().sendFileContents) throw new ToolError("File contents stay here. Turn on 'send file contents' in setup, or use the local brain.", 'refuse');
        if (!contentsNoticeShown) {
          const { response } = await dialog.showMessageBox({ type: 'question', buttons: ['OK', 'No'], defaultId: 1, cancelId: 1, title: 'Couch', message: 'This sends the text of this file to the AI to answer. OK?', detail: 'Only the most relevant parts, to the Gemini API.' });
          if (response !== 0) return { sayKind: 'cancel' };
          contentsNoticeShown = true;
        }
      }
      const x = await extractText(r);
      if ('problem' in x) {
        const say = x.problem === 'scanned' ? "That one's just a picture, I can't read it." : x.problem === 'unreadable' ? "Can't open it. Something has it locked." : "I can't open that one.";
        return { say, failed: true };
      }
      const parts = chunks(x.text);
      let data = x.text;
      if (parts.length > 1) {
        const idx = new MiniSearch({ fields: ['t'], storeFields: ['t'] });
        idx.addAll(parts.map((t, id) => ({ id, t })));
        const top = idx.search(a.question, { fuzzy: 0.2, prefix: true }).slice(0, 3);
        data = (top.length ? top.map((h) => String(h.t)) : parts.slice(0, 3)).join('\n...\n');
      }
      const ans = await answer(a.question, data, ctx.signal);
      // File contents are never spoken (they would go to text-to-speech): the answer stays on the card.
      return { card: { title: basename(r), body: ans }, say: "Read it. Answer's on the card." };
    },
  },
  'file.open': {
    async run(a: { ref: string; browser?: boolean }, ctx) {
      const r = await resolveFile(ref(a.ref, ctx), ctx, true);
      if (typeof r !== 'string') return { items: r.retry, say: r.say };
      if (isExecutable(r)) throw new ToolError("That's a program. I don't run programs. Show in folder instead?", 'refuse');
      if (a.browser && (await openInBrowser(r))) return { sayKind: 'done' };
      const err = await shell.openPath(r);
      if (err) throw new ToolError("Windows wouldn't open it.");
      return { sayKind: 'done' };
    },
  },
  'file.reveal': {
    async run(a: { ref: string }, ctx) {
      const r = await resolveFile(ref(a.ref, ctx), ctx, true);
      if (typeof r !== 'string') return { items: r.retry, say: r.say };
      shell.showItemInFolder(r);
      return { say: `It's in ${basename(join(r, '..'))}.` };
    },
  },
  'file.copy': {
    async prepare(a: CopyArgs, ctx) {
      const { src, dir, st, name } = await change('copy', a, ctx);
      return { action: 'Copy file', source: src, dest: join(dir, name), size: fmtSize(st.size), fingerprint: () => fp(src, dir) };
    },
    run: (a: CopyArgs, ctx) => doChange('copy', a, ctx),
  },
  'file.move': {
    async prepare(a: CopyArgs, ctx) {
      const { src, dir, st, name } = await change('move', a, ctx);
      return { action: a.newName ? 'Move and rename file' : 'Move file', source: src, dest: join(dir, name), size: fmtSize(st.size), fingerprint: () => fp(src, dir) };
    },
    run: (a: CopyArgs, ctx) => doChange('move', a, ctx),
  },
  'file.undo': {
    async run() {
      const log = await readUndo();
      const u = log.pop();
      if (!u) throw new ToolError('Nothing to undo. Or it has been over ten minutes.', 'refuse');
      const now = await stat(u.to).catch(() => null);
      if (!now || now.size !== u.size || now.mtimeMs !== u.mtime) {
        await writeUndo(log);
        throw new ToolError('That file changed since. Not touching it.', 'refuse');
      }
      if (u.kind === 'copy') await unlink(u.to); // removes only the copy Couch made
      else {
        if (await lstat(u.from).catch(() => null)) throw new ToolError('Something else is in its old spot now. Leaving it.', 'refuse');
        await rename(u.to, u.from);
      }
      await writeUndo(log);
      return { say: 'Undone. Like it never happened.' };
    },
  },
};

/** Card buttons: Open, Show in folder, Copy path. Same guards as the tools. */
export async function cardAction(it: Item, action: 'open' | 'reveal' | 'copyPath') {
  const g = await guardPath(String(it.data.path), roots(), { exactNamed: true });
  if (!g.ok) return false;
  if (action === 'open') return !isExecutable(g.real) && (await shell.openPath(g.real)) === '';
  if (action === 'reveal') shell.showItemInFolder(g.real);
  else clipboard.writeText(g.real);
  return true;
}
