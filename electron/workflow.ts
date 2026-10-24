// Mastra workflow `couch-request`: listen, stall, plan, check, then up to 4 slots of
// confirm (suspend) -> run -> pick (suspend), then respond, remember.
// Slot 4 exists only for the follow-up a pick implies ("second" opens the second file).
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as drive from './drive';
import { BrainError, getProvider, plan, TAG_SIZES, ollamaTag } from './gemma';
import { profileSummary, recordHabit } from './memory';
import { captureError, requestTrace, span, type TraceRef } from './trace';
import { judgeTone, line, smallTalk, type LineKind, type Tone } from './persona';
import { addOpen, asksForScreen, parseQuickPower, quickSteps, catalog, createConfirm, isRef, judgeStep, parsePick, routeDim, takeConfirm, type Step } from './policy';
import { listDevices, resolveDevice } from './devices/registry';
import { kindOf, noDeviceLine } from './tools/devices';
import { tools } from './tools';
import { rt, ToolError, type ConfirmInfo, type Ctx as ToolCtx, type Item, type Outcome } from './tools/rt';
import { isNoise } from './voice';

export interface UI {
  say(text: string): void;
  progress(text: string): void;
  thinking(): void;
  idle(): void;
  sulk(): void;
  cards(items: Item[], picking: boolean): void;
  card(title: string, body: string): void;
  confirm(id: string, info: { action: string; source: string; dest: string; size: string; image?: string }): void;
  closeConfirm(): void;
  screenPoint(): { x: number; y: number };
  showTarget(t: drive.Target): void;
  /** A habit crossed 3 uses on 2+ days: offer the last T0/T1 step as a tray shortcut. Never run it automatically. */
  offerShortcut(step: Step): void;
}

const SLOTS = 4;
const PICK_MS = 60_000;
const CONFIRM_MS = 60_000;

const State = z.object({
  requestId: z.string(),
  text: z.string(),
  stalled: z.boolean(),
  steps: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) })),
  modes: z.array(z.string()),
  reply: z.string(),
  lines: z.array(z.string()),
  kind: z.string().nullable(), // line bank for the final line when no explicit line
  stop: z.boolean(),
  failed: z.boolean(),
  items: z.array(z.any()),
  prev: z.any(),
  chosen: z.boolean(),
  preset: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) })).nullable(),
  ran: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) })),
});
type S = z.infer<typeof State>;

let ui: UI;
let lastResults: Item[] = [];
export const lastItems = () => lastResults;
const turns: { user: string; reply: string }[] = [];
const stallTimers = new Map<string, NodeJS.Timeout>();

type Current = { requestId: string; abort: AbortController; trace: TraceRef | null; run: { resume: Function; cancel: () => Promise<void> } };
let current: Current | null = null;
type Pending = { kind: 'pick'; step: string; items: Item[]; timer: NodeJS.Timeout } | { kind: 'confirm'; step: string; timer: NodeJS.Timeout };
let pending: Pending | null = null;
const tone: Tone = { strikes: 0, since: 0 };
let seq = 0; // newest request wins, even while an older one is still being cancelled
const signals = new Map<string, AbortSignal>(); // requestId -> that run's own cancel signal
const sig = (requestId: string) => signals.get(requestId) ?? AbortSignal.abort();
let sheetId = ''; // the confirm sheet on screen right now; taps on any older sheet are ignored

const toolCtx = (s: S, signal: AbortSignal): ToolCtx => ({ requestId: s.requestId, userText: s.text, signal, prev: (s.prev as Item) ?? null, last: lastResults });

function targetFor(step: Step, ctx: ToolCtx): drive.Target | null {
  const t = tools[step.tool];
  if (t.target) return t.target(step.args, ctx);
  // He only moves for something you can see him go to: the video player, or a device tile on the open panel.
  // Searches, files, timers and answers happen from the couch.
  return catalog[step.tool].anchor === 'playerWindow' && drive.targetVisible({ kind: 'playerWindow' }) ? { kind: 'playerWindow' } : null;
}

const brainLine = (e: BrainError): string =>
  ({
    'not-installed': "My brain's offline. Install Ollama from ollama.com, then ask again.",
    'not-running': "My brain's offline. Start Ollama and try again.",
    'model-missing': `My brain isn't downloaded. Tray, Brain, Download (${TAG_SIZES[ollamaTag()] ?? 'a few GB'}).`,
    oom: `Not enough memory for this brain.${e.hint ? ` Try GEMMA_MODEL=${e.hint}.` : ''}`,
    timeout: 'Thought for a whole minute. Gave up.',
    cancelled: '',
    'no-key': 'Cloud brain needs a Gemini key. Or switch back to local.',
    'rate-limit': 'Cloud brain says slow down. Give it a minute.',
    http: "My brain's acting up. Try again.",
  })[e.problem];

/** Run one catalog step, driving to its anchor through errand(). Returns the tool outcome. */
async function exec(step: Step, ctx: ToolCtx): Promise<Outcome> {
  const tool = tools[step.tool];
  const target = targetFor(step, ctx);
  const run = () => span(step.tool, 'tool', () => tool.run(step.args, ctx));
  if (!target) return run();
  ui.showTarget(target);
  let out: Outcome = {};
  await span('drive', 'drive', () =>
    drive.errand(
      target,
      async () => {
        out = await run();
      },
      catalog[step.tool].tier === 0, // read-only: start it while he drives
    ),
  );
  return out;
}

function absorb(s: S, out: Outcome): S {
  const lines = [...s.lines, ...(out.say ? [out.say] : [])];
  if (out.card) ui.card(out.card.title, out.card.body);
  const items = out.items ?? [];
  if (out.items) {
    lastResults = items;
    ui.cards(items, items.length > 1 && !out.chosen);
  }
  const prev = out.chosen ?? (items.length === 1 ? items[0] : out.items ? null : s.prev);
  const found: LineKind | undefined = out.items && !out.say && items.length && (out.chosen || items.length === 1) ? 'done' : undefined;
  return { ...s, lines, items, prev, chosen: Boolean(out.chosen) || items.length === 1, kind: out.sayKind ?? found ?? s.kind, failed: s.failed || Boolean(out.failed), stop: s.stop || Boolean(out.failed) };
}

function stopWith(s: S, text: string, kind: LineKind | null = null): S {
  return { ...s, stop: true, lines: text ? [...s.lines, text] : s.lines, kind };
}

/** Default follow-up when a pick ends the plan: open a file/link, play media, launch an app, or the device step that waited. */
function followUp(it: Item): Step | null {
  if (it.then) return it.then;
  const map: Partial<Record<Item['kind'], Step['tool']>> = { file: 'file.open', link: 'web.open', video: 'media.play', song: 'media.play' };
  const tool = map[it.kind];
  return tool ? { tool, args: { ref: '$prev' } } : null;
}

/** Replies never speak file names unless "speak file names" is on: the names stay on the cards. */
export function hideFileNames(text: string, items: Item[]): string {
  let out = text;
  for (const it of items) {
    if (it.kind !== 'file') continue;
    const stem = it.title.replace(/\.[^.]+$/, '');
    for (const n of /[^a-z]/i.test(stem) ? [it.title, stem] : [it.title]) if (n.length >= 3) out = out.replace(new RegExp(`(?<![\\w.])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'gi'), 'that file');
  }
  return out;
}

// ---------- steps ----------

const listen = createStep({
  id: 'listen',
  inputSchema: z.object({ requestId: z.string(), text: z.string(), stalled: z.boolean(), preset: State.shape.preset }),
  outputSchema: State,
  execute: async ({ inputData: i }) => {
    const s: S = { ...i, steps: [], modes: [], reply: '', lines: [], kind: null, stop: false, failed: false, items: [], prev: null, chosen: false, ran: [] };
    if (i.preset) return s; // tray action: no speech involved
    return isNoise(i.text) ? stopWith(s, '', 'huh') : s;
  },
});

const stall = createStep({
  id: 'stall',
  inputSchema: State,
  outputSchema: State,
  execute: async ({ inputData: s }) => {
    // "Hang on" only when the brain is actually slow: a quick answer gets one line, not two cutting each other off.
    // No "on it" line: he answers when he has the answer. Only a really slow brain gets one short note.
    if (!s.stop && !s.stalled && !s.preset) stallTimers.set(s.requestId, setTimeout(() => ui.say(line('stall')), 6000));
    if (!s.stop) ui.thinking();
    return s;
  },
});

const planStep = createStep({
  id: 'plan',
  inputSchema: State,
  outputSchema: State,
  execute: async ({ inputData: s }) => {
    if (s.stop) return s;
    if (s.preset) return { ...s, steps: s.preset };
    // Cloud brain: file names leave only if the user turned on "send file names to the AI".
    const hideNames = getProvider() === 'gemini' && !rt.settings().sendFileNames;
    try {
      const out = await plan({
        text: s.text,
        turns,
        profile: profileSummary(),
        lastResults: lastResults.map((r) => ({ id: r.id, label: hideNames && r.kind === 'file' ? 'file (name not shared)' : `${r.kind}: ${r.title} (${r.detail})` })),
        devices: listDevices().map((d) => d.name),
        signal: sig(s.requestId),
        onSlow: () => ui.progress('Still thinking. Slowly.'),
      });
      clearTimeout(stallTimers.get(s.requestId));
      stallTimers.delete(s.requestId);
      console.log(`[couch] plan ${out.ok ? 'ok' : 'invalid'} in ${out.ms} ms`); // timing only, never the text
      if (!out.ok) return stopWith(s, "I didn't catch that.");
      if (out.plan.clarify) return stopWith(s, out.plan.clarify, 'clarify');
      const lights = listDevices().filter((d) => d.kind === 'light').map((d) => d.name);
      return { ...s, steps: addOpen(routeDim(out.plan.steps, s.text, lights), s.text), reply: out.plan.reply };
    } catch (e) {
      if (e instanceof BrainError) return e.problem === 'cancelled' ? { ...s, stop: true } : { ...stopWith(s, brainLine(e)), failed: true };
      throw e;
    }
  },
});

const check = createStep({
  id: 'check',
  inputSchema: State,
  outputSchema: State,
  execute: async ({ inputData: s }) => {
    if (s.stop) return s;
    const modes: string[] = [];
    for (const step of s.steps as Step[]) {
      const v = judgeStep(step, { userText: s.text, deviceKind: kindOf(step) });
      if (v.mode === 'refuse') return stopWith(s, v.reason.startsWith('schedule') ? "I can't schedule that. It needs a yes every time." : line('refuse'));
      modes.push(v.mode);
    }
    return { ...s, modes };
  },
});

function slot(i: number) {
  const confirm = createStep({
    id: `confirm-${i}`,
    inputSchema: State,
    outputSchema: State,
    resumeSchema: z.object({ yes: z.boolean() }),
    suspendSchema: z.object({ id: z.string() }),
    execute: async ({ inputData: s, resumeData, suspend, suspendData }) => {
      if (s.stop || i >= s.steps.length || s.modes[i] !== 'confirm') return s;
      const step = s.steps[i] as Step;
      const ctx = toolCtx(s, sig(s.requestId));
      let info: ConfirmInfo;
      try {
        info = tools[step.tool].prepare
          ? await tools[step.tool].prepare!(step.args, ctx)
          : step.tool === 'web.find'
            ? { action: 'Search a site I do not know', source: String(step.args.site), dest: 'SerpApi + cloud browser', size: '-', fingerprint: async () => String(step.args.site) }
            : { action: step.tool, source: '-', dest: '-', size: '-', fingerprint: async () => JSON.stringify(step.args) };
      } catch (e) {
        if (e instanceof ToolError) return stopWith(s, e.line, e.kind);
        throw e;
      }
      if (resumeData && suspendData) {
        const why = resumeData.yes ? takeConfirm(suspendData.id, s.requestId, await info.fingerprint()) : 'no';
        if (why === null) return s;
        if (why !== 'changed') return stopWith(s, why === 'expired' ? 'Too slow. Took that as a no.' : '', 'cancel');
        ui.say('Something changed since. Look again.'); // edge 45: ask again with fresh details
      }
      const id = randomUUID();
      createConfirm(id, s.requestId, await info.fingerprint());
      sheetId = id;
      ui.confirm(id, { action: info.action, source: info.source, dest: info.dest, size: info.size, image: info.image });
      ui.say(line('confirm-ask'));
      return suspend({ id });
    },
  });

  const run = createStep({
    id: `run-${i}`,
    inputSchema: State,
    outputSchema: State,
    execute: async ({ inputData: s }) => {
      if (s.stop || i >= s.steps.length) return s;
      const step = s.steps[i] as Step;
      try {
        const out = absorb({ ...s, chosen: false }, await exec(step, toolCtx(s, sig(s.requestId))));
        return out.failed ? out : { ...out, ran: [...s.ran, step] };
      } catch (e) {
        if (e instanceof drive.Cancelled) return { ...s, stop: true };
        if (e instanceof ToolError) return { ...stopWith(s, e.line, e.kind), failed: e.kind === 'error' || e.kind === 'device-fail' || e.kind === 'device-offline' };
        if (e instanceof BrainError) return e.problem === 'cancelled' ? { ...s, stop: true } : { ...stopWith(s, brainLine(e)), failed: true };
        console.error('[couch] tool failed:', step.tool, e instanceof Error ? e.name : 'unknown');
        captureError(e); // scrubbed to the error type in trace.ts
        return { ...stopWith(s, line('error')), failed: true };
      }
    },
  });

  const pick = createStep({
    id: `pick-${i}`,
    inputSchema: State,
    outputSchema: State,
    resumeSchema: z.object({ index: z.number().int() }),
    suspendSchema: z.object({ count: z.number() }),
    execute: async ({ inputData: s, resumeData, suspend }) => {
      if (s.stop || i >= s.steps.length || s.chosen || s.items.length < 2) return s;
      const next = s.steps[i + 1] as Step | undefined;
      const needs = next ? Object.values(next.args).includes('$prev') : true;
      if (!needs) return s;
      if (!resumeData) {
        ui.say(line('pick-ask'));
        return suspend({ count: s.items.length });
      }
      if (resumeData.index < 0) return stopWith(s, resumeData.index === -2 ? 'Nobody picked. Moving on.' : '', 'cancel');
      const it = s.items[resumeData.index] as Item;
      let steps = s.steps;
      let modes = s.modes;
      const follow = next ? null : followUp(it);
      if (follow) {
        const v = judgeStep(follow, { userText: s.text, deviceKind: kindOf(follow) });
        if (v.mode === 'refuse') return stopWith(s, line('refuse'));
        steps = [...steps, follow];
        modes = [...modes, v.mode];
      }
      return { ...s, prev: it, chosen: true, steps, modes };
    },
  });
  return [confirm, run, pick] as const;
}

/** One result chosen: say what it is and what happened to it, in a few words. */
function foundLine(s: S): string | null {
  const it = s.prev;
  if (!it || !s.chosen) return null;
  const t = it.title.length > 40 ? `${it.title.slice(0, 38)}…` : it.title;
  const did = (tool: string) => s.ran.some((r) => r.tool === tool);
  if (did('media.play')) return `Playing ${t}. Enjoy.`;
  if (did('file.open') || did('web.open')) return `Opened ${t}.`;
  if (did('file.read') || did('web.read')) return null; // the answer is the line
  return `Found ${t}. It's in the popup.`;
}

const respond = createStep({
  id: 'respond',
  inputSchema: State,
  outputSchema: State,
  execute: async ({ inputData: s }) => {
    if (s.stop && !s.lines.length && !s.kind) return s; // cancelled by a newer request: that one talks
    const last = s.lines.at(-1);
    // Order: what a tool said > the plan's reply on a plain success or chat > the tool's line bank > "done".
    const kindLine = s.kind ? line(s.kind as LineKind) : '';
    // A plain success says the plan's own line ("Lamp's off. My arm hurts."): it names the thing, a bank line can't.
    clearTimeout(stallTimers.get(s.requestId));
    stallTimers.delete(s.requestId);
    const plainDone = !s.kind || s.kind === 'done' || s.kind === 'device-ok';
    const raw = s.failed || s.stop ? (last ?? kindLine) : (last ?? foundLine(s) ?? ((plainDone && s.reply) || kindLine || line('done')));
    const text = rt.settings().speakFileNames ? raw : hideFileNames(raw, lastResults);
    if (text) ui.say(text);
    if (s.failed) ui.sulk();
    else ui.idle();
    return { ...s, reply: text };
  },
});

const remember = createStep({
  id: 'remember',
  inputSchema: State,
  outputSchema: State,
  execute: async ({ inputData: s }) => {
    // Local, in-memory turn history for "the second one"/"move it". Profile/habits (MongoDB) arrive in a later build.
    if (!isNoise(s.text)) turns.push({ user: s.text.slice(0, 300), reply: s.reply.slice(0, 200) });
    if (turns.length > 5) turns.shift();
    // Habits: tool names only go to memory. A shortcut is only offered for a step that runs without a confirm or a ref.
    for (const st of s.ran as Step[]) {
      const offer = await recordHabit(st.tool);
      const plain = !Object.values(st.args).some(isRef);
      if (offer && plain && judgeStep(st, { userText: '', deviceKind: kindOf(st) }).mode === 'auto') ui.offerShortcut(st);
    }
    return s;
  },
});

let wf: ReturnType<typeof build>;
let mastra: Mastra;

/** One span per step. Skipped slots (nothing to do) still show up, with near-zero duration. */
function traced<T extends { id: string; execute: (p: any) => any }>(st: T): T {
  const inner = st.execute;
  st.execute = (p: unknown) => span(st.id, 'step', async () => inner(p));
  return st;
}

function build() {
  let w = createWorkflow({ id: 'couch-request', inputSchema: listen.inputSchema, outputSchema: State })
    .then(traced(listen))
    .then(traced(stall))
    .then(traced(planStep))
    .then(traced(check));
  for (let i = 0; i < SLOTS; i++) for (const st of slot(i)) w = w.then(traced(st));
  return w.then(traced(respond)).then(traced(remember)).commit();
}

export function initWorkflow(deps: UI) {
  ui = deps;
  wf = build();
  // In-memory storage: suspended picks and confirms never survive a restart (edge 44).
  mastra = new Mastra({ workflows: { 'couch-request': wf }, storage: new InMemoryStore(), logger: false });
}

function clearPending() {
  if (!pending) return;
  clearTimeout(pending.timer);
  if (pending.kind === 'confirm') ui.closeConfirm();
  pending = null;
}

async function settle(requestId: string, result: { status: string; suspended?: string[][]; error?: Error }) {
  if (current?.requestId !== requestId) return;
  if (result.status === 'suspended') {
    const step = result.suspended?.[0]?.at(-1) ?? '';
    if (step.startsWith('pick-')) {
      const timer = setTimeout(() => void answerPick(-2), PICK_MS);
      pending = { kind: 'pick', step, items: lastResults, timer };
    } else if (step.startsWith('confirm-')) {
      const timer = setTimeout(() => void resume({ yes: false }), CONFIRM_MS);
      pending = { kind: 'confirm', step, timer };
    }
    ui.idle();
    return;
  }
  if (result.status === 'failed') {
    console.error('[couch] workflow failed:', result.error?.name ?? 'unknown');
    ui.say(line('error'));
    ui.sulk();
  }
  signals.delete(requestId);
  current = null;
  void mastra.getWorkflow('couch-request').deleteWorkflowRunById(requestId).catch(() => undefined); // no snapshots piling up in RAM
}

async function resume(data: { yes: boolean } | { index: number }) {
  const c = current;
  const p = pending;
  if (!c || !p) return;
  clearPending();
  ui.thinking();
  const r = (await requestTrace(c.trace, () => c.run.resume({ step: p.step, resumeData: data })).catch((e: Error) => ({ status: 'failed', error: e }))) as { status: string; suspended?: string[][]; error?: Error };
  await settle(c.requestId, r);
}

/** Card click or "second"/"none". -1 = none, -2 = timed out. */
export function answerPick(index: number) {
  if (pending?.kind !== 'pick') return;
  if (index >= pending.items.length) return;
  void resume({ index });
}

/** Confirm sheet tap. Ids are checked again inside the step (single use, bound to this request, 60 s). */
export function answerConfirm(id: string, yes: boolean) {
  if (pending?.kind !== 'confirm' || id !== sheetId) return;
  void resume({ yes });
}

/** A new request. While a pick is open, "second"/"none" answers it; anything else cancels the old request and starts fresh. */
export async function request(text: string, stalled = false, preset: Step[] | null = null) {
  if (!preset) {
    const v = judgeTone(text, tone);
    if (v.kind === 'refuse' || v.kind === 'apology' || v.kind === 'thanks') {
      ui.say(v.line);
      return ui.idle();
    }
    if (v.kind === 'warn') ui.say(v.line); // complains, then does it anyway
  }
  if (pending?.kind === 'confirm' && !preset) {
    const t = text.toLowerCase().replace(/[^a-z\s]/g, '').trim();
    // A spoken "no" counts. A spoken "yes" does not: a Yes is always a tap, so a voice in the room can't approve a change.
    if (/^(no|nope|cancel|stop|dont|never ?mind)( thanks)?$/.test(t)) return void resume({ yes: false });
    if (/^(yes|yeah|yep|ok|okay|sure|do it|go|confirm)( please)?$/.test(t)) {
      ui.say('Tap Yes on the sheet. Rules.');
      return ui.idle();
    }
  }
  if (pending?.kind === 'pick' && !preset) {
    const p = parsePick(text, pending.items);
    if (p !== null) return answerPick(p === 'none' ? -1 : p);
  }
  if (!preset && !pending) {
    // Chit-chat and plain on/off are answered here: instant, and no brain call for "hey, what's up".
    const chat = smallTalk(text);
    if (chat) {
      ui.say(chat);
      turns.push({ user: text.slice(0, 300), reply: chat });
      if (turns.length > 5) turns.shift();
      return ui.idle();
    }
    // "summarize my screen": skip the planning call, the question is the user's own words.
    if (asksForScreen(text) && text.length < 200 && !/\b(dim|undim|brightness|bright|brighten|brighter|dark|darken|darker|restore)\b/i.test(text)) preset = [{ tool: 'screen.look', args: { question: text } }];
    preset ??= quickSteps(text);
    const quick = preset ? null : parseQuickPower(text);
    const r = quick && resolveDevice(quick.device);
    if (quick && r && (r.kind === 'one' || r.kind === 'group')) {
      const device = r.kind === 'one' ? r.device.name : quick.device;
      if ((r.kind === 'one' ? r.device.capabilities : r.devices[0].capabilities).includes('power'))
        preset = [{ tool: 'device.set', args: { device, capability: 'power', value: quick.on } }];
    }
    // "close the light" with no light: answer now instead of a slow brain call that ends in "don't know that one".
    if (quick && r?.kind === 'unknown' && /\b(lights?|lamps?|bulbs?|leds?|led lights?|fans?|ac|tv|plugs?|heater)\b/.test(quick.device)) {
      const say = noDeviceLine(quick.device);
      ui.say(say);
      turns.push({ user: text.slice(0, 300), reply: say });
      if (turns.length > 5) turns.shift();
      return ui.idle();
    }
  }
  const mine = ++seq;
  if (current) {
    const old = current;
    current = null;
    clearPending();
    old.abort.abort();

    await old.run.cancel().catch(() => undefined);
  }
  const requestId = randomUUID();
  const abort = new AbortController();
  signals.set(requestId, abort.signal);
  const run = await mastra.getWorkflow('couch-request').createRun({ runId: requestId });
  if (mine !== seq) return void signals.delete(requestId); // an even newer request arrived while this one was starting
  const cur: Current = { requestId, abort, trace: null, run: run as unknown as Current['run'] };
  current = cur;
  const r = await requestTrace(null, (ref) => {
    cur.trace = ref;
    return run.start({ inputData: { requestId, text, stalled, preset } });
  }).catch((e: Error) => ({ status: 'failed', error: e }));
  await settle(requestId, r as { status: string; suspended?: string[][] });
}

/** A schedule fired: T0/T1 only, re-judged now, then the couch drives to it like any other errand. */
export async function runScheduled(step: Step, label: string) {
  const v = judgeStep(step, { userText: label, deviceKind: kindOf(step) });
  if (v.mode !== 'auto') return ui.say("That scheduled thing needs a yes now. Skipped it.");
  try {
    const out = await requestTrace(null, () => exec(step, { requestId: randomUUID(), userText: label, signal: new AbortController().signal, prev: null, last: [] }));
    ui.say(out.say ?? line(out.sayKind ?? 'done'));
    if (out.failed) ui.sulk();
  } catch (e) {
    if (e instanceof drive.Cancelled) return;
    ui.say(e instanceof ToolError ? e.line : line('error'));
    ui.sulk();
  }
}
