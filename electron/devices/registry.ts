// Device registry: userData/devices.json + scenes.json. Name resolution happens here, in code.
// The model only ever supplies a spoken query string; hosts and URLs come from this file only.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CAPABILITIES, type Capability } from '../policy';

export const ADAPTERS = ['sim', 'generic-http', 'hue', 'homeassistant', 'tasmota', 'shelly'] as const;
export type AdapterKind = (typeof ADAPTERS)[number];

const Entry = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/),
  name: z.string().min(1).max(40),
  aliases: z.array(z.string().max(40)).default([]),
  room: z.string().max(40).optional(),
  kind: z.string().max(20), // light, tv, speaker, thermostat, fan, plug, blinds, lock, garage, door
  // Swapping a sim device for real hardware = change this field (and fill config). Nothing else.
  adapter: z.enum(ADAPTERS),
  config: z.record(z.string(), z.unknown()).default({}),
  capabilities: z.array(z.enum(CAPABILITIES)),
});
export type DeviceEntry = z.infer<typeof Entry>;
export type DeviceState = Record<string, boolean | number | string>;

/** Bound to one registry entry. BLE/USB adapters would implement this same shape (out of scope: needs a native module like noble/node-hid). */
export interface DeviceAdapter {
  id: string;
  discover?(): Promise<unknown[]>;
  getState(): Promise<DeviceState>;
  invoke(capability: Capability, value: boolean | number | string): Promise<void>;
}

export class DeviceOffline extends Error {
  constructor() {
    super('device-offline');
  }
}

const Scene = z.array(z.object({ device: z.string().max(60), capability: z.enum(CAPABILITIES), value: z.union([z.boolean(), z.number(), z.string().max(20)]) })).max(6);
export type SceneStep = z.infer<typeof Scene>[number];

const DEFAULT_SCENES: Record<string, SceneStep[]> = {
  'movie mode': [
    { device: 'ceiling light', capability: 'power', value: false },
    { device: 'lamp', capability: 'brightness', value: 20 },
    { device: 'blinds', capability: 'position', value: 0 },
    { device: 'TV', capability: 'power', value: true },
  ],
  bedtime: [
    { device: 'ceiling light', capability: 'power', value: false },
    { device: 'lamp', capability: 'power', value: false },
    { device: 'TV', capability: 'power', value: false },
    { device: 'front door lock', capability: 'lock', value: true },
  ],
};

let dir = '';
let devices: DeviceEntry[] = [];
let scenes: Record<string, SceneStep[]> = {};

export const SIM_DEVICES: DeviceEntry[] = [
  { id: 'ceiling', name: 'ceiling light', aliases: ['big light', 'main light'], room: 'living room', kind: 'light', adapter: 'sim', config: {}, capabilities: ['power', 'brightness', 'colorTemp', 'color'] },
  { id: 'lamp', name: 'lamp', aliases: ['floor lamp', 'reading lamp'], room: 'living room', kind: 'light', adapter: 'sim', config: {}, capabilities: ['power', 'brightness'] },
  { id: 'tv', name: 'TV', aliases: ['television', 'telly'], room: 'living room', kind: 'tv', adapter: 'sim', config: {}, capabilities: ['power', 'volume', 'mute', 'input', 'channel'] },
  { id: 'speaker', name: 'speaker', aliases: ['music speaker'], room: 'living room', kind: 'speaker', adapter: 'sim', config: {}, capabilities: ['power', 'volume', 'mute'] },
  { id: 'ac', name: 'AC', aliases: ['air conditioner', 'thermostat', 'heating', 'aircon'], room: 'living room', kind: 'thermostat', adapter: 'sim', config: {}, capabilities: ['power', 'targetTemp', 'mode', 'fanSpeed'] },
  { id: 'fan', name: 'fan', aliases: ['ceiling fan'], room: 'living room', kind: 'fan', adapter: 'sim', config: {}, capabilities: ['power', 'fanSpeed'] },
  { id: 'plug', name: 'smart plug', aliases: ['plug', 'kettle plug'], room: 'kitchen', kind: 'plug', adapter: 'sim', config: {}, capabilities: ['power'] },
  { id: 'blinds', name: 'blinds', aliases: ['shades', 'curtains'], room: 'living room', kind: 'blinds', adapter: 'sim', config: {}, capabilities: ['position'] },
  { id: 'door', name: 'front door lock', aliases: ['front door', 'door lock', 'lock'], room: 'hall', kind: 'lock', adapter: 'sim', config: {}, capabilities: ['lock'] },
];

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJson(file: string, data: unknown) {
  writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
  renameSync(file + '.tmp', file);
}

export function initRegistry(userData: string) {
  dir = userData;
  const raw = readJson(join(dir, 'devices.json'));
  const parsed = z.array(Entry).safeParse(raw);
  if (raw === undefined) {
    devices = SIM_DEVICES.map((d) => ({ ...d }));
    writeJson(join(dir, 'devices.json'), devices);
  } else if (parsed.success) devices = parsed.data;
  else {
    // A bad hand edit must not wipe the user's file: keep it and run with the valid entries only.
    devices = (Array.isArray(raw) ? raw : []).flatMap((d) => {
      const e = Entry.safeParse(d);
      return e.success ? [e.data] : [];
    });
    console.warn('[couch] devices.json has invalid entries; skipped them');
  }
  const rawScenes = readJson(join(dir, 'scenes.json'));
  if (rawScenes === undefined) writeJson(join(dir, 'scenes.json'), DEFAULT_SCENES);
  const s = z.record(z.string(), Scene).safeParse(rawScenes ?? DEFAULT_SCENES);
  scenes = s.success ? s.data : {};
}

let simVisible = true;
export const setSimVisible = (on: boolean) => (simVisible = on);
export const listDevices = () => devices.filter((d) => simVisible || d.adapter !== 'sim');
export const getScene = (name: string) => Object.entries(scenes).find(([n]) => n.toLowerCase() === name.trim().toLowerCase());

export function addDevice(e: DeviceEntry) {
  const base = e.id;
  let n = 1;
  while (devices.some((d) => d.id === e.id)) e = { ...e, id: `${base}-${++n}` };
  devices.push(Entry.parse(e));
  writeJson(join(dir, 'devices.json'), devices);
}

export function removeDevice(id: string) {
  devices = devices.filter((d) => d.id !== id);
  writeJson(join(dir, 'devices.json'), devices);
}

// ---------- name resolution (code, not model) ----------

const FILLER = new Set(['the', 'my', 'a', 'an', 'in', 'on', 'of', 'please', 'thing', 'all']);
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w));
const singular = (w: string) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

const tokenMatch = (q: string, c: string) => q === c || singular(q) === singular(c) || (q.length >= 4 && editDistance(singular(q), singular(c)) <= 1);

function score(query: string[], d: DeviceEntry): number {
  let best = 0;
  for (const cand of [d.name, ...d.aliases]) {
    const c = [...words(cand), ...words(d.room ?? ''), singular(d.kind)];
    const own = words(cand);
    const hit = query.filter((q) => c.some((x) => tokenMatch(q, x))).length / query.length;
    const exact = own.join(' ') === query.map(singular).join(' ') || own.join(' ') === query.join(' ');
    // Most of what was said must match: "garage door" is not the front door.
    best = Math.max(best, exact ? 2 : hit >= 0.66 ? hit + (query.some((q) => own.some((x) => tokenMatch(q, x))) ? 0.1 : 0) : 0);
  }
  return best;
}

export type Resolved = { kind: 'one'; device: DeviceEntry } | { kind: 'group'; devices: DeviceEntry[] } | { kind: 'ambiguous'; devices: DeviceEntry[] } | { kind: 'unknown' };

/**
 * Fuzzy match the spoken name against name, aliases, room and kind.
 * A plural kind word ("the lights") means every matching device of that kind; a tie is a pick; nothing close is unknown.
 */
export function resolveDevice(query: string, list: DeviceEntry[] = listDevices()): Resolved {
  const q = words(query);
  if (!q.length) return { kind: 'unknown' };
  const scored = list.map((d) => ({ d, s: score(q, d) })).filter((x) => x.s >= 0.6).sort((a, b) => b.s - a.s);
  if (!scored.length) return { kind: 'unknown' };
  if (scored[0].s >= 2) return { kind: 'one', device: scored[0].d };
  const plural = q.some((w) => w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && scored.some((x) => singular(w) === singular(x.d.kind)));
  const top = scored.filter((x) => x.s >= scored[0].s - 0.05);
  if (plural) {
    const group = scored.filter((x) => q.some((w) => singular(w) === singular(x.d.kind))).map((x) => x.d);
    if (group.length > 1) return { kind: 'group', devices: group };
    if (group.length === 1) return { kind: 'one', device: group[0] };
  }
  if (top.length === 1) return { kind: 'one', device: top[0].d };
  return { kind: 'ambiguous', devices: top.map((x) => x.d).slice(0, 5) };
}
