/**
 * Background worker: drains imageflow_upload_jobs into SharePoint.
 * Safe to run in several containers — claims use FOR UPDATE SKIP LOCKED + a lease,
 * and SharePoint PUTs use conflictBehavior=replace so a re-run after a crash overwrites
 * the same file instead of duplicating it.
 */
import { isDatabaseConfigured } from "./db";
import { uploadFileToSharePoint } from "./sharepoint";
import { recordUploadHistory } from "./uploadHistory";
import {
  claimNextUploadJob,
  markUploadJobDone,
  markUploadJobFailed,
  purgeOldUploadJobs,
  type ClaimedUploadJob,
} from "./uploadJobs";

const CONCURRENCY = Math.max(1, Number(process.env.IMAGEFLOW_UPLOAD_CONCURRENCY) || 3);
const POLL_MS = 2_000;
const PURGE_EVERY_MS = 60 * 60 * 1000;

let started = false;
let active = 0;
let draining = false;
let lastPurgeAt = 0;

function folderOnlyPath(fullPath: string): string {
  const parts = fullPath.split("/").filter(Boolean);
  if (parts.length <= 1) return fullPath;
  return parts.slice(0, -1).join("/");
}

function logUpload(event: string, fields: Record<string, unknown>): void {
  console.log(`[upload] ${event} ${JSON.stringify(fields)}`);
}

async function processJob(job: ClaimedUploadJob): Promise<void> {
  const queueWaitMs = Date.now() - job.createdAt.getTime();
  try {
    const result = await uploadFileToSharePoint(
      job.customerName,
      job.dept,
      job.workOrderNumber,
      job.fileName,
      job.bytes,
    );
    await markUploadJobDone(job.id, {
      sharepointPath: result.path,
      webUrl: result.webUrl ?? null,
      graphMs: result.timings.totalMs,
      graphTimings: result.timings,
    });
    logUpload("done", {
      id: job.id,
      attempt: job.attempts,
      bytes: job.bytes.length,
      queueWaitMs,
      ...result.timings,
    });
    try {
      await recordUploadHistory({
        workOrderNumber: job.workOrderNumber,
        partNumber: job.partNumber,
        rev: job.rev,
        customerName: job.customerName,
        folderPath: folderOnlyPath(result.path),
        fileName: job.fileName,
        webUrl: result.webUrl ?? null,
        dept: job.dept,
        userId: job.userId,
        userEmail: job.userEmail,
        userName: job.userName,
      });
    } catch (histErr: any) {
      console.warn("[uploadHistory] failed to record:", histErr?.message || histErr);
    }
  } catch (err: any) {
    const message = err?.message || String(err);
    const { permanent } = await markUploadJobFailed(job.id, job.attempts, message);
    logUpload(permanent ? "failed" : "retry", {
      id: job.id,
      attempt: job.attempts,
      queueWaitMs,
      error: message.slice(0, 300),
    });
  }
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (active < CONCURRENCY) {
      const job = await claimNextUploadJob();
      if (!job) break;
      active++;
      void processJob(job).finally(() => {
        active--;
        kickUploadWorker();
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
  void drain();
}

export function getUploadWorkerStatus(): { started: boolean; active: number; concurrency: number } {
  return { started, active, concurrency: CONCURRENCY };
}
