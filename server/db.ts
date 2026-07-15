/**
 * Optional Postgres pool for upload history.
 * Uses DATABASE_URL when set; otherwise history APIs return a clear error.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../shared/schema";

const { Pool } = pg;

let pool: pg.Pool | null = null;
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let ensured = false;

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function getDb() {
  if (!isDatabaseConfigured()) {
    throw new Error("DATABASE_URL is not set — upload history requires Postgres");
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL!.trim(),
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
      max: 5,
    });
    db = drizzle(pool, { schema });
  }
  return db!;
}

function getPool(): pg.Pool {
  getDb();
  return pool!;
}

export async function ensureUploadHistoryTable(): Promise<void> {
  if (!isDatabaseConfigured() || ensured) return;
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS upload_history (
        id text PRIMARY KEY,
        uploaded_at timestamptz NOT NULL DEFAULT now(),
        work_order_number text NOT NULL,
        part_number text NOT NULL DEFAULT '',
        rev text NOT NULL DEFAULT '',
        customer_name text NOT NULL,
        folder_path text NOT NULL,
        file_name text,
        web_url text,
        dept text,
        user_id text NOT NULL,
        user_email text NOT NULL,
        user_name text NOT NULL
      );
      CREATE INDEX IF NOT EXISTS upload_history_uploaded_at_idx ON upload_history (uploaded_at DESC);
      CREATE INDEX IF NOT EXISTS upload_history_user_id_idx ON upload_history (user_id);
    `);
    ensured = true;
  } finally {
    client.release();
  }
}
