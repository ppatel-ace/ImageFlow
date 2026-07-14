/**
 * SharePoint uploads via Azure AD app client credentials (GCC High).
 * Token: login.microsoftonline.us → Graph: graph.microsoft.us
 * Prefer SHAREPOINT_SITE_ID when using Sites.Selected (hostname lookup often 403s).
 * Folder layout: ACE/{Customer}/{Dept}/{WorkOrder}/
 */

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;
let cachedSiteId: string | null = null;
let cachedDriveId: string | null = null;

const GRAPH_BASE = "https://graph.microsoft.us/v1.0";
const TOKEN_URL_BASE = "https://login.microsoftonline.us";

function sanitizePathSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*]/g, "_");
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function sitesPermissionHint(status: number, body: string): string {
  if (status !== 403 && status !== 401) return "";
  return (
    ` Azure app lacks SharePoint access. Fix (GCC High admin): ` +
    `(1) App registration → API permissions → Microsoft Graph application ` +
    `Sites.Selected (or Sites.ReadWrite.All) + admin consent. ` +
    `(2) Grant that app Write on the site ` +
    `(Grant-PnPAzureADAppSitePermission / Graph site permissions). ` +
    `(3) Prefer setting SHAREPOINT_SITE_ID so the app skips site hostname lookup ` +
    `(Sites.Selected often returns 403 on /sites/{host}:{path}). ` +
    `Graph detail: ${body.slice(0, 180)}`
  );
}

async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.accessToken;
  }

  const tenantId = requireEnv("AZURE_TENANT_ID");
  const clientId = requireEnv("AZURE_CLIENT_ID");
  const clientSecret = requireEnv("AZURE_CLIENT_SECRET");

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.us/.default",
  });

  const res = await fetch(`${TOKEN_URL_BASE}/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Azure token request failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    throw new Error("Azure token response missing access_token");
  }

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return tokenCache.accessToken;
}

async function graphFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getAccessToken();
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && init.body && !(init.body instanceof Buffer)) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(url, { ...init, headers });
}

async function resolveSiteId(): Promise<string> {
  if (cachedSiteId) return cachedSiteId;

  const configured = process.env.SHAREPOINT_SITE_ID?.trim();
  if (configured) {
    // Validate the app can actually read this site
    const res = await graphFetch(`/sites/${configured}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `SHAREPOINT_SITE_ID is set but not accessible (${res.status}).` +
          sitesPermissionHint(res.status, text),
      );
    }
    cachedSiteId = configured;
    return cachedSiteId;
  }

  const hostname =
    process.env.SHAREPOINT_SITE_HOSTNAME?.trim() || "aceelectronics.sharepoint.us";
  const sitePath =
    process.env.SHAREPOINT_SITE_PATH?.trim() || "/sites/jobtravelerphotos";
  const normalizedPath = sitePath.startsWith("/") ? sitePath : `/${sitePath}`;

  // Graph: GET /sites/{hostname}:{server-relative-path}
  // Note: with Sites.Selected this call often 403s — set SHAREPOINT_SITE_ID instead.
  const res = await graphFetch(
    `/sites/${encodeURIComponent(hostname)}:${normalizedPath}`,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Failed to resolve SharePoint site (${res.status}).` +
        sitesPermissionHint(res.status, text) +
        (statusIsAccessDenied(res.status)
          ? ` Set SHAREPOINT_SITE_ID to the full Graph site id for ${hostname}${normalizedPath}.`
          : ` Raw: ${text.slice(0, 200)}`),
    );
  }
  const site = (await res.json()) as { id?: string };
  if (!site.id) throw new Error("SharePoint site response missing id");
  cachedSiteId = site.id;
  return cachedSiteId;
}

function statusIsAccessDenied(status: number): boolean {
  return status === 401 || status === 403;
}

async function resolveDriveId(siteId: string): Promise<string> {
  if (cachedDriveId) return cachedDriveId;

  const configured = process.env.SHAREPOINT_DRIVE_ID?.trim();
  if (configured) {
    cachedDriveId = configured;
    return cachedDriveId;
  }

  const res = await graphFetch(`/sites/${siteId}/drive`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Failed to resolve default drive (${res.status}).` +
        sitesPermissionHint(res.status, text),
    );
  }
  const drive = (await res.json()) as { id?: string };
  if (!drive.id) throw new Error("SharePoint drive response missing id");
  cachedDriveId = drive.id;
  return cachedDriveId;
}

function driveItemPath(segments: string[]): string {
  return segments.map(encodeURIComponent).join("/");
}

async function ensureFolderPath(driveId: string, folderPath: string): Promise<void> {
  const parts = folderPath.split("/").filter(Boolean);
  const built: string[] = [];

  for (const part of parts) {
    const parentSegments = [...built];
    built.push(part);

    const probe = await graphFetch(`/drives/${driveId}/root:/${driveItemPath(built)}`);
    if (probe.ok) continue;
    if (probe.status !== 404) {
      const text = await probe.text().catch(() => "");
      throw new Error(
        `Failed to check folder ${built.join("/")} (${probe.status}): ${text.slice(0, 200)}` +
          sitesPermissionHint(probe.status, text),
      );
    }

    const createUrl =
      parentSegments.length === 0
        ? `/drives/${driveId}/root/children`
        : `/drives/${driveId}/root:/${driveItemPath(parentSegments)}:/children`;

    const createRes = await graphFetch(createUrl, {
      method: "POST",
      body: JSON.stringify({
        name: part,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }),
    });

    // 409 = already created concurrently — treat as success
    if (!createRes.ok && createRes.status !== 409) {
      const text = await createRes.text().catch(() => "");
      throw new Error(
        `Failed to create folder ${part} (${createRes.status}): ${text.slice(0, 200)}` +
          sitesPermissionHint(createRes.status, text),
      );
    }
  }
}

export async function uploadFileToSharePoint(
  customerName: string,
  dept: string,
  workOrderNumber: string,
  fileName: string,
  fileBuffer: Buffer,
): Promise<{ success: true; path: string; webUrl?: string }> {
  const siteId = await resolveSiteId();
  const driveId = await resolveDriveId(siteId);

  const sanitizedCustomer = sanitizePathSegment(customerName);
  const sanitizedDept = sanitizePathSegment(dept);
  const sanitizedWo = sanitizePathSegment(workOrderNumber);
  const sanitizedFile = sanitizePathSegment(fileName);
  const folderPath = `ACE/${sanitizedCustomer}/${sanitizedDept}/${sanitizedWo}`;

  await ensureFolderPath(driveId, folderPath);

  const uploadPath = `/drives/${driveId}/root:/${driveItemPath([
    ...folderPath.split("/").filter(Boolean),
    sanitizedFile,
  ])}:/content`;

  const uploadRes = await graphFetch(uploadPath, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: fileBuffer,
  });

  if (!uploadRes.ok) {
    const text = await uploadRes.text().catch(() => "");
    throw new Error(
      `SharePoint upload failed (${uploadRes.status}): ${text.slice(0, 300)}` +
        sitesPermissionHint(uploadRes.status, text),
    );
  }

  const uploaded = (await uploadRes.json().catch(() => ({}))) as { webUrl?: string };

  return {
    success: true,
    path: `${folderPath}/${sanitizedFile}`,
    webUrl: uploaded.webUrl,
  };
}

/** Non-secret status for /health */
export function getSharePointEnvStatus(): {
  azureTenantSet: boolean;
  azureClientSet: boolean;
  azureSecretSet: boolean;
  siteIdSet: boolean;
  siteHostname: string;
  sitePath: string;
} {
  return {
    azureTenantSet: Boolean(process.env.AZURE_TENANT_ID?.trim()),
    azureClientSet: Boolean(process.env.AZURE_CLIENT_ID?.trim()),
    azureSecretSet: Boolean(process.env.AZURE_CLIENT_SECRET?.trim()),
    siteIdSet: Boolean(process.env.SHAREPOINT_SITE_ID?.trim()),
    siteHostname:
      process.env.SHAREPOINT_SITE_HOSTNAME?.trim() || "aceelectronics.sharepoint.us",
    sitePath: process.env.SHAREPOINT_SITE_PATH?.trim() || "/sites/jobtravelerphotos",
  };
}
