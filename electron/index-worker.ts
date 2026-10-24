// Worker thread: walk allowed roots, extract text, keep a MiniSearch index on disk, watch for changes, answer searches.
import MiniSearch from 'minisearch';
import { watch, type FSWatcher } from 'node:fs';
import { lstat, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { isDenied, isInside } from './policy';
import { attrOf, ext, extractText, isHiddenAttr, isPlaceholder, winAttrs, winAttrsOf } from './tools/extract';

export interface Doc {
  id: number;
  path: string;
  name: string;
  ext: string;
  size: number;
  mtime: number;
  folder: string;
  snippet: string;
  cloud: boolean;
  text?: string;
}
export interface Query {
  keywords: string[];
  nameHints: string[];
  extensions: string[];
  modifiedAfter: string | null;
  modifiedBefore: string | null;
  folderHint: string | null;
}
export type Hit = Omit<Doc, 'text' | 'id'> & { score: number };
export type ToWorker = { t: 'search'; id: number; q: Query } | { t: 'remove'; path: string } | { t: 'roots'; roots: string[] };
export type FromWorker = { t: 'progress'; indexed: number; building: boolean } | { t: 'result'; id: number; hits: Hit[]; partial: boolean };

const MAX_FILE = 200 * 1024 * 1024;
const MAX_PDF = 30 * 1024 * 1024; // big PDFs cost seconds of CPU each: name only
const INDEX_TEXT = 8 * 1024; // enough to find a file by what is in it; file.read extracts the full text itself
const NOISE = /(^~\$|\.tmp$|\.crdownload$|\.partial$|\.part$|\.download$|^desktop\.ini$|^thumbs\.db$)/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'cache', '__pycache__', '.venv', 'venv', '$recycle.bin', '.next', 'dist', 'build', '.gradle', '.idea', '.vscode', 'release', 'win-unpacked', 'out', 'target', 'coverage', 'bin', 'obj', 'packages', 'site-packages', 'appdata']);
// Code and data dumps: found by name only. Their text bloated the index (24 MB) without helping "find my lease".
const NAME_ONLY = /\.(js|mjs|cjs|jsx|ts|tsx|map|json|css|scss|html|xml|yml|yaml|toml|ini|lock|log|sql|c|h|cpp|hpp|cs|go|rs|rb|php|java|kt|py|sh|ps1|bat|swift|lua)$/i;
const WIN = process.platform === 'win32';
const key = (p: string) => (WIN ? p.toLowerCase() : p);

const OPTIONS = {
  fields: ['name', 'text', 'folder'],
  storeFields: ['path', 'name', 'ext', 'size', 'mtime', 'folder', 'snippet', 'cloud'],
  searchOptions: { boost: { name: 3, folder: 1.5 }, fuzzy: 0.2, prefix: true },
};

const { indexFile } = workerData as { indexFile: string; roots: string[] };
let roots: string[] = (workerData as { roots: string[] }).roots;
let ms = new MiniSearch<Doc>(OPTIONS);
let meta = new Map<string, { id: number; mtime: number; size: number }>();
let nextId = 1;
let building = true;
let dirty = 0;
const watchers: FSWatcher[] = [];
const hiddenDirs = new Set<string>(); // hidden/system folders seen by the scan: the watcher skips them too

const post = (m: FromWorker) => parentPort?.postMessage(m);

async function load() {
  try {
    const raw = JSON.parse(await readFile(indexFile, 'utf8')) as { v: 1; ms: unknown; meta: [string, { id: number; mtime: number; size: number }][] };
    ms = MiniSearch.loadJS<Doc>(raw.ms as never, OPTIONS);
    meta = new Map(raw.meta);
    nextId = Math.max(0, ...[...meta.values()].map((m) => m.id)) + 1;
  } catch {
    // no index yet, or corrupt: rebuild
  }
}

async function persist() {
  dirty = 0;
  const tmp = indexFile + '.tmp';
  await writeFile(tmp, JSON.stringify({ v: 1, ms: ms.toJSON(), meta: [...meta] }));
  await rename(tmp, indexFile);
}

function removePath(p: string) {
  const m = meta.get(key(p));
  if (!m) return;
  if (ms.has(m.id)) ms.discard(m.id);
  meta.delete(key(p));
  dirty++;
}

async function indexFileAt(p: string, attrs: number) {
  if (isDenied(p) || basename(p).startsWith('.') || isHiddenAttr(attrs)) return removePath(p);
  let st;
  try {
    st = await lstat(p);
  } catch {
    return removePath(p);
  }
  if (!st.isFile()) return; // symlinks and junctions are never followed
  const old = meta.get(key(p));
  if (old && old.mtime === st.mtimeMs && old.size === st.size) return;
  removePath(p);
  const cloud = isPlaceholder(attrs);
  // Name-only for cloud placeholders (reading would trigger a download), huge files, and anything that fails to extract.
  let text = '';
  if (!cloud && !NAME_ONLY.test(p) && st.size <= (ext(p) === 'pdf' ? MAX_PDF : MAX_FILE)) {
    const t0 = Date.now();
    const r = await extractText(p, INDEX_TEXT);
    if ('text' in r) text = r.text;
    // Rest as long as the file took: at most half of one core, so an old laptop stays usable during the first scan.
    await sleep(Math.max(4, Date.now() - t0));
  }
  const id = nextId++;
  const doc: Doc = {
    id,
    path: p,
    name: basename(p),
    ext: ext(p),
    size: st.size,
    mtime: st.mtimeMs,
    folder: dirname(p),
    snippet: text.replace(/\s+/g, ' ').slice(0, 150),
    cloud,
    text,
  };
  ms.add(doc);
  meta.set(key(p), { id, mtime: st.mtimeMs, size: st.size });
  dirty++; // saved at the end of the scan or 30 s after watcher changes: writing the whole index is expensive
}

async function walk(dir: string, attrs: Map<string, number>, seen: Set<string>) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // locked or permission denied: move on
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.') && !isDenied(p) && !isHiddenAttr(attrs.get(key(p)) ?? 0)) await walk(p, attrs, seen);
      else if (isHiddenAttr(attrs.get(key(p)) ?? 0)) hiddenDirs.add(key(p));
    } else if (e.isFile()) {
      seen.add(key(p));
      if (NOISE.test(e.name)) continue;
      await indexFileAt(p, attrOf(attrs, p));
      if (seen.size % 200 === 0) post({ t: 'progress', indexed: meta.size, building: true });
    }
  }
}

async function scan() {
  building = true;
  const seen = new Set<string>();
  for (const r of roots) await walk(r, await winAttrs(r), seen);
  // Startup rescan: anything gone since last time leaves the index.
  for (const k of [...meta.keys()]) if (!seen.has(k)) removePath(k);
  building = false;
  await persist();
  post({ t: 'progress', indexed: meta.size, building: false });
}

const pending = new Set<string>();
let timer: NodeJS.Timeout | null = null;
let busy = false;
let persistTimer: NodeJS.Timeout | null = null;

/** Save at most every 30 s after watcher changes. */
function schedulePersist() {
  persistTimer ??= setTimeout(() => {
    persistTimer = null;
    if (dirty) void persist().catch(() => undefined);
  }, 30_000);
}

// Scans and watcher batches run one at a time, never side by side (two scans of one folder added files twice).
let job: Promise<unknown> = Promise.resolve();
const serial = (f: () => Promise<unknown>) => (job = job.then(f).catch(() => undefined));
const skipSeg = (rel: string) => rel.split(/[\\/]/).some((s) => SKIP_DIRS.has(s.toLowerCase()) || s.startsWith('.'));

/** 3 s after the last change: one PowerShell call per batch, at most 300 files a batch. */
function drain() {
  if (busy) return;
  busy = true;
  void serial(async () => {
    while (pending.size) {
      const batch = [...pending].slice(0, 300);
      for (const p of batch) pending.delete(p);
      const files: string[] = [];
      const dirs: string[] = [];
      for (const p of batch) {
        if (!roots.some((x) => isInside(p, x)) || isDenied(p) || [...hiddenDirs].some((h) => isInside(key(p), h))) continue;
        const st = await lstat(p).catch(() => null);
        if (!st) {
          // A deleted/renamed folder: drop everything under it.
          for (const k of [...meta.keys()]) if (k === key(p) || k.startsWith(key(p) + '\\') || k.startsWith(key(p) + '/')) removePath(k);
        } else if (st.isFile()) files.push(p);
        else if (st.isDirectory()) dirs.push(p); // renamed or moved-in folder: Windows sends no events for the files inside
      }
      const attrs = await winAttrsOf(files);
      for (const p of files) await indexFileAt(p, attrOf(attrs, p));
      // Walk only the outermost new folders, at most 20 a batch (each costs one PowerShell call).
      const top = dirs.filter((d) => !dirs.some((o) => o !== d && isInside(d, o))).slice(0, 20);
      for (const d of top) await walk(d, await winAttrs(d), new Set());
      if (dirty) schedulePersist();
    }
  }).finally(() => (busy = false));
}

function startWatch() {
  for (const w of watchers.splice(0)) w.close();
  for (const r of roots) {
    try {
      const w = watch(r, { recursive: true }, (_ev, file) => {
        if (!file || NOISE.test(basename(file.toString())) || skipSeg(file.toString())) return; // same skips as the scan (dist, venv, .git...)
        if (pending.size < 20_000) pending.add(join(r, file.toString()));
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void drain();
        }, 3000);
      });
      w.on('error', () => undefined); // a root that disappears must not kill the worker
      watchers.push(w);
    } catch {
      // root missing or not watchable: the startup rescan still covers it
    }
  }
}

function search(q: Query): Hit[] {
  const words = [...q.keywords, ...q.nameHints].join(' ').trim();
  const after = q.modifiedAfter ? Date.parse(q.modifiedAfter) : -Infinity;
  const before = q.modifiedBefore ? Date.parse(q.modifiedBefore) + 86_400_000 : Infinity;
  const exts = new Set(q.extensions.map((e) => e.toLowerCase().replace(/^\./, '')));
  const run = (folder: string | null) =>
    ms.search(words || MiniSearch.wildcard, {
      filter: (r) => (exts.size === 0 || exts.has(r.ext)) && r.mtime >= after && r.mtime < before && (!folder || String(r.path).toLowerCase().includes(folder.toLowerCase())),
      boostDocument: (_id, _term, r) => {
        let b = 1;
        const name = String(r?.name ?? '').toLowerCase();
        if (q.nameHints.some((h) => name.includes(h.toLowerCase()))) b *= 1.5; // exact name hit
        if (r && Date.now() - Number(r.mtime) < 30 * 86_400_000) b *= 1.15; // recent
        if (/\\(downloads|desktop)\\/i.test(String(r?.path))) b *= 1.05;
        return b;
      },
    });
  let res = run(q.folderHint);
  if (!res.length && q.folderHint) res = run(null); // a vague folder hint should not hide everything
  return res.slice(0, 10).map((r) => ({ path: r.path, name: r.name, ext: r.ext, size: r.size, mtime: r.mtime, folder: r.folder, snippet: r.snippet, cloud: r.cloud, score: r.score }));
}

process.on('unhandledRejection', () => undefined); // a failed file never takes the whole index down

parentPort?.on('message', async (m: ToWorker) => {
  if (m.t === 'search') post({ t: 'result', id: m.id, hits: search(m.q), partial: building });
  else if (m.t === 'remove') {
    removePath(m.path);
    schedulePersist();
  } else if (m.t === 'roots') {
    roots = m.roots;
    await serial(scan);
    startWatch();
  }
});

void (async () => {
  await load();
  post({ t: 'progress', indexed: meta.size, building: true });
  await serial(scan);
  startWatch(); // after the scan: watching during it doubled the work
})();
