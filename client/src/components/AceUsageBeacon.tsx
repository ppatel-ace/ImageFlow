import { useEffect } from "react";
import { initUsageBeacon, trackFeature } from "@/lib/usageBeacon";

const DEFAULT_HUB = "https://aceerp.aceelectronics.com";

function hubBase(): string {
  try {
    return (
      (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_HUB_PUBLIC_URL?.trim().replace(
        /\/$/,
        "",
      ) || DEFAULT_HUB
    );
  } catch {
    return DEFAULT_HUB;
  }
}

function ingestSecret(): string {
  try {
    return (
      (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_PLATFORM_INGEST_SECRET?.trim() ||
      ""
    );
  } catch {
    return "";
  }
}

/** Spoke usage beacon — requires VITE_PLATFORM_INGEST_SECRET (+ optional VITE_HUB_PUBLIC_URL). */
export function AceUsageBeacon({
  appSlug,
  getIdentity,
}: {
  appSlug: string;
  getIdentity?: () => {
    email?: string | null;
    displayName?: string | null;
    ssoUserId?: string | null;
    employeeId?: string | null;
  } | null;
}) {
  useEffect(() => {
    const secret = ingestSecret();
    if (!secret) return;
    initUsageBeacon({
      appSlug,
      hubBaseUrl: hubBase(),
      mode: "ingest",
      ingestSecret: secret,
      getIdentity,
    });
  }, [appSlug, getIdentity]);

  return null;
}

export { trackFeature };
