import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

/** SharePoint upload audit — one row per successfully uploaded image. */
export const uploadHistory = pgTable("imageflow_upload_history", {
  id: text("id").primaryKey(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  workOrderNumber: text("work_order_number").notNull(),
  partNumber: text("part_number").notNull().default(""),
  rev: text("rev").notNull().default(""),
  customerName: text("customer_name").notNull(),
  folderPath: text("folder_path").notNull(),
  fileName: text("file_name"),
  webUrl: text("web_url"),
  dept: text("dept"),
  userId: text("user_id").notNull(),
  userEmail: text("user_email").notNull(),
  userName: text("user_name").notNull(),
});

export type UploadHistoryRow = typeof uploadHistory.$inferSelect;
export type InsertUploadHistory = typeof uploadHistory.$inferInsert;

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const UPLOAD_JOB_STATUSES = [
  "staged",
  "uploading",
  "checkin_pending",
  "blocked",
  "done",
  "failed",
] as const;
export type UploadJobStatus = (typeof UPLOAD_JOB_STATUSES)[number];

/**
 * Server-side staging queue: photo bytes are held here until the worker confirms
 * SharePoint upload + check-in, then `bytes` is nulled. `id` is the client idempotency key.
 */
export const uploadJobs = pgTable(
  "imageflow_upload_jobs",
  {
    id: text("id").primaryKey(),
    status: text("status").$type<UploadJobStatus>().notNull().default("staged"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    bytes: bytea("bytes"),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    fileName: text("file_name").notNull(),
    dept: text("dept").notNull(),
    customerName: text("customer_name").notNull(),
    workOrderNumber: text("work_order_number").notNull(),
    partNumber: text("part_number").notNull().default(""),
    rev: text("rev").notNull().default(""),
    userId: text("user_id").notNull(),
    userEmail: text("user_email").notNull(),
    userName: text("user_name").notNull(),
    sharepointPath: text("sharepoint_path"),
    sharepointItemId: text("sharepoint_item_id"),
    webUrl: text("web_url"),
    clientInfo: jsonb("client_info"),
    receivedMs: integer("received_ms"),
    graphMs: integer("graph_ms"),
    graphTimings: jsonb("graph_timings"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("imageflow_upload_jobs_status_next_idx").on(t.status, t.nextAttemptAt),
    index("imageflow_upload_jobs_user_idx").on(t.userId),
  ],
);

export type UploadJobRow = typeof uploadJobs.$inferSelect;
