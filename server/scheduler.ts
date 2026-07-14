import cron from 'node-cron';
import { checkForNewExcelFile, isExcelSyncAvailable } from './excelSync';
import { reloadExcelData } from './excelParser';

async function runExcelUpdate(label: string): Promise<void> {
  console.log(`[Scheduler] ${label}`);

  try {
    const syncResult = await checkForNewExcelFile();

    if (!syncResult.success) {
      console.log(`[Scheduler] No new Excel file found: ${syncResult.message}`);
      return;
    }

    console.log(`[Scheduler] New Excel file found: ${syncResult.originalFileName}`);

    const reloadResult = await reloadExcelData();

    if (!reloadResult.success) {
      console.error(`[Scheduler] Failed to reload Excel data: ${reloadResult.error}`);
      return;
    }

    console.log(`[Scheduler] ✓ Excel data successfully updated from ${syncResult.originalFileName}`);
    console.log(`[Scheduler] ✓ Current file: ${reloadResult.fileName}`);
  } catch (error: any) {
    console.error('[Scheduler] Error during scheduled Excel update:', error.message);
  }
}

// Server-side scheduled task to check for Excel updates at 7:20 AM EST/EDT daily
export function initializeScheduler() {
  if (!isExcelSyncAvailable()) {
    console.warn(
      '[Scheduler] Excel SFTP sync disabled — set SFTP_HOST, SFTP_USER, and SFTP_PASSWORD. SharePoint image uploads are unaffected.',
    );
    return;
  }

  console.log('[Scheduler] Initializing Excel SFTP update scheduler...');

  const cronExpression = '20 7 * * *';

  cron.schedule(cronExpression, async () => {
    const timestamp = new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    await runExcelUpdate(`Running scheduled Excel SFTP update at ${timestamp} EST/EDT`);
  }, {
    timezone: 'America/New_York'
  });

  console.log('[Scheduler] ✓ Excel SFTP scheduler initialized (daily at 7:20 AM EST/EDT)');

  setTimeout(async () => {
    try {
      await runExcelUpdate('Running initial Excel SFTP update check on server startup...');
    } catch (error: any) {
      console.error('[Scheduler] Initial update check error:', error?.message || String(error));
    }
  }, 10000);
}
