// Media: YouTube search via SerpApi (browser fallback), 3 options, in-app embed player for videos, YouTube Music for songs.
// Nothing is ever downloaded from YouTube.
import { BrowserWindow, shell } from 'electron';
import { withBrowser } from './web';
import { youtube, SerpDown, type Video } from './serp';
import { recordPlay } from '../memory';
import { ids, ref, ToolError, type Ctx, type Item, type Tool } from './rt';

let player: BrowserWindow | null = null;
export const playerBounds = () => (player && !player.isDestroyed() && player.isVisible() ? player.getBounds() : null);


async function search(query: string, ctx: Ctx): Promise<Video[]> {
  try {
    return await youtube(query, ctx.signal);
  } catch (e) {
    if (!(e instanceof SerpDown)) throw e;
    // Fallback: load the YouTube results page in the cloud browser and read the video links.
    return withBrowser(async (page) => {
      await page.goto(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForSelector('a#video-title', { timeout: 10_000 }).catch(() => undefined);
      const rows = await page.$$eval('ytd-video-renderer', (els) =>
        els.slice(0, 10).map((el) => ({
          title: el.querySelector('#video-title')?.textContent?.trim() ?? '',
          link: (el.querySelector('a#video-title') as unknown as { href?: string } | null)?.href ?? '',
          channel: el.querySelector('#channel-name a')?.textContent?.trim() ?? '',
          length: el.querySelector('#time-status #text')?.textContent?.trim() ?? '',
        })),
      );
      return rows
        .map((r) => ({ ...r, videoId: new URL(r.link || 'https://x').searchParams.get('v') ?? '' }))
        .filter((r) => /^[\w-]{11}$/.test(r.videoId));
    }, ctx.signal);
  }
}

function openPlayer(videoId: string, watchUrl: string) {
  if (!player || player.isDestroyed()) {
    player = new BrowserWindow({
      width: 640,
      height: 380,
      title: 'Couch player',
      autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' },
    });
  }
  const p = player;
  const fallback = () => {
    if (!p.isDestroyed()) p.close();
    void shell.openExternal(watchUrl);
  };
  p.webContents.removeAllListeners('did-fail-load');
  p.webContents.on('did-fail-load', (_e, code, _d, _u, isMainFrame) => isMainFrame && code !== -3 && fallback());
  // Embeds want a referrer; without one YouTube shows error 153.
  void p.loadURL(`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0`, { httpReferrer: 'https://couch.tech/' }).catch(() => undefined);
  p.show();
  // Embed refused or unavailable: YouTube shows an error panel inside the page. Then use the browser.
  setTimeout(async () => {
    if (p.isDestroyed()) return;
    const refused = await p.webContents.executeJavaScript(`!!document.querySelector('.ytp-error, .ytp-embed-error')`).catch(() => false);
    if (refused) fallback();
  }, 4000);
}

async function control(js: string) {
  if (!player || player.isDestroyed()) throw new ToolError("Nothing's playing in my window. If it's in your browser, that's on you.", 'refuse');
  await player.webContents.executeJavaScript(`(() => { const v = document.querySelector('video'); if (!v) return false; ${js}; return true; })()`);
}

export const mediaTools: Record<string, Tool<any>> = {
  'media.search': {
    async run(a: { query: string; kind: 'song' | 'video' }, ctx) {
      const found = await search(a.kind === 'song' ? `${a.query} official audio` : a.query, ctx);
      if (!found.length) return { say: 'YouTube came up empty. Weird.', failed: true };
      const items: Item[] = ids(
        found.slice(0, 3).map((v) => ({ kind: a.kind, title: v.title, detail: `${v.channel}${v.length ? ` · ${v.length}` : ''}`, data: { videoId: v.videoId, url: v.link, channel: v.channel } })),
      );
      // He plays the best match straight away; the other two stay in the popup if you'd rather have those.
      return { items, chosen: items[0] };
    },
  },
  'media.play': {
    async run(a: { ref: string }, ctx) {
      const it = ref(a.ref, ctx);
      const id = String(it.data.videoId ?? '');
      if (!/^[\w-]{11}$/.test(id)) throw new ToolError("That's not something I can play.", 'refuse');
      void recordPlay(it.title, String(it.data.channel ?? '')); // title + channel only (PRD 8)
      if (it.kind === 'song') {
        await shell.openExternal(`https://music.youtube.com/watch?v=${id}`);
        return { say: "On YouTube Music. I can't touch that tab, by the way." };
      }
      openPlayer(id, `https://www.youtube.com/watch?v=${id}`);
      return { sayKind: 'done' };
    },
  },
  'media.control': {
    async run(a: { action: 'pause' | 'resume' | 'stop' | 'volume'; level?: number }) {
      if (a.action === 'stop') {
        if (player && !player.isDestroyed()) player.close();
        return { say: 'Stopped.' };
      }
      if (a.action === 'pause') await control('v.pause()');
      else if (a.action === 'resume') await control('v.play()');
      else await control(`v.volume = ${Math.min(100, Math.max(0, Number(a.level ?? 50))) / 100}`);
      return { sayKind: 'done' };
    },
  },
};
