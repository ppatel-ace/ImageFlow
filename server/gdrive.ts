import { google } from 'googleapis';

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

  const media = {
    mimeType: 'image/jpeg', // Adjust based on actual file type if needed
    body: fileBuffer,
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
