import {
  checkForNewExcelFile as checkForNewExcelFileViaDrive,
  isExcelDriveSyncAvailable,
  type ExcelCheckResult,
} from "./gdrive";
import {
  checkForNewExcelFileViaSftp,
  isExcelSftpSyncAvailable,
} from "./sftpImport";

export type { ExcelCheckResult };
export { isExcelDriveSyncAvailable, isExcelSftpSyncAvailable };

/** True when either SFTP or Google Drive Excel sync can run. */
export function isExcelSyncAvailable(): boolean {
  return isExcelSftpSyncAvailable() || isExcelDriveSyncAvailable();
}

/**
 * Prefer SFTP (production Sage dump) when configured; fall back to Google Drive.
 */
export async function checkForNewExcelFile(): Promise<ExcelCheckResult> {
  if (isExcelSftpSyncAvailable()) {
    const sftpResult = await checkForNewExcelFileViaSftp();
    if (sftpResult.success) {
      return sftpResult;
    }
    console.warn(`[excelSync] SFTP sync failed: ${sftpResult.message}`);

    if (!isExcelDriveSyncAvailable()) {
      return sftpResult;
    }
    console.log("[excelSync] Falling back to Google Drive Excel sync…");
  }

  return checkForNewExcelFileViaDrive();
}
