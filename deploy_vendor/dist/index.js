// server/index.ts
import express from "express";

// server/routes.ts
import { createServer } from "http";
import multer from "multer";

// server/gdrive.ts
import { ReplitConnectors } from "@replit/connectors-sdk";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
async function parseJsonResponse(response, context) {
  if (!response.ok) {
    const text = await response.text().catch(() => `HTTP ${response.status}`);
    throw new Error(`Google Drive ${context} failed (${response.status}): ${text}`);
  }
  const data = await response.json();
  if (data.error) {
    const err = data.error;
    throw new Error(`Google Drive ${context} error ${err.code}: ${err.message}`);
  }
  return data;
}
async function getUncachableGoogleDriveClient() {
  return new ReplitConnectors();
}
var excelDriveUnavailableLogged = false;
function isExcelDriveSyncAvailable() {
  const flag = process.env.ENABLE_EXCEL_DRIVE_SYNC?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off" || flag === "no") {
    return false;
  }
  if (flag === "1" || flag === "true" || flag === "on" || flag === "yes") {
    return true;
  }
  return Boolean(process.env.REPL_IDENTITY || process.env.WEB_REPL_RENEWAL);
}
function isReplitIdentityError(message) {
  return message.includes("Replit identity token not found");
}
function warnExcelDriveUnavailableOnce(message) {
  if (excelDriveUnavailableLogged) return;
  excelDriveUnavailableLogged = true;
  console.warn(`[gdrive] ${message}`);
}
async function checkForNewExcelFile() {
  if (!isExcelDriveSyncAvailable()) {
    warnExcelDriveUnavailableOnce(
      "Excel Drive sync disabled \u2014 Replit connectors not configured (SharePoint handles image uploads). Mount an Excel file under attached_assets, or set REPL_IDENTITY/WEB_REPL_RENEWAL / ENABLE_EXCEL_DRIVE_SYNC=true to enable Drive sync."
    );
    return {
      success: false,
      message: "Excel Drive sync not configured (no Replit identity)"
    };
  }
  try {
    const connectors = await getUncachableGoogleDriveClient();
    const folderId = "1ixVvva0yj1FyytYBjj0DRuPNT4i76H76";
    const q = `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`;
    const params = new URLSearchParams({
      q,
      fields: "files(id,name,createdTime,modifiedTime)",
      orderBy: "modifiedTime desc",
      spaces: "drive"
    });
    const listResp = await connectors.proxy("google-drive", `/drive/v3/files?${params}`);
    const listData = await parseJsonResponse(listResp, "Excel file list");
    if (!listData.files || listData.files.length === 0) {
      return { success: false, message: "No Excel files found in KSAlert folder" };
    }
    const datePattern = /^\d{8}\.xlsx$/;
    const validFiles = listData.files.filter(
      (file) => file.name && datePattern.test(file.name)
    );
    if (validFiles.length === 0) {
      return {
        success: false,
        message: "No files matching YYYYMMDD.xlsx pattern found in KSAlert folder"
      };
    }
    validFiles.sort(
      (a, b) => b.name.replace(".xlsx", "").localeCompare(a.name.replace(".xlsx", ""))
    );
    const latestFile = validFiles[0];
    const originalFileName = latestFile.name;
    const downloadResp = await connectors.proxy(
      "google-drive",
      `/drive/v3/files/${encodeURIComponent(latestFile.id)}?alt=media`
    );
    if (!downloadResp.ok) {
      const errText = await downloadResp.text().catch(() => `HTTP ${downloadResp.status}`);
      throw new Error(`Failed to download Excel file (${downloadResp.status}): ${errText}`);
    }
    const buffer = Buffer.from(await downloadResp.arrayBuffer());
    const timestamp = Date.now();
    const newFileName = `OpenOrdersAllQtyOnly_${timestamp}.xlsx`;
    const __filename2 = fileURLToPath(import.meta.url);
    const __dirname2 = dirname(__filename2);
    const filePath = join(__dirname2, "..", "attached_assets", newFileName);
    writeFileSync(filePath, buffer);
    const fileDate = originalFileName.replace(".xlsx", "");
    const formattedDate = `${fileDate.slice(0, 4)}-${fileDate.slice(4, 6)}-${fileDate.slice(6, 8)}`;
    return {
      success: true,
      message: `Excel file ${originalFileName} successfully downloaded and saved`,
      fileName: newFileName,
      fileDate: formattedDate,
      originalFileName
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (isReplitIdentityError(errorMessage)) {
      warnExcelDriveUnavailableOnce(
        `Excel Drive sync unavailable: ${errorMessage} SharePoint image uploads are unaffected.`
      );
    } else {
      console.error("Error checking Google Drive for Excel file:", errorMessage);
    }
    return {
      success: false,
      message: errorMessage,
      error: errorMessage
    };
  }
}

// server/sharepoint.ts
var tokenCache = null;
var GRAPH_BASE = "https://graph.microsoft.us/v1.0";
var TOKEN_URL_BASE = "https://login.microsoftonline.us";
function sanitizePathSegment(value) {
  return value.replace(/[<>:"/\\|?*]/g, "_");
}
function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 6e4) {
    return tokenCache.accessToken;
  }
  const tenantId = requireEnv("AZURE_TENANT_ID");
  const clientId = requireEnv("AZURE_CLIENT_ID");
  const clientSecret = requireEnv("AZURE_CLIENT_SECRET");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.us/.default"
  });
  const res = await fetch(`${TOKEN_URL_BASE}/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Azure token request failed (${res.status}): ${text.slice(0, 300)}`);
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
  const hostname = process.env.SHAREPOINT_SITE_HOSTNAME?.trim() || "aceelectronics.sharepoint.us";
  const sitePath = process.env.SHAREPOINT_SITE_PATH?.trim() || "/sites/jobtravelerphotos";
  const normalizedPath = sitePath.startsWith("/") ? sitePath : `/${sitePath}`;
  const res = await graphFetch(
    `/sites/${encodeURIComponent(hostname)}:${normalizedPath}`
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to resolve SharePoint site (${res.status}): ${text.slice(0, 300)}`);
  }
  const site = await res.json();
  if (!site.id) throw new Error("SharePoint site response missing id");
  return site.id;
}
async function resolveDriveId(siteId) {
  const configured = process.env.SHAREPOINT_DRIVE_ID?.trim();
  if (configured) return configured;
  const res = await graphFetch(`/sites/${siteId}/drive`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to resolve default drive (${res.status}): ${text.slice(0, 300)}`);
  }
  const drive = await res.json();
  if (!drive.id) throw new Error("SharePoint drive response missing id");
  return drive.id;
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
      const text = await probe.text().catch(() => "");
      throw new Error(
        `Failed to check folder ${built.join("/")} (${probe.status}): ${text.slice(0, 200)}`
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
      const text = await createRes.text().catch(() => "");
      throw new Error(
        `Failed to create folder ${part} (${createRes.status}): ${text.slice(0, 200)}`
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
  const folderPath = `ACE/${sanitizedCustomer}/${sanitizedDept}/${sanitizedWo}`;
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
    const text = await uploadRes.text().catch(() => "");
    throw new Error(`SharePoint upload failed (${uploadRes.status}): ${text.slice(0, 300)}`);
  }
  const uploaded = await uploadRes.json().catch(() => ({}));
  return {
    success: true,
    path: `${folderPath}/${sanitizedFile}`,
    webUrl: uploaded.webUrl
  };
}

// server/excelParser.ts
import readXlsxFile from "read-excel-file/node";
import { readdirSync } from "fs";
import { fileURLToPath as fileURLToPath2 } from "url";
import { dirname as dirname2, join as join2 } from "path";
var __filename = fileURLToPath2(import.meta.url);
var __dirname = dirname2(__filename);
var cachedData = null;
var currentFileName = null;
async function parseExcelFile(filePath) {
  const rows = await readXlsxFile(filePath);
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
      (file) => file.startsWith("OpenOrdersAllQtyOnly_") && file.endsWith(".xlsx")
    );
    if (excelFiles.length === 0) {
      return null;
    }
    excelFiles.sort((a, b) => {
      const timestampA = parseInt(a.match(/\d+/)?.[0] || "0");
      const timestampB = parseInt(b.match(/\d+/)?.[0] || "0");
      return timestampB - timestampA;
    });
    return excelFiles[0];
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
        "[excelParser] No OpenOrders Excel file in attached_assets \u2014 work-order lookup empty until a file is mounted or Drive sync runs."
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
function requireAceSsoSpa(app2) {
  return (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path === "/health") return next();
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const payload = tryAceSsoFromRequest(req, res);
    if (payload && hasAppAccess(payload, app2)) return next();
    const loginUrl = buildSsoLoginUrl(req, req.originalUrl || "/");
    if (loginUrl) return res.redirect(loginUrl);
    return res.status(401).send("Unauthorized \u2014 SSO not configured");
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
    const payload = tryAceSsoFromRequest(req, res);
    if (payload && hasAppAccess(payload, appSlug)) {
      return res.json({
        authenticated: true,
        via: "sso",
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
        ssoLoginUrl: loginUrl
      });
    }
    res.json({ authenticated: false });
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

// server/routes.ts
var upload = multer({ storage: multer.memoryStorage() });
var requireImageflow = requireAceSsoApp("imageflow");
async function handleImageUpload(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const { customerName, dept, workOrderNumber, imageName } = req.body;
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
  app2.get("/api/work-orders", requireImageflow, (req, res) => {
    try {
      const workOrders = getAllWorkOrders();
      res.json(workOrders);
    } catch (error) {
      console.error("Error fetching work orders:", error);
      res.status(500).json({ error: "Failed to fetch work orders" });
    }
  });
  app2.get("/api/part-numbers/:workOrder", requireImageflow, (req, res) => {
    try {
      const { workOrder } = req.params;
      const partNumbers = getPartNumbersByWorkOrder(workOrder);
      res.json(partNumbers);
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
      const driveResult = await checkForNewExcelFile();
      if (!driveResult.success) {
        return res.json(driveResult);
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
        message: "Excel data updated successfully from Google Drive",
        fileName: driveResult.fileName,
        fileDate: driveResult.fileDate,
        currentFile: reloadResult.fileName
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
function initializeScheduler() {
  if (!isExcelDriveSyncAvailable()) {
    console.warn(
      "[Scheduler] Excel Drive sync scheduler disabled (no Replit connectors). SharePoint image uploads are unaffected."
    );
    return;
  }
  console.log("[Scheduler] Initializing Excel update scheduler...");
  const cronExpression = "20 7 * * *";
  cron.schedule(cronExpression, async () => {
    const timestamp = (/* @__PURE__ */ new Date()).toLocaleString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    console.log(`[Scheduler] Running scheduled Excel update check at ${timestamp} EST/EDT`);
    try {
      const driveResult = await checkForNewExcelFile();
      if (!driveResult.success) {
        console.log(`[Scheduler] No new Excel file found: ${driveResult.message}`);
        return;
      }
      console.log(`[Scheduler] New Excel file found: ${driveResult.originalFileName}`);
      const reloadResult = await reloadExcelData();
      if (!reloadResult.success) {
        console.error(`[Scheduler] Failed to reload Excel data: ${reloadResult.error}`);
        return;
      }
      console.log(`[Scheduler] \u2713 Excel data successfully updated from ${driveResult.originalFileName}`);
      console.log(`[Scheduler] \u2713 Current file: ${reloadResult.fileName}`);
    } catch (error) {
      console.error("[Scheduler] Error during scheduled Excel update:", error.message);
    }
  }, {
    timezone: "America/New_York"
  });
  console.log("[Scheduler] \u2713 Excel update scheduler initialized (runs daily at 7:20 AM EST/EDT)");
  setTimeout(async () => {
    console.log("[Scheduler] Running initial Excel update check on server startup...");
    try {
      const driveResult = await checkForNewExcelFile();
      if (driveResult.success) {
        const reloadResult = await reloadExcelData();
        if (reloadResult.success) {
          console.log(`[Scheduler] \u2713 Initial update successful: ${driveResult.originalFileName}`);
        }
      } else {
        const msg = driveResult.message || "";
        if (msg.includes("Replit identity") || msg.includes("not configured")) {
          console.warn(`[Scheduler] Initial Excel check skipped: ${msg}`);
        } else {
          console.log(`[Scheduler] Initial check: ${msg}`);
        }
      }
    } catch (error) {
      const msg = error?.message || String(error);
      if (String(msg).includes("Replit identity")) {
        console.warn(`[Scheduler] Initial Excel check skipped: ${msg}`);
      } else {
        console.error("[Scheduler] Initial update check error:", msg);
      }
    }
  }, 1e4);
}

// server/index.ts
import path from "path";
import fs from "fs";
import { fileURLToPath as fileURLToPath3 } from "url";
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
  res.json({ ok: true, service: "imageflow" });
});
registerAceSsoRoutes(app, "imageflow");
app.use((req, res, next) => {
  const start = Date.now();
  const path2 = req.path;
  let capturedJsonResponse = void 0;
  const originalResJson = res.json;
  res.json = function(bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path2.startsWith("/api")) {
      let logLine = `${req.method} ${path2} ${res.statusCode} in ${duration}ms`;
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
  app.use(requireAceSsoSpa("imageflow"));
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
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true
  }, () => {
    log(`serving on port ${port}`);
    initializeScheduler();
  });
})();
