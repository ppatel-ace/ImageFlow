import { ReplitConnectors } from "@replit/connectors-sdk";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Replace invalid folder name characters with underscore
function sanitizeCustomerName(customerName: string): string {
  return customerName.replace(/[<>:"/\\|?*]/g, '_');
}

// Helper to get MIME type from filename extension
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

// Find or create a folder by name in a parent folder using connectors proxy
async function findOrCreateFolder(
  connectors: ReplitConnectors,
  folderName: string,
  parentId: string = 'root'
): Promise<string> {
  const escapedName = folderName.replace(/'/g, "\\'");
  const q = `name='${escapedName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const params = new URLSearchParams({ q, fields: 'files(id,name)', spaces: 'drive' });

  const listResp = await connectors.proxy("google-drive", `/drive/v3/files?${params}`);
  const listData = await listResp.json() as any;

  if (listData.files && listData.files.length > 0) {
    return listData.files[0].id as string;
  }

  // Folder doesn't exist — create it
  const createResp = await connectors.proxy("google-drive", "/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  const createData = await createResp.json() as any;

  if (!createData.id) {
    throw new Error(`Failed to create folder "${folderName}": ${JSON.stringify(createData)}`);
  }
  return createData.id as string;
}

// Ensure folder path exists, creating nested folders as needed
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

// WARNING: Never cache this client.
// The connectors SDK handles token refresh automatically, but always call fresh per request.
export async function getUncachableGoogleDriveClient() {
  // Returns a ReplitConnectors instance scoped to google-drive.
  // All API calls go through the proxy which handles OAuth automatically.
  return new ReplitConnectors();
}

export async function uploadFileToGoogleDrive(
  customerName: string,
  dept: string,
  workOrderNumber: string,
  fileName: string,
  fileBuffer: Buffer
) {
  const connectors = new ReplitConnectors();

  // Path structure: ACE/CustomerName/Dept/WorkOrderNumber/filename
  const sanitizedCustomerName = sanitizeCustomerName(customerName);
  const pathParts = ['ACE', sanitizedCustomerName, dept, workOrderNumber];

  // Ensure the folder structure exists
  const folderId = await ensureFolderPath(connectors, pathParts);

  // Multipart upload: metadata + file binary
  const boundary = 'gdrive_upload_boundary_' + Date.now();
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
      headers: {
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    }
  );

  const uploadData = await uploadResp.json() as any;

  if (!uploadData.id) {
    throw new Error(`Google Drive upload failed: ${JSON.stringify(uploadData)}`);
  }

  const folderPath = pathParts.join('/');
  return {
    success: true,
    path: `${folderPath}/${fileName}`,
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

    // Search for .xlsx files in the KSAlert folder
    const q = `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`;
    const params = new URLSearchParams({
      q,
      fields: 'files(id,name,createdTime,modifiedTime)',
      orderBy: 'modifiedTime desc',
      spaces: 'drive',
    });

    const listResp = await connectors.proxy("google-drive", `/drive/v3/files?${params}`);
    const listData = await listResp.json() as any;

    if (!listData.files || listData.files.length === 0) {
      return {
        success: false,
        message: 'No Excel files found in KSAlert folder',
      };
    }

    // Filter files matching YYYYMMDD.xlsx pattern
    const datePattern = /^\d{8}\.xlsx$/;
    const validFiles = listData.files.filter(
      (file: any) => file.name && datePattern.test(file.name)
    );

    if (validFiles.length === 0) {
      return {
        success: false,
        message: 'No files matching YYYYMMDD.xlsx pattern found in KSAlert folder',
      };
    }

    // Sort by the date in filename (newest first)
    validFiles.sort((a: any, b: any) => {
      const dateA = (a.name as string).replace('.xlsx', '');
      const dateB = (b.name as string).replace('.xlsx', '');
      return dateB.localeCompare(dateA);
    });

    const latestFile = validFiles[0];
    const fileId = latestFile.id as string;
    const originalFileName = latestFile.name as string;

    // Download the file content
    const downloadResp = await connectors.proxy(
      "google-drive",
      `/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`
    );

    if (!downloadResp.ok) {
      const errText = await downloadResp.text();
      throw new Error(`Failed to download Excel file: ${errText}`);
    }

    const arrayBuffer = await downloadResp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Save the file with timestamp to attached_assets folder
    const timestamp = Date.now();
    const newFileName = `OpenOrdersAllQtyOnly_${timestamp}.xlsx`;

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const filePath = join(__dirname, '..', 'attached_assets', newFileName);

    writeFileSync(filePath, buffer);

    // Extract date from filename (YYYYMMDD format)
    const fileDate = originalFileName.replace('.xlsx', '');
    const year = fileDate.substring(0, 4);
    const month = fileDate.substring(4, 6);
    const day = fileDate.substring(6, 8);
    const formattedDate = `${year}-${month}-${day}`;

    return {
      success: true,
      message: `Excel file ${originalFileName} successfully downloaded and saved`,
      fileName: newFileName,
      fileDate: formattedDate,
      originalFileName: originalFileName,
    };
  } catch (error: any) {
    console.error('Error checking Google Drive for Excel file:', error);
    const errorMessage = error.message || String(error);
    return {
      success: false,
      message: errorMessage,
      error: errorMessage,
    };
  }
}
