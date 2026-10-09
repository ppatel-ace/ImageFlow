/**
 * Background worker: drains imageflow_upload_jobs into SharePoint.
 * Safe to run in several containers — claims use FOR UPDATE SKIP LOCKED + a lease
 * (renewed by a heartbeat while a job runs), and SharePoint PUTs use conflictBehavior=replace
 * so a re-run after a crash overwrites the same file instead of duplicating it.
 *
 * A job is only "done" once the file is checked in and Graph confirms it is published.
 * Content that landed but stayed checked out moves to checkin_pending and is repaired here.
 * Configuration/permission failures park jobs as "blocked" and pause the worker until a
 * SharePoint probe passes again, instead of burning retries for hours.
 */
import cron from "node-cron";
import { isDatabaseConfigured } from "./db";
import {
  probeSharePointAccess,
  retryCheckIn,
  SharePointCheckinError,
  sweepPathsCheckedOutByApp,
  sweepTreeCheckedOutByApp,
  uploadFileToSharePoint,
  type CheckinSweepResult,
} from "./sharepoint";
import { classifyUploadError } from "./uploadErrors";
import { recordUploadHistory } from "./uploadHistory";
import {
  claimNextCheckinJob,
  claimNextUploadJob,
  countBlockedJobs,
  extendUploadJobLease,
  listRecentUploadPaths,
  markUploadJobBlocked,
  markUploadJobCheckinPending,
  markUploadJobDone,
  markUploadJobFailed,
  purgeOldUploadJobs,
  releaseBlockedJobs,
  rescheduleCheckin,
  type ClaimedCheckinJob,
  type ClaimedUploadJob,
} from "./uploadJobs";

const CONCURRENCY = Math.max(1, Number(process.env.IMAGEFLOW_UPLOAD_CONCURRENCY) || 6);
const CHECKIN_CONCURRENCY = 2;
const POLL_MS = 2_000;
const HEARTBEAT_MS = 60_000;
const PROBE_EVERY_MS = 60_000;
const PURGE_EVERY_MS = 60 * 60 * 1000;
const NIGHTLY_SWEEP_CRON = "15 2 * * *";

let started = false;
let active = 0;
let activeCheckins = 0;
let draining = false;
let lastPurgeAt = 0;
let lastProbeAt = 0;
let blocked: { since: number; reason: string } | null = null;

export type CheckinSweepRun = {
  mode: "recent" | "full";
  startedAt: string;
  finishedAt: string | null;
  result: CheckinSweepResult | null;
  error: string | null;
};
let lastSweep: CheckinSweepRun | null = null;
let sweepRunning = false;

function folderOnlyPath(fullPath: string): string {
  const parts = fullPath.split("/").filter(Boolean);
  if (parts.length <= 1) return fullPath;
  return parts.slice(0, -1).join("/");
}

function logUpload(event: string, fields: Record<string, unknown>): void {
  console.log(`[upload] ${event} ${JSON.stringify(fields)}`);
}

function withHeartbeat<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    extendUploadJobLease(jobId).catch((err) =>
      console.warn("[upload] lease heartbeat failed:", err?.message || err),
    );
  }, HEARTBEAT_MS);
  return fn().finally(() => clearInterval(timer));
}

async function recordHistory(
  job: Pick<
    ClaimedUploadJob,
    "workOrderNumber" | "partNumber" | "rev" | "customerName" | "fileName" | "dept" | "userId" | "userEmail" | "userName"
  >,
  sharepointPath: string,
  webUrl: string | null,
): Promise<void> {
  try {
    await recordUploadHistory({
      workOrderNumber: job.workOrderNumber,
      partNumber: job.partNumber,
      rev: job.rev,
      customerName: job.customerName,
      folderPath: folderOnlyPath(sharepointPath),
      fileName: sharepointPath.split("/").pop() || job.fileName,
      webUrl,
      dept: job.dept,
      userId: job.userId,
      userEmail: job.userEmail,
      userName: job.userName,
    });
  } catch (histErr: any) {
    console.warn("[uploadHistory] failed to record:", histErr?.message || histErr);
  }
}

function enterBlocked(reason: string): void {
  if (!blocked) {
    blocked = { since: Date.now(), reason: reason.slice(0, 500) };
    console.error(`[upload] worker BLOCKED — pausing uploads until SharePoint access works: ${reason.slice(0, 300)}`);
  }
}

async function processJob(job: ClaimedUploadJob): Promise<void> {
  const queueWaitMs = Date.now() - job.createdAt.getTime();
  try {
    const result = await withHeartbeat(job.id, () =>
      uploadFileToSharePoint(job.customerName, job.dept, job.workOrderNumber, job.fileName, job.bytes),
    );
    await markUploadJobDone(job.id, {
      sharepointPath: result.path,
      sharepointItemId: result.itemId,
      webUrl: result.webUrl ?? null,
      graphMs: result.timings.totalMs,
      graphTimings: result.timings,
    });
    logUpload("done", { id: job.id, attempt: job.attempts, bytes: job.bytes.length, queueWaitMs, ...result.timings });
    await recordHistory(job, result.path, result.webUrl ?? null);
  } catch (err: any) {
    const message = err?.message || String(err);
    const kind = classifyUploadError(err);
    if (kind === "checkin" && err instanceof SharePointCheckinError) {
      await markUploadJobCheckinPending(job.id, {
        sharepointPath: err.path,
        sharepointItemId: err.itemId,
        webUrl: err.webUrl ?? null,
        error: message,
      });
      logUpload("checkin_pending", { id: job.id, path: err.path, error: message.slice(0, 300) });
      return;
    }
    if (kind === "blocked") {
      await markUploadJobBlocked(job.id, message);
      enterBlocked(message);
      logUpload("blocked", { id: job.id, error: message.slice(0, 300) });
      return;
    }
    const { permanent } = await markUploadJobFailed(job.id, job.attempts, message, {
      permanent: kind === "permanent",
    });
    logUpload(permanent ? "failed" : "retry", {
      id: job.id,
      attempt: job.attempts,
      queueWaitMs,
      error: message.slice(0, 300),
    });
  }
}

async function processCheckinJob(job: ClaimedCheckinJob): Promise<void> {
  try {
    const result = await withHeartbeat(job.id, () =>
      retryCheckIn(job.sharepointItemId, job.sharepointPath),
    );
    await markUploadJobDone(job.id, {
      sharepointPath: job.sharepointPath,
      sharepointItemId: result.itemId,
      webUrl: result.webUrl ?? null,
    });
    logUpload("checkin_repaired", { id: job.id, path: job.sharepointPath });
    await recordHistory(job, job.sharepointPath, result.webUrl ?? null);
  } catch (err: any) {
    const message = err?.message || String(err);
    await rescheduleCheckin(job.id, message);
    logUpload("checkin_retry", { id: job.id, error: message.slice(0, 300) });
  }
}

/** While blocked (or after a restart with blocked rows), probe SharePoint and resume when it works. */
async function maybeProbeBlocked(): Promise<void> {
  if (Date.now() - lastProbeAt < PROBE_EVERY_MS) return;
  lastProbeAt = Date.now();
  const blockedRows = await countBlockedJobs();
  if (!blocked && blockedRows === 0) return;
  const probe = await probeSharePointAccess();
  if (!probe.ok) {
    enterBlocked(probe.error || "SharePoint probe failed");
    return;
  }
  const released = await releaseBlockedJobs();
  if (blocked || released > 0) {
    logUpload("unblocked", {
      blockedForSec: blocked ? Math.round((Date.now() - blocked.since) / 1000) : null,
      released,
    });
  }
  blocked = null;
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    await maybeProbeBlocked();

    while (!blocked && active < CONCURRENCY) {
      const job = await claimNextUploadJob();
      if (!job) break;
      active++;
      void processJob(job).finally(() => {
        active--;
        kickUploadWorker();
      });
    }

    while (activeCheckins < CHECKIN_CONCURRENCY) {
      const job = await claimNextCheckinJob();
      if (!job) break;
      activeCheckins++;
      void processCheckinJob(job).finally(() => {
        activeCheckins--;
      });
    }
  } catch (err: any) {
    console.error("[upload] worker claim failed:", err?.message || err);
  } finally {
    draining = false;
  }

  if (Date.now() - lastPurgeAt > PURGE_EVERY_MS) {
    lastPurgeAt = Date.now();
    purgeOldUploadJobs()
      .then((n) => n > 0 && logUpload("purged", { rows: n }))
      .catch((err) => console.warn("[upload] purge failed:", err?.message || err));
  }
}

/**
 * Check in files the app left checked out. "recent" re-checks the last 14 days of uploads
 * (nightly); "full" walks the whole library once to clean up the pre-queue backlog.
 */
export async function runCheckinSweep(mode: "recent" | "full"): Promise<CheckinSweepRun> {
  if (sweepRunning && lastSweep) return lastSweep;
  sweepRunning = true;
  const run: CheckinSweepRun = {
    mode,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    error: null,
  };
  lastSweep = run;
  try {
    run.result =
      mode === "full"
        ? await sweepTreeCheckedOutByApp()
        : await sweepPathsCheckedOutByApp(await listRecentUploadPaths(14));
    logUpload("checkin_sweep", { mode, ...run.result, errors: run.result.errors.length });
  } catch (err: any) {
    run.error = (err?.message || String(err)).slice(0, 500);
    console.error(`[upload] check-in sweep (${mode}) failed:`, run.error);
  } finally {
    run.finishedAt = new Date().toISOString();
    sweepRunning = false;
  }
  return run;
}

/** Nudge the worker (e.g. right after a job is staged) instead of waiting for the poll. */
export function kickUploadWorker(): void {
  if (!started) return;
  setImmediate(() => void drain());
}

export function startUploadWorker(): void {
  if (started) return;
  if (!isDatabaseConfigured()) {
    console.warn("[upload] DATABASE_URL not set — staging queue disabled; legacy sync upload only");
    return;
  }
  if (process.env.IMAGEFLOW_UPLOAD_WORKER === "false") {
    console.warn("[upload] IMAGEFLOW_UPLOAD_WORKER=false — worker not started in this process");
    return;
  }
  started = true;
  console.log(`[upload] worker started (concurrency=${CONCURRENCY})`);
  setInterval(() => void drain(), POLL_MS).unref();
  cron.schedule(NIGHTLY_SWEEP_CRON, () => void runCheckinSweep("recent"), {
    timezone: "America/New_York",
  });
  void drain();
}

export function getUploadWorkerStatus(): {
  started: boolean;
  active: number;
  activeCheckins: number;
  concurrency: number;
  blocked: { since: string; reason: string } | null;
  lastSweep: CheckinSweepRun | null;
} {
  return {
    started,
    active,
    activeCheckins,
    concurrency: CONCURRENCY,
    blocked: blocked ? { since: new Date(blocked.since).toISOString(), reason: blocked.reason } : null,
    lastSweep,
  };
}
