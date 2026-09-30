/**
 * ACE server activity audit (ADR-031): records successful POST/PUT/PATCH/DELETE as
 * `record_change` usage events (route pattern + record type/id/label — never request bodies).
 *
 * Spokes: set PLATFORM_INGEST_URL + PLATFORM_AUDIT_INGEST_SECRET (server env only, never VITE_*).
 * Mount once, before the API router:  app.use(createActivityAudit({ appSlug: "crm" }))
 * Handlers may set `res.locals.auditRecord = { type, id, label }` for friendlier labels.
 * Browser page views: mount createUsageRelay() at POST /api/usage-events (beacon mode "relay").
 *
 * Canonical copy lives in ace-platform/shared/activityAudit.ts; spokes keep a verbatim copy.
 */

export type AuditIdentity = {
  email?: string | null;
  displayName?: string | null;
  ssoUserId?: string | null;
  employeeId?: string | null;
};

export type AuditRecord = { type?: string | null; id?: string | number | null; label?: string | null };

export type AuditEvent = {
  appSlug: string;
  eventType: "record_change";
  featureKey: string;
  featureLabel: string | null;
  httpMethod: string;
  httpStatus: number;
  apiPath: string;
  path: string | null;
  email: string | null;
  displayName: string | null;
  ssoUserId: string | null;
  employeeId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: { recordType: string | null; recordId: string | null; recordLabel: string | null };
};

/* Minimal structural types so this file compiles in any Express app without importing express. */
type AnyReq = {
  method: string;
  originalUrl?: string;
  url?: string;
  baseUrl?: string;
  route?: { path?: unknown };
  params?: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  [key: string]: unknown;
};
type AnyRes = {
  statusCode: number;
  locals?: Record<string, unknown>;
  json?: (body: unknown) => unknown;
  on: (event: "finish", cb: () => void) => unknown;
};
type Next = (err?: unknown) => void;

export type ActivityAuditOptions = {
  appSlug: string;
  /** Map a request to a sub-app slug (e.g. Inventory → "po-search"). */
  resolveAppSlug?: (req: AnyReq) => string | null | undefined;
  /** Override identity lookup; defaults probe req.user / req.session shapes. */
  getIdentity?: (req: AnyReq) => AuditIdentity | null | undefined;
  /** Extra skip rule (return true to ignore the request). */
  skip?: (req: AnyReq, apiPath: string) => boolean;
  /** Custom sink (Hub inserts directly); defaults to POST PLATFORM_INGEST_URL/api/platform/usage-events. */
  sink?: (events: AuditEvent[]) => Promise<unknown>;
};

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const DEFAULT_SKIP = [
  /\/auth(\/|$)/i,
  /\/sso(\/|$)/i,
  /\/log(in|out)(\/|$)/i,
  /\/session(\/|$)/i,
  /\/health(\/|$)/i,
  /\/heartbeat/i,
  /\/ping(\/|$)/i,
  /\/usage-events/i,
  /\/login-events/i,
  /\/telemetry/i,
  /\/geofence/i,
  /\/metrics(\/|$)/i,
  /\/help\/ask/i,
  /\/search(\/|$)/i,
];

const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{24,})$/i;

function str(value: unknown, max = 200): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function pick(obj: unknown, ...keys: string[]): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  for (const key of keys) {
    if (rec[key] !== undefined && rec[key] !== null && rec[key] !== "") return rec[key];
  }
  return undefined;
}

export function defaultAuditIdentity(req: AnyReq): AuditIdentity | null {
  const session = req.session as Record<string, unknown> | undefined;
  const sources = [req.user, req.auth, req.aceUser, req.ssoUser, session?.user, session?.passport, session];
  for (const src of sources) {
    const email = str(pick(src, "email", "userEmail", "mail"), 320);
    const ssoUserId = str(pick(src, "ssoUserId", "sso_user_id", "sub", "oid"), 120);
    const employeeId = str(pick(src, "employeeId", "employee_id", "employeeNumber", "technicianId"), 60);
    if (email || ssoUserId || employeeId) {
      return {
        email,
        ssoUserId,
        employeeId,
        displayName: str(pick(src, "displayName", "display_name", "name", "fullName", "technicianName"), 200),
      };
    }
  }
  return null;
}

function stripQuery(url: string): string {
  const q = url.indexOf("?");
  return (q >= 0 ? url.slice(0, q) : url).slice(0, 300);
}

function routePattern(req: AnyReq): string {
  const routePath = typeof req.route?.path === "string" ? req.route.path : null;
  if (routePath) return `${req.baseUrl || ""}${routePath}`.slice(0, 300) || "/";
  return stripQuery(req.originalUrl || req.url || "/")
    .split("/")
    .map((seg) => (ID_SEGMENT.test(seg) ? ":id" : seg))
    .join("/");
}

function singular(word: string): string {
  if (/ies$/i.test(word)) return word.slice(0, -3) + "y";
  if (/(ses|xes|ches|shes)$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.slice(0, -1);
  return word;
}

function describeRoute(method: string, pattern: string, req: AnyReq) {
  const segments = pattern.split("/").filter((seg) => seg && seg !== "api");
  let recordType: string | null = null;
  let recordId: string | null = null;
  let actionSuffix: string | null = null;
  let sawParam = false;

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg.startsWith(":")) {
      const key = seg.slice(1).replace(/[?*+].*$/, "");
      const val = req.params?.[key];
      if (val !== undefined) recordId = str(val, 120);
      sawParam = true;
      actionSuffix = null;
    } else if (seg !== "*") {
      if (sawParam && i === segments.length - 1) actionSuffix = seg;
      else {
        recordType = singular(seg);
        if (!sawParam) recordId = null;
      }
    }
  }

  let action: string;
  if (actionSuffix) action = actionSuffix.replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "action";
  else if (method === "DELETE") action = "delete";
  else if (method === "POST" && !recordId) action = "create";
  else if (method === "POST") action = "action";
  else action = "update";

  return { recordType, recordId, action };
}

function refererPath(req: AnyReq): string | null {
  const referer = req.headers.referer;
  if (typeof referer !== "string") return null;
  try {
    const u = new URL(referer);
    return (u.pathname + u.hash).slice(0, 300);
  } catch {
    return null;
  }
}

function clientIp(req: AnyReq): string | null {
  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  if (raw && raw.trim()) return raw.split(",")[0].trim();
  return req.ip?.trim() || null;
}

function httpSink<T>(): ((events: T[]) => Promise<unknown>) | null {
  const base = process.env.PLATFORM_INGEST_URL?.trim();
  const secret = process.env.PLATFORM_AUDIT_INGEST_SECRET?.trim();
  if (!base || !secret) return null;
  const url = `${base.replace(/\/$/, "")}/api/platform/usage-events`;
  return (events) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Platform-Audit-Secret": secret },
      body: JSON.stringify({ events }),
    });
}

function createBatcher<T>(sink: ((events: T[]) => Promise<unknown>) | null) {
  let queue: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (!sink || queue.length === 0) return;
    while (queue.length) {
      const batch = queue.splice(0, 50);
      void Promise.resolve()
        .then(() => sink(batch))
        .catch(() => {
          /* fail silent — auditing must never affect the app */
        });
    }
  };

  return (ev: T) => {
    if (queue.length > 500) return;
    queue.push(ev);
    if (queue.length >= 50) flush();
    else if (!timer) timer = setTimeout(flush, 2000);
  };
}

export function createActivityAudit(options: ActivityAuditOptions) {
  const sink = options.sink ?? httpSink<AuditEvent>();
  const getIdentity = options.getIdentity ?? defaultAuditIdentity;
  const enqueue = createBatcher(sink);

  return function activityAudit(rawReq: unknown, rawRes: unknown, next: Next) {
    const req = rawReq as AnyReq;
    const res = rawRes as AnyRes;
    if (!sink || !WRITE_METHODS.has(String(req.method).toUpperCase())) return next();

    const rawPath = stripQuery(req.originalUrl || req.url || "");
    if (DEFAULT_SKIP.some((re) => re.test(rawPath))) return next();

    let responseRecord: AuditRecord | null = null;
    if (typeof res.json === "function") {
      const original = res.json.bind(res);
      res.json = (body: unknown) => {
        try {
          const data = pick(body, "data");
          const target = data && typeof data === "object" && !Array.isArray(data) ? data : body;
          if (target && typeof target === "object" && !Array.isArray(target)) {
            responseRecord = {
              id: pick(target, "id", "uuid") as string | number | undefined,
              label: str(pick(target, "name", "title", "label", "displayName", "partNumber", "part_number"), 120),
            };
          }
        } catch {
          /* ignore */
        }
        return original(body);
      };
    }

    res.on("finish", () => {
      try {
        if (res.statusCode >= 400) return;
        const method = String(req.method).toUpperCase();
        const apiPath = routePattern(req);
        if (options.skip?.(req, apiPath)) return;
        const identity = getIdentity(req);
        if (!identity || !(identity.email || identity.ssoUserId || identity.employeeId)) return;

        const described = describeRoute(method, apiPath, req);
        const explicit = (res.locals?.auditRecord ?? null) as AuditRecord | null;
        const recordType = str(explicit?.type, 80) ?? described.recordType;
        const recordId = str(explicit?.id, 120) ?? described.recordId ?? str(responseRecord?.id, 120);
        const recordLabel = str(explicit?.label, 120) ?? str(responseRecord?.label, 120);
        const featureKey = `${(recordType || "record").toLowerCase()}.${described.action}`.slice(0, 120);

        enqueue({
          appSlug: options.resolveAppSlug?.(req) || options.appSlug,
          eventType: "record_change",
          featureKey,
          featureLabel: null,
          httpMethod: method,
          httpStatus: res.statusCode,
          apiPath,
          path: refererPath(req),
          email: str(identity.email, 320),
          displayName: str(identity.displayName, 200),
          ssoUserId: str(identity.ssoUserId, 120),
          employeeId: str(identity.employeeId, 60),
          ipAddress: clientIp(req),
          userAgent: str(req.headers["user-agent"], 500),
          metadata: { recordType, recordId, recordLabel },
        });
      } catch {
        /* never throw from finish */
      }
    });

    next();
  };
}

export type RelayedUsageEvent = {
  appSlug: string;
  eventType: "page_view" | "feature" | "api_error";
  sessionId: string | null;
  path: string | null;
  featureKey: string | null;
  featureLabel: string | null;
  httpMethod: string | null;
  httpStatus: number | null;
  apiPath: string | null;
  email: string | null;
  displayName: string | null;
  ssoUserId: string | null;
  employeeId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
};

export type UsageRelayOptions = {
  appSlug: string;
  /** Other slugs the browser may report for this server (e.g. Inventory → ["po-search"]). */
  allowedAppSlugs?: string[];
  getIdentity?: (req: AnyReq) => AuditIdentity | null | undefined;
  sink?: (events: RelayedUsageEvent[]) => Promise<unknown>;
};

const RELAY_EVENT_TYPES = new Set(["page_view", "feature", "api_error"]);

/**
 * Same-origin relay for the browser usage beacon (mode "relay"). Identity is taken from the
 * server session — browser-supplied identity is ignored — and events are forwarded to the Hub
 * with the server-only audit secret. Mount after body parsing and auth, e.g.
 *   app.post("/api/usage-events", createUsageRelay({ appSlug: "crm" }))
 * The path must match DEFAULT_SKIP (`/usage-events`) so the audit does not log it as a write.
 */
export function createUsageRelay(options: UsageRelayOptions) {
  const sink = options.sink ?? httpSink<RelayedUsageEvent>();
  const getIdentity = options.getIdentity ?? defaultAuditIdentity;
  const enqueue = createBatcher(sink);
  const allowed = new Set([options.appSlug, ...(options.allowedAppSlugs ?? [])]);

  return function usageRelay(rawReq: unknown, rawRes: unknown) {
    const req = rawReq as AnyReq & { body?: unknown };
    const res = rawRes as { status: (code: number) => { end: () => unknown } };
    try {
      const identity = sink ? getIdentity(req) : null;
      if (identity && (identity.email || identity.ssoUserId || identity.employeeId)) {
        const events = pick(req.body, "events");
        const list = Array.isArray(events) ? events.slice(0, 50) : [];
        for (const raw of list) {
          if (!raw || typeof raw !== "object") continue;
          const ev = raw as Record<string, unknown>;
          const eventType = String(ev.eventType ?? "");
          if (!RELAY_EVENT_TYPES.has(eventType)) continue;
          const slug = str(ev.appSlug, 60)?.toLowerCase();
          const status = Number(ev.httpStatus);
          const metadata =
            ev.metadata && typeof ev.metadata === "object" && !Array.isArray(ev.metadata) &&
            JSON.stringify(ev.metadata).length <= 2000
              ? (ev.metadata as Record<string, unknown>)
              : {};
          enqueue({
            appSlug: slug && allowed.has(slug) ? slug : options.appSlug,
            eventType: eventType as RelayedUsageEvent["eventType"],
            sessionId: str(ev.sessionId, 80),
            path: str(ev.path, 500),
            featureKey: str(ev.featureKey, 120),
            featureLabel: str(ev.featureLabel, 200),
            httpMethod: str(ev.httpMethod, 16),
            httpStatus: ev.httpStatus != null && Number.isFinite(status) ? status : null,
            apiPath: str(ev.apiPath, 500),
            email: str(identity.email, 320),
            displayName: str(identity.displayName, 200),
            ssoUserId: str(identity.ssoUserId, 120),
            employeeId: str(identity.employeeId, 60),
            ipAddress: clientIp(req),
            userAgent: str(req.headers["user-agent"], 500),
            metadata,
          });
        }
      }
    } catch {
      /* fail silent — tracking must never affect the app */
    }
    res.status(204).end();
  };
}
