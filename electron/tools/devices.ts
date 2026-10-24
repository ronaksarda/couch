// Device tools. Names resolve in code; values are clamped in code; hosts come from the registry only.
// After every set the state is read back; a mismatch is reported, never papered over.
import { adapterFor, huePair, hueRequest, NotSetUp, readBridgeCert, shellyGen } from '../devices/adapters';
import { discover, type Found } from '../devices/discover';
import { addDevice, DeviceOffline, getScene, listDevices, removeDevice, resolveDevice, type DeviceEntry, type DeviceState } from '../devices/registry';
import { clampValue, guardLanHost, tierOf, type Capability } from '../policy';
import { targetVisible, type Target } from '../drive';
import { ids, ref, rt, ToolError, type Ctx, type Item, type Outcome, type Tool } from './rt';

const CAP_WORD: Partial<Record<Capability, string>> = { targetTemp: 'temperature', colorTemp: 'color temperature', fanSpeed: 'fan speed' };
const capWord = (c: Capability) => CAP_WORD[c] ?? c;
const show = (v: unknown) => (v === true ? 'on' : v === false ? 'off' : String(v));

let notify: (id: string, s: DeviceState) => void = () => undefined;
export const onDeviceState = (fn: typeof notify) => (notify = fn);

function timed<T>(p: Promise<T>, ms = 7000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new DeviceOffline()), ms))]);
}

/** Resolve one device, or turn ambiguity into a pick whose items carry the waiting step. */
function one(query: string, then?: (d: DeviceEntry) => Item['then']): DeviceEntry | Outcome {
  const r = resolveDevice(query);
  if (r.kind === 'one') return r.device;
  if (r.kind === 'unknown') throw new ToolError(noDeviceLine(query), 'clarify');
  return { items: ids(r.devices.map((d) => ({ kind: 'device' as const, title: d.name, detail: d.room ?? d.kind, data: { id: d.id }, then: then?.(d) }))), say: 'Which one?' };
}

/** Asked for a device that isn't there: say so plainly and offer what he can do instead. */
export function noDeviceLine(query: string): string {
  const head = listDevices().length ? "I don't know that one." : 'No smart devices connected right now.';
  return /\b(lights?|lamps?|bulbs?|leds?)\b/i.test(query) ? `${head} I can dim your screen instead. Say "dim the screen".` : `${head} Turn on Sim home in the tray to try the demo house.`;
}

export function deviceTarget(query: string): Target | null {
  const r = resolveDevice(query);
  const t: Target | null = r.kind === 'one' ? { kind: 'devicePanelTile', id: r.device.id } : r.kind === 'group' ? { kind: 'devicePanelTile', id: r.devices[0].id } : null;
  return t && targetVisible(t) ? t : null; // panel closed: he does it from the couch
}
export const deviceKindOf = (query: string) => {
  const r = resolveDevice(query);
  return r.kind === 'one' ? r.device.kind : r.kind === 'group' ? r.devices[0].kind : undefined;
};

/** Device kind for a step, including the step inside a schedule ("every day at 7 open the garage"). */
export function kindOf(step: { args: Record<string, unknown> }): string | undefined {
  const nested = (step.args.step as { args?: Record<string, unknown> } | null | undefined)?.args;
  const name = typeof step.args.device === 'string' ? step.args.device : typeof nested?.device === 'string' ? nested.device : undefined;
  return name ? deviceKindOf(name) : undefined;
}

const close = (cap: Capability, want: unknown, got: unknown) => {
  if (got === undefined) return true; // device does not report this field: nothing to compare
  if (cap === 'color' || cap === 'input') return true; // lossy conversions on real hardware
  if (typeof want === 'number') return Math.abs(Number(got) - want) <= (cap === 'colorTemp' ? 150 : cap === 'targetTemp' ? 0.5 : 2);
  return String(got).toLowerCase() === String(want).toLowerCase();
};

const REL_STEP: Partial<Record<Capability, number>> = { brightness: 20, volume: 10, targetTemp: 1, colorTemp: 500, fanSpeed: 1, position: 25, channel: 1 };

/** "+2", "-1", "up", "down": read the current value and step from it. Clamping happens after, in clampValue. */
async function relative(a: { getState(): Promise<DeviceState> }, cap: Capability, raw: unknown): Promise<unknown> {
  if (typeof raw !== 'string' || REL_STEP[cap] === undefined) return raw;
  const m = raw.trim().toLowerCase().match(/^([+-])\s*(\d+(?:\.\d+)?)$|^(up|down|more|less|higher|lower|warmer|cooler|brighter|dimmer|louder|quieter)$/);
  if (!m) return raw;
  const cur = Number((await timed(a.getState(), 3500))[cap]);
  if (!Number.isFinite(cur)) throw new Error('no-current');
  const delta = m[1] ? (m[1] === '-' ? -1 : 1) * Number(m[2]) : (/^(up|more|higher|warmer|brighter|louder)$/.test(m[3]) ? 1 : -1) * REL_STEP[cap]!;
  return cur + delta;
}

const setupLine = (e: unknown) => (e instanceof NotSetUp ? e.message : null);

/** Set one capability, then poll the state for up to 2.5 s to confirm it took. Honest line either way. */
export async function setOne(d: DeviceEntry, cap: Capability, raw: unknown): Promise<{ ok: boolean; line: string }> {
  if (!d.capabilities.includes(cap)) return { ok: false, line: `The ${d.name} can't do ${capWord(cap)}.` };
  let a;
  try {
    a = adapterFor(d);
  } catch (e) {
    return { ok: false, line: setupLine(e) ?? `The ${d.name} is not set up right.` };
  }
  let value: boolean | number | string;
  try {
    value = clampValue(cap, await relative(a, cap, raw));
  } catch (e) {
    if (e instanceof DeviceOffline) return { ok: false, line: `The ${d.name} isn't answering.` };
    return { ok: false, line: `That's not a ${capWord(cap)} I understand.` };
  }
  try {
    await timed(a.invoke(cap, value));
  } catch (e) {
    return { ok: false, line: e instanceof DeviceOffline ? `The ${d.name} isn't answering.` : `The ${d.name} said no.` };
  }
  let got: unknown;
  for (const t0 = Date.now(); Date.now() - t0 < 2500; await new Promise((r) => setTimeout(r, 300))) {
    try {
      const s = await timed(a.getState(), 3500);
      notify(d.id, s);
      got = s[cap];
      // Sim home devices are pretend: say so, so nobody thinks a real AC just turned off.
      if (close(cap, value, got)) return { ok: true, line: `${d.adapter === 'sim' ? 'Pretend ' : ''}${d.name}: ${capWord(cap)} ${show(value)}.` };
    } catch {
      return { ok: false, line: `Sent it, but the ${d.name} won't say if it worked.` };
    }
  }
  return { ok: false, line: `Asked the ${d.name} for ${show(value)}, it says ${show(got)}. Hm.` };
}

function summary(d: DeviceEntry, s: DeviceState): string {
  const parts = Object.entries(s)
    .filter(([k]) => k !== 'color')
    .map(([k, v]) => (k === 'currentTemp' ? `${v}°C now` : k === 'targetTemp' ? `set to ${v}°C` : k === 'power' ? show(v) : k === 'lock' ? (v ? 'locked' : 'unlocked') : `${capWord(k as Capability)} ${show(v)}`));
  return `${d.name}: ${parts.join(', ')}.`;
}

export const deviceTools: Record<string, Tool<any>> = {
  'device.list': {
    async run(a: { room?: string }) {
      const list = listDevices().filter((d) => !a.room || (d.room ?? '').toLowerCase().includes(a.room.toLowerCase()));
      if (!list.length) return { say: 'No devices. Just me and the couch.' };
      const items = ids(list.map((d) => ({ kind: 'device' as const, title: d.name, detail: `${d.room ?? ''} · ${d.adapter}`, data: { id: d.id } })));
      return { items, chosen: items[0], say: `${list.length} devices. Panel's open if you want to look.` };
    },
    target: () => null,
  },
  'device.status': {
    async run(a: { device: string }) {
      const d = one(a.device);
      if (!('id' in d)) return d;
      try {
        const s = await timed(adapterFor(d).getState(), 4000);
        notify(d.id, s);
        return { say: summary(d, s) };
      } catch (e) {
        return { say: setupLine(e) ?? `The ${d.name} isn't answering.`, sayKind: 'device-offline', failed: true };
      }
    },
    target: (a) => deviceTarget(a.device),
  },
  'device.set': {
    // Only reached for confirm-tier sets (unlock, doors, garage): the sheet names the exact device and where it lives.
    async prepare(a: { device: string; capability: Capability; value: unknown }) {
      const d = one(a.device);
      if (!('id' in d)) throw new ToolError('Which one? Say the exact name.', 'clarify');
      const what = a.capability === 'lock' ? (clampValue('lock', a.value) ? 'Lock' : 'Unlock') : `Set ${capWord(a.capability)} to ${show(a.value)} on`;
      return { action: `${what} the ${d.name}`, source: d.room ?? d.kind, dest: d.adapter === 'sim' ? 'sim home' : String(d.config.host ?? d.adapter), size: '-', fingerprint: async () => `${d.id}|${a.capability}|${String(a.value)}` };
    },
    async run(a: { device: string; capability: Capability; value: unknown }) {
      const r = resolveDevice(a.device);
      const group = r.kind === 'group' ? r.devices.filter((d) => d.capabilities.includes(a.capability)) : null;
      if (group && !group.length) return { say: `None of those can do ${capWord(a.capability)}.`, failed: true };
      if (group) {
        const res = await Promise.all(group.map((d) => setOne(d, a.capability, a.value)));
        const bad = res.filter((x) => !x.ok);
        return bad.length ? { say: bad.map((b) => b.line).join(' '), failed: true } : { say: `All ${group.length} ${a.device.toLowerCase().includes('light') ? 'lights' : 'of them'}: done.` };
      }
      const d = one(a.device, (x) => ({ tool: 'device.set', args: { ...a, device: x.name } }));
      if (!('id' in d)) return d;
      const res = await setOne(d, a.capability, a.value);
      return { say: res.line, failed: !res.ok, ...(res.ok ? {} : { sayKind: 'device-fail' as const }) };
    },
    target: (a) => deviceTarget(a.device),
  },
  'device.scene': {
    async run(a: { name: string }) {
      const s = getScene(a.name);
      if (!s) throw new ToolError(`No scene called ${a.name}.`, 'clarify');
      const lines: string[] = [];
      for (const step of s[1].slice(0, 6)) {
        // Every scene step is checked again: known device, clamped value, and never a confirm-tier action.
        const r = resolveDevice(step.device);
        if (r.kind !== 'one') {
          lines.push(`Skipped ${step.device}: don't know it.`);
          continue;
        }
        if (tierOf({ tool: 'device.set', args: step }, r.device.kind) >= 2) {
          lines.push(`Skipped ${r.device.name}: that one needs a yes.`);
          continue;
        }
        const res = await setOne(r.device, step.capability, step.value);
        if (!res.ok) lines.push(res.line);
      }
      return lines.length ? { say: `Scene ran, mostly. ${lines.join(' ')}`, failed: true } : { say: `${s[0]}. Done.` };
    },
    target: (a) => {
      const first = getScene(a.name)?.[1][0];
      return first ? deviceTarget(first.device) : null;
    },
  },
  'device.discover': {
    async run() {
      if (!rt.settings().lanDiscovery) throw new ToolError("Turn on 'Look for real devices on my network' in setup first.", 'refuse');
      const found = await discover();
      if (!found.length) return { say: 'Nothing new on the network. Or it is hiding.' };
      return { items: ids(found.map((f) => ({ kind: 'found' as const, title: f.name, detail: `${f.kind} · ${f.host}`, data: { ...f } }))), say: `Found ${found.length}. Say which to add.` };
    },
  },
  'device.add': {
    async prepare(a: { ref: string; name: string; room?: string }, ctx) {
      if (!rt.settings().lanDiscovery) throw new ToolError("Turn on 'Look for real devices on my network' in setup first.", 'refuse');
      const f = foundOf(a.ref, ctx);
      await guardLanHost(f.host).catch(() => {
        throw new ToolError('That address is not on your home network. No.', 'refuse');
      });
      return { action: `Add ${f.kind} device "${a.name}"`, source: `host ${f.host}`, dest: 'devices.json', size: '-', fingerprint: async () => `${f.kind}|${f.host}` };
    },
    async run(a: { ref: string; name: string; room?: string }, ctx) {
      const f = foundOf(a.ref, ctx);
      await guardLanHost(f.host);
      const base = { aliases: [], room: a.room, config: {} as Record<string, unknown> };
      const slug = a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) || 'device';
      if (f.kind === 'hue') {
        const cert = await readBridgeCert(f.host);
        const cfg = { host: f.host, pin: cert.pin, ca: cert.ca };
        const key = await huePair(cfg);
        if (!key) throw new ToolError('Press the button on the Hue bridge, then ask me again.', 'clarify');
        // Each light on the bridge becomes a device. Names from the bridge are data, used only as names.
        const lights = ((await hueRequest({ ...cfg, key }, 'GET', '/clip/v2/resource/light')) as { data?: { id: string; metadata?: { name?: string } }[] }).data ?? [];
        lights.slice(0, 50).forEach((l, i) =>
          addDevice({ ...base, id: `hue-${slug}-${i + 1}`, name: (l.metadata?.name ?? `${a.name} ${i + 1}`).slice(0, 40), kind: 'light', adapter: 'hue', config: { ...cfg, key, rid: l.id }, capabilities: ['power', 'brightness', 'colorTemp', 'color'] }),
        );
        return { say: `Paired. Added ${lights.length} light${lights.length === 1 ? '' : 's'}.` };
      }
      if (f.kind === 'shelly') {
        const gen = await shellyGen(f.host);
        addDevice({ ...base, id: `shelly-${slug}`, name: a.name, kind: 'plug', adapter: 'shelly', config: { host: f.host, gen, channel: 0 }, capabilities: ['power'] });
        return { say: `Added ${a.name}. Gen ${gen} Shelly.` };
      }
      if (f.kind === 'homeassistant') return { say: 'Home Assistant needs a token and entity ids. Put them in devices.json, I am not typing that.', failed: true };
      return { say: "I don't know how to drive that one. Add it to devices.json as generic-http.", failed: true };
    },
  },
  'device.remove': {
    async prepare(a: { device: string }) {
      const d = one(a.device);
      if (!('id' in d)) throw new ToolError('Which one? Say the exact name.', 'clarify');
      return { action: `Remove device "${d.name}"`, source: `${d.adapter}${d.config.host ? ` at ${String(d.config.host)}` : ''}`, dest: '(removed from devices.json)', size: '-', fingerprint: async () => JSON.stringify(d) };
    },
    async run(a: { device: string }) {
      const d = one(a.device);
      if (!('id' in d)) throw new ToolError('Which one? Say the exact name.', 'clarify');
      removeDevice(d.id);
      return { say: `Forgot the ${d.name}.` };
    },
  },
};

function foundOf(r: string, ctx: Ctx): Found {
  const it = ref(r, ctx);
  if (it.kind !== 'found') throw new ToolError('That is not something I discovered.', 'refuse');
  return it.data as unknown as Found;
}
