/**
 * Minimal .env loader — avoids a dotenv dependency.
 * Does not override variables already set in the process environment.
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

export function loadEnvFile(fileName = ".env"): void {
  const filePath = resolve(process.cwd(), fileName);
  if (!existsSync(filePath)) return;

  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/** SSO is on only when ENABLE_SSO is explicitly true. Default: off. */
export function isSsoEnabled(): boolean {
  const flag = process.env.ENABLE_SSO?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "on" || flag === "yes";
}
