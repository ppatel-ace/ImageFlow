import { loadEnvFile, isSsoEnabled } from "./env";
loadEnvFile();

import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { initializeScheduler } from "./scheduler";
import { registerAceSsoRoutes, requireAceSsoSpa } from "./aceSso";
import { getSftpEnvStatus } from "./sftpImport";
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
  res.json({
    ok: true,
    service: "imageflow",
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

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  if (isSsoEnabled()) {
    app.use(requireAceSsoSpa("imageflow"));
  } else {
    console.warn("[SSO] Disabled (set ENABLE_SSO=true to require ACE login)");
  }

  if (process.env.NODE_ENV === "development") {
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

    app.use(express.static(distPath));

    app.use("*", (_req, res) => {
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
    },
  );
})();
