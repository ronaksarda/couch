// SerpApi client: Google site search and the YouTube engine. Plain HTTPS. Daily cap counted in caps.json.
import { useCap, PolicyError } from '../policy';
import { rt, ToolError } from './rt';

const API = 'https://serpapi.com/search.json';
export const serpReady = () => Boolean(process.env.SERPAPI_API_KEY);

export class SerpDown extends Error {}

async function call(params: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!serpReady()) throw new SerpDown('no-key');
  try {
    useCap(rt.userData, 'serp', rt.settings().caps.serpSearches);
  } catch (e) {
    if (e instanceof PolicyError) throw new SerpDown('cap');
    throw e;
  }
  const url = `${API}?${new URLSearchParams({ ...params, api_key: process.env.SERPAPI_API_KEY ?? '' })}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
  } catch {
    if (signal?.aborted) throw new ToolError('Cancelled.', 'cancel');
    throw new SerpDown('network');
  }
  if (!res.ok) throw new SerpDown(res.status === 401 || res.status === 429 ? 'quota' : `http-${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  if (typeof body.error === 'string' && !/hasn't returned any results/i.test(body.error)) throw new SerpDown('api');
  return body;
}

export type Organic = { title: string; link: string; snippet: string };

/** `site:<domain> <query>` on Google. Up to 10 organic results. */
export async function siteSearch(domain: string, query: string, filetype?: string, signal?: AbortSignal): Promise<Organic[]> {
  const q = `site:${domain} ${query}${filetype ? ` filetype:${filetype}` : ''}`;
  const body = await call({ engine: 'google', q, num: '10' }, signal);
  return ((body.organic_results as Organic[] | undefined) ?? []).slice(0, 10).map((r) => ({ title: String(r.title ?? ''), link: String(r.link ?? ''), snippet: String(r.snippet ?? '') }));
}

export type Video = { title: string; link: string; videoId: string; channel: string; length: string };

/** YouTube engine: `search_query`, results in `video_results` (channel.name, length). */
export async function youtube(query: string, signal?: AbortSignal): Promise<Video[]> {
  const body = await call({ engine: 'youtube', search_query: query }, signal);
  const rows = (body.video_results as Record<string, any>[] | undefined) ?? [];
  return rows
    .map((r) => {
      const link = String(r.link ?? '');
      const videoId = String(r.video_id ?? new URL(link || 'https://x').searchParams.get('v') ?? '');
      return { title: String(r.title ?? ''), link, videoId, channel: String(r.channel?.name ?? ''), length: String(r.length ?? '') };
    })
    .filter((v) => /^[\w-]{11}$/.test(v.videoId))
    .slice(0, 10);
}
