// Sim home: fake devices that behave like real hardware (fades, warm-up, drift, travel, motors).
// State persists in userData/sim-home.json; a corrupt file resets to defaults.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Capability } from '../policy';
import { DeviceOffline, type DeviceAdapter, type DeviceEntry, type DeviceState } from './registry';

const DEFAULTS: Record<string, DeviceState> = {
  ceiling: { power: false, brightness: 80, colorTemp: 3000, color: '#ffb46b' },
  lamp: { power: true, brightness: 40 },
  tv: { power: false, volume: 20, mute: false, input: 'HDMI 1', channel: 1 },
  speaker: { power: false, volume: 30, mute: false },
  ac: { power: false, targetTemp: 22, currentTemp: 26, mode: 'cool', fanSpeed: 2 },
  fan: { power: false, fanSpeed: 0 },
  plug: { power: false },
  blinds: { position: 100 },
  door: { lock: true },
};

export type Chaos = { offline: boolean; slow: boolean; failNext: boolean };

let file = '';
let state: Record<string, DeviceState> = {};
const chaos: Record<string, Chaos> = {};
const motion: Record<string, NodeJS.Timeout> = {};
let onChange: (id: string, s: DeviceState) => void = () => undefined;
let saveTimer: NodeJS.Timeout | null = null;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function save() {
  saveTimer ??= setTimeout(() => {
    saveTimer = null;
    try {
      writeFileSync(file, JSON.stringify(state));
    } catch {
      // disk trouble: state lives on in memory
    }
  }, 500);
}

function set(id: string, patch: DeviceState) {
  state[id] = { ...state[id], ...patch };
  onChange(id, state[id]);
  save();
}

export function initSim(userData: string, changed: (id: string, s: DeviceState) => void) {
  file = join(userData, 'sim-home.json');
  onChange = changed;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, DeviceState>;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('corrupt');
    state = Object.fromEntries(Object.entries(DEFAULTS).map(([id, d]) => [id, { ...d, ...(typeof raw[id] === 'object' ? raw[id] : {}) }]));
  } catch {
    state = structuredClone(DEFAULTS);
  }
  // AC drifts 0.5 C every 3 s toward the target while running.
  setInterval(() => {
    const ac = state.ac;
    if (!ac?.power || ac.mode === 'off' || ac.mode === 'fan') return;
    const cur = Number(ac.currentTemp);
    const tgt = Number(ac.targetTemp);
    const dir = Math.sign(tgt - cur);
    if (dir === 0 || (ac.mode === 'cool' && dir > 0) || (ac.mode === 'heat' && dir < 0)) return;
    set('ac', { currentTemp: cur + dir * 0.5 });
  }, 3000).unref();
}

export const simState = (id: string): DeviceState => ({ ...(state[id] ?? {}) });
export const getChaos = (id: string): Chaos => (chaos[id] ??= { offline: false, slow: false, failNext: false });

/** Animate a numeric field to a target over ms (40 ms frames). A new command on the same field takes over. */
function animate(id: string, field: string, to: number, ms: number) {
  const key = `${id}.${field}`;
  clearInterval(motion[key]);
  const from = Number(state[id][field] ?? 0);
  const t0 = Date.now();
  motion[key] = setInterval(() => {
    const f = Math.min(1, (Date.now() - t0) / ms);
    set(id, { [field]: Math.round(from + (to - from) * f) });
    if (f >= 1) clearInterval(motion[key]);
  }, 40);
}

async function invoke(d: DeviceEntry, cap: Capability, value: boolean | number | string) {
  const c = getChaos(d.id);
  if (c.offline) throw new DeviceOffline();
  if (c.slow) await delay(8000); // longer than the tool timeout, like a device that stopped answering
  await delay(80); // network round trip
  if (c.failNext) {
    c.failNext = false;
    throw new Error('device-error');
  }
  const id = d.id;
  state[id] ??= {};
  if (cap === 'brightness') return animate(id, 'brightness', Number(value), 400);
  if (cap === 'position') return animate(id, 'position', Number(value), (Math.abs(Number(value) - Number(state[id].position ?? 0)) / 100) * 2000);
  if (cap === 'power' && d.kind === 'tv' && value === true) return void setTimeout(() => set(id, { power: true }), 1200); // warm-up
  if (cap === 'lock') return void setTimeout(() => set(id, { lock: value }), 600); // motor
  if (cap === 'fanSpeed') return set(id, { fanSpeed: value, ...(d.kind === 'fan' ? { power: Number(value) > 0 } : {}) });
  set(id, { [cap]: value });
}

export function simAdapter(d: DeviceEntry): DeviceAdapter {
  return {
    id: d.id,
    async getState() {
      const c = getChaos(d.id);
      if (c.offline) throw new DeviceOffline();
      if (c.slow) await delay(8000);
      return simState(d.id);
    },
    invoke: (cap, value) => invoke(d, cap, value),
  };
}
