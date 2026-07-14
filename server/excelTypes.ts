export interface ExcelCheckResult {
  success: boolean;
  message: string;
  fileName?: string;
  fileDate?: string;
  originalFileName?: string;
  error?: string;
  source?: "sftp";
}
