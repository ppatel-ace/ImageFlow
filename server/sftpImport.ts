import SftpClient from "ssh2-sftp-client";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { ExcelCheckResult } from "./excelTypes";

const DEFAULT_REMOTE_DIRS = ["/mnt/sage", "/mnt/import"];
/** Matches daily dumps like "Open Order All Qty Only_20260714.xlsx" (spacing/underscore variants OK). */
const OPEN_ORDER_PATTERN = /^open\s*order\s*all\s*qty\s*only[_-\s].+\.xlsx$/i;

interface RemoteExcelFile {
  name: string;
  remotePath: string;
  modifyTime: number;
  size: number;
}

function envFlagEnabled(name: string): boolean | null {
  const flag = process.env[name]?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off" || flag === "no") return false;
  if (flag === "1" || flag === "true" || flag === "on" || flag === "yes") return true;
  return null;
}

/**
 * Resolve SFTP password.
 * Prefer SFTP_PASSWORD_B64 — Portainer/Compose often collapses "$$" → "$" in plain values.
 */
function resolveSftpPassword(): string | undefined {
  const b64 = process.env.SFTP_PASSWORD_B64?.trim();
  if (b64) {
    try {
      return Buffer.from(b64, "base64").toString("utf8");
    } catch {
      throw new Error("SFTP_PASSWORD_B64 is not valid base64");
    }
  }

  const plain = process.env.SFTP_PASSWORD;
  if (!plain) return undefined;

  // Compose/Portainer often collapses "$$" → "$". Restore doubles by default.
  // In String.replace, "$$$$" in the replacement yields two literal "$" characters.
  const escapeMode = process.env.SFTP_PASSWORD_DOLLAR_ESCAPE?.trim().toLowerCase();
  if (escapeMode === "off" || escapeMode === "false" || escapeMode === "0") {
    return plain;
  }
  if (plain.includes("$") && !plain.includes("$$")) {
    return plain.replace(/\$/g, "$$$$");
  }
  return plain;
}

export function isExcelSftpSyncAvailable(): boolean {
  const flag = envFlagEnabled("ENABLE_EXCEL_SFTP_SYNC");
  if (flag === false) return false;
  return Boolean(
    process.env.SFTP_HOST?.trim() &&
      process.env.SFTP_USER?.trim() &&
      resolveSftpPassword(),
  );
}

/** Safe diagnostics for logs /health — never includes the password. */
export function getSftpEnvStatus(): {
  configured: boolean;
  host: boolean;
  user: boolean;
  password: boolean;
  passwordSource: "b64" | "plain" | "none";
  passwordLength: number;
  passwordDollarCount: number;
  port: string;
  remoteDirs: string;
  enableFlag: string | null;
} {
  const resolved = resolveSftpPassword();
  return {
    configured: isExcelSftpSyncAvailable(),
    host: Boolean(process.env.SFTP_HOST?.trim()),
    user: Boolean(process.env.SFTP_USER?.trim()),
    password: Boolean(resolved),
    passwordSource: process.env.SFTP_PASSWORD_B64?.trim()
      ? "b64"
      : process.env.SFTP_PASSWORD
        ? "plain"
        : "none",
    passwordLength: resolved?.length ?? 0,
    passwordDollarCount: (resolved?.match(/\$/g) || []).length,
    port: process.env.SFTP_PORT?.trim() || "22",
    remoteDirs: process.env.SFTP_REMOTE_DIRS?.trim() || "/mnt/sage,/mnt/import",
    enableFlag: process.env.ENABLE_EXCEL_SFTP_SYNC?.trim() || null,
  };
}

function getSftpConfig() {
  const host = process.env.SFTP_HOST?.trim();
  const user = process.env.SFTP_USER?.trim();
  const password = resolveSftpPassword();
  if (!host || !user || !password) {
    throw new Error(
      "SFTP_HOST, SFTP_USER, and SFTP_PASSWORD (or SFTP_PASSWORD_B64) are required",
    );
  }

  const port = parseInt(process.env.SFTP_PORT?.trim() || "22", 10);
  return {
    host,
    port: Number.isFinite(port) ? port : 22,
    username: user,
    password,
    readyTimeout: 20000,
    tryKeyboard: true,
  };
}

function getRemoteDirs(): string[] {
  const raw = process.env.SFTP_REMOTE_DIRS?.trim();
  if (!raw) return DEFAULT_REMOTE_DIRS;
  return raw
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

function matchesOpenOrderFile(name: string): boolean {
  return OPEN_ORDER_PATTERN.test(name);
}

const MONTH_NAMES: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

/** Parse dates from filenames like "Open Order All Qty Only_14 July 2026.xlsx". */
function parseEmbeddedDate(name: string): string | null {
  const textual = name.match(
    /(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i,
  );
  if (textual) {
    const day = textual[1].padStart(2, "0");
    const month = MONTH_NAMES[textual[2].toLowerCase()];
    const year = textual[3];
    if (month) return `${year}${month}${day}`;
  }

  const digits = name.match(/(\d{8}|\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4})/);
  if (!digits) return null;

  const token = digits[1];
  if (/^\d{8}$/.test(token)) return token;
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) return token.replace(/-/g, "");
  if (/^\d{2}-\d{2}-\d{4}$/.test(token)) {
    const [mm, dd, yyyy] = token.split("-");
    return `${yyyy}${mm}${dd}`;
  }
  return null;
}

/** Prefer a date embedded in the filename; fall back to SFTP mtime. */
function sortKeyForFile(name: string, modifyTime: number): string {
  return parseEmbeddedDate(name) || String(modifyTime).padStart(15, "0");
}

function formatFileDate(name: string, modifyTime: number): string {
  const ymd = parseEmbeddedDate(name);
  if (ymd && ymd.length === 8) {
    return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  }
  return new Date(modifyTime).toISOString().slice(0, 10);
}

async function listMatchingFiles(sftp: SftpClient, remoteDir: string): Promise<RemoteExcelFile[]> {
  try {
    const entries = await sftp.list(remoteDir);
    return entries
      .filter((entry) => entry.type === "-" && matchesOpenOrderFile(entry.name))
      .map((entry) => ({
        name: entry.name,
        remotePath: `${remoteDir.replace(/\/$/, "")}/${entry.name}`,
        modifyTime: entry.modifyTime || 0,
        size: entry.size || 0,
      }));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[sftp] Could not list ${remoteDir}: ${message}`);
    return [];
  }
}

/**
 * Download the newest "Open Order All Qty Only_…" Excel from the Sage/import SFTP
 * share and save it as OpenOrdersAllQtyOnly_{timestamp}.xlsx for excelParser.
 */
export async function checkForNewExcelFileViaSftp(): Promise<ExcelCheckResult> {
  if (!isExcelSftpSyncAvailable()) {
    return {
      success: false,
      message: "Excel SFTP sync not configured (set SFTP_HOST, SFTP_USER, SFTP_PASSWORD)",
    };
  }

  const sftp = new SftpClient();
  try {
    const config = getSftpConfig();
    await sftp.connect(config);

    const remoteDirs = getRemoteDirs();
    const allFiles: RemoteExcelFile[] = [];
    for (const dir of remoteDirs) {
      const files = await listMatchingFiles(sftp, dir);
      allFiles.push(...files);
    }

    if (allFiles.length === 0) {
      return {
        success: false,
        message: `No Open Order All Qty Only Excel files found in ${remoteDirs.join(" or ")}`,
      };
    }

    allFiles.sort((a, b) =>
      sortKeyForFile(b.name, b.modifyTime).localeCompare(sortKeyForFile(a.name, a.modifyTime)),
    );

    const latest = allFiles[0];
    const buffer = (await sftp.get(latest.remotePath)) as Buffer;

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const assetsDir = join(__dirname, "..", "attached_assets");
    if (!existsSync(assetsDir)) {
      mkdirSync(assetsDir, { recursive: true });
    }

    const newFileName = `OpenOrdersAllQtyOnly_${Date.now()}.xlsx`;
    writeFileSync(join(assetsDir, newFileName), buffer);

    console.log(
      `[sftp] Downloaded ${latest.name} from ${latest.remotePath} → ${newFileName} (${buffer.length} bytes)`,
    );

    return {
      success: true,
      message: `Excel file ${latest.name} successfully downloaded via SFTP`,
      fileName: newFileName,
      fileDate: formatFileDate(latest.name, latest.modifyTime),
      originalFileName: latest.name,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[sftp] Error downloading Excel file:", errorMessage);
    return {
      success: false,
      message: errorMessage,
      error: errorMessage,
    };
  } finally {
    try {
      await sftp.end();
    } catch {
      // connection may already be closed
    }
  }
}
