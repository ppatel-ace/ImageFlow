/**
 * ACE usage beacon (ADR-023): page_view, named feature, api_error (5xx/network).
 * Hub SPA: mode "session" → POST /api/platform/usage-events/session (cookie).
 * Spokes: mode "relay" → POST same-origin /api/usage-events; the spoke server (createUsageRelay)
 *   stamps identity from its session and forwards to the Hub. No secret in the browser.
 * Legacy mode "ingest" (cross-origin + VITE secret) is blocked by CORS — do not use.
 */

export type UsageIdentity = {
  email?: string | null;
  displayName?: string | null;
  ssoUserId?: string | null;
  employeeId?: string | null;
};

export type UsageBeaconOptions = {
  appSlug: string;
  /** Absolute Hub origin, e.g. https://aceerp.aceelectronics.com — or "" for same-origin Hub */
  hubBaseUrl?: string;
  mode?: "session" | "ingest" | "relay";
  ingestSecret?: string;
  /** Relay endpoint on the spoke's own server (default "/api/usage-events"). */
  relayUrl?: string;
  /** Extra headers for the relay call, e.g. a bearer token when auth is not cookie-based. */
  relayHeaders?: () => Record<string, string> | null | undefined;
  getIdentity?: () => UsageIdentity | null | undefined;
};

type QueuedEvent = Record<string, unknown>;

const SESSION_KEY = "ace_usage_session_id";
let sessionId = "";
let opts: UsageBeaconOptions | null = null;
let queue: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let fetchPatched = false;
let routeHooked = false;
let lastPath = "";

function ensureSessionId(): string {
  if (sessionId) return sessionId;
  try {
    const existing = sessionStorage.getItem(SESSION_KEY);
    if (existing) {
      sessionId = existing;
      return sessionId;
    }
    sessionId = crypto.randomUUID();
    sessionStorage.setItem(SESSION_KEY, sessionId);
  } catch {
    sessionId = `anon-${Date.now()}`;
  }
  return sessionId;
}

function sanitizePath(raw: string): string {
  try {
    if (raw.startsWith("http")) {
      const u = new URL(raw);
      return (u.pathname + u.hash).slice(0, 500);
    }
  } catch {
    /* ignore */
  }
  const noQuery = raw.split("?")[0] || raw;
  return noQuery.slice(0, 500);
}

function hubOrigin(): string {
  const base = (opts?.hubBaseUrl || "").replace(/\/$/, "");
  return base;
}

function enqueue(ev: QueuedEvent) {
  if (!opts) return;
  const id = opts.getIdentity?.() || {};
  queue.push({
    ...ev,
    appSlug: opts.appSlug,
    sessionId: ensureSessionId(),
    email: id.email ?? null,
    displayName: id.displayName ?? null,
    ssoUserId: id.ssoUserId ?? null,
    employeeId: id.employeeId ?? null,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
  });
  if (queue.length >= 20) {
    void flush();
    return;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, 2000);
  }
}

async function flush() {
  if (!opts || queue.length === 0) return;
  const batch = queue.splice(0, 50);
  const mode = opts.mode || (opts.ingestSecret ? "ingest" : "session");
  const origin = hubOrigin();
  const url =
    mode === "relay"
      ? opts.relayUrl || "/api/usage-events"
      : mode === "session"
        ? `${origin}/api/platform/usage-events/session`
        : `${origin}/api/platform/usage-events`;

  if (mode === "ingest" && !opts.ingestSecret) return;

  let extraHeaders: Record<string, string> = {};
  if (mode === "relay") {
    try {
      extraHeaders = opts.relayHeaders?.() || {};
    } catch {
      extraHeaders = {};
    }
  }

  try {
    await fetch(url, {
      method: "POST",
      credentials: mode === "session" ? "include" : mode === "relay" ? "same-origin" : "omit",
      headers: {
        "Content-Type": "application/json",
        ...(mode === "ingest" && opts.ingestSecret
          ? { "X-Platform-Ingest-Secret": opts.ingestSecret }
          : {}),
        ...extraHeaders,
      },
      body: JSON.stringify({ events: batch }),
      keepalive: true,
    });
  } catch {
    /* fail silent */
  }
}

export function trackFeature(
  featureKey: string,
  featureLabel?: string,
  metadata?: Record<string, unknown>,
) {
  enqueue({
    eventType: "feature",
    featureKey: String(featureKey).slice(0, 120),
    featureLabel: featureLabel ? String(featureLabel).slice(0, 200) : null,
    path: sanitizePath(
      typeof window !== "undefined" ? window.location.pathname + window.location.hash : "",
    ),
    metadata: metadata && typeof metadata === "object" ? metadata : {},
  });
}

export function trackPageView(path?: string) {
  const p = sanitizePath(
    path ||
      (typeof window !== "undefined" ? window.location.pathname + window.location.hash : ""),
  );
  if (!p || p === lastPath) return;
  lastPath = p;
  enqueue({
    eventType: "page_view",
    path: p,
  });
}

function patchFetch() {
  if (fetchPatched || typeof window === "undefined" || !window.fetch) return;
  fetchPatched = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const res = await original(input, init);
      if (res.status >= 500) {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.includes("/usage-events")) return res;
        enqueue({
          eventType: "api_error",
          httpMethod: (init?.method || "GET").toUpperCase(),
          httpStatus: res.status,
          apiPath: sanitizePath(url),
          path: sanitizePath(window.location.pathname + window.location.hash),
        });
      }
      return res;
    } catch (err) {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.includes("/usage-events")) throw err;
      enqueue({
        eventType: "api_error",
        httpMethod: (init?.method || "GET").toUpperCase(),
        httpStatus: 0,
        apiPath: sanitizePath(url),
        path: sanitizePath(window.location.pathname + window.location.hash),
        metadata: { network: true },
      });
      throw err;
    }
  };
}

function hookRoutes() {
  if (routeHooked || typeof window === "undefined") return;
  routeHooked = true;
  const notify = () => trackPageView();
  window.addEventListener("popstate", notify);
  window.addEventListener("hashchange", notify);
  const wrap = (name: "pushState" | "replaceState") => {
    const orig = history[name].bind(history);
    history[name] = (...args: Parameters<History["pushState"]>) => {
      const ret = orig(...args);
      queueMicrotask(notify);
      return ret;
    };
  };
  wrap("pushState");
  wrap("replaceState");
  notify();
}

export function initUsageBeacon(options: UsageBeaconOptions) {
  opts = options;
  ensureSessionId();
  patchFetch();
  hookRoutes();
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => {
      void flush();
    });
  }
}

export function flushUsageBeacon() {
  return flush();
}
