/**
 * SharePoint uploads via Azure AD app client credentials (GCC High).
 * Token: login.microsoftonline.us → Graph: graph.microsoft.us
 * Auth: AZURE_CLIENT_SECRET, or certificate (PEM/key or Portainer base64 — preferred for Workload ID CA).
 * Prefer SHAREPOINT_SITE_ID when using Sites.Selected (hostname lookup often 403s).
 * Folder layout: {QC|Testing|Production}/{Customer}/{WorkOrder}/
 */

import { createHash, createSign, randomUUID, X509Certificate } from "crypto";
import { existsSync, readFileSync } from "fs";

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;
let cachedSiteId: string | null = null;
let cachedDriveId: string | null = null;

const GRAPH_BASE = "https://graph.microsoft.us/v1.0";
const TOKEN_URL_BASE = "https://login.microsoftonline.us";
const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/**
 * SharePoint/OneDrive folder & file names cannot contain <>:"/\|?*
 * and must not start/end with a space or period (e.g. "CACI TECHNOLOGIES, INC.").
 */
function sanitizePathSegment(value: string): string {
  let name = value
    .replace(/[<>:"/\\|?*#%\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  // Strip leading/trailing dots and spaces (SharePoint 400 if name ends with ".")
  name = name.replace(/^[.\s]+|[.\s]+$/g, "");
  // Avoid reserved device names / empty after sanitize
  if (!name) name = "_";
  return name;
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function base64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeBase64Env(name: string): Buffer {
  const raw = requireEnv(name);
  try {
    return Buffer.from(raw, "base64");
  } catch {
    throw new Error(`Invalid base64 in ${name}`);
  }
}

function hasCertificateConfigured(): boolean {
  return Boolean(
    process.env.AZURE_CLIENT_CERT_PEM_BASE64?.trim() ||
      process.env.AZURE_CLIENT_CERT_PATH?.trim(),
  );
}

function loadClientCertificate(): { privateKeyPem: string; x5tS256: string } {
  let certRaw: Buffer;
  let keyPem: string;

  const pemB64 = process.env.AZURE_CLIENT_CERT_PEM_BASE64?.trim();
  if (pemB64) {
    certRaw = decodeBase64Env("AZURE_CLIENT_CERT_PEM_BASE64");
    keyPem = decodeBase64Env("AZURE_CLIENT_CERT_KEY_BASE64").toString("utf8");
  } else {
    const certPath = requireEnv("AZURE_CLIENT_CERT_PATH");
    const keyPath =
      process.env.AZURE_CLIENT_CERT_KEY_PATH?.trim() ||
      certPath.replace(/\.(pem|cer|crt)$/i, ".key");

    if (!existsSync(certPath)) {
      throw new Error(`AZURE_CLIENT_CERT_PATH not found: ${certPath}`);
    }
    if (!existsSync(keyPath)) {
      throw new Error(`Private key not found: ${keyPath}`);
    }

    certRaw = readFileSync(certPath);
    keyPem = readFileSync(keyPath, "utf8");
  }

  // Accept PEM or DER (.cer)
  const x509 = new X509Certificate(certRaw);
  const x5tS256 = base64Url(createHash("sha256").update(x509.raw).digest());

  return { privateKeyPem: keyPem, x5tS256 };
}

function buildClientAssertion(tokenUrl: string, clientId: string): string {
  const { privateKeyPem, x5tS256 } = loadClientCertificate();
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(
    Buffer.from(
      JSON.stringify({
        alg: "RS256",
        typ: "JWT",
        "x5t#S256": x5tS256,
      }),
    ),
  );
  const payload = base64Url(
    Buffer.from(
      JSON.stringify({
        aud: tokenUrl,
        iss: clientId,
        sub: clientId,
        jti: randomUUID(),
        nbf: now - 60,
        exp: now + 600,
      }),
    ),
  );
  const data = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  const signature = base64Url(signer.sign(privateKeyPem));
  return `${data}.${signature}`;
}

export function getAzureCredentialMode(): "secret" | "certificate" | "none" {
  const secret = process.env.AZURE_CLIENT_SECRET?.trim();
  const secretLooksLikeGuidOnly =
    !!secret &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(secret);

  if (secret && !secretLooksLikeGuidOnly) return "secret";
  if (hasCertificateConfigured()) return "certificate";
  return "none";
}

/** Prefer certificate for Workload ID; skip Secret-ID mistakes so cert can take over. */
function applyClientCredential(params: URLSearchParams, tokenUrl: string, clientId: string): void {
  const secret = process.env.AZURE_CLIENT_SECRET?.trim();
  const secretLooksLikeGuidOnly =
    !!secret &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(secret);

  if (secret && !secretLooksLikeGuidOnly) {
    params.set("client_secret", secret);
    return;
  }

  if (hasCertificateConfigured()) {
    params.set("client_assertion_type", CLIENT_ASSERTION_TYPE);
    params.set("client_assertion", buildClientAssertion(tokenUrl, clientId));
    return;
  }

  if (secretLooksLikeGuidOnly) {
    throw new Error(
      "AZURE_CLIENT_SECRET looks like a Secret ID (GUID), not the secret Value. " +
        "Delete AZURE_CLIENT_SECRET in Portainer and use certificate auth " +
        "(AZURE_CLIENT_CERT_PEM_BASE64 + AZURE_CLIENT_CERT_KEY_BASE64).",
    );
  }

  throw new Error(
    "Missing Azure credentials: set AZURE_CLIENT_CERT_PEM_BASE64 + AZURE_CLIENT_CERT_KEY_BASE64 (Portainer), " +
      "or AZURE_CLIENT_CERT_PATH (+ key), or AZURE_CLIENT_SECRET (secret Value, not Secret ID).",
  );
}

function sitesPermissionHint(status: number, body: string): string {
  if (status !== 403 && status !== 401) return "";
  return (
    ` Azure app lacks SharePoint access. Fix (GCC High admin): ` +
    `(1) App registration → API permissions → Microsoft Graph application ` +
    `Sites.Selected (or Sites.ReadWrite.All) + admin consent. ` +
    `(2) Grant that app Write on the site ` +
    `(Grant-PnPAzureADAppSitePermission / Graph site permissions). ` +
    `(3) Prefer setting SHAREPOINT_SITE_ID so the app skips site hostname lookup ` +
    `(Sites.Selected often returns 403 on /sites/{host}:{path}). ` +
    `Graph detail: ${body.slice(0, 180)}`
  );
}

async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.accessToken;
  }

  const tenantId = requireEnv("AZURE_TENANT_ID");
  const clientId = requireEnv("AZURE_CLIENT_ID");
  const tokenUrl = `${TOKEN_URL_BASE}/${tenantId}/oauth2/v2.0/token`;

  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    scope: "https://graph.microsoft.us/.default",
  });

  applyClientCredential(params, tokenUrl, clientId);

  const tokenController = new AbortController();
  const tokenTimer = setTimeout(() => tokenController.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
      signal: tokenController.signal,
    });
  } catch (err) {
    const name = err && typeof err === "object" ? (err as { name?: string }).name : "";
    if (name === "AbortError" || name === "TimeoutError") {
      throw new Error("Azure token request timed out after 30000ms");
    }
    throw err;
  } finally {
    clearTimeout(tokenTimer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Azure token request failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    throw new Error("Azure token response missing access_token");
  }

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return tokenCache.accessToken;
}

type GraphRequestInit = RequestInit & { timeoutMs?: number };

const METADATA_TIMEOUT_MS = 30_000;
const CONTENT_TIMEOUT_MS = 120_000;
const SIMPLE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
/** Graph upload-session chunks must be multiples of 320 KiB (except the last). */
const UPLOAD_CHUNK_BYTES = 320 * 1024 * 16; // 5,242,880
const MAX_GRAPH_ATTEMPTS = 3;

const ensuredFolders = new Set<string>();

function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBinaryBody(body: BodyInit | null | undefined): boolean {
  return (
    typeof Buffer !== "undefined" &&
    (body instanceof Buffer || body instanceof Uint8Array)
  );
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "AbortError" || name === "TimeoutError";
}

function retryAfterMs(res: Response, attempt: number): number {
  const raw = res.headers.get("Retry-After");
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed * 1000, 15_000);
  return Math.min(1000 * 2 ** (attempt - 1), 8_000);
}

async function graphFetch(
  path: string,
  init: GraphRequestInit = {},
): Promise<Response> {
  const { timeoutMs = METADATA_TIMEOUT_MS, signal: userSignal, ...rest } = init;
  const token = await getAccessToken();
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
  const headers = new Headers(rest.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && rest.body && !isBinaryBody(rest.body)) {
    headers.set("Content-Type", "application/json");
  }
  const signal = userSignal ?? timeoutSignal(timeoutMs);
  return fetch(url, { ...rest, headers, signal });
}

async function graphFetchWithRetry(
  path: string,
  init: GraphRequestInit = {},
  maxAttempts = MAX_GRAPH_ATTEMPTS,
): Promise<Response> {
  let lastAbort: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await graphFetch(path, init);
      if (res.status === 429 || res.status === 503) {
        if (attempt === maxAttempts) return res;
        const waitMs = retryAfterMs(res, attempt);
        await res.text().catch(() => "");
        await sleep(waitMs);
        continue;
      }
      return res;
    } catch (err) {
      if (isAbortError(err) && attempt < maxAttempts) {
        lastAbort = err instanceof Error ? err : new Error(String(err));
        await sleep(1000 * attempt);
        continue;
      }
      if (isAbortError(err)) {
        throw new Error(
          `SharePoint request timed out after ${init.timeoutMs ?? METADATA_TIMEOUT_MS}ms`,
        );
      }
      throw err;
    }
  }
  throw lastAbort ?? new Error("SharePoint request failed");
}

async function resolveSiteId(): Promise<string> {
  if (cachedSiteId) return cachedSiteId;

  const configured = process.env.SHAREPOINT_SITE_ID?.trim();
  if (configured) {
    // Validate the app can actually read this site
    const res = await graphFetchWithRetry(`/sites/${configured}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `SHAREPOINT_SITE_ID is set but not accessible (${res.status}).` +
          sitesPermissionHint(res.status, text),
      );
    }
    cachedSiteId = configured;
    return cachedSiteId;
  }

  const hostname =
    process.env.SHAREPOINT_SITE_HOSTNAME?.trim() || "aceelectronics.sharepoint.us";
  const sitePath =
    process.env.SHAREPOINT_SITE_PATH?.trim() || "/sites/jobtravelerphotos";
  const normalizedPath = sitePath.startsWith("/") ? sitePath : `/${sitePath}`;

  // Graph: GET /sites/{hostname}:{server-relative-path}
  // Note: with Sites.Selected this call often 403s — set SHAREPOINT_SITE_ID instead.
  const res = await graphFetchWithRetry(
    `/sites/${encodeURIComponent(hostname)}:${normalizedPath}`,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Failed to resolve SharePoint site (${res.status}).` +
        sitesPermissionHint(res.status, text) +
        (statusIsAccessDenied(res.status)
          ? ` Set SHAREPOINT_SITE_ID to the full Graph site id for ${hostname}${normalizedPath}.`
          : ` Raw: ${text.slice(0, 200)}`),
    );
  }
  const site = (await res.json()) as { id?: string };
  if (!site.id) throw new Error("SharePoint site response missing id");
  cachedSiteId = site.id;
  return cachedSiteId;
}

function statusIsAccessDenied(status: number): boolean {
  return status === 401 || status === 403;
}

async function resolveDriveId(siteId: string): Promise<string> {
  if (cachedDriveId) return cachedDriveId;

  const configured = process.env.SHAREPOINT_DRIVE_ID?.trim();
  if (configured) {
    cachedDriveId = configured;
    return cachedDriveId;
  }

  const res = await graphFetchWithRetry(`/sites/${siteId}/drive`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Failed to resolve default drive (${res.status}).` +
        sitesPermissionHint(res.status, text),
    );
  }
  const drive = (await res.json()) as { id?: string };
  if (!drive.id) throw new Error("SharePoint drive response missing id");
  cachedDriveId = drive.id;
  return cachedDriveId;
}

function driveItemPath(segments: string[]): string {
  return segments.map(encodeURIComponent).join("/");
}

async function ensureFolderPath(driveId: string, folderPath: string): Promise<void> {
  const cacheKey = `${driveId}:${folderPath}`;
  if (ensuredFolders.has(cacheKey)) return;

  const parts = folderPath.split("/").filter(Boolean);
  const built: string[] = [];

  for (const part of parts) {
    const parentSegments = [...built];
    built.push(part);

    const probe = await graphFetchWithRetry(
      `/drives/${driveId}/root:/${driveItemPath(built)}`,
    );
    if (probe.ok) continue;
    if (probe.status !== 404) {
      const text = await probe.text().catch(() => "");
      throw new Error(
        `Failed to check folder ${built.join("/")} (${probe.status}): ${text.slice(0, 200)}` +
          sitesPermissionHint(probe.status, text),
      );
    }

    const createUrl =
      parentSegments.length === 0
        ? `/drives/${driveId}/root/children`
        : `/drives/${driveId}/root:/${driveItemPath(parentSegments)}:/children`;

    const createRes = await graphFetchWithRetry(createUrl, {
      method: "POST",
      body: JSON.stringify({
        name: part,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }),
    });

    // 409 = already created concurrently — treat as success
    if (!createRes.ok && createRes.status !== 409) {
      const text = await createRes.text().catch(() => "");
      throw new Error(
        `Failed to create folder ${part} (${createRes.status}): ${text.slice(0, 200)}` +
          sitesPermissionHint(createRes.status, text),
      );
    }
  }

  ensuredFolders.add(cacheKey);
}

type DriveItemInfo = { id: string; webUrl?: string };

async function getDriveItemInfo(
  driveId: string,
  itemPath: string,
): Promise<DriveItemInfo | null> {
  const segments = itemPath.split("/").filter(Boolean);
  const res = await graphFetchWithRetry(
    `/drives/${driveId}/root:/${driveItemPath(segments)}`,
  );
  if (res.status === 404) {
    await res.text().catch(() => "");
    return null;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Failed to look up SharePoint item ${itemPath} (${res.status}): ${text.slice(0, 200)}` +
        sitesPermissionHint(res.status, text),
    );
  }
  const data = (await res.json()) as { id?: string; webUrl?: string };
  if (!data.id) return null;
  return { id: data.id, webUrl: data.webUrl };
}

function isBenignCheckinFailure(status: number, body: string): boolean {
  if (status === 400 || status === 404 || status === 409) return true;
  return /already checked in|not checked out|no checkout/i.test(body);
}

async function checkInDriveItem(
  driveId: string,
  itemId: string,
  comment: string,
): Promise<void> {
  const res = await graphFetchWithRetry(`/drives/${driveId}/items/${itemId}/checkin`, {
    method: "POST",
    body: JSON.stringify({ comment, checkInAs: "published" }),
  });
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  if (isBenignCheckinFailure(res.status, text)) return;
  throw new Error(
    `SharePoint check-in failed (${res.status}): ${text.slice(0, 200)}` +
      sitesPermissionHint(res.status, text),
  );
}

async function checkoutDriveItem(driveId: string, itemId: string): Promise<void> {
  const res = await graphFetchWithRetry(`/drives/${driveId}/items/${itemId}/checkout`, {
    method: "POST",
  });
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  if (
    res.status === 400 ||
    res.status === 409 ||
    /already checked out|checked.?out/i.test(text)
  ) {
    return;
  }
  throw new Error(
    `SharePoint check-out failed (${res.status}): ${text.slice(0, 200)}` +
      sitesPermissionHint(res.status, text),
  );
}

async function prepareExistingItemForOverwrite(
  driveId: string,
  folderPath: string,
  fileName: string,
): Promise<string | null> {
  const existing = await getDriveItemInfo(driveId, `${folderPath}/${fileName}`);
  if (!existing?.id) return null;
  await checkInDriveItem(
    driveId,
    existing.id,
    `ImageFlow release before overwrite: ${fileName}`,
  );
  await checkoutDriveItem(driveId, existing.id);
  return existing.id;
}

function lockedByOtherMessage(fileName: string, folderPath: string, detail: string): Error {
  return new Error(
    `SharePoint file "${folderPath}/${fileName}" is checked out by another user. ` +
      `Open the file in SharePoint, Check In (or Discard Check Out), then try Upload again. ` +
      `(${detail.slice(0, 200)})`,
  );
}

async function putSimpleContent(
  driveId: string,
  folderPath: string,
  fileName: string,
  fileBuffer: Buffer,
): Promise<DriveItemInfo> {
  const uploadPath = `/drives/${driveId}/root:/${driveItemPath([
    ...folderPath.split("/").filter(Boolean),
    fileName,
  ])}:/content`;

  const uploadRes = await graphFetchWithRetry(uploadPath, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: fileBuffer,
    timeoutMs: CONTENT_TIMEOUT_MS,
  });

  if (!uploadRes.ok) {
    const text = await uploadRes.text().catch(() => "");
    throw new Error(
      `SharePoint upload failed (${uploadRes.status}): ${text.slice(0, 300)}` +
        sitesPermissionHint(uploadRes.status, text),
    );
  }

  const uploaded = (await uploadRes.json().catch(() => ({}))) as {
    id?: string;
    webUrl?: string;
  };
  if (uploaded.id) return { id: uploaded.id, webUrl: uploaded.webUrl };
  const lookedUp = await getDriveItemInfo(driveId, `${folderPath}/${fileName}`);
  if (lookedUp?.id) return lookedUp;
  throw new Error(`SharePoint upload succeeded but returned no item id for ${fileName}`);
}

async function putSessionChunk(
  uploadUrl: string,
  chunk: Buffer,
  offset: number,
  total: number,
): Promise<Response> {
  const end = offset + chunk.length - 1;
  let lastAbort: Error | null = null;
  for (let attempt = 1; attempt <= MAX_GRAPH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(chunk.length),
          "Content-Range": `bytes ${offset}-${end}/${total}`,
        },
        body: chunk,
        signal: timeoutSignal(CONTENT_TIMEOUT_MS),
      });
      if (res.status === 429 || res.status === 503) {
        if (attempt === MAX_GRAPH_ATTEMPTS) return res;
        const waitMs = retryAfterMs(res, attempt);
        await res.text().catch(() => "");
        await sleep(waitMs);
        continue;
      }
      return res;
    } catch (err) {
      if (isAbortError(err) && attempt < MAX_GRAPH_ATTEMPTS) {
        lastAbort = err instanceof Error ? err : new Error(String(err));
        await sleep(1000 * attempt);
        continue;
      }
      if (isAbortError(err)) {
        throw new Error(
          `SharePoint chunk upload timed out after ${CONTENT_TIMEOUT_MS}ms (bytes ${offset}-${end})`,
        );
      }
      throw err;
    }
  }
  throw lastAbort ?? new Error("SharePoint chunk upload failed");
}

async function putViaUploadSession(
  driveId: string,
  folderPath: string,
  fileName: string,
  fileBuffer: Buffer,
): Promise<DriveItemInfo> {
  const itemPath = driveItemPath([
    ...folderPath.split("/").filter(Boolean),
    fileName,
  ]);
  const sessionRes = await graphFetchWithRetry(
    `/drives/${driveId}/root:/${itemPath}:/createUploadSession`,
    {
      method: "POST",
      body: JSON.stringify({
        item: {
          "@microsoft.graph.conflictBehavior": "replace",
          name: fileName,
        },
      }),
    },
  );
  if (!sessionRes.ok) {
    const text = await sessionRes.text().catch(() => "");
    throw new Error(
      `SharePoint upload session failed (${sessionRes.status}): ${text.slice(0, 300)}` +
        sitesPermissionHint(sessionRes.status, text),
    );
  }
  const session = (await sessionRes.json()) as { uploadUrl?: string };
  if (!session.uploadUrl) {
    throw new Error("SharePoint upload session missing uploadUrl");
  }

  let offset = 0;
  let lastItem: DriveItemInfo | null = null;
  while (offset < fileBuffer.length) {
    const endExclusive = Math.min(offset + UPLOAD_CHUNK_BYTES, fileBuffer.length);
    const chunk = fileBuffer.subarray(offset, endExclusive);
    const chunkRes = await putSessionChunk(
      session.uploadUrl,
      chunk,
      offset,
      fileBuffer.length,
    );
    if (chunkRes.status === 200 || chunkRes.status === 201) {
      const uploaded = (await chunkRes.json().catch(() => ({}))) as {
        id?: string;
        webUrl?: string;
      };
      if (uploaded.id) lastItem = { id: uploaded.id, webUrl: uploaded.webUrl };
    } else if (chunkRes.status === 202) {
      await chunkRes.text().catch(() => "");
    } else {
      const text = await chunkRes.text().catch(() => "");
      throw new Error(
        `SharePoint chunk upload failed (${chunkRes.status}) at byte ${offset}: ${text.slice(0, 300)}` +
          sitesPermissionHint(chunkRes.status, text),
      );
    }
    offset = endExclusive;
  }

  if (lastItem?.id) return lastItem;
  const lookedUp = await getDriveItemInfo(driveId, `${folderPath}/${fileName}`);
  if (lookedUp?.id) return lookedUp;
  throw new Error(`SharePoint upload session finished but item ${fileName} was not found`);
}

async function putFileContent(
  driveId: string,
  folderPath: string,
  fileName: string,
  fileBuffer: Buffer,
): Promise<DriveItemInfo> {
  if (fileBuffer.length >= SIMPLE_UPLOAD_MAX_BYTES) {
    return putViaUploadSession(driveId, folderPath, fileName, fileBuffer);
  }
  try {
    return await putSimpleContent(driveId, folderPath, fileName, fileBuffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/413|too large|max.*size|Request Entity Too Large/i.test(msg)) {
      return putViaUploadSession(driveId, folderPath, fileName, fileBuffer);
    }
    throw err;
  }
}

export async function uploadFileToSharePoint(
  customerName: string,
  dept: string,
  workOrderNumber: string,
  fileName: string,
  fileBuffer: Buffer,
): Promise<{ success: true; path: string; webUrl?: string }> {
  const siteId = await resolveSiteId();
  const driveId = await resolveDriveId(siteId);

  const sanitizedCustomer = sanitizePathSegment(customerName);
  const sanitizedDept = sanitizePathSegment(dept);
  const sanitizedWo = sanitizePathSegment(workOrderNumber);
  const sanitizedFile = sanitizePathSegment(fileName);
  const folderPath = `${sanitizedDept}/${sanitizedCustomer}/${sanitizedWo}`;

  await ensureFolderPath(driveId, folderPath);
  await prepareExistingItemForOverwrite(driveId, folderPath, sanitizedFile);

  let uploaded: DriveItemInfo;
  try {
    uploaded = await putFileContent(driveId, folderPath, sanitizedFile, fileBuffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/423|resourceLocked|resourceCheckedOut|checked-out by another/i.test(msg)) {
      console.warn(
        `[sharepoint] PUT locked for "${sanitizedFile}", retrying after check-in/check-out`,
      );
      await prepareExistingItemForOverwrite(driveId, folderPath, sanitizedFile);
      try {
        uploaded = await putFileContent(driveId, folderPath, sanitizedFile, fileBuffer);
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        if (/423|resourceLocked|resourceCheckedOut|checked-out by another/i.test(retryMsg)) {
          throw lockedByOtherMessage(sanitizedFile, folderPath, retryMsg);
        }
        throw retryErr;
      }
    } else {
      throw err;
    }
  }

  if (!uploaded.id) {
    const lookedUp = await getDriveItemInfo(driveId, `${folderPath}/${sanitizedFile}`);
    if (!lookedUp?.id) {
      throw new Error(
        `SharePoint upload of ${sanitizedFile} did not return an item id; cannot check in`,
      );
    }
    uploaded = lookedUp;
  }

  // Require Check Out libraries leave Graph PUTs checked out to the app identity
  // until check-in — fail the upload if the file would stay invisible in Documents.
  await checkInDriveItem(driveId, uploaded.id, `ImageFlow upload: ${sanitizedFile}`);

  return {
    success: true,
    path: `${folderPath}/${sanitizedFile}`,
    webUrl: uploaded.webUrl,
  };
}

/** Non-secret status for /health */
export function getSharePointEnvStatus(): {
  azureTenantSet: boolean;
  azureClientSet: boolean;
  azureSecretSet: boolean;
  azureCertSet: boolean;
  azureCredentialMode: "secret" | "certificate" | "none";
  siteIdSet: boolean;
  siteHostname: string;
  sitePath: string;
} {
  return {
    azureTenantSet: Boolean(process.env.AZURE_TENANT_ID?.trim()),
    azureClientSet: Boolean(process.env.AZURE_CLIENT_ID?.trim()),
    azureSecretSet: Boolean(process.env.AZURE_CLIENT_SECRET?.trim()),
    azureCertSet: hasCertificateConfigured(),
    azureCredentialMode: getAzureCredentialMode(),
    siteIdSet: Boolean(process.env.SHAREPOINT_SITE_ID?.trim()),
    siteHostname:
      process.env.SHAREPOINT_SITE_HOSTNAME?.trim() || "aceelectronics.sharepoint.us",
    sitePath: process.env.SHAREPOINT_SITE_PATH?.trim() || "/sites/jobtravelerphotos",
  };
}

/** Connectivity check: token → site → drive (and optional tiny upload). */
export async function probeSharePointAccess(options?: {
  uploadTest?: boolean;
}): Promise<{
  ok: boolean;
  credentialMode: "secret" | "certificate" | "none";
  siteId?: string;
  driveId?: string;
  uploadPath?: string;
  error?: string;
}> {
  const credentialMode = getAzureCredentialMode();
  try {
    await getAccessToken();
    const siteId = await resolveSiteId();
    const driveId = await resolveDriveId(siteId);

    let uploadPath: string | undefined;
    if (options?.uploadTest) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const result = await uploadFileToSharePoint(
        "_ImageFlowProbe",
        "Testing",
        "PROBE",
        `probe-${stamp}.txt`,
        Buffer.from(`ImageFlow SharePoint probe ${stamp}\n`, "utf8"),
      );
      uploadPath = result.path;
    }

    return { ok: true, credentialMode, siteId, driveId, uploadPath };
  } catch (err) {
    return {
      ok: false,
      credentialMode,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
