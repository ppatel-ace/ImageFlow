import readXlsxFile from 'read-excel-file/node';
import { readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface WorkOrderData {
  workOrder: string;
  partNumber: string;
  customerName: string;
  rev: string;
}

let cachedData: WorkOrderData[] | null = null;
let currentFileName: string | null = null;

export async function parseExcelFile(filePath: string): Promise<WorkOrderData[]> {
  const rows: any[][] = await readXlsxFile(filePath) as any[][];

  const workOrderData: WorkOrderData[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const workOrder = row[4] != null ? String(row[4]).trim() : '';
    const customerName = row[6] != null ? String(row[6]).trim() : '';
    const rev = row[14] != null ? String(row[14]).trim() : '';
    const partNumber = row[9] != null ? String(row[9]).trim() : '';

    if (workOrder && partNumber) {
      workOrderData.push({
        workOrder,
        partNumber,
        customerName: customerName || '',
        rev: rev || ''
      });
    }
  }

  return workOrderData;
}

export function getLatestExcelFile(): string | null {
  try {
    const assetsPath = join(__dirname, '..', 'attached_assets');
    const files = readdirSync(assetsPath);

    const excelFiles = files.filter(file =>
      (file.startsWith('OpenOrdersAllQtyOnly_') || file === 'OpenOrdersAllQtyOnly_seed.xlsx') &&
      file.endsWith('.xlsx')
    );

    if (excelFiles.length === 0) {
      return null;
    }

    // Prefer dated / timestamp dumps over the seed file
    const ranked = [...excelFiles].sort((a, b) => {
      if (a.includes('seed') && !b.includes('seed')) return 1;
      if (b.includes('seed') && !a.includes('seed')) return -1;
      const timestampA = parseInt(a.match(/\d{10,}/)?.[0] || a.match(/\d+/)?.[0] || '0', 10);
      const timestampB = parseInt(b.match(/\d{10,}/)?.[0] || b.match(/\d+/)?.[0] || '0', 10);
      return timestampB - timestampA;
    });

    return ranked[0];
  } catch (error: any) {
    const code = error?.code || '';
    const msg = error?.message || String(error);
    if (code === 'ENOENT' || msg.includes('ENOENT') || msg.includes('no such file')) {
      console.warn('[excelParser] attached_assets missing or unreadable — Excel work-order data unavailable until a file is mounted.');
    } else {
      console.warn('[excelParser] Could not find latest Excel file:', msg);
    }
    return null;
  }
}

export async function reloadExcelData(): Promise<{ success: boolean; fileName?: string; error?: string }> {
  try {
    const latestFile = getLatestExcelFile();

    if (!latestFile) {
      return { success: false, error: 'No Excel file found' };
    }

    const excelPath = join(__dirname, '..', 'attached_assets', latestFile);
    cachedData = await parseExcelFile(excelPath);
    currentFileName = latestFile;

    return { success: true, fileName: latestFile };
  } catch (error: any) {
    console.error('Error reloading Excel data:', error);
    return { success: false, error: error.message || String(error) };
  }
}

export function getWorkOrderData(): WorkOrderData[] {
  return cachedData || [];
}

export function getCurrentFileName(): string | null {
  return currentFileName;
}

export function getPartNumbersByWorkOrder(workOrder: string): { partNumber: string; rev: string; customerName: string }[] {
  const data = getWorkOrderData();
  return data
    .filter(item => item.workOrder === workOrder)
    .map(item => ({
      partNumber: item.partNumber,
      rev: item.rev,
      customerName: item.customerName
    }));
}

export function getRevByPartNumber(partNumber: string): string {
  const data = getWorkOrderData();
  const item = data.find(item => item.partNumber === partNumber);
  return item?.rev || '';
}

export function getAllWorkOrders(): string[] {
  const data = getWorkOrderData();
  const uniqueWorkOrders = Array.from(new Set(data.map(item => item.workOrder)));
  return uniqueWorkOrders.sort();
}

(async () => {
  try {
    const latestFile = getLatestExcelFile();
    if (!latestFile) {
      console.warn(
        '[excelParser] No OpenOrders Excel file in attached_assets — work-order lookup empty until a file is mounted or Drive sync runs.',
      );
      return;
    }
    const excelPath = join(__dirname, '..', 'attached_assets', latestFile);
    cachedData = await parseExcelFile(excelPath);
    currentFileName = latestFile;
    console.log(`[excelParser] Loaded initial Excel file: ${latestFile}`);
  } catch (error: any) {
    const code = error?.code || '';
    const msg = error?.message || String(error);
    if (code === 'ENOENT' || msg.includes('ENOENT') || msg.includes('no such file')) {
      console.warn('[excelParser] Initial Excel file missing — skipping load (SharePoint image uploads unaffected).');
    } else {
      console.warn('[excelParser] Skipping initial Excel load:', msg);
    }
  }
})();
