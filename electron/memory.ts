// Memory: MongoDB `couch` (profiles incl. remembered facts, habits, plays), mirrored in local files so it works offline.
// Never stored in Mongo: file paths/names/contents, request text, URLs, device names, API keys.
import { MongoClient, type Collection } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { setServers } from 'node:dns';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Profile = { likes: string[]; vibe: string; sadMusic: string[]; funny: string[] };
type ProfileDoc = Profile & { _id: string; facts?: string[]; createdAt: Date; updatedAt: Date };
type HabitDoc = { installId: string; tool: string; timeBucket: 'morning' | 'afternoon' | 'evening' | 'night'; weekdayType: 'weekday' | 'weekend'; count: number; lastSeen: Date };
type PlayDoc = { installId: string; title: string; channel: string; at: Date };

let dir = '';
let installId = '';
let client: MongoClient | null = null;
let db: { profiles: Collection<ProfileDoc>; habits: Collection<HabitDoc>; plays: Collection<PlayDoc> } | null = null;
let profile: Profile | null = null;
// Local only: which days each habit key was seen (Mongo keeps the PRD fields only), and offers already made.
let days: Record<string, string[]> = {};
let offered: string[] = [];
// Things the user said "remember ..." about: local file, and the profile document in Mongo when connected.
let facts: string[] = [];

const localFile = (n: string) => join(dir, n);
const readJson = <T>(n: string, d: T): T => {
  try {
    return JSON.parse(readFileSync(localFile(n), 'utf8')) as T;
  } catch {
    return d;
  }
};

export const getInstallId = () => installId;

/** Returns null when history is saved, or the one line to show when it is not (edges 46, 47). */
export async function initMemory(userData: string): Promise<string | null> {
  dir = userData;
  try {
    installId = readFileSync(localFile('install-id'), 'utf8').trim();
  } catch {
    installId = '';
  }
  if (!/^[0-9a-f-]{36}$/.test(installId)) {
    installId = randomUUID();
    writeFileSync(localFile('install-id'), installId);
  }
  days = readJson('habit-days.json', {});
  offered = readJson('habit-offers.json', []);
  profile = readJson<Profile | null>('profile.json', null);
  facts = readJson<string[]>('facts.json', []).filter((f) => typeof f === 'string').slice(-50); // local copy: the profile survives restarts without Mongo
  const uri = process.env.MONGODB_URI;
  if (!uri) return "No MONGODB_URI, so history won't be saved. Everything else works.";
  try {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, appName: 'couch' });
    await client.connect().catch(async (e: Error) => {
      // Some Windows setups give Node a local DNS (127.0.0.1) that refuses SRV queries; mongodb+srv needs them.
      if (!/querySrv|ENOTFOUND|ECONNREFUSED/.test(String(e.message))) throw e;
      setServers(['1.1.1.1', '8.8.8.8']);
      await client!.connect();
    });
    const d = client.db('couch');
    db = { profiles: d.collection('profiles'), habits: d.collection('habits'), plays: d.collection('plays') };
    const p = await db.profiles.findOne({ _id: installId });
    if (p) profile = { likes: p.likes, vibe: p.vibe, sadMusic: p.sadMusic, funny: p.funny };
    // Facts from another session or install merge with the local ones; Mongo gets the union back.
    if (p?.facts?.length) facts = [...new Set([...p.facts.filter((f) => typeof f === 'string'), ...facts])].slice(-50);
    if (facts.length) await saveFacts();
    return null;
  } catch {
    db = null;
    await client?.close().catch(() => undefined);
    client = null;
    return "Can't reach the memory database. History won't be saved this time.";
  }
}

/** "remember I hate horror movies" -> kept, newest last, at most 50. */
export function addFact(text: string) {
  const f = text.trim().replace(/\s+/g, ' ').slice(0, 200);
  if (!f) return;
  facts = [...facts.filter((x) => x.toLowerCase() !== f.toLowerCase()), f].slice(-50);
  void saveFacts();
}

async function saveFacts() {
  writeFileSync(localFile('facts.json'), JSON.stringify(facts));
  const now = new Date();
  await db?.profiles.updateOne({ _id: installId }, { $set: { facts, updatedAt: now }, $setOnInsert: { createdAt: now, likes: [], vibe: '', sadMusic: [], funny: [] } }, { upsert: true }).catch(() => undefined);
}

export const knowsAnything = () => facts.length > 0 || Boolean(profile && (profile.likes.length || profile.vibe || profile.sadMusic.length || profile.funny.length));

/** What he knows about the user, for the planner: answers "what do I like?" and picks media. */
export function profileSummary(): string {
  const remembered = facts.length ? `; remembered: ${facts.slice(-12).join(' | ')}` : '';
  if (!profile) return remembered.slice(2);
  const parts = [
    // Shuffled each call: the planner tends to take the first item, so "something I like" was always show one.
    profile.likes.length && `likes ${[...profile.likes].sort(() => Math.random() - 0.5).join(', ')}`,
    profile.vibe && `vibe ${profile.vibe}`,
    profile.sadMusic.length && `sad music ${profile.sadMusic.join(', ')}`,
    profile.funny.length && `laughs at ${profile.funny.join(', ')}`,
  ].filter(Boolean);
  return (parts.join('; ') + remembered).slice(0, 900);
}

/**
 * "The Office, Friends, Dark and Taskmaster" -> 4 items. The model sometimes returns one string, or one item for four shows.
 * "and"/"&" splits only the last item of a list, so "Pride and Prejudice" on its own stays one show.
 */
export function splitList(s: string): string[] {
  const parts = s.split(/\s*[,;/\n]\s*/).map((x) => x.trim().replace(/[.!?]+$/, '')).filter(Boolean);
  if (parts.length > 1) parts.push(...parts.pop()!.split(/\s+(?:and|&)\s+/i));
  return parts.filter(Boolean);
}

const clean = (xs: unknown, n = 10) => {
  const list = typeof xs === 'string' ? splitList(xs) : Array.isArray(xs) ? xs.filter((x): x is string => typeof x === 'string') : [];
  const seen = new Set<string>();
  return list.map((x) => x.trim().slice(0, 60)).filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase())).slice(0, n);
};

export async function saveProfile(p: Partial<Profile>) {
  profile = { likes: clean(p.likes), vibe: String(p.vibe ?? '').slice(0, 40), sadMusic: clean(p.sadMusic), funny: clean(p.funny) };
  writeFileSync(localFile('profile.json'), JSON.stringify(profile));
  const now = new Date();
  await db?.profiles.updateOne({ _id: installId }, { $set: { ...profile, updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true }).catch(() => undefined);
}

const bucket = (h: number): HabitDoc['timeBucket'] => (h >= 5 && h < 12 ? 'morning' : h < 17 && h >= 12 ? 'afternoon' : h >= 17 && h < 22 ? 'evening' : 'night');

/**
 * Count a tool use. Returns true exactly once per tool+time slot, after 3 uses across at least 2 days:
 * that is when the guy offers a shortcut. The caller never auto-runs anything (and never offers T2 tools).
 */
export async function recordHabit(tool: string, now = new Date()): Promise<boolean> {
  const timeBucket = bucket(now.getHours());
  const weekdayType = now.getDay() === 0 || now.getDay() === 6 ? 'weekend' : 'weekday';
  const key = `${tool}|${timeBucket}|${weekdayType}`;
  const day = now.toISOString().slice(0, 10);
  const seen = (days[key] ??= []);
  seen.push(day);
  if (seen.length > 30) seen.splice(0, seen.length - 30);
  writeFileSync(localFile('habit-days.json'), JSON.stringify(days));
  await db?.habits.updateOne({ installId, tool, timeBucket, weekdayType }, { $inc: { count: 1 }, $set: { lastSeen: now } }, { upsert: true }).catch(() => undefined);
  if (offered.includes(key) || seen.length < 3 || new Set(seen).size < 2) return false;
  offered.push(key);
  writeFileSync(localFile('habit-offers.json'), JSON.stringify(offered));
  return true;
}

export async function recordPlay(title: string, channel: string) {
  await db?.plays.insertOne({ installId, title: title.slice(0, 200), channel: channel.slice(0, 100), at: new Date() }).catch(() => undefined);
}

/** Forget me: Mongo docs, the local install id, habit files. The caller also drops the file index. */
export async function forgetMe() {
  if (db) await Promise.all([db.profiles.deleteMany({ _id: installId }), db.habits.deleteMany({ installId }), db.plays.deleteMany({ installId })]).catch(() => undefined);
  for (const f of ['install-id', 'habit-days.json', 'habit-offers.json', 'profile.json', 'facts.json']) rmSync(localFile(f), { force: true });
  profile = null;
  facts = [];
  days = {};
  offered = [];
  installId = randomUUID();
  writeFileSync(localFile('install-id'), installId);
}

export const closeMemory = () => client?.close().catch(() => undefined);
