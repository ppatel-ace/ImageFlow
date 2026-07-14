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
    return {
      success: false,
      message:
        "Excel SFTP sync not configured. Set SFTP_HOST, SFTP_USER, and SFTP_PASSWORD.",
    };
  }

  const result = await checkForNewExcelFileViaSftp();
  if (result.success) {
    return { ...result, source: "sftp" };
  }
  return result;
}
