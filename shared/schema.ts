import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp } from "drizzle-orm/pg-core";
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
export const uploadHistory = pgTable("upload_history", {
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
