import { app } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const API = 'https://api.elevenlabs.io/v1';
const STT_MODEL = 'scribe_v2'; // verified in ElevenLabs docs (Oct 2026); PRD did not pin one
const TTS_MODEL = 'eleven_flash_v2_5'; // ~470 ms vs ~820 ms for multilingual_v2 (measured Oct 2026)
const FORMAT = 'mp3_44100_128';
// A lazy guy talks slowly: 0.85x speed, steady delivery. (ElevenLabs allows 0.7 to 1.2.)
const VOICE = { speed: 0.85, stability: 0.6, similarity_boost: 0.75 };

const key = () => process.env.ELEVENLABS_API_KEY ?? '';
const voiceId = () => process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'; // Adam, a premade voice every account has

export const sttReady = () => key() !== '';
export const ttsReady = () => key() !== '' && voiceId() !== '';

let ttsDownUntil = 0;

/** Speech to text. Audio stays in memory and is dropped after this call; nothing is written to disk. */
export async function transcribe(audio: Uint8Array, mime: string): Promise<string> {
  if (!sttReady()) throw new Error('no-elevenlabs-key');
  const form = new FormData();
  form.append('model_id', STT_MODEL);
  // ponytail: audio never touches disk, so there is no file to delete; the buffer is released when this returns.
  form.append('file', new Blob([audio as Uint8Array<ArrayBuffer>], { type: mime }), 'speech.webm');
  const res = await fetch(`${API}/speech-to-text`, {
    method: 'POST',
    headers: { 'xi-api-key': key() },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`stt-${res.status}`);
  const body = (await res.json()) as { text?: unknown };
  return typeof body.text === 'string' ? body.text : '';
}

/** Text to speech, cached on disk by voice+model+text. Returns null on any failure so the bubble still shows. */
export async function speak(text: string, cache: boolean): Promise<Uint8Array | null> {
  if (!ttsReady() || Date.now() < ttsDownUntil) return null;
  const dir = join(app.getPath('userData'), 'tts-cache');
  const path = join(dir, createHash('sha1').update(`${voiceId()}|${TTS_MODEL}|${FORMAT}|${VOICE.speed}|${text}`).digest('hex') + '.mp3');
  if (cache) {
    try {
      return new Uint8Array(await readFile(path));
    } catch {
      // not cached yet
    }
  }
  try {
    const res = await fetch(`${API}/text-to-speech/${encodeURIComponent(voiceId())}?output_format=${FORMAT}`, {
      method: 'POST',
      headers: { 'xi-api-key': key(), 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: TTS_MODEL, voice_settings: VOICE }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // Quota or auth trouble: stay quiet for a while instead of failing every line.
      if (res.status === 401 || res.status === 402 || res.status === 429) ttsDownUntil = Date.now() + 5 * 60_000;
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (cache) {
      await mkdir(dir, { recursive: true });
      await writeFile(path, bytes).catch(() => undefined);
    }
    return bytes;
  } catch {
    return null;
  }
}

const NOISE = /^(u+h+|u+m+|h+m+|m+|a+h+|e+r+|e+h+|o+h+|huh)$/i;

/** True for empty, noise-only or filler transcripts ("uh", "(background noise)"). */
export function isNoise(text: string): boolean {
  const t = text
    .replace(/\(.*?\)|\[.*?\]/g, ' ') // ElevenLabs tags sound events in brackets
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .trim();
  if (t.length < 2) return true;
  return t.split(/\s+/).every((w) => NOISE.test(w));
}
