import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/electron/main', () => ({}));
vi.mock('electron', () => ({ app: { getPath: () => '.', on: () => undefined }, screen: {} }));
const memory = await import('../electron/memory');
const { scrub } = await import('../electron/trace');
const { hideFileNames } = await import('../electron/workflow');

describe('memory without MongoDB', () => {
  const dir = mkdtempSync(join(tmpdir(), 'couch-mem-'));

  it('runs in memory and says history will not be saved (edges 46-47)', async () => {
    delete process.env.MONGODB_URI;
    expect(await memory.initMemory(dir)).toMatch(/history won't be saved/);
    expect(memory.getInstallId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(join(dir, 'install-id'), 'utf8')).toBe(memory.getInstallId());
  });

  it('offers a shortcut only after 3 uses across 2+ days, once', async () => {
    const d1 = new Date('2026-10-20T19:00:00');
    const d2 = new Date('2026-10-21T19:30:00');
    expect(await memory.recordHabit('screen.dim', d1)).toBe(false);
    expect(await memory.recordHabit('screen.dim', d1)).toBe(false);
    expect(await memory.recordHabit('screen.dim', d1)).toBe(false); // 3 uses, 1 day
    expect(await memory.recordHabit('screen.dim', d2)).toBe(true);
    expect(await memory.recordHabit('screen.dim', d2)).toBe(false); // already offered
  });

  it('habit files hold tool names only', () => {
    expect(readFileSync(join(dir, 'habit-days.json'), 'utf8')).toMatch(/^\{"screen\.dim\|evening\|weekday":/);
  });

  it('remembers facts the user asks it to, and uses them in the summary', () => {
    memory.addFact('I love sci-fi movies, especially Interstellar');
    memory.addFact('i love sci-fi movies, especially interstellar'); // same fact: kept once
    expect(memory.knowsAnything()).toBe(true);
    expect(memory.profileSummary()).toMatch(/interstellar/i);
    expect(readFileSync(join(dir, 'facts.json'), 'utf8').match(/Interstellar/gi)?.length).toBe(1);
  });

  it('keeps every show the user named', async () => {
    expect(memory.splitList('The Office, Friends, Breaking Bad and Taskmaster.')).toEqual(['The Office', 'Friends', 'Breaking Bad', 'Taskmaster']);
    expect(memory.splitList('Pride and Prejudice')).toEqual(['Pride and Prejudice']);
    await memory.saveProfile({ likes: 'Dark; Severance & Taskmaster' as never, vibe: '', sadMusic: [], funny: [] });
    for (const s of ['Dark', 'Severance', 'Taskmaster']) expect(memory.profileSummary()).toContain(s);
  });

  it('profile summary feeds media queries; forget me wipes it and the install id', async () => {
    await memory.saveProfile({ likes: ['Taskmaster'], vibe: 'bright and cozy', sadMusic: [], funny: ['cats'] });
    expect(memory.profileSummary()).toContain('Taskmaster');
    const old = memory.getInstallId();
    await memory.forgetMe();
    expect(memory.profileSummary()).toBe('');
    expect(memory.getInstallId()).not.toBe(old);
  });
});

describe('tracing scrub', () => {
  it('keeps error types and file basenames; drops text, paths, breadcrumbs, user', () => {
    const e = scrub({
      message: 'find my lease',
      user: { id: 'x' },
      breadcrumbs: [{ message: 'GET https://serpapi.com/search.json?api_key=SECRET' }],
      exception: { values: [{ type: 'ToolError', value: 'C:\\Users\\a\\lease.pdf is locked', stacktrace: { frames: [{ filename: 'C:\\app\\dist\\electron\\tools\\files.js', abs_path: 'C:\\app', vars: { p: 'C:\\x' }, context_line: 'x' }] } }] },
    });
    const json = JSON.stringify(e);
    expect(json).not.toMatch(/lease|SECRET|Users|find my/);
    expect(e.exception?.values?.[0].value).toBe('ToolError');
    expect(e.exception?.values?.[0].stacktrace?.frames?.[0].filename).toBe('files.js');
  });
});

describe('spoken replies', () => {
  it('hide file names unless "speak file names" is on', () => {
    const items = [{ id: 'r1', kind: 'file' as const, title: 'lease-2026.pdf', detail: '', data: {} }];
    expect(hideFileNames('Opened lease-2026.pdf for you.', items)).toBe('Opened that file for you.');
    expect(hideFileNames('Found lease-2026. Want it?', items)).toBe('Found that file. Want it?');
    const done = [{ id: 'r1', kind: 'file' as const, title: 'Done.docx', detail: '', data: {} }];
    expect(hideFileNames('Finished. Opened Done.docx.', done)).toBe('Finished. Opened that file.');
    expect(hideFileNames('Done. You are welcome.', done)).toBe('Done. You are welcome.');
    expect(hideFileNames('Undone stuff.', done)).toBe('Undone stuff.');
  });
});
