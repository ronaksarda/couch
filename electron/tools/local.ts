// Small local tools: screen dim overlay, app launch, note, clipboard.
import { app, BrowserWindow, clipboard, screen, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { access, appendFile, mkdir, readdir, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { guardPath } from '../policy';
import { ids, ref, rt, ToolError, type Tool } from './rt';

// ---------- screen.dim: click-through black overlay (a tool, restored on exit) ----------

let overlay: BrowserWindow | null = null;

export function dim(level: number) {
  const l = Math.min(85, Math.max(0, Math.round(level)));
  if (l === 0) {
    overlay?.destroy();
    overlay = null;
    return 0;
  }
  if (!overlay || overlay.isDestroyed()) {
    const b = screen.getPrimaryDisplay().bounds;
    overlay = new BrowserWindow({
      ...b,
      frame: false,
      transparent: false,
      backgroundColor: '#000000',
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      hasShadow: false,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    overlay.setIgnoreMouseEvents(true);
    overlay.setAlwaysOnTop(true, 'floating');
    overlay.showInactive();
  }
  overlay.setOpacity(l / 100);
  rt.raise();
  return l;
}
app.on('before-quit', () => dim(0));

// ---------- screen.brightness: real backlight via WMI (laptops); monitors without it get the dim overlay ----------

const ps = (cmd: string) =>
  new Promise<string>((res, rej) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 6000, windowsHide: true }, (e, out) => (e ? rej(e) : res(String(out).trim()))));
const WMI = '-Namespace root/WMI -ClassName';

async function brightness(level: number | 'up' | 'down'): Promise<{ level: number; real: boolean }> {
  const step = (cur: number) => (typeof level === 'number' ? level : cur + (level === 'up' ? 20 : -20));
  try {
    const cur = Number((await ps(`(Get-CimInstance ${WMI} WmiMonitorBrightness).CurrentBrightness`)).split(/\s+/)[0]);
    if (!Number.isFinite(cur)) throw new Error('no-wmi');
    const want = Math.round(Math.min(100, Math.max(5, step(cur)))); // never fully black
    await ps(`Get-CimInstance ${WMI} WmiMonitorBrightnessMethods | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{Timeout=0;Brightness=${want}}`);
    dim(0);
    return { level: want, real: true };
  } catch {
    // External monitor: no backlight control from Windows. Fake it with the overlay (brightness 100 = no overlay).
    const cur = overlay && !overlay.isDestroyed() ? 100 - Math.round(overlay.getOpacity() * 100) : 100;
    const want = Math.round(Math.min(100, Math.max(15, step(cur))));
    dim(100 - want);
    return { level: want, real: false };
  }
}

// ---------- app.launch: Start Menu shortcuts, cached ----------

let apps: { name: string; path: string }[] | null = null;

async function listApps() {
  if (apps) return apps;
  const dirs = [join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft\\Windows\\Start Menu\\Programs'), join(app.getPath('appData'), 'Microsoft\\Windows\\Start Menu\\Programs')];
  const out: { name: string; path: string }[] = [];
  for (const d of dirs) {
    const files = await readdir(d, { recursive: true }).catch(() => [] as string[]);
    for (const f of files) if (/\.(lnk|url)$/i.test(f) && !/uninstall|readme|help|documentation/i.test(f)) out.push({ name: basename(f).replace(/\.(lnk|url)$/i, ''), path: join(d, f) });
  }
  apps = out;
  return out;
}

const SITES: Record<string, string> = {
  youtube: 'https://www.youtube.com/',
  'youtube music': 'https://music.youtube.com/',
  'yt music': 'https://music.youtube.com/',
  spotify: 'https://open.spotify.com/',
  gmail: 'https://mail.google.com/',
  netflix: 'https://www.netflix.com/',
  chatgpt: 'https://chatgpt.com/',
  whatsapp: 'https://web.whatsapp.com/',
  instagram: 'https://www.instagram.com/',
};

const n = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export const localTools: Record<string, Tool<any>> = {
  'screen.dim': {
    async run(a: { level: number }) {
      const l = dim(a.level);
      return { say: l === 0 ? 'Lights back. Squint responsibly.' : `Dimmed to ${l} percent. Better?` };
    },
  },
  'screen.brightness': {
    async run(a: { level: number | 'up' | 'down' }) {
      const b = await brightness(a.level);
      return { say: b.real ? `Brightness ${b.level} percent.` : `This monitor won't let me, so I faked it. ${b.level} percent.` };
    },
  },
  'app.launch': {
    async run(a: { name: string }) {
      const q = n(a.name);
      const list = await listApps();
      const exact = list.filter((x) => n(x.name) === q);
      const hits = exact.length ? exact : list.filter((x) => n(x.name).startsWith(q) || n(x.name).split(' ').includes(q) || (q.length >= 4 && n(x.name).includes(q)));
      const uniq = [...new Map(hits.map((h) => [n(h.name), h])).values()];
      if (!uniq.length) {
        // Web apps people call "apps": no Start Menu entry, so open the site. Fixed list, never a URL from the model.
        const site = SITES[q];
        if (site) {
          await shell.openExternal(site);
          return { say: `Opening ${a.name}. In your browser.` };
        }
        throw new ToolError(`Can't find ${a.name} in the Start Menu.`);
      }
      if (uniq.length > 1) return { items: ids(uniq.map((h) => ({ kind: 'app' as const, title: h.name, detail: 'app', data: { path: h.path }, then: { tool: 'app.launch' as const, args: { name: h.name } } }))) };
      await launch(uniq[0].path);
      return { say: `Opening ${uniq[0].name}. Slowly.` };
    },
  },
  'note.add': {
    async run(a: { text: string }) {
      const dir = join(app.getPath('documents'), 'Couch');
      await mkdir(dir, { recursive: true });
      const stamp = new Date().toLocaleString('sv-SE').slice(0, 16);
      // .txt, not .md: Notepad asks "Open file from an untrusted source?" for every markdown file it is handed.
      const file = join(dir, 'notes.txt');
      // One-time move of notes kept as notes.md; never over an existing notes.txt.
      if (await access(file).then(() => false, () => true)) await rename(join(dir, 'notes.md'), file).catch(() => undefined);
      await appendFile(file, `- ${stamp} ${a.text.replace(/\r?\n/g, ' ')}\n`);
      // Open it in Windows Notepad so the note is right there on screen. (Sticky Notes has no way for apps to add notes.)
      spawn('notepad.exe', [file], { detached: true, stdio: 'ignore', windowsHide: false }).on('error', () => undefined).unref();
      return { say: 'Wrote it down. It is in Notepad.' };
    },
  },
  'clipboard.copy': {
    async run(a: { text?: string; ref?: string }, ctx) {
      if (a.text) {
        clipboard.writeText(a.text);
        return { say: 'Copied.' };
      }
      const it = ref(a.ref, ctx);
      if (it.kind !== 'file') {
        clipboard.writeText(String(it.data.url ?? it.title));
        return { say: 'Copied the link.' };
      }
      const g = await guardPath(String(it.data.path), rt.settings().roots, { exactNamed: true });
      if (!g.ok) throw new ToolError("That one's off limits.", 'refuse');
      clipboard.writeText(g.real);
      return { say: 'Path copied.' };
    },
  },
};

/** Only paths from our own Start Menu scan are ever launched. */
export async function launch(path: string) {
  if (!(await listApps()).some((x) => x.path === path)) throw new ToolError('Not an app I know.', 'refuse');
  const err = await shell.openPath(path);
  if (err) throw new ToolError("Windows wouldn't start it.");
}
