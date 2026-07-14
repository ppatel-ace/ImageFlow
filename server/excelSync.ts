import type { ExcelCheckResult } from "./excelTypes";
import {
  checkForNewExcelFileViaSftp,
  isExcelSftpSyncAvailable,
} from "./sftpImport";

export type { ExcelCheckResult };
export { isExcelSftpSyncAvailable };

/** True when SFTP Excel sync credentials are configured. */
export function isExcelSyncAvailable(): boolean {
  return isExcelSftpSyncAvailable();
}

/**
 * Pull the newest Open Orders Excel from the Sage SFTP share.
 * Google Drive is no longer used for work-order / part-number sync.
 */
export async function checkForNewExcelFile(): Promise<ExcelCheckResult> {
  if (!isExcelSftpSyncAvailable()) {
    const host = Boolean(process.env.SFTP_HOST?.trim());
    const user = Boolean(process.env.SFTP_USER?.trim());
    const password = Boolean(process.env.SFTP_PASSWORD);
    const missing = [
      !host && "SFTP_HOST",
      !user && "SFTP_USER",
      !password && "SFTP_PASSWORD",
    ].filter(Boolean);
    return {
      success: false,
      message:
        missing.length > 0
          ? `Excel SFTP sync not configured — missing in the container: ${missing.join(", ")}. In Portainer these must be listed under the service environment (redeploy the updated docker-compose.yml).`
          : "Excel SFTP sync is disabled (ENABLE_EXCEL_SFTP_SYNC=false).",
    };
  }

  const result = await checkForNewExcelFileViaSftp();
  if (result.success) {
    return { ...result, source: "sftp" };
  }
  return result;
}
