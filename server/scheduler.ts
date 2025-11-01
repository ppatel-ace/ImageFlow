import cron from 'node-cron';
import { checkForNewExcelFile } from './gdrive';
import { reloadExcelData } from './excelParser';

// Server-side scheduled task to check for Excel updates at 7:20 AM EST/EDT daily
export function initializeScheduler() {
  console.log('[Scheduler] Initializing Excel update scheduler...');
  
  // Cron expression: "20 7 * * *" runs at 7:20 AM
  // Using timezone: America/New_York for EST/EDT handling
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
    
    console.log(`[Scheduler] Running scheduled Excel update check at ${timestamp} EST/EDT`);
    
    try {
      const driveResult = await checkForNewExcelFile();
      
      if (!driveResult.success) {
        console.log(`[Scheduler] No new Excel file found: ${driveResult.message}`);
        return;
      }
      
      console.log(`[Scheduler] New Excel file found: ${driveResult.originalFileName}`);
      
      // Reload Excel data with the new file
      const reloadResult = reloadExcelData();
      
      if (!reloadResult.success) {
        console.error(`[Scheduler] Failed to reload Excel data: ${reloadResult.error}`);
        return;
      }
      
      console.log(`[Scheduler] ✓ Excel data successfully updated from ${driveResult.originalFileName}`);
      console.log(`[Scheduler] ✓ Current file: ${reloadResult.fileName}`);
    } catch (error: any) {
      console.error('[Scheduler] Error during scheduled Excel update:', error.message);
    }
  }, {
    timezone: 'America/New_York'
  });
  
  console.log('[Scheduler] ✓ Excel update scheduler initialized (runs daily at 7:20 AM EST/EDT)');
  
  // Also run an initial check 10 seconds after server startup
  setTimeout(async () => {
    console.log('[Scheduler] Running initial Excel update check on server startup...');
    try {
      const driveResult = await checkForNewExcelFile();
      
      if (driveResult.success) {
        const reloadResult = reloadExcelData();
        if (reloadResult.success) {
          console.log(`[Scheduler] ✓ Initial update successful: ${driveResult.originalFileName}`);
        }
      } else {
        console.log(`[Scheduler] Initial check: ${driveResult.message}`);
      }
    } catch (error: any) {
      console.error('[Scheduler] Initial update check error:', error.message);
    }
  }, 10000); // 10 seconds delay
}
