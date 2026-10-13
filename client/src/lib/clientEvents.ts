/**
 * Device-side diagnostics. Failures that never reach the server (storage aborts,
 * unreadable photos, fetch errors, tab reloads) are posted to /api/upload/client-events,
 * which only writes an [upload-client] log line.
 */
import { isAndroid, isIOS } from "./deviceDetection";

export type ClientEvent =
  | "storage_problem"
  | "blob_unreadable"
  | "send_error"
  | "camera_reload";

const sent = new Set<string>();

export function deviceLabel(): string {
  const cap = (window as any).Capacitor;
  if (cap?.isNativePlatform?.()) return "android-app";
  if (isAndroid()) return "android-browser";
  if (isIOS()) return "ios-browser";
  return "desktop-browser";
}

/** Fire-and-forget; one report per event + detail per page load. Never throws. */
export function reportClientEvent(event: ClientEvent, detail = ""): void {
  const trimmed = detail.slice(0, 500);
  const key = `${event}|${trimmed}`;
  if (sent.has(key) || sent.size > 50) return;
  sent.add(key);
  const body = JSON.stringify({
    event,
    detail: trimmed,
    device: deviceLabel(),
    userAgent: navigator.userAgent.slice(0, 200),
    online: navigator.onLine,
  });
  try {
    void fetch("/api/upload/client-events", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* diagnostics must never break capture */
  }
}
