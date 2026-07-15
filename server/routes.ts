import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import { checkForNewExcelFile, isExcelSyncAvailable } from "./excelSync";
import { uploadFileToSharePoint } from "./sharepoint";
import {
  getAllWorkOrders,
  getPartNumbersByWorkOrder,
  reloadExcelData,
  getCurrentFileName,
} from "./excelParser";
import { requireAceSsoApp, type AceAuthRequest } from "./aceSso";
import { isDatabaseConfigured } from "./db";
import { listUploadHistory, recordUploadHistory } from "./uploadHistory";

const upload = multer({ storage: multer.memoryStorage() });
const requireImageflow = requireAceSsoApp("imageflow");

/** If WO cache is empty but SFTP is configured, pull Excel once before answering. */
async function ensureWorkOrderDataLoaded(): Promise<void> {
  if (getAllWorkOrders().length > 0 || !isExcelSyncAvailable()) return;
  const syncResult = await checkForNewExcelFile();
  if (syncResult.success) {
    await reloadExcelData();
  }
}

function folderOnlyPath(fullPath: string): string {
  const parts = fullPath.split("/").filter(Boolean);
  if (parts.length <= 1) return fullPath;
  return parts.slice(0, -1).join("/");
}

async function handleImageUpload(req: AceAuthRequest, res: any) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { customerName, dept, workOrderNumber, imageName, partNumber, rev } =
      req.body;

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
      req.file.buffer,
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
        userName: user?.name || user?.email || "Unknown User",
      });
    } catch (histErr: any) {
      console.warn("[uploadHistory] failed to record:", histErr?.message || histErr);
    }

    res.json(result);
  } catch (error: any) {
    console.error("SharePoint upload error:", error);

    const msg: string = error.message || "";
    const isAuthFailure =
      msg.includes("Missing required env var") ||
      msg.includes("Azure token") ||
      msg.includes("UNAUTHORIZED") ||
      msg.includes("401") ||
      msg.includes("403");

    if (isAuthFailure) {
      return res.status(401).json({
        error: "SharePoint not configured",
        message:
          msg ||
          "SharePoint / Azure Graph credentials are missing or invalid. Check AZURE_* and SHAREPOINT_* env vars.",
        requiresAuth: true,
      });
    }

    res.status(500).json({
      error: "Upload failed",
      message: msg || "Unknown upload error",
    });
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  app.post(
    "/api/upload/sharepoint",
    requireImageflow,
    upload.single("imageFile"),
    handleImageUpload,
  );
  // Alias — legacy client path kept for compatibility
  app.post(
    "/api/upload/gdrive",
    requireImageflow,
    upload.single("imageFile"),
    handleImageUpload,
  );

  app.get("/api/upload-history", requireImageflow, async (req: AceAuthRequest, res) => {
    try {
      const scope = String(req.query.scope || "mine").toLowerCase();
      const user = req.aceSsoUser;
      const userId = user?.id || user?.sub;

      if (scope === "all") {
        const rows = await listUploadHistory({});
        return res.json({
          scope: "all",
          databaseConfigured: isDatabaseConfigured(),
          items: rows,
        });
      }

      if (!userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const rows = await listUploadHistory({ userId });
      res.json({
        scope: "mine",
        databaseConfigured: isDatabaseConfigured(),
        items: rows,
      });
    } catch (error: any) {
      console.error("Error fetching upload history:", error);
      res.status(500).json({
        error: "Failed to fetch upload history",
        message: error.message || String(error),
        databaseConfigured: isDatabaseConfigured(),
      });
    }
  });

  app.get("/api/work-orders", requireImageflow, async (_req, res) => {
    try {
      await ensureWorkOrderDataLoaded();
      res.json(getAllWorkOrders());
    } catch (error: any) {
      console.error("Error fetching work orders:", error);
      res.status(500).json({ error: "Failed to fetch work orders" });
    }
  });

  app.get("/api/part-numbers/:workOrder", requireImageflow, async (req, res) => {
    try {
      await ensureWorkOrderDataLoaded();
      const { workOrder } = req.params;
      res.json(getPartNumbersByWorkOrder(workOrder));
    } catch (error: any) {
      console.error("Error fetching part numbers:", error);
      res.status(500).json({ error: "Failed to fetch part numbers" });
    }
  });

  app.get("/api/excel-info", requireImageflow, (req, res) => {
    try {
      const fileName = getCurrentFileName();
      res.json({ fileName });
    } catch (error: any) {
      console.error("Error getting Excel info:", error);
      res.status(500).json({ error: "Failed to get Excel info" });
    }
  });

  // Excel / work-order sync via SFTP (Sage Open Orders dump)
  app.post("/api/check-excel-updates", requireImageflow, async (req, res) => {
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
          error: reloadResult.error,
        });
      }

      res.json({
        success: true,
        message: "Excel data updated successfully from SFTP",
        fileName: syncResult.fileName,
        fileDate: syncResult.fileDate,
        originalFileName: syncResult.originalFileName,
        currentFile: reloadResult.fileName,
        source: "SFTP",
      });
    } catch (error: any) {
      console.error("Error checking for Excel updates:", error);
      res.status(500).json({
        success: false,
        error: "Failed to check for Excel updates",
        message: error.message || String(error),
      });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
