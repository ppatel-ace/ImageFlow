import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import multer from "multer";
import { uploadFileToOneDrive } from "./onedrive";
import { uploadFileToSharePoint } from "./sharepoint";
import { getAllWorkOrders, getPartNumbersByWorkOrder, getRevByPartNumber, reloadExcelData, getCurrentFileName } from "./excelParser";
import { checkForNewExcelFile } from "./gmailService";

const upload = multer({ storage: multer.memoryStorage() });

export async function registerRoutes(app: Express): Promise<Server> {
  app.post("/api/upload/onedrive", upload.single("imageFile"), async (req, res) => {
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

      const result = await uploadFileToOneDrive(
        customerName,
        dept,
        workOrderNumber,
        fileName,
        req.file.buffer
      );

      res.json(result);
    } catch (error: any) {
      console.error("OneDrive upload error:", error);
      
      if (error.message.includes('not connected') || error.message.includes('Authentication required')) {
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

  app.post("/api/upload/sharepoint", upload.single("imageFile"), async (req, res) => {
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

      const result = await uploadFileToSharePoint(
        customerName,
        dept,
        workOrderNumber,
        fileName,
        req.file.buffer
      );

      res.json(result);
    } catch (error: any) {
      console.error("SharePoint upload error:", error);
      
      if (error.message.includes('not connected') || error.message.includes('Authentication required')) {
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

  // Gmail check endpoint
  app.post("/api/check-gmail", async (req, res) => {
    try {
      // Check for new Excel file from Gmail
      const emailResult = await checkForNewExcelFile();
      
      if (!emailResult.success) {
        return res.json(emailResult);
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
        message: "Excel data updated successfully from Gmail",
        fileName: emailResult.fileName,
        emailDate: emailResult.emailDate,
        currentFile: reloadResult.fileName
      });
    } catch (error: any) {
      console.error("Error checking Gmail:", error);
      res.status(500).json({ 
        success: false,
        message: "Failed to check Gmail",
        error: error.message 
      });
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

  const httpServer = createServer(app);

  return httpServer;
}
