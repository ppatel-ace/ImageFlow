import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export type BuildInfo = {
  sha: string;
  sourceHash: string | null;
  builtAt: string | null;
};

let cached: BuildInfo | null = null;

/** Written by scripts/vendor.mjs next to dist/index.js; absent in `npm run dev`. */
export function getBuildInfo(): BuildInfo {
  if (cached) return cached;
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "BUILD_INFO.json"), "utf8"));
    cached = {
      sha: String(raw.gitShaShort || raw.gitSha || "unknown"),
      sourceHash: raw.sourceHash ? String(raw.sourceHash).slice(0, 12) : null,
      builtAt: raw.builtAt ? String(raw.builtAt) : null,
    };
  } catch {
    cached = { sha: "dev", sourceHash: null, builtAt: null };
  }
  return cached;
}
