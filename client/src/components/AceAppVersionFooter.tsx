import { useEffect, useState } from "react";

type VersionResponse = { app_slug: string; name: string; version: string };

const DEFAULT_HUB = "https://aceerp.aceelectronics.com";
const cache = new Map<string, { at: number; data: VersionResponse }>();
const TTL_MS = 5 * 60 * 1000;

function hubBase(): string {
  return (
    (import.meta.env.VITE_HUB_PUBLIC_URL as string | undefined)?.trim().replace(/\/$/, "") ||
    DEFAULT_HUB
  );
}

async function fetchVersion(appSlug: string): Promise<VersionResponse | null> {
  const key = appSlug.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  try {
    const res = await fetch(`${hubBase()}/api/platform/version/${encodeURIComponent(key)}`, {
      credentials: "omit",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as VersionResponse;
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch {
    return null;
  }
}

export function AceAppVersionFooter({
  appSlug,
  displayName,
  fallbackVersion = "1.0.0",
  className = "",
}: {
  appSlug: string;
  displayName: string;
  fallbackVersion?: string;
  className?: string;
}) {
  const [label, setLabel] = useState(`${displayName} - ${fallbackVersion}`);

  useEffect(() => {
    let cancelled = false;
    void fetchVersion(appSlug).then((data) => {
      if (cancelled || !data) return;
      setLabel(`${displayName} - ${data.version || fallbackVersion}`);
    });
    return () => {
      cancelled = true;
    };
  }, [appSlug, displayName, fallbackVersion]);

  return (
    <p className={className} data-testid="ace-app-version-footer">
      {label}
    </p>
  );
}
