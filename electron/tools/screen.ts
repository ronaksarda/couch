// screen.look: one screenshot of the display the couch is on, only when the user asks, shown on the confirm sheet first.
// The image goes to an answer-only model call: text on the screen can never add or change steps. Never written to disk.
import { desktopCapturer, screen } from 'electron';
import { couchBounds } from '../drive';
import { answerImage, getProvider } from '../gemma';
import { fmtSize, ToolError, type Tool } from './rt';

// requestId -> the exact JPEG the user approved. Memory only, dropped after use.
const shots = new Map<string, Buffer>();

async function capture() {
  const d = screen.getDisplayMatching(couchBounds());
  // Physical pixels, capped: enough to read text, small enough for the free API tier.
  const scale = Math.min(1, 1280 / (d.size.width * d.scaleFactor)); // 1280 wide: text still readable, about half the upload
  const size = { width: Math.round(d.size.width * d.scaleFactor * scale), height: Math.round(d.size.height * d.scaleFactor * scale) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[0];
  if (!src || src.thumbnail.isEmpty()) throw new ToolError("Couldn't grab the screen. Windows said no.");
  return { jpeg: src.thumbnail.toJPEG(70), preview: src.thumbnail.resize({ width: 480 }).toDataURL(), index: screen.getAllDisplays().findIndex((x) => x.id === d.id) + 1 };
}

export const screenTools: Record<string, Tool<any>> = {
  'screen.look': {
    async prepare(_a: { question: string }, ctx) {
      const dest = getProvider() === 'gemini' ? 'Gemma via the Gemini API (Google)' : 'Gemma on this computer (Ollama)';
      // The confirm step calls prepare again on Yes: keep the approved shot, never grab a new one (it would show the sheet itself).
      const kept = shots.get(ctx.requestId);
      if (kept) return { action: 'Look at your screen (this one screenshot)', source: 'Screen', dest, size: fmtSize(kept.length), fingerprint: async () => `screen:${ctx.requestId}` };
      const shot = await capture();
      while (shots.size >= 3) shots.delete(shots.keys().next().value!);
      shots.set(ctx.requestId, shot.jpeg);
      return {
        action: 'Look at your screen (this one screenshot)',
        source: `Display ${shot.index}`,
        dest,
        size: fmtSize(shot.jpeg.length),
        image: shot.preview,
        fingerprint: async () => `screen:${ctx.requestId}`, // what was shown is what gets sent
      };
    },
    async run(a: { question: string }, ctx) {
      // Approved on the sheet: send exactly that shot. Asked for in words: take it now.
      const jpeg = shots.get(ctx.requestId) ?? (await capture()).jpeg;
      shots.delete(ctx.requestId);
      const ans = await answerImage(a.question, jpeg.toString('base64'), ctx.signal);
      // He says the gist out loud; the full answer is on the card.
      const first = ans.replace(/^[\s*•-]+/, '').split(/(?<=[.!?])\s|\n/)[0];
      const gist = first.length > 90 ? `${first.slice(0, 88).replace(/\s+\S*$/, '')}…` : first;
      return { card: { title: 'Your screen', body: ans }, say: gist || 'Looked. Nothing to say.' };
    },
  },
};
