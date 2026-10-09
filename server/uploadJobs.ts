/**
 * Data access for imageflow_upload_jobs (server staging queue).
 * Raw SQL via the shared pg pool so the worker can use FOR UPDATE SKIP LOCKED.
 */
import { createHash } from "crypto";
import type { UploadJobStatus } from "../shared/schema";
import { ensureUploadJobsTable, getPool } from "./db";

/** Transient retries back off to 5 min, so 30 attempts ≈ 2 h before a job is marked failed. */
export const MAX_JOB_ATTEMPTS = 30;
/** Renewed every minute by the worker heartbeat; only a crashed worker lets it lapse. */
export const JOB_LEASE_SECONDS = 5 * 60;
export const CHECKIN_RETRY_SECONDS = 2 * 60;
const DONE_RETENTION_DAYS = 30;

export type NewUploadJob = {
  id: string;
  bytes: Buffer;
  contentType: string;
  fileName: string;
  dept: string;
  customerName: string;
  workOrderNumber: string;
  partNumber: string;
  rev: string;
  userId: string;
  userEmail: string;
  userName: string;
  clientInfo: Record<string, unknown> | null;
  receivedMs: number;
};

export type UploadJobStatusDto = {
  id: string;
  status: UploadJobStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  sharepointPath: string | null;
  webUrl: string | null;
  updatedAt: string;
};

export type ClaimedUploadJob = {
  id: string;
  attempts: number;
  bytes: Buffer;
  fileName: string;
  dept: string;
  customerName: string;
  workOrderNumber: string;
  partNumber: string;
  rev: string;
  userId: string;
  userEmail: string;
  userName: string;
  createdAt: Date;
};

function toStatusDto(row: any): UploadJobStatusDto {
  return {
    id: row.id,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error ?? null,
    nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at).toISOString() : null,
    sharepointPath: row.sharepoint_path ?? null,
    webUrl: row.web_url ?? null,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const STATUS_COLUMNS =
  "id, status, attempts, last_error, next_attempt_at, sharepoint_path, web_url, updated_at, user_id";

/**
 * Idempotent insert keyed by the client job id. Returns the existing row when the
 * same id was already staged (e.g. client retried after a lost 202 response).
 */
export async function stageUploadJob(
  job: NewUploadJob,
): Promise<{ created: boolean; row: UploadJobStatusDto; ownerId: string }> {
  await ensureUploadJobsTable();
  const sha256 = createHash("sha256").update(job.bytes).digest("hex");
  const pool = getPool();
  const inserted = await pool.query(
    `INSERT INTO imageflow_upload_jobs (
       id, status, bytes, content_type, size_bytes, sha256, file_name, dept,
       customer_name, work_order_number, part_number, rev,
       user_id, user_email, user_name, client_info, received_ms
     ) VALUES ($1, 'staged', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (id) DO NOTHING
     RETURNING ${STATUS_COLUMNS}`,
    [
      job.id,
      job.bytes,
      job.contentType,
      job.bytes.length,
      sha256,
      job.fileName,
      job.dept,
      job.customerName,
      job.workOrderNumber,
      job.partNumber,
      job.rev,
      job.userId,
      job.userEmail,
      job.userName,
      job.clientInfo ? JSON.stringify(job.clientInfo) : null,
      job.receivedMs,
    ],
  );
  if (inserted.rows[0]) {
    return { created: true, row: toStatusDto(inserted.rows[0]), ownerId: job.userId };
  }
  const existing = await pool.query(
    `SELECT ${STATUS_COLUMNS} FROM imageflow_upload_jobs WHERE id = $1`,
    [job.id],
  );
  const row = existing.rows[0];
  return { created: false, row: toStatusDto(row), ownerId: row.user_id };
}

export async function getUploadJobStatuses(
  userId: string,
  ids: string[],
): Promise<UploadJobStatusDto[]> {
  if (ids.length === 0) return [];
  await ensureUploadJobsTable();
  const res = await getPool().query(
    `SELECT ${STATUS_COLUMNS} FROM imageflow_upload_jobs
      WHERE user_id = $1 AND id = ANY($2::text[])`,
    [userId, ids],
  );
  return res.rows.map(toStatusDto);
}

/** Re-arm a failed (or waiting) job for immediate retry. Scoped to the owner. */
export async function retryUploadJob(
  userId: string,
  id: string,
): Promise<UploadJobStatusDto | null> {
  await ensureUploadJobsTable();
  const res = await getPool().query(
    `UPDATE imageflow_upload_jobs
        SET status = CASE WHEN status = 'checkin_pending' THEN 'checkin_pending' ELSE 'staged' END,
            attempts = 0, next_attempt_at = now(), locked_until = NULL, updated_at = now()
      WHERE id = $1 AND user_id = $2
        AND status IN ('failed', 'staged', 'blocked', 'checkin_pending')
        AND bytes IS NOT NULL
      RETURNING ${STATUS_COLUMNS}`,
    [id, userId],
  );
  return res.rows[0] ? toStatusDto(res.rows[0]) : null;
}

/** Keep the lease alive while a slow upload is still running so no other worker re-claims it. */
export async function extendUploadJobLease(id: string): Promise<void> {
  await getPool().query(
    `UPDATE imageflow_upload_jobs
        SET locked_until = now() + ($2 || ' seconds')::interval
      WHERE id = $1 AND status IN ('uploading', 'checkin_pending')`,
    [id, String(JOB_LEASE_SECONDS)],
  );
}

/** Claim the next due job (or one whose lease expired after a crash/restart). */
export async function claimNextUploadJob(): Promise<ClaimedUploadJob | null> {
  await ensureUploadJobsTable();
  const res = await getPool().query(
    `UPDATE imageflow_upload_jobs
        SET status = 'uploading',
            attempts = attempts + 1,
            locked_until = now() + ($1 || ' seconds')::interval,
            updated_at = now()
      WHERE id = (
        SELECT id FROM imageflow_upload_jobs
         WHERE bytes IS NOT NULL
           AND ((status = 'staged' AND next_attempt_at <= now())
             OR (status = 'uploading' AND locked_until < now()))
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, attempts, bytes, file_name, dept, customer_name, work_order_number,
                part_number, rev, user_id, user_email, user_name, created_at`,
    [String(JOB_LEASE_SECONDS)],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    attempts: row.attempts,
    bytes: row.bytes,
    fileName: row.file_name,
    dept: row.dept,
    customerName: row.customer_name,
    workOrderNumber: row.work_order_number,
    partNumber: row.part_number,
    rev: row.rev,
    userId: row.user_id,
    userEmail: row.user_email,
    userName: row.user_name,
    createdAt: new Date(row.created_at),
  };
}

export type ClaimedCheckinJob = {
  id: string;
  sharepointPath: string;
  sharepointItemId: string | null;
  workOrderNumber: string;
  partNumber: string;
  rev: string;
  customerName: string;
  fileName: string;
  dept: string;
  userId: string;
  userEmail: string;
  userName: string;
  createdAt: Date;
};

/** Claim a job whose file is in SharePoint but still needs a successful check-in. */
export async function claimNextCheckinJob(): Promise<ClaimedCheckinJob | null> {
  await ensureUploadJobsTable();
  const res = await getPool().query(
    `UPDATE imageflow_upload_jobs
        SET locked_until = now() + ($1 || ' seconds')::interval, updated_at = now()
      WHERE id = (
        SELECT id FROM imageflow_upload_jobs
         WHERE status = 'checkin_pending'
           AND next_attempt_at <= now()
           AND (locked_until IS NULL OR locked_until < now())
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, sharepoint_path, sharepoint_item_id, work_order_number, part_number, rev,
                customer_name, file_name, dept, user_id, user_email, user_name, created_at`,
    [String(JOB_LEASE_SECONDS)],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    sharepointPath: row.sharepoint_path,
    sharepointItemId: row.sharepoint_item_id ?? null,
    workOrderNumber: row.work_order_number,
    partNumber: row.part_number,
    rev: row.rev,
    customerName: row.customer_name,
    fileName: row.file_name,
    dept: row.dept,
    userId: row.user_id,
    userEmail: row.user_email,
    userName: row.user_name,
    createdAt: new Date(row.created_at),
  };
}

export async function markUploadJobDone(
  id: string,
  result: {
    sharepointPath: string;
    sharepointItemId: string | null;
    webUrl: string | null;
    graphMs?: number;
    graphTimings?: Record<string, unknown>;
  },
): Promise<void> {
  await getPool().query(
    `UPDATE imageflow_upload_jobs
        SET status = 'done', bytes = NULL, locked_until = NULL, last_error = NULL,
            sharepoint_path = $2, sharepoint_item_id = $3, web_url = coalesce($4, web_url),
            graph_ms = coalesce($5, graph_ms), graph_timings = coalesce($6, graph_timings),
            completed_at = now(), updated_at = now()
      WHERE id = $1`,
    [
      id,
      result.sharepointPath,
      result.sharepointItemId,
      result.webUrl,
      result.graphMs ?? null,
      result.graphTimings ? JSON.stringify(result.graphTimings) : null,
    ],
  );
}

/** Content is in SharePoint but check-in did not stick — the repair sweeper retries it. */
export async function markUploadJobCheckinPending(
  id: string,
  info: { sharepointPath: string; sharepointItemId: string; webUrl: string | null; error: string },
): Promise<void> {
  await getPool().query(
    `UPDATE imageflow_upload_jobs
        SET status = 'checkin_pending', locked_until = NULL, last_error = $5,
            sharepoint_path = $2, sharepoint_item_id = $3, web_url = $4,
            next_attempt_at = now() + ($6 || ' seconds')::interval, updated_at = now()
      WHERE id = $1`,
    [id, info.sharepointPath, info.sharepointItemId, info.webUrl, info.error.slice(0, 1000), String(CHECKIN_RETRY_SECONDS)],
  );
}

export async function rescheduleCheckin(id: string, error: string): Promise<void> {
  await getPool().query(
    `UPDATE imageflow_upload_jobs
        SET locked_until = NULL, last_error = $2,
            next_attempt_at = now() + ($3 || ' seconds')::interval, updated_at = now()
      WHERE id = $1 AND status = 'checkin_pending'`,
    [id, error.slice(0, 1000), String(CHECKIN_RETRY_SECONDS)],
  );
}

/**
 * Configuration / permission failure: park the job without burning an attempt.
 * The worker releases every blocked job once a SharePoint probe passes again.
 */
export async function markUploadJobBlocked(id: string, error: string): Promise<void> {
  await getPool().query(
    `UPDATE imageflow_upload_jobs
        SET status = 'blocked', attempts = greatest(attempts - 1, 0), locked_until = NULL,
            last_error = $2, updated_at = now()
      WHERE id = $1`,
    [id, error.slice(0, 1000)],
  );
}

export async function countBlockedJobs(): Promise<number> {
  await ensureUploadJobsTable();
  const res = await getPool().query(
    `SELECT count(*)::int AS n FROM imageflow_upload_jobs WHERE status = 'blocked'`,
  );
  return res.rows[0]?.n ?? 0;
}

export async function releaseBlockedJobs(): Promise<number> {
  const res = await getPool().query(
    `UPDATE imageflow_upload_jobs
        SET status = 'staged', next_attempt_at = now(), updated_at = now()
      WHERE status = 'blocked' AND bytes IS NOT NULL`,
  );
  return res.rowCount ?? 0;
}

/** Transient backoff: 15s, 30s, 1m, 2m, then every 5 min. */
export function backoffSeconds(attempts: number): number {
  const schedule = [15, 30, 60, 120];
  return schedule[attempts - 1] ?? 300;
}

export async function markUploadJobFailed(
  id: string,
  attempts: number,
  error: string,
  options: { permanent?: boolean } = {},
): Promise<{ permanent: boolean }> {
  const permanent = options.permanent === true || attempts >= MAX_JOB_ATTEMPTS;
  await getPool().query(
    `UPDATE imageflow_upload_jobs
        SET status = $2, last_error = $3, locked_until = NULL,
            next_attempt_at = now() + ($4 || ' seconds')::interval,
            updated_at = now()
      WHERE id = $1`,
    [id, permanent ? "failed" : "staged", error.slice(0, 1000), String(backoffSeconds(attempts))],
  );
  return { permanent };
}

export async function purgeOldUploadJobs(): Promise<number> {
  await ensureUploadJobsTable();
  const res = await getPool().query(
    `DELETE FROM imageflow_upload_jobs
      WHERE status = 'done' AND completed_at < now() - ($1 || ' days')::interval`,
    [String(DONE_RETENTION_DAYS)],
  );
  return res.rowCount ?? 0;
}

export type UploadQueueHealth = {
  pending: number;
  oldestPendingSec: number | null;
  blocked: number;
  checkinPending: number;
  oldestCheckinPendingSec: number | null;
  failedLast24h: number;
  latestBlockedError: string | null;
  latestCheckinError: string | null;
};

/** Live queue picture used by the monitor, /health and alerts. */
export async function getUploadQueueHealth(): Promise<UploadQueueHealth> {
  await ensureUploadJobsTable();
  const res = await getPool().query(
    `SELECT
       count(*) FILTER (WHERE status IN ('staged', 'uploading'))::int AS pending,
       extract(epoch FROM now() - min(created_at) FILTER (WHERE status IN ('staged', 'uploading', 'blocked')))::int AS oldest_pending,
       count(*) FILTER (WHERE status = 'blocked')::int AS blocked,
       count(*) FILTER (WHERE status = 'checkin_pending')::int AS checkin_pending,
       extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'checkin_pending'))::int AS oldest_checkin,
       count(*) FILTER (WHERE status = 'failed' AND updated_at > now() - interval '24 hours')::int AS failed_24h,
       (SELECT left(last_error, 300) FROM imageflow_upload_jobs WHERE status = 'blocked' ORDER BY updated_at DESC LIMIT 1) AS blocked_error,
       (SELECT left(last_error, 300) FROM imageflow_upload_jobs WHERE status = 'checkin_pending' ORDER BY updated_at DESC LIMIT 1) AS checkin_error
     FROM imageflow_upload_jobs
     WHERE status <> 'done'`,
  );
  const r = res.rows[0] ?? {};
  return {
    pending: r.pending ?? 0,
    oldestPendingSec: r.oldest_pending ?? null,
    blocked: r.blocked ?? 0,
    checkinPending: r.checkin_pending ?? 0,
    oldestCheckinPendingSec: r.oldest_checkin ?? null,
    failedLast24h: r.failed_24h ?? 0,
    latestBlockedError: r.blocked_error ?? null,
    latestCheckinError: r.checkin_error ?? null,
  };
}

/** SharePoint paths uploaded recently (queue + legacy history) for the nightly check-in sweep. */
export async function listRecentUploadPaths(days = 14): Promise<string[]> {
  await ensureUploadJobsTable();
  const pool = getPool();
  const paths = new Set<string>();
  const jobs = await pool.query(
    `SELECT sharepoint_path FROM imageflow_upload_jobs
      WHERE sharepoint_path IS NOT NULL AND created_at > now() - ($1 || ' days')::interval`,
    [String(days)],
  );
  for (const r of jobs.rows) paths.add(r.sharepoint_path);
  try {
    const hist = await pool.query(
      `SELECT folder_path, file_name FROM imageflow_upload_history
        WHERE file_name IS NOT NULL AND uploaded_at > now() - ($1 || ' days')::interval`,
      [String(days)],
    );
    for (const r of hist.rows) paths.add(`${r.folder_path}/${r.file_name}`);
  } catch {
    /* history table not created yet */
  }
  return Array.from(paths);
}

export type UploadStats = {
  windowDays: number;
  counts: Record<string, number>;
  current: UploadQueueHealth;
  backlogBytes: number;
  receivedMs: { p50: number | null; p95: number | null };
  graphMs: { p50: number | null; p95: number | null };
  endToEndMs: { p50: number | null; p95: number | null };
  byDevice: { device: string; jobs: number; failed: number; p95ReceivedMs: number | null }[];
  topErrors: { error: string; jobs: number }[];
};

export async function getUploadStats(windowDays = 7): Promise<UploadStats> {
  await ensureUploadJobsTable();
  const pool = getPool();
  const interval = String(windowDays);

  const [current, counts, backlog, timings, devices, errors] = await Promise.all([
    getUploadQueueHealth(),
    pool.query(
      `SELECT status, count(*)::int AS n FROM imageflow_upload_jobs
        WHERE created_at > now() - ($1 || ' days')::interval GROUP BY status`,
      [interval],
    ),
    pool.query(
      `SELECT coalesce(sum(size_bytes), 0)::bigint AS b FROM imageflow_upload_jobs
        WHERE bytes IS NOT NULL`,
    ),
    pool.query(
      `SELECT
         percentile_cont(0.5) WITHIN GROUP (ORDER BY received_ms) AS rec_p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY received_ms) AS rec_p95,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY graph_ms) AS graph_p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY graph_ms) AS graph_p95,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - created_at) * 1000) AS e2e_p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - created_at) * 1000) AS e2e_p95
       FROM imageflow_upload_jobs
       WHERE created_at > now() - ($1 || ' days')::interval`,
      [interval],
    ),
    pool.query(
      `SELECT coalesce(client_info->>'device', 'unknown') AS device,
              count(*)::int AS jobs,
              count(*) FILTER (WHERE status = 'failed')::int AS failed,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY received_ms) AS p95
         FROM imageflow_upload_jobs
        WHERE created_at > now() - ($1 || ' days')::interval
        GROUP BY 1 ORDER BY jobs DESC`,
      [interval],
    ),
    pool.query(
      `SELECT left(last_error, 160) AS error, count(*)::int AS jobs
         FROM imageflow_upload_jobs
        WHERE created_at > now() - ($1 || ' days')::interval AND last_error IS NOT NULL
        GROUP BY 1 ORDER BY jobs DESC LIMIT 5`,
      [interval],
    ),
  ]);

  const num = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v)));
  const t = timings.rows[0] ?? {};
  return {
    windowDays,
    counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
    current,
    backlogBytes: Number(backlog.rows[0]?.b ?? 0),
    receivedMs: { p50: num(t.rec_p50), p95: num(t.rec_p95) },
    graphMs: { p50: num(t.graph_p50), p95: num(t.graph_p95) },
    endToEndMs: { p50: num(t.e2e_p50), p95: num(t.e2e_p95) },
    byDevice: devices.rows.map((r) => ({
      device: r.device,
      jobs: r.jobs,
      failed: r.failed,
      p95ReceivedMs: num(r.p95),
    })),
    topErrors: errors.rows.map((r) => ({ error: r.error, jobs: r.jobs })),
  };
}
