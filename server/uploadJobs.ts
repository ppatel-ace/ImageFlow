/**
 * Data access for imageflow_upload_jobs (server staging queue).
 * Raw SQL via the shared pg pool so the worker can use FOR UPDATE SKIP LOCKED.
 */
import { createHash } from "crypto";
import type { UploadJobStatus } from "../shared/schema";
import { ensureUploadJobsTable, getPool } from "./db";

export const MAX_JOB_ATTEMPTS = 12;
export const JOB_LEASE_SECONDS = 10 * 60;
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
        SET status = 'staged', attempts = 0, next_attempt_at = now(),
            locked_until = NULL, updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status IN ('failed', 'staged') AND bytes IS NOT NULL
      RETURNING ${STATUS_COLUMNS}`,
    [id, userId],
  );
  return res.rows[0] ? toStatusDto(res.rows[0]) : null;
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

export async function markUploadJobDone(
  id: string,
  result: {
    sharepointPath: string;
    webUrl: string | null;
    graphMs: number;
    graphTimings: Record<string, unknown>;
  },
): Promise<void> {
  await getPool().query(
    `UPDATE imageflow_upload_jobs
        SET status = 'done', bytes = NULL, locked_until = NULL, last_error = NULL,
            sharepoint_path = $2, web_url = $3, graph_ms = $4, graph_timings = $5,
            completed_at = now(), updated_at = now()
      WHERE id = $1`,
    [id, result.sharepointPath, result.webUrl, result.graphMs, JSON.stringify(result.graphTimings)],
  );
}

/** Backoff: 30s, 2m, 10m, 30m, then hourly. */
export function backoffSeconds(attempts: number): number {
  const schedule = [30, 120, 600, 1800];
  return schedule[attempts - 1] ?? 3600;
}

export async function markUploadJobFailed(
  id: string,
  attempts: number,
  error: string,
): Promise<{ permanent: boolean }> {
  const permanent = attempts >= MAX_JOB_ATTEMPTS;
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

export type UploadStats = {
  windowDays: number;
  counts: Record<string, number>;
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

  const [counts, backlog, timings, devices, errors] = await Promise.all([
    pool.query(
      `SELECT status, count(*)::int AS n FROM imageflow_upload_jobs
        WHERE created_at > now() - ($1 || ' days')::interval GROUP BY status`,
      [interval],
    ),
    pool.query(
      `SELECT coalesce(sum(size_bytes), 0)::bigint AS b FROM imageflow_upload_jobs
        WHERE status IN ('staged', 'uploading', 'failed')`,
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
        GROUP BY 1 ORDER BY jobs DESC LIMIT 10`,
      [interval],
    ),
  ]);

  const num = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v)));
  const t = timings.rows[0] ?? {};
  return {
    windowDays,
    counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
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
