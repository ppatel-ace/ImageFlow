import { useEffect } from "react";
import { initUsageBeacon, trackFeature } from "@/lib/usageBeacon";

/** Spoke usage beacon — posts same-origin to /api/usage-events; the API server relays to the Hub. */
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
    initUsageBeacon({
      appSlug,
      mode: "relay",
      getIdentity,
    });
  }, [appSlug, getIdentity]);

  return null;
}

export { trackFeature };
