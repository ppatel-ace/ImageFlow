// server/index.ts
import express from "express";

// server/routes.ts
import { createServer } from "http";
import multer from "multer";

// server/onedrive.ts
import { Client } from "@microsoft/microsoft-graph-client";
var connectionSettings;
async function getAccessToken() {
  if (connectionSettings && connectionSettings.settings.expires_at && new Date(connectionSettings.settings.expires_at).getTime() > Date.now()) {
    return connectionSettings.settings.access_token;
  }
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY ? "repl " + process.env.REPL_IDENTITY : process.env.WEB_REPL_RENEWAL ? "depl " + process.env.WEB_REPL_RENEWAL : null;
  if (!xReplitToken) {
    throw new Error("Authentication required. Please connect to OneDrive.");
  }
  connectionSettings = await fetch(
    "https://" + hostname + "/api/v2/connection?include_secrets=true&connector_names=onedrive",
    {
      headers: {
        "Accept": "application/json",
        "X_REPLIT_TOKEN": xReplitToken
      }
    }
  ).then((res) => res.json()).then((data) => data.items?.[0]);
  const accessToken = connectionSettings?.settings?.access_token ?? connectionSettings?.settings?.oauth?.credentials?.access_token;
  if (!connectionSettings || !accessToken) {
    throw new Error("OneDrive not connected. Please connect your OneDrive account.");
  }
  return accessToken;
}
async function getOneDriveClient() {
  const accessToken = await getAccessToken();
  return Client.init({
    authProvider: (done) => {
      done(null, accessToken);
    }
  });
}
async function uploadFileToOneDrive(customerName, dept, workOrderNumber, fileName, fileBuffer) {
  const client = await getOneDriveClient();
  const folderPath = `ACE/${customerName}/${dept}/${workOrderNumber}`;
  const filePath = `/me/drive/root:/${folderPath}/${fileName}:/content`;
  await client.api(filePath).put(fileBuffer);
  return {
    success: true,
    path: `${folderPath}/${fileName}`
  };
}

// server/sharepoint.ts
import { Client as Client2 } from "@microsoft/microsoft-graph-client";
var connectionSettings2;
async function getAccessToken2() {
  if (connectionSettings2 && connectionSettings2.settings.expires_at && new Date(connectionSettings2.settings.expires_at).getTime() > Date.now()) {
    return connectionSettings2.settings.access_token;
  }
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY ? "repl " + process.env.REPL_IDENTITY : process.env.WEB_REPL_RENEWAL ? "depl " + process.env.WEB_REPL_RENEWAL : null;
  if (!xReplitToken) {
    throw new Error("Authentication required. Please connect to SharePoint.");
  }
  connectionSettings2 = await fetch(
    "https://" + hostname + "/api/v2/connection?include_secrets=true&connector_names=sharepoint",
    {
      headers: {
        "Accept": "application/json",
        "X_REPLIT_TOKEN": xReplitToken
      }
    }
  ).then((res) => res.json()).then((data) => data.items?.[0]);
  const accessToken = connectionSettings2?.settings?.access_token ?? connectionSettings2?.settings?.oauth?.credentials?.access_token;
  if (!connectionSettings2 || !accessToken) {
    throw new Error("SharePoint not connected. Please connect your SharePoint account.");
  }
  return accessToken;
}
async function getSharePointClient() {
  const accessToken = await getAccessToken2();
  return Client2.init({
    authProvider: (done) => {
      done(null, accessToken);
    },
    // Use Government Community Cloud (GCC) endpoint
    baseUrl: "https://graph.microsoft.us/v1.0"
  });
}
async function ensureFolder(client, siteId, folderPath) {
  try {
    await client.api(`/sites/${siteId}/drive/root:/${folderPath}`).get();
  } catch (error) {
    if (error.statusCode === 404) {
      const pathParts = folderPath.split("/");
      let currentPath = "";
      for (const part of pathParts) {
        const parentPath = currentPath || "/";
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        try {
          await client.api(`/sites/${siteId}/drive/root:/${currentPath}`).get();
        } catch (err) {
          if (err.statusCode === 404) {
            const createPath = parentPath === "/" ? `/sites/${siteId}/drive/root/children` : `/sites/${siteId}/drive/root:/${parentPath}:/children`;
            await client.api(createPath).post({
              name: part,
              folder: {},
              "@microsoft.graph.conflictBehavior": "rename"
            });
          } else {
            throw err;
          }
        }
      }
    } else {
      throw error;
    }
  }
}
async function uploadFileToSharePoint(customerName, dept, workOrderNumber, fileName, fileBuffer) {
  const client = await getSharePointClient();
  const folderPath = `ACE/${customerName}/${dept}/${workOrderNumber}`;
  const site = await client.api("/sites/root").get();
  const siteId = site.id;
  await ensureFolder(client, siteId, folderPath);
  const filePath = `/sites/${siteId}/drive/root:/${folderPath}/${fileName}:/content`;
  await client.api(filePath).put(fileBuffer);
  return {
    success: true,
    path: `${folderPath}/${fileName}`
  };
}

// server/excelParser.ts
import * as XLSX from "xlsx";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
var __filename = fileURLToPath(import.meta.url);
var __dirname = dirname(__filename);
var cachedData = null;
function parseExcelFile(filePath) {
  const fileBuffer = readFileSync(filePath);
  const workbook = XLSX.read(fileBuffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
  const workOrderData = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length === 0) continue;
    const workOrder = row[3]?.toString().trim();
    const customerName = row[7]?.toString().trim();
    const rev = row[19]?.toString().trim() || "";
    const partNumber = row[10]?.toString().trim();
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
function getWorkOrderData() {
  if (cachedData) {
    return cachedData;
  }
  try {
    const excelPath = join(__dirname, "..", "attached_assets", "OpenOrdersEst Parth_1760046981567.xlsx");
    cachedData = parseExcelFile(excelPath);
    return cachedData;
  } catch (error) {
    console.error("Error loading Excel file:", error);
    return [];
  }
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

// server/routes.ts
var upload = multer({ storage: multer.memoryStorage() });
async function registerRoutes(app2) {
  app2.post("/api/upload/onedrive", upload.single("imageFile"), async (req, res) => {
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
      const result = await uploadFileToOneDrive(
        customerName,
        dept,
        workOrderNumber,
        fileName,
        req.file.buffer
      );
      res.json(result);
    } catch (error) {
      console.error("OneDrive upload error:", error);
      if (error.message.includes("not connected") || error.message.includes("Authentication required")) {
        return res.status(401).json({
          error: "OneDrive not connected",
          message: error.message,
          requiresAuth: true
        });
      }
      res.status(500).json({
        error: "Upload failed",
        message: error.message
      });
    }
  });
  app2.post("/api/upload/sharepoint", upload.single("imageFile"), async (req, res) => {
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
      if (error.message.includes("not connected") || error.message.includes("Authentication required")) {
        return res.status(401).json({
          error: "SharePoint not connected",
          message: error.message,
          requiresAuth: true
        });
      }
      res.status(500).json({
        error: "Upload failed",
        message: error.message
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
  const httpServer = createServer(app2);
  return httpServer;
}

// server/index.ts
import path from "path";
import fs from "fs";
import { fileURLToPath as fileURLToPath2 } from "url";
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
    const __dirname2 = path.dirname(fileURLToPath2(import.meta.url));
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
  });
})();
