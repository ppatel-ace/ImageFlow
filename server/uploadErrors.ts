import { SharePointCheckinError } from "./sharepoint";

/**
 * transient → retry with backoff (network, throttling, 5xx, locked by a person)
 * blocked   → configuration / permission problem: retrying cannot help until someone fixes it
 * permanent → this photo itself is rejected (bad name, unsupported content)
 * checkin   → content landed but is still checked out; repair sweeper owns it
 */
export type UploadErrorKind = "transient" | "blocked" | "permanent" | "checkin";

const BLOCKED_PATTERNS = [
  /Missing required env var/i,
  /Missing Azure credentials/i,
  /looks like a Secret ID/i,
  /AZURE_CLIENT_CERT_PATH not found|Private key not found|Invalid base64 in/i,
  /Azure token request failed \(4\d\d\)/i,
  /SHAREPOINT_SITE_ID is set but not accessible/i,
  /Failed to resolve (SharePoint site|default drive)/i,
  /\((401|403)\)/,
];

const PERMANENT_PATTERNS = [
  /SharePoint upload (session )?failed \(400\)/i,
  /Failed to create folder .* \(400\)/i,
];

export function classifyUploadError(err: unknown): UploadErrorKind {
  if (err instanceof SharePointCheckinError) return "checkin";
  const message = err instanceof Error ? err.message : String(err);
  if (BLOCKED_PATTERNS.some((re) => re.test(message))) return "blocked";
  if (PERMANENT_PATTERNS.some((re) => re.test(message))) return "permanent";
  return "transient";
}
