/**
 * Read-only Google Drive access via a service account (photo migration).
 * The service account only sees folders shared with its email address.
 * Env: GOOGLE_SERVICE_ACCOUNT_JSON — the JSON key, raw or base64.
 */
import { createSign } from "crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

type ServiceAccountKey = { client_email: string; private_key: string; token_uri?: string };

export type DriveEntry = {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  modifiedTime: string | null;
};

export class DriveApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DriveApiError";
  }
}

let cachedKey: ServiceAccountKey | null | undefined;
let cachedToken: { token: string; expiresAt: number } | null = null;

function loadKey(): ServiceAccountKey | null {
  if (cachedKey !== undefined) return cachedKey;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return (cachedKey = null);
  try {
    const text = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(text) as ServiceAccountKey;
    if (!parsed.client_email || !parsed.private_key) throw new Error("missing client_email/private_key");
    return (cachedKey = parsed);
  } catch (err) {
    console.error("[gdrive-reader] GOOGLE_SERVICE_ACCOUNT_JSON is not a valid service-account key:", (err as Error).message);
    return (cachedKey = null);
  }
}

export function getDriveReaderStatus(): { configured: boolean; serviceAccountEmail: string | null } {
  const key = loadKey();
  return { configured: Boolean(key), serviceAccountEmail: key?.client_email ?? null };
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) return cachedToken.token;
  const key = loadKey();
  if (!key) throw new Error("Missing required env var: GOOGLE_SERVICE_ACCOUNT_JSON");
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: key.token_uri || TOKEN_URL, iat: now, exp: now + 3600 }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${base64Url(signer.sign(key.private_key))}`;

  const res = await fetch(key.token_uri || TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new DriveApiError(`Google token request failed (${res.status}): ${body.error_description || "no token"}`, res.status);
  }
  cachedToken = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cachedToken.token;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function driveFetch(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${await getToken()}` },
      signal: AbortSignal.timeout(120_000),
    });
    const retryable = res.status === 429 || res.status >= 500 || res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(await res.clone().text());
    if (res.ok || !retryable || attempt >= 4) return res;
    if (res.status === 401) cachedToken = null;
    await res.text().catch(() => "");
    await sleep(Math.min(30_000, 1000 * 2 ** attempt));
  }
}

async function failure(res: Response, context: string): Promise<DriveApiError> {
  const text = await res.text().catch(() => "");
  let detail = text.slice(0, 200);
  try {
    detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message || detail;
  } catch {
    /* not JSON */
  }
  return new DriveApiError(`Google Drive ${context} failed (${res.status}): ${detail}`, res.status);
}

export const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

/** Accept a bare folder id or any Drive URL containing one. */
export function parseDriveFolderId(input: string): string | null {
  const value = input.trim();
  if (DRIVE_ID_RE.test(value)) return value;
  const match = value.match(/\/folders\/([A-Za-z0-9_-]{10,200})/) || value.match(/[?&]id=([A-Za-z0-9_-]{10,200})/);
  return match ? match[1] : null;
}

export async function getDriveFolder(folderId: string): Promise<{ id: string; name: string }> {
  if (!DRIVE_ID_RE.test(folderId)) throw new Error("Invalid Drive folder id");
  const params = new URLSearchParams({ fields: "id,name,mimeType", supportsAllDrives: "true" });
  const res = await driveFetch(`${DRIVE_API}/files/${folderId}?${params}`);
  if (!res.ok) throw await failure(res, "folder lookup");
  const data = (await res.json()) as { id: string; name: string; mimeType: string };
  if (data.mimeType !== FOLDER_MIME) throw new Error(`Drive item ${data.name} is not a folder`);
  return { id: data.id, name: data.name };
}

export async function listDriveChildren(folderId: string): Promise<DriveEntry[]> {
  if (!DRIVE_ID_RE.test(folderId)) throw new Error("Invalid Drive folder id");
  const out: DriveEntry[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id,name,mimeType,size,modifiedTime)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await driveFetch(`${DRIVE_API}/files?${params}`);
    if (!res.ok) throw await failure(res, "folder listing");
    const page = (await res.json()) as {
      nextPageToken?: string;
      files?: { id: string; name: string; mimeType: string; size?: string; modifiedTime?: string }[];
    };
    for (const f of page.files ?? []) {
      out.push({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        size: f.size !== undefined ? Number(f.size) : null,
        modifiedTime: f.modifiedTime ?? null,
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

export async function downloadDriveFile(fileId: string): Promise<Buffer> {
  if (!DRIVE_ID_RE.test(fileId)) throw new Error("Invalid Drive file id");
  const res = await driveFetch(`${DRIVE_API}/files/${fileId}?alt=media&supportsAllDrives=true`);
  if (!res.ok) throw await failure(res, "download");
  return Buffer.from(await res.arrayBuffer());
}
