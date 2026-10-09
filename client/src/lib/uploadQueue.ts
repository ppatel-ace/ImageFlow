/**
 * Durable device-side upload queue (IndexedDB).
 *
 * Photos are written here the moment they are captured (status "draft"), so a refresh,
 * SSO redirect, tablet sleep or app kill never loses them. Tapping Upload flips drafts to
 * "queued"; the runner sends them to POST /api/upload/jobs (idempotent by id) and only
 * drops the image bytes once the server replies 202 (durably staged in Postgres). Status
 * is then polled until the server worker confirms SharePoint upload.
 */
import { isAndroid, isIOS } from "./deviceDetection";

export type QueueStatus =
  | "draft"
  | "queued"
  | "sending"
  | "staged"
  | "uploading"
  | "checkin_pending"
  | "blocked"
  | "done"
  | "failed";

/** Still on this device only — closing the page would stall these until it is reopened. */
export function isUnsentOnDevice(p: Pick<QueuedPhoto, "status" | "blob">): boolean {
  return Boolean(p.blob) && (p.status === "queued" || p.status === "sending");
}

const SERVER_STATUSES: ReadonlySet<string> = new Set([
  "staged",
  "uploading",
  "checkin_pending",
  "blocked",
  "done",
  "failed",
]);

export type UploadMeta = {
  dept: string;
  customerName: string;
  workOrderNumber: string;
  partNumber: string;
  rev: string;
  imageName: string;
};

export type QueuedPhoto = {
  id: string;
  status: QueueStatus;
  blob: Blob | null;
  thumb: Blob | null;
  ext: string;
  source: "camera" | "gallery";
  capturedAt: string;
  nameStem: string;
  nameLocked: boolean;
  sizeBytes: number;
  compressMs: number;
  meta: UploadMeta | null;
  attempts: number;
  lastError: string | null;
  serverFailed: boolean;
  nextAttemptAt: number;
  queuedAt: number | null;
  createdAt: number;
  updatedAt: number;
  webUrl: string | null;
};

const DB_NAME = "imageflow";
const STORE = "photos";
const CONCURRENCY = 3;
const SEND_TIMEOUT_MS = 120_000;
const TICK_MS = 4_000;
const DONE_RETENTION_MS = 24 * 60 * 60 * 1000;
const BACKOFF_S = [2, 5, 15, 30, 60, 120, 300];
const CHANNEL = "imageflow-upload-queue";

// ---------- IndexedDB ----------

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Photos the browser's device store could not hold. They still upload from memory,
 * but only while this page stays open — so the UI warns and we keep trying to move
 * them back into IndexedDB.
 */
const memoryPhotos = new Map<string, QueuedPhoto>();

export type StorageProblem = {
  kind: "quota" | "unavailable";
  detail: string;
  usageMb: number | null;
  quotaMb: number | null;
  at: number;
};
let storageProblem: StorageProblem | null = null;

export function getStorageProblem(): StorageProblem | null {
  return storageProblem;
}

export function isHeldInMemory(id: string): boolean {
  return memoryPhotos.has(id);
}

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    const opening: Promise<IDBDatabase> = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new DOMException("IndexedDB is not available in this browser", "NotSupportedError"));
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("status", "status");
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Android Chrome closes connections when a tab is frozen or memory is low;
        // forget this one so the next call reopens instead of failing forever.
        const forget = () => {
          if (dbPromise === opening) dbPromise = null;
        };
        db.onclose = forget;
        db.onversionchange = () => {
          db.close();
          forget();
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new DOMException("Could not open device storage", "UnknownError"));
    });
    dbPromise = opening;
    opening.catch(() => {
      if (dbPromise === opening) dbPromise = null;
    });
  }
  return dbPromise;
}

function errorName(err: unknown): string {
  return (err && typeof err === "object" && "name" in err ? String((err as any).name) : "") || "Error";
}

function isQuotaError(err: unknown): boolean {
  return errorName(err) === "QuotaExceededError" || /quota/i.test(String((err as any)?.message ?? ""));
}

/** Errors that mean the connection is stale, not that storage is full. */
function isConnectionError(err: unknown): boolean {
  const name = errorName(err);
  return (
    name === "InvalidStateError" ||
    name === "TransactionInactiveError" ||
    name === "UnknownError" ||
    /clos(ed|ing)/i.test(String((err as any)?.message ?? ""))
  );
}

function runTx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    let t: IDBTransaction;
    let req: IDBRequest<T> | void;
    try {
      t = db.transaction(STORE, mode);
      req = fn(t.objectStore(STORE));
    } catch (err) {
      reject(err);
      return;
    }
    const fail = () => reject(t.error ?? new DOMException("Device storage transaction aborted", "AbortError"));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = fail;
    t.onabort = fail;
  });
}

async function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  try {
    return await runTx(await openDb(), mode, fn);
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    dbPromise = null;
    return runTx(await openDb(), mode, fn);
  }
}

/** Make room without touching unsent photos: drop finished rows and duplicate thumbnails. */
async function freeDeviceSpace(): Promise<void> {
  const rows = (await tx<QueuedPhoto[]>("readonly", (s) => s.getAll())) ?? [];
  const done = rows.filter((p) => p.status === "done").map((p) => p.id);
  // A thumb the same size as the blob is the original stored twice (compression fallback).
  const slim = rows.filter((p) => p.status !== "done" && p.thumb && p.blob && p.thumb.size === p.blob.size);
  await tx("readwrite", (s) => {
    for (const id of done) s.delete(id);
    for (const p of slim) s.put({ ...p, thumb: null });
  });
}

async function writeWithRecovery(fn: (store: IDBObjectStore) => void): Promise<void> {
  try {
    await tx("readwrite", fn);
  } catch (err) {
    if (!isQuotaError(err)) throw err;
    await freeDeviceSpace().catch(() => {});
    await tx("readwrite", fn);
  }
}

async function noteStorageProblem(err: unknown): Promise<void> {
  const kind = isQuotaError(err) ? "quota" : "unavailable";
  if (storageProblem?.kind === kind && Date.now() - storageProblem.at < 60_000) return;
  let usageMb: number | null = null;
  let quotaMb: number | null = null;
  try {
    const est = await (navigator as any).storage?.estimate?.();
    if (est?.usage !== undefined) usageMb = Math.round(est.usage / 1048576);
    if (est?.quota !== undefined) quotaMb = Math.round(est.quota / 1048576);
  } catch {
    /* estimate unsupported */
  }
  const firstTime = storageProblem === null;
  storageProblem = {
    kind,
    detail: `${errorName(err)}: ${String((err as any)?.message ?? err).slice(0, 160)}`,
    usageMb,
    quotaMb,
    at: Date.now(),
  };
  console.error("[uploadQueue] device storage problem:", storageProblem, err);
  if (firstTime) emitChange();
}

/** Plain-language explanation for toasts/banners. */
export function describeStorageProblem(p: StorageProblem | null = storageProblem): string {
  if (!p) return "";
  const usage =
    p.usageMb !== null && p.quotaMb !== null ? ` (this site is using ${p.usageMb} MB of the ${p.quotaMb} MB the browser allows)` : "";
  const privateHint =
    p.quotaMb !== null && p.quotaMb < 300 ? " If this is a private/incognito tab, open ImageFlow in a normal tab." : "";
  return p.kind === "quota"
    ? `The browser's storage limit for ImageFlow is full${usage} — this is separate from the tablet's free space.${privateHint}`
    : `The browser could not save photos on this device (${p.detail}).`;
}

export async function listPhotos(): Promise<QueuedPhoto[]> {
  let rows: QueuedPhoto[] = [];
  try {
    rows = (await tx<QueuedPhoto[]>("readonly", (s) => s.getAll())) ?? [];
  } catch (err) {
    await noteStorageProblem(err);
  }
  const byId = new Map(rows.map((p) => [p.id, p]));
  memoryPhotos.forEach((p, id) => byId.set(id, p));
  return Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt);
}

async function getPhoto(id: string): Promise<QueuedPhoto | undefined> {
  const held = memoryPhotos.get(id);
  if (held) return held;
  try {
    return await tx<QueuedPhoto>("readonly", (s) => s.get(id));
  } catch (err) {
    await noteStorageProblem(err);
    return undefined;
  }
}

/** Returns false when the photo could only be kept in memory. Never throws. */
async function putPhoto(photo: QueuedPhoto): Promise<boolean> {
  if (memoryPhotos.has(photo.id)) {
    memoryPhotos.set(photo.id, photo);
    return false;
  }
  try {
    await writeWithRecovery((s) => {
      s.put(photo);
    });
    return true;
  } catch (err) {
    await noteStorageProblem(err);
    memoryPhotos.set(photo.id, photo);
    return false;
  }
}

/** Move memory-only photos back into IndexedDB once it works again. */
async function flushMemoryToDevice(): Promise<void> {
  if (memoryPhotos.size === 0) return;
  for (const [id, photo] of Array.from(memoryPhotos.entries())) {
    if (photo.status === "done") {
      memoryPhotos.delete(id);
      continue;
    }
    try {
      await writeWithRecovery((s) => {
        s.put(photo);
      });
      memoryPhotos.delete(id);
    } catch {
      return;
    }
  }
  if (memoryPhotos.size === 0 && storageProblem) {
    storageProblem = null;
    emitChange();
  }
}

export async function updatePhoto(
  id: string,
  patch: Partial<QueuedPhoto>,
  notify = true,
): Promise<QueuedPhoto | undefined> {
  const current = await getPhoto(id);
  if (!current) return undefined;
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await putPhoto(next);
  if (notify) emitChange();
  return next;
}

/** Returns false when the photo is held in memory only (device store unavailable or full). */
export async function saveDraft(photo: QueuedPhoto): Promise<boolean> {
  const persisted = await putPhoto(photo);
  emitChange();
  return persisted;
}

export async function removePhoto(id: string): Promise<void> {
  await removePhotos([id]);
}

export async function removePhotos(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  for (const id of ids) memoryPhotos.delete(id);
  try {
    await tx("readwrite", (s) => {
      for (const id of ids) s.delete(id);
    });
  } catch (err) {
    await noteStorageProblem(err);
  }
  emitChange();
}

// ---------- change notifications ----------

type Listener = () => void;
const listeners = new Set<Listener>();
let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === "undefined") return channel;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = () => listeners.forEach((l) => l());
  return channel;
}

function emitChange(): void {
  listeners.forEach((l) => l());
  getChannel()?.postMessage("changed");
}

export function subscribeQueue(listener: Listener): () => void {
  listeners.add(listener);
  getChannel();
  return () => listeners.delete(listener);
}

// ---------- queue actions ----------

export function newPhotoId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Upsert full records as "queued" (works even if the draft write never landed).
 * Never blocks the upload: if the device store fails, photos upload from memory.
 * Returns false when any photo is held in memory only.
 */
export async function enqueuePhotos(photos: QueuedPhoto[]): Promise<boolean> {
  const now = Date.now();
  const queued = photos.map((p) => ({ ...p, status: "queued" as const, nextAttemptAt: now, queuedAt: now, updatedAt: now }));
  const onDevice = queued.filter((p) => !memoryPhotos.has(p.id));
  for (const p of queued) if (memoryPhotos.has(p.id)) memoryPhotos.set(p.id, p);
  let persisted = onDevice.length === queued.length;
  if (onDevice.length > 0) {
    try {
      await writeWithRecovery((s) => {
        for (const p of onDevice) s.put(p);
      });
    } catch (err) {
      await noteStorageProblem(err);
      for (const p of onDevice) memoryPhotos.set(p.id, p);
      persisted = false;
    }
  }
  emitChange();
  kickUploadRunner();
  return persisted;
}

export async function retryPhoto(id: string): Promise<void> {
  const photo = await getPhoto(id);
  if (!photo) return;
  if (photo.serverFailed) {
    const res = await fetch(`/api/upload/jobs/${encodeURIComponent(id)}/retry`, {
      method: "POST",
      credentials: "include",
    });
    if (res.ok) {
      await updatePhoto(id, { status: "staged", serverFailed: false, lastError: null });
    } else {
      const body = await res.json().catch(() => ({}) as any);
      await updatePhoto(id, { lastError: body?.error || `Retry failed (HTTP ${res.status})` });
    }
  } else if (photo.blob) {
    await updatePhoto(id, {
      status: "queued",
      attempts: 0,
      lastError: null,
      nextAttemptAt: Date.now(),
    });
  }
  kickUploadRunner();
}

export async function clearFinished(): Promise<void> {
  const all = await listPhotos();
  await removePhotos(all.filter((p) => p.status === "done").map((p) => p.id));
}

// ---------- runner ----------

type RunnerOptions = { onAuthRequired?: (loginUrl: string) => void };

let runnerStarted = false;
let runnerOptions: RunnerOptions = {};
let pumping = false;
let pumpAgain = false;
let authBlocked = false;
const inflight = new Set<string>();
const AUTH_REDIRECT_KEY = "imageflow-auth-redirect-at";
const AUTH_REDIRECT_COOLDOWN_MS = 60_000;
let wakeLock: { release: () => Promise<void>; released?: boolean } | null = null;

/** Send the user to SSO once; photos stay in IndexedDB and resume after login. */
function requestLogin(loginUrl: string): void {
  authBlocked = true;
  try {
    const last = Number(sessionStorage.getItem(AUTH_REDIRECT_KEY) || 0);
    if (Date.now() - last < AUTH_REDIRECT_COOLDOWN_MS) return;
    sessionStorage.setItem(AUTH_REDIRECT_KEY, String(Date.now()));
  } catch {
    /* storage unavailable — redirect anyway */
  }
  runnerOptions.onAuthRequired?.(loginUrl);
}

/** After a 401, check whether the session works again (e.g. refreshed in another tab). */
async function probeAuth(): Promise<void> {
  try {
    const res = await fetch("/api/upload/jobs?ids=", { credentials: "include" });
    if (res.ok) authBlocked = false;
  } catch {
    /* offline — try next tick */
  }
}

/** Keep the screen awake while photos are still on this device, so the tablet does not sleep mid-send. */
async function syncWakeLock(photos: QueuedPhoto[]): Promise<void> {
  const nav = navigator as any;
  if (!nav.wakeLock?.request) return;
  const needed = photos.some(isUnsentOnDevice);
  if (needed && (!wakeLock || wakeLock.released) && document.visibilityState === "visible") {
    try {
      wakeLock = await nav.wakeLock.request("screen");
    } catch {
      wakeLock = null;
    }
  } else if (!needed && wakeLock && !wakeLock.released) {
    await wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

function deviceLabel(): string {
  const cap = (window as any).Capacitor;
  if (cap?.isNativePlatform?.()) return "android-app";
  if (isAndroid()) return "android-browser";
  if (isIOS()) return "ios-browser";
  return "desktop-browser";
}

function backoffMs(attempts: number): number {
  const base = BACKOFF_S[Math.min(attempts - 1, BACKOFF_S.length - 1)] * 1000;
  return base + Math.round(base * 0.3 * Math.random());
}

function buildForm(photo: QueuedPhoto, includeJobId: boolean): FormData {
  const meta = photo.meta!;
  const form = new FormData();
  if (includeJobId) form.append("jobId", photo.id);
  form.append("customerName", meta.customerName);
  form.append("dept", meta.dept);
  form.append("workOrderNumber", meta.workOrderNumber);
  form.append("imageName", meta.imageName);
  form.append("partNumber", meta.partNumber);
  form.append("rev", meta.rev);
  const blob = photo.blob!;
  form.append(
    "imageFile",
    new File([blob], `${meta.imageName}.${photo.ext}`, { type: blob.type || "image/jpeg" }),
  );
  return form;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, credentials: "include", signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

async function scheduleRetry(photo: QueuedPhoto, message: string): Promise<void> {
  const attempts = photo.attempts + 1;
  await updatePhoto(photo.id, {
    status: "queued",
    attempts,
    lastError: message,
    nextAttemptAt: Date.now() + backoffMs(attempts),
  });
}

async function sendLegacy(photo: QueuedPhoto): Promise<void> {
  const res = await fetchWithTimeout("/api/upload/sharepoint", {
    method: "POST",
    body: buildForm(photo, false),
  });
  const body = await res.json().catch(() => ({}) as any);
  if (res.ok) {
    await updatePhoto(photo.id, {
      status: "done",
      blob: null,
      lastError: null,
      webUrl: body?.webUrl ?? null,
    });
    return;
  }
  await scheduleRetry(photo, body?.message || body?.error || `HTTP ${res.status}`);
}

async function sendOne(photo: QueuedPhoto): Promise<void> {
  if (!photo.blob || !photo.meta) {
    await updatePhoto(photo.id, { status: "failed", lastError: "Photo data missing on device" });
    return;
  }
  inflight.add(photo.id);
  await updatePhoto(photo.id, { status: "sending" });
  const attempt = photo.attempts + 1;
  try {
    const res = await fetchWithTimeout("/api/upload/jobs", {
      method: "POST",
      body: buildForm(photo, true),
      headers: {
        "x-imageflow-device": deviceLabel(),
        "x-imageflow-client-ms": JSON.stringify({
          compressMs: photo.compressMs,
          waitMs: photo.queuedAt ? Date.now() - photo.queuedAt : 0,
          attempt,
          bytes: photo.blob.size,
        }),
      },
    });
    const body = await res.json().catch(() => ({}) as any);

    if (res.status === 202 || res.ok) {
      const status: QueueStatus = SERVER_STATUSES.has(body?.status) ? body.status : "staged";
      await updatePhoto(photo.id, {
        status,
        blob: null,
        lastError: null,
        attempts: attempt,
        webUrl: body?.webUrl ?? null,
      });
      return;
    }
    if (res.status === 401 && body?.ssoLoginUrl) {
      await updatePhoto(photo.id, { status: "queued" });
      requestLogin(body.ssoLoginUrl);
      return;
    }
    if (res.status === 403) {
      await updatePhoto(photo.id, {
        status: "failed",
        attempts: attempt,
        lastError:
          "Your account does not have access to ImageFlow. Ask IT to grant access, then tap Retry — the photo is kept on this device.",
      });
      return;
    }
    if (res.status === 503 && body?.fallback === "sync") {
      await sendLegacy(photo);
      return;
    }
    if (res.status === 400 || res.status === 409 || res.status === 413) {
      await updatePhoto(photo.id, {
        status: "failed",
        attempts: attempt,
        lastError: body?.message || body?.error || `Rejected (HTTP ${res.status})`,
      });
      return;
    }
    await scheduleRetry(photo, body?.message || body?.error || `Server error (HTTP ${res.status})`);
  } catch (err: any) {
    await scheduleRetry(
      photo,
      err?.name === "AbortError"
        ? "Upload timed out — will retry"
        : "Network unavailable — will retry",
    );
  } finally {
    inflight.delete(photo.id);
  }
}

async function pollServer(photos: QueuedPhoto[]): Promise<void> {
  const waiting = photos.filter(
    (p) =>
      p.status === "staged" ||
      p.status === "uploading" ||
      p.status === "checkin_pending" ||
      p.status === "blocked",
  );
  for (let i = 0; i < waiting.length; i += 100) {
    const batch = waiting.slice(i, i + 100);
    const res = await fetch(
      `/api/upload/jobs?ids=${batch.map((p) => encodeURIComponent(p.id)).join(",")}`,
      { credentials: "include" },
    );
    if (res.status === 401) {
      const body = await res.json().catch(() => ({}) as any);
      if (body?.ssoLoginUrl) requestLogin(body.ssoLoginUrl);
      return;
    }
    if (!res.ok) return;
    const body = (await res.json().catch(() => ({}))) as {
      items?: { id: string; status: string; lastError: string | null; webUrl: string | null }[];
      databaseConfigured?: boolean;
    };
    if (body.databaseConfigured === false) return;
    const byId = new Map((body.items ?? []).map((it) => [it.id, it]));
    let changed = false;
    for (const photo of batch) {
      const item = byId.get(photo.id);
      if (!item) {
        await updatePhoto(
          photo.id,
          { status: "failed", lastError: "Server has no record of this photo" },
          false,
        );
        changed = true;
        continue;
      }
      const status: QueueStatus = SERVER_STATUSES.has(item.status)
        ? (item.status as QueueStatus)
        : "staged";
      if (status !== photo.status || item.lastError !== photo.lastError) {
        await updatePhoto(
          photo.id,
          {
            status,
            lastError: item.lastError,
            serverFailed: status === "failed",
            webUrl: item.webUrl ?? photo.webUrl,
          },
          false,
        );
        changed = true;
      }
    }
    if (changed) emitChange();
  }
}

async function runPump(): Promise<void> {
  await flushMemoryToDevice();
  const all = await listPhotos();
  const now = Date.now();

  const expired = all.filter((p) => p.status === "done" && now - p.updatedAt > DONE_RETENTION_MS);
  if (expired.length) await removePhotos(expired.map((p) => p.id));

  // A "sending" row not owned by this tab was orphaned by a closed tab/app kill.
  for (const p of all) {
    if (p.status === "sending" && !inflight.has(p.id)) {
      p.status = "queued";
      await updatePhoto(p.id, { status: "queued" }, false);
    }
  }

  await syncWakeLock(all);

  if (typeof navigator !== "undefined" && navigator.onLine === false) return;

  if (authBlocked) await probeAuth();

  if (!authBlocked) {
    const due = all.filter(
      (p) => p.status === "queued" && p.nextAttemptAt <= now && !inflight.has(p.id),
    );
    let index = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, due.length) }, async () => {
      while (index < due.length && !authBlocked) {
        const next = due[index++];
        await sendOne(next);
      }
    });
    await Promise.all(workers);
  }

  try {
    const latest = await listPhotos();
    await syncWakeLock(latest);
    await pollServer(latest);
  } catch {
    /* offline or server down — next tick retries */
  }
}

async function withRunnerLock(fn: () => Promise<void>): Promise<void> {
  const locks = (navigator as any).locks;
  if (locks?.request) {
    await locks.request("imageflow-upload-runner", { ifAvailable: true }, async (lock: unknown) => {
      if (lock) await fn();
    });
    return;
  }
  await fn();
}

async function pump(): Promise<void> {
  if (pumping) {
    pumpAgain = true;
    return;
  }
  pumping = true;
  try {
    do {
      pumpAgain = false;
      await withRunnerLock(runPump);
    } while (pumpAgain);
  } catch (err) {
    console.warn("[uploadQueue] pump failed:", err);
  } finally {
    pumping = false;
  }
}

export function kickUploadRunner(): void {
  if (!runnerStarted) return;
  void pump();
}

export function startUploadRunner(options: RunnerOptions = {}): () => void {
  runnerOptions = options;
  if (runnerStarted) return () => {};
  runnerStarted = true;
  authBlocked = false;

  const nav = navigator as any;
  if (nav.storage?.persist) {
    nav.storage.persist().catch(() => {});
  }

  const onOnline = () => kickUploadRunner();
  const onVisible = () => {
    if (document.visibilityState === "visible") kickUploadRunner();
  };
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);
  const timer = window.setInterval(() => kickUploadRunner(), TICK_MS);
  void pump();

  return () => {
    runnerStarted = false;
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisible);
    window.clearInterval(timer);
    void wakeLock?.release().catch(() => {});
    wakeLock = null;
  };
}
