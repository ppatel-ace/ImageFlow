import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import multer from "multer";
import { uploadFileToOneDrive } from "./onedrive";
import { uploadFileToSharePoint } from "./sharepoint";

const upload = multer({ storage: multer.memoryStorage() });

export async function registerRoutes(app: Express): Promise<Server> {
  app.post("/api/upload/onedrive", upload.single("imageFile"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const { customerName, workOrderNumber, imageName } = req.body;

      if (!customerName || !workOrderNumber || !imageName) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const extension = req.file.originalname.split('.').pop() || 'jpg';
      const fileName = `${imageName}.${extension}`;

      const result = await uploadFileToOneDrive(
        customerName,
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

      const { customerName, workOrderNumber, imageName } = req.body;

      if (!customerName || !workOrderNumber || !imageName) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const extension = req.file.originalname.split('.').pop() || 'jpg';
      const fileName = `${imageName}.${extension}`;

      const result = await uploadFileToSharePoint(
        customerName,
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

  const httpServer = createServer(app);

  return httpServer;
}
