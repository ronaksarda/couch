// Real-hardware adapters. Every host comes from devices.json (never the model) and is checked LAN-only before each call.
import { request } from 'node:https';
import { connect, type PeerCertificate } from 'node:tls';
import { guardLanHost } from '../policy';
import { DeviceOffline, type DeviceAdapter, type DeviceEntry, type DeviceState } from './registry';
import { simAdapter } from './sim';

const TIMEOUT = 3000;
type Value = boolean | number | string;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** LAN-only fetch: host re-checked every call, 3 s timeout, one retry on network trouble (not on HTTP errors). */
export async function lanFetch(host: string, url: string, init: RequestInit = {}): Promise<Response> {
  await guardLanHost(host);
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT) });
    } catch {
      if (attempt >= 1) throw new DeviceOffline();
    }
  }
}

async function json(res: Response): Promise<Record<string, unknown>> {
  if (!res.ok) throw new Error(`device-http-${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

const pick = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), o);
const base = (c: Record<string, unknown>, port?: number) => `${c.scheme === 'https' ? 'https' : 'http'}://${hostPart(str(c.host))}${c.port ?? port ? `:${c.port ?? port}` : ''}`;
const hostPart = (h: string) => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);

// ---------- generic-http: command templates with {value} ----------

type Cmd = { method?: 'GET' | 'POST' | 'PUT'; path: string; body?: unknown };

function fill(t: unknown, v: Value): unknown {
  if (t === '{value}') return v; // keeps the type in JSON bodies
  if (typeof t === 'string') return t.replaceAll('{value}', String(v));
  if (Array.isArray(t)) return t.map((x) => fill(x, v));
  if (t && typeof t === 'object') return Object.fromEntries(Object.entries(t).map(([k, x]) => [k, fill(x, v)]));
  return t;
}

function genericHttp(d: DeviceEntry): DeviceAdapter {
  const c = d.config;
  const host = str(c.host);
  const headers = (c.headers ?? {}) as Record<string, string>;
  return {
    id: d.id,
    async getState() {
      const st = c.state as { path: string; fields: Record<string, string> } | undefined;
      if (!st) return {};
      const body = await json(await lanFetch(host, base(c) + st.path, { headers }));
      return Object.fromEntries(Object.entries(st.fields).map(([cap, p]) => [cap, pick(body, p) as Value]));
    },
    async invoke(cap, value) {
      const cmd = (c.commands as Record<string, Cmd> | undefined)?.[cap];
      if (!cmd) throw new Error('unsupported');
      const path = cmd.path.replaceAll('{value}', encodeURIComponent(String(value)));
      const body = cmd.body === undefined ? undefined : JSON.stringify(fill(cmd.body, value));
      const res = await lanFetch(host, base(c) + path, { method: cmd.method ?? (body ? 'POST' : 'GET'), headers: body ? { 'Content-Type': 'application/json', ...headers } : headers, body });
      if (!res.ok) throw new Error(`device-http-${res.status}`);
    },
  };
}

// ---------- Philips Hue: CLIP v2 with an application key, bridge cert pinned per bridge ----------

/** First contact (pairing only): read the bridge cert to pin. TLS checks are off only for this one socket, never globally. */
export function readBridgeCert(host: string): Promise<{ pin: string; ca: string }> {
  return new Promise((resolve, reject) => {
    const s = connect({ host, port: 443, rejectUnauthorized: false, timeout: TIMEOUT }, () => {
      let cert = s.getPeerCertificate(true) as PeerCertificate & { issuerCertificate?: PeerCertificate };
      const pin = cert.fingerprint256;
      while (cert.issuerCertificate && cert.issuerCertificate !== cert) cert = cert.issuerCertificate;
      const ca = `-----BEGIN CERTIFICATE-----\n${cert.raw.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
      s.end();
      resolve({ pin, ca });
    });
    s.on('error', reject);
    s.on('timeout', () => s.destroy(new DeviceOffline()));
  });
}

/** HTTPS to the bridge: chain must verify against its own root, and the leaf must match the pin. Headers go out only after that. */
export async function hueRequest(c: Record<string, unknown>, method: string, path: string, body?: unknown, retry = 1): Promise<unknown> {
  const host = str(c.host);
  await guardLanHost(host);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const once = () =>
    new Promise<unknown>((resolve, reject) => {
      const req = request(
        {
          host,
          port: 443,
          method,
          path,
          ca: str(c.ca),
          checkServerIdentity: (_h, cert) => (cert.fingerprint256 === c.pin ? undefined : new Error('hue-cert-mismatch')),
          headers: { ...(c.key ? { 'hue-application-key': str(c.key) } : {}), ...(payload ? { 'Content-Type': 'application/json' } : {}) },
          timeout: TIMEOUT,
        },
        (res) => {
          let data = '';
          res.on('data', (d) => (data += d));
          res.on('end', () => {
            try {
              if ((res.statusCode ?? 500) >= 400) return reject(new Error(`device-http-${res.statusCode}`));
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new DeviceOffline()));
      req.on('error', reject);
      req.end(payload);
    });
  try {
    return await once();
  } catch (e) {
    if (retry > 0 && !(e instanceof Error && /mismatch|http/.test(e.message))) return hueRequest(c, method, path, body, retry - 1);
    throw e instanceof DeviceOffline || (e as NodeJS.ErrnoException).code ? new DeviceOffline() : e;
  }
}

/** Link-button pairing. Returns the application key, or null if the button was not pressed (Hue error 101). */
export async function huePair(c: Record<string, unknown>): Promise<string | null> {
  const out = (await hueRequest(c, 'POST', '/api', { devicetype: 'couch#desktop', generateclientkey: true })) as { success?: { username: string }; error?: { type: number } }[];
  if (out[0]?.error?.type === 101) return null;
  return out[0]?.success?.username ?? null;
}

function hexToXy(hex: string): { x: number; y: number } {
  const lin = (v: number) => (v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
  const s = X + Y + Z || 1;
  return { x: Math.round((X / s) * 1e4) / 1e4, y: Math.round((Y / s) * 1e4) / 1e4 };
}

export class NotSetUp extends Error {}

function hue(d: DeviceEntry): DeviceAdapter {
  const c = d.config;
  if (!c.key || !c.pin) throw new NotSetUp('The Hue bridge is not paired. Discover it and add it again.');
  const path = `/clip/v2/resource/light/${encodeURIComponent(str(c.rid))}`;
  return {
    id: d.id,
    async getState() {
      const l = ((await hueRequest(c, 'GET', path)) as { data?: Record<string, any>[] }).data?.[0] ?? {};
      const mirek = l.color_temperature?.mirek;
      return { power: !!l.on?.on, ...(l.dimming ? { brightness: Math.round(l.dimming.brightness) } : {}), ...(mirek ? { colorTemp: Math.round(1e6 / mirek) } : {}) };
    },
    async invoke(cap, v) {
      const body =
        cap === 'power' ? { on: { on: v } }
        : cap === 'brightness' ? { on: { on: Number(v) > 0 }, dimming: { brightness: Number(v) } }
        : cap === 'colorTemp' ? { color_temperature: { mirek: Math.min(500, Math.max(153, Math.round(1e6 / Number(v)))) } }
        : cap === 'color' ? { color: { xy: hexToXy(String(v)) } }
        : null;
      if (!body) throw new Error('unsupported');
      await hueRequest(c, 'PUT', path, body);
    },
  };
}

// ---------- Home Assistant: REST with a long-lived token kept in devices.json (local only) ----------

function homeAssistant(d: DeviceEntry): DeviceAdapter {
  const c = d.config;
  if (!c.token) throw new NotSetUp('Home Assistant needs a token in devices.json.');
  if (!c.entity) throw new NotSetUp('That Home Assistant device needs an entity id in devices.json.');
  const host = str(c.host);
  const entity = str(c.entity);
  const domain = entity.split('.')[0];
  const headers = { Authorization: `Bearer ${str(c.token)}`, 'Content-Type': 'application/json' };
  const url = base(c, 8123);
  const call = async (dom: string, service: string, data: Record<string, unknown> = {}) => {
    const res = await lanFetch(host, `${url}/api/services/${dom}/${service}`, { method: 'POST', headers, body: JSON.stringify({ entity_id: entity, ...data }) });
    if (!res.ok) throw new Error(`device-http-${res.status}`);
  };
  return {
    id: d.id,
    async getState() {
      const s = await json(await lanFetch(host, `${url}/api/states/${encodeURIComponent(entity)}`, { headers }));
      const a = (s.attributes ?? {}) as Record<string, any>;
      const st = String(s.state);
      if (st === 'unavailable') throw new DeviceOffline();
      const out: DeviceState = { power: !['off', 'closed', 'locked', 'unlocked', 'standby'].includes(st) };
      if (domain === 'lock') out.lock = st === 'locked';
      if (a.brightness != null) out.brightness = Math.round((a.brightness / 255) * 100);
      if (a.color_temp_kelvin != null) out.colorTemp = a.color_temp_kelvin;
      if (a.volume_level != null) out.volume = Math.round(a.volume_level * 100);
      if (a.is_volume_muted != null) out.mute = a.is_volume_muted;
      if (a.temperature != null) out.targetTemp = a.temperature;
      if (a.current_temperature != null) out.currentTemp = a.current_temperature;
      if (domain === 'climate') out.mode = st;
      if (a.percentage != null) out.fanSpeed = Math.round(a.percentage / 20);
      if (a.current_position != null) out.position = a.current_position;
      if (a.source != null) out.input = a.source;
      return out;
    },
    async invoke(cap, v) {
      switch (cap) {
        case 'power':
          return call(domain === 'cover' ? 'cover' : 'homeassistant', domain === 'cover' ? (v ? 'open_cover' : 'close_cover') : v ? 'turn_on' : 'turn_off');
        case 'brightness':
          return call('light', 'turn_on', { brightness_pct: v });
        case 'colorTemp':
          return call('light', 'turn_on', { color_temp_kelvin: v });
        case 'color':
          return call('light', 'turn_on', { rgb_color: [1, 3, 5].map((i) => parseInt(String(v).slice(i, i + 2), 16)) });
        case 'volume':
          return call('media_player', 'volume_set', { volume_level: Number(v) / 100 });
        case 'mute':
          return call('media_player', 'volume_mute', { is_volume_muted: v });
        case 'input':
          return call('media_player', 'select_source', { source: v });
        case 'targetTemp':
          return call('climate', 'set_temperature', { temperature: v });
        case 'mode':
          return call('climate', 'set_hvac_mode', { hvac_mode: v });
        case 'fanSpeed':
          return call('fan', 'set_percentage', { percentage: Number(v) * 20 });
        case 'position':
          return call('cover', 'set_cover_position', { position: v });
        case 'lock':
          return call('lock', v ? 'lock' : 'unlock');
        default:
          throw new Error('unsupported');
      }
    },
  };
}

// ---------- Tasmota: /cm?cmnd= ----------

function tasmota(d: DeviceEntry): DeviceAdapter {
  const c = d.config;
  const host = str(c.host);
  const cmnd = async (s: string) => json(await lanFetch(host, `${base(c)}/cm?cmnd=${encodeURIComponent(s)}`));
  return {
    id: d.id,
    async getState() {
      const s = await cmnd('State');
      return {
        power: String(s.POWER ?? s.POWER1) === 'ON',
        ...(s.Dimmer != null ? { brightness: Number(s.Dimmer) } : {}),
        ...(s.CT != null ? { colorTemp: Math.round(1e6 / Number(s.CT)) } : {}),
      };
    },
    async invoke(cap, v) {
      if (cap === 'power') await cmnd(`Power ${v ? 'On' : 'Off'}`);
      else if (cap === 'brightness') await cmnd(`Dimmer ${v}`);
      else if (cap === 'colorTemp') await cmnd(`CT ${Math.min(500, Math.max(153, Math.round(1e6 / Number(v))))}`);
      else if (cap === 'color') await cmnd(`Color ${String(v).slice(1)}`);
      else throw new Error('unsupported');
    },
  };
}

// ---------- Shelly: Gen1 REST (/relay, /light, /roller) vs Gen2+ RPC (/rpc/Switch.Set ...) ----------

/** Gen2+ answer /shelly with a numeric "gen"; Gen1 does not have that field. */
export async function shellyGen(host: string): Promise<1 | 2> {
  const s = await json(await lanFetch(host, `http://${hostPart(host)}/shelly`));
  return Number(s.gen) >= 2 ? 2 : 1;
}

function shelly(d: DeviceEntry): DeviceAdapter {
  const c = d.config;
  const host = str(c.host);
  const ch = Number(c.channel ?? 0);
  const part = str(c.part) || (d.kind === 'blinds' ? 'cover' : d.kind === 'light' ? 'light' : 'switch');
  const get = async (p: string) => json(await lanFetch(host, `${base(c)}${p}`));
  const gen2 = Number(c.gen) >= 2;
  const comp = part === 'cover' ? 'Cover' : part === 'light' ? 'Light' : 'Switch';
  const g1 = part === 'cover' ? 'roller' : part === 'light' ? 'light' : 'relay';
  return {
    id: d.id,
    async getState(): Promise<DeviceState> {
      const s = gen2 ? await get(`/rpc/${comp}.GetStatus?id=${ch}`) : await get(`/${g1}/${ch}`);
      if (part === 'cover') return { position: Number(s.current_pos) };
      return { power: Boolean(gen2 ? s.output : s.ison), ...(s.brightness != null ? { brightness: Number(s.brightness) } : {}) };
    },
    async invoke(cap, v) {
      if (part === 'cover' && cap === 'position') await get(gen2 ? `/rpc/Cover.GoToPosition?id=${ch}&pos=${v}` : `/roller/${ch}?go=to_pos&roller_pos=${v}`);
      else if (cap === 'power') await get(gen2 ? `/rpc/${comp}.Set?id=${ch}&on=${v ? 'true' : 'false'}` : `/${g1}/${ch}?turn=${v ? 'on' : 'off'}`);
      else if (cap === 'brightness' && part === 'light') await get(gen2 ? `/rpc/Light.Set?id=${ch}&on=true&brightness=${v}` : `/light/${ch}?turn=on&brightness=${v}`);
      else throw new Error('unsupported');
    },
  };
}

export function adapterFor(d: DeviceEntry): DeviceAdapter {
  switch (d.adapter) {
    case 'sim':
      return simAdapter(d);
    case 'generic-http':
      return genericHttp(d);
    case 'hue':
      return hue(d);
    case 'homeassistant':
      return homeAssistant(d);
    case 'tasmota':
      return tasmota(d);
    case 'shelly':
      return shelly(d);
  }
}
