// A toy copy of the desktop app's couch, drawn with the same pixel art and lines.
// It only moves when a visitor taps a request: no endless loops, and nothing runs while the tab is hidden.
const SW = 64, SH = 48; // sprite grid, same as the app
const W = 256, H = 72; // stage grid
const HOME = W - SW - 4;

const C = {
  couch: '#b5562e', couchDark: '#7d3a1f', couchLight: '#d9774a', frame: '#3b2a20', tire: '#1b1b1b', hub: '#9a9a9a',
  light: '#ffe27a', skin: '#f0c49a', hair: '#4a3020', shirt: '#5d7f9e', pants: '#3e4a5c', shoe: '#222', ink: '#1d1b19',
  remote: '#2a2a2a', paper: '#fffaf0', smoke: 'rgba(160,150,140,0.7)', floor: '#e9dcc4', wall: '#f6ecd9', rug: '#d9c3a0',
};

// Lines from the app's persona banks.
const LINES = {
  wake: ['Huh. I was resting my eyes.', 'Ugh. What now?', 'Awake. Unfortunately.', 'Okay, okay. I am here.'],
  depart: ['Alright, getting up. Not literally.', 'Fine, the couch is moving.', "Okay. Going. Don't touch my spot.", "On my way. Slowly, it's a couch."],
  working: ['Reaching. Do not watch.', 'Pressing the button. Very hard.', 'Tapping. This is my cardio.'],
  done: ["Done. Don't make it a habit.", 'There you go.', 'Done. You owe me a snack.', 'Sorted. Back to the couch.'],
  warn: ["Rude. I'll do it. This once.", 'Hey. I am literally doing your chores. Be nice.', 'Wow. Doing it anyway. Manners next time?'],
  refuse: ['Nope. Not until you say sorry.', 'I am on strike. An apology ends it.', 'Couch is closed for rude people. Sorry opens it.'],
  apology: ['Fine. Apology accepted. What do you need?', 'Accepted. I was never mad. I was very mad.'],
  unneeded: ['Apologize for what? Okay. Accepted, I guess.'],
};
const pick = (k) => LINES[k][Math.floor(Math.random() * LINES[k].length)];

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
canvas.width = W;
canvas.height = H;
const art = document.createElement('canvas');
art.width = SW;
art.height = SH;
const o = art.getContext('2d');
const bubble = document.getElementById('bubble');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

const props = { lamp: { x: 18, on: false }, file: { x: 66, open: false }, tv: { x: 112, on: false } };
let guy = { x: HOME, facing: 1, state: 'asleep', arm: 'rest', since: 0 }; // asleep until someone needs him
let strikes = 0;
let busy = false;
let wheel = 0;
let puffs = [];
let blinkAt = 3;

function rect(c, x, y, w, h, col) {
  c.fillStyle = col;
  c.fillRect(Math.round(x), Math.round(y), w, h);
}
function seg(x0, y0, x1, y1, col) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    rect(o, x0, y0, 1, 1, col);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) (err += dy), (x0 += sx);
    if (e2 <= dx) (err += dx), (y0 += sy);
  }
}
function leg(x, lift) {
  rect(o, x, 38 - lift, 3, 5, C.frame);
  rect(o, x, 42 - lift, 3, 1, C.couchDark);
}

function drawGuy(t) {
  o.clearRect(0, 0, SW, SH);
  const driving = guy.state === 'driving';
  const by = driving && !reduced ? Math.round(Math.sin(t * 22) * 0.6) : 0;
  const gy = by + (guy.state === 'asleep' ? 1 : 0);
  rect(o, 4, 34 + by, 56, 4, C.couchDark);
  rect(o, 6, 29 + by, 52, 6, C.couchDark);
  rect(o, 8, 31 + by, 48, 1, C.couch);
  rect(o, 14, 25 + by, 40, 5, C.couch);
  rect(o, 14, 25 + by, 40, 1, C.couchLight);
  rect(o, 5, 12 + by, 10, 20, C.couch);
  rect(o, 6, 11 + by, 8, 1, C.couchLight);
  rect(o, 52, 21 + by, 8, 12, C.couch);
  rect(o, 51, 20 + by, 10, 2, C.couchDark);
  rect(o, 4, 10 + by, 4, 4, '#e3b04b');
  rect(o, 5, 11 + by, 2, 2, '#f0c96a');
  const step = driving && !reduced ? (Math.sin(wheel) > 0 ? 1 : 0) : 0;
  leg(7, step);
  leg(17, 1 - step);
  leg(44, step);
  leg(54, 1 - step);
  rect(o, 24, 21 + gy, 17, 4, C.pants);
  rect(o, 40, 21 + gy, 9, 3, C.pants);
  rect(o, 48, 17 + by, 3, 5, C.shoe);
  rect(o, 15, 12 + gy, 10, 11, C.shirt);
  rect(o, 24, 16 + gy, 2, 6, C.shirt);
  rect(o, 15, 3 + gy, 10, 10, C.skin);
  rect(o, 15, 2 + gy, 10, 2, C.hair);
  rect(o, 15, 4 + gy, 2, 4, C.hair);
  rect(o, 25, 7 + gy, 1, 2, C.skin);
  if (!reduced && t > blinkAt) blinkAt = t + 2.5 + Math.random() * 3;
  const blink = !reduced && blinkAt - t > 0 && blinkAt - t < 0.12;
  if (guy.state === 'asleep' || blink) rect(o, 21, 7 + gy, 3, 1, C.ink);
  else (rect(o, 22, 6 + gy, 1, 2, C.ink), rect(o, 20, 5 + gy, 3, 1, C.hair));
  if (guy.state === 'sulking') (rect(o, 21, 11 + gy, 3, 1, C.ink), rect(o, 21, 10 + gy, 1, 1, C.ink));
  else if (guy.state === 'talking' && !reduced && Math.sin(t * 18) > 0) rect(o, 22, 10 + gy, 2, 2, C.ink);
  else rect(o, 21, 10 + gy, 3, 1, C.ink);
  const sx = 20, sy = 14 + gy;
  let hand;
  if (guy.arm === 'reach') {
    hand = [27, 9 + gy - (reduced ? 0 : Math.round(Math.sin(t * 8)))];
    seg(sx, sy, hand[0], hand[1], C.shirt);
  } else if (guy.arm === 'hold') {
    hand = [31, 10 + gy];
    seg(sx, sy, hand[0], hand[1], C.shirt);
    rect(o, 31, 4 + gy, 5, 6, C.paper);
    rect(o, 32, 5 + gy, 3, 1, C.ink);
    rect(o, 32, 7 + gy, 3, 1, C.ink);
  } else if (guy.arm === 'cross') {
    hand = [25, 17 + gy];
    seg(sx, sy + 3, hand[0], hand[1], C.shirt);
  } else if (guy.arm === 'drive') {
    hand = [25, 17 + gy];
    seg(sx, sy, hand[0], hand[1], C.shirt);
  } else {
    hand = [26, 19 + gy];
    seg(sx, sy, hand[0], hand[1], C.shirt);
  }
  rect(o, hand[0], hand[1], 2, 2, C.skin);
  if (guy.state === 'asleep') (rect(o, 28, 4, 3, 1, '#6b8fd6'), rect(o, 29, 5, 1, 1, '#6b8fd6'), rect(o, 28, 6, 3, 1, '#6b8fd6'));
}

function drawRoom() {
  rect(ctx, 0, 0, W, H, C.wall);
  rect(ctx, 0, 52, W, H - 52, C.floor);
  rect(ctx, 0, 51, W, 1, '#d2c2a4');
  rect(ctx, 150, 56, 90, 4, C.rug);
  // window with a lazy cloud
  rect(ctx, 170, 8, 34, 22, '#3b2a20');
  rect(ctx, 172, 10, 30, 18, '#bfe0f2');
  rect(ctx, 186, 10, 1, 18, '#3b2a20');
  rect(ctx, 176, 15, 8, 3, '#ffffff');
  // lamp
  const L = props.lamp;
  if (L.on) {
    ctx.fillStyle = 'rgba(255,226,122,0.35)';
    ctx.beginPath();
    ctx.moveTo(L.x + 1, 22); ctx.lineTo(L.x + 11, 22); ctx.lineTo(L.x + 22, 52); ctx.lineTo(L.x - 10, 52); ctx.fill();
  }
  rect(ctx, L.x, 14, 12, 8, L.on ? '#ffe27a' : '#c9b48a');
  rect(ctx, L.x + 5, 22, 2, 28, '#3b2a20');
  rect(ctx, L.x + 2, 50, 8, 2, '#3b2a20');
  // desk with a file
  const F = props.file;
  rect(ctx, F.x - 4, 38, 26, 3, '#7d5a3a');
  rect(ctx, F.x - 2, 41, 2, 11, '#7d5a3a');
  rect(ctx, F.x + 18, 41, 2, 11, '#7d5a3a');
  if (!F.open) (rect(ctx, F.x + 4, 31, 9, 7, '#fffaf0'), rect(ctx, F.x + 6, 33, 5, 1, '#9a8f84'), rect(ctx, F.x + 6, 35, 5, 1, '#9a8f84'));
  // tv
  const T = props.tv;
  rect(ctx, T.x, 26, 30, 20, '#2a2420');
  rect(ctx, T.x + 2, 28, 26, 15, T.on ? '#b5562e' : '#4a4440');
  if (T.on) (rect(ctx, T.x + 12, 31, 2, 9, '#fffaf0'), rect(ctx, T.x + 14, 32, 2, 7, '#fffaf0'), rect(ctx, T.x + 16, 34, 2, 3, '#fffaf0'));
  rect(ctx, T.x + 13, 46, 4, 6, '#2a2420');
}

let last = performance.now();
let raf = 0;
let idleTimer = 0;
function frame() {
  const now = performance.now();
  const t = now / 1000;
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (guy.state === 'driving' && !reduced) {
    wheel += (guy.facing * 60 * dt) / 4;
    if (Math.random() < 0.2) puffs.push({ x: guy.x + (guy.facing > 0 ? 8 : SW - 8), y: 48, life: 1 });
  }
  puffs = puffs.filter((p) => (p.life -= dt * 1.6) > 0);
  drawRoom();
  for (const p of puffs) rect(ctx, p.x - 1, p.y - (1 - p.life) * 8, 2 + Math.round((1 - p.life) * 2), 2, C.smoke);
  drawGuy(t);
  ctx.save();
  if (guy.facing < 0) (ctx.translate(Math.round(guy.x) + SW, 6), ctx.scale(-1, 1));
  else ctx.translate(Math.round(guy.x), 6);
  ctx.drawImage(art, 0, 0);
  ctx.restore();
  placeBubble();
  const moving = guy.state === 'driving' || guy.state === 'talking' || guy.arm === 'reach' || puffs.length;
  if (document.hidden) return;
  if (moving) raf = requestAnimationFrame(frame);
  else idleTimer = setTimeout(frame, 250); // idle: blink only, four frames a second
}
function kick() {
  cancelAnimationFrame(raf);
  clearTimeout(idleTimer);
  frame();
}
document.addEventListener('visibilitychange', () => !document.hidden && kick());

let bubbleLeft = '';
function placeBubble() {
  if (bubble.hidden) return;
  const r = canvas.getBoundingClientRect();
  const left = `${Math.round(Math.max(8, Math.min(r.width - 228, (guy.x + 14) * (r.width / W) - 40)))}px`;
  if (left !== bubbleLeft) bubble.style.left = bubbleLeft = left;
}
function say(text, ms = 1600) {
  bubble.textContent = text;
  bubble.hidden = false;
  placeBubble();
  guy.state = 'talking';
  kick();
  return wait(reduced ? 900 : ms).then(() => {
    guy.state = 'idle';
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function drive(to) {
  guy.facing = to > guy.x ? 1 : -1;
  guy.state = 'driving';
  guy.arm = 'drive';
  bubble.hidden = true;
  const from = guy.x, dist = Math.abs(to - from), ms = reduced ? 0 : 500 + dist * 9, start = performance.now();
  kick();
  return new Promise((res) => {
    const step = () => {
      const k = ms ? Math.min(1, (performance.now() - start) / ms) : 1;
      guy.x = from + (to - from) * (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
      if (k < 1) requestAnimationFrame(step);
      else (guy.state = 'idle', guy.arm = 'rest', res());
    };
    step();
  });
}

async function errand(prop, act) {
  await say(pick('depart'), 1200);
  await drive(Math.max(0, props[prop].x - 30));
  guy.facing = 1;
  guy.arm = 'reach';
  guy.since = performance.now() / 1000;
  await say(pick('working'), 1200);
  act();
  guy.arm = prop === 'file' ? 'hold' : 'rest';
  await drive(HOME);
  guy.facing = 1;
  await say(pick('done'), 2200);
  if (prop === 'file') (props.file.open = false, guy.arm = 'rest');
  kick();
}

const REQUESTS = {
  lamp: () => errand('lamp', () => (props.lamp.on = !props.lamp.on)),
  tv: () => errand('tv', () => (props.tv.on = !props.tv.on)),
  file: () => errand('file', () => (props.file.open = true)),
  rude: async () => {
    strikes++;
    if (strikes >= 2) (guy.arm = 'cross', guy.state = 'sulking');
    await say(pick(strikes >= 2 ? 'refuse' : 'warn'), 2600);
    if (strikes >= 2) guy.state = 'sulking';
    kick();
  },
  sorry: async () => {
    const was = strikes;
    strikes = 0;
    guy.arm = 'rest';
    await say(pick(was ? 'apology' : 'unneeded'), 2400);
    kick();
  },
};

for (const b of document.querySelectorAll('[data-ask]')) {
  b.addEventListener('click', async () => {
    if (busy) return;
    const k = b.dataset.ask;
    if (strikes >= 2 && k !== 'sorry' && k !== 'rude') {
      busy = true;
      await say(pick('refuse'), 2200);
      guy.state = 'sulking';
      busy = false;
      return kick();
    }
    busy = true;
    document.body.classList.add('busy');
    await REQUESTS[k]();
    busy = false;
    document.body.classList.remove('busy');
  });
}

canvas.addEventListener('click', () => !busy && say(pick('wake'), 1800));
kick();
