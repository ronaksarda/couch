// Sentry, main process only. One trace per request, one span per workflow step, plus drive and tool spans.
// Only tool/step names, durations and error types leave: text, paths, URLs and device names are scrubbed.
import * as Sentry from '@sentry/electron/main';

let on = false;

// Allowlist: no HTTP/fetch/net breadcrumbs (URLs carry keys and queries), no child-process args, no screenshots, no minidumps.
const KEEP = new Set(['OnUncaughtException', 'OnUnhandledRejection', 'LinkedErrors', 'Dedupe', 'FunctionToString', 'EventFilters', 'InboundFilters', 'ElectronContext', 'GpuContext', 'NormalizePaths', 'MainProcessSession']);
const OURS = /^couch\./;

type Ev = Sentry.Event;

/** Keep exception types and code locations; drop messages, values, variables, breadcrumbs, request, user, extras. */
export function scrub<E extends Ev>(e: E): E {
  delete e.message;
  delete e.request;
  delete e.user;
  delete e.extra;
  delete e.server_name;
  e.breadcrumbs = [];
  for (const v of e.exception?.values ?? []) {
    v.value = v.type ?? 'Error';
    for (const f of v.stacktrace?.frames ?? []) {
      delete f.vars;
      delete f.context_line;
      delete f.pre_context;
      delete f.post_context;
      delete f.abs_path;
      if (f.filename) f.filename = f.filename.replace(/^.*[\\/](?=[^\\/]+$)/, ''); // basename only
    }
  }
  return e;
}

function scrubTransaction(e: Ev): Ev | null {
  scrub(e);
  e.spans = (e.spans ?? []).filter((s) => OURS.test(s.op ?? '')).map((s) => ({ ...s, data: pick(s.data) }));
  if (e.contexts?.trace) e.contexts.trace.data = pick(e.contexts.trace.data);
  return e;
}

const pick = (d: Record<string, unknown> | undefined): Record<string, string | number | boolean> =>
  Object.fromEntries(Object.entries(d ?? {}).filter((x): x is [string, string | number | boolean] => ['string', 'number', 'boolean'].includes(typeof x[1])).filter(([k]) => ['couch.tool', 'couch.outcome', 'couch.error', 'sentry.op', 'sentry.origin'].includes(k)));

export function initTrace() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return; // app runs without it (edge 47)
  Sentry.init({
    dsn,
    tracesSampleRate: 1,
    // Static lifecycle: the default "stream" mode skips beforeSendTransaction, and that hook is where spans get scrubbed.
    traceLifecycle: 'static',
    integrations: (defaults) => defaults.filter((i) => KEEP.has(i.name)),
    beforeBreadcrumb: () => null,
    beforeSend: (e) => scrub(e),
    beforeSendTransaction: (e) => scrubTransaction(e) as typeof e,
  });
  on = true;
}

export type TraceRef = { sentryTrace?: string; baggage?: string };

/** Start (or continue, after a suspend) the request's single trace. */
export function requestTrace<T>(ref: TraceRef | null, fn: (ref: TraceRef) => Promise<T>): Promise<T> {
  if (!on) return fn({});
  const run = () =>
    Sentry.startSpan({ name: 'couch-request', op: 'couch.request', forceTransaction: true }, async () => {
      const t = Sentry.getTraceData();
      return fn({ sentryTrace: t['sentry-trace'], baggage: t.baggage });
    });
  return ref?.sentryTrace ? Sentry.continueTrace({ sentryTrace: ref.sentryTrace, baggage: ref.baggage }, run) : Sentry.startNewTrace(run);
}

/** A span with a fixed name (step id, tool name, "drive"). Errors are recorded by type only. */
export async function span<T>(name: string, op: 'step' | 'tool' | 'drive', fn: () => Promise<T>): Promise<T> {
  if (!on) return fn();
  return Sentry.startSpan({ name, op: `couch.${op}`, attributes: op === 'tool' ? { 'couch.tool': name } : {} }, async (s) => {
    try {
      const out = await fn();
      s.setAttribute('couch.outcome', 'ok');
      return out;
    } catch (e) {
      s.setAttribute('couch.outcome', 'error');
      s.setAttribute('couch.error', e instanceof Error ? e.constructor.name : 'unknown');
      throw e;
    }
  });
}

export function captureError(e: unknown) {
  if (on) Sentry.captureException(e);
}

export const flushTrace = () => (on ? Sentry.flush(2000) : Promise.resolve(true));
