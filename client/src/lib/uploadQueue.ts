/**
 * Durable device-side upload queue (IndexedDB).
 *
 * Photos are written here the moment they are captured (status "draft"), so a refresh,
 * SSO redirect, tablet sleep or app kill never loses them. Tapping Upload flips drafts to
 * "queued"; the runner sends them to POST /api/upload/jobs (idempotent by id) and only
 * drops the image bytes once the server replies 202 (durably staged in Postgres). Status
 * is then polled until the server worker confirms SharePoint upload.
 */
import { deviceLabel, reportClientEvent } from "./clientEvents";

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

/**
 * Errors worth one retry on a fresh connection: a stale connection, or a transaction
 * Chrome aborted without saying why (seen on Android under memory pressure).
 */
function isConnectionError(err: unknown): boolean {
  const name = errorName(err);
  return (
    name === "InvalidStateError" ||
    name === "TransactionInactiveError" ||
    name === "UnknownError" ||
    name === "AbortError" ||
    /clos(ed|ing)/i.test(String((err as any)?.message ?? ""))
  );
}

/**
 * Photo bytes as stored when Chrome refuses a Blob write. Rows normally hold Blobs
 * (lazy, file-backed, cheap to list); only rows whose Blob write aborted hold bytes.
 */
type StoredBytes = { bytes: ArrayBuffer; type: string };
type StoredPhoto = Omit<QueuedPhoto, "blob" | "thumb"> & {
  blob: Blob | StoredBytes | null;
  thumb: Blob | StoredBytes | null;
};

function isStoredBytes(v: unknown): v is StoredBytes {
  return Boolean(v) && typeof v === "object" && (v as StoredBytes).bytes instanceof ArrayBuffer;
}

function bytesToBlob(v: Blob | StoredBytes | null): Blob | null {
  if (!v) return null;
  return isStoredBytes(v) ? new Blob([v.bytes], { type: v.type }) : v;
}

function fromStored(row: StoredPhoto): QueuedPhoto {
  return { ...row, blob: bytesToBlob(row.blob), thumb: bytesToBlob(row.thumb) };
}

async function blobToBytes(b: Blob | null): Promise<StoredBytes | null> {
  if (!b) return null;
  return { bytes: await b.arrayBuffer(), type: b.type || "image/jpeg" };
}

async function toStoredBytes(p: QueuedPhoto): Promise<StoredPhoto> {
  const cached = p.blob ? photoBytes.get(p.id) : undefined;
  const blob = cached ? { bytes: cached, type: p.blob?.type || "image/jpeg" } : await blobToBytes(p.blob);
  const thumb = p.thumb === p.blob ? blob : await blobToBytes(p.thumb).catch(() => null);
  return { ...p, blob, thumb };
}

/**
 * Compressed upload bytes kept on the JS heap for photos taken in this page.
 * Some tablets' Chrome can't read Blobs back (IndexedDB and in-memory alike), so sends
 * and the bytes fallback use these instead of the Blob whenever they exist.
 */
const photoBytes = new Map<string, ArrayBuffer>();

export function rememberPhotoBytes(id: string, bytes: ArrayBuffer): void {
  photoBytes.set(id, bytes);
}

/** Upload bytes for a photo: page-memory copy first, else read the stored Blob. */
async function readPhotoBytes(p: QueuedPhoto): Promise<ArrayBuffer | null> {
  const cached = photoBytes.get(p.id);
  if (cached) return cached;
  if (!p.blob) return null;
  try {
    const bytes = await p.blob.arrayBuffer();
    photoBytes.set(p.id, bytes);
    return bytes;
  } catch (err) {
    reportClientEvent("blob_unreadable", `${errorName(err)}: ${String((err as any)?.message ?? "")}`);
    return null;
  }
}

/** Memory-only copy; sends read the page-memory bytes, so the Blob only feeds thumbnails. */
async function toMemoryCopy(p: QueuedPhoto): Promise<QueuedPhoto> {
  if (photoBytes.has(p.id)) return p;
  try {
    return fromStored(await toStoredBytes(p));
  } catch {
    return p;
  }
}

function storedSize(v: Blob | StoredBytes | null): number {
  if (!v) return 0;
  return isStoredBytes(v) ? v.bytes.byteLength : v.size;
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
  const rows = (await tx<StoredPhoto[]>("readonly", (s) => s.getAll())) ?? [];
  const done = rows.filter((p) => p.status === "done").map((p) => p.id);
  // A thumb the same size as the blob is the original stored twice (compression fallback).
  const slim = rows.filter(
    (p) => p.status !== "done" && p.thumb && p.blob && storedSize(p.thumb) === storedSize(p.blob),
  );
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

/** Put full photo rows; if Chrome keeps aborting the Blob write, store the bytes instead. */
async function writePhotos(photos: QueuedPhoto[]): Promise<void> {
  try {
    await writeWithRecovery((s) => {
      for (const p of photos) s.put(p);
    });
  } catch (err) {
    if (errorName(err) !== "AbortError" && errorName(err) !== "UnknownError") throw err;
    const stored = await Promise.all(photos.map(toStoredBytes));
    await writeWithRecovery((s) => {
      for (const p of stored) s.put(p);
    });
    reportClientEvent("storage_problem", `blob write aborted (${errorName(err)}); stored as bytes`);
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
  reportClientEvent(
    "storage_problem",
    `${kind}: ${storageProblem.detail}${usageMb !== null ? ` usage=${usageMb}MB/${quotaMb}MB` : ""}`,
  );
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
    rows = ((await tx<StoredPhoto[]>("readonly", (s) => s.getAll())) ?? []).map(fromStored);
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
    const row = await tx<StoredPhoto>("readonly", (s) => s.get(id));
    return row ? fromStored(row) : undefined;
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
    await writePhotos([photo]);
    return true;
  } catch (err) {
    await noteStorageProblem(err);
    memoryPhotos.set(photo.id, await toMemoryCopy(photo));
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
      await writePhotos([photo]);
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
  if (patch.blob === null) photoBytes.delete(id);
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
  for (const id of ids) {
    memoryPhotos.delete(id);
    photoBytes.delete(id);
  }
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
      await writePhotos(onDevice);
    } catch (err) {
      await noteStorageProblem(err);
      for (const p of onDevice) memoryPhotos.set(p.id, await toMemoryCopy(p));
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

function backoffMs(attempts: number): number {
  const base = BACKOFF_S[Math.min(attempts - 1, BACKOFF_S.length - 1)] * 1000;
  return base + Math.round(base * 0.3 * Math.random());
}

type MultipartBody = { body: Uint8Array; contentType: string };

/**
 * multipart/form-data built from bytes: FormData + Blob would go back through the
 * browser's Blob storage, which is exactly what fails on the affected tablets.
 */
export function buildMultipart(photo: QueuedPhoto, bytes: ArrayBuffer, includeJobId: boolean): MultipartBody {
  const meta = photo.meta!;
  const boundary = `----ImageFlow${newPhotoId().replace(/-/g, "")}`;
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const field = (name: string, value: string) =>
    chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  if (includeJobId) field("jobId", photo.id);
  field("customerName", meta.customerName);
  field("dept", meta.dept);
  field("workOrderNumber", meta.workOrderNumber);
  field("imageName", meta.imageName);
  field("partNumber", meta.partNumber);
  field("rev", meta.rev);
  const fileName = `${meta.imageName}.${photo.ext}`.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const type = photo.blob?.type || "image/jpeg";
  chunks.push(
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="imageFile"; filename="${fileName}"\r\nContent-Type: ${type}\r\n\r\n`,
    ),
  );
  chunks.push(new Uint8Array(bytes));
  chunks.push(enc.encode(`\r\n--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
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

async function sendLegacy(photo: QueuedPhoto, bytes: ArrayBuffer): Promise<void> {
  const multipart = buildMultipart(photo, bytes, false);
  const res = await fetchWithTimeout("/api/upload/sharepoint", {
    method: "POST",
    body: multipart.body,
    headers: { "Content-Type": multipart.contentType },
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

function describeSendError(err: unknown): string {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "Offline — will send when back online";
  }
  if (errorName(err) === "AbortError") return "Upload timed out — will retry";
  const message = String((err as any)?.message ?? "").slice(0, 120);
  return `Could not reach ImageFlow — will retry (${errorName(err)}${message ? `: ${message}` : ""})`;
}

async function sendOne(photo: QueuedPhoto): Promise<void> {
  if (!photo.blob || !photo.meta) {
    await updatePhoto(photo.id, { status: "failed", lastError: "Photo data missing on device" });
    return;
  }
  // fetch() fails like a network error when the body can't be read, so get the bytes first.
  const bytes = await readPhotoBytes(photo);
  if (!bytes) {
    await updatePhoto(photo.id, {
      status: "failed",
      lastError: "Photo data was lost on this device — please retake.",
    });
    return;
  }
  inflight.add(photo.id);
  await updatePhoto(photo.id, { status: "sending" });
  const attempt = photo.attempts + 1;
  try {
    const multipart = buildMultipart(photo, bytes, true);
    const res = await fetchWithTimeout("/api/upload/jobs", {
      method: "POST",
      body: multipart.body,
      headers: {
        "Content-Type": multipart.contentType,
        "x-imageflow-device": deviceLabel(),
        "x-imageflow-client-ms": JSON.stringify({
          compressMs: photo.compressMs,
          waitMs: photo.queuedAt ? Date.now() - photo.queuedAt : 0,
          attempt,
          bytes: bytes.byteLength,
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
      await sendLegacy(photo, bytes);
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
  } catch (err) {
    const message = describeSendError(err);
    if (navigator.onLine !== false) reportClientEvent("send_error", message);
    await scheduleRetry(photo, message);
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
