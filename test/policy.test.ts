import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ATTR,
  catalog,
  checkScheduledStep,
  clampValue,
  createConfirm,
  dropConfirms,
  guardLanHost,
  guardPath,
  guardUrl,
  ipClass,
  isDenied,
  judgeSite,
  judgeStep,
  resolveDestRoot,
  routeDim,
  addOpen,
  T3,
  takeConfirm,
  tierOf,
  useCap,
  type Step,
} from '../electron/policy';

const fakeDns = (map: Record<string, string[]>) => async (h: string) => {
  if (!map[h]) throw new Error('ENOTFOUND');
  return map[h];
};

describe('tool catalog tiers', () => {
  it('every catalog tool has the tier the PRD gives it', () => {
    const expected: Record<string, number> = {
      'file.search': 0, 'file.read': 0, 'file.open': 1, 'file.reveal': 1, 'file.copy': 2, 'file.move': 2, 'file.undo': 1,
      'note.add': 1, 'web.find': 0, 'web.read': 0, 'web.download': 2, 'web.open': 1,
      'media.search': 0, 'media.play': 1, 'media.control': 1, 'screen.dim': 1, 'screen.brightness': 1, 'screen.look': 2, 'app.launch': 1, 'timer.set': 1, 'clipboard.copy': 1,
      'schedule.add': 1, 'schedule.list': 0, 'schedule.cancel': 1,
      'device.list': 0, 'device.status': 0, 'device.set': 1, 'device.scene': 1, 'device.discover': 0, 'device.add': 2, 'device.remove': 2,
    };
    expect(Object.fromEntries(Object.entries(catalog).map(([k, v]) => [k, v.tier]))).toEqual(expected);
  });

  it('no T3 action exists as a tool', () => {
    for (const name of Object.keys(catalog)) for (const bad of T3) expect(name.split('.')).not.toContain(bad);
    expect(Object.values(catalog).every((t) => t.tier < 3)).toBe(true);
  });
});

describe('file path guard', () => {
  // Not under %TEMP%: that lives in AppData, which is denylisted.
  const base = mkdtempSync(join(import.meta.dirname, 'tmp-policy-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(root, 'lease.pdf'), 'x');
  writeFileSync(join(root, '.hidden.txt'), 'x');
  writeFileSync(join(root, 'id_rsa'), 'x');
  writeFileSync(join(outside, 'secret-plans.txt'), 'x');
  writeFileSync(join(outside, 'plain.txt'), 'x');
  mkdirSync(join(root, '.ssh'));
  writeFileSync(join(root, '.ssh', 'config'), 'x');
  // A junction (no admin needed on Windows) inside the root that points outside it.
  symlinkSync(outside, join(root, 'escape'), 'junction');

  it('denylist', () => {
    for (const p of ['C:\\Users\\a\\.ssh\\id_ed25519', 'C:\\Users\\a\\AppData\\Roaming\\x.txt', 'C:\\Program Files\\x\\a.txt', 'C:\\Windows\\win.ini', 'D:\\proj\\.git\\config', 'C:\\d\\server.pem', 'C:\\d\\a.key', 'C:\\d\\vault.kdbx', 'C:\\d\\.env.local', 'C:\\d\\credentials.json', 'C:\\d\\my-secret.txt', 'C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\User Data\\x'])
      expect(isDenied(p), p).toBe(true);
    for (const p of ['C:\\Users\\a\\Documents\\lease.pdf', 'C:\\Users\\a\\Downloads\\Q3 budget.xlsx']) expect(isDenied(p), p).toBe(false);
  });

  it('allows a normal file inside a root', async () => {
    const r = await guardPath(join(root, 'lease.pdf'), [root]);
    expect(r.ok).toBe(true);
  });

  it('refuses outside roots, denylisted, missing', async () => {
    expect(await guardPath(join(outside, 'plain.txt'), [root])).toEqual({ ok: false, reason: 'outside' });
    expect(await guardPath(join(root, 'id_rsa'), [root])).toEqual({ ok: false, reason: 'denied' });
    expect(await guardPath(join(root, '.ssh', 'config'), [root])).toEqual({ ok: false, reason: 'denied' });
    expect(await guardPath(join(root, 'nope.pdf'), [root])).toEqual({ ok: false, reason: 'missing' });
  });

  it('never follows a link or junction out of the roots', async () => {
    expect(await guardPath(join(root, 'escape', 'plain.txt'), [root])).toEqual({ ok: false, reason: 'outside' });
  });

  it('hidden and system files only when the user named the exact file', async () => {
    expect(await guardPath(join(root, '.hidden.txt'), [root])).toEqual({ ok: false, reason: 'hidden' });
    expect((await guardPath(join(root, '.hidden.txt'), [root], { exactNamed: true })).ok).toBe(true);
    expect(await guardPath(join(root, 'lease.pdf'), [root], { attrs: ATTR.SYSTEM })).toEqual({ ok: false, reason: 'hidden' });
    // Named exactly but denylisted stays refused.
    expect(await guardPath(join(root, 'id_rsa'), [root], { exactNamed: true })).toEqual({ ok: false, reason: 'denied' });
  });

  it('case-insensitive on Windows', async () => {
    if (process.platform !== 'win32') return;
    expect((await guardPath(join(root, 'LEASE.PDF'), [root.toUpperCase()])).ok).toBe(true);
  });

  it('destination folder comes from an allowed root name only', () => {
    const roots = ['C:\\Users\\a\\Desktop', 'C:\\Users\\a\\Documents'];
    expect(resolveDestRoot('Desktop', roots)).toBe('C:\\Users\\a\\Desktop');
    expect(resolveDestRoot('my desktop', roots)).toBe('C:\\Users\\a\\Desktop');
    expect(resolveDestRoot('Documents/Taxes', roots)).toBe(join('C:\\Users\\a\\Documents', 'Taxes'));
    expect(resolveDestRoot('Desktop/../..', roots)).toBeNull();
    expect(resolveDestRoot('C:', roots)).toBeNull();
    expect(resolveDestRoot('Windows', roots)).toBeNull();
  });
});

describe('web guard', () => {
  const dns = fakeDns({ 'example.com': ['93.184.216.34'], 'evil.example': ['192.168.1.1'], 'rebind.example': ['93.184.216.34', '127.0.0.1'], 'v6.example': ['::1'] });

  it('https only, http upgraded', async () => {
    expect((await guardUrl('http://example.com/a', dns)).href).toBe('https://example.com/a');
    expect((await guardUrl('example.com', dns)).protocol).toBe('https:');
    await expect(guardUrl('ftp://example.com', dns)).rejects.toThrow('not-https');
    await expect(guardUrl('file:///C:/x', dns)).rejects.toThrow('not-https');
  });

  it('blocks localhost, private, link-local, loopback, also after DNS', async () => {
    for (const u of ['https://localhost', 'https://127.0.0.1', 'https://10.0.0.5', 'https://172.16.3.1', 'https://192.168.0.1', 'https://169.254.169.254', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://printer.local', 'https://intranet'])
      await expect(guardUrl(u, dns), u).rejects.toThrow();
    await expect(guardUrl('https://evil.example', dns)).rejects.toThrow('private-address');
    await expect(guardUrl('https://rebind.example', dns)).rejects.toThrow('private-address');
    await expect(guardUrl('https://v6.example', dns)).rejects.toThrow('private-address');
    await expect(guardUrl('https://nowhere.example', dns)).rejects.toThrow('dns-failed');
  });

  it('refuses credentials in the URL', async () => {
    await expect(guardUrl('https://user:pw@example.com', dns)).rejects.toThrow('credentials-in-url');
  });

  it('site must be named or well known, else confirm', () => {
    expect(judgeSite('amazon', 'find the cheapest usb-c cable on amazon')).toEqual({ domain: 'amazon.com', needsConfirm: false });
    expect(judgeSite('stripe.com', 'pricing page on stripe').needsConfirm).toBe(false);
    expect(judgeSite('wikipedia.org', 'who was ada lovelace').needsConfirm).toBe(false);
    expect(judgeSite('totally-unknown-shop.biz', 'find a cable').needsConfirm).toBe(true);
  });

  it('daily caps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'couch-cap-'));
    useCap(dir, 'serp', 2, '2026-10-24');
    useCap(dir, 'serp', 2, '2026-10-24');
    expect(() => useCap(dir, 'serp', 2, '2026-10-24')).toThrow('cap-serp');
    expect(() => useCap(dir, 'browser', 1, '2026-10-24')).not.toThrow();
    expect(() => useCap(dir, 'serp', 2, '2026-10-25')).not.toThrow(); // new day
  });
});

describe('device rules', () => {
  const dns = fakeDns({ 'hue.local': ['192.168.1.20'], 'bad.example': ['8.8.8.8'] });

  it('LAN-only hosts', async () => {
    await expect(guardLanHost('192.168.1.20', dns)).resolves.toBeUndefined();
    await expect(guardLanHost('10.1.2.3', dns)).resolves.toBeUndefined();
    await expect(guardLanHost('fe80::1', dns)).resolves.toBeUndefined();
    await expect(guardLanHost('hue.local', dns)).resolves.toBeUndefined();
    await expect(guardLanHost('8.8.8.8', dns)).rejects.toThrow('not-lan');
    await expect(guardLanHost('bad.example', dns)).rejects.toThrow('not-lan');
    await expect(guardLanHost('missing.example', dns)).rejects.toThrow('dns-failed');
    await expect(guardLanHost('224.0.0.1', dns)).rejects.toThrow('not-lan');
  });

  it('ip classes', () => {
    expect(ipClass('127.0.0.1')).toBe('loopback');
    expect(ipClass('172.31.0.1')).toBe('private');
    expect(ipClass('172.32.0.1')).toBe('public');
    expect(ipClass('100.64.0.1')).toBe('reserved');
    expect(ipClass('fd00::1')).toBe('private');
    expect(ipClass('2606:4700::1111')).toBe('public');
    expect(ipClass('::ffff:7f00:1')).toBe('loopback');
    expect(ipClass('::ffff:c0a8:101')).toBe('private');
    expect(ipClass('::7f00:1')).toBe('reserved');
    expect(ipClass('64:ff9b::a00:1')).toBe('reserved');
  });

  it('values are clamped in code', () => {
    expect(clampValue('brightness', 150)).toBe(100);
    expect(clampValue('brightness', -5)).toBe(0);
    expect(clampValue('volume', '40')).toBe(40);
    expect(clampValue('targetTemp', 35)).toBe(30);
    expect(clampValue('targetTemp', 10)).toBe(16);
    expect(clampValue('targetTemp', 22.3)).toBe(22.5);
    expect(clampValue('colorTemp', 10_000)).toBe(6500);
    expect(clampValue('fanSpeed', 9)).toBe(5);
    expect(clampValue('power', 'on')).toBe(true);
    expect(clampValue('lock', 'unlock')).toBe(false);
    expect(clampValue('color', 'Red')).toBe('#ff3b30');
    expect(clampValue('mode', 'COOL')).toBe('cool');
    expect(() => clampValue('brightness', 'lots')).toThrow();
    expect(() => clampValue('mode', 'turbo')).toThrow();
    expect(() => clampValue('color', 'url(javascript:1)')).toThrow();
    expect(() => clampValue('input', '<script>')).toThrow();
  });

  it('unlock / door / garage need a confirm; locking does not', () => {
    const set = (capability: string, value: unknown): Step => ({ tool: 'device.set', args: { device: 'x', capability, value } });
    expect(tierOf(set('lock', false), 'lock')).toBe(2);
    expect(tierOf(set('lock', 'unlocked'), 'lock')).toBe(2);
    expect(tierOf(set('lock', true), 'lock')).toBe(1);
    expect(tierOf(set('lock', 0), 'lock')).toBe(2);
    expect(tierOf(set('lock', 'false'), 'lock')).toBe(2);
    expect(tierOf(set('lock', 'banana'), 'lock')).toBe(2); // unclear value: ask
    expect(tierOf(set('power', true), 'garage')).toBe(2);
    expect(tierOf(set('position', 100), 'door')).toBe(2);
    expect(tierOf(set('brightness', 50), 'light')).toBe(1);
  });

  it('schedules may contain only T0/T1 steps', () => {
    expect(checkScheduledStep({ tool: 'device.set', args: { device: 'lamp', capability: 'power', value: true } })).toBeNull();
    expect(checkScheduledStep({ tool: 'device.set', args: { device: 'door', capability: 'lock', value: false } })).toBe('needs-confirm');
    expect(checkScheduledStep({ tool: 'device.set', args: { device: 'garage', capability: 'power', value: true } }, 'garage')).toBe('needs-confirm');
    expect(checkScheduledStep({ tool: 'file.move', args: { ref: 'r1', dest: 'Desktop' } })).toBe('ref-in-schedule');
    expect(checkScheduledStep({ tool: 'web.download', args: { url: 'https://example.com/a.pdf' } })).toBe('needs-confirm');
    expect(checkScheduledStep({ tool: 'schedule.add', args: { inMinutes: 1, label: 'x' } })).toBe('unknown-or-nested');
    expect(checkScheduledStep({ tool: 'shell.run', args: {} })).toBe('unknown-or-nested');
    expect(checkScheduledStep({ tool: 'device.set', args: { device: 'lamp', capability: 'power', value: true, host: '1.2.3.4' } })).toBe('bad-args');
  });

  it('judgeStep: auto, confirm, refuse', () => {
    const v = (s: Step, deviceKind?: string) => judgeStep(s, { userText: 'find a cable on amazon', deviceKind }).mode;
    expect(v({ tool: 'file.search', args: {} })).toBe('auto');
    expect(v({ tool: 'file.move', args: { ref: 'r1', dest: 'Desktop' } })).toBe('confirm');
    expect(v({ tool: 'web.find', args: { site: 'amazon', query: 'usb-c cable' } })).toBe('auto');
    expect(v({ tool: 'web.find', args: { site: 'shadyshop.biz', query: 'usb-c cable' } })).toBe('confirm');
    expect(v({ tool: 'device.set', args: { device: 'front door', capability: 'lock', value: false } }, 'lock')).toBe('confirm');
    expect(v({ tool: 'schedule.add', args: { inMinutes: 5, label: 'x', repeat: 'none', step: { tool: 'device.set', args: { device: 'door', capability: 'lock', value: false } } } })).toBe('refuse');
    expect(judgeStep({ tool: 'nope' as never, args: {} }, { userText: '' }).mode).toBe('refuse');
  });

  it('"dim the lights" goes to lights when one exists; "screen" always means the screen', () => {
    const dimStep: Step[] = [{ tool: 'screen.dim', args: { level: 60 } }];
    expect(routeDim(dimStep, 'dim the lights, I feel weird', ['lamp'])[0]).toEqual({ tool: 'device.set', args: { device: 'lamp', capability: 'brightness', value: 40 } });
    expect(routeDim(dimStep, 'dim the lights', ['lamp', 'ceiling light'])).toEqual([{ tool: 'device.set', args: { device: 'lights', capability: 'brightness', value: 40 } }]);
    expect(routeDim(dimStep, 'dim the lights', [])).toEqual(dimStep);
    expect(routeDim(dimStep, 'dim the screen lights', ['lamp'])).toEqual(dimStep);
    expect(routeDim(dimStep, 'dim the display', ['lamp'])).toEqual(dimStep);
    const search = [{ tool: 'file.search' as const, args: { keywords: ['lease'] } }];
    expect(addOpen(search, 'open the lease pdf')).toEqual([...search, { tool: 'file.open', args: { ref: '$prev' } }]);
    expect(addOpen(search, 'find the lease pdf')).toEqual(search);
  });
});

describe('confirms', () => {
  it('single use, bound to the request, 60 s, re-checked, gone after restart', () => {
    createConfirm('c1', 'req1', 'fp', 0);
    expect(takeConfirm('c1', 'req2', 'fp', 1)).toBe('other-request'); // another request cannot use it
    expect(takeConfirm('c1', 'req1', 'fp', 1)).toBeNull(); // first tap counts
    expect(takeConfirm('c1', 'req1', 'fp', 2)).toBe('unknown'); // second tap does not
    createConfirm('c2', 'req1', 'fp', 0);
    expect(takeConfirm('c2', 'req1', 'fp', 60_001)).toBe('expired');
    createConfirm('c3', 'req1', 'a.pdf|100', 0);
    expect(takeConfirm('c3', 'req1', 'a.pdf|999', 1)).toBe('changed'); // size changed since the plan
    createConfirm('c4', 'req1', 'fp', 0);
    dropConfirms(); // what a restart looks like: memory only
    expect(takeConfirm('c4', 'req1', 'fp', 1)).toBe('unknown');
  });
});
