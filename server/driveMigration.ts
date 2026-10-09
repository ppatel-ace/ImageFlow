/**
 * One-time admin migration: old ImageFlow photos in Google Drive → SharePoint.
 *
 * Scan (dry run) walks Drive read-only and plans every file into
 * imageflow_drive_migration_items. Start renames "&amp;" customer folders, then the
 * worker copies each file: skip if it already exists in SharePoint (checking it in if
 * needed), otherwise download → upload → strict check-in. Every step is idempotent, so
 * Pause/Resume, Retry failed and container restarts are safe.
 */
import { randomUUID } from "crypto";
import { getPool, isDatabaseConfigured } from "./db";
import {
  DriveApiError,
  FOLDER_MIME,
  downloadDriveFile,
  getDriveFolder,
  getDriveReaderStatus,
  listDriveChildren,
} from "./googleDriveReader";
import {
  DEPARTMENTS,
  classifyDriveFile,
  mapDrivePath,
  nameKey,
  planRenames,
  resolveCustomerFolder,
  uniqueFileName,
  type PlannedRename,
} from "./driveMigrationPlan";
import {
  SharePointCheckinError,
  checkInAnyCheckout,
  checkInFolderCheckouts,
  listSharePointSubfolders,
  lookupSharePointFile,
  renameSharePointFolder,
  uploadFileToSharePointFolder,
} from "./sharepoint";
import { classifyUploadError } from "./uploadErrors";

const CONCURRENCY = Math.min(Math.max(Number(process.env.IMAGEFLOW_MIGRATION_CONCURRENCY) || 4, 1), 12);
const MAX_ATTEMPTS = 8;
const BACKOFF_S = [30, 60, 120, 300, 600, 900];
const IDLE_POLL_MS = 15_000;

export type RunStatus = "scanning" | "scanned" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type ItemStatus = "pending" | "copying" | "done" | "exists" | "skipped" | "failed";

export type MigrationPlan = {
  rootName: string;
  totals: { files: number; photos: number; mapped: number; oldPhotos: number; skipped: number; bytes: number };
  byDept: Record<string, number>;
  customers: { drive: string; dept: string; target: string; existing: boolean; files: number }[];
  oldPhotoFolders: { path: string; files: number }[];
  skippedReasons: Record<string, number>;
  skippedTopLevel: string[];
  renames: PlannedRename[];
  renameConflicts: PlannedRename[];
  renameResults?: { from: string; to: string; dept: string; ok: boolean; error?: string }[];
  scanErrors: string[];
};

// ── Schema ───────────────────────────────────────────────────────────────────

let ensurePromise: Promise<void> | null = null;

export async function ensureMigrationTables(): Promise<void> {
  if (!isDatabaseConfigured()) return;
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const client = await getPool().connect();
      try {
        await client.query("SELECT pg_advisory_lock($1)", [874203153]);
        try {
          await client.query(`
            CREATE TABLE IF NOT EXISTS imageflow_drive_migration_runs (
              id text PRIMARY KEY,
              status text NOT NULL,
              root_folder_id text NOT NULL,
              root_folder_name text,
              skip_folders jsonb NOT NULL DEFAULT '[]'::jsonb,
              plan jsonb,
              error text,
              cleanup_checked_in integer NOT NULL DEFAULT 0,
              cleanup_failed integer NOT NULL DEFAULT 0,
              started_by text NOT NULL,
              created_at timestamptz NOT NULL DEFAULT now(),
              updated_at timestamptz NOT NULL DEFAULT now(),
              started_at timestamptz,
              completed_at timestamptz
            );
            CREATE TABLE IF NOT EXISTS imageflow_drive_migration_items (
              id bigserial PRIMARY KEY,
              run_id text NOT NULL REFERENCES imageflow_drive_migration_runs(id) ON DELETE CASCADE,
              drive_file_id text NOT NULL,
              drive_path text NOT NULL,
              mime_type text,
              size_bytes bigint,
              drive_modified_at timestamptz,
              kind text NOT NULL,
              dept text,
              customer text,
              target_folder text,
              file_name text,
              status text NOT NULL,
              attempts integer NOT NULL DEFAULT 0,
              next_attempt_at timestamptz NOT NULL DEFAULT now(),
              locked_until timestamptz,
              last_error text,
              sharepoint_item_id text,
              web_url text,
              created_at timestamptz NOT NULL DEFAULT now(),
              updated_at timestamptz NOT NULL DEFAULT now(),
              UNIQUE (run_id, drive_file_id)
            );
            CREATE INDEX IF NOT EXISTS imageflow_drive_migration_items_claim_idx
              ON imageflow_drive_migration_items (run_id, status, next_attempt_at);
          `);
        } finally {
          await client.query("SELECT pg_advisory_unlock($1)", [874203153]);
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

// ── Runs ─────────────────────────────────────────────────────────────────────

type RunRow = {
  id: string;
  status: RunStatus;
  root_folder_id: string;
  root_folder_name: string | null;
  skip_folders: string[];
  plan: MigrationPlan | null;
  error: string | null;
  cleanup_checked_in: number;
  cleanup_failed: number;
  started_by: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

async function latestRun(): Promise<RunRow | null> {
  const res = await getPool().query<RunRow>(
    `SELECT * FROM imageflow_drive_migration_runs ORDER BY created_at DESC LIMIT 1`,
  );
  return res.rows[0] ?? null;
}

async function setRun(id: string, fields: Partial<Record<keyof RunRow, unknown>>): Promise<void> {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  const values = keys.map((k) => {
    const v = (fields as Record<string, unknown>)[k];
    return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
  });
  await getPool().query(
    `UPDATE imageflow_drive_migration_runs SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`,
    [id, ...values],
  );
}

export class MigrationConflictError extends Error {}

export async function startScan(rootFolderId: string, skipFolders: string[], startedBy: string): Promise<string> {
  await ensureMigrationTables();
  const busy = await getPool().query(
    `SELECT id, status FROM imageflow_drive_migration_runs WHERE status IN ('scanning','running') LIMIT 1`,
  );
  if (busy.rows[0]) {
    throw new MigrationConflictError(`A migration is already ${busy.rows[0].status}. Pause it before scanning again.`);
  }
  await getPool().query(
    `UPDATE imageflow_drive_migration_runs SET status = 'cancelled', updated_at = now() WHERE status IN ('scanned','paused')`,
  );
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO imageflow_drive_migration_runs (id, status, root_folder_id, skip_folders, started_by)
     VALUES ($1, 'scanning', $2, $3::jsonb, $4)`,
    [id, rootFolderId, JSON.stringify(skipFolders), startedBy],
  );
  void runScan(id, rootFolderId, skipFolders).catch(async (err) => {
    console.error("[migration] scan failed:", err);
    await setRun(id, { status: "failed", error: String((err as Error)?.message ?? err).slice(0, 500) }).catch(() => {});
  });
  return id;
}

type PlannedItem = {
  driveFileId: string;
  drivePath: string;
  mimeType: string;
  size: number | null;
  modified: string | null;
  kind: "mapped" | "old_photos" | "not_photo";
  dept: string | null;
  customer: string | null;
  targetFolder: string | null;
  fileName: string | null;
  status: ItemStatus;
  lastError: string | null;
};

async function insertItems(runId: string, rows: PlannedItem[]): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const tuples = rows.map((r, i) => {
    const b = i * 13;
    values.push(
      runId, r.driveFileId, r.drivePath, r.mimeType, r.size, r.modified, r.kind,
      r.dept, r.customer, r.targetFolder, r.fileName, r.status, r.lastError,
    );
    return `(${Array.from({ length: 13 }, (_, j) => `$${b + j + 1}`).join(",")})`;
  });
  await getPool().query(
    `INSERT INTO imageflow_drive_migration_items
       (run_id, drive_file_id, drive_path, mime_type, size_bytes, drive_modified_at, kind,
        dept, customer, target_folder, file_name, status, last_error)
     VALUES ${tuples.join(",")}
     ON CONFLICT (run_id, drive_file_id) DO NOTHING`,
    values,
  );
}

async function runScan(runId: string, rootFolderId: string, skipFolders: string[]): Promise<void> {
  const root = await getDriveFolder(rootFolderId);
  await setRun(runId, { root_folder_name: root.name });

  const existingByDept: Record<string, string[]> = {};
  for (const dept of DEPARTMENTS) existingByDept[dept] = await listSharePointSubfolders(dept);
  const { renames, conflicts } = planRenames(existingByDept);
  const afterRename: Record<string, string[]> = {};
  for (const dept of DEPARTMENTS) {
    afterRename[dept] = existingByDept[dept].map(
      (n) => renames.find((r) => r.dept === dept && r.from === n)?.to ?? n,
    );
  }

  const skipKeys = new Set(skipFolders.map(nameKey).filter(Boolean));
  const plan: MigrationPlan = {
    rootName: root.name,
    totals: { files: 0, photos: 0, mapped: 0, oldPhotos: 0, skipped: 0, bytes: 0 },
    byDept: {},
    customers: [],
    oldPhotoFolders: [],
    skippedReasons: {},
    skippedTopLevel: [],
    renames,
    renameConflicts: conflicts,
    scanErrors: [],
  };
  const customers = new Map<string, MigrationPlan["customers"][number]>();
  const oldFolders = new Map<string, number>();
  const takenNames = new Set<string>();
  let pending: PlannedItem[] = [];

  const queue: { id: string; folders: string[] }[] = [{ id: root.id, folders: [] }];
  const walkOne = async (node: { id: string; folders: string[] }) => {
    let children;
    try {
      children = await listDriveChildren(node.id);
    } catch (err) {
      if (plan.scanErrors.length < 50) plan.scanErrors.push(`${node.folders.join("/") || root.name}: ${(err as Error).message}`);
      return;
    }
    for (const child of children) {
      if (child.mimeType === FOLDER_MIME) {
        if (node.folders.length === 0 && skipKeys.has(nameKey(child.name))) {
          plan.skippedTopLevel.push(child.name);
          continue;
        }
        queue.push({ id: child.id, folders: [...node.folders, child.name] });
        continue;
      }
      plan.totals.files++;
      const drivePath = [...node.folders, child.name].join("/");
      const cls = classifyDriveFile(child.name, child.mimeType);
      const base = {
        driveFileId: child.id,
        drivePath,
        mimeType: child.mimeType,
        size: child.size,
        modified: child.modifiedTime,
      };
      if (!cls.copy) {
        plan.totals.skipped++;
        plan.skippedReasons[cls.reason] = (plan.skippedReasons[cls.reason] ?? 0) + 1;
        pending.push({ ...base, kind: "not_photo", dept: null, customer: null, targetFolder: null, fileName: null, status: "skipped", lastError: cls.reason });
        continue;
      }
      plan.totals.photos++;
      plan.totals.bytes += child.size ?? 0;
      const target = mapDrivePath(node.folders);
      if (target.kind === "mapped") {
        const resolved = resolveCustomerFolder(target.driveCustomer, afterRename[target.dept]);
        const folder = `${target.dept}/${resolved.name}/${target.workOrder}`;
        const fileName = uniqueFileName(folder, child.name, takenNames);
        plan.totals.mapped++;
        plan.byDept[target.dept] = (plan.byDept[target.dept] ?? 0) + 1;
        const ck = `${target.dept}|${resolved.name}`;
        const entry = customers.get(ck) ?? { drive: target.driveCustomer, dept: target.dept, target: resolved.name, existing: resolved.existing, files: 0 };
        entry.files++;
        customers.set(ck, entry);
        pending.push({ ...base, kind: "mapped", dept: target.dept, customer: resolved.name, targetFolder: folder, fileName, status: "pending", lastError: null });
      } else {
        const fileName = uniqueFileName(target.folder, child.name, takenNames);
        plan.totals.oldPhotos++;
        const group = target.folder.split("/").slice(0, 3).join("/");
        oldFolders.set(group, (oldFolders.get(group) ?? 0) + 1);
        pending.push({ ...base, kind: "old_photos", dept: null, customer: null, targetFolder: target.folder, fileName, status: "pending", lastError: null });
      }
    }
    if (pending.length >= 500) {
      const batch = pending;
      pending = [];
      await insertItems(runId, batch);
    }
  };

  let lastBeat = Date.now();
  while (queue.length > 0) {
    const batch = queue.splice(0, 4);
    await Promise.all(batch.map(walkOne));
    if (Date.now() - lastBeat > 30_000) {
      lastBeat = Date.now();
      await getPool().query(`UPDATE imageflow_drive_migration_runs SET updated_at = now() WHERE id = $1`, [runId]);
    }
  }
  await insertItems(runId, pending);

  plan.customers = Array.from(customers.values()).sort((a, b) => a.target.localeCompare(b.target) || a.dept.localeCompare(b.dept));
  plan.oldPhotoFolders = Array.from(oldFolders.entries())
    .map(([path, files]) => ({ path, files }))
    .sort((a, b) => a.path.localeCompare(b.path));
  await setRun(runId, { status: "scanned", plan });
  console.log(`[migration] scan ${runId} done: ${plan.totals.photos} photos (${plan.totals.mapped} mapped, ${plan.totals.oldPhotos} → Old Photos), ${plan.totals.skipped} skipped`);
}

export async function startOrResume(): Promise<RunRow> {
  await ensureMigrationTables();
  const run = await latestRun();
  if (!run || !["scanned", "paused", "completed"].includes(run.status)) {
    throw new MigrationConflictError(run ? `Cannot start a run that is ${run.status}.` : "Scan Google Drive first.");
  }
  if (run.status === "scanned" && run.plan && !run.plan.renameResults) {
    const results: NonNullable<MigrationPlan["renameResults"]> = [];
    for (const r of run.plan.renames) {
      try {
        await renameSharePointFolder(`${r.dept}/${r.from}`, r.to);
        results.push({ ...r, ok: true });
      } catch (err) {
        results.push({ ...r, ok: false, error: (err as Error).message.slice(0, 200) });
      }
    }
    await setRun(run.id, { plan: { ...run.plan, renameResults: results } });
  }
  await setRun(run.id, { status: "running", started_at: run.started_at ?? new Date().toISOString(), completed_at: null });
  kickMigrationWorker();
  return (await latestRun())!;
}

export async function pauseRun(): Promise<void> {
  await ensureMigrationTables();
  await getPool().query(
    `UPDATE imageflow_drive_migration_runs SET status = 'paused', updated_at = now() WHERE status = 'running'`,
  );
}

export async function retryFailed(): Promise<number> {
  await ensureMigrationTables();
  const run = await latestRun();
  if (!run) return 0;
  const res = await getPool().query(
    `UPDATE imageflow_drive_migration_items
        SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL, updated_at = now()
      WHERE run_id = $1 AND status = 'failed'`,
    [run.id],
  );
  if (run.status === "completed" && (res.rowCount ?? 0) > 0) {
    await setRun(run.id, { status: "running", completed_at: null });
    kickMigrationWorker();
  }
  return res.rowCount ?? 0;
}

// ── Worker ───────────────────────────────────────────────────────────────────

type ItemRow = {
  id: string;
  run_id: string;
  drive_file_id: string;
  drive_path: string;
  target_folder: string;
  file_name: string;
  attempts: number;
  sharepoint_item_id: string | null;
};

let workerActive = false;
const sweptFolders = new Set<string>();

export function kickMigrationWorker(): void {
  if (workerActive || !isDatabaseConfigured()) return;
  workerActive = true;
  void workerLoop()
    .catch((err) => console.error("[migration] worker crashed:", err))
    .finally(() => {
      workerActive = false;
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function workerLoop(): Promise<void> {
  for (;;) {
    const run = (
      await getPool().query<RunRow>(
        `SELECT * FROM imageflow_drive_migration_runs WHERE status = 'running' ORDER BY created_at DESC LIMIT 1`,
      )
    ).rows[0];
    if (!run) return;

    const claimed = await getPool().query<ItemRow>(
      `UPDATE imageflow_drive_migration_items
          SET status = 'copying', attempts = attempts + 1,
              locked_until = now() + interval '10 minutes', updated_at = now()
        WHERE id IN (
          SELECT id FROM imageflow_drive_migration_items
           WHERE run_id = $1
             AND ((status = 'pending' AND next_attempt_at <= now())
               OR (status = 'copying' AND locked_until < now()))
           ORDER BY id
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
        RETURNING id, run_id, drive_file_id, drive_path, target_folder, file_name, attempts, sharepoint_item_id`,
      [run.id, CONCURRENCY],
    );

    if (claimed.rows.length === 0) {
      const left = await getPool().query(
        `SELECT count(*)::int AS n FROM imageflow_drive_migration_items WHERE run_id = $1 AND status IN ('pending','copying')`,
        [run.id],
      );
      if (left.rows[0].n === 0) {
        await getPool().query(
          `UPDATE imageflow_drive_migration_runs SET status = 'completed', completed_at = now(), updated_at = now()
            WHERE id = $1 AND status = 'running'`,
          [run.id],
        );
        console.log(`[migration] run ${run.id} completed`);
        return;
      }
      await sleep(IDLE_POLL_MS);
      continue;
    }

    await Promise.all(claimed.rows.map((item) => processItem(item)));
  }
}

async function finishItem(id: string, status: ItemStatus, itemId: string | null, webUrl: string | null, note: string | null = null) {
  await getPool().query(
    `UPDATE imageflow_drive_migration_items
        SET status = $2, sharepoint_item_id = COALESCE($3, sharepoint_item_id), web_url = COALESCE($4, web_url),
            last_error = $5, locked_until = NULL, updated_at = now()
      WHERE id = $1`,
    [id, status, itemId, webUrl, note],
  );
}

async function sweepFolderOnce(runId: string, folder: string): Promise<void> {
  const key = `${runId}|${folder}`;
  if (sweptFolders.has(key)) return;
  sweptFolders.add(key);
  try {
    const result = await checkInFolderCheckouts(folder);
    if (result.checkedIn || result.failed) {
      await getPool().query(
        `UPDATE imageflow_drive_migration_runs
            SET cleanup_checked_in = cleanup_checked_in + $2, cleanup_failed = cleanup_failed + $3, updated_at = now()
          WHERE id = $1`,
        [runId, result.checkedIn, result.failed],
      );
      if (result.errors.length) console.warn(`[migration] cleanup in ${folder}:`, result.errors);
    }
  } catch (err) {
    sweptFolders.delete(key);
    console.warn(`[migration] cleanup sweep of ${folder} failed:`, (err as Error).message);
  }
}

type FailureKind = "transient" | "blocked" | "permanent";

function classifyMigrationError(err: unknown): FailureKind {
  if (err instanceof DriveApiError) {
    if (/token request failed/i.test(err.message)) return "blocked";
    if (err.status === 404) return "permanent";
    if (err.status === 403) return /rateLimit/i.test(err.message) ? "transient" : "permanent";
    if (err.status === 400) return "permanent";
    return "transient";
  }
  const kind = classifyUploadError(err);
  return kind === "checkin" ? "transient" : kind;
}

async function processItem(item: ItemRow): Promise<void> {
  const target = `${item.target_folder}/${item.file_name}`;
  try {
    await sweepFolderOnce(item.run_id, item.target_folder);
    const existing = await lookupSharePointFile(target);
    if (existing) {
      let webUrl = existing.webUrl ?? null;
      if (existing.checkedOut) {
        webUrl = (await checkInAnyCheckout(existing.id, `ImageFlow migration: ${item.file_name}`)).webUrl ?? webUrl;
      }
      await finishItem(item.id, item.sharepoint_item_id ? "done" : "exists", existing.id, webUrl);
      return;
    }
    const bytes = await downloadDriveFile(item.drive_file_id);
    const uploaded = await uploadFileToSharePointFolder(item.target_folder, item.file_name, bytes);
    await finishItem(item.id, "done", uploaded.itemId, uploaded.webUrl ?? null);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    if (err instanceof SharePointCheckinError) {
      await getPool().query(
        `UPDATE imageflow_drive_migration_items
            SET status = 'pending', sharepoint_item_id = $2, next_attempt_at = now() + interval '120 seconds',
                last_error = $3, locked_until = NULL, updated_at = now()
          WHERE id = $1`,
        [item.id, err.itemId, `Uploaded, check-in pending: ${message}`],
      );
      return;
    }
    const kind = classifyMigrationError(err);
    if (kind === "permanent" || item.attempts >= MAX_ATTEMPTS) {
      await finishItem(item.id, "failed", null, null, message);
      return;
    }
    const delay = kind === "blocked" ? 300 : BACKOFF_S[Math.min(item.attempts - 1, BACKOFF_S.length - 1)];
    await getPool().query(
      `UPDATE imageflow_drive_migration_items
          SET status = 'pending', attempts = attempts - $4, next_attempt_at = now() + ($2 || ' seconds')::interval,
              last_error = $3, locked_until = NULL, updated_at = now()
        WHERE id = $1`,
      [item.id, String(delay), message, kind === "blocked" ? 1 : 0],
    );
  }
}

/** Boot: a scan cannot survive a restart; a running copy resumes. */
export async function startDriveMigrationWorker(): Promise<void> {
  if (!isDatabaseConfigured()) return;
  try {
    await ensureMigrationTables();
    await getPool().query(
      `UPDATE imageflow_drive_migration_runs
          SET status = 'failed', error = 'Scan interrupted by a restart — scan again.', updated_at = now()
        WHERE status = 'scanning' AND updated_at < now() - interval '2 minutes'`,
    );
    kickMigrationWorker();
  } catch (err) {
    console.error("[migration] startup failed:", err);
  }
}

// ── Read APIs ────────────────────────────────────────────────────────────────

export async function getMigrationOverview() {
  const drive = getDriveReaderStatus();
  const base = {
    drive,
    defaultRootFolderId: process.env.GDRIVE_MIGRATION_ROOT_ID?.trim() || null,
    workerActive,
    concurrency: CONCURRENCY,
  };
  if (!isDatabaseConfigured()) return { ...base, databaseConfigured: false, run: null };
  await ensureMigrationTables();
  const run = await latestRun();
  if (!run) return { ...base, databaseConfigured: true, run: null };
  const counts = await getPool().query<{ status: string; n: number; bytes: string | null }>(
    `SELECT status, count(*)::int AS n, sum(size_bytes)::text AS bytes
       FROM imageflow_drive_migration_items WHERE run_id = $1 GROUP BY status`,
    [run.id],
  );
  const byStatus: Record<string, number> = {};
  let bytesCopied = 0;
  for (const row of counts.rows) {
    byStatus[row.status] = row.n;
    if (row.status === "done") bytesCopied = Number(row.bytes ?? 0);
  }
  return { ...base, databaseConfigured: true, run: { ...run, counts: byStatus, bytesCopied } };
}

const SORTS: Record<string, string> = {
  drive_path: "drive_path",
  target: "target_folder",
  status: "status",
  size: "size_bytes",
  attempts: "attempts",
  updated: "updated_at",
};

export async function listMigrationItems(opts: {
  status?: string;
  kind?: string;
  q?: string;
  sort?: string;
  dir?: string;
  page?: number;
  pageSize?: number;
}) {
  await ensureMigrationTables();
  const run = await latestRun();
  if (!run) return { items: [], total: 0, page: 1, pageSize: 50 };
  const where = ["run_id = $1"];
  const params: unknown[] = [run.id];
  if (opts.status && /^[a-z_]+$/.test(opts.status)) {
    params.push(opts.status);
    where.push(`status = $${params.length}`);
  }
  if (opts.kind && /^[a-z_]+$/.test(opts.kind)) {
    params.push(opts.kind);
    where.push(`kind = $${params.length}`);
  }
  if (opts.q?.trim()) {
    params.push(`%${opts.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const p = `$${params.length}`;
    where.push(`(drive_path ILIKE ${p} OR target_folder ILIKE ${p} OR file_name ILIKE ${p} OR last_error ILIKE ${p})`);
  }
  const sortCol = SORTS[opts.sort ?? ""] ?? "id";
  const dir = opts.dir === "desc" ? "DESC" : "ASC";
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 10), 200);
  const page = Math.max(opts.page ?? 1, 1);
  const whereSql = where.join(" AND ");
  const total = await getPool().query(`SELECT count(*)::int AS n FROM imageflow_drive_migration_items WHERE ${whereSql}`, params);
  const rows = await getPool().query(
    `SELECT id, drive_path, kind, target_folder, file_name, status, attempts, last_error, size_bytes, web_url, updated_at
       FROM imageflow_drive_migration_items
      WHERE ${whereSql}
      ORDER BY ${sortCol} ${dir} NULLS LAST, id ASC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params,
  );
  return { items: rows.rows, total: total.rows[0].n as number, page, pageSize };
}
