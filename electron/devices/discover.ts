// Discovery: user-initiated only (device.discover). mDNS + SSDP for a few seconds, private addresses only.
import Bonjour from 'bonjour-service';
import { Client as Ssdp } from 'node-ssdp';
import { isIP } from 'node:net';
import { ipClass } from '../policy';

export type Found = { kind: 'hue' | 'shelly' | 'homeassistant' | 'unknown'; host: string; name: string };

const lan = (ip: string) => isIP(ip) === 4 && (ipClass(ip) === 'private' || ipClass(ip) === 'linklocal');

export async function discover(ms = 4000): Promise<Found[]> {
  const found = new Map<string, Found>();
  const add = (f: Found) => {
    const prev = found.get(f.host);
    if (!prev || prev.kind === 'unknown') found.set(f.host, f);
  };
  const bonjour = new Bonjour();
  const ssdp = new Ssdp();
  try {
    for (const type of ['hue', 'shelly', 'home-assistant', 'http']) {
      bonjour.find({ type }, (s) => {
        const ip = (s.addresses ?? []).find(lan);
        if (!ip) return;
        const name = String(s.name ?? s.host ?? ip).slice(0, 40);
        const kind = type === 'hue' ? 'hue' : type === 'home-assistant' ? 'homeassistant' : type === 'shelly' || /^shelly/i.test(name) ? 'shelly' : 'unknown';
        add({ kind, host: ip, name });
      });
    }
    ssdp.on('response', (headers, _code, rinfo) => {
      if (!lan(rinfo.address)) return;
      const h = headers as Record<string, string | undefined>;
      const isHue = Boolean(h['HUE-BRIDGEID'] ?? h['hue-bridgeid']);
      add({ kind: isHue ? 'hue' : 'unknown', host: rinfo.address, name: isHue ? 'Hue bridge' : String(h.SERVER ?? h.ST ?? 'device').slice(0, 40) });
    });
    void ssdp.search('ssdp:all');
    await new Promise((r) => setTimeout(r, ms));
  } finally {
    ssdp.stop();
    bonjour.destroy();
  }
  return [...found.values()].slice(0, 20);
}
