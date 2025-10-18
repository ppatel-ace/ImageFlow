import { google } from 'googleapis';
import { Readable } from 'stream';

let connectionSettings: any;

// Replace invalid folder name characters with underscore
function sanitizeCustomerName(customerName: string): string {
  return customerName.replace(/[<>:"/\\|?*]/g, '_');
}

async function getAccessToken() {
  if (connectionSettings && connectionSettings.settings.expires_at && new Date(connectionSettings.settings.expires_at).getTime() > Date.now()) {
    return connectionSettings.settings.access_token;
  }
  
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken) {
    throw new Error('X_REPLIT_TOKEN not found for repl/depl');
  }

  connectionSettings = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=google-drive',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  ).then(res => res.json()).then(data => data.items?.[0]);

  if (!connectionSettings) {
    throw new Error('Google Drive not connected');
  }

  const accessToken = connectionSettings.settings?.access_token || connectionSettings.settings?.oauth?.credentials?.access_token;

  if (!accessToken) {
    throw new Error('Google Drive not connected');
  }
  return accessToken;
}

// WARNING: Never cache this client.
// Access tokens expire, so a new client must be created each time.
// Always call this function again to get a fresh client.
export async function getUncachableGoogleDriveClient() {
  const accessToken = await getAccessToken();

  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({
    access_token: accessToken
  });

  return google.drive({ version: 'v3', auth: oauth2Client });
}

// Find or create a folder by name in a parent folder
async function findOrCreateFolder(drive: any, folderName: string, parentId: string = 'root'): Promise<string> {
  // Search for existing folder
  const query = `name='${folderName.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  
  const response = await drive.files.list({
    q: query,
    fields: 'files(id, name)',
    spaces: 'drive',
  });

  if (response.data.files && response.data.files.length > 0) {
    // Folder exists, return its ID
    return response.data.files[0].id!;
  }

  // Folder doesn't exist, create it
  const fileMetadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentId],
  };

  const folder = await drive.files.create({
    requestBody: fileMetadata,
    fields: 'id',
  });

  return folder.data.id!;
}

// Ensure folder path exists (create nested folders if needed)
async function ensureFolderPath(drive: any, pathParts: string[]): Promise<string> {
  let parentId = 'root';
  
  for (const folderName of pathParts) {
    parentId = await findOrCreateFolder(drive, folderName, parentId);
  }
  
  return parentId;
}

export async function uploadFileToGoogleDrive(
  customerName: string,
  dept: string,
  workOrderNumber: string,
  fileName: string,
  fileBuffer: Buffer
) {
  const drive = await getUncachableGoogleDriveClient();
  
  // Path structure: ACE/CustomerName/Dept/WorkOrderNumber/filename
  const sanitizedCustomerName = sanitizeCustomerName(customerName);
  const pathParts = ['ACE', sanitizedCustomerName, dept, workOrderNumber];
  
  // Ensure the folder structure exists
  const folderId = await ensureFolderPath(drive, pathParts);
  
  // Upload the file
  const fileMetadata = {
    name: fileName,
    parents: [folderId],
  };

  // Convert Buffer to Stream (required by Google Drive API)
  const stream = Readable.from(fileBuffer);

  const media = {
    mimeType: 'image/jpeg', // Adjust based on actual file type if needed
    body: stream,
  };

  await drive.files.create({
    requestBody: fileMetadata,
    media: media,
    fields: 'id, name, webViewLink',
  });
  
  const folderPath = pathParts.join('/');
  
  return {
    success: true,
    path: `${folderPath}/${fileName}`
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
    const drive = await getUncachableGoogleDriveClient();
    
    // KSAlert folder ID provided by user
    const folderId = '1ixVvva0yj1FyytYBjj0DRuPNT4i76H76';
    
    // Search for .xlsx files in the KSAlert folder
    const query = `'${folderId}' in parents and mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' and trashed=false`;
    
    const response = await drive.files.list({
      q: query,
      fields: 'files(id, name, createdTime, modifiedTime)',
      orderBy: 'modifiedTime desc',
      spaces: 'drive',
    });

    if (!response.data.files || response.data.files.length === 0) {
      return {
        success: false,
        message: 'No Excel files found in KSAlert folder'
      };
    }

    // Filter files matching YYYYMMDD.xlsx pattern
    const datePattern = /^\d{8}\.xlsx$/;
    const validFiles = response.data.files.filter(file => 
      file.name && datePattern.test(file.name)
    );

    if (validFiles.length === 0) {
      return {
        success: false,
        message: 'No files matching YYYYMMDD.xlsx pattern found in KSAlert folder'
      };
    }

    // Sort by the date in filename (newest first)
    validFiles.sort((a, b) => {
      const dateA = a.name!.replace('.xlsx', '');
      const dateB = b.name!.replace('.xlsx', '');
      return dateB.localeCompare(dateA);
    });

    const latestFile = validFiles[0];
    const fileId = latestFile.id!;
    const originalFileName = latestFile.name!;

    // Download the file
    const fileResponse = await drive.files.get({
      fileId: fileId,
      alt: 'media',
    }, {
      responseType: 'arraybuffer'
    });

    const buffer = Buffer.from(fileResponse.data as ArrayBuffer);

    // Save the file with timestamp to attached_assets folder
    const timestamp = Date.now();
    const newFileName = `OpenOrdersAllQtyOnly_${timestamp}.xlsx`;
    const { writeFileSync } = await import('fs');
    const { join } = await import('path');
    const { fileURLToPath } = await import('url');
    const { dirname } = await import('path');
    
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
      originalFileName: originalFileName
    };

  } catch (error: any) {
    console.error('Error checking Google Drive for Excel file:', error);
    const errorMessage = error.message || String(error);
    return {
      success: false,
      message: errorMessage,
      error: errorMessage
    };
  }
}
