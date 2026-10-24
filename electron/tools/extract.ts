// Text extraction + Windows file attributes. Shared by the index worker and file.read. No Electron imports.
import { execFile } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { ATTR } from '../policy';

export const TEXT_CAP = 200 * 1024;
export const TEXT_EXT = new Set(['txt', 'md', 'csv', 'json', 'log', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'html', 'css', 'scss', 'xml', 'yml', 'yaml', 'toml', 'ini', 'sql', 'sh', 'ps1', 'bat', 'swift', 'lua', 'r', 'tex']);
export const ext = (p: string) => extname(p).slice(1).toLowerCase();

export type Extracted = { text: string } | { problem: 'scanned' | 'locked' | 'unsupported' | 'unreadable' };

/** Extract up to 200 KB of text. Password-protected/corrupt files give 'locked', image-only PDFs give 'scanned'. */
export async function extractText(path: string, cap = TEXT_CAP): Promise<Extracted> {
  const e = ext(path);
  try {
    if (TEXT_EXT.has(e)) {
      const fh = await open(path, 'r');
      try {
        const buf = Buffer.alloc(cap);
        const { bytesRead } = await fh.read(buf, 0, cap, 0);
        return { text: buf.subarray(0, bytesRead).toString('utf8') };
      } finally {
        await fh.close();
      }
    }
    if (e === 'docx') {
      const mammoth = await import('mammoth');
      const r = await mammoth.extractRawText({ path });
      return { text: r.value.slice(0, cap) };
    }
    if (e === 'pdf') return await pdfText(path, cap);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EBUSY' || code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') return { problem: 'unreadable' };
    return { problem: 'locked' }; // corrupt or encrypted docx/zip
  }
  return { problem: 'unsupported' };
}

async function pdfText(path: string, cap: number): Promise<Extracted> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await readFile(path));
  const task = pdfjs.getDocument({ data, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  let doc;
  try {
    doc = await task.promise;
  } catch {
    return { problem: 'locked' }; // PasswordException or InvalidPDFException
  }
  try {
    let text = '';
    for (let i = 1; i <= (cap < TEXT_CAP ? Math.min(doc.numPages, 60) : doc.numPages) && text.length < cap; i++) {
      const page = await doc.getPage(i);
      const c = await page.getTextContent();
      text += c.items.map((it) => ('str' in it ? it.str : '')).join(' ') + '\n';
    }
    return text.trim().length < 20 ? { problem: 'scanned' } : { text: text.slice(0, cap) };
  } finally {
    await task.destroy();
  }
}

/**
 * Windows attributes Node's fs.stat does not expose: hidden, system, and cloud placeholders
 * (OneDrive files-on-demand carry RECALL_ON_DATA_ACCESS / OFFLINE). One PowerShell walk per root; only flagged files return.
 */
export function winAttrs(root: string, recurse = true): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (process.platform !== 'win32') return Promise.resolve(out);
  const mask = ATTR.HIDDEN | ATTR.SYSTEM | ATTR.OFFLINE | ATTR.RECALL_ON_OPEN | ATTR.RECALL_ON_DATA;
  const script = `$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-ChildItem -LiteralPath $env:COUCH_ROOT -Force ${recurse ? '-Recurse' : ''} | Where-Object { ([int]$_.Attributes -band ${mask}) -ne 0 } | ForEach-Object { '{0}|{1}' -f [int]$_.Attributes, $_.FullName }`;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, COUCH_ROOT: root }, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 120_000 },
      (err, stdout) => {
        for (const l of String(stdout).split(/\r?\n/)) {
          const i = l.indexOf('|');
          if (i > 0) out.set(l.slice(i + 1).toLowerCase(), Number(l.slice(0, i)));
        }
        if (err) out.set(UNKNOWN, ATTR.OFFLINE); // walk failed or timed out: treat everything as cloud-only, never read it
        resolve(out);
      },
    );
  });
}

/**
 * Attributes of many files in ONE PowerShell call (paths on stdin). Used for watcher batches: never one process per file,
 * because OneDrive sync fires thousands of change events and a process each brought the machine to its knees.
 */
export function winAttrsOf(paths: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (process.platform !== 'win32' || !paths.length) return Promise.resolve(out);
  // PowerShell 5.1 talks the old console code page by default: force UTF-8 both ways, or "Résumé.txt" never matches.
  const script = `$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $r=New-Object IO.StreamReader([Console]::OpenStandardInput(),[Text.Encoding]::UTF8); while(($p=$r.ReadLine()) -ne $null){ $i = Get-Item -LiteralPath $p -Force; if ($i) { '{0}|{1}' -f [int]$i.Attributes, $i.FullName } }`;
  return new Promise((resolve) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 60_000, encoding: 'utf8' }, (err, stdout) => {
      for (const l of String(stdout).split(/\r?\n/)) {
        const i = l.indexOf('|');
        if (i > 0) out.set(l.slice(i + 1).toLowerCase(), Number(l.slice(0, i)));
      }
      if (err) out.set(UNKNOWN, ATTR.OFFLINE);
      resolve(out);
    });
    child.stdin?.end(paths.join('\n'), 'utf8');
  });
}

/** Attributes of one file (0 when none are flagged). */
export async function fileAttrs(path: string): Promise<number> {
  return (await winAttrsOf([path])).get(path.toLowerCase()) ?? 0;
}

/** Map key set when PowerShell failed: every file's attributes are unknown, so treat them as cloud-only. */
export const UNKNOWN = '*';
export const attrOf = (m: Map<string, number>, p: string) => m.get(p.toLowerCase()) ?? m.get(UNKNOWN) ?? 0;

export const isPlaceholder = (a: number) => (a & (ATTR.OFFLINE | ATTR.RECALL_ON_OPEN | ATTR.RECALL_ON_DATA)) !== 0;
export const isHiddenAttr = (a: number) => (a & (ATTR.HIDDEN | ATTR.SYSTEM)) !== 0;

/** 6,000-character chunks for question answering. */
export function chunks(text: string, size = 6000): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
