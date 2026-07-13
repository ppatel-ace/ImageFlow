const DEFAULT_HUB_URL = "https://aceerp.aceelectronics.com";

/** ACE Hub applications launcher. */
export function getHubAppsUrl(): string {
  const base =
    (import.meta.env.VITE_HUB_PUBLIC_URL as string | undefined)?.trim().replace(/\/$/, "") ||
    DEFAULT_HUB_URL;
  return `${base}/`;
}
