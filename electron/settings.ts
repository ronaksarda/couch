import { app } from 'electron';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const Schema = z.object({
  hotkey: z.string().min(1).max(64).default('Control+Alt+Space'),
  voice: z.boolean().default(true),
  pauseListening: z.boolean().default(false),
  reducedMotion: z.boolean().default(false),
  homeCorner: z
    .object({ corner: z.enum(['tl', 'tr', 'bl', 'br']), displayId: z.number().optional() })
    .default({ corner: 'br' }),
  // Default allowed roots; onboarding (later build) asks first. Network/removable drives are never added.
  roots: z.array(z.string()).default(() => (['documents', 'downloads', 'desktop'] as const).map((n) => app.getPath(n))),
  // GEMMA_PROVIDER in .env is the user's own choice of default; the tray can change it later.
  brain: z.enum(['ollama', 'gemini']).default(() => (process.env.GEMMA_PROVIDER === 'gemini' ? 'gemini' : 'ollama')),
  simHome: z.boolean().default(true),
  devicesPanel: z.boolean().default(true),
  onboarded: z.boolean().default(false),
  lanDiscovery: z.boolean().default(false), // "Look for real devices on my network": off until enabled
  sendFileNames: z.boolean().default(false), // cloud brain only
  sendFileContents: z.boolean().default(false), // cloud brain only
  speakFileNames: z.boolean().default(false),
  shortcuts: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) })).max(5).default([]),
  caps: z
    .object({
      browserSessions: z.number().int().min(0).max(1000).default(30),
      serpSearches: z.number().int().min(0).max(1000).default(10), // free plan is a few hundred a month
    })
    .default({ browserSessions: 30, serpSearches: 10 }),
});

export type Settings = z.infer<typeof Schema>;
export type Corner = Settings['homeCorner']['corner'];

const file = () => join(app.getPath('userData'), 'settings.json');

export function loadSettings(): Settings {
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(file(), 'utf8'));
  } catch {
    // missing or corrupt file: start from defaults
  }
  const parsed = Schema.safeParse(raw);
  return parsed.success ? parsed.data : Schema.parse({});
}

export function saveSettings(s: Settings): void {
  const tmp = file() + '.tmp';
  writeFileSync(tmp, JSON.stringify(Schema.parse(s), null, 2));
  renameSync(tmp, file()); // atomic replace so a crash never leaves half a file
}
