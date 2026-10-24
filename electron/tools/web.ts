// Web tools: find (SerpApi finds, Browserbase verifies), read, download, open.
import { app, shell } from 'electron';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import MiniSearch from 'minisearch';
import { answer, rank } from '../gemma';
import { guardUrl, isSearchBoxSelector, judgeSite, PolicyError, useCap } from '../policy';
import { chunks } from './extract';
import { freeName } from './files';
import { siteSearch, SerpDown, type Organic } from './serp';
import { fmtSize, ids, ref, rt, ToolError, type Ctx, type Item, type Tool } from './rt';

const BB = 'https://api.browserbase.com/v1';
const bbKey = () => process.env.BROWSERBASE_API_KEY ?? '';
export const browserReady = () => Boolean(bbKey() && process.env.BROWSERBASE_PROJECT_ID);
const sessionsFile = () => join(rt.userData, 'bb-sessions.json');

const readIds = async (): Promise<string[]> => JSON.parse(await readFile(sessionsFile(), 'utf8').catch(() => '[]')) as string[];
const writeIds = (x: string[]) => writeFile(sessionsFile(), JSON.stringify(x)).catch(() => undefined);

async function release(id: string) {
  await fetch(`${BB}/sessions/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'X-BB-API-Key': bbKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'REQUEST_RELEASE', projectId: process.env.BROWSERBASE_PROJECT_ID }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}

/** App start: release any session a crash left open. Only sessions this app created (ids kept locally). */
export async function cleanupSessions() {
  if (!browserReady()) return;
  const left = await readIds();
  await Promise.all(left.map(release));
  await writeIds([]);
}

/** One cloud browser session, always released in `finally`. */
export async function withBrowser<T>(fn: (page: Page) => Promise<T>, signal: AbortSignal): Promise<T> {
  if (!browserReady()) throw new ToolError('No cloud browser key set up. Add the Browserbase key.');
  try {
    useCap(rt.userData, 'browser', rt.settings().caps.browserSessions);
  } catch (e) {
    if (e instanceof PolicyError) throw new ToolError('Out of browser trips for today. The cap says so.');
    throw e;
  }
  const res = await fetch(`${BB}/sessions`, {
    method: 'POST',
    headers: { 'X-BB-API-Key': bbKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: process.env.BROWSERBASE_PROJECT_ID }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!res?.ok) throw new ToolError("The cloud browser won't start.");
  const s = (await res.json()) as { id: string; connectUrl: string };
  await writeIds([...(await readIds()), s.id]);
  let browser: Browser | null = null;
  const onAbort = () => void browser?.close().catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    browser = await chromium.connectOverCDP(s.connectUrl, { timeout: 20_000 });
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    return await fn(page);
  } finally {
    signal.removeEventListener('abort', onAbort);
    await browser?.close().catch(() => undefined);
    await release(s.id);
    await writeIds((await readIds()).filter((x) => x !== s.id));
  }
}

const sameSite = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
type Loaded = { ok: true; title: string; text: string; url: string } | { ok: false; why: 'captcha' | 'login' | 'redirect' | 'load' };

/** Load one page and say what it really is. Stops on captcha, login wall or a jump to another domain. */
async function load(page: Page, url: string, domain: string): Promise<Loaded> {
  try {
    await guardUrl(url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  } catch {
    return { ok: false, why: 'load' };
  }
  const now = new URL(page.url());
  if (!sameSite(now.hostname.replace(/^www\./, ''), domain)) return { ok: false, why: 'redirect' };
  await dismissCookies(page);
  const text = (await page.evaluate(() => (globalThis as unknown as { document: { body?: { innerText: string } } }).document.body?.innerText ?? '').catch(() => '')).slice(0, 50_000);
  if (/captcha|are you a robot|verify you are human|unusual traffic|press and hold/i.test(text.slice(0, 3000))) return { ok: false, why: 'captcha' };
  if ((await page.locator('input[type=password]').count().catch(() => 0)) > 0 && text.length < 3000) return { ok: false, why: 'login' };
  return { ok: true, title: await page.title().catch(() => ''), text, url: page.url() };
}

/** Cookie banners: only an obvious reject/decline/close. Never accept. */
async function dismissCookies(page: Page) {
  const btn = page.getByRole('button', { name: /^(reject( all)?|decline( all)?|close|no,? thanks|only necessary|necessary only)$/i }).first();
  if (await btn.isVisible({ timeout: 500 }).catch(() => false)) await btn.click({ timeout: 2000 }).catch(() => undefined);
}

const WHY: Record<string, string> = {
  captcha: "Bot wall. I'm not fighting it.",
  login: "It wants a login. I don't do logins.",
  redirect: 'It sent me to some other site. Stopped.',
  load: "That site won't load.",
};

const matches = (text: string, query: string) => {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const t = text.toLowerCase();
  return words.length === 0 || words.some((w) => t.includes(w));
};
const price = (text: string) => text.match(/[$€£]\s?\d[\d,]*(\.\d{2})?/)?.[0];

async function find(a: { site: string; query: string; filetype?: string }, ctx: Ctx) {
  const { domain } = judgeSite(a.site, ctx.userText);
  rt.say(`Looking on ${domain}.`);
  await guardUrl(`https://${domain}`).catch(() => {
    throw new ToolError("That's not a site I'll go to.", 'refuse');
  });
  const deadline = AbortSignal.any([ctx.signal, AbortSignal.timeout(60_000)]);
  let found: Organic[] = [];
  let serpTrouble = '';
  try {
    found = await siteSearch(domain, a.query, a.filetype, deadline); // no second, shorter search: the site's own search box is the fallback
  } catch (e) {
    if (!(e instanceof SerpDown)) throw e;
    serpTrouble = e.message === 'cap' ? 'Search cap hit for today. ' : 'Search is down. ';
  }
  const shopping = /cheap|price|buy|cost|\$/i.test(ctx.userText);
  if (!browserReady() && found.length) {
    const items = ids(found.slice(0, 3).map((r) => ({ kind: 'link' as const, title: r.title, detail: `${domain} · not checked (no cloud browser)`, snippet: r.snippet, data: { url: r.link } })));
    return { items, say: "Found these. Couldn't double-check them without the cloud browser." };
  }
  return withBrowser(async (page) => {
    let loads = 0;
    let candidates = found.filter((r) => {
      try {
        return sameSite(new URL(r.link).hostname.replace(/^www\./, ''), domain) && new URL(r.link).protocol === 'https:';
      } catch {
        return false;
      }
    });
    if (!candidates.length) {
      // Fallback: the site's own search box. Only that box is ever typed into.
      rt.progress(`${serpTrouble}On the site, using its search box...`);
      loads++;
      const home = await load(page, `https://${domain}`, domain);
      if (!home.ok) throw new ToolError(WHY[home.why]);
      const box = page.locator(isSearchBoxSelector).first();
      if (!(await box.isVisible({ timeout: 2000 }).catch(() => false))) throw new ToolError("Couldn't find a search box on that site.");
      await box.fill(a.query);
      await box.press('Enter');
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined);
      loads++;
      if (!sameSite(new URL(page.url()).hostname.replace(/^www\./, ''), domain)) throw new ToolError(WHY.redirect);
      const links = await page.$$eval('a[href]', (as) => as.map((x) => ({ title: (x.textContent ?? '').trim(), link: (x as unknown as { href: string }).href })));
      candidates = links
        .filter((l) => l.title.length > 3 && l.link.startsWith('https://') && sameSite(new URL(l.link).hostname.replace(/^www\./, ''), domain))
        .slice(0, 10)
        .map((l) => ({ ...l, snippet: '' }));
    }
    if (!candidates.length) throw new ToolError('Nothing there matched. Describe it differently?');
    rt.progress(`on ${domain}, checking...`);
    const best = await rank(a.query, candidates.map((c) => `${c.title} | ${c.link} | ${c.snippet}`), 3, deadline);
    const order = (best.length ? best : [0, 1, 2]).map((i) => candidates[i]).filter(Boolean);
    const verified: Omit<Item, 'id'>[] = [];
    let stop = '';
    // Check the candidates side by side in one session (tabs), still at most 3 page loads in total.
    const batch = order.slice(0, Math.max(0, 3 - loads));
    const pages = await Promise.all(
      batch.map(async (c, i) => {
        const tab = i === 0 ? page : await page.context().newPage();
        try {
          return { c, r: await load(tab, c.link, domain) };
        } finally {
          if (tab !== page) await tab.close().catch(() => undefined);
        }
      }),
    );
    for (const { c, r } of pages) {
      if (!r.ok) {
        if (r.why === 'captcha' || r.why === 'login') stop = WHY[r.why];
        continue; // 38a: drop it
      }
      if (!matches(`${r.title} ${r.text.slice(0, 2000)}`, a.query)) continue;
      const p = shopping ? price(r.text.slice(0, 5000)) : undefined;
      verified.push({ kind: 'link', title: r.title || c.title, detail: `${domain}${p ? ` · ${p}` : ''}`, snippet: r.text.slice(0, 200).replace(/\s+/g, ' '), data: { url: r.url } });
    }
    if (!verified.length) throw new ToolError(stop || (deadline.aborted ? 'Ran out of time on that site.' : 'Nothing there matched. Describe it differently?'));
    const items = ids(verified);
    return { items, chosen: items.length === 1 ? items[0] : undefined };
  }, deadline);
}

async function urlOf(a: { ref?: string; url?: string }, ctx: Ctx): Promise<URL> {
  const raw = a.ref ? String(ref(a.ref, ctx).data.url ?? '') : String(a.url);
  if (!raw) throw new ToolError("That one doesn't have a link.", 'refuse');
  try {
    return await guardUrl(raw);
  } catch {
    throw new ToolError("That's a private or non-https address. Not going.", 'refuse');
  }
}

// ---------- download: allowed types, 100 MB, Downloads/Couch, every redirect hop re-checked ----------

const ALLOWED = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'txt', 'jpg', 'jpeg', 'png']);
const MAX_DL = 100 * 1024 * 1024;
const MIME: Record<string, string> = { 'application/pdf': 'pdf', 'text/csv': 'csv', 'text/plain': 'txt', 'image/jpeg': 'jpg', 'image/png': 'png', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx' };

async function fetchGuarded(u: URL, method: 'HEAD' | 'GET', signal: AbortSignal): Promise<Response> {
  let url = u;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, { method, redirect: 'manual', signal });
    if (res.status < 300 || res.status >= 400) return res;
    const next = res.headers.get('location');
    if (!next) break;
    url = await guardUrl(new URL(next, url).href);
  }
  throw new ToolError('Too many redirects. Stopped.');
}

async function probe(u: URL, signal: AbortSignal) {
  const res = await fetchGuarded(u, 'HEAD', signal).catch((e) => {
    if (e instanceof ToolError) throw e;
    throw new ToolError("That site won't answer.");
  });
  const type = MIME[(res.headers.get('content-type') ?? '').split(';')[0].trim()] ?? extname(u.pathname).slice(1).toLowerCase();
  const size = Number(res.headers.get('content-length') ?? NaN);
  const cd = res.headers.get('content-disposition')?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1];
  let raw = cd ?? u.pathname;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // malformed %-escape: keep it as is
  }
  const stem = basename(raw).replace(/[\\/:*?"<>|]/g, '_').replace(/\.[^.]*$/, '').slice(0, 120) || 'download';
  const name = `${stem}.${type}`; // the extension always matches the checked type: a "pdf" can't land as .exe
  return { type, size, name };
}

export const webTools: Record<string, Tool<any>> = {
  'web.find': {
    run: (a, ctx) => find(a, ctx),
  },
  'web.read': {
    async run(a: { ref?: string; url?: string; question: string }, ctx) {
      const u = await urlOf(a, ctx);
      const domain = u.hostname.replace(/^www\./, '');
      return withBrowser(async (page) => {
        const r = await load(page, u.href, domain);
        if (!r.ok) throw new ToolError(WHY[r.why]);
        const parts = chunks(r.text);
        const idx = new MiniSearch({ fields: ['t'], storeFields: ['t'] });
        idx.addAll(parts.map((t, id) => ({ id, t })));
        const top = idx.search(a.question, { fuzzy: 0.2, prefix: true }).slice(0, 3);
        const ans = await answer(a.question, (top.length ? top.map((h) => String(h.t)) : parts.slice(0, 3)).join('\n...\n'), ctx.signal);
        return { card: { title: r.title || domain, body: ans }, say: ans.split(/(?<=[.!?])\s/)[0].slice(0, 140) };
      }, AbortSignal.any([ctx.signal, AbortSignal.timeout(60_000)]));
    },
  },
  'web.download': {
    async prepare(a, ctx) {
      const u = await urlOf(a, ctx);
      const p = await probe(u, ctx.signal);
      if (!ALLOWED.has(p.type)) throw new ToolError(`I only download pdf, docx, xlsx, pptx, csv, txt, jpg, png. That's ${p.type || 'unknown'}.`, 'refuse');
      if (p.size > MAX_DL) throw new ToolError('Over 100 MB. Too heavy for me.', 'refuse');
      const dir = join(app.getPath('downloads'), 'Couch');
      return { action: 'Download file', source: u.href, dest: join(dir, p.name), size: Number.isFinite(p.size) ? fmtSize(p.size) : 'unknown', fingerprint: async () => JSON.stringify(await probe(u, ctx.signal)) };
    },
    async run(a, ctx) {
      const u = await urlOf(a, ctx);
      const p = await probe(u, ctx.signal);
      if (!ALLOWED.has(p.type) || p.size > MAX_DL) throw new ToolError('That file changed into something I will not download.', 'refuse');
      const dir = join(app.getPath('downloads'), 'Couch');
      await mkdir(dir, { recursive: true });
      const dest = await freeName(dir, p.name);
      const part = `${dest}.part`;
      try {
        const res = await fetchGuarded(u, 'GET', AbortSignal.any([ctx.signal, AbortSignal.timeout(300_000)]));
        if (!res.ok || !res.body) throw new Error('http');
        const served = MIME[(res.headers.get('content-type') ?? '').split(';')[0].trim()];
        if (served && served !== p.type && !(served === 'jpg' && p.type === 'jpeg')) throw new Error('type-changed');
        let got = 0;
        const body = Readable.fromWeb(res.body as never);
        body.on('data', (c: Buffer) => {
          got += c.length;
          if (got > MAX_DL) body.destroy(new Error('too-big'));
        });
        await pipeline(body, createWriteStream(part, { flags: 'wx' }));
        await rename(part, dest);
      } catch (e) {
        await unlink(part).catch(() => undefined); // never leave a partial file behind
        throw new ToolError((e as Error).message === 'too-big' ? 'It kept growing past 100 MB. Stopped and cleaned up.' : 'Download failed. Cleaned up the pieces.');
      }
      return { card: { title: 'Downloaded', body: dest }, say: "Saved it to Downloads, Couch folder. Didn't open it." };
    },
  },
  'web.open': {
    async run(a, ctx) {
      await shell.openExternal((await urlOf(a, ctx)).href);
      return { sayKind: 'done' };
    },
  },
};
