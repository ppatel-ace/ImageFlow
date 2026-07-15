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
  return value.replace(/[<>:"/\\|?*]/g, "_");
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
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
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
async function graphFetch(path2, init = {}) {
  const token = await getAccessToken();
  const url = path2.startsWith("http") ? path2 : `${GRAPH_BASE}${path2}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && init.body && !(init.body instanceof Buffer)) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(url, { ...init, headers });
}
async function resolveSiteId() {
  if (cachedSiteId) return cachedSiteId;
  const configured = process.env.SHAREPOINT_SITE_ID?.trim();
  if (configured) {
    const res2 = await graphFetch(`/sites/${configured}`);
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
  const res = await graphFetch(
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
  const res = await graphFetch(`/sites/${siteId}/drive`);
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
  const parts = folderPath.split("/").filter(Boolean);
  const built = [];
  for (const part of parts) {
    const parentSegments = [...built];
    built.push(part);
    const probe = await graphFetch(`/drives/${driveId}/root:/${driveItemPath(built)}`);
    if (probe.ok) continue;
    if (probe.status !== 404) {
      const text2 = await probe.text().catch(() => "");
      throw new Error(
        `Failed to check folder ${built.join("/")} (${probe.status}): ${text2.slice(0, 200)}` + sitesPermissionHint(probe.status, text2)
      );
    }
    const createUrl = parentSegments.length === 0 ? `/drives/${driveId}/root/children` : `/drives/${driveId}/root:/${driveItemPath(parentSegments)}:/children`;
    const createRes = await graphFetch(createUrl, {
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
}
async function uploadFileToSharePoint(customerName, dept, workOrderNumber, fileName, fileBuffer) {
  const siteId = await resolveSiteId();
  const driveId = await resolveDriveId(siteId);
  const sanitizedCustomer = sanitizePathSegment(customerName);
  const sanitizedDept = sanitizePathSegment(dept);
  const sanitizedWo = sanitizePathSegment(workOrderNumber);
  const sanitizedFile = sanitizePathSegment(fileName);
  const folderPath = `${sanitizedDept}/${sanitizedCustomer}/${sanitizedWo}`;
  await ensureFolderPath(driveId, folderPath);
  const uploadPath = `/drives/${driveId}/root:/${driveItemPath([
    ...folderPath.split("/").filter(Boolean),
    sanitizedFile
  ])}:/content`;
  const uploadRes = await graphFetch(uploadPath, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: fileBuffer
  });
  if (!uploadRes.ok) {
    const text2 = await uploadRes.text().catch(() => "");
    throw new Error(
      `SharePoint upload failed (${uploadRes.status}): ${text2.slice(0, 300)}` + sitesPermissionHint(uploadRes.status, text2)
    );
  }
  const uploaded = await uploadRes.json().catch(() => ({}));
  if (uploaded.id) {
    const checkinRes = await graphFetch(`/drives/${driveId}/items/${uploaded.id}/checkin`, {
      method: "POST",
      body: JSON.stringify({ comment: "ImageFlow upload" })
    });
    if (!checkinRes.ok) {
      const text2 = await checkinRes.text().catch(() => "");
      console.warn(
        `SharePoint check-in failed for ${sanitizedFile} (${checkinRes.status}): ${text2.slice(0, 200)}`
      );
    }
  }
  return {
    success: true,
    path: `${folderPath}/${sanitizedFile}`,
    webUrl: uploaded.webUrl
  };
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
function setAceSsoCookie(res, token) {
  res.cookie(SSO_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    ...cookieDomainOptions()
  });
}
function clearAceSsoCookie(res) {
  res.cookie(SSO_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
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
function requireAceSsoSpa(_app) {
  return (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path === "/health") return next();
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    tryAceSsoFromRequest(req, res);
    return next();
  };
}
function registerAceSsoRoutes(app2, appSlug = "imageflow") {
  app2.get("/api/auth/sso/callback", (req, res) => {
    const rawToken = req.query.ace_token;
    const nextPath = req.query.next || "/";
    const safeNext = nextPath.startsWith("/") ? nextPath : "/";
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
  insertUserSchema: () => insertUserSchema,
  uploadHistory: () => uploadHistory,
  users: () => users
});
import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp } from "drizzle-orm/pg-core";
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
var uploadHistory = pgTable("upload_history", {
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

// server/db.ts
var { Pool } = pg;
var pool = null;
var db = null;
var ensured = false;
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
      max: 5
    });
    db = drizzle(pool, { schema: schema_exports });
  }
  return db;
}
function getPool() {
  getDb();
  return pool;
}
async function ensureUploadHistoryTable() {
  if (!isDatabaseConfigured() || ensured) return;
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS upload_history (
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
      );
      CREATE INDEX IF NOT EXISTS upload_history_uploaded_at_idx ON upload_history (uploaded_at DESC);
      CREATE INDEX IF NOT EXISTS upload_history_user_id_idx ON upload_history (user_id);
    `);
    ensured = true;
  } finally {
    client.release();
  }
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

// server/routes.ts
var upload = multer({ storage: multer.memoryStorage() });
var requireImageflow = requireAceSsoApp("imageflow");
async function ensureWorkOrderDataLoaded() {
  if (getAllWorkOrders().length > 0 || !isExcelSyncAvailable()) return;
  const syncResult = await checkForNewExcelFile();
  if (syncResult.success) {
    await reloadExcelData();
  }
}
function folderOnlyPath(fullPath) {
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
        folderPath: folderOnlyPath(result.path),
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
    upload.single("imageFile"),
    handleImageUpload
  );
  app2.post(
    "/api/upload/gdrive",
    requireImageflow,
    upload.single("imageFile"),
    handleImageUpload
  );
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
import cron from "node-cron";
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
  cron.schedule(cronExpression, async () => {
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

// server/index.ts
import path from "path";
import fs from "fs";
import { fileURLToPath as fileURLToPath3 } from "url";
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
  res.json({
    ok: true,
    service: "imageflow",
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
    sharepoint: sp
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
(async () => {
  const server = await registerRoutes(app);
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    res.status(status).json({ message });
    throw err;
  });
  if (isSsoEnabled()) {
    app.use(requireAceSsoSpa("imageflow"));
  } else {
    console.warn("[SSO] Disabled (set ENABLE_SSO=true to require ACE login)");
  }
  if (process.env.NODE_ENV === "development") {
    const viteModule = "./vite";
    const { setupVite } = await import(viteModule);
    await setupVite(app, server);
  } else {
    const __dirname2 = path.dirname(fileURLToPath3(import.meta.url));
    const distPath = path.resolve(__dirname2, "public");
    if (!fs.existsSync(distPath)) {
      throw new Error(
        `Could not find the build directory: ${distPath}, make sure to build the client first`
      );
    }
    app.use(express.static(distPath));
    app.use("*", (_req, res) => {
      res.sendFile(path.resolve(distPath, "index.html"));
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
    }
  );
})();
