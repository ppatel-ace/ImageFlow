import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import { checkForNewExcelFile } from "./gdrive";
import { uploadFileToSharePoint } from "./sharepoint";
import {
  getAllWorkOrders,
  getPartNumbersByWorkOrder,
  reloadExcelData,
  getCurrentFileName,
} from "./excelParser";
import { requireAceSsoApp } from "./aceSso";

const upload = multer({ storage: multer.memoryStorage() });
const requireImageflow = requireAceSsoApp("imageflow");

async function handleImageUpload(req: any, res: any) {
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
      req.file.buffer,
    );

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

  app.get("/api/work-orders", requireImageflow, (req, res) => {
    try {
      const workOrders = getAllWorkOrders();
      res.json(workOrders);
    } catch (error: any) {
      console.error("Error fetching work orders:", error);
      res.status(500).json({ error: "Failed to fetch work orders" });
    }
  });

  app.get("/api/part-numbers/:workOrder", requireImageflow, (req, res) => {
    try {
      const { workOrder } = req.params;
      const partNumbers = getPartNumbersByWorkOrder(workOrder);
      res.json(partNumbers);
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

  // Excel/work-order sync remains on Google Drive / local (known gap)
  app.post("/api/check-excel-updates", requireImageflow, async (req, res) => {
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
          error: reloadResult.error,
        });
      }

      res.json({
        success: true,
        message: "Excel data updated successfully from Google Drive",
        fileName: driveResult.fileName,
        fileDate: driveResult.fileDate,
        currentFile: reloadResult.fileName,
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
