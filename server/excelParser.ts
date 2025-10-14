import * as XLSX from 'xlsx';
import { readFileSync, readdirSync } from 'fs';
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

export function parseExcelFile(filePath: string): WorkOrderData[] {
  const fileBuffer = readFileSync(filePath);
  const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  
  // Convert to JSON with header row
  const data: any[] = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
  
  // Skip header row and parse data
  // Based on actual Excel structure:
  // Index 4 = SalesOrderNo (Work Order #)
  // Index 6 = BillToName (Customer Name)
  // Index 9 = ItemCode (Part #)
  // Index 14 = UDF_REV (Rev)
  const workOrderData: WorkOrderData[] = [];
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length === 0) continue;
    
    const workOrder = row[4]?.toString().trim(); // SalesOrderNo
    const customerName = row[6]?.toString().trim(); // BillToName
    const rev = row[14]?.toString().trim() || ''; // UDF_REV
    const partNumber = row[9]?.toString().trim(); // ItemCode
    
    // Only add rows that have at least work order and part number
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

// Get the latest Excel file from attached_assets folder
export function getLatestExcelFile(): string | null {
  try {
    const assetsPath = join(__dirname, '..', 'attached_assets');
    const files = readdirSync(assetsPath);
    
    // Filter for Excel files matching the pattern
    const excelFiles = files.filter(file => 
      file.startsWith('OpenOrdersAllQtyOnly_') && file.endsWith('.xlsx')
    );
    
    if (excelFiles.length === 0) {
      return null;
    }
    
    // Sort by timestamp (newest first)
    excelFiles.sort((a, b) => {
      const timestampA = parseInt(a.match(/\d+/)?.[0] || '0');
      const timestampB = parseInt(b.match(/\d+/)?.[0] || '0');
      return timestampB - timestampA;
    });
    
    return excelFiles[0];
  } catch (error) {
    console.error('Error finding latest Excel file:', error);
    return null;
  }
}

// Reload cache with latest Excel file
export function reloadExcelData(): { success: boolean; fileName?: string; error?: string } {
  try {
    const latestFile = getLatestExcelFile();
    
    if (!latestFile) {
      return { success: false, error: 'No Excel file found' };
    }
    
    const excelPath = join(__dirname, '..', 'attached_assets', latestFile);
    cachedData = parseExcelFile(excelPath);
    currentFileName = latestFile;
    
    return { success: true, fileName: latestFile };
  } catch (error: any) {
    console.error('Error reloading Excel data:', error);
    return { success: false, error: error.message || String(error) };
  }
}

export function getWorkOrderData(): WorkOrderData[] {
  if (cachedData) {
    return cachedData;
  }
  
  try {
    const latestFile = getLatestExcelFile();
    const fileName = latestFile || 'OpenOrdersAllQtyOnly_1760375874902.xlsx';
    const excelPath = join(__dirname, '..', 'attached_assets', fileName);
    
    cachedData = parseExcelFile(excelPath);
    currentFileName = fileName;
    return cachedData;
  } catch (error) {
    console.error('Error loading Excel file:', error);
    return [];
  }
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
