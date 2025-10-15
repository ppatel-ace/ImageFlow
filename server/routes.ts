import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import multer from "multer";
import { uploadFileToOneDrive } from "./onedrive";
import { uploadFileToGoogleDrive } from "./gdrive";
import { getAllWorkOrders, getPartNumbersByWorkOrder, getRevByPartNumber, reloadExcelData, getCurrentFileName } from "./excelParser";
import { checkForNewExcelFile } from "./gmailService";
import { getAuthUrl, getTokensFromCode, hasValidTokens, revokeTokens } from "./oauth";

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
      
      if (error.message.includes('not connected') || error.message.includes('Authentication required')) {
        return res.status(401).json({ 
          error: "Google Drive not connected",
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

  // OAuth routes for Gmail authentication
  app.get("/oauth/gmail/auth", (req, res) => {
    try {
      const authUrl = getAuthUrl();
      res.json({ authUrl });
    } catch (error: any) {
      console.error("Error generating auth URL:", error);
      res.status(500).json({ error: "Failed to generate auth URL" });
    }
  });

  app.get("/oauth/callback", async (req, res) => {
    try {
      const { code } = req.query;
      
      if (!code || typeof code !== 'string') {
        return res.status(400).send('Missing authorization code');
      }

      await getTokensFromCode(code);
      
      // Redirect to home page with success message
      res.send(`
        <html>
          <head>
            <title>Gmail Connected</title>
            <script>
              window.opener.postMessage({ type: 'GMAIL_AUTH_SUCCESS' }, '*');
              window.close();
            </script>
          </head>
          <body>
            <h1>Gmail Connected Successfully!</h1>
            <p>You can close this window and return to the app.</p>
          </body>
        </html>
      `);
    } catch (error: any) {
      console.error("OAuth callback error:", error);
      res.status(500).send(`
        <html>
          <head>
            <title>Gmail Connection Failed</title>
            <script>
              window.opener.postMessage({ type: 'GMAIL_AUTH_ERROR', error: '${error.message}' }, '*');
              window.close();
            </script>
          </head>
          <body>
            <h1>Failed to Connect Gmail</h1>
            <p>${error.message}</p>
          </body>
        </html>
      `);
    }
  });

  app.get("/oauth/gmail/status", (req, res) => {
    try {
      const connected = hasValidTokens();
      res.json({ connected });
    } catch (error: any) {
      console.error("Error checking Gmail status:", error);
      res.json({ connected: false });
    }
  });

  app.post("/oauth/gmail/disconnect", async (req, res) => {
    try {
      await revokeTokens();
      res.json({ success: true, message: "Gmail disconnected successfully" });
    } catch (error: any) {
      console.error("Error disconnecting Gmail:", error);
      res.status(500).json({ error: "Failed to disconnect Gmail" });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
