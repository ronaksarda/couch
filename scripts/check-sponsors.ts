// Live check of every partner service with the keys in .env. Prints ok/fail per service, never a key.
// Run: npx tsx scripts/check-sponsors.ts
import { config } from 'dotenv';
import { setServers } from 'node:dns';
import { MongoClient } from 'mongodb';

config({ quiet: true });
const env = (k: string) => process.env[k] ?? '';
const results: [string, string][] = [];
const check = async (name: string, f: () => Promise<string>) => {
  try {
    results.push([name, `ok   ${await f()}`]);
  } catch (e) {
    results.push([name, `FAIL ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}`]);
  }
};

void (async () => {
  await check('Gemma (Gemini API)', async () => {
    if (!env('GEMINI_API_KEY')) throw new Error('no GEMINI_API_KEY');
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': env('GEMINI_API_KEY') } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const names = ((await r.json()) as { models: { name: string }[] }).models.map((m) => m.name).filter((n) => n.includes('gemma'));
    return `${names.length} Gemma models visible (${names.find((n) => n.includes('gemma-4')) ?? names[0] ?? 'none'})`;
  });

  await check('MongoDB Atlas', async () => {
    if (!env('MONGODB_URI')) throw new Error('no MONGODB_URI');
    let c = new MongoClient(env('MONGODB_URI'), { serverSelectionTimeoutMS: 6000 });
    try {
      await c.connect();
    } catch {
      setServers(['1.1.1.1', '8.8.8.8']); // same fallback the app uses for SRV lookups
      c = new MongoClient(env('MONGODB_URI'), { serverSelectionTimeoutMS: 6000 });
      await c.connect();
    }
    const db = c.db('couch');
    await db.command({ ping: 1 });
    const n = await Promise.all(['profiles', 'habits', 'plays'].map((x) => db.collection(x).countDocuments()));
    await c.close();
    return `connected; profiles ${n[0]}, habits ${n[1]}, plays ${n[2]}`;
  });

  await check('ElevenLabs', async () => {
    if (!env('ELEVENLABS_API_KEY')) throw new Error('no ELEVENLABS_API_KEY');
    // The real call the app makes (3 characters): scoped keys may not read account info, but they must speak.
    const voice = env('ELEVENLABS_VOICE_ID') || 'pNInz6obpgDQGcFmaJgB';
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': env('ELEVENLABS_API_KEY'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hi.', model_id: 'eleven_flash_v2_5', voice_settings: { speed: 0.85, stability: 0.6, similarity_boost: 0.75 } }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 100)}`);
    return `text-to-speech works (${(await r.arrayBuffer()).byteLength} bytes of audio)`;
  });

  await check('Browserbase', async () => {
    if (!env('BROWSERBASE_API_KEY') || !env('BROWSERBASE_PROJECT_ID')) throw new Error('no BROWSERBASE_API_KEY / PROJECT_ID');
    const r = await fetch(`https://api.browserbase.com/v1/projects/${env('BROWSERBASE_PROJECT_ID')}/usage`, { headers: { 'X-BB-API-Key': env('BROWSERBASE_API_KEY') } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const u = (await r.json()) as { browserMinutes?: number };
    return `key works; ${u.browserMinutes ?? 0} browser minutes used`;
  });

  await check('Sentry', async () => {
    const dsn = env('SENTRY_DSN');
    if (!dsn) throw new Error('no SENTRY_DSN');
    const u = new URL(dsn);
    if (!u.username || !u.pathname.slice(1)) throw new Error('DSN looks malformed');
    return `DSN set (project ${u.pathname.slice(1)}); traces go out when the app runs`;
  });

  await check('SerpApi (search)', async () => {
    if (!env('SERPAPI_API_KEY')) throw new Error('no SERPAPI_API_KEY');
    const r = await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(env('SERPAPI_API_KEY'))}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const a = (await r.json()) as { plan_searches_left?: number };
    return `${a.plan_searches_left ?? '?'} searches left`;
  });

  results.push(['Mastra', 'ok   in-process: every request runs as the couch-request workflow (no key needed)']);
  for (const [k, v] of results) console.log(`${k.padEnd(20)} ${v}`);
})();
