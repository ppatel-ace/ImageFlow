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
import {
  getUploadJobStatuses,
  getUploadStats,
  retryUploadJob,
  stageUploadJob,
} from "./uploadJobs";
import { getUploadWorkerStatus, kickUploadWorker } from "./uploadWorker";

const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STATUS_IDS = 100;

function userIdOf(req: AceAuthRequest): string | null {
  const user = req.aceSsoUser;
  return user?.id || user?.sub || null;
}

/** Upload stats admins: SSO group containing "admin" or email in IMAGEFLOW_ADMIN_EMAILS. */
function isImageflowAdmin(req: AceAuthRequest): boolean {
  const user = req.aceSsoUser;
  if (!user) return false;
  if (user.id === "local-dev") return true;
  const allow = (process.env.IMAGEFLOW_ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (user.email && allow.includes(user.email.toLowerCase())) return true;
  return (user.groups || []).some((g) => /admin/i.test(g));
}

function parseClientInfo(req: AceAuthRequest): Record<string, unknown> | null {
  const info: Record<string, unknown> = {};
  const device = req.get("x-imageflow-device");
  if (device) info.device = device.slice(0, 40);
  const raw = req.get("x-imageflow-client-ms");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "number" && Number.isFinite(v)) info[k] = Math.round(v);
        }
      }
    } catch {
      /* ignore malformed telemetry */
    }
  }
  return Object.keys(info).length ? info : null;
}

function markRequestStart(req: any, _res: any, next: any) {
  req.imageflowStartedAt = Date.now();
  next();
}

async function handleStageJob(req: AceAuthRequest & { imageflowStartedAt?: number }, res: any) {
  if (!isDatabaseConfigured()) {
    return res.status(503).json({
      error: "Staging queue unavailable",
      message: "DATABASE_URL is not configured; use the direct upload route.",
      fallback: "sync",
    });
  }
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  if (!/^image\//i.test(req.file.mimetype || "")) {
    return res.status(400).json({ error: "Only image files can be uploaded" });
  }

  const { jobId, customerName, dept, workOrderNumber, imageName, partNumber, rev } = req.body;
  if (!jobId || !JOB_ID_RE.test(String(jobId))) {
    return res.status(400).json({ error: "Missing or invalid jobId" });
  }
  if (!customerName || !dept || !workOrderNumber || !imageName) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const userId = userIdOf(req);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  const user = req.aceSsoUser!;

  const extension = (req.file.originalname.split(".").pop() || "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
  const fileName = `${String(imageName)}.${extension}`;

  try {
    const staged = await stageUploadJob({
      id: String(jobId).toLowerCase(),
      bytes: req.file.buffer,
      contentType: req.file.mimetype,
      fileName,
      dept: String(dept),
      customerName: String(customerName),
      workOrderNumber: String(workOrderNumber),
      partNumber: String(partNumber ?? ""),
      rev: String(rev ?? ""),
      userId,
      userEmail: user.email || "unknown",
      userName: user.name || user.email || "Unknown User",
      clientInfo: parseClientInfo(req),
      receivedMs: Date.now() - (req.imageflowStartedAt ?? Date.now()),
    });
    if (staged.ownerId !== userId) {
      return res.status(409).json({ error: "Job id already used" });
    }
    if (staged.created) {
      console.log(
        `[upload] staged ${JSON.stringify({ id: staged.row.id, bytes: req.file.size, receivedMs: Date.now() - (req.imageflowStartedAt ?? Date.now()) })}`,
      );
      kickUploadWorker();
      res.locals.auditRecord = { type: "upload", id: staged.row.id, label: fileName };
    } else {
      (req as AceAuthRequest & { imageflowAuditSkip?: boolean }).imageflowAuditSkip = true;
    }
    res.status(202).json(staged.row);
  } catch (error: any) {
    console.error("[upload] stage failed:", error);
    res.status(500).json({ error: "Could not stage upload", message: error?.message || String(error) });
  }
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});
const requireImageflow = requireAceSsoApp("imageflow");

function acceptImageFile(req: AceAuthRequest, res: any, next: any) {
  upload.single("imageFile")(req, res, (err: any) => {
    if (err?.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: "File too large",
        message: "Image must be 25 MB or smaller.",
      });
    }
    if (err) return next(err);
    next();
  });
}

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

    res.locals.auditRecord = { type: "upload", label: fileName };
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
    acceptImageFile,
    handleImageUpload,
  );
  // Alias — legacy client path kept for compatibility
  app.post(
    "/api/upload/gdrive",
    requireImageflow,
    acceptImageFile,
    handleImageUpload,
  );

  app.post(
    "/api/upload/jobs",
    markRequestStart,
    requireImageflow,
    acceptImageFile,
    handleStageJob,
  );

  app.get("/api/upload/jobs", requireImageflow, async (req: AceAuthRequest, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    if (!isDatabaseConfigured()) return res.json({ items: [], databaseConfigured: false });
    const ids = String(req.query.ids || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => JOB_ID_RE.test(s))
      .slice(0, MAX_STATUS_IDS);
    try {
      const items = await getUploadJobStatuses(userId, ids);
      res.json({ items, databaseConfigured: true });
    } catch (error: any) {
      console.error("[upload] status lookup failed:", error);
      res.status(500).json({ error: "Status lookup failed", message: error?.message || String(error) });
    }
  });

  app.post("/api/upload/jobs/:id/retry", requireImageflow, async (req: AceAuthRequest, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const id = String(req.params.id || "").toLowerCase();
    if (!JOB_ID_RE.test(id)) return res.status(400).json({ error: "Invalid job id" });
    if (!isDatabaseConfigured()) return res.status(503).json({ error: "Staging queue unavailable" });
    try {
      const row = await retryUploadJob(userId, id);
      if (!row) return res.status(404).json({ error: "Job not found or not retryable" });
      kickUploadWorker();
      res.json(row);
    } catch (error: any) {
      console.error("[upload] retry failed:", error);
      res.status(500).json({ error: "Retry failed", message: error?.message || String(error) });
    }
  });

  app.get("/api/upload/stats", requireImageflow, async (req: AceAuthRequest, res) => {
    if (!isImageflowAdmin(req)) return res.status(403).json({ error: "Admin only" });
    if (!isDatabaseConfigured()) return res.status(503).json({ error: "DATABASE_URL not set" });
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    try {
      const stats = await getUploadStats(days);
      res.json({ ...stats, worker: getUploadWorkerStatus() });
    } catch (error: any) {
      console.error("[upload] stats failed:", error);
      res.status(500).json({ error: "Stats failed", message: error?.message || String(error) });
    }
  });

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
