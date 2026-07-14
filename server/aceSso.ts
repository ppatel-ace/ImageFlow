/**
 * ACE SSO for ImageFlow — HS256 JWT via Node crypto (no jsonwebtoken/jose).
 * Cookie parse/set without cookie-parser (Express res.cookie + manual Cookie header).
 */
import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction, Express } from "express";
import { isSsoEnabled } from "./env";

export type AceAppSlug = "imageflow";

export interface AceSsoJwtPayload {
  sub: string;
  email: string;
  name: string;
  employeeId?: string;
  groups?: string[];
  apps?: string[];
  iat?: number;
  exp?: number;
}

export const SSO_COOKIE = "ace_sso";
export const SSO_JWT_EXPIRY_SECONDS = 8 * 60 * 60;
export const SSO_REFRESH_THRESHOLD_SECONDS = 2 * 60 * 60;

export type AceAuthRequest = Request & {
  aceSsoUser?: AceSsoJwtPayload & { id: string };
};

function base64urlEncode(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64urlDecode(input: string): Buffer {
  const pad = (4 - (input.length % 4)) % 4;
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  return Buffer.from(b64, "base64");
}

function signHs256Jwt(
  payload: Record<string, unknown>,
  secret: string,
  expiresInSeconds: number,
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSeconds };
  const h = base64urlEncode(JSON.stringify(header));
  const p = base64urlEncode(JSON.stringify(body));
  const data = `${h}.${p}`;
  const sig = createHmac("sha256", secret).update(data).digest();
  return `${data}.${base64urlEncode(sig)}`;
}

function verifyHs256Jwt(token: string, secret: string): AceSsoJwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const data = `${h}.${p}`;
  const expected = createHmac("sha256", secret).update(data).digest();
  let actual: Buffer;
  try {
    actual = base64urlDecode(s);
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  try {
    const payload = JSON.parse(base64urlDecode(p).toString("utf8")) as AceSsoJwtPayload;
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    if (!payload.sub || !payload.email) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

function cookieDomainOptions(): { domain?: string } {
  const domain = process.env.APP_DOMAIN;
  const isLocal = !domain || domain === "localhost" || domain === "127.0.0.1";
  return isLocal ? {} : { domain: `.${domain}` };
}

function setAceSsoCookie(res: Response, token: string): void {
  res.cookie(SSO_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    ...cookieDomainOptions(),
  });
}

export function clearAceSsoCookie(res: Response): void {
  res.cookie(SSO_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    ...cookieDomainOptions(),
  });
}

export function verifyAceSsoToken(token: string): AceSsoJwtPayload | null {
  const secret = process.env.SSO_JWT_SECRET;
  if (!secret || !token) return null;
  return verifyHs256Jwt(token, secret);
}

export function hasAppAccess(
  payload: Pick<AceSsoJwtPayload, "groups" | "apps"> | null | undefined,
  app: AceAppSlug,
): boolean {
  if (!payload) return false;
  return payload.apps?.includes(app) ?? false;
}

function refreshSsoTokenIfNeeded(
  token: string,
  payload: AceSsoJwtPayload,
  res: Response,
): void {
  try {
    const secret = process.env.SSO_JWT_SECRET;
    if (!secret) return;
    if (
      typeof payload.exp === "number" &&
      payload.exp - Math.floor(Date.now() / 1000) >= SSO_REFRESH_THRESHOLD_SECONDS
    ) {
      return;
    }
    const newToken = signHs256Jwt(
      {
        sub: payload.sub,
        email: payload.email,
        name: payload.name,
        employeeId: payload.employeeId,
        groups: payload.groups,
        apps: payload.apps,
      },
      secret,
      SSO_JWT_EXPIRY_SECONDS,
    );
    setAceSsoCookie(res, newToken);
  } catch {
    /* ignore */
  }
}

export function buildSsoLoginUrl(req: Request, nextPath = "/"): string | null {
  const ssoBase = process.env.SSO_LOGIN_URL;
  if (!ssoBase) return null;
  // APP_URL must be the public origin (https://image.aceelectronics.com) so SSO redirect_uri matches NPM/DNS.
  const appUrl = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
  const callback = `${appUrl}/api/auth/sso/callback`;
  const withNext =
    nextPath && nextPath !== "/"
      ? `${callback}?next=${encodeURIComponent(nextPath)}`
      : callback;
  return `${ssoBase}?redirect_uri=${encodeURIComponent(withNext)}`;
}

export function tryAceSsoFromRequest(
  req: AceAuthRequest,
  res: Response,
): AceSsoJwtPayload | null {
  const cookies = parseCookies(req);
  const token = cookies[SSO_COOKIE];
  if (!token) return null;
  const payload = verifyAceSsoToken(token);
  if (!payload) return null;
  req.aceSsoUser = { ...payload, id: payload.sub };
  refreshSsoTokenIfNeeded(token, payload, res);
  return payload;
}

export function requireAceSsoApp(app: AceAppSlug) {
  return (req: AceAuthRequest, res: Response, next: NextFunction): void => {
    if (!isSsoEnabled()) {
      req.aceSsoUser = {
        id: "local-dev",
        sub: "local-dev",
        email: "local@aceelectronics.com",
        name: "Local User",
        apps: [app],
      };
      return next();
    }

    const payload = tryAceSsoFromRequest(req, res);
    if (!payload) {
      const loginUrl = buildSsoLoginUrl(req);
      if (loginUrl) {
        return res.status(401).json({
          error: "Unauthorized",
          ssoLoginUrl: loginUrl,
        });
      }
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!hasAppAccess(payload, app)) {
      return res.status(403).json({
        error: "Forbidden",
        message: "You do not have access to this application.",
      });
    }
    next();
  };
}

/**
 * Serve the SPA without hard-redirecting to SSO. When a cookie is present,
 * refresh it. Login UX is handled by the client (LoginPage).
 * API routes remain gated via requireAceSsoApp.
 */
export function requireAceSsoSpa(_app: AceAppSlug) {
  return (req: AceAuthRequest, res: Response, next: NextFunction): void => {
    if (req.path.startsWith("/api/") || req.path === "/health") return next();
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    tryAceSsoFromRequest(req, res);
    return next();
  };
}

export function registerAceSsoRoutes(app: Express, appSlug: AceAppSlug = "imageflow"): void {
  app.get("/api/auth/sso/callback", (req, res) => {
    const rawToken = req.query.ace_token as string | undefined;
    const nextPath = (req.query.next as string) || "/";
    const safeNext = nextPath.startsWith("/") ? nextPath : "/";
    if (!rawToken) return res.redirect(safeNext);

    const token = decodeURIComponent(rawToken);
    const payload = verifyAceSsoToken(token);
    if (!payload) return res.redirect("/");

    if (!hasAppAccess(payload, appSlug)) {
      clearAceSsoCookie(res);
      return res.status(403).send("You do not have access to ImageFlow. Contact your administrator.");
    }

    setAceSsoCookie(res, token);
    res.redirect(safeNext);
  });

  app.get("/api/auth/sso/session", (req: AceAuthRequest, res) => {
    if (!isSsoEnabled()) {
      return res.json({
        authenticated: true,
        via: "disabled",
        ssoEnabled: false,
        user: {
          id: "local-dev",
          email: "local@aceelectronics.com",
          name: "Local User",
          groups: [],
          apps: [appSlug],
        },
      });
    }

    const payload = tryAceSsoFromRequest(req, res);
    if (payload && hasAppAccess(payload, appSlug)) {
      return res.json({
        authenticated: true,
        via: "sso",
        ssoEnabled: true,
        user: {
          id: payload.sub,
          email: payload.email,
          name: payload.name,
          groups: payload.groups ?? [],
          apps: payload.apps ?? [],
        },
      });
    }
    const loginUrl = buildSsoLoginUrl(req, "/");
    if (loginUrl) {
      return res.json({
        authenticated: false,
        ssoEnabled: true,
        ssoLoginUrl: loginUrl,
      });
    }
    res.json({ authenticated: false, ssoEnabled: true });
  });

  app.post("/api/auth/sso/logout", (_req, res) => {
    clearAceSsoCookie(res);
    res.json({ ok: true });
  });

  app.get("/api/auth/sso/logout", (_req, res) => {
    clearAceSsoCookie(res);
    const ssoBase = process.env.SSO_LOGIN_URL;
    if (ssoBase) return res.redirect(ssoBase);
    res.redirect("/");
  });
}
