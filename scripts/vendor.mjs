#!/usr/bin/env node
/**
 * Build the app and refresh deploy_vendor/dist (what the Dockerfile ships).
 *
 *   node scripts/vendor.mjs          build → dist/ → deploy_vendor/dist + BUILD_INFO.json
 *   node scripts/vendor.mjs --check  exit 1 if deploy_vendor/dist was built from different source
 *   node scripts/vendor.mjs --hash   print the current source hash
 *
 * deploy_vendor/node_modules is Linux-built (Replit) and is NOT touched here; the build
 * fails if the server bundle imports a package that is missing from it.
 */
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(root, "deploy_vendor");
const vendorDist = path.join(vendorDir, "dist");
const buildInfoPath = path.join(vendorDist, "BUILD_INFO.json");

const SOURCE_PATHS = [
  "client",
  "server",
  "shared",
  "package.json",
  "package-lock.json",
  "vite.config.ts",
  "tsconfig.json",
  "tailwind.config.ts",
  "postcss.config.js",
  "components.json",
];

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/** Line-ending-insensitive hash of tracked + untracked (not ignored) source files. */
function sourceHash() {
  const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "--", ...SOURCE_PATHS])
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => fs.existsSync(path.join(root, f)))
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const content = fs.readFileSync(path.join(root, file)).toString("latin1").replace(/\r\n/g, "\n");
    hash.update(file).update("\0").update(createHash("sha256").update(content, "latin1").digest("hex")).update("\n");
  }
  return { hash: hash.digest("hex"), files: files.length };
}

function run(label, args, env = {}) {
  console.log(`[vendor] ${label}`);
  const res = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) {
    console.error(`[vendor] ${label} failed (exit ${res.status})`);
    process.exit(res.status ?? 1);
  }
}

function packageNameOf(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

/** Every bare import in the server bundle must exist in deploy_vendor/node_modules. */
function verifyRuntimeDeps(bundlePath) {
  const code = fs.readFileSync(bundlePath, "utf8");
  const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
  const specifiers = new Set();
  const patterns = [
    /^import\s[^;]*?\sfrom\s*["']([^"']+)["']/gm,
    /^import\s*["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const packageLike = /^(@[\w.-]+\/)?[\w.-]+(\/[\w./-]+)?$/;
  for (const re of patterns) {
    for (const m of code.matchAll(re)) {
      if (packageLike.test(m[1]) && !m[1].startsWith(".")) specifiers.add(m[1]);
    }
  }
  const missing = [];
  for (const spec of specifiers) {
    if (builtins.has(spec) || spec.startsWith("node:")) continue;
    const pkg = packageNameOf(spec);
    if (!fs.existsSync(path.join(vendorDir, "node_modules", pkg, "package.json"))) missing.push(pkg);
  }
  return [...new Set(missing)].sort();
}

const args = new Set(process.argv.slice(2));

if (args.has("--hash")) {
  console.log(sourceHash().hash);
  process.exit(0);
}

if (args.has("--check")) {
  const current = sourceHash();
  if (!fs.existsSync(buildInfoPath)) {
    console.error("[vendor] deploy_vendor/dist/BUILD_INFO.json is missing — run `npm run vendor` and commit deploy_vendor/.");
    process.exit(1);
  }
  const info = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
  if (info.sourceHash !== current.hash) {
    console.error(
      `[vendor] deploy_vendor/dist is STALE.\n` +
        `  built from: ${info.sourceHash} (git ${info.gitSha}, ${info.builtAt})\n` +
        `  source now: ${current.hash}\n` +
        `Production would not get these changes. Run \`npm run vendor\` and commit deploy_vendor/.`,
    );
    process.exit(1);
  }
  console.log(`[vendor] deploy_vendor/dist matches source (${current.hash.slice(0, 12)}, ${current.files} files).`);
  process.exit(0);
}

const nodeModules = path.join(root, "node_modules");
run("vite build", [path.join(nodeModules, "vite", "bin", "vite.js"), "build"], { NODE_ENV: "production" });
run("esbuild server", [
  path.join(nodeModules, "esbuild", "bin", "esbuild"),
  "server/index.ts",
  "--platform=node",
  "--packages=external",
  "--bundle",
  "--format=esm",
  "--outdir=dist",
]);

const distDir = path.join(root, "dist");
const missing = verifyRuntimeDeps(path.join(distDir, "index.js"));
if (missing.length) {
  console.error(
    `[vendor] Server imports packages missing from deploy_vendor/node_modules: ${missing.join(", ")}\n` +
      `Regenerate deploy_vendor/node_modules on Linux (see replit.md) before shipping.`,
  );
  process.exit(1);
}

const src = sourceHash();
let gitSha = "unknown";
let dirty = false;
try {
  gitSha = git(["rev-parse", "HEAD"]);
  dirty = git(["status", "--porcelain", "--", ...SOURCE_PATHS]).length > 0;
} catch {
  /* not a git checkout */
}
const buildInfo = {
  sourceHash: src.hash,
  sourceFiles: src.files,
  gitSha,
  gitShaShort: gitSha.slice(0, 8),
  baseDirty: dirty,
  builtAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(distDir, "BUILD_INFO.json"), JSON.stringify(buildInfo, null, 2) + "\n");

fs.rmSync(vendorDist, { recursive: true, force: true });
fs.cpSync(distDir, vendorDist, { recursive: true });
console.log(`[vendor] deploy_vendor/dist refreshed — source ${src.hash.slice(0, 12)} on git ${buildInfo.gitShaShort}${dirty ? " (+uncommitted changes)" : ""}.`);
console.log("[vendor] Commit deploy_vendor/ together with the source changes.");
