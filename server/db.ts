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
let ensurePromise: Promise<void> | null = null;

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

async function tableExists(client: pg.PoolClient, tableName: string): Promise<boolean> {
  const res = await client.query(
    `SELECT 1
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
      LIMIT 1`,
    [tableName],
  );
  return res.rowCount !== null && res.rowCount > 0;
}

/**
 * Create imageflow_upload_history safely on a shared Postgres.
 * Avoids races that hit pg_type_typname_nsp_index when two CREATE TABLEs race,
 * and avoids colliding with other apps' upload_history types/tables.
 */
export async function ensureUploadHistoryTable(): Promise<void> {
  if (!isDatabaseConfigured()) return;
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const client = await getPool().connect();
      try {
        // Serialize DDL across containers/processes on this DB
        await client.query("SELECT pg_advisory_lock($1)", [874203151]);
        try {
          if (await tableExists(client, "imageflow_upload_history")) {
            return;
          }

          try {
            await client.query(`
              CREATE TABLE imageflow_upload_history (
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
              )
            `);
          } catch (err: any) {
            // Concurrent create can raise 23505 on pg_type; OK if table exists afterward
            const code = err?.code;
            const msg = String(err?.message || "");
            if (
              code === "23505" ||
              msg.includes("pg_type_typname_nsp_index") ||
              msg.includes("already exists")
            ) {
              if (await tableExists(client, "imageflow_upload_history")) {
                return;
              }
            }
            throw err;
          }

          await client.query(`
            CREATE INDEX IF NOT EXISTS imageflow_upload_history_uploaded_at_idx
              ON imageflow_upload_history (uploaded_at DESC);
            CREATE INDEX IF NOT EXISTS imageflow_upload_history_user_id_idx
              ON imageflow_upload_history (user_id);
          `);
        } finally {
          await client.query("SELECT pg_advisory_unlock($1)", [874203151]);
        }
      } finally {
        client.release();
      }
    })().catch((err) => {
      ensurePromise = null;
      throw err;
    });
  }
  await ensurePromise;
}
