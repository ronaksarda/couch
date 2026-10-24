import type { CouchApi, CouchEvent, GuyState } from '../electron/preload';

const api = (window as unknown as { couch: CouchApi }).couch;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- sprite engine: procedural pixel art, no image assets ----------

const SW = 64; // sprite grid, in art pixels
const SH = 48;
const canvas = $<HTMLCanvasElement>('sprite');
const ctx = canvas.getContext('2d')!;
const art = new OffscreenCanvas(SW, SH);
const o = art.getContext('2d', { willReadFrequently: true })!;

const C = {
  couch: '#b5562e',
  couchDark: '#7d3a1f',
  couchLight: '#d9774a',
  frame: '#3b2a20',
  skin: '#f0c49a',
  hair: '#4a3020',
  shirt: '#5d7f9e',
  pants: '#3e4a5c',
  shoe: '#222',
  ink: '#1d1b19',
  paper: '#fffaf0',
  smoke: 'rgba(200,200,200,0.8)',
  zz: '#6b8fd6',
};

let state: GuyState = 'idle';
let motion = { vel: 0, accel: 0, facing: -1 as 1 | -1 };
let reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let collapsed = false;
let mouth = 0; // 0..1, from audio amplitude
let wheelAngle = 0;
let puffs: { x: number; y: number; r: number; life: number }[] = [];
let nextBlink = 2;

function rect(x: number, y: number, w: number, h: number, c: string) {
  o.fillStyle = c;
  o.fillRect(Math.round(x), Math.round(y), w, h);
}

function seg(x0: number, y0: number, x1: number, y1: number, c: string) {
  // Bresenham, so limbs stay crisp pixels
  x0 = Math.round(x0);
  y0 = Math.round(y0);
  x1 = Math.round(x1);
  y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  o.fillStyle = c;
  for (;;) {
    o.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) (err += dy), (x0 += sx);
    if (e2 <= dx) (err += dx), (y0 += sy);
  }
}

/** Stubby wooden leg. While scooting the legs take little alternating steps. */
function leg(x: number, lift: number) {
  rect(x, 38 - lift, 3, 5, C.frame);
  rect(x, 42 - lift, 3, 1, C.couchDark);
}

type Arm = 'rest' | 'scratch' | 'ear' | 'hold' | 'reach' | 'cross' | 'drive';

function armFor(s: GuyState): Arm {
  switch (s) {
    case 'thinking':
      return 'scratch';
    case 'listening':
      return 'ear';
    case 'delivering':
      return 'hold';
    case 'working':
      return 'reach';
    case 'sulking':
      return 'cross';
    case 'driving':
    case 'returning':
    case 'departing':
    case 'arriving':
    case 'parking':
      return 'drive';
    default:
      return 'rest';
  }
}

/** Draws one frame into the art canvas. t = seconds; frozen at 0 under reduced motion. */
function drawArt(t: number, dt: number) {
  const still = reducedMotion;
  const driving = state === 'driving' || state === 'returning';
  const speed = Math.abs(motion.vel);
  const localAccel = motion.accel * motion.facing;

  o.setTransform(1, 0, 0, 1, 0, 0);
  o.clearRect(0, 0, SW, SH);
  // The art faces right; mirror it when driving left.
  if (motion.facing < 0) o.setTransform(-1, 0, 0, 1, SW, 0);

  // body offsets: suspension bob, brake squat, lean on accel/brake
  const bob = !still && driving ? Math.round(Math.sin(t * 22) * 0.6 + (speed > 200 ? 0.4 : 0)) : 0;
  const squat = state === 'arriving' ? 2 : state === 'parking' ? 1 : 0;
  const by = bob + squat;
  const lean = !still && driving && Math.abs(localAccel) > 400 ? -Math.sign(localAccel) : 0;
  const gx = lean + (state === 'listening' ? 1 : 0) + (state === 'asleep' ? -1 : 0);
  const gy = by + (state === 'asleep' ? 1 : 0);

  if (!still && driving) wheelAngle += (motion.vel * motion.facing * dt) / 12; // drives the leg shuffle

  // dust from the back legs while scooting
  if (!still) {
    const rate = state === 'departing' ? 0.4 : driving ? speed / 2200 : 0;
    if (Math.random() < rate) puffs.push({ x: 8, y: 41, r: state === 'departing' ? 2 : 1, life: 1 });
    puffs = puffs.filter((p) => (p.life -= dt * 1.4) > 0);
    for (const p of puffs) {
      p.x -= dt * 10;
      p.y -= dt * 6;
      const r = Math.round(p.r + (1 - p.life) * 2);
      rect(p.x - r, p.y - r, r * 2, r * 2, C.smoke);
    }
  }

  // couch: an ordinary living-room couch on four wooden legs
  rect(4, 34 + by, 56, 4, C.couchDark); // base
  rect(6, 29 + by, 52, 6, C.couchDark); // skirt
  rect(8, 31 + by, 48, 1, C.couch); // seam
  rect(14, 25 + by, 40, 5, C.couch); // seat cushion
  rect(14, 25 + by, 40, 1, C.couchLight);
  rect(5, 12 + by, 10, 20, C.couch); // backrest
  rect(6, 11 + by, 8, 1, C.couchLight);
  rect(52, 21 + by, 8, 12, C.couch); // front arm
  rect(51, 20 + by, 10, 2, C.couchDark);
  rect(4, 10 + by, 4, 4, '#e3b04b'); // cushion he never uses
  rect(5, 11 + by, 2, 2, '#f0c96a');
  const step = !still && driving ? (Math.sin(wheelAngle) > 0 ? 1 : 0) : 0;
  leg(7, step);
  leg(17, 1 - step);
  leg(44, step);
  leg(54, 1 - step);

  // guy: always seated, legs stretched, feet up on the armrest. No standing frames, by design.
  rect(24 + gx, 21 + gy, 17, 4, C.pants); // thighs
  rect(40 + gx, 21 + gy, 9, 3, C.pants); // shins
  rect(48, 17 + by, 3, 5, C.shoe); // feet on the arm
  rect(15 + gx, 12 + gy, 10, 11, C.shirt); // slouched torso
  rect(24 + gx, 16 + gy, 2, 6, C.shirt); // belly
  rect(15 + gx, 3 + gy, 10, 10, C.skin); // head
  rect(15 + gx, 2 + gy, 10, 2, C.hair);
  rect(15 + gx, 4 + gy, 2, 4, C.hair);
  rect(25 + gx, 7 + gy, 1, 2, C.skin); // nose

  // eyes: blink every few seconds; closed while asleep
  if (!still && t > nextBlink) nextBlink = t + 2.5 + Math.random() * 3;
  const blinking = !still && nextBlink - t > 0 && nextBlink - t < 0.12;
  const closed = state === 'asleep' || blinking;
  if (closed) rect(21 + gx, 7 + gy, 3, 1, C.ink);
  else {
    rect(22 + gx, 6 + gy, 1, 2, C.ink);
    rect(20 + gx, 5 + gy, 3, 1, C.hair); // heavy lazy eyebrow
  }

  // mouth
  const talking = state === 'talking' || mouth > 0.05;
  const open = still ? (talking ? 1 : 0) : talking ? Math.min(2, Math.round(mouth * 3 + (mouth < 0.05 ? (Math.sin(t * 18) > 0 ? 1 : 0) : 0))) : 0;
  if (state === 'sulking') {
    rect(21 + gx, 11 + gy, 3, 1, C.ink);
    rect(21 + gx, 10 + gy, 1, 1, C.ink);
  } else if (open > 0) rect(22 + gx, 10 + gy, 2, open, C.ink);
  else rect(21 + gx, 10 + gy, 3, 1, C.ink);

  // arm
  const sx = 20 + gx;
  const sy = 14 + gy;
  const wig = still ? 0 : Math.round(Math.sin(t * 14));
  let hand: [number, number];
  switch (armFor(state)) {
    case 'scratch':
      hand = [17 + gx + wig, 1 + gy];
      seg(sx, sy, 23 + gx, 9 + gy, C.shirt);
      seg(23 + gx, 9 + gy, hand[0], hand[1], C.shirt);
      break;
    case 'ear':
      hand = [16 + gx, 7 + gy];
      seg(sx, sy, 14 + gx, 11 + gy, C.shirt);
      seg(14 + gx, 11 + gy, hand[0], hand[1], C.shirt);
      break;
    case 'hold':
      hand = [31 + gx, 10 + gy];
      seg(sx, sy, hand[0], hand[1], C.shirt);
      rect(31 + gx, 4 + gy, 5, 6, C.paper); // document
      rect(32 + gx, 5 + gy, 3, 1, C.ink);
      rect(32 + gx, 7 + gy, 3, 1, C.ink);
      break;
    case 'reach':
      // a lazy wave toward the thing: normal arm length, a little bob
      hand = [27 + gx, 9 + gy - (still ? 0 : Math.round(Math.sin(t * 8)))];
      seg(sx, sy, hand[0], hand[1], C.shirt);
      break;
    case 'cross':
      hand = [25 + gx, 17 + gy];
      seg(sx, sy + 3, hand[0], hand[1], C.shirt);
      break;
    case 'drive':
      hand = [25 + gx, 17 + gy]; // holding on to the armrest
      seg(sx, sy, hand[0], hand[1], C.shirt);
      break;
    default:
      hand = [26 + gx, 19 + gy]; // hand resting on the belly
      seg(sx, sy, hand[0], hand[1], C.shirt);
  }
  rect(hand[0], hand[1], 2, 2, C.skin);

  // sigh cloud when departing, Zz when asleep
  if (state === 'departing') rect(27 + gx, 8 + gy, 2, 2, C.smoke);
  if (state === 'asleep') {
    const zy = still ? 0 : Math.round((t * 2) % 3);
    rect(28, 1 - zy + 3, 3, 1, C.zz);
    rect(29, 2 - zy + 3, 1, 1, C.zz);
    rect(28, 3 - zy + 3, 3, 1, C.zz);
  }
}

let scale = 3;
let offX = 0;
let offY = 0;

function present() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const full = Math.max(1, Math.floor(Math.min(w / SW, h / SH))); // integer scale only
  scale = collapsed ? Math.max(1, Math.floor(full / 2)) : full;
  offX = collapsed ? w - SW * scale : Math.floor((w - SW * scale) / 2);
  offY = h - SH * scale;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(art, offX, offY, SW * scale, SH * scale);
}

/** Is this client point over a non-transparent sprite pixel? */
function overSprite(clientX: number, clientY: number): boolean {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const x = Math.floor(((clientX - r.left) * dpr - offX) / scale);
  const y = Math.floor(((clientY - r.top) * dpr - offY) / scale);
  if (x < 0 || y < 0 || x >= SW || y >= SH) return false;
  return o.getImageData(x, y, 1, 1).data[3] > 0;
}

// Asleep 3 fps, idle 8 fps, 60 fps while moving or talking. Slow states use a plain timer, not
// requestAnimationFrame: rAF wakes the process 60 times a second even when it then skips the frame.
const FAST: GuyState[] = ['departing', 'driving', 'arriving', 'working', 'returning', 'parking', 'talking'];
let last = performance.now();
let wake = 0;
function loop() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (audioLevel) mouth = audioLevel();
  drawArt(reducedMotion ? 0 : now / 1000, dt);
  present();
  schedule();
}
function schedule() {
  clearTimeout(wake);
  if (FAST.includes(state) || mouth > 0.05) requestAnimationFrame(loop);
  else wake = window.setTimeout(loop, state === 'asleep' ? 333 : 125);
}
loop();

// ---------- bubble + playback ----------

const bubble = $<HTMLDivElement>('bubble');
let bubbleTimer = 0;
let player: HTMLAudioElement | null = null;
let audioCtx: AudioContext | null = null;
let audioLevel: (() => number) | null = null;

function spoken(id: number) {
  api.send({ c: 'spoken', id });
}

let typeTimer = 0;
let voiceOn = true;

/** Types the line out at a lazy pace, pausing on punctuation, mouth moving. Returns the typing time in ms. */
function typeOut(text: string): number {
  clearTimeout(typeTimer);
  if (reducedMotion) {
    bubble.textContent = text;
    return 0;
  }
  let i = 0;
  let total = 0;
  for (const ch of text) total += /[.,!?]/.test(ch) ? 200 : 32;
  const step = () => {
    i++;
    bubble.textContent = text.slice(0, i);
    if (!audioLevel) mouth = i < text.length ? 0.3 : 0;
    if (i < text.length) typeTimer = window.setTimeout(step, /[.,!?]/.test(text[i - 1]) ? 200 : 32);
  };
  step();
  return total;
}

// ---------- speech queue: every line finishes before the next one starts, nothing gets cut in half ----------

type Line = { id: number; text: string; bytes?: Uint8Array };
const queue: Line[] = [];
let active: Line | null = null;
let waitAudio = 0;

function enqueue(id: number, text: string) {
  queue.push({ id, text });
  while (queue.length > 2) queue.shift(); // fell behind: skip stale lines, keep the newest
  pump();
}

function gotAudio(id: number, bytes: Uint8Array) {
  const it = active?.id === id ? active : queue.find((q) => q.id === id);
  if (!it) return;
  it.bytes = bytes;
  if (it === active && !player) {
    clearTimeout(waitAudio);
    play(it);
  }
}

function pump() {
  if (active || !queue.length) return;
  const it = (active = queue.shift()!);
  $('said').textContent = it.text; // screen readers get the whole line once, not every letter
  clearTimeout(bubbleTimer);
  bubble.hidden = false;
  const typing = typeOut(it.text);
  if (it.bytes) return play(it);
  // Voice on: wait a moment for the audio. Voice off or slow voice: read time, then move on.
  const read = typing + Math.max(1600, it.text.length * 55);
  waitAudio = window.setTimeout(() => finish(it), voiceOn ? Math.max(read, 2500) : read);
}

function finish(it: Line) {
  if (active !== it) return;
  clearTimeout(waitAudio);
  active = null;
  spoken(it.id);
  if (queue.length) return pump();
  bubbleTimer = window.setTimeout(() => (bubble.hidden = true), 2500); // time to finish reading
}

function stopAudio() {
  queue.length = 0;
  if (player) {
    player.pause();
    URL.revokeObjectURL(player.src);
  }
  player = null;
  audioLevel = null;
  mouth = 0;
  if (active) finish(active);
}

function play(it: Line) {
  audioCtx ??= new AudioContext();
  const el = new Audio(URL.createObjectURL(new Blob([it.bytes as Uint8Array<ArrayBuffer>], { type: 'audio/mpeg' })));
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  audioCtx.createMediaElementSource(el).connect(analyser);
  analyser.connect(audioCtx.destination);
  const buf = new Float32Array(analyser.fftSize);
  audioLevel = () => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    return Math.min(1, Math.sqrt(sum / buf.length) * 6);
  };
  player = el;
  const end = () => {
    if (player !== el) return;
    URL.revokeObjectURL(el.src);
    player = null;
    audioLevel = null;
    mouth = 0;
    finish(it);
  };
  el.addEventListener('ended', end);
  el.addEventListener('error', end);
  el.addEventListener('pause', end); // paused from outside: move on instead of hanging
  void el.play().catch(end);
}

// ---------- recorder: MediaRecorder + RMS silence detection ----------

let rec: { stop(): void } | null = null;
let starting = false;
let stopAsked = false; // "stop" arrived while the mic was still opening

async function startListening() {
  if (rec || starting) return;
  starting = true;
  stopAsked = false;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    starting = false;
    api.send({ c: 'micError' }); // blocked or no mic: main opens the text box
    return;
  }
  starting = false;
  if (stopAsked) {
    stream.getTracks().forEach((t) => t.stop());
    return api.send({ c: 'text', text: '' });
  }
  const mr = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  const actx = new AudioContext();
  const analyser = actx.createAnalyser();
  analyser.fftSize = 1024;
  actx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const started = performance.now();
  let lastLoud = started;
  const poll = window.setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const now = performance.now();
    if (Math.sqrt(sum / buf.length) > 0.015) lastLoud = now;
    if (now - lastLoud > 1500 || now - started > 15_000) stop(); // 1.5 s silence or 15 s max
  }, 100);
  const stop = () => {
    if (mr.state !== 'inactive') mr.stop();
  };
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mr.onstop = async () => {
    clearInterval(poll);
    stream.getTracks().forEach((t) => t.stop());
    void actx.close();
    rec = null;
    const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
    if (blob.size === 0) return api.send({ c: 'text', text: '' }); // nothing recorded: main says "Huh?"
    api.send({ c: 'audio', bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type });
  };
  mr.start(250);
  rec = { stop };
}

function stopListening() {
  if (starting) stopAsked = true;
  rec?.stop();
}

// Mic button: click, talk, he stops listening when you go quiet (or click again). Never always-on.
const micBtn = $<HTMLButtonElement>('mic');
let lastMic = 0;
micBtn.addEventListener('click', () => {
  const now = performance.now();
  if (now - lastMic < 400) return; // double-click guard
  lastMic = now;
  api.send({ c: 'mic' });
});

// ---------- text box (always available) ----------

const form = $<HTMLFormElement>('ask');
const input = $<HTMLInputElement>('askText');

function openInput() {
  if (collapsed) toggleCollapse();
  form.hidden = false;
  api.send({ c: 'input', on: true });
  input.focus();
}

function closeInput() {
  form.hidden = true;
  input.value = '';
  api.send({ c: 'input', on: false });
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  closeInput();
  if (text) api.send({ c: 'text', text });
});
input.addEventListener('keydown', (e) => e.key === 'Escape' && closeInput());
input.addEventListener('blur', () => !form.hidden && setTimeout(() => document.activeElement !== input && closeInput(), 0));

// ---------- collapse ----------

const collapseBtn = $<HTMLButtonElement>('collapse');
function toggleCollapse() {
  collapsed = !collapsed;
  document.body.classList.toggle('collapsed', collapsed);
  collapseBtn.textContent = collapsed ? '+' : '–';
  collapseBtn.setAttribute('aria-label', collapsed ? 'Expand couch' : 'Collapse couch');
  collapseBtn.setAttribute('aria-expanded', String(!collapsed));
}
collapseBtn.setAttribute('aria-expanded', 'true');
collapseBtn.addEventListener('click', toggleCollapse);
$('quit').addEventListener('click', () => api.send({ c: 'quit' }));

// ---------- click-through: tell main when the pointer is over something solid ----------

let hit = false;
let dragging = false;
function report(over: boolean) {
  if (over === hit) return;
  hit = over;
  api.send({ c: 'hit', over });
}

window.addEventListener('mousemove', (e) => {
  if (dragging) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  report(!!el?.closest('.hit') || (el === canvas && overSprite(e.clientX, e.clientY)) || !form.hidden);
});
document.addEventListener('mouseleave', () => !dragging && form.hidden && report(false));

// ---------- drag (sprite only) ----------

let down: { x: number; y: number; id: number } | null = null;
// Right-click the guy: the same menu as the tray, so Quit is always one click away.
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (overSprite(e.clientX, e.clientY)) api.send({ c: 'menu' });
});

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !overSprite(e.clientX, e.clientY)) return;
  down = { x: e.screenX, y: e.screenY, id: e.pointerId };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!down) return;
  if (!dragging && Math.hypot(e.screenX - down.x, e.screenY - down.y) > 4) {
    dragging = true;
    api.send({ c: 'drag', phase: 'start', x: down.x, y: down.y });
  }
  if (dragging) api.send({ c: 'drag', phase: 'move', x: e.screenX, y: e.screenY });
});
canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  canvas.releasePointerCapture(down.id);
  if (dragging) api.send({ c: 'drag', phase: 'end', x: e.screenX, y: e.screenY });
  else openInput(); // a plain click on the guy opens the text box
  down = null;
  dragging = false;
});

// ---------- events from main ----------

api.on((ev: CouchEvent) => {
  switch (ev.t) {
    case 'state':
      state = ev.state;
      return;
    case 'motion':
      motion = { vel: ev.vel, accel: ev.accel, facing: ev.facing };
      return;
    case 'say':
      return enqueue(ev.id, ev.text);
    case 'audio':
      return gotAudio(ev.id, ev.bytes);
    case 'stopAudio':
      return stopAudio();
    case 'listen':
      micBtn.classList.toggle('on', ev.on);
      micBtn.setAttribute('aria-pressed', String(ev.on));
      micBtn.setAttribute('aria-label', ev.on ? 'Stop listening' : 'Talk to him');
      if (ev.on) void startListening();
      else stopListening();
      return;
    case 'openInput':
      return openInput();
    case 'settings':
      reducedMotion = ev.reducedMotion;
      voiceOn = ev.voice;
      return;
  }
});

api.send({ c: 'ready', osReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
