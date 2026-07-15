import { randomUUID } from "crypto";
import { desc, eq } from "drizzle-orm";
import { uploadHistory, type UploadHistoryRow } from "../shared/schema";
import { ensureUploadHistoryTable, getDb, isDatabaseConfigured } from "./db";

export type UploadHistoryDto = {
  id: string;
  uploadedAt: string;
  workOrderNumber: string;
  partNumber: string;
  rev: string;
  customerName: string;
  folderPath: string;
  fileName: string | null;
  webUrl: string | null;
  dept: string | null;
  userId: string;
  userEmail: string;
  userName: string;
};

export type NewUploadHistory = {
  workOrderNumber: string;
  partNumber: string;
  rev: string;
  customerName: string;
  folderPath: string;
  fileName?: string | null;
  webUrl?: string | null;
  dept?: string | null;
  userId: string;
  userEmail: string;
  userName: string;
};

function toDto(row: UploadHistoryRow): UploadHistoryDto {
  return {
    id: row.id,
    uploadedAt: row.uploadedAt.toISOString(),
    workOrderNumber: row.workOrderNumber,
    partNumber: row.partNumber,
    rev: row.rev,
    customerName: row.customerName,
    folderPath: row.folderPath,
    fileName: row.fileName ?? null,
    webUrl: row.webUrl ?? null,
    dept: row.dept ?? null,
    userId: row.userId,
    userEmail: row.userEmail,
    userName: row.userName,
  };
}

export async function recordUploadHistory(
  entry: NewUploadHistory,
): Promise<UploadHistoryDto | null> {
  if (!isDatabaseConfigured()) {
    console.warn("[uploadHistory] DATABASE_URL not set — skipping history write");
    return null;
  }
  await ensureUploadHistoryTable();
  const db = getDb();
  const [row] = await db
    .insert(uploadHistory)
    .values({
      id: randomUUID(),
      workOrderNumber: entry.workOrderNumber,
      partNumber: entry.partNumber,
      rev: entry.rev,
      customerName: entry.customerName,
      folderPath: entry.folderPath,
      fileName: entry.fileName ?? null,
      webUrl: entry.webUrl ?? null,
      dept: entry.dept ?? null,
      userId: entry.userId,
      userEmail: entry.userEmail,
      userName: entry.userName,
    })
    .returning();
  return row ? toDto(row) : null;
}

export async function listUploadHistory(options: {
  userId?: string;
  limit?: number;
}): Promise<UploadHistoryDto[]> {
  if (!isDatabaseConfigured()) {
    throw new Error("DATABASE_URL is not set — upload history requires Postgres");
  }
  await ensureUploadHistoryTable();
  const db = getDb();
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);

  const rows = options.userId
    ? await db
        .select()
        .from(uploadHistory)
        .where(eq(uploadHistory.userId, options.userId))
        .orderBy(desc(uploadHistory.uploadedAt))
        .limit(limit)
    : await db
        .select()
        .from(uploadHistory)
        .orderBy(desc(uploadHistory.uploadedAt))
        .limit(limit);

  return rows.map(toDto);
}
