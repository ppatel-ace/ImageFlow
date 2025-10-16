import { writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { getGmailClient } from './oauth';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface EmailCheckResult {
  success: boolean;
  message: string;
  fileName?: string;
  emailDate?: string;
  error?: string;
}

export async function checkForNewExcelFile(): Promise<EmailCheckResult> {
  try {
    const gmail = await getGmailClient();
    
    // Search for emails from KSAlerts@aceelectronics.com with Excel attachments
    // Use parentheses to ensure the sender filter applies to both file extensions
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'from:KSAlerts@aceelectronics.com has:attachment (filename:xlsx OR filename:xls)',
      maxResults: 1,
    });

    if (!response.data.messages || response.data.messages.length === 0) {
      return {
        success: false,
        message: 'No emails found from KSAlerts@aceelectronics.com with Excel attachments'
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
    const errorMessage = error.message || String(error);
    return {
      success: false,
      message: errorMessage, // Return the actual error message instead of generic one
      error: errorMessage
    };
  }
}
