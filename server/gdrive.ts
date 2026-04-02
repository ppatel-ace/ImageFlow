import { ReplitConnectors } from "@replit/connectors-sdk";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ── Google Drive REST API response types ──────────────────────────────────────

interface DriveFile {
  id: string;
  name: string;
  createdTime?: string;
  modifiedTime?: string;
}

interface DriveFileListResponse {
  files: DriveFile[];
  nextPageToken?: string;
}

interface DriveFileCreateResponse {
  id: string;
  name: string;
  webViewLink?: string;
}

interface DriveErrorResponse {
  error?: {
    code: number;
    message: string;
    status?: string;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Replace invalid folder name characters with underscore
function sanitizeCustomerName(customerName: string): string {
  return customerName.replace(/[<>:"/\\|?*]/g, '_');
}

// Get MIME type from filename extension
function getMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'heic':
      return 'image/heic';
    default:
      return 'image/jpeg';
  }
}

// Parse a proxy response as JSON, throwing on non-2xx or Drive API error
async function parseJsonResponse<T>(response: Response, context: string): Promise<T> {
  if (!response.ok) {
    const text = await response.text().catch(() => `HTTP ${response.status}`);
    throw new Error(`Google Drive ${context} failed (${response.status}): ${text}`);
  }
  const data = (await response.json()) as T | DriveErrorResponse;
  if ((data as DriveErrorResponse).error) {
    const err = (data as DriveErrorResponse).error!;
    throw new Error(`Google Drive ${context} error ${err.code}: ${err.message}`);
  }
  return data as T;
}

// ── Folder management ─────────────────────────────────────────────────────────

// Find or create a folder by name inside parentId, returns the folder ID
async function findOrCreateFolder(
  connectors: ReplitConnectors,
  folderName: string,
  parentId: string = 'root'
): Promise<string> {
  const escapedName = folderName.replace(/'/g, "\\'");
  const q = `name='${escapedName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const params = new URLSearchParams({ q, fields: 'files(id,name)', spaces: 'drive' });

  const listResp = await connectors.proxy("google-drive", `/drive/v3/files?${params}`);
  const listData = await parseJsonResponse<DriveFileListResponse>(listResp, "folder list");

  if (listData.files.length > 0) {
    return listData.files[0].id;
  }

  // Folder doesn't exist — create it
  const createResp = await connectors.proxy("google-drive", "/drive/v3/files?fields=id,name", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  const createData = await parseJsonResponse<DriveFileCreateResponse>(createResp, "folder create");
  return createData.id;
}

// Walk pathParts creating/finding each nested folder, returns the leaf folder ID
async function ensureFolderPath(
  connectors: ReplitConnectors,
  pathParts: string[]
): Promise<string> {
  let parentId = 'root';
  for (const folderName of pathParts) {
    parentId = await findOrCreateFolder(connectors, folderName, parentId);
  }
  return parentId;
}

// ── Public API ────────────────────────────────────────────────────────────────

// WARNING: Never cache this client.
// The connectors SDK handles token refresh automatically per request.
export async function getUncachableGoogleDriveClient(): Promise<ReplitConnectors> {
  return new ReplitConnectors();
}

export async function uploadFileToGoogleDrive(
  customerName: string,
  dept: string,
  workOrderNumber: string,
  fileName: string,
  fileBuffer: Buffer
): Promise<{ success: boolean; path: string }> {
  const connectors = new ReplitConnectors();

  // Path structure: ACE/CustomerName/Dept/WorkOrderNumber
  const sanitizedCustomerName = sanitizeCustomerName(customerName);
  const pathParts = ['ACE', sanitizedCustomerName, dept, workOrderNumber];
  const folderId = await ensureFolderPath(connectors, pathParts);

  // Build a multipart/related body: metadata part + binary part
  const boundary = 'gdrive_upload_' + Date.now();
  const mimeType = getMimeType(fileName);
  const metadata = JSON.stringify({ name: fileName, parents: [folderId] });

  const metadataPart = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    'utf8'
  );
  const mediaHeader = Buffer.from(
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    'utf8'
  );
  const closingPart = Buffer.from(`\r\n--${boundary}--`, 'utf8');
  const multipartBody = Buffer.concat([metadataPart, mediaHeader, fileBuffer, closingPart]);

  const uploadResp = await connectors.proxy(
    "google-drive",
    "/upload/drive/v3/files?uploadType=multipart&fields=id,name",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: multipartBody,
    }
  );
  await parseJsonResponse<DriveFileCreateResponse>(uploadResp, "file upload");

  return {
    success: true,
    path: `${pathParts.join('/')}/${fileName}`,
  };
}

export interface ExcelCheckResult {
  success: boolean;
  message: string;
  fileName?: string;
  fileDate?: string;
  originalFileName?: string;
  error?: string;
}

// Check KSAlert folder for new Excel files with YYYYMMDD.xlsx naming pattern
export async function checkForNewExcelFile(): Promise<ExcelCheckResult> {
  try {
    const connectors = new ReplitConnectors();

    // KSAlert folder ID provided by user
    const folderId = '1ixVvva0yj1FyytYBjj0DRuPNT4i76H76';
    const q = `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`;
    const params = new URLSearchParams({
      q,
      fields: 'files(id,name,createdTime,modifiedTime)',
      orderBy: 'modifiedTime desc',
      spaces: 'drive',
    });

    const listResp = await connectors.proxy("google-drive", `/drive/v3/files?${params}`);
    const listData = await parseJsonResponse<DriveFileListResponse>(listResp, "Excel file list");

    if (!listData.files || listData.files.length === 0) {
      return { success: false, message: 'No Excel files found in KSAlert folder' };
    }

    // Filter files matching YYYYMMDD.xlsx pattern
    const datePattern = /^\d{8}\.xlsx$/;
    const validFiles = listData.files.filter(
      (file: DriveFile) => file.name && datePattern.test(file.name)
    );

    if (validFiles.length === 0) {
      return {
        success: false,
        message: 'No files matching YYYYMMDD.xlsx pattern found in KSAlert folder',
      };
    }

    // Sort by the date in filename (newest first)
    validFiles.sort((a: DriveFile, b: DriveFile) =>
      b.name.replace('.xlsx', '').localeCompare(a.name.replace('.xlsx', ''))
    );

    const latestFile = validFiles[0];
    const originalFileName = latestFile.name;

    // Download file content
    const downloadResp = await connectors.proxy(
      "google-drive",
      `/drive/v3/files/${encodeURIComponent(latestFile.id)}?alt=media`
    );

    if (!downloadResp.ok) {
      const errText = await downloadResp.text().catch(() => `HTTP ${downloadResp.status}`);
      throw new Error(`Failed to download Excel file (${downloadResp.status}): ${errText}`);
    }

    const buffer = Buffer.from(await downloadResp.arrayBuffer());

    // Save with timestamp to attached_assets folder
    const timestamp = Date.now();
    const newFileName = `OpenOrdersAllQtyOnly_${timestamp}.xlsx`;

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const filePath = join(__dirname, '..', 'attached_assets', newFileName);
    writeFileSync(filePath, buffer);

    // Format date from YYYYMMDD filename
    const fileDate = originalFileName.replace('.xlsx', '');
    const formattedDate = `${fileDate.slice(0, 4)}-${fileDate.slice(4, 6)}-${fileDate.slice(6, 8)}`;

    return {
      success: true,
      message: `Excel file ${originalFileName} successfully downloaded and saved`,
      fileName: newFileName,
      fileDate: formattedDate,
      originalFileName,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Error checking Google Drive for Excel file:', errorMessage);
    return {
      success: false,
      message: errorMessage,
      error: errorMessage,
    };
  }
}
