// Timers and schedules, persisted in userData/schedules.json. They survive restarts; overdue ones fire at once.
import { Notification } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkScheduledStep, type Step } from '../policy';
import { line } from '../persona';
import { fmtDate, ids, rt, ToolError, type Tool } from './rt';

type Entry = { id: string; label: string; at: number; repeat: 'none' | 'daily' | 'weekdays'; step: Step | null };
let entries: Entry[] = [];
const file = () => join(rt.userData, 'schedules.json');
const save = () => writeFileSync(file(), JSON.stringify(entries));

function next(e: Entry): number | null {
  if (e.repeat === 'none') return null;
  const d = new Date(e.at);
  do d.setDate(d.getDate() + 1);
  while (e.repeat === 'weekdays' && (d.getDay() === 0 || d.getDay() === 6));
  return d.getTime() < Date.now() ? next({ ...e, at: d.getTime() }) : d.getTime();
}

async function fire(e: Entry, late: boolean) {
  const note = late ? ' (late: I was off)' : '';
  new Notification({ title: 'Couch', body: `${e.label}${note}` }).show();
  rt.say(e.step ? line('schedule-fire') : `Reminder: ${e.label}.${late ? ' Late, sorry.' : ''}`);
  if (e.step) {
    // Re-check at fire time: a schedule may only ever run T0/T1 steps.
    if (checkScheduledStep(e.step)) return rt.say('That scheduled thing needs a yes now. Skipped it.');
    await rt.runScheduled(e.step, e.label).catch(() => undefined);
  }
}

function tick() {
  const now = Date.now();
  const due = entries.filter((e) => e.at <= now);
  if (!due.length) return;
  for (const e of due) {
    const n = next(e);
    if (n) e.at = n;
    else entries = entries.filter((x) => x !== e);
    void fire(e, now - e.at > 60_000 && !n);
  }
  save();
}

export function startSchedules() {
  try {
    entries = JSON.parse(readFileSync(file(), 'utf8')) as Entry[];
  } catch {
    entries = [];
  }
  // Overdue after a restart: fire immediately, with a note.
  const now = Date.now();
  for (const e of entries.filter((x) => x.at <= now)) {
    const n = next(e);
    void fire(e, true);
    if (n) e.at = n;
    else entries = entries.filter((x) => x !== e);
  }
  save();
  setInterval(tick, 5000).unref();
}

function add(label: string, at: number, repeat: Entry['repeat'], step: Step | null) {
  const e = { id: randomUUID(), label, at, repeat, step };
  entries.push(e);
  save();
  return e;
}

const when = (ms: number) => {
  const mins = Math.round((ms - Date.now()) / 60_000);
  return mins < 60 ? `in ${mins} minute${mins === 1 ? '' : 's'}` : `${fmtDate(ms)} ${new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
};

export const listSchedules = () => [...entries].sort((x, y) => x.at - y.at).map((e) => ({ id: e.id, label: `${e.label} (${when(e.at)})` }));
export function cancelSchedule(id: string) {
  entries = entries.filter((e) => e.id !== id);
  save();
}

export const scheduleTools: Record<string, Tool<any>> = {
  'timer.set': {
    async run(a: { minutes: number; label: string }) {
      const e = add(a.label, Date.now() + a.minutes * 60_000, 'none', null);
      return { say: `Fine. I'll bug you ${when(e.at)}.` };
    },
  },
  'schedule.add': {
    async run(a: { at?: string; inMinutes?: number; repeat: Entry['repeat']; label: string; step: Step | null }) {
      // Refused at schedule time if the step would need a confirm (T2) or is not a valid catalog step.
      if (checkScheduledStep(a.step)) throw new ToolError("I can't schedule that. It needs a yes every time.", 'refuse');
      const at = a.inMinutes ? Date.now() + a.inMinutes * 60_000 : new Date(String(a.at)).getTime();
      if (!Number.isFinite(at)) throw new ToolError("That time doesn't make sense.", 'clarify');
      const e = add(a.label, at <= Date.now() && a.repeat !== 'none' ? (next({ id: '', label: '', at, repeat: a.repeat, step: null }) ?? at) : at, a.repeat, a.step);
      return { say: `Scheduled ${when(e.at)}${a.repeat !== 'none' ? `, ${a.repeat}` : ''}.` };
    },
  },
  'schedule.list': {
    async run() {
      if (!entries.length) return { say: 'Nothing scheduled. Bliss.' };
      const items = ids([...entries].sort((x, y) => x.at - y.at).map((e) => ({ kind: 'schedule' as const, title: e.label, detail: `${when(e.at)}${e.repeat !== 'none' ? ` · ${e.repeat}` : ''}`, data: { id: e.id } })));
      return { items, say: `${entries.length} thing${entries.length === 1 ? '' : 's'} on the list.`, chosen: items[0] };
    },
  },
  'schedule.cancel': {
    async run(a: { label?: string }) {
      const words = (a.label ?? '').toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !['timer', 'reminder', 'schedule', 'the'].includes(w));
      const pool = words.length ? entries.filter((e) => words.some((w) => e.label.toLowerCase().includes(w))) : entries;
      const victim = [...pool].sort((x, y) => y.at - x.at)[0];
      if (!victim) throw new ToolError(entries.length ? 'No timer like that.' : 'No timer to cancel.', 'refuse');
      entries = entries.filter((e) => e !== victim);
      save();
      return { say: `Cancelled "${victim.label}".` };
    },
  },
};
