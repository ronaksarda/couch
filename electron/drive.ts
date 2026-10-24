import { screen, type BrowserWindow, type Point, type Rectangle } from 'electron';
import type { Corner } from './settings';

export type Target =
  | { kind: 'home' }
  | { kind: 'screenPoint'; x: number; y: number }
  | { kind: 'resultsWindow' }
  | { kind: 'devicePanelTile'; id: string }
  | { kind: 'playerWindow' };

export type Phase = 'idle' | 'departing' | 'driving' | 'arriving' | 'working' | 'returning' | 'parking';

export interface Motion {
  vel: number; // horizontal screen px/s, signed
  accel: number;
  facing: 1 | -1;
}

export interface DriveDeps {
  windowRect(kind: 'resultsWindow' | 'playerWindow' | 'devicePanelTile', id?: string): Rectangle | null;
  home(): { corner: Corner; displayId?: number };
  reducedMotion(): boolean;
  onPhase(p: Phase): void;
  onMotion(m: Motion): void;
  say(text: string): void;
}

export class Cancelled extends Error {}

export const SPEED_CAP = 900;
export const MIN_T = 0.6;
export const MAX_T = 2.5;
const STUCK_MS = 5000;
const MARGIN = 8;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Smoothstep peaks at 1.5x the average speed, so this keeps the peak near the cap.
export const duration = (dist: number) => clamp((1.5 * dist) / SPEED_CAP, MIN_T, MAX_T);

// Cubic Hermite on one axis: start at p0 with velocity v0, stop at p1 with velocity 0.
// v0 = 0 gives ease-in-out; v0 != 0 lets a retarget bleed off the current speed smoothly.
export function hermite(p0: number, v0: number, p1: number, T: number, t: number): { p: number; v: number } {
  const s = clamp(t / T, 0, 1);
  const s2 = s * s;
  const s3 = s2 * s;
  const p = (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * T * v0 + (-2 * s3 + 3 * s2) * p1;
  const v = ((6 * s2 - 6 * s) * p0 + (-6 * s2 + 6 * s) * p1) / T + (3 * s2 - 4 * s + 1) * v0;
  return { p, v };
}

export function cornerPoint(area: Rectangle, corner: Corner, w: number, h: number): Point {
  return {
    x: corner.endsWith('l') ? area.x + MARGIN : area.x + area.width - w - MARGIN,
    y: corner.startsWith('t') ? area.y + MARGIN : area.y + area.height - h - MARGIN,
  };
}

export function nearestCorner(area: Rectangle, center: Point): Corner {
  const top = center.y < area.y + area.height / 2;
  const left = center.x < area.x + area.width / 2;
  return `${top ? 't' : 'b'}${left ? 'l' : 'r'}` as Corner;
}

let win: BrowserWindow;
let deps: DriveDeps;
let W = 0;
let H = 0;

let pos: Point = { x: 0, y: 0 };
let vel: Point = { x: 0, y: 0 };
let facing: 1 | -1 = -1;
let phase: Phase = 'idle';
let errandId = 0;

interface Segment {
  target: Target;
  p0: Point;
  v0: Point;
  p1: Point;
  T: number;
  start: number;
  resolve(): void;
  reject(e: Error): void;
}
let seg: Segment | null = null;
let timer: NodeJS.Timeout | null = null;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function place(p: Point) {
  // Always pass the same width/height: on mixed-DPI setups setPosition alone lets Windows drift the size.
  win.setBounds({ x: Math.round(p.x), y: Math.round(p.y), width: W, height: H });
}

function clampToWork(p: Point): Point {
  const area = screen.getDisplayMatching({ x: Math.round(p.x), y: Math.round(p.y), width: W, height: H }).workArea;
  return { x: clamp(p.x, area.x, area.x + area.width - W), y: clamp(p.y, area.y, area.y + area.height - H) };
}

function beside(r: Rectangle): Point {
  // Park against the left edge of the rect, bottoms aligned; flip right if there is no room.
  const area = screen.getDisplayMatching(r).workArea;
  const x = r.x - W >= area.x ? r.x - W : r.x + r.width;
  return { x, y: r.y + r.height - H };
}

/** Is there a real window to drive to? */
export function targetVisible(t: Target): boolean {
  return t.kind === 'home' || t.kind === 'screenPoint' || deps.windowRect(t.kind, 'id' in t ? t.id : undefined) !== null;
}

function outing(): Point {
  const home = resolveTarget({ kind: 'home' });
  const area = screen.getDisplayNearestPoint(home).workArea;
  const away = Math.min(420, area.width / 3);
  const left = home.x - away >= area.x;
  return { x: left ? home.x - away : home.x + away, y: home.y };
}

function resolveTarget(t: Target): Point {
  let p: Point | null = null;
  switch (t.kind) {
    case 'home': {
      const h = deps.home();
      const d = screen.getAllDisplays().find((x) => x.id === h.displayId) ?? screen.getPrimaryDisplay();
      p = cornerPoint(d.workArea, h.corner, W, H);
      break;
    }
    case 'screenPoint':
      // Sit just left of the point so the arm reaches it; flip side near the left edge.
      p = beside({ x: t.x, y: t.y - H / 2, width: 1, height: H });
      break;
    case 'devicePanelTile': {
      const r = deps.windowRect('devicePanelTile', t.id);
      p = r && beside(r);
      break;
    }
    default: {
      const r = deps.windowRect(t.kind);
      p = r && beside(r);
    }
  }
  // Hidden target (popup not open yet, device panel closed): still head out a little way from home,
  // so every errand is a visible trip instead of the couch sitting still.
  p = clampToWork(p ?? outing());
  return p;
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

function finish(err?: Error) {
  const s = seg;
  seg = null;
  stopTimer();
  vel = { x: 0, y: 0 };
  deps.onMotion({ vel: 0, accel: 0, facing });
  if (s) err ? s.reject(err) : s.resolve();
}

function tick() {
  if (!seg) return stopTimer();
  const now = Date.now();
  const t = (now - seg.start) / 1000;
  const x = hermite(seg.p0.x, seg.v0.x, seg.p1.x, seg.T, t);
  const y = hermite(seg.p0.y, seg.v0.y, seg.p1.y, seg.T, t);
  const accel = (x.v - vel.x) * 60;
  pos = { x: x.p, y: y.p };
  vel = { x: x.v, y: y.v };
  if (Math.abs(vel.x) > 20) facing = vel.x > 0 ? 1 : -1;
  place(pos);
  deps.onMotion({ vel: vel.x, accel, facing });
  if (t < seg.T) return;
  const b = win.getBounds();
  if (Math.abs(b.x - seg.p1.x) <= 2 && Math.abs(b.y - seg.p1.y) <= 2) return finish();
  if (now - seg.start > STUCK_MS) {
    // The OS keeps refusing the move. Jump straight there.
    place(seg.p1);
    pos = { ...seg.p1 };
    deps.say('Ugh, shortcut.');
    finish();
  }
}

export function initDrive(w: BrowserWindow, d: DriveDeps) {
  win = w;
  deps = d;
  [W, H] = w.getSize();
  const b = w.getBounds();
  pos = { x: b.x, y: b.y };
  const onDisplays = () => {
    if (seg) {
      // Monitor added, removed or rescaled mid-drive: re-aim from where we are now.
      seg.p0 = { ...pos };
      seg.v0 = { ...vel };
      seg.p1 = resolveTarget(seg.target);
      seg.T = duration(Math.hypot(seg.p1.x - pos.x, seg.p1.y - pos.y));
      seg.start = Date.now();
    } else if (phase === 'idle') {
      pos = resolveTarget({ kind: 'home' });
      place(pos);
    }
  };
  screen.on('display-added', onDisplays);
  screen.on('display-removed', onDisplays);
  screen.on('display-metrics-changed', onDisplays);
}

export async function driveTo(target: Target): Promise<void> {
  if (seg) {
    // Retarget mid-drive: keep current velocity so the Hermite curve brakes and turns smoothly.
    const keep = { ...vel };
    finish(new Cancelled());
    vel = keep;
  }
  const p1 = resolveTarget(target);
  if (deps.reducedMotion()) {
    // No driving animation: fade out, jump, fade in, 150 ms total.
    for (let o = 1; o >= 0; o -= 0.25) (win.setOpacity(o), await delay(15));
    pos = p1;
    place(pos);
    for (let o = 0; o <= 1; o += 0.25) (win.setOpacity(o), await delay(15));
    return;
  }
  const dist = Math.hypot(p1.x - pos.x, p1.y - pos.y);
  if (dist < 2 && Math.hypot(vel.x, vel.y) < 1) return;
  return new Promise<void>((resolve, reject) => {
    seg = { target, p0: { ...pos }, v0: { ...vel }, p1, T: duration(dist), start: Date.now(), resolve, reject };
    timer ??= setInterval(tick, 1000 / 60);
  });
}

function setPhase(p: Phase) {
  phase = p;
  deps.onPhase(p);
}

export const couchBounds = (): Rectangle => ({ x: Math.round(pos.x), y: Math.round(pos.y), width: W, height: H });

/** Drive out, do `action` (at least 700 ms of working), drive home, park. A newer errand or a drag cancels this one. */
/**
 * Drive out, do `action`, drive home. Returns as soon as the action is done and he has arrived:
 * the trip home runs on its own, so the answer never waits for parking.
 * early = start the action while driving (searches): results don't wait for the couch either.
 * A newer errand or a drag cancels this one.
 */
export async function errand(target: Target, action: () => unknown, early = false): Promise<void> {
  const id = ++errandId;
  const moving = phase === 'driving' || phase === 'returning' || phase === 'departing';
  const live = () => {
    if (id !== errandId) throw new Cancelled();
  };
  let failure: unknown = null;
  let acted = false;
  const act = () =>
    Promise.resolve()
      .then(action)
      .catch((e) => (failure = e))
      .then(() => (acted = true));
  const work = early ? act() : null;
  try {
    if (target.kind !== 'home') {
      if (!moving) {
        setPhase('departing');
        await delay(300);
        live();
      }
      setPhase('driving');
      await driveTo(target);
      live();
      setPhase('arriving');
      await delay(200);
      live();
    }
    setPhase('working');
    await Promise.all([work ?? act(), delay(500)]);
    live();
    if (target.kind !== 'home') void goHome(id);
    else setPhase('idle');
  } catch (e) {
    // Cancelled before the action finished (drag, newer errand): the caller must not report success.
    if (!(e instanceof Cancelled)) {
      setPhase('idle');
      throw e;
    }
    if (work) await work; // a search that already started still finishes
    if (!acted) throw e;
  }
  if (failure) throw failure;
}

async function goHome(id: number) {
  try {
    setPhase('returning');
    await driveTo({ kind: 'home' });
    if (id !== errandId) return;
    setPhase('parking');
    await delay(300);
    if (id === errandId) setPhase('idle');
  } catch {
    // a newer errand took over the couch
  }
}

/** Stop everything where it is (drag start, quit). */
export function cancelAll() {
  errandId++;
  if (seg) finish(new Cancelled());
  if (phase !== 'idle') setPhase('idle');
}

let dragFrom: { mouse: Point; couch: Point } | null = null;

export function dragStart(mouse: Point) {
  cancelAll();
  dragFrom = { mouse, couch: { ...pos } };
}

export function dragMove(mouse: Point) {
  if (!dragFrom) return;
  pos = { x: dragFrom.couch.x + mouse.x - dragFrom.mouse.x, y: dragFrom.couch.y + mouse.y - dragFrom.mouse.y };
  place(pos);
}

/** Snap to the nearest corner of whichever screen the couch was dropped on. Returns the new home. */
export function dragEnd(): { corner: Corner; displayId: number } | null {
  if (!dragFrom) return null;
  dragFrom = null;
  const center = { x: Math.round(pos.x + W / 2), y: Math.round(pos.y + H / 2) };
  const d = screen.getDisplayNearestPoint(center);
  const corner = nearestCorner(d.workArea, center);
  pos = cornerPoint(d.workArea, corner, W, H);
  place(pos);
  return { corner, displayId: d.id };
}

/** Put the couch at home without animation (startup, settings change). */
export function parkHome() {
  pos = resolveTarget({ kind: 'home' });
  place(pos);
}
