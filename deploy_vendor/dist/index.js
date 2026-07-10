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
function sanitizeCustomerName(customerName) {
  return customerName.replace(/[<>:"/\\|?*]/g, "_");
}
function getMimeType(fileName) {
  const ext = fileName.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "heic":
      return "image/heic";
    default:
      return "image/jpeg";
  }
}
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
async function uploadViaResumable(connectors, folderId, fileName, fileBuffer) {
  const mimeType = getMimeType(fileName);
  const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
  const initiateResp = await connectors.proxy(
    "google-drive",
    `/upload/drive/v3/files?uploadType=resumable&fields=id,name`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(fileBuffer.length)
      },
      body: metadata
    }
  );
  if (!initiateResp.ok) {
    const text = await initiateResp.text().catch(() => `HTTP ${initiateResp.status}`);
    throw new Error(`Google Drive upload initiation failed (${initiateResp.status}): ${text}`);
  }
  const sessionUri = initiateResp.headers.get("Location");
  if (!sessionUri) {
    const body = await initiateResp.text().catch(() => "(unreadable body)");
    console.error(
      `[gdrive] Resumable upload initiation missing Location header. Status: ${initiateResp.status}. Response headers: ${JSON.stringify(Object.fromEntries(initiateResp.headers))}. Body: ${body}`
    );
    throw new Error("Google Drive resumable upload: no Location header in initiation response");
  }
  const uploadResp = await fetch(sessionUri, {
    method: "PUT",
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(fileBuffer.length)
    },
    body: fileBuffer
  });
  if (!uploadResp.ok) {
    const text = await uploadResp.text().catch(() => `HTTP ${uploadResp.status}`);
    throw new Error(`Google Drive file upload failed (${uploadResp.status}): ${text}`);
  }
}
async function findOrCreateFolder(connectors, folderName, parentId = "root") {
  const escapedName = folderName.replace(/'/g, "\\'");
  const q = `name='${escapedName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id,name)", spaces: "drive" });
  const listResp = await connectors.proxy("google-drive", `/drive/v3/files?${params}`);
  const listData = await parseJsonResponse(listResp, "folder list");
  if (listData.files.length > 0) {
    return listData.files[0].id;
  }
  const createResp = await connectors.proxy("google-drive", "/drive/v3/files?fields=id,name", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId]
    })
  });
  const createData = await parseJsonResponse(createResp, "folder create");
  return createData.id;
}
async function ensureFolderPath(connectors, pathParts) {
  let parentId = "root";
  for (const folderName of pathParts) {
    parentId = await findOrCreateFolder(connectors, folderName, parentId);
  }
  return parentId;
}
async function getUncachableGoogleDriveClient() {
  return new ReplitConnectors();
}
async function uploadFileToGoogleDrive(customerName, dept, workOrderNumber, fileName, fileBuffer) {
  const connectors = await getUncachableGoogleDriveClient();
  const sanitizedCustomerName = sanitizeCustomerName(customerName);
  const pathParts = ["ACE", sanitizedCustomerName, dept, workOrderNumber];
  const folderId = await ensureFolderPath(connectors, pathParts);
  await uploadViaResumable(connectors, folderId, fileName, fileBuffer);
  return {
    success: true,
    path: `${pathParts.join("/")}/${fileName}`
  };
}
async function checkForNewExcelFile() {
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
    console.error("Error checking Google Drive for Excel file:", errorMessage);
    return {
      success: false,
      message: errorMessage,
      error: errorMessage
    };
  }
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
    console.error("Error finding latest Excel file:", error);
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
    const fileName = latestFile || "OpenOrdersAllQtyOnly_1760375874902.xlsx";
    const excelPath = join2(__dirname, "..", "attached_assets", fileName);
    cachedData = await parseExcelFile(excelPath);
    currentFileName = fileName;
  } catch (error) {
    console.error("Error loading initial Excel file:", error);
  }
})();

// server/routes.ts
var upload = multer({ storage: multer.memoryStorage() });
async function registerRoutes(app2) {
  app2.post("/api/upload/gdrive", upload.single("imageFile"), async (req, res) => {
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
      const result = await uploadFileToGoogleDrive(
        customerName,
        dept,
        workOrderNumber,
        fileName,
        req.file.buffer
      );
      res.json(result);
    } catch (error) {
      console.error("Google Drive upload error:", error);
      const msg = error.message || "";
      const isAuthFailure = msg.includes("not connected") || msg.includes("Authentication required") || msg.includes("Token refresh failed") || msg.includes("Connection is error") || msg.includes("invalid_grant") || msg.includes("UNAUTHORIZED");
      if (isAuthFailure) {
        return res.status(401).json({
          error: "Google Drive not connected",
          message: "Google Drive authorization has expired or been revoked. Please reconnect Google Drive in Replit's Integrations panel and try again.",
          requiresAuth: true
        });
      }
      res.status(500).json({
        error: "Upload failed",
        message: msg || "Unknown upload error"
      });
    }
  });
  app2.get("/api/work-orders", (req, res) => {
    try {
      const workOrders = getAllWorkOrders();
      res.json(workOrders);
    } catch (error) {
      console.error("Error fetching work orders:", error);
      res.status(500).json({ error: "Failed to fetch work orders" });
    }
  });
  app2.get("/api/part-numbers/:workOrder", (req, res) => {
    try {
      const { workOrder } = req.params;
      const partNumbers = getPartNumbersByWorkOrder(workOrder);
      res.json(partNumbers);
    } catch (error) {
      console.error("Error fetching part numbers:", error);
      res.status(500).json({ error: "Failed to fetch part numbers" });
    }
  });
  app2.get("/api/excel-info", (req, res) => {
    try {
      const fileName = getCurrentFileName();
      res.json({ fileName });
    } catch (error) {
      console.error("Error getting Excel info:", error);
      res.status(500).json({ error: "Failed to get Excel info" });
    }
  });
  app2.post("/api/check-excel-updates", async (req, res) => {
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
        console.log(`[Scheduler] Initial check: ${driveResult.message}`);
      }
    } catch (error) {
      console.error("[Scheduler] Initial update check error:", error.message);
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
