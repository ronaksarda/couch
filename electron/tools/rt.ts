// Shared runtime for tools: result items, outcomes, confirm info, and the few app hooks tools need.
import type { Target } from '../drive';
import type { LineKind } from '../persona';
import type { Settings } from '../settings';
import { isRef, type Step } from '../policy';

export type ItemKind = 'file' | 'link' | 'video' | 'song' | 'device' | 'found' | 'schedule' | 'app';

/** One entry of a result set. Labels are untrusted data (file names, page titles, video titles, device names). */
export interface Item {
  id: string; // r1..r5
  kind: ItemKind;
  title: string;
  detail: string;
  snippet?: string;
  cloud?: boolean;
  data: Record<string, unknown>;
  /** What picking this item does when nothing else follows (e.g. the device step that was waiting on a name). */
  then?: Step;
}

export interface Outcome {
  items?: Item[];
  /** A clear winner among items: no pick needed. */
  chosen?: Item;
  say?: string;
  sayKind?: LineKind;
  card?: { title: string; body: string };
  failed?: boolean;
}

export interface ConfirmInfo {
  action: string;
  source: string;
  dest: string;
  size: string;
  /** Optional preview (data URL) shown on the sheet: the screenshot that would be sent. */
  image?: string;
  /** Paths, sizes, targets as of now. Recomputed at confirm time; any change means ask again. */
  fingerprint: () => Promise<string>;
}

export interface Ctx {
  requestId: string;
  userText: string;
  signal: AbortSignal;
  prev: Item | null;
  last: Item[];
}

export class ToolError extends Error {
  constructor(readonly line: string, readonly kind: LineKind = 'error') {
    super(line);
  }
}

export interface Tool<A = Record<string, unknown>> {
  run(args: A, ctx: Ctx): Promise<Outcome>;
  prepare?(args: A, ctx: Ctx): Promise<ConfirmInfo>;
  target?(args: A, ctx: Ctx): Target | null;
}

export const rt = {
  userData: '',
  settings: (): Settings => {
    throw new Error('rt not ready');
  },
  say: (_text: string) => undefined as void,
  progress: (_text: string) => undefined as void,
  /** Keep the couch above overlays it created. */
  raise: () => undefined as void,
  /** Put the results popup away (a video started: the popup would only cover it). */
  hideResults: () => undefined as void,
  /** Run a T0/T1 step that a schedule fired (the couch drives to it). */
  runScheduled: async (_step: Step, _label: string) => undefined as void,
};

export function ref(r: unknown, ctx: Ctx): Item {
  const it = r === '$prev' ? ctx.prev : isRef(r) ? ctx.last[Number(String(r).slice(1)) - 1] : undefined;
  if (!it) throw new ToolError('Which one? I lost track.', 'clarify');
  return it;
}

export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`);
export const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
export const ids = <T extends Omit<Item, 'id'>>(xs: T[]): (T & { id: string })[] => xs.slice(0, 5).map((x, i) => ({ ...x, id: `r${i + 1}` }));
