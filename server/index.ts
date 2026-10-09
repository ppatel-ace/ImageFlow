import { loadEnvFile, isSsoEnabled } from "./env";
loadEnvFile();

import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { initializeScheduler } from "./scheduler";
import { registerAceSsoRoutes, requireAceSsoApp, requireAceSsoSpa, type AceAuthRequest } from "./aceSso";
import { createActivityAudit, createUsageRelay } from "./activityAudit";
import { getSftpEnvStatus } from "./sftpImport";
import { getSharePointEnvStatus } from "./sharepoint";
import { getUploadWorkerStatus, startUploadWorker } from "./uploadWorker";
import { getUploadQueueSnapshot, startUploadMonitor } from "./uploadMonitor";
import { getBuildInfo } from "./buildInfo";
import { startDriveMigrationWorker } from "./driveMigration";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get("/health", (_req, res) => {
  const sftp = getSftpEnvStatus();
  const sp = getSharePointEnvStatus();
  const worker = getUploadWorkerStatus();
  const queue = getUploadQueueSnapshot();
  res.json({
    ok: true,
    service: "imageflow",
    build: getBuildInfo(),
    ssoEnabled: isSsoEnabled(),
    sftp: {
      configured: sftp.configured,
      hostSet: sftp.host,
      userSet: sftp.user,
      passwordSet: sftp.password,
      passwordSource: sftp.passwordSource,
      passwordLength: sftp.passwordLength,
      passwordDollarCount: sftp.passwordDollarCount,
      port: sftp.port,
      remoteDirs: sftp.remoteDirs,
      enableFlag: sftp.enableFlag,
    },
    sharepoint: sp,
    uploadWorker: {
      started: worker.started,
      active: worker.active,
      concurrency: worker.concurrency,
      blocked: worker.blocked !== null,
      blockedSince: worker.blocked?.since ?? null,
    },
    uploadQueue: queue
      ? {
          pending: queue.pending,
          oldestPendingSec: queue.oldestPendingSec,
          blocked: queue.blocked,
          checkinPending: queue.checkinPending,
          failedLast24h: queue.failedLast24h,
          checkedAt: queue.checkedAt,
        }
      : null,
    alertsConfigured: Boolean(process.env.IMAGEFLOW_ALERT_WEBHOOK?.trim()),
  });
});

registerAceSsoRoutes(app, "imageflow");

app.use((req, res, next) => {
  const start = Date.now();
  const pathName = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (pathName.startsWith("/api")) {
      let logLine = `${req.method} ${pathName} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

// Identity must match ace-auth's login event (ssoUserId = SSO sub). Excel checks are auto-polled
// and job retries replay queued uploads; handleStageJob flags idempotent re-posts of an existing job.
const ssoAuditIdentity = (req: Record<string, unknown>) => {
  const user = req.aceSsoUser as AceAuthRequest["aceSsoUser"];
  if (!user || user.id === "local-dev") return null;
  return {
    email: user.email,
    ssoUserId: user.sub || user.id,
    employeeId: user.employeeId ?? null,
    displayName: user.name,
  };
};
app.use(
  createActivityAudit({
    appSlug: "imageflow",
    getIdentity: ssoAuditIdentity,
    skip: (req, apiPath) =>
      req.imageflowAuditSkip === true ||
      /\/retry$/i.test(apiPath) ||
      /\/check-excel-updates$/i.test(apiPath),
  }),
);

app.post(
  "/api/usage-events",
  requireAceSsoApp("imageflow"),
  createUsageRelay({ appSlug: "imageflow", getIdentity: ssoAuditIdentity }),
);

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  if (!isSsoEnabled()) {
    console.warn("[SSO] Disabled (set ENABLE_SSO=true to require ACE login)");
  }

  if (process.env.NODE_ENV === "development") {
    // Gate HTML document routes; static exemptions live in requireAceSsoSpa.
    if (isSsoEnabled()) {
      app.use(requireAceSsoSpa("imageflow"));
    }
    const viteModule = "./vite" + "";
    const { setupVite } = await import(viteModule);
    await setupVite(app, server);
  } else {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const distPath = path.resolve(__dirname, "public");

    if (!fs.existsSync(distPath)) {
      throw new Error(
        `Could not find the build directory: ${distPath}, make sure to build the client first`,
      );
    }

    // Built assets FIRST — never pass real files through SSO middleware.
    app.use(
      express.static(distPath, {
        index: false,
        setHeaders(res, filePath) {
          // Allow module/style loads even with accidental crossorigin attrs.
          res.setHeader("Access-Control-Allow-Origin", "*");
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          }
        },
      }),
    );

    if (isSsoEnabled()) {
      app.use(requireAceSsoSpa("imageflow"));
    }

    // HTML shell only (and unknown routes). Never cache — asset hashes change.
    app.use("*", (_req, res) => {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
      res.setHeader("Pragma", "no-cache");
      res.sendFile(path.resolve(distPath, "index.html"));
    });
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  server.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);

      const sftp = getSftpEnvStatus();
      console.log(
        `[SFTP] configured=${sftp.configured} hostSet=${sftp.host} userSet=${sftp.user} passwordSet=${sftp.password} passwordSource=${sftp.passwordSource} passwordLen=${sftp.passwordLength} dollarCount=${sftp.passwordDollarCount} port=${sftp.port} dirs=${sftp.remoteDirs} ENABLE_EXCEL_SFTP_SYNC=${sftp.enableFlag ?? "(unset)"}`,
      );

      initializeScheduler();
      startUploadWorker();
      startUploadMonitor();
      void startDriveMigrationWorker();
    },
  );
})();
