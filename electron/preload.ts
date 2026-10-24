import { contextBridge, ipcRenderer } from 'electron';

export type GuyState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'talking'
  | 'delivering'
  | 'asleep'
  | 'sulking'
  | 'departing'
  | 'driving'
  | 'arriving'
  | 'working'
  | 'returning'
  | 'parking';

/** A result card as the renderer sees it: labels only, never paths or URLs. */
export type CardItem = { id: string; key: string; kind: string; title: string; detail: string; snippet?: string; cloud?: boolean; thumb?: string };
export type DeviceView = { id: string; name: string; room?: string; kind: string; adapter: string; state: Record<string, boolean | number | string>; online: boolean };
export type Rect = { x: number; y: number; width: number; height: number };

/** Main to renderer. */
export type CouchEvent =
  | { t: 'state'; state: GuyState }
  | { t: 'motion'; vel: number; accel: number; facing: 1 | -1 }
  | { t: 'say'; id: number; text: string }
  | { t: 'audio'; id: number; bytes: Uint8Array }
  | { t: 'stopAudio' }
  | { t: 'listen'; on: boolean }
  | { t: 'openInput' }
  | { t: 'settings'; reducedMotion: boolean; voice: boolean }
  | { t: 'card'; title: string; body: string }
  | { t: 'confirm'; id: string; action: string; source: string; dest: string; size: string; image?: string }
  | { t: 'closeConfirm' }
  | { t: 'cards'; items: CardItem[]; picking: boolean }
  | { t: 'undo'; on: boolean }
  | { t: 'devices'; list: DeviceView[] }
  | { t: 'device'; id: string; state: Record<string, boolean | number | string>; online: boolean }
  | { t: 'obStep'; step: 0 | 1 | 2 | 3 }
  | { t: 'obBrain'; status: 'ok' | 'not-installed' | 'not-running' | 'model-missing' | 'no-key'; provider: 'ollama' | 'gemini'; tag: string; size: string }
  | { t: 'obProgress'; pct: number }
  | { t: 'obSettings'; roots: { path: string; checked: boolean }[]; voice: boolean; simHome: boolean; lanDiscovery: boolean; cloud: boolean; sendFileNames: boolean; sendFileContents: boolean }
  | { t: 'obFolder'; path: string }
  | { t: 'obQuestion'; index: number; text: string }
  | { t: 'obKeys'; set: Record<string, boolean> }; // which keys exist: never their values

/** Renderer to main. Main zod-validates every one of these. */
export type CouchCommand =
  | { c: 'ready'; osReducedMotion: boolean }
  | { c: 'hit'; over: boolean }
  | { c: 'drag'; phase: 'start' | 'move' | 'end'; x: number; y: number }
  | { c: 'input'; on: boolean }
  | { c: 'text'; text: string }
  | { c: 'audio'; bytes: Uint8Array; mime: string }
  | { c: 'micError' }
  | { c: 'mic' }
  | { c: 'expand'; on: boolean }
  | { c: 'closeResults' }
  | { c: 'spoken'; id: number }
  | { c: 'confirm'; id: string; yes: boolean }
  | { c: 'pick'; index: number }
  | { c: 'cardAction'; key: string; action: 'open' | 'reveal' | 'copyPath' }
  | { c: 'undo' }
  | { c: 'menu' }
  | { c: 'quit' }
  | { c: 'devicesReady' }
  | { c: 'hideDevices' }
  | { c: 'tiles'; rects: Record<string, Rect> }
  | { c: 'obCheck' }
  | { c: 'obInstall' }
  | { c: 'obDownload' }
  | { c: 'obPermissions' }
  | { c: 'obAddFolder' }
  | { c: 'obSave'; roots: string[]; voice: boolean; simHome: boolean; lanDiscovery: boolean; sendFileNames: boolean; sendFileContents: boolean }
  | { c: 'obAnswer'; text: string }
  | { c: 'obSkip' }
  | { c: 'obPrivacy' }
  | { c: 'obKeys'; keys: Record<string, string> };

const api = {
  send: (cmd: CouchCommand) => ipcRenderer.send('cmd', cmd),
  on: (cb: (e: CouchEvent) => void) => {
    ipcRenderer.on('evt', (_e, ev: CouchEvent) => cb(ev));
  },
};

export type CouchApi = typeof api;

contextBridge.exposeInMainWorld('couch', api);
