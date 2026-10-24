// Policy engine: the model proposes, this file decides. No Electron imports (also used by the index worker and tests).
import { realpath } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { basename, join, sep } from 'node:path';
import { z } from 'zod';

// ---------- tool catalog: names, tiers, strict arg schemas ----------

/** T0 read-only (auto), T1 reversible (auto), T2 changes data (confirm), T3 forbidden (never implemented). */
export type Tier = 0 | 1 | 2 | 3;
export type Anchor = 'home' | 'resultsWindow' | 'device' | 'playerWindow' | 'screenPoint';

// A reference into the last result set ("r1".."r5") or the previous step's result ("$prev").
// The model never writes paths, hosts or URLs for file/device tools: their schemas have no field for one.
export const isRef = (v: unknown) => typeof v === 'string' && /^(\$prev|r[1-9])$/.test(v);
const Ref = z.string().refine(isRef, 'ref must be "$prev" or r1..r9');
const Short = (n: number) => z.string().trim().min(1).max(n);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/);

export const CAPABILITIES = [
  'power',
  'brightness',
  'colorTemp',
  'color',
  'volume',
  'mute',
  'input',
  'channel',
  'targetTemp',
  'mode',
  'fanSpeed',
  'position',
  'lock',
] as const;
export type Capability = (typeof CAPABILITIES)[number];
const DeviceValue = z.union([z.boolean(), z.number(), Short(20)]);

const tool = <S extends z.ZodType>(tier: Tier, anchor: Anchor, desc: string, args: S) => ({ tier, anchor, desc, args });

export const catalog = {
  'file.search': tool(
    0,
    'resultsWindow',
    'Search local files by words, name hints, type, date, folder.',
    z
      .object({
        keywords: z.array(Short(60)).max(10).default([]),
        nameHints: z.array(Short(60)).max(5).default([]),
        extensions: z.array(z.string().regex(/^[a-z0-9]{1,8}$/i)).max(8).default([]),
        modifiedAfter: IsoDate.nullable().default(null),
        modifiedBefore: IsoDate.nullable().default(null),
        folderHint: Short(60).nullable().default(null),
      })
      .strict(),
  ),
  'file.read': tool(0, 'home', 'Answer a question about one file from the results.', z.object({ ref: Ref, question: Short(300) }).strict()),
  'file.open': tool(1, 'resultsWindow', 'Open a file from the results. browser=true opens it in the web browser.', z.object({ ref: Ref, browser: z.boolean().optional() }).strict()),
  'file.reveal': tool(1, 'resultsWindow', 'Show a file from the results in Explorer.', z.object({ ref: Ref }).strict()),
  'file.copy': tool(2, 'resultsWindow', 'Copy a result file into an allowed folder by name (e.g. Desktop).', z.object({ ref: Ref, dest: Short(60) }).strict()),
  'file.move': tool(
    2,
    'resultsWindow',
    'Move or rename a result file inside allowed folders.',
    z.object({ ref: Ref, dest: Short(60), newName: z.string().regex(/^[^\\/:*?"<>|]{1,120}$/).optional() }).strict(),
  ),
  'file.undo': tool(1, 'resultsWindow', 'Undo the last file copy or move (10 minutes).', z.object({}).strict()),
  'note.add': tool(1, 'screenPoint', 'Append a line to the notes file.', z.object({ text: Short(500) }).strict()),
  'web.find': tool(
    0,
    'resultsWindow',
    'Find a page or item on a named website.',
    z.object({ site: Short(100), query: Short(150), filetype: z.string().regex(/^[a-z0-9]{1,5}$/).optional() }).strict(),
  ),
  'web.read': tool(
    0,
    'home',
    'Read one web page (result ref or https url) and answer.',
    z.object({ ref: Ref.optional(), url: Short(500).optional(), question: Short(300) }).strict(),
  ),
  'web.download': tool(2, 'resultsWindow', 'Download a file from a result or url into Downloads/Couch.', z.object({ ref: Ref.optional(), url: Short(500).optional() }).strict()),
  'web.open': tool(1, 'resultsWindow', 'Open a result link or https url in the browser.', z.object({ ref: Ref.optional(), url: Short(500).optional() }).strict()),
  'media.search': tool(0, 'resultsWindow', 'Search YouTube for a song or video.', z.object({ query: Short(150), kind: z.enum(['song', 'video']) }).strict()),
  'media.play': tool(1, 'playerWindow', 'Play a media result.', z.object({ ref: Ref }).strict()),
  'media.control': tool(
    1,
    'playerWindow',
    'Pause, resume, stop or set volume of the in-app player.',
    z.object({ action: z.enum(['pause', 'resume', 'stop', 'volume']), level: z.number().optional() }).strict(),
  ),
  'screen.look': tool(
    2,
    'home',
    'ONLY when the user asks you to look at or read their screen. One screenshot, answers the question, cannot act.',
    z.object({ question: Short(300) }).strict(),
  ),
  'screen.dim': tool(1, 'screenPoint', 'Dim the SCREEN (display) 0 to 85 percent. 0 restores.', z.object({ level: z.number() }).strict()),
  'screen.brightness': tool(1, 'screenPoint', 'Set the real SCREEN brightness 5 to 100, or "up"/"down".', z.object({ level: z.union([z.number(), z.enum(['up', 'down'])]) }).strict()),
  'app.launch': tool(1, 'screenPoint', 'Launch an installed app by name.', z.object({ name: Short(80) }).strict()),
  'timer.set': tool(1, 'screenPoint', 'Reminder after N minutes with a label.', z.object({ minutes: z.number().positive().max(10080), label: Short(120) }).strict()),
  'clipboard.copy': tool(1, 'screenPoint', 'Copy given text, or a result file path, to the clipboard.', z.object({ text: Short(2000).optional(), ref: Ref.optional() }).strict()),
  'schedule.add': tool(
    1,
    'screenPoint',
    'Run one T0/T1 step later. at = ISO local datetime, or inMinutes.',
    z
      .object({
        at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/).optional(),
        inMinutes: z.number().positive().max(10080).optional(),
        repeat: z.enum(['none', 'daily', 'weekdays']).default('none'),
        label: Short(120),
        step: z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) }).strict().nullable().default(null),
      })
      .strict(),
  ),
  'schedule.list': tool(0, 'home', 'List timers and schedules.', z.object({}).strict()),
  'schedule.cancel': tool(1, 'home', 'Cancel a timer or schedule by label words, or the latest.', z.object({ label: Short(120).optional() }).strict()),
  'device.list': tool(0, 'home', 'List smart devices, optionally by room.', z.object({ room: Short(40).optional() }).strict()),
  'device.status': tool(0, 'device', 'Read one device state. device = spoken name.', z.object({ device: Short(60) }).strict()),
  'device.set': tool(
    1,
    'device',
    'Set a device capability. device = spoken name.',
    z.object({ device: Short(60), capability: z.enum(CAPABILITIES), value: DeviceValue }).strict(),
  ),
  'device.scene': tool(1, 'device', 'Run a saved scene by name.', z.object({ name: Short(40) }).strict()),
  'device.discover': tool(0, 'home', 'Look for new devices on the local network.', z.object({}).strict()),
  'device.add': tool(2, 'home', 'Add a discovered device from the results.', z.object({ ref: Ref, name: Short(40), room: Short(40).optional() }).strict()),
  'device.remove': tool(2, 'home', 'Remove a device from the registry.', z.object({ device: Short(60) }).strict()),
} as const;

export type ToolName = keyof typeof catalog;
export type Step = { tool: ToolName; args: Record<string, unknown> };
export const isTool = (t: string): t is ToolName => Object.hasOwn(catalog, t);

/** Tools whose result is a result set that "$prev" and "r1".."r5" can point at. */
export const RESULT_TOOLS: ToolName[] = ['file.search', 'web.find', 'media.search', 'device.discover', 'device.list', 'schedule.list'];

// T3, never implemented, listed so the refusal is explicit: shell, delete, email, payments, passwords, settings, installs, registry, capture, uploads.
export const T3 = ['shell', 'delete', 'email', 'message', 'payment', 'password', 'settings', 'install', 'registry', 'screenshot', 'keylog', 'upload'];

// ---------- dynamic tiers (devices) ----------

const RISKY_KINDS = new Set(['lock', 'garage', 'door', 'gate']);

/** Tier of one step. Unlocking and opening doors/garages always need a confirm. */
export function tierOf(step: Step, deviceKind?: string): Tier {
  const base = catalog[step.tool].tier;
  if (step.tool !== 'device.set') return base;
  const { capability, value } = step.args as { capability: Capability; value: unknown };
  if (capability === 'lock') {
    // Whatever form the value takes (false, 0, "false", "open"...), if it is not clearly "locked", it needs a Yes.
    try {
      if (clampValue('lock', value) === false) return 2;
    } catch {
      return 2;
    }
  }
  if (deviceKind && RISKY_KINDS.has(deviceKind) && capability !== 'lock') return 2;
  return base;
}

/** Schedules may only hold T0/T1 steps; the nested step must be a valid catalog step too. */
export function checkScheduledStep(step: { tool: string; args: unknown } | null, deviceKind?: string): string | null {
  if (!step) return null;
  if (!isTool(step.tool) || step.tool.startsWith('schedule.')) return 'unknown-or-nested';
  const parsed = catalog[step.tool].args.safeParse(step.args);
  if (!parsed.success) return 'bad-args';
  if (Object.values(step.args as object).some(isRef)) return 'ref-in-schedule';
  return tierOf({ tool: step.tool, args: parsed.data as Record<string, unknown> }, deviceKind) >= 2 ? 'needs-confirm' : null;
}

// ---------- device values: clamp in code ----------

export const MODES = ['off', 'cool', 'heat', 'auto', 'fan', 'dry'] as const;

/** Clamp/normalize a device value; throws on nonsense. */
export function clampValue(cap: Capability, raw: unknown): boolean | number | string {
  const num = (lo: number, hi: number, int = true) => {
    const n = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('bad-value');
    const c = Math.min(hi, Math.max(lo, n));
    return int ? Math.round(c) : Math.round(c * 2) / 2;
  };
  const bool = () => {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'on' || raw === 'true' || raw === 1 || raw === 'locked' || raw === 'lock') return true;
    if (raw === 'off' || raw === 'false' || raw === 0 || raw === 'unlocked' || raw === 'unlock') return false;
    throw new Error('bad-value');
  };
  switch (cap) {
    case 'power':
    case 'mute':
    case 'lock':
      return bool();
    case 'brightness':
    case 'volume':
    case 'position':
      return num(0, 100);
    case 'colorTemp':
      return num(2000, 6500); // kelvin
    case 'targetTemp':
      return num(16, 30, false); // celsius, half steps
    case 'fanSpeed':
      return num(0, 5);
    case 'channel':
      return num(1, 9999);
    case 'color': {
      const s = String(raw).trim().toLowerCase();
      if (/^#[0-9a-f]{6}$/.test(s)) return s;
      const named: Record<string, string> = { red: '#ff3b30', green: '#34c759', blue: '#007aff', warm: '#ffb46b', white: '#ffffff', purple: '#af52de', orange: '#ff9500', pink: '#ff6fb1', yellow: '#ffd60a' };
      if (named[s]) return named[s];
      throw new Error('bad-value');
    }
    case 'mode': {
      const s = String(raw).toLowerCase();
      if ((MODES as readonly string[]).includes(s)) return s;
      throw new Error('bad-value');
    }
    case 'input': {
      const s = String(raw).trim();
      if (/^[\w .-]{1,20}$/.test(s)) return s;
      throw new Error('bad-value');
    }
  }
}

// ---------- file path guard ----------

const WIN = process.platform === 'win32';
const norm = (p: string) => (WIN ? p.toLowerCase() : p);

const DENY_SEGMENTS = ['.ssh', '.aws', '.gnupg', '.git', 'appdata', 'windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin', 'system volume information', '1password', 'bitwarden', 'keepass', 'keepassxc', 'lastpass', 'dashlane', 'node_modules'];
const DENY_PATH_PARTS = ['google\\chrome\\user data', 'microsoft\\edge\\user data', 'mozilla\\firefox\\profiles', 'bravesoftware', 'google/chrome', 'firefox/profiles'];
const DENY_NAME = /(\.pem|\.key|\.kdbx|\.pfx|\.p12|\.ppk)$|^\.env|^id_(rsa|dsa|ecdsa|ed25519)|credentials|secret/i;

/** True if any part of this path is on the denylist. Case-insensitive on Windows. */
export function isDenied(p: string): boolean {
  const n = p.toLowerCase();
  const segs = n.split(/[\\/]+/);
  if (segs.some((s) => DENY_SEGMENTS.includes(s))) return true;
  if (DENY_PATH_PARTS.some((d) => n.includes(d))) return true;
  return DENY_NAME.test(basename(p));
}

export function isInside(child: string, root: string): boolean {
  const c = norm(child);
  const r = norm(root).replace(/[\\/]+$/, '');
  return c === r || c.startsWith(r + sep) || c.startsWith(r + '/');
}

export const isHiddenName = (p: string) => basename(p).startsWith('.');
export const ATTR = { HIDDEN: 0x2, SYSTEM: 0x4, REPARSE: 0x400, OFFLINE: 0x1000, RECALL_ON_OPEN: 0x40000, RECALL_ON_DATA: 0x400000 };

export type PathCheck = { ok: true; real: string } | { ok: false; reason: 'missing' | 'outside' | 'denied' | 'hidden' };

/**
 * Resolve with realpath (follows symlinks and junctions) and check the REAL path against roots and denylist,
 * so a link can never lead outside the allowed roots. Hidden/system only if the user named the exact file.
 */
export async function guardPath(p: string, roots: string[], opts: { attrs?: number; exactNamed?: boolean } = {}): Promise<PathCheck> {
  let real: string;
  try {
    real = await realpath(p);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  const realRoots = await Promise.all(roots.map((r) => realpath(r).catch(() => r)));
  if (!realRoots.some((r) => isInside(real, r))) return { ok: false, reason: 'outside' };
  if (isDenied(p) || isDenied(real)) return { ok: false, reason: 'denied' };
  const hidden = isHiddenName(real) || ((opts.attrs ?? 0) & (ATTR.HIDDEN | ATTR.SYSTEM)) !== 0;
  if (hidden && !opts.exactNamed) return { ok: false, reason: 'hidden' };
  return { ok: true, real };
}

/** Destination folder for copy/move: an allowed root picked by its folder name, plus an optional subfolder. */
export function resolveDestRoot(dest: string, roots: string[]): string | null {
  const [head, ...rest] = dest.split(/[\\/]/).filter(Boolean);
  if (!head || rest.some((s) => s === '..' || s === '.')) return null;
  const root = roots.find((r) => norm(basename(r)) === norm(head) || norm(basename(r)) === norm(head.replace(/^my\s+/i, '')));
  return root ? join(root, ...rest) : null;
}

// ---------- IP classification (web SSRF + device LAN rules) ----------

function v4(ip: string): number[] | null {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  return m ? m.slice(1).map(Number) : null;
}

export function ipClass(ip: string): 'loopback' | 'private' | 'linklocal' | 'public' | 'reserved' {
  const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipClass(mapped[1]);
  // IPv4-mapped in hex form (URL parsing turns ::ffff:127.0.0.1 into ::ffff:7f00:1).
  const hex = ip.toLowerCase().match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
    return ipClass(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  // IPv4-compatible (::a.b.c.d, ::xxxx:xxxx) and NAT64 (64:ff9b::/96) can reach IPv4 hosts: never public.
  if ((/^::[0-9a-f.:]+$/i.test(ip) && ip !== '::1') || /^64:ff9b:/i.test(ip)) return 'reserved';
  const o = v4(ip);
  if (o) {
    const [a, b] = o;
    if (a === 127) return 'loopback';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
    if (a === 169 && b === 254) return 'linklocal';
    if (a === 0 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))) return 'reserved';
    return 'public';
  }
  const s = ip.toLowerCase();
  if (s === '::1') return 'loopback';
  if (s === '::') return 'reserved';
  if (/^f[cd]/.test(s)) return 'private';
  if (/^fe[89ab]/.test(s)) return 'linklocal';
  if (/^ff/.test(s)) return 'reserved';
  return 'public';
}

type Resolver = (host: string) => Promise<string[]>;
const dnsAll: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

// ---------- web guard ----------

export class PolicyError extends Error {}

/** https only (http upgraded), no credentials, no local/private targets, also after DNS. */
export async function guardUrl(raw: string, resolve: Resolver = dnsAll): Promise<URL> {
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new PolicyError('bad-url');
  }
  if (u.protocol === 'http:') u.protocol = 'https:';
  if (u.protocol !== 'https:') throw new PolicyError('not-https');
  if (u.username || u.password) throw new PolicyError('credentials-in-url');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !isIP(host))
    throw new PolicyError('local-host');
  const ips = isIP(host) ? [host] : await resolve(host).catch(() => {
    throw new PolicyError('dns-failed');
  });
  if (ips.length === 0 || ips.some((ip) => ipClass(ip) !== 'public')) throw new PolicyError('private-address');
  return u;
}

/** Device hosts come from the registry only, and must be on the laptop or the LAN. Public addresses are refused. */
export async function guardLanHost(host: string, resolve: Resolver = dnsAll): Promise<void> {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  const ips = isIP(h) ? [h] : await resolve(h).catch(() => {
    throw new PolicyError('dns-failed');
  });
  if (ips.length === 0 || ips.some((ip) => ipClass(ip) === 'public' || ipClass(ip) === 'reserved')) throw new PolicyError('not-lan');
}

export const WELL_KNOWN = new Set([
  'amazon.com', 'ebay.com', 'walmart.com', 'target.com', 'bestbuy.com', 'ikea.com', 'etsy.com', 'stripe.com', 'github.com',
  'wikipedia.org', 'youtube.com', 'reddit.com', 'nytimes.com', 'bbc.com', 'bbc.co.uk', 'theguardian.com', 'apple.com',
  'microsoft.com', 'google.com', 'stackoverflow.com', 'imdb.com', 'netflix.com', 'spotify.com', 'npmjs.com', 'mozilla.org',
]);

/** Normalize a spoken site into a domain and decide: auto (named or well known) or confirm (unfamiliar). */
export function judgeSite(site: string, userText: string): { domain: string; needsConfirm: boolean } {
  let domain = site.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (!domain.includes('.')) domain = `${domain.replace(/[^a-z0-9-]/g, '')}.com`;
  const label = domain.split('.').slice(-2, -1)[0] ?? domain;
  const named = label.length >= 3 && userText.toLowerCase().includes(label);
  return { domain, needsConfirm: !(named || WELL_KNOWN.has(domain)) };
}

/** Loose block on logins, payments and form posts while browsing. Only a site's own search box may be typed into. */
export const isSearchBoxSelector = 'input[type=search], [role=searchbox], input[placeholder*="search" i], input[aria-label*="search" i], input[name=q]';

// ---------- daily caps ----------

export function useCap(dir: string, kind: 'browser' | 'serp', limit: number, today = new Date().toISOString().slice(0, 10)): void {
  const file = join(dir, 'caps.json');
  let data: { day: string; browser: number; serp: number } = { day: today, browser: 0, serp: 0 };
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    if (d.day === today) data = { ...data, ...d };
  } catch {
    // first use today
  }
  if (data[kind] >= limit) throw new PolicyError(`cap-${kind}`);
  data[kind]++;
  writeFileSync(file, JSON.stringify(data));
}

// ---------- confirms: single use, bound to the request, 60 s, memory only (never survive a restart) ----------

export interface PendingConfirm {
  id: string;
  requestId: string;
  expires: number;
  fingerprint: string; // paths+sizes+targets at plan time, re-checked at confirm time
}

const confirms = new Map<string, PendingConfirm>();

export function createConfirm(id: string, requestId: string, fingerprint: string, now = Date.now()): PendingConfirm {
  const c = { id, requestId, fingerprint, expires: now + 60_000 };
  confirms.set(id, c);
  return c;
}

/** Consumes the confirm. Returns why it was rejected, or null if it may proceed. */
export function takeConfirm(id: string, requestId: string, currentFingerprint: string, now = Date.now()): null | 'unknown' | 'other-request' | 'expired' | 'changed' {
  const c = confirms.get(id);
  if (!c) return 'unknown'; // second tap, restart, or never existed
  if (c.requestId !== requestId) return 'other-request'; // does not burn the real request's confirm
  confirms.delete(id);
  if (now > c.expires) return 'expired';
  if (c.fingerprint !== currentFingerprint) return 'changed';
  return null;
}

export const dropConfirms = () => confirms.clear();

// ---------- per-step verdict ----------

export type Verdict = { mode: 'auto' | 'confirm' } | { mode: 'refuse'; reason: string };

/** auto (T0/T1), confirm (T2, or an unfamiliar site), refuse (T3 or a rule broken). */
export function judgeStep(step: Step, ctx: { userText: string; deviceKind?: string }): Verdict {
  if (!isTool(step.tool)) return { mode: 'refuse', reason: 'not-in-catalog' };
  const tier = tierOf(step, ctx.deviceKind);
  if (tier >= 3) return { mode: 'refuse', reason: 't3' };
  if (step.tool === 'schedule.add') {
    const bad = checkScheduledStep(step.args.step as { tool: string; args: unknown } | null, ctx.deviceKind);
    if (bad) return { mode: 'refuse', reason: `schedule-${bad}` };
  }
  if (step.tool === 'web.find' && judgeSite(String(step.args.site), ctx.userText).needsConfirm) return { mode: 'confirm' };
  // The user's own words asked to look at the screen: that is the consent, no extra sheet.
  if (step.tool === 'screen.look' && asksForScreen(ctx.userText)) return { mode: 'auto' };
  return { mode: tier === 2 ? 'confirm' : 'auto' };
}

/** "read my screen", "what's on my screen", "what am I looking at", "explain this error". */
export const asksForScreen = (text: string) =>
  /\b(my screen|the screen|this screen|on screen|my display|my monitor)\b|what am i looking at|what('?s| is) (this|that) (error|page|window|thing)|read (this|that)\b|look at (this|that)\b/i.test(text);

/** "turn off the lamp", "lights on", "switch the fan off": plain on/off needs no brain. Returns the device words and the state. */
export function parseQuickPower(text: string): { device: string; on: boolean } | null {
  const t = text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\b(hey|couch|please|pls|can you|could you|would you|for me|now|real quick)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const ok = (device: string, state: string) =>
    device.split(' ').length <= 4 && !/\b(and|then|after|at|in|every|when|if|show|video|music|song)\b/.test(device) ? { device, on: state === 'on' } : null;
  let m = /^(?:turn|switch|shut|put) (on|off) (?:the |my |all the |all )?(.+)$/.exec(t);
  if (m) return ok(m[2], m[1]);
  // "close the light" / "open the fan": common Indian English for off/on. Only kept when the words name a device.
  m = /^(close|kill|open) (?:the |my |all the |all )?(.+)$/.exec(t);
  if (m) return ok(m[2], m[1] === 'open' ? 'on' : 'off');
  m = /^(?:(?:turn|switch|shut|put) )?(?:the |my |all the |all )?(.+?) (on|off)$/.exec(t);
  return m ? ok(m[1], m[2]) : null;
}

const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, half: 0.5 };

/**
 * Everyday commands with one obvious meaning, answered by code: instant, and no brain call.
 * Anything with more to it ("dim the lights and play jazz") returns null and goes to the brain.
 * The steps still pass judgeStep like any plan.
 */
export function quickSteps(text: string): Step[] | null {
  const t = text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/^(hey|hi|yo|ok|okay)\b[ ,]*/, '')
    .replace(/\b(couch|please|pls|can you|could you|would you|for me|real quick)\b/g, ' ')
    .replace(/[^a-z0-9%' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let m: RegExpExecArray | null;
  // player
  if ((m = /^(pause|resume|stop|unpause)( (it|that|the (video|music|song|player)))?$/.exec(t)))
    return [{ tool: 'media.control', args: { action: m[1] === 'unpause' ? 'resume' : m[1] } }];
  if ((m = /^(?:set )?(?:the )?volume (?:to |at )?(\d{1,3})(?: ?%| percent)?$/.exec(t)))
    return [{ tool: 'media.control', args: { action: 'volume', level: Math.min(100, Number(m[1])) } }];
  // "play tame impala on youtube music": search and play, no brain. Vague asks ("play something") go to the brain, which knows the taste.
  if ((m = /^(?:play|put on) (?:some )?(.{2,80}?) (?:on|in|from) (youtube music|yt music|youtube)$/.exec(t)) && !/^(something|anything|a song|music|songs|videos?|whatever|stuff)$/.test(m[1]))
    return [
      { tool: 'media.search', args: { query: m[1], kind: m[2] === 'youtube' ? 'video' : 'song' } },
      { tool: 'media.play', args: { ref: '$prev' } },
    ];
  // screen dimming (the screen only: "dim the lights" is a device)
  if (/^(undim|brighten|restore) (the |my )?screen( back)?$|^screen (back )?to normal$/.test(t)) return [{ tool: 'screen.dim', args: { level: 0 } }];
  if ((m = /^(?:dim|darken) (?:the |my )?(?:screen|display)(?: (?:to |by )?(\d{1,2})(?: ?%| percent)?)?$/.exec(t)))
    return [{ tool: 'screen.dim', args: { level: Math.min(85, m[1] ? Number(m[1]) : 50) } }];
  // real backlight: "reduce the brightness of my screen", "brightness to 30", "make the screen brighter"
  if (/\bbrightness\b|^make (the |my )?(screen|display) (brighter|darker|dimmer)$/.test(t) && !/\b(lights?|lamps?|bulbs?|and|then)\b/.test(t)) {
    if ((m = /\bbrightness (?:to |at )?(\d{1,3})(?: ?%| percent)?$|\bbrightness of (?:the |my )?(?:screen|display) to (\d{1,3})/.exec(t)))
      return [{ tool: 'screen.brightness', args: { level: Math.min(100, Math.max(5, Number(m[1] ?? m[2]))) } }];
    if (/\b(reduce|lower|decrease|down|dim|darker|dimmer|less)\b/.test(t)) return [{ tool: 'screen.brightness', args: { level: 'down' } }];
    if (/\b(increase|raise|up|brighter|more|full|max)\b/.test(t)) return [{ tool: 'screen.brightness', args: { level: /\b(full|max)\b/.test(t) ? 100 : 'up' } }];
  }
  // timers: "set a timer for 10 minutes", "remind me in 5 min to check the oven"
  if ((m = /^(?:set (?:a |an )?(?:timer|alarm|reminder)|remind me|timer)(?: for| in)? (\d+|a|an|one|two|three|four|five|ten|fifteen|twenty|thirty|half an?) ?(min|mins|minute|minutes|hour|hours|hr|hrs)(?: (?:to|that|about) (.+))?$/.exec(t))) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : WORDS[m[1].split(' ')[0]] ?? 1;
    const minutes = /^h/.test(m[2]) ? n * 60 : n;
    if (minutes > 0 && minutes <= 10080) return [{ tool: 'timer.set', args: { minutes, label: (m[3] ?? 'Timer').slice(0, 120) } }];
  }
  // notes: "take a note buy milk", "note: call the plumber"
  if ((m = /^(?:take a note|make a note|add a note|note down|note|jot down)(?: that| saying)? (.{2,500})$/.exec(t)))
    return [{ tool: 'note.add', args: { text: text.replace(/^.*?\b(note|jot down)\b[:,]?\s*(that |saying )?/i, '').trim().slice(0, 500) } }];
  return null;
}

/**
 * "Open the DLC assignment" / "play some music": the model often plans only the search. Code adds the open or play,
 * so he does it instead of listing results. "in my browser" opens the file in the web browser.
 */
export function addOpen(steps: Step[], userText: string): Step[] {
  const last = steps[steps.length - 1];
  const browser = /\b(in|on|with) (my |the )?(web )?(browser|chrome|edge|firefox|brave)\b/i.test(userText);
  if (last?.tool === 'file.open' && browser && !last.args.browser) return [...steps.slice(0, -1), { ...last, args: { ...last.args, browser: true } }];
  if (steps.length >= 4) return steps;
  if (last?.tool === 'file.search' && /\b(open|show|pull up|bring up|give me|let me see)\b/i.test(userText))
    return [...steps, { tool: 'file.open', args: browser ? { ref: '$prev', browser: true } : { ref: '$prev' } }];
  if (last?.tool === 'media.search' && /\b(play|put on|listen|watch|start)\b/i.test(userText)) return [...steps, { tool: 'media.play', args: { ref: '$prev' } }];
  return steps;
}

/** "dim the lights" means real lights when one exists; "screen"/"display" always means the screen overlay. */
export function routeDim(steps: Step[], userText: string, lights: string[]): Step[] {
  const t = userText.toLowerCase();
  if (/\b(screen|display|monitor)\b/.test(t) || lights.length === 0 || !/\blights?\b|\blamps?\b/.test(t)) return steps;
  return steps.map((s): Step => {
    if (s.tool !== 'screen.dim') return s;
    const level = Number(s.args.level);
    // screen.dim level is "how dark"; brightness is the opposite. 0 = lights back on full. "lights" resolves to every light.
    return { tool: 'device.set', args: { device: lights.length === 1 ? lights[0] : 'lights', capability: 'brightness', value: level <= 0 ? 100 : Math.max(5, 100 - level) } };
  });
}

// ---------- picks: click or speech ----------

const ORDINALS: Record<string, number> = { first: 0, one: 0, '1': 0, '1st': 0, second: 1, two: 1, '2': 1, '2nd': 1, third: 2, three: 2, '3': 2, '3rd': 2, fourth: 3, four: 3, '4': 3, '4th': 3, fifth: 4, five: 4, '5': 4, '5th': 4, last: -1 };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Index into items, 'none', or null when the speech is unrelated (a new request). */
export function parsePick(text: string, items: { detail?: string }[]): number | 'none' | null {
  const t = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  if (/^(none|cancel|never ?mind|neither|no|nope|stop)( of (them|those))?( thanks)?$/.test(t)) return 'none';
  const month = MONTHS.findIndex((m) => t.includes(`from ${m}`) || t.includes(`in ${m}`));
  if (month >= 0 && /\bthe one\b/.test(t)) {
    const hit = items.findIndex((it) => it.detail && new RegExp(`\\b${MONTHS[month].slice(0, 3)}`, 'i').test(it.detail));
    return hit >= 0 ? hit : null;
  }
  const words = t.split(/\s+/);
  if (words.length <= 5) {
    for (const w of words) {
      const i = ORDINALS[w];
      if (i === undefined) continue;
      const idx = i < 0 ? items.length - 1 : i;
      return idx < items.length ? idx : null;
    }
  }
  return null;
}
