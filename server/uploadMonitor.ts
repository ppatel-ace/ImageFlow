/**
 * Watches the upload queue every minute and posts to a Teams webhook
 * (IMAGEFLOW_ALERT_WEBHOOK) when photos are stuck, blocked, or not checked in —
 * so IT hears about it before operators do. Also feeds the /health queue snapshot.
 */
import { isDatabaseConfigured } from "./db";
import { getUploadQueueHealth, type UploadQueueHealth } from "./uploadJobs";
import { getUploadWorkerStatus } from "./uploadWorker";

const CHECK_EVERY_MS = 60_000;
const REALERT_AFTER_MS = 30 * 60 * 1000;
const STUCK_AFTER_SEC = 5 * 60;
const CHECKIN_STUCK_AFTER_SEC = 15 * 60;
const DB_FAILURES_BEFORE_ALERT = 3;

type AlertKey = "stuck" | "blocked" | "checkin" | "monitor";

type Snapshot = UploadQueueHealth & { checkedAt: string };

let started = false;
let snapshot: Snapshot | null = null;
let dbFailures = 0;
let lastDbError = "";
const lastAlertAt = new Map<AlertKey, number>();

export function getUploadQueueSnapshot(): Snapshot | null {
  return snapshot;
}

function webhookUrl(): string | null {
  return process.env.IMAGEFLOW_ALERT_WEBHOOK?.trim() || null;
}

function appLabel(): string {
  const url = process.env.APP_URL?.trim() || "ImageFlow";
  return url.replace(/^https?:\/\//, "");
}

function minutes(sec: number | null): string {
  if (sec === null) return "?";
  return sec < 120 ? `${sec}s` : `${Math.round(sec / 60)} min`;
}

async function postToTeams(title: string, lines: string[], tone: "attention" | "good"): Promise<void> {
  const url = webhookUrl();
  if (!url) return;
  const text = `**${title}**\n\n${lines.join("\n\n")}`;
  const payload = {
    type: "message",
    text,
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", color: tone, wrap: true },
            ...lines.map((line) => ({ type: "TextBlock", text: line, wrap: true, spacing: "Small" })),
          ],
        },
      },
    ],
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.warn(`[upload-monitor] Teams webhook returned ${res.status}`);
  } catch (err: any) {
    console.warn("[upload-monitor] Teams webhook failed:", err?.message || err);
  }
}

async function evaluate(key: AlertKey, active: boolean, title: string, lines: string[]): Promise<void> {
  const last = lastAlertAt.get(key);
  if (active) {
    if (last && Date.now() - last < REALERT_AFTER_MS) return;
    lastAlertAt.set(key, Date.now());
    console.warn(`[upload-monitor] ALERT ${key}: ${lines.join(" | ")}`);
    await postToTeams(`ImageFlow: ${title}`, [...lines, `Server: ${appLabel()}`], "attention");
    return;
  }
  if (last) {
    lastAlertAt.delete(key);
    console.log(`[upload-monitor] resolved ${key}`);
    await postToTeams(`ImageFlow resolved: ${title}`, [`Back to normal on ${appLabel()}.`], "good");
  }
}

async function check(): Promise<void> {
  let health: UploadQueueHealth;
  try {
    health = await getUploadQueueHealth();
    dbFailures = 0;
  } catch (err: any) {
    dbFailures++;
    lastDbError = (err?.message || String(err)).slice(0, 300);
    await evaluate("monitor", dbFailures >= DB_FAILURES_BEFORE_ALERT, "upload queue database unreachable", [
      `The upload queue could not be read ${dbFailures} times in a row. New photos cannot be accepted.`,
      `Error: ${lastDbError}`,
    ]);
    return;
  }
  await evaluate("monitor", false, "upload queue database unreachable", []);
  snapshot = { ...health, checkedAt: new Date().toISOString() };

  const worker = getUploadWorkerStatus();
  await evaluate(
    "blocked",
    health.blocked > 0 || worker.blocked !== null,
    "SharePoint uploads are BLOCKED",
    [
      `${health.blocked} photo(s) are waiting because ImageFlow cannot write to SharePoint (configuration or permission problem).`,
      `Photos are safe on the server and upload automatically once access works again.`,
      `Error: ${(worker.blocked?.reason || health.latestBlockedError || "unknown").slice(0, 300)}`,
    ],
  );
  await evaluate(
    "stuck",
    health.oldestPendingSec !== null && health.oldestPendingSec > STUCK_AFTER_SEC,
    "photos are waiting too long",
    [
      `${health.pending + health.blocked} photo(s) not yet in SharePoint; oldest has waited ${minutes(health.oldestPendingSec)}.`,
      `Expected: under 1 minute.`,
    ],
  );
  await evaluate(
    "checkin",
    health.oldestCheckinPendingSec !== null && health.oldestCheckinPendingSec > CHECKIN_STUCK_AFTER_SEC,
    "photos uploaded but NOT checked in",
    [
      `${health.checkinPending} photo(s) are in SharePoint but still checked out (invisible to users); oldest ${minutes(health.oldestCheckinPendingSec)}.`,
      `Error: ${(health.latestCheckinError || "unknown").slice(0, 300)}`,
    ],
  );
}

export function startUploadMonitor(): void {
  if (started || !isDatabaseConfigured()) return;
  started = true;
  if (!webhookUrl()) {
    console.warn("[upload-monitor] IMAGEFLOW_ALERT_WEBHOOK not set — alerts only go to the container log");
  }
  setInterval(() => void check(), CHECK_EVERY_MS).unref();
  setTimeout(() => void check(), 5_000).unref();
}
