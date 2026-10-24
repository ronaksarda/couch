import type { CouchApi, DeviceView } from '../electron/preload';

const api = (window as unknown as { couch: CouchApi }).couch;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tilesEl = $<HTMLUListElement>('tiles');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

type Tile = { view: DeviceView; li: HTMLLIElement; canvas: HTMLCanvasElement; status: HTMLParagraphElement; spin: number };
const tiles = new Map<string, Tile>();

const W = 48;
const H = 32;

const num = (v: unknown, d = 0) => (typeof v === 'number' ? v : d);
const kelvinColor = (k: number) => (k < 3000 ? '#ffb46b' : k < 4500 ? '#ffe2b0' : '#e6f0ff');

function status(v: DeviceView): string {
  if (!v.online) return 'offline';
  const s = v.state;
  switch (v.kind) {
    case 'light':
      return s.power ? `on · ${num(s.brightness, 100)}%` : 'off';
    case 'tv':
    case 'speaker':
      return s.power ? `on · vol ${num(s.volume)}${s.mute ? ' · muted' : ''}` : 'off';
    case 'thermostat':
      return `${num(s.currentTemp, NaN).toFixed(1)}°C now · ${s.power ? `${s.mode} to ${num(s.targetTemp)}°C` : 'off'}`;
    case 'fan':
      return s.power ? `speed ${num(s.fanSpeed)}` : 'off';
    case 'blinds':
      return `${num(s.position)}% open`;
    case 'lock':
      return s.lock ? 'locked' : 'unlocked';
    default:
      return 'power' in s ? (s.power ? 'on' : 'off') : '';
  }
}

/** Drawn sprites, one per kind. Art is 48x32 pixels, scaled up crisp. */
function draw(t: Tile) {
  const g = t.canvas.getContext('2d')!;
  const s = t.view.state;
  const on = t.view.online && s.power === true;
  const px = (x: number, y: number, w: number, h: number, c: string) => {
    g.fillStyle = c;
    g.fillRect(x, y, w, h);
  };
  g.clearRect(0, 0, W, H);
  switch (t.view.kind) {
    case 'light': {
      const color = typeof s.color === 'string' ? s.color : kelvinColor(num(s.colorTemp, 2700));
      if (on) {
        // Glow strength follows brightness, so the 400 ms fade shows.
        g.globalAlpha = 0.15 + 0.6 * (num(s.brightness, 100) / 100);
        const grd = g.createRadialGradient(24, 13, 2, 24, 13, 16);
        grd.addColorStop(0, color);
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, W, H);
        g.globalAlpha = 1;
      }
      px(20, 6, 8, 10, on ? color : '#cfc8bd');
      px(21, 16, 6, 3, '#777');
      px(22, 19, 4, 2, '#555');
      break;
    }
    case 'tv': {
      px(8, 4, 32, 20, '#222');
      if (on) for (let i = 0; i < 16; i++) px(10, 6 + i, 28, 1, `hsl(${(Date.now() / 20 + i * 12) % 360} 60% ${45 + (i % 3) * 5}%)`);
      else px(10, 6, 28, 16, '#0b0b0b');
      px(20, 24, 8, 2, '#444');
      px(16, 26, 16, 2, '#333');
      break;
    }
    case 'speaker': {
      px(16, 3, 16, 26, '#333');
      const pulse = on && !reduced ? Math.round(Math.sin(Date.now() / 120) * (num(s.volume) / 50)) : 0;
      px(20 - pulse, 13 - pulse, 8 + pulse * 2, 8 + pulse * 2, on ? '#6a6' : '#555');
      px(22, 6, 4, 4, '#555');
      break;
    }
    case 'thermostat': {
      px(4, 6, 40, 16, '#eee');
      px(4, 18, 40, 4, '#ccc');
      for (let x = 8; x < 40; x += 4) px(x, 19, 2, 2, '#999');
      const mode = String(s.mode);
      px(6, 8, 4, 4, !on ? '#777' : mode === 'heat' ? '#f80' : mode === 'cool' ? '#39f' : '#6c6');
      g.fillStyle = '#222';
      g.font = '7px monospace';
      g.fillText(num(s.currentTemp, NaN).toFixed(1), 14, 14);
      if (on && !reduced) for (let i = 0; i < 3; i++) px(10 + i * 12, 24 + ((Date.now() / 200 + i * 2) % 6), 6, 1, mode === 'heat' ? '#fa6' : '#9cf');
      break;
    }
    case 'fan': {
      // Spin speed tracks fanSpeed.
      if (on && !reduced) t.spin += num(s.fanSpeed) * 0.08;
      g.save();
      g.translate(24, 15);
      g.rotate(t.spin);
      for (let i = 0; i < 3; i++) {
        g.rotate((Math.PI * 2) / 3);
        px(-2, -13, 4, 11, '#8aa');
      }
      g.restore();
      px(22, 13, 4, 4, '#555');
      px(23, 17, 2, 12, '#666');
      break;
    }
    case 'plug': {
      px(14, 4, 20, 24, '#ddd');
      px(19, 10, 2, 6, '#333');
      px(27, 10, 2, 6, '#333');
      px(22, 20, 4, 3, on ? '#3c3' : '#555');
      break;
    }
    case 'blinds': {
      px(8, 2, 32, 28, '#8cf');
      const closed = Math.round(((100 - num(s.position, 100)) / 100) * 26);
      for (let y = 3; y < 3 + closed; y += 2) px(9, y, 30, 1, '#d8c8a8');
      px(8, 2, 32, 1, '#666');
      break;
    }
    case 'lock': {
      const locked = s.lock === true;
      g.strokeStyle = '#555';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(24, locked ? 13 : 9, 6, Math.PI, 0);
      g.stroke();
      px(16, 13, 16, 14, locked ? '#c93' : '#9a9');
      px(23, 18, 2, 5, '#333');
      break;
    }
    default:
      px(14, 6, 20, 20, on ? '#6a6' : '#888');
  }
  if (!t.view.online) {
    px(0, 0, W, H, 'rgba(200,200,200,0.7)');
    px(4, 15, 40, 2, '#900');
  }
}

/** Tile positions in window content coordinates. Main turns them into screen rects the couch drives to. */
function reportRects() {
  const rects: Record<string, { x: number; y: number; width: number; height: number }> = {};
  for (const [id, t] of tiles) {
    const r = t.li.getBoundingClientRect();
    rects[id] = { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  api.send({ c: 'tiles', rects });
}

function render(list: DeviceView[]) {
  tilesEl.replaceChildren();
  tiles.clear();
  $('none').hidden = list.length > 0;
  for (const v of list) {
    const li = document.createElement('li');
    li.className = 'tile';
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', v.kind);
    const name = document.createElement('h2');
    name.textContent = v.name; // data, never HTML
    const st = document.createElement('p');
    st.className = 'muted';
    li.append(canvas, name, st);
    if (v.adapter !== 'sim') li.classList.add('real');
    tilesEl.append(li);
    const t = { view: v, li, canvas, status: st, spin: 0 };
    tiles.set(v.id, t);
    st.textContent = status(v);
    draw(t);
  }
  requestAnimationFrame(reportRects);
}

api.on((ev) => {
  if (ev.t === 'devices') render(ev.list);
  else if (ev.t === 'device') {
    const t = tiles.get(ev.id);
    if (!t) return;
    t.view = { ...t.view, state: ev.online ? { ...t.view.state, ...ev.state } : t.view.state, online: ev.online };
    t.status.textContent = status(t.view);
    draw(t);
  }
});

$('compact').addEventListener('click', (e) => {
  const b = e.currentTarget as HTMLButtonElement;
  const on = document.body.classList.toggle('compact');
  b.setAttribute('aria-pressed', String(on));
  b.textContent = on ? 'Expand' : 'Collapse';
  requestAnimationFrame(reportRects);
});
addEventListener('resize', () => requestAnimationFrame(reportRects));
addEventListener('scroll', () => requestAnimationFrame(reportRects));

// Moving parts (fan, TV, AC airflow, speaker) redraw at about 15 fps; still frames with reduced motion.
if (!reduced)
  setInterval(() => {
    for (const t of tiles.values()) if (['fan', 'tv', 'thermostat', 'speaker'].includes(t.view.kind) && t.view.state.power) draw(t);
  }, 66);

$('hide').addEventListener('click', () => api.send({ c: 'hideDevices' }));

api.send({ c: 'devicesReady' });
