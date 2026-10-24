// The real Mastra workflow with suspend/resume; brain, drive and tools are fakes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Step } from '../electron/policy';

vi.mock('electron', () => ({ app: { getPath: () => '.', on: () => undefined }, screen: {} }));
vi.mock('../electron/drive', () => ({
  Cancelled: class extends Error {},
  errand: async (_t: unknown, action: () => unknown) => {
    await action();
  },
}));

const plans: { steps: Step[]; reply: string }[] = [];
vi.mock('../electron/gemma', async (orig) => ({
  ...(await orig<typeof import('../electron/gemma')>()),
  plan: async () => {
    const p = plans.shift()!;
    return { ok: true, plan: { steps: p.steps, clarify: null, reply: p.reply }, ms: 1 };
  },
}));

const calls: { tool: string; args: Record<string, unknown>; prev: unknown }[] = [];
const files = [1, 2, 3].map((n) => ({ id: `r${n}`, kind: 'file', title: `budget ${n}.xlsx`, detail: 'Documents', data: { path: `C:\\x\\budget ${n}.xlsx` } }));
const fp = vi.hoisted(() => ({ size: '10 KB' }));
vi.mock('../electron/tools', () => {
  const rec = (tool: string) => async (args: Record<string, unknown>, ctx: { prev: unknown }) => {
    calls.push({ tool, args, prev: ctx.prev });
    return tool === 'file.search' ? { items: files } : { say: `${tool} done` };
  };
  const tools: Record<string, unknown> = new Proxy({} as Record<string, unknown>, { get: (t, name: string) => t[name] ?? { run: rec(name) } });
  (tools as Record<string, unknown>)['file.copy'] = { run: rec('file.copy'), prepare: async () => ({ action: 'Copy file', source: 'a', dest: 'b', size: fp.size, fingerprint: async () => fp.size }) };
  return { tools };
});
vi.mock('../electron/tools/devices', () => ({ deviceKindOf: () => undefined, kindOf: () => undefined }));
vi.mock('../electron/trace', () => ({ captureError: () => undefined, requestTrace: (_r: unknown, fn: (r: object) => unknown) => fn({}), span: (_n: string, _o: string, fn: () => unknown) => fn() }));
vi.mock('../electron/memory', () => ({ profileSummary: () => '', recordHabit: async () => false }));

const wf = await import('../electron/workflow');
const { rt } = await import('../electron/tools/rt');
rt.settings = () => ({ speakFileNames: false, sendFileNames: false }) as never;
const said: string[] = [];
const confirms: string[] = [];
wf.initWorkflow({
  say: (t) => said.push(t),
  progress: () => undefined,
  thinking: () => undefined,
  idle: () => undefined,
  sulk: () => undefined,
  cards: () => undefined,
  card: () => undefined,
  confirm: (id) => confirms.push(id),
  closeConfirm: () => undefined,
  screenPoint: () => ({ x: 0, y: 0 }),
  showTarget: () => undefined,
  offerShortcut: () => undefined,
});
const tick = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
  calls.length = 0;
  said.length = 0;
  confirms.length = 0;
});

describe('couch-request workflow', () => {
  it('several matches: suspends for a pick; "second" opens the second', async () => {
    plans.push({ steps: [{ tool: 'file.search', args: { keywords: ['budget'], nameHints: [], extensions: [], modifiedAfter: null, modifiedBefore: null, folderHint: null } }], reply: 'Ugh.' });
    await wf.request('find the budget spreadsheet');
    expect(calls.map((c) => c.tool)).toEqual(['file.search']);
    await wf.request('second');
    await tick();
    expect(calls.map((c) => c.tool)).toEqual(['file.search', 'file.open']);
    expect((calls[1].prev as { title: string }).title).toBe('budget 2.xlsx');
  });

  it('unrelated speech during a pick is a new request', async () => {
    plans.push({ steps: [{ tool: 'file.search', args: {} }], reply: 'k' });
    plans.push({ steps: [{ tool: 'note.add', args: { text: 'call the plumber' } }], reply: 'k' });
    await wf.request('find budget');
    await wf.request('take a note call the plumber');
    expect(calls.map((c) => c.tool)).toEqual(['file.search', 'note.add']);
    expect(said).not.toContain('Dropping that one. Doing this instead.'); // no chatter about switching: he just answers
  });

  it('T2 step waits for the confirm; Yes runs it once; a second tap does nothing', async () => {
    plans.push({ steps: [{ tool: 'file.copy', args: { ref: 'r1', dest: 'Desktop' } }], reply: 'k' });
    await wf.request('copy that to my desktop');
    expect(calls).toHaveLength(0);
    expect(confirms).toHaveLength(1);
    wf.answerConfirm(confirms[0], true);
    wf.answerConfirm(confirms[0], true);
    await tick();
    expect(calls.map((c) => c.tool)).toEqual(['file.copy']);
  });

  it('a spoken "yes" never approves; a spoken "no" cancels', async () => {
    plans.push({ steps: [{ tool: 'file.copy', args: { ref: 'r1', dest: 'Desktop' } }], reply: 'k' });
    await wf.request('copy that to my desktop');
    await wf.request('yes');
    await tick();
    expect(calls).toHaveLength(0);
    expect(said).toContain('Tap Yes on the sheet. Rules.');
    await wf.request('no');
    await tick();
    wf.answerConfirm(confirms[0], true); // a late tap after the No does nothing
    await tick();
    expect(calls).toHaveLength(0);
  });

  it('No means nothing runs', async () => {
    plans.push({ steps: [{ tool: 'file.copy', args: { ref: 'r1', dest: 'Desktop' } }], reply: 'k' });
    await wf.request('copy that to my desktop');
    wf.answerConfirm(confirms[0], false);
    await tick();
    expect(calls).toHaveLength(0);
  });

  it('file changed between plan and confirm: asks again instead of running', async () => {
    fp.size = '10 KB';
    plans.push({ steps: [{ tool: 'file.copy', args: { ref: 'r1', dest: 'Desktop' } }], reply: 'k' });
    await wf.request('copy that to my desktop');
    fp.size = '99 KB';
    wf.answerConfirm(confirms[0], true);
    await tick();
    expect(calls).toHaveLength(0);
    expect(confirms).toHaveLength(2);
    wf.answerConfirm(confirms[1], true);
    await tick();
    expect(calls.map((c) => c.tool)).toEqual(['file.copy']);
  });
});
