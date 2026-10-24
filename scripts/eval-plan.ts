// Plan eval: 20 realistic requests through the configured brain. Logs valid-plan count, tool match and time-to-plan.
// Run: npx tsx scripts/eval-plan.ts   (Ollama running, GEMMA_MODEL set or the default tag pulled)
// Build-order rule (PRD 13.3): fewer than 17 correct plans means a larger tag or a tighter prompt.
import { config } from 'dotenv';
import { cpus, totalmem } from 'node:os';
import { getProvider, ollamaTag, plan, setProvider } from '../electron/gemma';
import { SIM_DEVICES } from '../electron/devices/registry';

config({ quiet: true });
if (process.env.GEMMA_PROVIDER === 'gemini') setProvider('gemini');

const lastResults = [
  { id: 'r1', label: 'file: lease-2026.pdf (Downloads · Sep 12, 2026)' },
  { id: 'r2', label: 'file: Q3 budget v2.xlsx (Documents · Oct 1, 2026)' },
];
const devices = SIM_DEVICES.map((d) => d.name);

// [request, first tool expected (null = chat/clarify, no steps)]
const CASES: [string, string | null][] = [
  ['Find the lease PDF I downloaded last month', 'file.search'],
  ['Open my resume', 'file.search'],
  ['Find that spreadsheet about Q3 budget', 'file.search'],
  ['What does the contract in Downloads say about the notice period?', 'file.search'],
  ['Copy the second one to my Desktop', 'file.copy'],
  ['Find the cheapest USB-C cable on amazon', 'web.find'],
  ['Find the pricing page on stripe', 'web.find'],
  ['Play I Want It That Way', 'media.search'],
  ['Play something funny about cats', 'media.search'],
  ['Dim the screen, my eyes hurt', 'screen.dim'],
  ['Open Spotify', 'app.launch'],
  ['Remind me in 20 minutes to stretch', 'timer.set'],
  ['Take a note: call the plumber', 'note.add'],
  ['How many legs does a spider have?', null],
  ['Turn off the lamp', 'device.set'],
  ['Set the AC to 21 degrees', 'device.set'],
  ['Is the front door locked?', 'device.status'],
  ['Close the blinds halfway', 'device.set'],
  ['Turn the TV volume down to 10', 'device.set'],
  ['Every weekday at 7am turn on the ceiling light', 'schedule.add'],
];

async function main() {
  console.log(`brain: ${getProvider()} ${getProvider() === 'ollama' ? ollamaTag() : process.env.GEMINI_MODEL || '(newest gemma)'} | ${cpus()[0]?.model} x${cpus().length} | ${(totalmem() / 2 ** 30).toFixed(0)} GB RAM`);
  let valid = 0;
  let right = 0;
  const times: number[] = [];
  for (const [text, want] of CASES) {
    // Free Gemini tier: 16k input tokens a minute. Pace the eval so it measures planning, not the quota.
    if (getProvider() === 'gemini') await new Promise((r) => setTimeout(r, 6000));
    const t0 = Date.now();
    try {
      const r = await plan({ text, lastResults, devices, now: new Date() });
      const ms = Date.now() - t0;
      times.push(ms);
      const got = r.ok ? (r.plan.steps[0]?.tool ?? null) : 'INVALID';
      if (r.ok) valid++;
      if (got === want) right++;
      console.log(`${got === want ? 'ok  ' : 'MISS'} ${String(ms).padStart(6)} ms  want=${want ?? 'chat'} got=${got}  "${text}"`);
    } catch (e) {
      times.push(Date.now() - t0);
      console.log(`ERR  ${(e as Error).message} ${(e as { hint?: string }).hint ?? ''}  "${text}"`);
    }
  }
  times.sort((a, b) => a - b);
  const p = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))];
  console.log(`\nvalid plans: ${valid}/${CASES.length}  first tool correct: ${right}/${CASES.length}  time-to-plan p50=${p(0.5)} ms p90=${p(0.9)} ms max=${times.at(-1)} ms`);
  if (right < 17) console.log('Under 17 correct: try a larger tag (e.g. GEMMA_MODEL=gemma3:12b) or tighten the prompt.');
}

void main();
