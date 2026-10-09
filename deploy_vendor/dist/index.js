var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// server/env.ts
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
function loadEnvFile(fileName = ".env") {
  const filePath = resolve(process.cwd(), fileName);
  if (!existsSync(filePath)) return;
  const text2 = readFileSync(filePath, "utf8");
  for (const rawLine of text2.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq2 = line.indexOf("=");
    if (eq2 <= 0) continue;
    const key = line.slice(0, eq2).trim();
    if (!key || process.env[key] !== void 0) continue;
    let value = line.slice(eq2 + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
function isSsoEnabled() {
  const flag = process.env.ENABLE_SSO?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "on" || flag === "yes";
}

// server/index.ts
import express from "express";

// server/routes.ts
import { createServer } from "http";
import multer from "multer";

// server/sftpImport.ts
import SftpClient from "ssh2-sftp-client";
import { writeFileSync, mkdirSync, existsSync as existsSync2 } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
var DEFAULT_REMOTE_DIRS = ["/mnt/sage", "/mnt/import"];
var OPEN_ORDER_PATTERN = /^open\s*order\s*all\s*qty\s*only[_-\s].+\.xlsx$/i;
function envFlagEnabled(name) {
  const flag = process.env[name]?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off" || flag === "no") return false;
  if (flag === "1" || flag === "true" || flag === "on" || flag === "yes") return true;
  return null;
}
function resolveSftpPassword() {
  const b64 = process.env.SFTP_PASSWORD_B64?.trim();
  if (b64) {
    try {
      return Buffer.from(b64, "base64").toString("utf8");
    } catch {
      throw new Error("SFTP_PASSWORD_B64 is not valid base64");
    }
  }
  const plain = process.env.SFTP_PASSWORD;
  if (!plain) return void 0;
  const escapeMode = process.env.SFTP_PASSWORD_DOLLAR_ESCAPE?.trim().toLowerCase();
  if (escapeMode === "off" || escapeMode === "false" || escapeMode === "0") {
    return plain;
  }
  if (plain.includes("$") && !plain.includes("$$")) {
    return plain.replace(/\$/g, "$$$$");
  }
  return plain;
}
function isExcelSftpSyncAvailable() {
  const flag = envFlagEnabled("ENABLE_EXCEL_SFTP_SYNC");
  if (flag === false) return false;
  return Boolean(
    process.env.SFTP_HOST?.trim() && process.env.SFTP_USER?.trim() && resolveSftpPassword()
  );
}
function getSftpEnvStatus() {
  const resolved = resolveSftpPassword();
  return {
    configured: isExcelSftpSyncAvailable(),
    host: Boolean(process.env.SFTP_HOST?.trim()),
    user: Boolean(process.env.SFTP_USER?.trim()),
    password: Boolean(resolved),
    passwordSource: process.env.SFTP_PASSWORD_B64?.trim() ? "b64" : process.env.SFTP_PASSWORD ? "plain" : "none",
    passwordLength: resolved?.length ?? 0,
    passwordDollarCount: (resolved?.match(/\$/g) || []).length,
    port: process.env.SFTP_PORT?.trim() || "22",
    remoteDirs: process.env.SFTP_REMOTE_DIRS?.trim() || "/mnt/sage,/mnt/import",
    enableFlag: process.env.ENABLE_EXCEL_SFTP_SYNC?.trim() || null
  };
}
function getSftpConfig() {
  const host = process.env.SFTP_HOST?.trim();
  const user = process.env.SFTP_USER?.trim();
  const password = resolveSftpPassword();
  if (!host || !user || !password) {
    throw new Error(
      "SFTP_HOST, SFTP_USER, and SFTP_PASSWORD (or SFTP_PASSWORD_B64) are required"
    );
  }
  const port = parseInt(process.env.SFTP_PORT?.trim() || "22", 10);
  return {
    host,
    port: Number.isFinite(port) ? port : 22,
    username: user,
    password,
    readyTimeout: 2e4,
    tryKeyboard: true
  };
}
function getRemoteDirs() {
  const raw = process.env.SFTP_REMOTE_DIRS?.trim();
  if (!raw) return DEFAULT_REMOTE_DIRS;
  return raw.split(",").map((d) => d.trim()).filter(Boolean);
}
function matchesOpenOrderFile(name) {
  return OPEN_ORDER_PATTERN.test(name);
}
var MONTH_NAMES = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12"
};
function parseEmbeddedDate(name) {
  const textual = name.match(
    /(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i
  );
  if (textual) {
    const day = textual[1].padStart(2, "0");
    const month = MONTH_NAMES[textual[2].toLowerCase()];
    const year = textual[3];
    if (month) return `${year}${month}${day}`;
  }
  const digits = name.match(/(\d{8}|\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4})/);
  if (!digits) return null;
  const token = digits[1];
  if (/^\d{8}$/.test(token)) return token;
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) return token.replace(/-/g, "");
  if (/^\d{2}-\d{2}-\d{4}$/.test(token)) {
    const [mm, dd, yyyy] = token.split("-");
    return `${yyyy}${mm}${dd}`;
  }
  return null;
}
function sortKeyForFile(name, modifyTime) {
  return parseEmbeddedDate(name) || String(modifyTime).padStart(15, "0");
}
function formatFileDate(name, modifyTime) {
  const ymd = parseEmbeddedDate(name);
  if (ymd && ymd.length === 8) {
    return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  }
  return new Date(modifyTime).toISOString().slice(0, 10);
}
async function listMatchingFiles(sftp, remoteDir) {
  try {
    const entries = await sftp.list(remoteDir);
    return entries.filter((entry) => entry.type === "-" && matchesOpenOrderFile(entry.name)).map((entry) => ({
      name: entry.name,
      remotePath: `${remoteDir.replace(/\/$/, "")}/${entry.name}`,
      modifyTime: entry.modifyTime || 0,
      size: entry.size || 0
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[sftp] Could not list ${remoteDir}: ${message}`);
    return [];
  }
}
async function checkForNewExcelFileViaSftp() {
  if (!isExcelSftpSyncAvailable()) {
    return {
      success: false,
      message: "Excel SFTP sync not configured (set SFTP_HOST, SFTP_USER, SFTP_PASSWORD)"
    };
  }
  const sftp = new SftpClient();
  try {
    const config = getSftpConfig();
    await sftp.connect(config);
    const remoteDirs = getRemoteDirs();
    const allFiles = [];
    for (const dir of remoteDirs) {
      const files = await listMatchingFiles(sftp, dir);
      allFiles.push(...files);
    }
    if (allFiles.length === 0) {
      return {
        success: false,
        message: `No Open Order All Qty Only Excel files found in ${remoteDirs.join(" or ")}`
      };
    }
    allFiles.sort(
      (a, b) => sortKeyForFile(b.name, b.modifyTime).localeCompare(sortKeyForFile(a.name, a.modifyTime))
    );
    const latest = allFiles[0];
    const buffer = await sftp.get(latest.remotePath);
    const __filename2 = fileURLToPath(import.meta.url);
    const __dirname2 = dirname(__filename2);
    const assetsDir = join(__dirname2, "..", "attached_assets");
    if (!existsSync2(assetsDir)) {
      mkdirSync(assetsDir, { recursive: true });
    }
    const newFileName = `OpenOrdersAllQtyOnly_${Date.now()}.xlsx`;
    writeFileSync(join(assetsDir, newFileName), buffer);
    console.log(
      `[sftp] Downloaded ${latest.name} from ${latest.remotePath} \u2192 ${newFileName} (${buffer.length} bytes)`
    );
    return {
      success: true,
      message: `Excel file ${latest.name} successfully downloaded via SFTP`,
      fileName: newFileName,
      fileDate: formatFileDate(latest.name, latest.modifyTime),
      originalFileName: latest.name
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[sftp] Error downloading Excel file:", errorMessage);
    return {
      success: false,
      message: errorMessage,
      error: errorMessage
    };
  } finally {
    try {
      await sftp.end();
    } catch {
    }
  }
}

// server/excelSync.ts
function isExcelSyncAvailable() {
  return isExcelSftpSyncAvailable();
}
async function checkForNewExcelFile() {
  if (!isExcelSftpSyncAvailable()) {
    const host = Boolean(process.env.SFTP_HOST?.trim());
    const user = Boolean(process.env.SFTP_USER?.trim());
    const password = Boolean(process.env.SFTP_PASSWORD);
    const missing = [
      !host && "SFTP_HOST",
      !user && "SFTP_USER",
      !password && "SFTP_PASSWORD"
    ].filter(Boolean);
    return {
      success: false,
      message: missing.length > 0 ? `Excel SFTP sync not configured \u2014 missing in the container: ${missing.join(", ")}. In Portainer these must be listed under the service environment (redeploy the updated docker-compose.yml).` : "Excel SFTP sync is disabled (ENABLE_EXCEL_SFTP_SYNC=false)."
    };
  }
  const result = await checkForNewExcelFileViaSftp();
  if (result.success) {
    return { ...result, source: "sftp" };
  }
  return result;
}

// server/sharepoint.ts
import { createHash, createSign, randomUUID, X509Certificate } from "crypto";
import { existsSync as existsSync3, readFileSync as readFileSync2 } from "fs";
var tokenCache = null;
var cachedSiteId = null;
var cachedDriveId = null;
var GRAPH_BASE = "https://graph.microsoft.us/v1.0";
var TOKEN_URL_BASE = "https://login.microsoftonline.us";
var CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
function sanitizePathSegment(value) {
  let name = value.replace(/[<>:"/\\|?*#%\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim();
  name = name.replace(/^[.\s]+|[.\s]+$/g, "");
  if (!name) name = "_";
  return name;
}
function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
function base64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeBase64Env(name) {
  const raw = requireEnv(name);
  try {
    return Buffer.from(raw, "base64");
  } catch {
    throw new Error(`Invalid base64 in ${name}`);
  }
}
function hasCertificateConfigured() {
  return Boolean(
    process.env.AZURE_CLIENT_CERT_PEM_BASE64?.trim() || process.env.AZURE_CLIENT_CERT_PATH?.trim()
  );
}
function loadClientCertificate() {
  let certRaw;
  let keyPem;
  const pemB64 = process.env.AZURE_CLIENT_CERT_PEM_BASE64?.trim();
  if (pemB64) {
    certRaw = decodeBase64Env("AZURE_CLIENT_CERT_PEM_BASE64");
    keyPem = decodeBase64Env("AZURE_CLIENT_CERT_KEY_BASE64").toString("utf8");
  } else {
    const certPath = requireEnv("AZURE_CLIENT_CERT_PATH");
    const keyPath = process.env.AZURE_CLIENT_CERT_KEY_PATH?.trim() || certPath.replace(/\.(pem|cer|crt)$/i, ".key");
    if (!existsSync3(certPath)) {
      throw new Error(`AZURE_CLIENT_CERT_PATH not found: ${certPath}`);
    }
    if (!existsSync3(keyPath)) {
      throw new Error(`Private key not found: ${keyPath}`);
    }
    certRaw = readFileSync2(certPath);
    keyPem = readFileSync2(keyPath, "utf8");
  }
  const x509 = new X509Certificate(certRaw);
  const x5tS256 = base64Url(createHash("sha256").update(x509.raw).digest());
  return { privateKeyPem: keyPem, x5tS256 };
}
function buildClientAssertion(tokenUrl, clientId) {
  const { privateKeyPem, x5tS256 } = loadClientCertificate();
  const now = Math.floor(Date.now() / 1e3);
  const header = base64Url(
    Buffer.from(
      JSON.stringify({
        alg: "RS256",
        typ: "JWT",
        "x5t#S256": x5tS256
      })
    )
  );
  const payload = base64Url(
    Buffer.from(
      JSON.stringify({
        aud: tokenUrl,
        iss: clientId,
        sub: clientId,
        jti: randomUUID(),
        nbf: now - 60,
        exp: now + 600
      })
    )
  );
  const data = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  const signature = base64Url(signer.sign(privateKeyPem));
  return `${data}.${signature}`;
}
function getAzureCredentialMode() {
  const secret = process.env.AZURE_CLIENT_SECRET?.trim();
  const secretLooksLikeGuidOnly = !!secret && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(secret);
  if (secret && !secretLooksLikeGuidOnly) return "secret";
  if (hasCertificateConfigured()) return "certificate";
  return "none";
}
function applyClientCredential(params, tokenUrl, clientId) {
  const secret = process.env.AZURE_CLIENT_SECRET?.trim();
  const secretLooksLikeGuidOnly = !!secret && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(secret);
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
      "AZURE_CLIENT_SECRET looks like a Secret ID (GUID), not the secret Value. Delete AZURE_CLIENT_SECRET in Portainer and use certificate auth (AZURE_CLIENT_CERT_PEM_BASE64 + AZURE_CLIENT_CERT_KEY_BASE64)."
    );
  }
  throw new Error(
    "Missing Azure credentials: set AZURE_CLIENT_CERT_PEM_BASE64 + AZURE_CLIENT_CERT_KEY_BASE64 (Portainer), or AZURE_CLIENT_CERT_PATH (+ key), or AZURE_CLIENT_SECRET (secret Value, not Secret ID)."
  );
}
function sitesPermissionHint(status, body) {
  if (status !== 403 && status !== 401) return "";
  return ` Azure app lacks SharePoint access. Fix (GCC High admin): (1) App registration \u2192 API permissions \u2192 Microsoft Graph application Sites.Selected (or Sites.ReadWrite.All) + admin consent. (2) Grant that app Write on the site (Grant-PnPAzureADAppSitePermission / Graph site permissions). (3) Prefer setting SHAREPOINT_SITE_ID so the app skips site hostname lookup (Sites.Selected often returns 403 on /sites/{host}:{path}). Graph detail: ${body.slice(0, 180)}`;
}
async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 6e4) {
    return tokenCache.accessToken;
  }
  const tenantId = requireEnv("AZURE_TENANT_ID");
  const clientId = requireEnv("AZURE_CLIENT_ID");
  const tokenUrl = `${TOKEN_URL_BASE}/${tenantId}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    scope: "https://graph.microsoft.us/.default"
  });
  applyClientCredential(params, tokenUrl, clientId);
  const tokenController = new AbortController();
  const tokenTimer = setTimeout(() => tokenController.abort(), 3e4);
  let res;
  try {
    res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
      signal: tokenController.signal
    });
  } catch (err) {
    const name = err && typeof err === "object" ? err.name : "";
    if (name === "AbortError" || name === "TimeoutError") {
      throw new Error("Azure token request timed out after 30000ms");
    }
    throw err;
  } finally {
    clearTimeout(tokenTimer);
  }
  if (!res.ok) {
    const text2 = await res.text().catch(() => "");
    throw new Error(`Azure token request failed (${res.status}): ${text2.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new Error("Azure token response missing access_token");
  }
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1e3
  };
  return tokenCache.accessToken;
}
var METADATA_TIMEOUT_MS = 3e4;
var CONTENT_TIMEOUT_MS = 12e4;
var SIMPLE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
var UPLOAD_CHUNK_BYTES = 320 * 1024 * 16;
var MAX_GRAPH_ATTEMPTS = 3;
var ensuredFolders = /* @__PURE__ */ new Set();
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}
function sleep(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}
function isBinaryBody(body) {
  return typeof Buffer !== "undefined" && (body instanceof Buffer || body instanceof Uint8Array);
}
function isAbortError(err) {
  if (!err || typeof err !== "object") return false;
  const name = err.name;
  return name === "AbortError" || name === "TimeoutError";
}
function retryAfterMs(res, attempt) {
  const raw = res.headers.get("Retry-After");
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed * 1e3, 15e3);
  return Math.min(1e3 * 2 ** (attempt - 1), 8e3);
}
async function graphFetch(path3, init = {}) {
  const { timeoutMs = METADATA_TIMEOUT_MS, signal: userSignal, ...rest } = init;
  const token = await getAccessToken();
  const url = path3.startsWith("http") ? path3 : `${GRAPH_BASE}${path3}`;
  const headers = new Headers(rest.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && rest.body && !isBinaryBody(rest.body)) {
    headers.set("Content-Type", "application/json");
  }
  const signal = userSignal ?? timeoutSignal(timeoutMs);
  return fetch(url, { ...rest, headers, signal });
}
async function graphFetchWithRetry(path3, init = {}, maxAttempts = MAX_GRAPH_ATTEMPTS) {
  let lastAbort = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await graphFetch(path3, init);
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
        await sleep(1e3 * attempt);
        continue;
      }
      if (isAbortError(err)) {
        throw new Error(
          `SharePoint request timed out after ${init.timeoutMs ?? METADATA_TIMEOUT_MS}ms`
        );
      }
      throw err;
    }
  }
  throw lastAbort ?? new Error("SharePoint request failed");
}
async function resolveSiteId() {
  if (cachedSiteId) return cachedSiteId;
  const configured = process.env.SHAREPOINT_SITE_ID?.trim();
  if (configured) {
    const res2 = await graphFetchWithRetry(`/sites/${configured}`);
    if (!res2.ok) {
      const text2 = await res2.text().catch(() => "");
      throw new Error(
        `SHAREPOINT_SITE_ID is set but not accessible (${res2.status}).` + sitesPermissionHint(res2.status, text2)
      );
    }
    cachedSiteId = configured;
    return cachedSiteId;
  }
  const hostname = process.env.SHAREPOINT_SITE_HOSTNAME?.trim() || "aceelectronics.sharepoint.us";
  const sitePath = process.env.SHAREPOINT_SITE_PATH?.trim() || "/sites/jobtravelerphotos";
  const normalizedPath = sitePath.startsWith("/") ? sitePath : `/${sitePath}`;
  const res = await graphFetchWithRetry(
    `/sites/${encodeURIComponent(hostname)}:${normalizedPath}`
  );
  if (!res.ok) {
    const text2 = await res.text().catch(() => "");
    throw new Error(
      `Failed to resolve SharePoint site (${res.status}).` + sitesPermissionHint(res.status, text2) + (statusIsAccessDenied(res.status) ? ` Set SHAREPOINT_SITE_ID to the full Graph site id for ${hostname}${normalizedPath}.` : ` Raw: ${text2.slice(0, 200)}`)
    );
  }
  const site = await res.json();
  if (!site.id) throw new Error("SharePoint site response missing id");
  cachedSiteId = site.id;
  return cachedSiteId;
}
function statusIsAccessDenied(status) {
  return status === 401 || status === 403;
}
async function resolveDriveId(siteId) {
  if (cachedDriveId) return cachedDriveId;
  const configured = process.env.SHAREPOINT_DRIVE_ID?.trim();
  if (configured) {
    cachedDriveId = configured;
    return cachedDriveId;
  }
  const res = await graphFetchWithRetry(`/sites/${siteId}/drive`);
  if (!res.ok) {
    const text2 = await res.text().catch(() => "");
    throw new Error(
      `Failed to resolve default drive (${res.status}).` + sitesPermissionHint(res.status, text2)
    );
  }
  const drive = await res.json();
  if (!drive.id) throw new Error("SharePoint drive response missing id");
  cachedDriveId = drive.id;
  return cachedDriveId;
}
function driveItemPath(segments) {
  return segments.map(encodeURIComponent).join("/");
}
async function ensureFolderPath(driveId, folderPath) {
  const cacheKey = `${driveId}:${folderPath}`;
  if (ensuredFolders.has(cacheKey)) return;
  const parts = folderPath.split("/").filter(Boolean);
  const leafProbe = await graphFetchWithRetry(
    `/drives/${driveId}/root:/${driveItemPath(parts)}`
  );
  if (leafProbe.ok) {
    await leafProbe.text().catch(() => "");
    ensuredFolders.add(cacheKey);
    return;
  }
  await leafProbe.text().catch(() => "");
  const built = [];
  for (const part of parts) {
    const parentSegments = [...built];
    built.push(part);
    const probe = await graphFetchWithRetry(
      `/drives/${driveId}/root:/${driveItemPath(built)}`
    );
    if (probe.ok) continue;
    if (probe.status !== 404) {
      const text2 = await probe.text().catch(() => "");
      throw new Error(
        `Failed to check folder ${built.join("/")} (${probe.status}): ${text2.slice(0, 200)}` + sitesPermissionHint(probe.status, text2)
      );
    }
    const createUrl = parentSegments.length === 0 ? `/drives/${driveId}/root/children` : `/drives/${driveId}/root:/${driveItemPath(parentSegments)}:/children`;
    const createRes = await graphFetchWithRetry(createUrl, {
      method: "POST",
      body: JSON.stringify({
        name: part,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail"
      })
    });
    if (!createRes.ok && createRes.status !== 409) {
      const text2 = await createRes.text().catch(() => "");
      throw new Error(
        `Failed to create folder ${part} (${createRes.status}): ${text2.slice(0, 200)}` + sitesPermissionHint(createRes.status, text2)
      );
    }
  }
  ensuredFolders.add(cacheKey);
}
async function getDriveItemInfo(driveId, itemPath) {
  const segments = itemPath.split("/").filter(Boolean);
  const res = await graphFetchWithRetry(
    `/drives/${driveId}/root:/${driveItemPath(segments)}`
  );
  if (res.status === 404) {
    await res.text().catch(() => "");
    return null;
  }
  if (!res.ok) {
    const text2 = await res.text().catch(() => "");
    throw new Error(
      `Failed to look up SharePoint item ${itemPath} (${res.status}): ${text2.slice(0, 200)}` + sitesPermissionHint(res.status, text2)
    );
  }
  const data = await res.json();
  if (!data.id) return null;
  return { id: data.id, webUrl: data.webUrl };
}
var SharePointCheckinError = class extends Error {
  constructor(message, itemId, path3, webUrl) {
    super(message);
    this.itemId = itemId;
    this.path = path3;
    this.webUrl = webUrl;
    this.name = "SharePointCheckinError";
  }
};
var PUBLICATION_SELECT = "$select=id,name,webUrl,publication,lastModifiedBy";
async function getItemPublication(driveId, itemId) {
  const res = await graphFetchWithRetry(`/drives/${driveId}/items/${itemId}?${PUBLICATION_SELECT}`);
  if (!res.ok) {
    const text2 = await res.text().catch(() => "");
    throw new Error(
      `Failed to read SharePoint item ${itemId} (${res.status}): ${text2.slice(0, 200)}` + sitesPermissionHint(res.status, text2)
    );
  }
  return await res.json();
}
function isCheckedOut(item) {
  return item.publication?.level === "checkout";
}
async function checkInAndVerify(driveId, itemId, comment) {
  const res = await graphFetchWithRetry(`/drives/${driveId}/items/${itemId}/checkin`, {
    method: "POST",
    body: JSON.stringify({ comment, checkInAs: "published" })
  });
  const checkinDetail = res.ok ? "" : `check-in returned ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
  if (res.ok) await res.text().catch(() => "");
  const item = await getItemPublication(driveId, itemId);
  if (!isCheckedOut(item)) return { webUrl: item.webUrl };
  throw new Error(
    `SharePoint file is still checked out after check-in` + (checkinDetail ? ` (${checkinDetail})` : "") + `. Check the library's required columns / check-in permissions.` + (res.status === 401 || res.status === 403 ? sitesPermissionHint(res.status, checkinDetail) : "")
  );
}
async function releaseBeforeOverwrite(driveId, itemId, comment) {
  const res = await graphFetchWithRetry(`/drives/${driveId}/items/${itemId}/checkin`, {
    method: "POST",
    body: JSON.stringify({ comment, checkInAs: "published" })
  });
  await res.text().catch(() => "");
}
async function checkoutDriveItem(driveId, itemId) {
  const res = await graphFetchWithRetry(`/drives/${driveId}/items/${itemId}/checkout`, {
    method: "POST"
  });
  if (res.ok) return;
  const text2 = await res.text().catch(() => "");
  if (res.status === 400 || res.status === 409 || /already checked out|checked.?out/i.test(text2)) {
    return;
  }
  throw new Error(
    `SharePoint check-out failed (${res.status}): ${text2.slice(0, 200)}` + sitesPermissionHint(res.status, text2)
  );
}
async function prepareExistingItemForOverwrite(driveId, folderPath, fileName) {
  const existing = await getDriveItemInfo(driveId, `${folderPath}/${fileName}`);
  if (!existing?.id) return null;
  await releaseBeforeOverwrite(
    driveId,
    existing.id,
    `ImageFlow release before overwrite: ${fileName}`
  );
  await checkoutDriveItem(driveId, existing.id);
  return existing.id;
}
function lockedByOtherMessage(fileName, folderPath, detail) {
  return new Error(
    `SharePoint file "${folderPath}/${fileName}" is checked out by another user. Open the file in SharePoint, Check In (or Discard Check Out), then try Upload again. (${detail.slice(0, 200)})`
  );
}
async function putSimpleContent(driveId, folderPath, fileName, fileBuffer) {
  const uploadPath = `/drives/${driveId}/root:/${driveItemPath([
    ...folderPath.split("/").filter(Boolean),
    fileName
  ])}:/content`;
  const uploadRes = await graphFetchWithRetry(uploadPath, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: fileBuffer,
    timeoutMs: CONTENT_TIMEOUT_MS
  });
  if (!uploadRes.ok) {
    const text2 = await uploadRes.text().catch(() => "");
    throw new Error(
      `SharePoint upload failed (${uploadRes.status}): ${text2.slice(0, 300)}` + sitesPermissionHint(uploadRes.status, text2)
    );
  }
  const uploaded = await uploadRes.json().catch(() => ({}));
  if (uploaded.id) return { id: uploaded.id, webUrl: uploaded.webUrl };
  const lookedUp = await getDriveItemInfo(driveId, `${folderPath}/${fileName}`);
  if (lookedUp?.id) return lookedUp;
  throw new Error(`SharePoint upload succeeded but returned no item id for ${fileName}`);
}
async function putSessionChunk(uploadUrl, chunk, offset, total) {
  const end = offset + chunk.length - 1;
  let lastAbort = null;
  for (let attempt = 1; attempt <= MAX_GRAPH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(chunk.length),
          "Content-Range": `bytes ${offset}-${end}/${total}`
        },
        body: chunk,
        signal: timeoutSignal(CONTENT_TIMEOUT_MS)
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
        await sleep(1e3 * attempt);
        continue;
      }
      if (isAbortError(err)) {
        throw new Error(
          `SharePoint chunk upload timed out after ${CONTENT_TIMEOUT_MS}ms (bytes ${offset}-${end})`
        );
      }
      throw err;
    }
  }
  throw lastAbort ?? new Error("SharePoint chunk upload failed");
}
async function putViaUploadSession(driveId, folderPath, fileName, fileBuffer) {
  const itemPath = driveItemPath([
    ...folderPath.split("/").filter(Boolean),
    fileName
  ]);
  const sessionRes = await graphFetchWithRetry(
    `/drives/${driveId}/root:/${itemPath}:/createUploadSession`,
    {
      method: "POST",
      body: JSON.stringify({
        item: {
          "@microsoft.graph.conflictBehavior": "replace",
          name: fileName
        }
      })
    }
  );
  if (!sessionRes.ok) {
    const text2 = await sessionRes.text().catch(() => "");
    throw new Error(
      `SharePoint upload session failed (${sessionRes.status}): ${text2.slice(0, 300)}` + sitesPermissionHint(sessionRes.status, text2)
    );
  }
  const session = await sessionRes.json();
  if (!session.uploadUrl) {
    throw new Error("SharePoint upload session missing uploadUrl");
  }
  let offset = 0;
  let lastItem = null;
  while (offset < fileBuffer.length) {
    const endExclusive = Math.min(offset + UPLOAD_CHUNK_BYTES, fileBuffer.length);
    const chunk = fileBuffer.subarray(offset, endExclusive);
    const chunkRes = await putSessionChunk(
      session.uploadUrl,
      chunk,
      offset,
      fileBuffer.length
    );
    if (chunkRes.status === 200 || chunkRes.status === 201) {
      const uploaded = await chunkRes.json().catch(() => ({}));
      if (uploaded.id) lastItem = { id: uploaded.id, webUrl: uploaded.webUrl };
    } else if (chunkRes.status === 202) {
      await chunkRes.text().catch(() => "");
    } else {
      const text2 = await chunkRes.text().catch(() => "");
      throw new Error(
        `SharePoint chunk upload failed (${chunkRes.status}) at byte ${offset}: ${text2.slice(0, 300)}` + sitesPermissionHint(chunkRes.status, text2)
      );
    }
    offset = endExclusive;
  }
  if (lastItem?.id) return lastItem;
  const lookedUp = await getDriveItemInfo(driveId, `${folderPath}/${fileName}`);
  if (lookedUp?.id) return lookedUp;
  throw new Error(`SharePoint upload session finished but item ${fileName} was not found`);
}
async function putFileContent(driveId, folderPath, fileName, fileBuffer) {
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
async function uploadFileToSharePoint(customerName, dept, workOrderNumber, fileName, fileBuffer) {
  const startedAt = Date.now();
  let mark = startedAt;
  const lap = () => {
    const now = Date.now();
    const ms = now - mark;
    mark = now;
    return ms;
  };
  await getAccessToken();
  const tokenMs = lap();
  const siteId = await resolveSiteId();
  const driveId = await resolveDriveId(siteId);
  const siteMs = lap();
  const sanitizedCustomer = sanitizePathSegment(customerName);
  const sanitizedDept = sanitizePathSegment(dept);
  const sanitizedWo = sanitizePathSegment(workOrderNumber);
  const sanitizedFile = sanitizePathSegment(fileName);
  const folderPath = `${sanitizedDept}/${sanitizedCustomer}/${sanitizedWo}`;
  await ensureFolderPath(driveId, folderPath);
  const folderMs = lap();
  let lockedRetry = false;
  let uploaded;
  try {
    uploaded = await putFileContent(driveId, folderPath, sanitizedFile, fileBuffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/423|resourceLocked|resourceCheckedOut|checked-out by another/i.test(msg)) {
      lockedRetry = true;
      console.warn(
        `[sharepoint] PUT locked for "${sanitizedFile}", retrying after check-in/check-out`
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
        `SharePoint upload of ${sanitizedFile} did not return an item id; cannot check in`
      );
    }
    uploaded = lookedUp;
  }
  const putMs = lap();
  const itemPath = `${folderPath}/${sanitizedFile}`;
  let checkedIn;
  try {
    checkedIn = await checkInAndVerify(driveId, uploaded.id, `ImageFlow upload: ${sanitizedFile}`);
  } catch (err) {
    throw new SharePointCheckinError(
      err instanceof Error ? err.message : String(err),
      uploaded.id,
      itemPath,
      uploaded.webUrl
    );
  }
  const checkinMs = lap();
  return {
    success: true,
    path: itemPath,
    itemId: uploaded.id,
    webUrl: checkedIn.webUrl ?? uploaded.webUrl,
    timings: {
      tokenMs,
      siteMs,
      folderMs,
      putMs,
      checkinMs,
      totalMs: Date.now() - startedAt,
      lockedRetry
    }
  };
}
async function resolveDrive() {
  await getAccessToken();
  const siteId = await resolveSiteId();
  return resolveDriveId(siteId);
}
async function retryCheckIn(itemId, itemPath) {
  const driveId = await resolveDrive();
  let id = itemId;
  if (!id) {
    const found = await getDriveItemInfo(driveId, itemPath);
    if (!found?.id) throw new Error(`SharePoint item ${itemPath} not found for check-in`);
    id = found.id;
  }
  const fileName = itemPath.split("/").pop() || itemPath;
  const result = await checkInAndVerify(driveId, id, `ImageFlow upload: ${fileName}`);
  return { itemId: id, webUrl: result.webUrl };
}
function isCheckedOutByApp(item) {
  if (!isCheckedOut(item)) return false;
  const clientId = process.env.AZURE_CLIENT_ID?.trim().toLowerCase();
  const appId = item.lastModifiedBy?.application?.id?.toLowerCase();
  return Boolean(clientId && appId && appId === clientId);
}
function emptySweep() {
  return { scanned: 0, checkedOutByApp: 0, checkedIn: 0, failed: 0, errors: [] };
}
async function mapLimit(items, limit, fn) {
  let index2 = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index2 < items.length) {
      const next = items[index2++];
      await fn(next);
    }
  });
  await Promise.all(workers);
}
async function sweepItem(driveId, item, result) {
  result.scanned++;
  if (!isCheckedOutByApp(item)) return;
  result.checkedOutByApp++;
  try {
    await checkInAndVerify(driveId, item.id, "ImageFlow check-in sweep");
    result.checkedIn++;
  } catch (err) {
    result.failed++;
    if (result.errors.length < 10) {
      result.errors.push(`${item.id}: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
    }
  }
}
async function sweepPathsCheckedOutByApp(paths) {
  const driveId = await resolveDrive();
  const result = emptySweep();
  await mapLimit(Array.from(new Set(paths)), 4, async (itemPath) => {
    const segments = itemPath.split("/").filter(Boolean);
    const res = await graphFetchWithRetry(
      `/drives/${driveId}/root:/${driveItemPath(segments)}?${PUBLICATION_SELECT}`
    );
    if (!res.ok) {
      await res.text().catch(() => "");
      return;
    }
    await sweepItem(driveId, await res.json(), result);
  });
  return result;
}
async function sweepTreeCheckedOutByApp() {
  const driveId = await resolveDrive();
  const result = emptySweep();
  const folders = [`/drives/${driveId}/root/children`];
  const select = "$select=id,name,webUrl,folder,file,publication,lastModifiedBy&$top=200";
  while (folders.length > 0) {
    const batch = folders.splice(0, 4);
    await Promise.all(
      batch.map(async (start) => {
        let url = start.includes("?") ? start : `${start}?${select}`;
        while (url) {
          const res = await graphFetchWithRetry(url);
          if (!res.ok) {
            const text2 = await res.text().catch(() => "");
            if (result.errors.length < 10) result.errors.push(`list ${res.status}: ${text2.slice(0, 160)}`);
            return;
          }
          const page = await res.json();
          for (const child of page.value ?? []) {
            if (child.folder) folders.push(`/drives/${driveId}/items/${child.id}/children`);
            else if (child.file) await sweepItem(driveId, child, result);
          }
          url = page["@odata.nextLink"] ?? null;
        }
      })
    );
  }
  return result;
}
function getSharePointEnvStatus() {
  return {
    azureTenantSet: Boolean(process.env.AZURE_TENANT_ID?.trim()),
    azureClientSet: Boolean(process.env.AZURE_CLIENT_ID?.trim()),
    azureSecretSet: Boolean(process.env.AZURE_CLIENT_SECRET?.trim()),
    azureCertSet: hasCertificateConfigured(),
    azureCredentialMode: getAzureCredentialMode(),
    siteIdSet: Boolean(process.env.SHAREPOINT_SITE_ID?.trim()),
    siteHostname: process.env.SHAREPOINT_SITE_HOSTNAME?.trim() || "aceelectronics.sharepoint.us",
    sitePath: process.env.SHAREPOINT_SITE_PATH?.trim() || "/sites/jobtravelerphotos"
  };
}
async function probeSharePointAccess(options) {
  const credentialMode = getAzureCredentialMode();
  try {
    await getAccessToken();
    const siteId = await resolveSiteId();
    const driveId = await resolveDriveId(siteId);
    let uploadPath;
    if (options?.uploadTest) {
      const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
      const result = await uploadFileToSharePoint(
        "_ImageFlowProbe",
        "Testing",
        "PROBE",
        `probe-${stamp}.txt`,
        Buffer.from(`ImageFlow SharePoint probe ${stamp}
`, "utf8")
      );
      uploadPath = result.path;
    }
    return { ok: true, credentialMode, siteId, driveId, uploadPath };
  } catch (err) {
    return {
      ok: false,
      credentialMode,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

// server/excelParser.ts
import { readSheet } from "read-excel-file/node";
import { readdirSync } from "fs";
import { fileURLToPath as fileURLToPath2 } from "url";
import { dirname as dirname2, join as join2 } from "path";
var __filename = fileURLToPath2(import.meta.url);
var __dirname = dirname2(__filename);
var cachedData = null;
var currentFileName = null;
async function parseExcelFile(filePath) {
  const rows = await readSheet(filePath);
  const workOrderData = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const workOrder = row[4] != null ? String(row[4]).trim() : "";
    const customerName = row[6] != null ? String(row[6]).trim() : "";
    const rev = row[14] != null ? String(row[14]).trim() : "";
    const partNumber = row[9] != null ? String(row[9]).trim() : "";
    if (workOrder && partNumber) {
      workOrderData.push({
        workOrder,
        partNumber,
        customerName: customerName || "",
        rev: rev || ""
      });
    }
  }
  return workOrderData;
}
function getLatestExcelFile() {
  try {
    const assetsPath = join2(__dirname, "..", "attached_assets");
    const files = readdirSync(assetsPath);
    const excelFiles = files.filter(
      (file) => (file.startsWith("OpenOrdersAllQtyOnly_") || file === "OpenOrdersAllQtyOnly_seed.xlsx") && file.endsWith(".xlsx")
    );
    if (excelFiles.length === 0) {
      return null;
    }
    const ranked = [...excelFiles].sort((a, b) => {
      if (a.includes("seed") && !b.includes("seed")) return 1;
      if (b.includes("seed") && !a.includes("seed")) return -1;
      const timestampA = parseInt(a.match(/\d{10,}/)?.[0] || a.match(/\d+/)?.[0] || "0", 10);
      const timestampB = parseInt(b.match(/\d{10,}/)?.[0] || b.match(/\d+/)?.[0] || "0", 10);
      return timestampB - timestampA;
    });
    return ranked[0];
  } catch (error) {
    const code = error?.code || "";
    const msg = error?.message || String(error);
    if (code === "ENOENT" || msg.includes("ENOENT") || msg.includes("no such file")) {
      console.warn("[excelParser] attached_assets missing or unreadable \u2014 Excel work-order data unavailable until a file is mounted.");
    } else {
      console.warn("[excelParser] Could not find latest Excel file:", msg);
    }
    return null;
  }
}
async function reloadExcelData() {
  try {
    const latestFile = getLatestExcelFile();
    if (!latestFile) {
      return { success: false, error: "No Excel file found" };
    }
    const excelPath = join2(__dirname, "..", "attached_assets", latestFile);
    cachedData = await parseExcelFile(excelPath);
    currentFileName = latestFile;
    return { success: true, fileName: latestFile };
  } catch (error) {
    console.error("Error reloading Excel data:", error);
    return { success: false, error: error.message || String(error) };
  }
}
function getWorkOrderData() {
  return cachedData || [];
}
function getCurrentFileName() {
  return currentFileName;
}
function getPartNumbersByWorkOrder(workOrder) {
  const data = getWorkOrderData();
  return data.filter((item) => item.workOrder === workOrder).map((item) => ({
    partNumber: item.partNumber,
    rev: item.rev,
    customerName: item.customerName
  }));
}
function getAllWorkOrders() {
  const data = getWorkOrderData();
  const uniqueWorkOrders = Array.from(new Set(data.map((item) => item.workOrder)));
  return uniqueWorkOrders.sort();
}
(async () => {
  try {
    const latestFile = getLatestExcelFile();
    if (!latestFile) {
      console.warn(
        "[excelParser] No OpenOrders Excel file in attached_assets \u2014 work-order lookup empty until a file is mounted or SFTP sync runs."
      );
      return;
    }
    const excelPath = join2(__dirname, "..", "attached_assets", latestFile);
    cachedData = await parseExcelFile(excelPath);
    currentFileName = latestFile;
    console.log(`[excelParser] Loaded initial Excel file: ${latestFile}`);
  } catch (error) {
    const code = error?.code || "";
    const msg = error?.message || String(error);
    if (code === "ENOENT" || msg.includes("ENOENT") || msg.includes("no such file")) {
      console.warn("[excelParser] Initial Excel file missing \u2014 skipping load (SharePoint image uploads unaffected).");
    } else {
      console.warn("[excelParser] Skipping initial Excel load:", msg);
    }
  }
})();

// server/aceSso.ts
import { createHmac, timingSafeEqual } from "crypto";
var SSO_COOKIE = "ace_sso";
var SSO_JWT_EXPIRY_SECONDS = 8 * 60 * 60;
var SSO_REFRESH_THRESHOLD_SECONDS = 2 * 60 * 60;
function base64urlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function base64urlDecode(input) {
  const pad = (4 - input.length % 4) % 4;
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  return Buffer.from(b64, "base64");
}
function signHs256Jwt(payload, secret, expiresInSeconds) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1e3);
  const body = { ...payload, iat: now, exp: now + expiresInSeconds };
  const h = base64urlEncode(JSON.stringify(header));
  const p = base64urlEncode(JSON.stringify(body));
  const data = `${h}.${p}`;
  const sig = createHmac("sha256", secret).update(data).digest();
  return `${data}.${base64urlEncode(sig)}`;
}
function verifyHs256Jwt(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const data = `${h}.${p}`;
  const expected = createHmac("sha256", secret).update(data).digest();
  let actual;
  try {
    actual = base64urlDecode(s);
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  try {
    const payload = JSON.parse(base64urlDecode(p).toString("utf8"));
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1e3)) {
      return null;
    }
    if (!payload.sub || !payload.email) return null;
    return payload;
  } catch {
    return null;
  }
}
function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}
function cookieDomainOptions() {
  const domain = process.env.APP_DOMAIN;
  const isLocal = !domain || domain === "localhost" || domain === "127.0.0.1";
  return isLocal ? {} : { domain: `.${domain}` };
}
function useSecureCookies() {
  if (process.env.COOKIE_SECURE === "true") return true;
  if (process.env.COOKIE_SECURE === "false") return false;
  return process.env.NODE_ENV === "production";
}
function setAceSsoCookie(res, token) {
  res.cookie(SSO_COOKIE, token, {
    httpOnly: true,
    secure: useSecureCookies(),
    sameSite: "lax",
    path: "/",
    // Persist across browser reloads for the JWT lifetime (session cookies can
    // be dropped by some browsers / IT policies and look like a logout).
    maxAge: SSO_JWT_EXPIRY_SECONDS * 1e3,
    ...cookieDomainOptions()
  });
}
function clearAceSsoCookie(res) {
  res.cookie(SSO_COOKIE, "", {
    httpOnly: true,
    secure: useSecureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    ...cookieDomainOptions()
  });
}
function verifyAceSsoToken(token) {
  const secret = process.env.SSO_JWT_SECRET;
  if (!secret || !token) return null;
  return verifyHs256Jwt(token, secret);
}
function hasAppAccess(payload, app2) {
  if (!payload) return false;
  return payload.apps?.includes(app2) ?? false;
}
function refreshSsoTokenIfNeeded(token, payload, res) {
  try {
    const secret = process.env.SSO_JWT_SECRET;
    if (!secret) return;
    if (typeof payload.exp === "number" && payload.exp - Math.floor(Date.now() / 1e3) >= SSO_REFRESH_THRESHOLD_SECONDS) {
      return;
    }
    const newToken = signHs256Jwt(
      {
        sub: payload.sub,
        email: payload.email,
        name: payload.name,
        employeeId: payload.employeeId,
        groups: payload.groups,
        apps: payload.apps
      },
      secret,
      SSO_JWT_EXPIRY_SECONDS
    );
    setAceSsoCookie(res, newToken);
  } catch {
  }
}
function buildSsoLoginUrl(req, nextPath = "/") {
  const ssoBase = process.env.SSO_LOGIN_URL;
  if (!ssoBase) return null;
  const appUrl = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
  const callback = `${appUrl}/api/auth/sso/callback`;
  const withNext = nextPath && nextPath !== "/" ? `${callback}?next=${encodeURIComponent(nextPath)}` : callback;
  return `${ssoBase}?redirect_uri=${encodeURIComponent(withNext)}`;
}
function tryAceSsoFromRequest(req, res) {
  const cookies = parseCookies(req);
  const token = cookies[SSO_COOKIE];
  if (!token) return null;
  const payload = verifyAceSsoToken(token);
  if (!payload) return null;
  req.aceSsoUser = { ...payload, id: payload.sub };
  refreshSsoTokenIfNeeded(token, payload, res);
  return payload;
}
function requireAceSsoApp(app2) {
  return (req, res, next) => {
    if (!isSsoEnabled()) {
      req.aceSsoUser = {
        id: "local-dev",
        sub: "local-dev",
        email: "local@aceelectronics.com",
        name: "Local User",
        apps: [app2]
      };
      return next();
    }
    const payload = tryAceSsoFromRequest(req, res);
    if (!payload) {
      const loginUrl = buildSsoLoginUrl(req);
      if (loginUrl) {
        return res.status(401).json({
          error: "Unauthorized",
          ssoLoginUrl: loginUrl
        });
      }
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!hasAppAccess(payload, app2)) {
      return res.status(403).json({
        error: "Forbidden",
        message: "You do not have access to this application."
      });
    }
    next();
  };
}
var STATIC_ASSET_PREFIXES = [
  "/assets/",
  "/src/",
  // Vite dev
  "/@vite/",
  "/@fs/",
  "/@id/",
  "/@react-refresh",
  "/node_modules/"
];
var STATIC_ASSET_EXTENSIONS = /\.(js|mjs|cjs|css|map|ico|png|jpe?g|gif|svg|webp|woff2?|ttf|eot|txt|webmanifest)$/i;
function isPublicStaticPath(pathname) {
  if (STATIC_ASSET_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  if (STATIC_ASSET_EXTENSIONS.test(pathname)) return true;
  return false;
}
function requireAceSsoSpa(app2) {
  return (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path === "/health") return next();
    if (isPublicStaticPath(req.path)) return next();
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (!isSsoEnabled()) {
      return next();
    }
    const payload = tryAceSsoFromRequest(req, res);
    if (payload && hasAppAccess(payload, app2)) {
      return next();
    }
    const loginUrl = buildSsoLoginUrl(req, req.path || "/");
    if (loginUrl) {
      res.setHeader(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, private"
      );
      res.setHeader("Pragma", "no-cache");
      return res.redirect(302, loginUrl);
    }
    return next();
  };
}
function safeSpaNextPath(nextPath) {
  if (!nextPath || !nextPath.startsWith("/") || nextPath.startsWith("//")) return "/";
  if (isPublicStaticPath(nextPath)) return "/";
  return nextPath;
}
function registerAceSsoRoutes(app2, appSlug = "imageflow") {
  app2.get("/api/auth/sso/callback", (req, res) => {
    const rawToken = req.query.ace_token;
    const safeNext = safeSpaNextPath(req.query.next);
    if (!rawToken) return res.redirect(safeNext);
    const token = decodeURIComponent(rawToken);
    const payload = verifyAceSsoToken(token);
    if (!payload) return res.redirect("/");
    if (!hasAppAccess(payload, appSlug)) {
      clearAceSsoCookie(res);
      return res.status(403).send("You do not have access to ImageFlow. Contact your administrator.");
    }
    setAceSsoCookie(res, token);
    res.redirect(safeNext);
  });
  app2.get("/api/auth/sso/session", (req, res) => {
    if (!isSsoEnabled()) {
      return res.json({
        authenticated: true,
        via: "disabled",
        ssoEnabled: false,
        user: {
          id: "local-dev",
          email: "local@aceelectronics.com",
          name: "Local User",
          groups: [],
          apps: [appSlug]
        }
      });
    }
    const payload = tryAceSsoFromRequest(req, res);
    if (payload && hasAppAccess(payload, appSlug)) {
      return res.json({
        authenticated: true,
        via: "sso",
        ssoEnabled: true,
        user: {
          id: payload.sub,
          email: payload.email,
          name: payload.name,
          groups: payload.groups ?? [],
          apps: payload.apps ?? []
        }
      });
    }
    const loginUrl = buildSsoLoginUrl(req, "/");
    if (loginUrl) {
      return res.json({
        authenticated: false,
        ssoEnabled: true,
        ssoLoginUrl: loginUrl
      });
    }
    res.json({ authenticated: false, ssoEnabled: true });
  });
  app2.post("/api/auth/sso/logout", (_req, res) => {
    clearAceSsoCookie(res);
    res.json({ ok: true });
  });
  app2.get("/api/auth/sso/logout", (_req, res) => {
    clearAceSsoCookie(res);
    const ssoBase = process.env.SSO_LOGIN_URL;
    if (ssoBase) return res.redirect(ssoBase);
    res.redirect("/");
  });
}

// server/db.ts
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

// shared/schema.ts
var schema_exports = {};
__export(schema_exports, {
  UPLOAD_JOB_STATUSES: () => UPLOAD_JOB_STATUSES,
  insertUserSchema: () => insertUserSchema,
  uploadHistory: () => uploadHistory,
  uploadJobs: () => uploadJobs,
  users: () => users
});
import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
var users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull()
});
var insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true
});
var uploadHistory = pgTable("imageflow_upload_history", {
  id: text("id").primaryKey(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  workOrderNumber: text("work_order_number").notNull(),
  partNumber: text("part_number").notNull().default(""),
  rev: text("rev").notNull().default(""),
  customerName: text("customer_name").notNull(),
  folderPath: text("folder_path").notNull(),
  fileName: text("file_name"),
  webUrl: text("web_url"),
  dept: text("dept"),
  userId: text("user_id").notNull(),
  userEmail: text("user_email").notNull(),
  userName: text("user_name").notNull()
});
var bytea = customType({
  dataType() {
    return "bytea";
  }
});
var UPLOAD_JOB_STATUSES = [
  "staged",
  "uploading",
  "checkin_pending",
  "blocked",
  "done",
  "failed"
];
var uploadJobs = pgTable(
  "imageflow_upload_jobs",
  {
    id: text("id").primaryKey(),
    status: text("status").$type().notNull().default("staged"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    bytes: bytea("bytes"),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    fileName: text("file_name").notNull(),
    dept: text("dept").notNull(),
    customerName: text("customer_name").notNull(),
    workOrderNumber: text("work_order_number").notNull(),
    partNumber: text("part_number").notNull().default(""),
    rev: text("rev").notNull().default(""),
    userId: text("user_id").notNull(),
    userEmail: text("user_email").notNull(),
    userName: text("user_name").notNull(),
    sharepointPath: text("sharepoint_path"),
    sharepointItemId: text("sharepoint_item_id"),
    webUrl: text("web_url"),
    clientInfo: jsonb("client_info"),
    receivedMs: integer("received_ms"),
    graphMs: integer("graph_ms"),
    graphTimings: jsonb("graph_timings"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (t) => [
    index("imageflow_upload_jobs_status_next_idx").on(t.status, t.nextAttemptAt),
    index("imageflow_upload_jobs_user_idx").on(t.userId)
  ]
);

// server/db.ts
var { Pool } = pg;
var pool = null;
var db = null;
var ensurePromise = null;
function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL?.trim());
}
function getDb() {
  if (!isDatabaseConfigured()) {
    throw new Error("DATABASE_URL is not set \u2014 upload history requires Postgres");
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL.trim(),
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : void 0,
      max: 8
    });
    db = drizzle(pool, { schema: schema_exports });
  }
  return db;
}
function getPool() {
  getDb();
  return pool;
}
var ensureJobsPromise = null;
async function ensureUploadJobsTable() {
  if (!isDatabaseConfigured()) return;
  if (!ensureJobsPromise) {
    ensureJobsPromise = (async () => {
      const client = await getPool().connect();
      try {
        await client.query("SELECT pg_advisory_lock($1)", [874203152]);
        try {
          if (!await tableExists(client, "imageflow_upload_jobs")) {
            await client.query(`
              CREATE TABLE imageflow_upload_jobs (
                id text PRIMARY KEY,
                status text NOT NULL DEFAULT 'staged',
                attempts integer NOT NULL DEFAULT 0,
                next_attempt_at timestamptz NOT NULL DEFAULT now(),
                locked_until timestamptz,
                last_error text,
                bytes bytea,
                content_type text NOT NULL,
                size_bytes integer NOT NULL,
                sha256 text NOT NULL,
                file_name text NOT NULL,
                dept text NOT NULL,
                customer_name text NOT NULL,
                work_order_number text NOT NULL,
                part_number text NOT NULL DEFAULT '',
                rev text NOT NULL DEFAULT '',
                user_id text NOT NULL,
                user_email text NOT NULL,
                user_name text NOT NULL,
                sharepoint_path text,
                web_url text,
                client_info jsonb,
                received_ms integer,
                graph_ms integer,
                graph_timings jsonb,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now(),
                completed_at timestamptz
              )
            `);
          }
          await client.query(`
            ALTER TABLE imageflow_upload_jobs ADD COLUMN IF NOT EXISTS sharepoint_item_id text;
            CREATE INDEX IF NOT EXISTS imageflow_upload_jobs_status_next_idx
              ON imageflow_upload_jobs (status, next_attempt_at);
            CREATE INDEX IF NOT EXISTS imageflow_upload_jobs_user_idx
              ON imageflow_upload_jobs (user_id);
          `);
        } finally {
          await client.query("SELECT pg_advisory_unlock($1)", [874203152]);
        }
      } finally {
        client.release();
      }
    })().catch((err) => {
      ensureJobsPromise = null;
      throw err;
    });
  }
  await ensureJobsPromise;
}
async function tableExists(client, tableName) {
  const res = await client.query(
    `SELECT 1
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
      LIMIT 1`,
    [tableName]
  );
  return res.rowCount !== null && res.rowCount > 0;
}
async function ensureUploadHistoryTable() {
  if (!isDatabaseConfigured()) return;
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const client = await getPool().connect();
      try {
        await client.query("SELECT pg_advisory_lock($1)", [874203151]);
        try {
          if (await tableExists(client, "imageflow_upload_history")) {
            return;
          }
          try {
            await client.query(`
              CREATE TABLE imageflow_upload_history (
                id text PRIMARY KEY,
                uploaded_at timestamptz NOT NULL DEFAULT now(),
                work_order_number text NOT NULL,
                part_number text NOT NULL DEFAULT '',
                rev text NOT NULL DEFAULT '',
                customer_name text NOT NULL,
                folder_path text NOT NULL,
                file_name text,
                web_url text,
                dept text,
                user_id text NOT NULL,
                user_email text NOT NULL,
                user_name text NOT NULL
              )
            `);
          } catch (err) {
            const code = err?.code;
            const msg = String(err?.message || "");
            if (code === "23505" || msg.includes("pg_type_typname_nsp_index") || msg.includes("already exists")) {
              if (await tableExists(client, "imageflow_upload_history")) {
                return;
              }
            }
            throw err;
          }
          await client.query(`
            CREATE INDEX IF NOT EXISTS imageflow_upload_history_uploaded_at_idx
              ON imageflow_upload_history (uploaded_at DESC);
            CREATE INDEX IF NOT EXISTS imageflow_upload_history_user_id_idx
              ON imageflow_upload_history (user_id);
          `);
        } finally {
          await client.query("SELECT pg_advisory_unlock($1)", [874203151]);
        }
      } finally {
        client.release();
      }
    })().catch((err) => {
      ensurePromise = null;
      throw err;
    });
  }
  await ensurePromise;
}

// server/uploadHistory.ts
import { randomUUID as randomUUID2 } from "crypto";
import { desc, eq } from "drizzle-orm";
function toDto(row) {
  return {
    id: row.id,
    uploadedAt: row.uploadedAt.toISOString(),
    workOrderNumber: row.workOrderNumber,
    partNumber: row.partNumber,
    rev: row.rev,
    customerName: row.customerName,
    folderPath: row.folderPath,
    fileName: row.fileName ?? null,
    webUrl: row.webUrl ?? null,
    dept: row.dept ?? null,
    userId: row.userId,
    userEmail: row.userEmail,
    userName: row.userName
  };
}
async function recordUploadHistory(entry) {
  if (!isDatabaseConfigured()) {
    console.warn("[uploadHistory] DATABASE_URL not set \u2014 skipping history write");
    return null;
  }
  await ensureUploadHistoryTable();
  const db2 = getDb();
  const [row] = await db2.insert(uploadHistory).values({
    id: randomUUID2(),
    workOrderNumber: entry.workOrderNumber,
    partNumber: entry.partNumber,
    rev: entry.rev,
    customerName: entry.customerName,
    folderPath: entry.folderPath,
    fileName: entry.fileName ?? null,
    webUrl: entry.webUrl ?? null,
    dept: entry.dept ?? null,
    userId: entry.userId,
    userEmail: entry.userEmail,
    userName: entry.userName
  }).returning();
  return row ? toDto(row) : null;
}
async function listUploadHistory(options) {
  if (!isDatabaseConfigured()) {
    throw new Error("DATABASE_URL is not set \u2014 upload history requires Postgres");
  }
  await ensureUploadHistoryTable();
  const db2 = getDb();
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1e3);
  const rows = options.userId ? await db2.select().from(uploadHistory).where(eq(uploadHistory.userId, options.userId)).orderBy(desc(uploadHistory.uploadedAt)).limit(limit) : await db2.select().from(uploadHistory).orderBy(desc(uploadHistory.uploadedAt)).limit(limit);
  return rows.map(toDto);
}

// server/uploadJobs.ts
import { createHash as createHash2 } from "crypto";
var MAX_JOB_ATTEMPTS = 30;
var JOB_LEASE_SECONDS = 5 * 60;
var CHECKIN_RETRY_SECONDS = 2 * 60;
var DONE_RETENTION_DAYS = 30;
function toStatusDto(row) {
  return {
    id: row.id,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error ?? null,
    nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at).toISOString() : null,
    sharepointPath: row.sharepoint_path ?? null,
    webUrl: row.web_url ?? null,
    updatedAt: new Date(row.updated_at).toISOString()
  };
}
var STATUS_COLUMNS = "id, status, attempts, last_error, next_attempt_at, sharepoint_path, web_url, updated_at, user_id";
async function stageUploadJob(job) {
  await ensureUploadJobsTable();
  const sha256 = createHash2("sha256").update(job.bytes).digest("hex");
  const pool2 = getPool();
  const inserted = await pool2.query(
    `INSERT INTO imageflow_upload_jobs (
       id, status, bytes, content_type, size_bytes, sha256, file_name, dept,
       customer_name, work_order_number, part_number, rev,
       user_id, user_email, user_name, client_info, received_ms
     ) VALUES ($1, 'staged', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (id) DO NOTHING
     RETURNING ${STATUS_COLUMNS}`,
    [
      job.id,
      job.bytes,
      job.contentType,
      job.bytes.length,
      sha256,
      job.fileName,
      job.dept,
      job.customerName,
      job.workOrderNumber,
      job.partNumber,
      job.rev,
      job.userId,
      job.userEmail,
      job.userName,
      job.clientInfo ? JSON.stringify(job.clientInfo) : null,
      job.receivedMs
    ]
  );
  if (inserted.rows[0]) {
    return { created: true, row: toStatusDto(inserted.rows[0]), ownerId: job.userId };
  }
  const existing = await pool2.query(
    `SELECT ${STATUS_COLUMNS} FROM imageflow_upload_jobs WHERE id = $1`,
    [job.id]
  );
  const row = existing.rows[0];
  return { created: false, row: toStatusDto(row), ownerId: row.user_id };
}
async function getUploadJobStatuses(userId, ids) {
  if (ids.length === 0) return [];
  await ensureUploadJobsTable();
  const res = await getPool().query(
    `SELECT ${STATUS_COLUMNS} FROM imageflow_upload_jobs
      WHERE user_id = $1 AND id = ANY($2::text[])`,
    [userId, ids]
  );
  return res.rows.map(toStatusDto);
}
async function retryUploadJob(userId, id) {
  await ensureUploadJobsTable();
  const res = await getPool().query(
    `UPDATE imageflow_upload_jobs
        SET status = CASE WHEN status = 'checkin_pending' THEN 'checkin_pending' ELSE 'staged' END,
            attempts = 0, next_attempt_at = now(), locked_until = NULL, updated_at = now()
      WHERE id = $1 AND user_id = $2
        AND status IN ('failed', 'staged', 'blocked', 'checkin_pending')
        AND bytes IS NOT NULL
      RETURNING ${STATUS_COLUMNS}`,
    [id, userId]
  );
  return res.rows[0] ? toStatusDto(res.rows[0]) : null;
}
async function extendUploadJobLease(id) {
  await getPool().query(
    `UPDATE imageflow_upload_jobs
        SET locked_until = now() + ($2 || ' seconds')::interval
      WHERE id = $1 AND status IN ('uploading', 'checkin_pending')`,
    [id, String(JOB_LEASE_SECONDS)]
  );
}
async function claimNextUploadJob() {
  await ensureUploadJobsTable();
  const res = await getPool().query(
    `UPDATE imageflow_upload_jobs
        SET status = 'uploading',
            attempts = attempts + 1,
            locked_until = now() + ($1 || ' seconds')::interval,
            updated_at = now()
      WHERE id = (
        SELECT id FROM imageflow_upload_jobs
         WHERE bytes IS NOT NULL
           AND ((status = 'staged' AND next_attempt_at <= now())
             OR (status = 'uploading' AND locked_until < now()))
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, attempts, bytes, file_name, dept, customer_name, work_order_number,
                part_number, rev, user_id, user_email, user_name, created_at`,
    [String(JOB_LEASE_SECONDS)]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    attempts: row.attempts,
    bytes: row.bytes,
    fileName: row.file_name,
    dept: row.dept,
    customerName: row.customer_name,
    workOrderNumber: row.work_order_number,
    partNumber: row.part_number,
    rev: row.rev,
    userId: row.user_id,
    userEmail: row.user_email,
    userName: row.user_name,
    createdAt: new Date(row.created_at)
  };
}
async function claimNextCheckinJob() {
  await ensureUploadJobsTable();
  const res = await getPool().query(
    `UPDATE imageflow_upload_jobs
        SET locked_until = now() + ($1 || ' seconds')::interval, updated_at = now()
      WHERE id = (
        SELECT id FROM imageflow_upload_jobs
         WHERE status = 'checkin_pending'
           AND next_attempt_at <= now()
           AND (locked_until IS NULL OR locked_until < now())
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, sharepoint_path, sharepoint_item_id, work_order_number, part_number, rev,
                customer_name, file_name, dept, user_id, user_email, user_name, created_at`,
    [String(JOB_LEASE_SECONDS)]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    sharepointPath: row.sharepoint_path,
    sharepointItemId: row.sharepoint_item_id ?? null,
    workOrderNumber: row.work_order_number,
    partNumber: row.part_number,
    rev: row.rev,
    customerName: row.customer_name,
    fileName: row.file_name,
    dept: row.dept,
    userId: row.user_id,
    userEmail: row.user_email,
    userName: row.user_name,
    createdAt: new Date(row.created_at)
  };
}
async function markUploadJobDone(id, result) {
  await getPool().query(
    `UPDATE imageflow_upload_jobs
        SET status = 'done', bytes = NULL, locked_until = NULL, last_error = NULL,
            sharepoint_path = $2, sharepoint_item_id = $3, web_url = coalesce($4, web_url),
            graph_ms = coalesce($5, graph_ms), graph_timings = coalesce($6, graph_timings),
            completed_at = now(), updated_at = now()
      WHERE id = $1`,
    [
      id,
      result.sharepointPath,
      result.sharepointItemId,
      result.webUrl,
      result.graphMs ?? null,
      result.graphTimings ? JSON.stringify(result.graphTimings) : null
    ]
  );
}
async function markUploadJobCheckinPending(id, info) {
  await getPool().query(
    `UPDATE imageflow_upload_jobs
        SET status = 'checkin_pending', locked_until = NULL, last_error = $5,
            sharepoint_path = $2, sharepoint_item_id = $3, web_url = $4,
            next_attempt_at = now() + ($6 || ' seconds')::interval, updated_at = now()
      WHERE id = $1`,
    [id, info.sharepointPath, info.sharepointItemId, info.webUrl, info.error.slice(0, 1e3), String(CHECKIN_RETRY_SECONDS)]
  );
}
async function rescheduleCheckin(id, error) {
  await getPool().query(
    `UPDATE imageflow_upload_jobs
        SET locked_until = NULL, last_error = $2,
            next_attempt_at = now() + ($3 || ' seconds')::interval, updated_at = now()
      WHERE id = $1 AND status = 'checkin_pending'`,
    [id, error.slice(0, 1e3), String(CHECKIN_RETRY_SECONDS)]
  );
}
async function markUploadJobBlocked(id, error) {
  await getPool().query(
    `UPDATE imageflow_upload_jobs
        SET status = 'blocked', attempts = greatest(attempts - 1, 0), locked_until = NULL,
            last_error = $2, updated_at = now()
      WHERE id = $1`,
    [id, error.slice(0, 1e3)]
  );
}
async function countBlockedJobs() {
  await ensureUploadJobsTable();
  const res = await getPool().query(
    `SELECT count(*)::int AS n FROM imageflow_upload_jobs WHERE status = 'blocked'`
  );
  return res.rows[0]?.n ?? 0;
}
async function releaseBlockedJobs() {
  const res = await getPool().query(
    `UPDATE imageflow_upload_jobs
        SET status = 'staged', next_attempt_at = now(), updated_at = now()
      WHERE status = 'blocked' AND bytes IS NOT NULL`
  );
  return res.rowCount ?? 0;
}
function backoffSeconds(attempts) {
  const schedule = [15, 30, 60, 120];
  return schedule[attempts - 1] ?? 300;
}
async function markUploadJobFailed(id, attempts, error, options = {}) {
  const permanent = options.permanent === true || attempts >= MAX_JOB_ATTEMPTS;
  await getPool().query(
    `UPDATE imageflow_upload_jobs
        SET status = $2, last_error = $3, locked_until = NULL,
            next_attempt_at = now() + ($4 || ' seconds')::interval,
            updated_at = now()
      WHERE id = $1`,
    [id, permanent ? "failed" : "staged", error.slice(0, 1e3), String(backoffSeconds(attempts))]
  );
  return { permanent };
}
async function purgeOldUploadJobs() {
  await ensureUploadJobsTable();
  const res = await getPool().query(
    `DELETE FROM imageflow_upload_jobs
      WHERE status = 'done' AND completed_at < now() - ($1 || ' days')::interval`,
    [String(DONE_RETENTION_DAYS)]
  );
  return res.rowCount ?? 0;
}
async function getUploadQueueHealth() {
  await ensureUploadJobsTable();
  const res = await getPool().query(
    `SELECT
       count(*) FILTER (WHERE status IN ('staged', 'uploading'))::int AS pending,
       extract(epoch FROM now() - min(created_at) FILTER (WHERE status IN ('staged', 'uploading', 'blocked')))::int AS oldest_pending,
       count(*) FILTER (WHERE status = 'blocked')::int AS blocked,
       count(*) FILTER (WHERE status = 'checkin_pending')::int AS checkin_pending,
       extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'checkin_pending'))::int AS oldest_checkin,
       count(*) FILTER (WHERE status = 'failed' AND updated_at > now() - interval '24 hours')::int AS failed_24h,
       (SELECT left(last_error, 300) FROM imageflow_upload_jobs WHERE status = 'blocked' ORDER BY updated_at DESC LIMIT 1) AS blocked_error,
       (SELECT left(last_error, 300) FROM imageflow_upload_jobs WHERE status = 'checkin_pending' ORDER BY updated_at DESC LIMIT 1) AS checkin_error
     FROM imageflow_upload_jobs
     WHERE status <> 'done'`
  );
  const r = res.rows[0] ?? {};
  return {
    pending: r.pending ?? 0,
    oldestPendingSec: r.oldest_pending ?? null,
    blocked: r.blocked ?? 0,
    checkinPending: r.checkin_pending ?? 0,
    oldestCheckinPendingSec: r.oldest_checkin ?? null,
    failedLast24h: r.failed_24h ?? 0,
    latestBlockedError: r.blocked_error ?? null,
    latestCheckinError: r.checkin_error ?? null
  };
}
async function listRecentUploadPaths(days = 14) {
  await ensureUploadJobsTable();
  const pool2 = getPool();
  const paths = /* @__PURE__ */ new Set();
  const jobs = await pool2.query(
    `SELECT sharepoint_path FROM imageflow_upload_jobs
      WHERE sharepoint_path IS NOT NULL AND created_at > now() - ($1 || ' days')::interval`,
    [String(days)]
  );
  for (const r of jobs.rows) paths.add(r.sharepoint_path);
  try {
    const hist = await pool2.query(
      `SELECT folder_path, file_name FROM imageflow_upload_history
        WHERE file_name IS NOT NULL AND uploaded_at > now() - ($1 || ' days')::interval`,
      [String(days)]
    );
    for (const r of hist.rows) paths.add(`${r.folder_path}/${r.file_name}`);
  } catch {
  }
  return Array.from(paths);
}
async function getUploadStats(windowDays = 7) {
  await ensureUploadJobsTable();
  const pool2 = getPool();
  const interval = String(windowDays);
  const [current, counts, backlog, timings, devices, errors] = await Promise.all([
    getUploadQueueHealth(),
    pool2.query(
      `SELECT status, count(*)::int AS n FROM imageflow_upload_jobs
        WHERE created_at > now() - ($1 || ' days')::interval GROUP BY status`,
      [interval]
    ),
    pool2.query(
      `SELECT coalesce(sum(size_bytes), 0)::bigint AS b FROM imageflow_upload_jobs
        WHERE bytes IS NOT NULL`
    ),
    pool2.query(
      `SELECT
         percentile_cont(0.5) WITHIN GROUP (ORDER BY received_ms) AS rec_p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY received_ms) AS rec_p95,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY graph_ms) AS graph_p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY graph_ms) AS graph_p95,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - created_at) * 1000) AS e2e_p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - created_at) * 1000) AS e2e_p95
       FROM imageflow_upload_jobs
       WHERE created_at > now() - ($1 || ' days')::interval`,
      [interval]
    ),
    pool2.query(
      `SELECT coalesce(client_info->>'device', 'unknown') AS device,
              count(*)::int AS jobs,
              count(*) FILTER (WHERE status = 'failed')::int AS failed,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY received_ms) AS p95
         FROM imageflow_upload_jobs
        WHERE created_at > now() - ($1 || ' days')::interval
        GROUP BY 1 ORDER BY jobs DESC`,
      [interval]
    ),
    pool2.query(
      `SELECT left(last_error, 160) AS error, count(*)::int AS jobs
         FROM imageflow_upload_jobs
        WHERE created_at > now() - ($1 || ' days')::interval AND last_error IS NOT NULL
        GROUP BY 1 ORDER BY jobs DESC LIMIT 5`,
      [interval]
    )
  ]);
  const num = (v) => v === null || v === void 0 ? null : Math.round(Number(v));
  const t = timings.rows[0] ?? {};
  return {
    windowDays,
    counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
    current,
    backlogBytes: Number(backlog.rows[0]?.b ?? 0),
    receivedMs: { p50: num(t.rec_p50), p95: num(t.rec_p95) },
    graphMs: { p50: num(t.graph_p50), p95: num(t.graph_p95) },
    endToEndMs: { p50: num(t.e2e_p50), p95: num(t.e2e_p95) },
    byDevice: devices.rows.map((r) => ({
      device: r.device,
      jobs: r.jobs,
      failed: r.failed,
      p95ReceivedMs: num(r.p95)
    })),
    topErrors: errors.rows.map((r) => ({ error: r.error, jobs: r.jobs }))
  };
}

// server/uploadWorker.ts
import cron from "node-cron";

// server/uploadErrors.ts
var BLOCKED_PATTERNS = [
  /Missing required env var/i,
  /Missing Azure credentials/i,
  /looks like a Secret ID/i,
  /AZURE_CLIENT_CERT_PATH not found|Private key not found|Invalid base64 in/i,
  /Azure token request failed \(4\d\d\)/i,
  /SHAREPOINT_SITE_ID is set but not accessible/i,
  /Failed to resolve (SharePoint site|default drive)/i,
  /\((401|403)\)/
];
var PERMANENT_PATTERNS = [
  /SharePoint upload (session )?failed \(400\)/i,
  /Failed to create folder .* \(400\)/i
];
function classifyUploadError(err) {
  if (err instanceof SharePointCheckinError) return "checkin";
  const message = err instanceof Error ? err.message : String(err);
  if (BLOCKED_PATTERNS.some((re) => re.test(message))) return "blocked";
  if (PERMANENT_PATTERNS.some((re) => re.test(message))) return "permanent";
  return "transient";
}

// server/uploadWorker.ts
var CONCURRENCY = Math.max(1, Number(process.env.IMAGEFLOW_UPLOAD_CONCURRENCY) || 6);
var CHECKIN_CONCURRENCY = 2;
var POLL_MS = 2e3;
var HEARTBEAT_MS = 6e4;
var PROBE_EVERY_MS = 6e4;
var PURGE_EVERY_MS = 60 * 60 * 1e3;
var NIGHTLY_SWEEP_CRON = "15 2 * * *";
var started = false;
var active = 0;
var activeCheckins = 0;
var draining = false;
var lastPurgeAt = 0;
var lastProbeAt = 0;
var blocked = null;
var lastSweep = null;
var sweepRunning = false;
function folderOnlyPath(fullPath) {
  const parts = fullPath.split("/").filter(Boolean);
  if (parts.length <= 1) return fullPath;
  return parts.slice(0, -1).join("/");
}
function logUpload(event, fields) {
  console.log(`[upload] ${event} ${JSON.stringify(fields)}`);
}
function withHeartbeat(jobId, fn) {
  const timer = setInterval(() => {
    extendUploadJobLease(jobId).catch(
      (err) => console.warn("[upload] lease heartbeat failed:", err?.message || err)
    );
  }, HEARTBEAT_MS);
  return fn().finally(() => clearInterval(timer));
}
async function recordHistory(job, sharepointPath, webUrl) {
  try {
    await recordUploadHistory({
      workOrderNumber: job.workOrderNumber,
      partNumber: job.partNumber,
      rev: job.rev,
      customerName: job.customerName,
      folderPath: folderOnlyPath(sharepointPath),
      fileName: sharepointPath.split("/").pop() || job.fileName,
      webUrl,
      dept: job.dept,
      userId: job.userId,
      userEmail: job.userEmail,
      userName: job.userName
    });
  } catch (histErr) {
    console.warn("[uploadHistory] failed to record:", histErr?.message || histErr);
  }
}
function enterBlocked(reason) {
  if (!blocked) {
    blocked = { since: Date.now(), reason: reason.slice(0, 500) };
    console.error(`[upload] worker BLOCKED \u2014 pausing uploads until SharePoint access works: ${reason.slice(0, 300)}`);
  }
}
async function processJob(job) {
  const queueWaitMs = Date.now() - job.createdAt.getTime();
  try {
    const result = await withHeartbeat(
      job.id,
      () => uploadFileToSharePoint(job.customerName, job.dept, job.workOrderNumber, job.fileName, job.bytes)
    );
    await markUploadJobDone(job.id, {
      sharepointPath: result.path,
      sharepointItemId: result.itemId,
      webUrl: result.webUrl ?? null,
      graphMs: result.timings.totalMs,
      graphTimings: result.timings
    });
    logUpload("done", { id: job.id, attempt: job.attempts, bytes: job.bytes.length, queueWaitMs, ...result.timings });
    await recordHistory(job, result.path, result.webUrl ?? null);
  } catch (err) {
    const message = err?.message || String(err);
    const kind = classifyUploadError(err);
    if (kind === "checkin" && err instanceof SharePointCheckinError) {
      await markUploadJobCheckinPending(job.id, {
        sharepointPath: err.path,
        sharepointItemId: err.itemId,
        webUrl: err.webUrl ?? null,
        error: message
      });
      logUpload("checkin_pending", { id: job.id, path: err.path, error: message.slice(0, 300) });
      return;
    }
    if (kind === "blocked") {
      await markUploadJobBlocked(job.id, message);
      enterBlocked(message);
      logUpload("blocked", { id: job.id, error: message.slice(0, 300) });
      return;
    }
    const { permanent } = await markUploadJobFailed(job.id, job.attempts, message, {
      permanent: kind === "permanent"
    });
    logUpload(permanent ? "failed" : "retry", {
      id: job.id,
      attempt: job.attempts,
      queueWaitMs,
      error: message.slice(0, 300)
    });
  }
}
async function processCheckinJob(job) {
  try {
    const result = await withHeartbeat(
      job.id,
      () => retryCheckIn(job.sharepointItemId, job.sharepointPath)
    );
    await markUploadJobDone(job.id, {
      sharepointPath: job.sharepointPath,
      sharepointItemId: result.itemId,
      webUrl: result.webUrl ?? null
    });
    logUpload("checkin_repaired", { id: job.id, path: job.sharepointPath });
    await recordHistory(job, job.sharepointPath, result.webUrl ?? null);
  } catch (err) {
    const message = err?.message || String(err);
    await rescheduleCheckin(job.id, message);
    logUpload("checkin_retry", { id: job.id, error: message.slice(0, 300) });
  }
}
async function maybeProbeBlocked() {
  if (Date.now() - lastProbeAt < PROBE_EVERY_MS) return;
  lastProbeAt = Date.now();
  const blockedRows = await countBlockedJobs();
  if (!blocked && blockedRows === 0) return;
  const probe = await probeSharePointAccess();
  if (!probe.ok) {
    enterBlocked(probe.error || "SharePoint probe failed");
    return;
  }
  const released = await releaseBlockedJobs();
  if (blocked || released > 0) {
    logUpload("unblocked", {
      blockedForSec: blocked ? Math.round((Date.now() - blocked.since) / 1e3) : null,
      released
    });
  }
  blocked = null;
}
async function drain() {
  if (draining) return;
  draining = true;
  try {
    await maybeProbeBlocked();
    while (!blocked && active < CONCURRENCY) {
      const job = await claimNextUploadJob();
      if (!job) break;
      active++;
      void processJob(job).finally(() => {
        active--;
        kickUploadWorker();
      });
    }
    while (activeCheckins < CHECKIN_CONCURRENCY) {
      const job = await claimNextCheckinJob();
      if (!job) break;
      activeCheckins++;
      void processCheckinJob(job).finally(() => {
        activeCheckins--;
      });
    }
  } catch (err) {
    console.error("[upload] worker claim failed:", err?.message || err);
  } finally {
    draining = false;
  }
  if (Date.now() - lastPurgeAt > PURGE_EVERY_MS) {
    lastPurgeAt = Date.now();
    purgeOldUploadJobs().then((n) => n > 0 && logUpload("purged", { rows: n })).catch((err) => console.warn("[upload] purge failed:", err?.message || err));
  }
}
async function runCheckinSweep(mode) {
  if (sweepRunning && lastSweep) return lastSweep;
  sweepRunning = true;
  const run = {
    mode,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    finishedAt: null,
    result: null,
    error: null
  };
  lastSweep = run;
  try {
    run.result = mode === "full" ? await sweepTreeCheckedOutByApp() : await sweepPathsCheckedOutByApp(await listRecentUploadPaths(14));
    logUpload("checkin_sweep", { mode, ...run.result, errors: run.result.errors.length });
  } catch (err) {
    run.error = (err?.message || String(err)).slice(0, 500);
    console.error(`[upload] check-in sweep (${mode}) failed:`, run.error);
  } finally {
    run.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
    sweepRunning = false;
  }
  return run;
}
function kickUploadWorker() {
  if (!started) return;
  setImmediate(() => void drain());
}
function startUploadWorker() {
  if (started) return;
  if (!isDatabaseConfigured()) {
    console.warn("[upload] DATABASE_URL not set \u2014 staging queue disabled; legacy sync upload only");
    return;
  }
  if (process.env.IMAGEFLOW_UPLOAD_WORKER === "false") {
    console.warn("[upload] IMAGEFLOW_UPLOAD_WORKER=false \u2014 worker not started in this process");
    return;
  }
  started = true;
  console.log(`[upload] worker started (concurrency=${CONCURRENCY})`);
  setInterval(() => void drain(), POLL_MS).unref();
  cron.schedule(NIGHTLY_SWEEP_CRON, () => void runCheckinSweep("recent"), {
    timezone: "America/New_York"
  });
  void drain();
}
function getUploadWorkerStatus() {
  return {
    started,
    active,
    activeCheckins,
    concurrency: CONCURRENCY,
    blocked: blocked ? { since: new Date(blocked.since).toISOString(), reason: blocked.reason } : null,
    lastSweep
  };
}

// server/routes.ts
var JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var MAX_STATUS_IDS = 100;
function userIdOf(req) {
  const user = req.aceSsoUser;
  return user?.id || user?.sub || null;
}
function isImageflowAdmin(req) {
  const user = req.aceSsoUser;
  if (!user) return false;
  if (user.id === "local-dev") return true;
  const allow = (process.env.IMAGEFLOW_ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (user.email && allow.includes(user.email.toLowerCase())) return true;
  return (user.groups || []).some((g) => /admin/i.test(g));
}
function parseClientInfo(req) {
  const info = {};
  const device = req.get("x-imageflow-device");
  if (device) info.device = device.slice(0, 40);
  const raw = req.get("x-imageflow-client-ms");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "number" && Number.isFinite(v)) info[k] = Math.round(v);
        }
      }
    } catch {
    }
  }
  return Object.keys(info).length ? info : null;
}
function markRequestStart(req, _res, next) {
  req.imageflowStartedAt = Date.now();
  next();
}
async function handleStageJob(req, res) {
  if (!isDatabaseConfigured()) {
    return res.status(503).json({
      error: "Staging queue unavailable",
      message: "DATABASE_URL is not configured; use the direct upload route.",
      fallback: "sync"
    });
  }
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  if (!/^image\//i.test(req.file.mimetype || "")) {
    return res.status(400).json({ error: "Only image files can be uploaded" });
  }
  const { jobId, customerName, dept, workOrderNumber, imageName, partNumber, rev } = req.body;
  if (!jobId || !JOB_ID_RE.test(String(jobId))) {
    return res.status(400).json({ error: "Missing or invalid jobId" });
  }
  if (!customerName || !dept || !workOrderNumber || !imageName) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  const userId = userIdOf(req);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  const user = req.aceSsoUser;
  const extension = (req.file.originalname.split(".").pop() || "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
  const fileName = `${String(imageName)}.${extension}`;
  try {
    const staged = await stageUploadJob({
      id: String(jobId).toLowerCase(),
      bytes: req.file.buffer,
      contentType: req.file.mimetype,
      fileName,
      dept: String(dept),
      customerName: String(customerName),
      workOrderNumber: String(workOrderNumber),
      partNumber: String(partNumber ?? ""),
      rev: String(rev ?? ""),
      userId,
      userEmail: user.email || "unknown",
      userName: user.name || user.email || "Unknown User",
      clientInfo: parseClientInfo(req),
      receivedMs: Date.now() - (req.imageflowStartedAt ?? Date.now())
    });
    if (staged.ownerId !== userId) {
      return res.status(409).json({ error: "Job id already used" });
    }
    if (staged.created) {
      console.log(
        `[upload] staged ${JSON.stringify({ id: staged.row.id, bytes: req.file.size, receivedMs: Date.now() - (req.imageflowStartedAt ?? Date.now()) })}`
      );
      kickUploadWorker();
      res.locals.auditRecord = { type: "upload", id: staged.row.id, label: fileName };
    } else {
      req.imageflowAuditSkip = true;
    }
    res.status(202).json(staged.row);
  } catch (error) {
    console.error("[upload] stage failed:", error);
    res.status(500).json({ error: "Could not stage upload", message: error?.message || String(error) });
  }
}
var MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
var upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES }
});
var requireImageflow = requireAceSsoApp("imageflow");
function acceptImageFile(req, res, next) {
  upload.single("imageFile")(req, res, (err) => {
    if (err?.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: "File too large",
        message: "Image must be 25 MB or smaller."
      });
    }
    if (err) return next(err);
    next();
  });
}
async function ensureWorkOrderDataLoaded() {
  if (getAllWorkOrders().length > 0 || !isExcelSyncAvailable()) return;
  const syncResult = await checkForNewExcelFile();
  if (syncResult.success) {
    await reloadExcelData();
  }
}
function folderOnlyPath2(fullPath) {
  const parts = fullPath.split("/").filter(Boolean);
  if (parts.length <= 1) return fullPath;
  return parts.slice(0, -1).join("/");
}
async function handleImageUpload(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const { customerName, dept, workOrderNumber, imageName, partNumber, rev } = req.body;
    if (!customerName || !dept || !workOrderNumber || !imageName) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const extension = req.file.originalname.split(".").pop() || "jpg";
    const fileName = `${imageName}.${extension}`;
    const result = await uploadFileToSharePoint(
      customerName,
      dept,
      workOrderNumber,
      fileName,
      req.file.buffer
    );
    const user = req.aceSsoUser;
    try {
      await recordUploadHistory({
        workOrderNumber: String(workOrderNumber),
        partNumber: String(partNumber ?? ""),
        rev: String(rev ?? ""),
        customerName: String(customerName),
        folderPath: folderOnlyPath2(result.path),
        fileName,
        webUrl: result.webUrl ?? null,
        dept: String(dept),
        userId: user?.id || user?.sub || "unknown",
        userEmail: user?.email || "unknown",
        userName: user?.name || user?.email || "Unknown User"
      });
    } catch (histErr) {
      console.warn("[uploadHistory] failed to record:", histErr?.message || histErr);
    }
    res.locals.auditRecord = { type: "upload", label: fileName };
    res.json(result);
  } catch (error) {
    console.error("SharePoint upload error:", error);
    const msg = error.message || "";
    const isAuthFailure = msg.includes("Missing required env var") || msg.includes("Azure token") || msg.includes("UNAUTHORIZED") || msg.includes("401") || msg.includes("403");
    if (isAuthFailure) {
      return res.status(401).json({
        error: "SharePoint not configured",
        message: msg || "SharePoint / Azure Graph credentials are missing or invalid. Check AZURE_* and SHAREPOINT_* env vars.",
        requiresAuth: true
      });
    }
    res.status(500).json({
      error: "Upload failed",
      message: msg || "Unknown upload error"
    });
  }
}
async function registerRoutes(app2) {
  app2.post(
    "/api/upload/sharepoint",
    requireImageflow,
    acceptImageFile,
    handleImageUpload
  );
  app2.post(
    "/api/upload/gdrive",
    requireImageflow,
    acceptImageFile,
    handleImageUpload
  );
  app2.post(
    "/api/upload/jobs",
    markRequestStart,
    requireImageflow,
    acceptImageFile,
    handleStageJob
  );
  app2.get("/api/upload/jobs", requireImageflow, async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    if (!isDatabaseConfigured()) return res.json({ items: [], databaseConfigured: false });
    const ids = String(req.query.ids || "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => JOB_ID_RE.test(s)).slice(0, MAX_STATUS_IDS);
    try {
      const items = await getUploadJobStatuses(userId, ids);
      res.json({ items, databaseConfigured: true });
    } catch (error) {
      console.error("[upload] status lookup failed:", error);
      res.status(500).json({ error: "Status lookup failed", message: error?.message || String(error) });
    }
  });
  app2.post("/api/upload/jobs/:id/retry", requireImageflow, async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const id = String(req.params.id || "").toLowerCase();
    if (!JOB_ID_RE.test(id)) return res.status(400).json({ error: "Invalid job id" });
    if (!isDatabaseConfigured()) return res.status(503).json({ error: "Staging queue unavailable" });
    try {
      const row = await retryUploadJob(userId, id);
      if (!row) return res.status(404).json({ error: "Job not found or not retryable" });
      kickUploadWorker();
      res.json(row);
    } catch (error) {
      console.error("[upload] retry failed:", error);
      res.status(500).json({ error: "Retry failed", message: error?.message || String(error) });
    }
  });
  app2.get("/api/upload/stats", requireImageflow, async (req, res) => {
    if (!isImageflowAdmin(req)) return res.status(403).json({ error: "Admin only" });
    if (!isDatabaseConfigured()) return res.status(503).json({ error: "DATABASE_URL not set" });
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    try {
      const stats = await getUploadStats(days);
      res.json({ ...stats, worker: getUploadWorkerStatus() });
    } catch (error) {
      console.error("[upload] stats failed:", error);
      res.status(500).json({ error: "Stats failed", message: error?.message || String(error) });
    }
  });
  app2.post("/api/upload/checkin-sweep", requireImageflow, (req, res) => {
    if (!isImageflowAdmin(req)) return res.status(403).json({ error: "Admin only" });
    if (!isDatabaseConfigured()) return res.status(503).json({ error: "DATABASE_URL not set" });
    const mode = String(req.query.mode || req.body?.mode || "recent") === "full" ? "full" : "recent";
    void runCheckinSweep(mode);
    res.status(202).json({ started: true, mode, lastSweep: getUploadWorkerStatus().lastSweep });
  });
  app2.get("/api/upload-history", requireImageflow, async (req, res) => {
    try {
      const scope = String(req.query.scope || "mine").toLowerCase();
      const user = req.aceSsoUser;
      const userId = user?.id || user?.sub;
      if (scope === "all") {
        const rows2 = await listUploadHistory({});
        return res.json({
          scope: "all",
          databaseConfigured: isDatabaseConfigured(),
          items: rows2
        });
      }
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const rows = await listUploadHistory({ userId });
      res.json({
        scope: "mine",
        databaseConfigured: isDatabaseConfigured(),
        items: rows
      });
    } catch (error) {
      console.error("Error fetching upload history:", error);
      res.status(500).json({
        error: "Failed to fetch upload history",
        message: error.message || String(error),
        databaseConfigured: isDatabaseConfigured()
      });
    }
  });
  app2.get("/api/work-orders", requireImageflow, async (_req, res) => {
    try {
      await ensureWorkOrderDataLoaded();
      res.json(getAllWorkOrders());
    } catch (error) {
      console.error("Error fetching work orders:", error);
      res.status(500).json({ error: "Failed to fetch work orders" });
    }
  });
  app2.get("/api/part-numbers/:workOrder", requireImageflow, async (req, res) => {
    try {
      await ensureWorkOrderDataLoaded();
      const { workOrder } = req.params;
      res.json(getPartNumbersByWorkOrder(workOrder));
    } catch (error) {
      console.error("Error fetching part numbers:", error);
      res.status(500).json({ error: "Failed to fetch part numbers" });
    }
  });
  app2.get("/api/excel-info", requireImageflow, (req, res) => {
    try {
      const fileName = getCurrentFileName();
      res.json({ fileName });
    } catch (error) {
      console.error("Error getting Excel info:", error);
      res.status(500).json({ error: "Failed to get Excel info" });
    }
  });
  app2.post("/api/check-excel-updates", requireImageflow, async (req, res) => {
    try {
      const syncResult = await checkForNewExcelFile();
      if (!syncResult.success) {
        return res.json(syncResult);
      }
      const reloadResult = await reloadExcelData();
      if (!reloadResult.success) {
        return res.status(500).json({
          success: false,
          message: "Excel file downloaded but failed to load",
          error: reloadResult.error
        });
      }
      res.json({
        success: true,
        message: "Excel data updated successfully from SFTP",
        fileName: syncResult.fileName,
        fileDate: syncResult.fileDate,
        originalFileName: syncResult.originalFileName,
        currentFile: reloadResult.fileName,
        source: "SFTP"
      });
    } catch (error) {
      console.error("Error checking for Excel updates:", error);
      res.status(500).json({
        success: false,
        error: "Failed to check for Excel updates",
        message: error.message || String(error)
      });
    }
  });
  const httpServer = createServer(app2);
  return httpServer;
}

// server/scheduler.ts
import cron2 from "node-cron";
async function runExcelUpdate(label) {
  console.log(`[Scheduler] ${label}`);
  try {
    const syncResult = await checkForNewExcelFile();
    if (!syncResult.success) {
      console.log(`[Scheduler] No new Excel file found: ${syncResult.message}`);
      return;
    }
    console.log(`[Scheduler] New Excel file found: ${syncResult.originalFileName}`);
    const reloadResult = await reloadExcelData();
    if (!reloadResult.success) {
      console.error(`[Scheduler] Failed to reload Excel data: ${reloadResult.error}`);
      return;
    }
    console.log(`[Scheduler] \u2713 Excel data successfully updated from ${syncResult.originalFileName}`);
    console.log(`[Scheduler] \u2713 Current file: ${reloadResult.fileName}`);
  } catch (error) {
    console.error("[Scheduler] Error during scheduled Excel update:", error.message);
  }
}
function initializeScheduler() {
  if (!isExcelSyncAvailable()) {
    console.warn(
      "[Scheduler] Excel SFTP sync disabled \u2014 set SFTP_HOST, SFTP_USER, and SFTP_PASSWORD. SharePoint image uploads are unaffected."
    );
    return;
  }
  console.log("[Scheduler] Initializing Excel SFTP update scheduler...");
  const cronExpression = "20 7 * * *";
  cron2.schedule(cronExpression, async () => {
    const timestamp2 = (/* @__PURE__ */ new Date()).toLocaleString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    await runExcelUpdate(`Running scheduled Excel SFTP update at ${timestamp2} EST/EDT`);
  }, {
    timezone: "America/New_York"
  });
  console.log("[Scheduler] \u2713 Excel SFTP scheduler initialized (daily at 7:20 AM EST/EDT)");
  setTimeout(async () => {
    try {
      await runExcelUpdate("Running initial Excel SFTP update check on server startup...");
    } catch (error) {
      console.error("[Scheduler] Initial update check error:", error?.message || String(error));
    }
  }, 1e4);
}

// server/activityAudit.ts
var WRITE_METHODS = /* @__PURE__ */ new Set(["POST", "PUT", "PATCH", "DELETE"]);
var DEFAULT_SKIP = [
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
  /\/search(\/|$)/i
];
var ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{24,})$/i;
function str(value, max = 200) {
  if (value === null || value === void 0) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}
function pick(obj, ...keys) {
  if (!obj || typeof obj !== "object") return void 0;
  const rec = obj;
  for (const key of keys) {
    if (rec[key] !== void 0 && rec[key] !== null && rec[key] !== "") return rec[key];
  }
  return void 0;
}
function defaultAuditIdentity(req) {
  const session = req.session;
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
        displayName: str(pick(src, "displayName", "display_name", "name", "fullName", "technicianName"), 200)
      };
    }
  }
  return null;
}
function stripQuery(url) {
  const q = url.indexOf("?");
  return (q >= 0 ? url.slice(0, q) : url).slice(0, 300);
}
function routePattern(req) {
  const routePath = typeof req.route?.path === "string" ? req.route.path : null;
  if (routePath) return `${req.baseUrl || ""}${routePath}`.slice(0, 300) || "/";
  return stripQuery(req.originalUrl || req.url || "/").split("/").map((seg) => ID_SEGMENT.test(seg) ? ":id" : seg).join("/");
}
function singular(word) {
  if (/ies$/i.test(word)) return word.slice(0, -3) + "y";
  if (/(ses|xes|ches|shes)$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.slice(0, -1);
  return word;
}
function describeRoute(method, pattern, req) {
  const segments = pattern.split("/").filter((seg) => seg && seg !== "api");
  let recordType = null;
  let recordId = null;
  let actionSuffix = null;
  let sawParam = false;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg.startsWith(":")) {
      const key = seg.slice(1).replace(/[?*+].*$/, "");
      const val = req.params?.[key];
      if (val !== void 0) recordId = str(val, 120);
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
  let action;
  if (actionSuffix) action = actionSuffix.replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "action";
  else if (method === "DELETE") action = "delete";
  else if (method === "POST" && !recordId) action = "create";
  else if (method === "POST") action = "action";
  else action = "update";
  return { recordType, recordId, action };
}
function refererPath(req) {
  const referer = req.headers.referer;
  if (typeof referer !== "string") return null;
  try {
    const u = new URL(referer);
    return (u.pathname + u.hash).slice(0, 300);
  } catch {
    return null;
  }
}
function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  if (raw && raw.trim()) return raw.split(",")[0].trim();
  return req.ip?.trim() || null;
}
function httpSink() {
  const base = process.env.PLATFORM_INGEST_URL?.trim();
  const secret = process.env.PLATFORM_AUDIT_INGEST_SECRET?.trim();
  if (!base || !secret) return null;
  const url = `${base.replace(/\/$/, "")}/api/platform/usage-events`;
  return (events) => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Platform-Audit-Secret": secret },
    body: JSON.stringify({ events })
  });
}
function createBatcher(sink) {
  let queue = [];
  let timer = null;
  const flush = () => {
    timer = null;
    if (!sink || queue.length === 0) return;
    while (queue.length) {
      const batch = queue.splice(0, 50);
      void Promise.resolve().then(() => sink(batch)).catch(() => {
      });
    }
  };
  return (ev) => {
    if (queue.length > 500) return;
    queue.push(ev);
    if (queue.length >= 50) flush();
    else if (!timer) timer = setTimeout(flush, 2e3);
  };
}
function createActivityAudit(options) {
  const sink = options.sink ?? httpSink();
  const getIdentity = options.getIdentity ?? defaultAuditIdentity;
  const enqueue = createBatcher(sink);
  return function activityAudit(rawReq, rawRes, next) {
    const req = rawReq;
    const res = rawRes;
    if (!sink || !WRITE_METHODS.has(String(req.method).toUpperCase())) return next();
    const rawPath = stripQuery(req.originalUrl || req.url || "");
    if (DEFAULT_SKIP.some((re) => re.test(rawPath))) return next();
    let responseRecord = null;
    if (typeof res.json === "function") {
      const original = res.json.bind(res);
      res.json = (body) => {
        try {
          const data = pick(body, "data");
          const target = data && typeof data === "object" && !Array.isArray(data) ? data : body;
          if (target && typeof target === "object" && !Array.isArray(target)) {
            responseRecord = {
              id: pick(target, "id", "uuid"),
              label: str(pick(target, "name", "title", "label", "displayName", "partNumber", "part_number"), 120)
            };
          }
        } catch {
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
        const explicit = res.locals?.auditRecord ?? null;
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
          metadata: { recordType, recordId, recordLabel }
        });
      } catch {
      }
    });
    next();
  };
}
var RELAY_EVENT_TYPES = /* @__PURE__ */ new Set(["page_view", "feature", "api_error"]);
function createUsageRelay(options) {
  const sink = options.sink ?? httpSink();
  const getIdentity = options.getIdentity ?? defaultAuditIdentity;
  const enqueue = createBatcher(sink);
  const allowed = /* @__PURE__ */ new Set([options.appSlug, ...options.allowedAppSlugs ?? []]);
  return function usageRelay(rawReq, rawRes) {
    const req = rawReq;
    const res = rawRes;
    try {
      const identity = sink ? getIdentity(req) : null;
      if (identity && (identity.email || identity.ssoUserId || identity.employeeId)) {
        const events = pick(req.body, "events");
        const list = Array.isArray(events) ? events.slice(0, 50) : [];
        for (const raw of list) {
          if (!raw || typeof raw !== "object") continue;
          const ev = raw;
          const eventType = String(ev.eventType ?? "");
          if (!RELAY_EVENT_TYPES.has(eventType)) continue;
          const slug = str(ev.appSlug, 60)?.toLowerCase();
          const status = Number(ev.httpStatus);
          const metadata = ev.metadata && typeof ev.metadata === "object" && !Array.isArray(ev.metadata) && JSON.stringify(ev.metadata).length <= 2e3 ? ev.metadata : {};
          enqueue({
            appSlug: slug && allowed.has(slug) ? slug : options.appSlug,
            eventType,
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
            metadata
          });
        }
      }
    } catch {
    }
    res.status(204).end();
  };
}

// server/uploadMonitor.ts
var CHECK_EVERY_MS = 6e4;
var REALERT_AFTER_MS = 30 * 60 * 1e3;
var STUCK_AFTER_SEC = 5 * 60;
var CHECKIN_STUCK_AFTER_SEC = 15 * 60;
var DB_FAILURES_BEFORE_ALERT = 3;
var started2 = false;
var snapshot = null;
var dbFailures = 0;
var lastDbError = "";
var lastAlertAt = /* @__PURE__ */ new Map();
function getUploadQueueSnapshot() {
  return snapshot;
}
function webhookUrl() {
  return process.env.IMAGEFLOW_ALERT_WEBHOOK?.trim() || null;
}
function appLabel() {
  const url = process.env.APP_URL?.trim() || "ImageFlow";
  return url.replace(/^https?:\/\//, "");
}
function minutes(sec) {
  if (sec === null) return "?";
  return sec < 120 ? `${sec}s` : `${Math.round(sec / 60)} min`;
}
async function postToTeams(title, lines, tone) {
  const url = webhookUrl();
  if (!url) return;
  const text2 = `**${title}**

${lines.join("\n\n")}`;
  const payload = {
    type: "message",
    text: text2,
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", color: tone, wrap: true },
            ...lines.map((line) => ({ type: "TextBlock", text: line, wrap: true, spacing: "Small" }))
          ]
        }
      }
    ]
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(1e4)
    });
    if (!res.ok) console.warn(`[upload-monitor] Teams webhook returned ${res.status}`);
  } catch (err) {
    console.warn("[upload-monitor] Teams webhook failed:", err?.message || err);
  }
}
async function evaluate(key, active2, title, lines) {
  const last = lastAlertAt.get(key);
  if (active2) {
    if (last && Date.now() - last < REALERT_AFTER_MS) return;
    lastAlertAt.set(key, Date.now());
    console.warn(`[upload-monitor] ALERT ${key}: ${lines.join(" | ")}`);
    await postToTeams(`ImageFlow: ${title}`, [...lines, `Server: ${appLabel()}`], "attention");
    return;
  }
  if (last) {
    lastAlertAt.delete(key);
    console.log(`[upload-monitor] resolved ${key}`);
    await postToTeams(`ImageFlow resolved: ${title}`, [`Back to normal on ${appLabel()}.`], "good");
  }
}
async function check() {
  let health;
  try {
    health = await getUploadQueueHealth();
    dbFailures = 0;
  } catch (err) {
    dbFailures++;
    lastDbError = (err?.message || String(err)).slice(0, 300);
    await evaluate("monitor", dbFailures >= DB_FAILURES_BEFORE_ALERT, "upload queue database unreachable", [
      `The upload queue could not be read ${dbFailures} times in a row. New photos cannot be accepted.`,
      `Error: ${lastDbError}`
    ]);
    return;
  }
  await evaluate("monitor", false, "upload queue database unreachable", []);
  snapshot = { ...health, checkedAt: (/* @__PURE__ */ new Date()).toISOString() };
  const worker = getUploadWorkerStatus();
  await evaluate(
    "blocked",
    health.blocked > 0 || worker.blocked !== null,
    "SharePoint uploads are BLOCKED",
    [
      `${health.blocked} photo(s) are waiting because ImageFlow cannot write to SharePoint (configuration or permission problem).`,
      `Photos are safe on the server and upload automatically once access works again.`,
      `Error: ${(worker.blocked?.reason || health.latestBlockedError || "unknown").slice(0, 300)}`
    ]
  );
  await evaluate(
    "stuck",
    health.oldestPendingSec !== null && health.oldestPendingSec > STUCK_AFTER_SEC,
    "photos are waiting too long",
    [
      `${health.pending + health.blocked} photo(s) not yet in SharePoint; oldest has waited ${minutes(health.oldestPendingSec)}.`,
      `Expected: under 1 minute.`
    ]
  );
  await evaluate(
    "checkin",
    health.oldestCheckinPendingSec !== null && health.oldestCheckinPendingSec > CHECKIN_STUCK_AFTER_SEC,
    "photos uploaded but NOT checked in",
    [
      `${health.checkinPending} photo(s) are in SharePoint but still checked out (invisible to users); oldest ${minutes(health.oldestCheckinPendingSec)}.`,
      `Error: ${(health.latestCheckinError || "unknown").slice(0, 300)}`
    ]
  );
}
function startUploadMonitor() {
  if (started2 || !isDatabaseConfigured()) return;
  started2 = true;
  if (!webhookUrl()) {
    console.warn("[upload-monitor] IMAGEFLOW_ALERT_WEBHOOK not set \u2014 alerts only go to the container log");
  }
  setInterval(() => void check(), CHECK_EVERY_MS).unref();
  setTimeout(() => void check(), 5e3).unref();
}

// server/buildInfo.ts
import fs from "fs";
import path from "path";
import { fileURLToPath as fileURLToPath3 } from "url";
var cached = null;
function getBuildInfo() {
  if (cached) return cached;
  try {
    const dir = path.dirname(fileURLToPath3(import.meta.url));
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "BUILD_INFO.json"), "utf8"));
    cached = {
      sha: String(raw.gitShaShort || raw.gitSha || "unknown"),
      sourceHash: raw.sourceHash ? String(raw.sourceHash).slice(0, 12) : null,
      builtAt: raw.builtAt ? String(raw.builtAt) : null
    };
  } catch {
    cached = { sha: "dev", sourceHash: null, builtAt: null };
  }
  return cached;
}

// server/index.ts
import path2 from "path";
import fs2 from "fs";
import { fileURLToPath as fileURLToPath4 } from "url";
loadEnvFile();
function log(message, source = "express") {
  const formattedTime = (/* @__PURE__ */ new Date()).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}
var app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.get("/health", (_req, res) => {
  const sftp = getSftpEnvStatus();
  const sp = getSharePointEnvStatus();
  const worker = getUploadWorkerStatus();
  const queue = getUploadQueueSnapshot();
  res.json({
    ok: true,
    service: "imageflow",
    build: getBuildInfo(),
    ssoEnabled: isSsoEnabled(),
    sftp: {
      configured: sftp.configured,
      hostSet: sftp.host,
      userSet: sftp.user,
      passwordSet: sftp.password,
      passwordSource: sftp.passwordSource,
      passwordLength: sftp.passwordLength,
      passwordDollarCount: sftp.passwordDollarCount,
      port: sftp.port,
      remoteDirs: sftp.remoteDirs,
      enableFlag: sftp.enableFlag
    },
    sharepoint: sp,
    uploadWorker: {
      started: worker.started,
      active: worker.active,
      concurrency: worker.concurrency,
      blocked: worker.blocked !== null,
      blockedSince: worker.blocked?.since ?? null
    },
    uploadQueue: queue ? {
      pending: queue.pending,
      oldestPendingSec: queue.oldestPendingSec,
      blocked: queue.blocked,
      checkinPending: queue.checkinPending,
      failedLast24h: queue.failedLast24h,
      checkedAt: queue.checkedAt
    } : null,
    alertsConfigured: Boolean(process.env.IMAGEFLOW_ALERT_WEBHOOK?.trim())
  });
});
registerAceSsoRoutes(app, "imageflow");
app.use((req, res, next) => {
  const start = Date.now();
  const pathName = req.path;
  let capturedJsonResponse = void 0;
  const originalResJson = res.json;
  res.json = function(bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (pathName.startsWith("/api")) {
      let logLine = `${req.method} ${pathName} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "\u2026";
      }
      log(logLine);
    }
  });
  next();
});
var ssoAuditIdentity = (req) => {
  const user = req.aceSsoUser;
  if (!user || user.id === "local-dev") return null;
  return {
    email: user.email,
    ssoUserId: user.sub || user.id,
    employeeId: user.employeeId ?? null,
    displayName: user.name
  };
};
app.use(
  createActivityAudit({
    appSlug: "imageflow",
    getIdentity: ssoAuditIdentity,
    skip: (req, apiPath) => req.imageflowAuditSkip === true || /\/retry$/i.test(apiPath) || /\/check-excel-updates$/i.test(apiPath)
  })
);
app.post(
  "/api/usage-events",
  requireAceSsoApp("imageflow"),
  createUsageRelay({ appSlug: "imageflow", getIdentity: ssoAuditIdentity })
);
(async () => {
  const server = await registerRoutes(app);
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    res.status(status).json({ message });
    throw err;
  });
  if (!isSsoEnabled()) {
    console.warn("[SSO] Disabled (set ENABLE_SSO=true to require ACE login)");
  }
  if (process.env.NODE_ENV === "development") {
    if (isSsoEnabled()) {
      app.use(requireAceSsoSpa("imageflow"));
    }
    const viteModule = "./vite";
    const { setupVite } = await import(viteModule);
    await setupVite(app, server);
  } else {
    const __dirname2 = path2.dirname(fileURLToPath4(import.meta.url));
    const distPath = path2.resolve(__dirname2, "public");
    if (!fs2.existsSync(distPath)) {
      throw new Error(
        `Could not find the build directory: ${distPath}, make sure to build the client first`
      );
    }
    app.use(
      express.static(distPath, {
        index: false,
        setHeaders(res, filePath) {
          res.setHeader("Access-Control-Allow-Origin", "*");
          if (filePath.includes(`${path2.sep}assets${path2.sep}`)) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          }
        }
      })
    );
    if (isSsoEnabled()) {
      app.use(requireAceSsoSpa("imageflow"));
    }
    app.use("*", (_req, res) => {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
      res.setHeader("Pragma", "no-cache");
      res.sendFile(path2.resolve(distPath, "index.html"));
    });
  }
  const port = parseInt(process.env.PORT || "5000", 10);
  server.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true
    },
    () => {
      log(`serving on port ${port}`);
      const sftp = getSftpEnvStatus();
      console.log(
        `[SFTP] configured=${sftp.configured} hostSet=${sftp.host} userSet=${sftp.user} passwordSet=${sftp.password} passwordSource=${sftp.passwordSource} passwordLen=${sftp.passwordLength} dollarCount=${sftp.passwordDollarCount} port=${sftp.port} dirs=${sftp.remoteDirs} ENABLE_EXCEL_SFTP_SYNC=${sftp.enableFlag ?? "(unset)"}`
      );
      initializeScheduler();
      startUploadWorker();
      startUploadMonitor();
    }
  );
})();
