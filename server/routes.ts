import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import multer from "multer";
import { uploadFileToGoogleDrive, checkForNewExcelFile } from "./gdrive";
import { getAllWorkOrders, getPartNumbersByWorkOrder, getRevByPartNumber, reloadExcelData, getCurrentFileName } from "./excelParser";

const upload = multer({ storage: multer.memoryStorage() });

export async function registerRoutes(app: Express): Promise<Server> {

  app.post("/api/upload/gdrive", upload.single("imageFile"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const { customerName, dept, workOrderNumber, imageName } = req.body;

      if (!customerName || !dept || !workOrderNumber || !imageName) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const extension = req.file.originalname.split('.').pop() || 'jpg';
      const fileName = `${imageName}.${extension}`;

      const result = await uploadFileToGoogleDrive(
        customerName,
        dept,
        workOrderNumber,
        fileName,
        req.file.buffer
      );

      res.json(result);
    } catch (error: any) {
      console.error("Google Drive upload error:", error);
      
      const msg: string = error.message || "";
      const isAuthFailure =
        msg.includes('not connected') ||
        msg.includes('Authentication required') ||
        msg.includes('Token refresh failed') ||
        msg.includes('Connection is error') ||
        msg.includes('invalid_grant') ||
        msg.includes('UNAUTHORIZED');

      if (isAuthFailure) {
        return res.status(401).json({
          error: "Google Drive not connected",
          message: "Google Drive authorization has expired or been revoked. Please reconnect Google Drive in Replit's Integrations panel and try again.",
          requiresAuth: true,
        });
      }

      res.status(500).json({
        error: "Upload failed",
        message: msg || "Unknown upload error",
      });
    }
  });

  // Excel data endpoints
  app.get("/api/work-orders", (req, res) => {
    try {
      const workOrders = getAllWorkOrders();
      res.json(workOrders);
    } catch (error: any) {
      console.error("Error fetching work orders:", error);
      res.status(500).json({ error: "Failed to fetch work orders" });
    }
  });

  app.get("/api/part-numbers/:workOrder", (req, res) => {
    try {
      const { workOrder } = req.params;
      const partNumbers = getPartNumbersByWorkOrder(workOrder);
      res.json(partNumbers);
    } catch (error: any) {
      console.error("Error fetching part numbers:", error);
      res.status(500).json({ error: "Failed to fetch part numbers" });
    }
  });

  // Get current Excel file info
  app.get("/api/excel-info", (req, res) => {
    try {
      const fileName = getCurrentFileName();
      res.json({ fileName });
    } catch (error: any) {
      console.error("Error getting Excel info:", error);
      res.status(500).json({ error: "Failed to get Excel info" });
    }
  });

  // Check for Excel updates in Google Drive KSAlert folder
  app.post("/api/check-excel-updates", async (req, res) => {
    try {
      const driveResult = await checkForNewExcelFile();
      
      if (!driveResult.success) {
        return res.json(driveResult);
      }

      // Reload Excel data with the new file
      const reloadResult = reloadExcelData();
      
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
    } catch (error: any) {
      console.error("Error checking for Excel updates:", error);
      res.status(500).json({ 
        success: false,
        error: "Failed to check for Excel updates",
        message: error.message || String(error)
      });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
