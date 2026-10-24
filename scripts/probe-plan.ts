// One-off: print the brain's plan for a few asks (no keys printed). Run: npx tsx scripts/probe-plan.ts
import { config } from 'dotenv';
import { plan, setProvider } from '../electron/gemma';
import { SIM_DEVICES } from '../electron/devices/registry';
config({ quiet: true });
setProvider('gemini');
const devices = SIM_DEVICES.map((d) => d.name);
void (async () => {
  for (const text of process.argv.slice(2)) {
    const out = await plan({ text, turns: [], profile: '', lastResults: [], devices });
    console.log(text, '=>', JSON.stringify(out).slice(0, 500));
    await new Promise((r) => setTimeout(r, 4000));
  }
})();
