import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '.', on: () => undefined }, screen: {}, shell: {}, clipboard: {}, BrowserWindow: class {}, Notification: class {} }));
const { tools } = await import('../electron/tools');
const { catalog } = await import('../electron/policy');

describe('tool registry', () => {
  it('every catalog tool has an implementation', () => {
    for (const name of Object.keys(catalog)) expect(typeof tools[name as keyof typeof tools]?.run, name).toBe('function');
  });

  it('every T2 tool builds a confirm sheet (exact action, source, destination, size)', () => {
    for (const [name, t] of Object.entries(catalog)) if (t.tier === 2) expect(typeof tools[name as keyof typeof tools].prepare, name).toBe('function');
  });

  it('"open" never runs programs', async () => {
    const { isExecutable } = await import('../electron/tools/files');
    for (const f of ['setup.exe', 'run.BAT', 'x.ps1', 'a.lnk', 'b.msi', 'c.hta', 'd.js', 'e.scr']) expect(isExecutable(f), f).toBe(true);
    for (const f of ['lease.pdf', 'budget.xlsx', 'notes.md', 'photo.jpg']) expect(isExecutable(f), f).toBe(false);
  });
});
