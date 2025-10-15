import { google } from 'googleapis';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let connectionSettings: any;

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

  console.log('Fetching Google Drive connector...');
  
  // Use Google Drive connector which has broader scopes that include Gmail access
  const response = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=google-drive',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  );

  const data = await response.json();
  console.log('Connector response status:', response.status);
  console.log('Connector response data:', JSON.stringify(data, null, 2));

  connectionSettings = data.items?.[0];

  if (!connectionSettings) {
    throw new Error('Google Drive not connected - no connection settings found. Please reconnect Google Drive in Connectors.');
  }

  const accessToken = connectionSettings.settings?.access_token || connectionSettings.settings?.oauth?.credentials?.access_token;

  if (!accessToken) {
    throw new Error('Google Drive not connected - no access token found in settings');
  }
  
  console.log('Successfully retrieved access token');
  return accessToken;
}

// WARNING: Never cache this client.
// Access tokens expire, so a new client must be created each time.
// Always call this function again to get a fresh client.
export async function getUncachableGmailClient() {
  const accessToken = await getAccessToken();

  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({
    access_token: accessToken
  });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

export interface EmailCheckResult {
  success: boolean;
  message: string;
  fileName?: string;
  emailDate?: string;
  error?: string;
}

export async function checkForNewExcelFile(): Promise<EmailCheckResult> {
  try {
    const gmail = await getUncachableGmailClient();
    
    // Search for emails from scanner@aceelectronics.com with Excel attachments
    // Use parentheses to ensure the sender filter applies to both file extensions
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'from:scanner@aceelectronics.com has:attachment (filename:xlsx OR filename:xls)',
      maxResults: 1,
    });

    if (!response.data.messages || response.data.messages.length === 0) {
      return {
        success: false,
        message: 'No emails found from scanner@aceelectronics.com with Excel attachments'
      };
    }

    const messageId = response.data.messages[0].id!;
    
    // Get the full message with attachments
    const message = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
    });

    const parts = message.data.payload?.parts || [];
    let excelAttachment = null;
    let fileName = '';

    // Find Excel attachment
    for (const part of parts) {
      const mimeType = part.mimeType || '';
      const filename = part.filename || '';
      
      if (
        (mimeType.includes('spreadsheet') || 
         filename.endsWith('.xlsx') || 
         filename.endsWith('.xls')) &&
        part.body?.attachmentId
      ) {
        excelAttachment = part;
        fileName = filename;
        break;
      }
    }

    if (!excelAttachment || !excelAttachment.body?.attachmentId) {
      return {
        success: false,
        message: 'No Excel attachment found in the latest email'
      };
    }

    // Download the attachment
    const attachment = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: messageId,
      id: excelAttachment.body.attachmentId,
    });

    if (!attachment.data.data) {
      return {
        success: false,
        message: 'Failed to download attachment data'
      };
    }

    // Gmail uses base64url encoding - convert to standard base64 before decoding
    // Replace '-' with '+' and '_' with '/' to convert from base64url to base64
    const base64Data = attachment.data.data.replace(/-/g, '+').replace(/_/g, '/');
    const buffer = Buffer.from(base64Data, 'base64');

    // Save the file with timestamp to attached_assets folder
    const timestamp = Date.now();
    const newFileName = `OpenOrdersAllQtyOnly_${timestamp}.xlsx`;
    const filePath = join(__dirname, '..', 'attached_assets', newFileName);
    
    writeFileSync(filePath, buffer);

    // Get email date
    const emailDate = message.data.internalDate 
      ? new Date(parseInt(message.data.internalDate)).toISOString()
      : new Date().toISOString();

    return {
      success: true,
      message: 'Excel file successfully downloaded and saved',
      fileName: newFileName,
      emailDate
    };

  } catch (error: any) {
    console.error('Error checking Gmail for Excel file:', error);
    return {
      success: false,
      message: 'Error checking Gmail',
      error: error.message || String(error)
    };
  }
}
