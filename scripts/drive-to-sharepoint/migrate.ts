/**
 * Copy old ImageFlow photos from Google Drive into SharePoint, checking every file in.
 *
 * Drive (read via rclone):  ACE/{Customer}/{Dept}/{WorkOrder}/{photo}
 * SharePoint:               {Dept}/{Customer}/{WorkOrder}/{photo}
 * Anything else:            Old Photos/<Drive path>/{photo}
 *
 * Launch through Copy-Drive-To-SharePoint.ps1 (sets ACE_RCLONE*, cwd = repo root).
 * Progress is saved after every file, so a stopped run resumes where it left off.
 */
import { spawn } from "child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";
import {
  DEPARTMENTS,
  classifyDriveFile,
  mapDrivePath,
  nameKey,
  normalizePhotoName,
  planRenames,
  resolveCustomerFolder,
  uniqueFileName,
  type Department,
} from "../../server/driveMigrationPlan";
import * as sp from "../../server/sharepoint";

// â”€â”€ Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
loadDotEnv(join(process.cwd(), ".env"));

const RCLONE = process.env.ACE_RCLONE || "rclone";
const RCLONE_CONF = process.env.ACE_RCLONE_CONF || "";
const REMOTE = process.env.ACE_RCLONE_REMOTE || "acedrive";
const TOOL_HOME = process.env.ACE_TOOL_HOME || join(process.cwd(), ".drive-to-sharepoint");

type Options = {
  dryRun: boolean;
  yes: boolean;
  only: string | null;
  folder: string | null;
  concurrency: number;
  retryFailed: boolean;
  skip: string[];
};

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    dryRun: false,
    yes: false,
    only: null,
    folder: null,
    concurrency: 6,
    retryFailed: false,
    skip: ["TestCustomer"],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--retry-failed") opts.retryFailed = true;
    else if (a === "--only") opts.only = argv[++i] ?? null;
    else if (a === "--folder") opts.folder = argv[++i] ?? null;
    else if (a === "--skip") opts.skip = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--concurrency") opts.concurrency = Math.min(Math.max(Number(argv[++i]) || 6, 1), 12);
    else if (a === "--help" || a === "-h") {
      console.log(
        "Options: --dry-run  --yes  --only \"<Customer folder>\"  --skip \"<Folder>,<Folder>\" (default TestCustomer)\n" +
          "         --folder \"<Drive folder link or id>\"  --concurrency N  --retry-failed  --reset-google",
      );
      process.exit(0);
    } else {
      console.error(`Unknown option: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

// â”€â”€ rclone (Google Drive, read-only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function rclone(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const full = [...(RCLONE_CONF ? ["--config", RCLONE_CONF] : []), ...args];
    const child = spawn(RCLONE, full, { windowsHide: true });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      if (err.length > 4000) err = err.slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`rclone ${args[0]} failed (exit ${code}): ${lastLines(err)}`));
    });
  });
}

function lastLines(text: string): string {
  return text.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 400);
}

type DriveListing = { Path: string; Name: string; Size: number; MimeType: string; ModTime: string; IsDir: boolean; ID?: string };

async function rootFolderId(folderArg: string | null): Promise<{ id: string; name: string }> {
  if (folderArg) {
    const m = folderArg.match(/\/folders\/([A-Za-z0-9_-]{10,})/) || folderArg.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
    const id = m ? m[1] : folderArg.trim();
    if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) throw new Error(`Not a Drive folder link or id: ${folderArg}`);
    return { id, name: id };
  }
  const cached = join(TOOL_HOME, "root-folder.json");
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, "utf8"));
  const shared = JSON.parse(
    (await rclone(["lsjson", `${REMOTE}:`, "--drive-shared-with-me", "--dirs-only"])).toString("utf8"),
  ) as DriveListing[];
  const ace = shared.filter((d) => d.Name.trim().toUpperCase() === "ACE");
  if (ace.length !== 1 || !ace[0].ID) {
    throw new Error(
      ace.length === 0
        ? `No "ACE" folder found in this Google account's "Shared with me". Re-run with --reset-google and sign in with the right account, or pass --folder "<link>".`
        : `Found ${ace.length} "ACE" folders in "Shared with me". Pass --folder "<link of the right one>".`,
    );
  }
  const root = { id: ace[0].ID, name: ace[0].Name };
  writeFileSync(cached, JSON.stringify(root));
  return root;
}

function remotePath(rootId: string, subPath: string): string[] {
  return ["--drive-root-folder-id", rootId, `${REMOTE}:${subPath}`];
}

async function listDrive(rootId: string, only: string | null): Promise<DriveListing[]> {
  const base = only ? only.replace(/^\/+|\/+$/g, "") : "";
  const [flagA, flagB, target] = remotePath(rootId, base);
  const raw = await rclone(["lsjson", "-R", "--files-only", "--fast-list", flagA, flagB, target]);
  const files = JSON.parse(raw.toString("utf8")) as DriveListing[];
  return files.map((f) => ({ ...f, Path: base ? `${base}/${f.Path}` : f.Path }));
}

/**
 * One long-lived `rclone serve http` keeps Drive folder listings cached, so each download
 * is a single Drive request instead of a fresh process re-walking Customer/Dept/WO.
 */
let driveServer: { base: string; proc: ReturnType<typeof spawn> } | null = null;

async function freePort(): Promise<number> {
  const { createServer } = await import("net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

async function startDriveServer(rootId: string): Promise<void> {
  const port = await freePort();
  const proc = spawn(
    RCLONE,
    [
      ...(RCLONE_CONF ? ["--config", RCLONE_CONF] : []),
      "serve", "http", `${REMOTE}:`,
      "--drive-root-folder-id", rootId,
      "--addr", `127.0.0.1:${port}`,
      "--read-only",
      "--dir-cache-time", "24h",
      "--vfs-cache-mode", "off",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  proc.unref();
  process.on("exit", () => proc.kill());
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const res = await fetch(`${base}/`, { method: "HEAD" });
      if (res.ok) {
        driveServer = { base, proc };
        return;
      }
    } catch {
      /* not up yet */
    }
  }
  proc.kill();
}

async function downloadDrive(rootId: string, file: PlanItem): Promise<Buffer> {
  if (driveServer && !file.duplicatePath) {
    const url = `${driveServer.base}/${file.drivePath.split("/").map(encodeURIComponent).join("/")}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (res.ok) {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (file.size <= 0 || bytes.length === file.size) return bytes;
    } else {
      await res.text().catch(() => "");
    }
  }
  if (file.duplicatePath && file.driveId) {
    // Same path twice in Drive: fetch the exact file by id.
    const tmpDir = join(TOOL_HOME, "tmp");
    mkdirSync(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `${file.driveId}.bin`);
    await rclone(["backend", "copyid", "--drive-root-folder-id", rootId, `${REMOTE}:`, file.driveId, tmp]);
    const bytes = readFileSync(tmp);
    rmSync(tmp, { force: true });
    return bytes;
  }
  const [flagA, flagB, target] = remotePath(rootId, file.drivePath);
  return rclone(["cat", flagA, flagB, target]);
}

// â”€â”€ Plan â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type PlanItem = {
  key: string;
  driveId: string | null;
  drivePath: string;
  duplicatePath: boolean;
  size: number;
  kind: "mapped" | "old_photos" | "skipped";
  dept: Department | null;
  customer: string | null;
  targetFolder: string;
  fileName: string;
  skipReason?: string;
};

async function buildPlan(files: DriveListing[], skipTopLevel: string[]) {
  const skipKeys = new Set(skipTopLevel.map(nameKey).filter(Boolean));
  const existingByDept: Record<string, string[]> = {};
  for (const dept of DEPARTMENTS) existingByDept[dept] = await sp.listSharePointSubfolders(dept);
  const { renames, conflicts } = planRenames(existingByDept);
  const afterRename: Record<string, string[]> = {};
  for (const dept of DEPARTMENTS) {
    afterRename[dept] = existingByDept[dept].map((n) => renames.find((r) => r.dept === dept && r.from === n)?.to ?? n);
  }

  const sorted = [...files].sort((a, b) => a.Path.localeCompare(b.Path) || (a.ID ?? "").localeCompare(b.ID ?? ""));
  const pathCount = new Map<string, number>();
  for (const f of sorted) pathCount.set(f.Path, (pathCount.get(f.Path) ?? 0) + 1);

  const taken = new Set<string>();
  const items: PlanItem[] = [];
  for (const f of sorted) {
    const parts = f.Path.split("/");
    const name = parts.pop()!;
    const base = {
      key: f.ID || f.Path,
      driveId: f.ID ?? null,
      drivePath: f.Path,
      duplicatePath: (pathCount.get(f.Path) ?? 0) > 1,
      size: Math.max(f.Size, 0),
    };
    const cls = classifyDriveFile(name, f.MimeType);
    const skipReason = !cls.copy ? cls.reason : parts.length > 0 && skipKeys.has(nameKey(parts[0])) ? `Skipped folder (${parts[0]})` : null;
    if (skipReason) {
      items.push({ ...base, kind: "skipped", dept: null, customer: null, targetFolder: "", fileName: name, skipReason });
      continue;
    }
    const cleanName = normalizePhotoName(name, f.MimeType);
    const target = mapDrivePath(parts);
    if (target.kind === "mapped") {
      const resolved = resolveCustomerFolder(target.driveCustomer, afterRename[target.dept]);
      const folder = [target.dept, resolved.name, target.workOrder, ...target.subfolders].join("/");
      items.push({ ...base, kind: "mapped", dept: target.dept, customer: resolved.name, targetFolder: folder, fileName: uniqueFileName(folder, cleanName, taken) });
    } else {
      items.push({ ...base, kind: "old_photos", dept: null, customer: null, targetFolder: target.folder, fileName: uniqueFileName(target.folder, cleanName, taken) });
    }
  }
  return { items, renames, conflicts, existingByDept: afterRename };
}

// â”€â”€ State (resume) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type ItemState = { status: "done" | "exists" | "failed"; target: string; error?: string; at: string };

function loadState(file: string): Map<string, ItemState> {
  const state = new Map<string, ItemState>();
  if (!existsSync(file)) return state;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as ItemState & { key: string };
      state.set(row.key, row);
    } catch {
      /* partial last line after a crash */
    }
  }
  return state;
}

// â”€â”€ Progress bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "--";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

class Progress {
  private started = Date.now();
  private bytesThisRun = 0;
  private timer: NodeJS.Timeout | null = null;
  done = 0;
  exists = 0;
  failed = 0;
  blocked = 0;
  bytes = 0;

  constructor(
    private total: number,
    private totalBytes: number,
  ) {}

  start() {
    this.timer = setInterval(() => this.render(), 250);
    this.render();
  }

  add(kind: "done" | "exists" | "failed" | "blocked", size: number, fromEarlierRun = false) {
    this[kind]++;
    this.bytes += size;
    if (kind === "done" && !fromEarlierRun) this.bytesThisRun += size;
  }

  log(line: string) {
    process.stdout.write(process.stdout.isTTY ? `\r\x1b[2K${line}\n` : `${line}\n`);
    this.render();
  }

  render() {
    const finished = this.done + this.exists + this.failed + this.blocked;
    const pct = this.total ? finished / this.total : 1;
    const width = 30;
    const fill = Math.round(pct * width);
    const elapsed = (Date.now() - this.started) / 1000;
    const rate = this.bytesThisRun / Math.max(elapsed, 1);
    const left = rate > 0 ? (this.totalBytes - this.bytes) / rate : NaN;
    const bar = `[${"â–ˆ".repeat(fill)}${"â–‘".repeat(width - fill)}] ${(pct * 100).toFixed(1)}%`;
    const line =
      `${bar}  ${finished}/${this.total} files  ${fmtBytes(this.bytes)}/${fmtBytes(this.totalBytes)}  ` +
      `${fmtBytes(rate)}/s  ETA ${fmtDuration(left)}  âœ” ${this.done} new  â†º ${this.exists} already there` +
      (this.blocked ? `  â›” ${this.blocked} blocked` : "") +
      `  âœ– ${this.failed} failed`;
    if (!process.stdout.isTTY) {
      if (Date.now() - this.lastPlain < 10_000 && finished < this.total) return;
      this.lastPlain = Date.now();
      process.stdout.write(`${line}\n`);
      return;
    }
    const cols = process.stdout.columns || 160;
    process.stdout.write(`\r\x1b[2K${line.slice(0, cols - 1)}`);
  }

  private lastPlain = 0;

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.render();
    process.stdout.write("\n");
  }
}

// â”€â”€ Copy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const RETRY_DELAYS_S = [5, 15, 45, 120];

function isPermanent(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(400|404)\b|not found|directory not found|object not found|Invalid/i.test(msg) && !/429|503|throttl/i.test(msg);
}

const LOCKED_RE = /checked out by another user|\b423\b|resourceLocked/i;

type CopyResult = "done" | "exists" | "blocked";

async function copyOne(
  rootId: string,
  item: PlanItem,
  sweep: (folder: string) => Promise<void>,
  blockedFolders: Set<string>,
): Promise<CopyResult> {
  const target = `${item.targetFolder}/${item.fileName}`;
  await sweep(item.targetFolder);
  const existing = await sp.lookupSharePointFile(target);
  if (existing) {
    if (existing.checkedOut) await sp.checkInAnyCheckout(existing.id, `Drive migration: ${item.fileName}`);
    return "exists";
  }
  if (blockedFolders.has(item.targetFolder)) return "blocked";
  const bytes = await downloadDrive(rootId, item);
  let itemId: string;
  try {
    itemId = (await sp.uploadFileToSharePointFolder(item.targetFolder, item.fileName, bytes)).itemId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (LOCKED_RE.test(msg)) {
      blockedFolders.add(item.targetFolder);
      return "blocked";
    }
    if (!(err instanceof sp.SharePointCheckinError)) throw err;
    itemId = err.itemId;
    let checkedIn = false;
    for (const wait of [5, 20, 60]) {
      await sleep(wait * 1000);
      try {
        await sp.retryCheckIn(err.itemId, err.path);
        checkedIn = true;
        break;
      } catch {
        /* try again */
      }
    }
    if (!checkedIn) throw err;
  }
  // A hidden file with this name makes SharePoint save ours as "name (1)": undo that.
  if (!(await sp.lookupSharePointFile(target))) {
    await sp.deleteSharePointItem(itemId);
    blockedFolders.add(item.targetFolder);
    return "blocked";
  }
  return "done";
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) await fn(items[index++]);
    }),
  );
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((r) => rl.question(question, r));
  rl.close();
  return answer.trim().toLowerCase();
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file: string, header: string[], rows: unknown[][]): void {
  writeFileSync(file, "\uFEFF" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n"), "utf8");
}

function acquireRunLock(): void {
  const lock = join(TOOL_HOME, "running.pid");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = pid !== process.pid;
    } catch {
      /* stale lock */
    }
    if (alive) throw new Error(`Another copy is already running (process ${pid}). Close it first.`);
  }
  writeFileSync(lock, String(process.pid));
  process.on("exit", () => rmSync(lock, { force: true }));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const reportsDir = join(TOOL_HOME, "reports");
  mkdirSync(reportsDir, { recursive: true });
  if (!opts.dryRun) acquireRunLock();
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);

  console.log("Checking SharePoint access...");
  const probe = await sp.probeSharePointAccess();
  if (!probe.ok) throw new Error(`SharePoint not reachable: ${probe.error}`);

  console.log("Finding the ACE folder in Google Drive...");
  const root = await rootFolderId(opts.folder);

  const scanStart = Date.now();
  const spinner = setInterval(() => {
    if (!process.stdout.isTTY) return;
    process.stdout.write(`\r\x1b[2KListing Google Drive${opts.only ? ` (${opts.only})` : ""}... ${fmtDuration((Date.now() - scanStart) / 1000)}`);
  }, 500);
  let files: DriveListing[];
  try {
    files = await listDrive(root.id, opts.only);
  } finally {
    clearInterval(spinner);
    if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
  }
  console.log(`Found ${files.length} files in Drive (${fmtDuration((Date.now() - scanStart) / 1000)}).`);

  console.log("Matching customer folders in SharePoint...");
  const plan = await buildPlan(files, opts.skip);
  const { items, conflicts } = plan;
  // Only rename "&amp;" folders this run actually writes into.
  const renames = plan.renames.filter((r) => items.some((i) => i.kind === "mapped" && i.dept === r.dept && i.customer === r.to));

  const toCopy = items.filter((i) => i.kind !== "skipped");
  const skipped = items.filter((i) => i.kind === "skipped");
  const stateFile = join(TOOL_HOME, `state-${root.id}.jsonl`);
  const state = loadState(stateFile);
  if (opts.retryFailed) for (const [k, v] of state) if (v.status === "failed") state.delete(k);
  const finishedBefore = toCopy.filter((i) => {
    const s = state.get(i.key);
    return s && s.status !== "failed" && s.target === `${i.targetFolder}/${i.fileName}`;
  });
  const failedBefore = toCopy.filter((i) => state.get(i.key)?.status === "failed");
  const work = toCopy.filter((i) => !finishedBefore.includes(i) && !failedBefore.includes(i));

  // â”€â”€ Hidden checkouts: files someone checked out and never checked in. SharePoint hides
  // them, but they still own their names, so copying into those folders is unsafe.
  const workFolders = [...new Set(work.map((i) => i.targetFolder))];
  const hiddenByFolder = new Map<string, number>();
  let checkedFolders = 0;
  await mapLimit(workFolders, 8, async (folder) => {
    const n = await sp.countHiddenCheckouts(folder);
    if (n > 0) hiddenByFolder.set(folder, n);
    checkedFolders++;
    if (process.stdout.isTTY) process.stdout.write(`\r\x1b[2KChecking SharePoint folders for hidden checked-out files... ${checkedFolders}/${workFolders.length}`);
  });
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
  const hiddenTotal = [...hiddenByFolder.values()].reduce((a, b) => a + b, 0);
  let unlockable: sp.HiddenCheckout[] | null = null;
  if (hiddenTotal > 0) {
    const all = await sp.listHiddenCheckouts();
    unlockable = all && all.filter((h) => hiddenByFolder.has(h.path.slice(0, h.path.lastIndexOf("/"))));
  }

  // â”€â”€ Dry-run summary
  const byDept: Record<string, number> = {};
  const newCustomers = new Set<string>();
  const oldFolders = new Map<string, number>();
  const skipReasons = new Map<string, number>();
  const extCount = new Map<string, number>();
  for (const i of toCopy) {
    const ext = (i.fileName.split(".").pop() || "").toLowerCase();
    extCount.set(ext, (extCount.get(ext) ?? 0) + 1);
    if (i.kind === "mapped") {
      byDept[i.dept!] = (byDept[i.dept!] ?? 0) + 1;
    } else {
      const g = i.targetFolder.split("/").slice(0, 3).join("/");
      oldFolders.set(g, (oldFolders.get(g) ?? 0) + 1);
    }
  }
  const existingNow: Record<string, Set<string>> = {};
  for (const dept of DEPARTMENTS) existingNow[dept] = new Set((await sp.listSharePointSubfolders(dept)).map((n) => n.toLowerCase()));
  for (const i of toCopy) {
    if (i.kind === "mapped" && !existingNow[i.dept!].has(i.customer!.toLowerCase()) && !renames.some((r) => r.dept === i.dept && r.to === i.customer)) {
      newCustomers.add(`${i.dept}/${i.customer}`);
    }
  }
  for (const i of skipped) skipReasons.set(i.skipReason!, (skipReasons.get(i.skipReason!) ?? 0) + 1);
  const totalBytes = toCopy.reduce((s, i) => s + i.size, 0);

  console.log("");
  console.log("â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• PLAN â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•");
  console.log(`Drive folder:        ${root.name}${opts.only ? ` / ${opts.only}` : ""}`);
  console.log(`Photos to copy:      ${toCopy.length}  (${fmtBytes(totalBytes)})`);
  for (const dept of DEPARTMENTS) if (byDept[dept]) console.log(`   ${dept.padEnd(16)} ${byDept[dept]}`);
  if (oldFolders.size) console.log(`   ${"Old Photos".padEnd(16)} ${toCopy.length - Object.values(byDept).reduce((a, b) => a + b, 0)}  (folders that don't match Customer/Dept/WO)`);
  console.log(`File types:          ${[...extCount.entries()].sort((a, b) => b[1] - a[1]).map(([e, n]) => `.${e} ${n}`).join(", ")}`);
  console.log(`New customer folders:${String(newCustomers.size).padStart(4)}`);
  if (renames.length) console.log(`Folder renames:      ${renames.length}  (${renames.slice(0, 3).map((r) => `${r.dept}/${r.from} â†’ ${r.to}`).join("; ")}${renames.length > 3 ? "; â€¦" : ""})`);
  if (conflicts.length) console.log(`Rename conflicts:    ${conflicts.length}  (both "&amp;" and "&" folders exist â€” left as they are)`);
  const renamedFiles = toCopy.filter((i) => i.fileName !== i.drivePath.split("/").pop());
  if (renamedFiles.length) console.log(`Renamed files:       ${renamedFiles.length}  (duplicate names get " (2)"; text after ".jpg" moved before it)`);
  if (skipped.length) console.log(`Skipped:             ${skipped.length}  (${[...skipReasons.entries()].map(([r, n]) => `${r}: ${n}`).join("; ")})`);
  if (finishedBefore.length) console.log(`Already copied in an earlier run: ${finishedBefore.length}`);
  if (failedBefore.length) console.log(`Failed in an earlier run: ${failedBefore.length}  (re-run with --retry-failed)`);
  console.log(`Left to copy now:    ${work.length}`);
  const blockedPhotos = work.filter((i) => hiddenByFolder.has(i.targetFolder)).length;
  if (hiddenTotal > 0) {
    console.log("");
    console.log(`âš  ${hiddenTotal} files in ${hiddenByFolder.size} of these SharePoint folders are checked out to someone and were`);
    console.log("  never checked in, so SharePoint hides them (probably an earlier copy of these same photos).");
    if (unlockable) {
      const byUser = new Map<string, number>();
      for (const h of unlockable) byUser.set(h.checkedOutBy, (byUser.get(h.checkedOutBy) ?? 0) + 1);
      console.log(`  They will be taken over and checked in first (${[...byUser].map(([u, n]) => `${u}: ${n}`).join(", ")}).`);
    } else {
      console.log(`  The app can't unlock them (it needs Full Control on the site), so ${blockedPhotos} photos in those`);
      console.log("  folders will be held back. Everything else is copied. See README â†’ 'Hidden checked-out files'.");
    }
  }
  console.log("â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•");
  if (hiddenByFolder.size) {
    const hiddenCsv = join(reportsDir, `hidden-checkouts-${stamp}.csv`);
    writeCsv(hiddenCsv, ["SharePoint folder", "Hidden files"], [...hiddenByFolder].sort().map(([f, n]) => [f, n]));
    console.log(`Folders with hidden files: ${hiddenCsv}`);
  }

  const planCsv = join(reportsDir, `plan-${stamp}.csv`);
  writeCsv(
    planCsv,
    ["Drive path", "Action", "SharePoint folder", "File name", "Size (bytes)", "Note"],
    items.map((i) => [
      i.drivePath,
      i.kind === "skipped" ? "skip" : i.kind === "old_photos" ? "copy â†’ Old Photos" : "copy",
      i.targetFolder,
      i.fileName,
      i.size,
      i.skipReason ?? state.get(i.key)?.status ?? "",
    ]),
  );
  console.log(`Full plan (open in Excel): ${planCsv}`);

  if (opts.dryRun) return;
  if (work.length === 0) {
    console.log("Nothing left to copy.");
    return;
  }
  if (!opts.yes) {
    const answer = await ask(`\nStart copying ${work.length} photos to SharePoint now? (y/N) `);
    if (answer !== "y" && answer !== "yes") {
      console.log("Stopped. Nothing was copied.");
      return;
    }
  }

  for (const r of renames) {
    try {
      await sp.renameSharePointFolder(`${r.dept}/${r.from}`, r.to);
      console.log(`Renamed ${r.dept}/${r.from} â†’ ${r.to}`);
    } catch (err) {
      console.warn(`Rename failed (${r.dept}/${r.from}): ${(err as Error).message}`);
    }
  }

  const blockedFolders = new Set(hiddenByFolder.keys());
  if (unlockable?.length) {
    let unlocked = 0;
    let unlockFailed = 0;
    await mapLimit(unlockable, 4, async (h) => {
      try {
        await sp.takeOverAndCheckIn(h.path, "Drive migration: check in file left checked out");
        unlocked++;
      } catch (err) {
        unlockFailed++;
        if (unlockFailed <= 5) console.warn(`\nCould not unlock ${h.path}: ${(err as Error).message}`);
      }
      if (process.stdout.isTTY) process.stdout.write(`\r\x1b[2KChecking in hidden files... ${unlocked + unlockFailed}/${unlockable!.length}`);
    });
    console.log(`\nChecked in ${unlocked} hidden files${unlockFailed ? ` (${unlockFailed} failed)` : ""}.`);
    for (const folder of [...blockedFolders]) {
      if ((await sp.countHiddenCheckouts(folder)) === 0) blockedFolders.delete(folder);
    }
  }

  const swept = new Map<string, Promise<void>>();
  let leftoverCheckins = 0;
  const sweep = (folder: string) => {
    if (!swept.has(folder)) {
      swept.set(
        folder,
        sp
          .checkInFolderCheckouts(folder)
          .then((r) => {
            leftoverCheckins += r.checkedIn;
          })
          .catch(() => {
            swept.delete(folder);
          }),
      );
    }
    return swept.get(folder)!;
  };

  const progress = new Progress(work.length + finishedBefore.length, totalBytes - failedBefore.reduce((s, i) => s + i.size, 0));
  for (const i of finishedBefore) progress.add(state.get(i.key)!.status === "done" ? "done" : "exists", i.size, true);
  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    progress.log("Stopping after the files in progress finish... (Ctrl+C again to quit now)");
  });

  const failures: { item: PlanItem; error: string }[] = [];
  const blockedItems: PlanItem[] = [];
  const record = (item: PlanItem, status: ItemState["status"], error?: string) => {
    appendFileSync(
      stateFile,
      JSON.stringify({ key: item.key, status, target: `${item.targetFolder}/${item.fileName}`, error, at: new Date().toISOString() }) + "\n",
    );
  };

  await startDriveServer(root.id);
  progress.start();
  let next = 0;
  const worker = async () => {
    while (!stopping && next < work.length) {
      const item = work[next++];
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await copyOne(root.id, item, sweep, blockedFolders);
          if (result === "blocked") blockedItems.push(item);
          else record(item, result);
          progress.add(result, item.size);
          break;
        } catch (err) {
          const msg = (err instanceof Error ? err.message : String(err)).slice(0, 400);
          if (isPermanent(err) || attempt >= RETRY_DELAYS_S.length) {
            record(item, "failed", msg);
            failures.push({ item, error: msg });
            progress.add("failed", item.size);
            progress.log(`âœ– ${item.drivePath}: ${msg}`);
            break;
          }
          await sleep(RETRY_DELAYS_S[attempt] * 1000);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, worker));
  progress.stop();

  console.log("");
  console.log(
    `Copied & checked in: ${progress.done}   Already in SharePoint: ${progress.exists}   ` +
      `Held back (hidden checkouts): ${progress.blocked}   Failed: ${progress.failed}`,
  );
  if (leftoverCheckins) console.log(`Also checked in ${leftoverCheckins} files that were left checked out in those folders.`);
  if (blockedItems.length) {
    const blockedCsv = join(reportsDir, `held-back-${stamp}.csv`);
    writeCsv(blockedCsv, ["Drive path", "SharePoint target"], blockedItems.map((i) => [i.drivePath, `${i.targetFolder}/${i.fileName}`]));
    console.log(`Held back: ${blockedCsv}`);
    console.log("Once those hidden files are checked in (README â†’ 'Hidden checked-out files'), run this again â€” it only copies what's missing.");
  }
  if (failures.length) {
    const failCsv = join(reportsDir, `failed-${stamp}.csv`);
    writeCsv(failCsv, ["Drive path", "SharePoint target", "Error"], failures.map((f) => [f.item.drivePath, `${f.item.targetFolder}/${f.item.fileName}`, f.error]));
    console.log(`Failed files: ${failCsv}`);
    console.log("Run again with --retry-failed to try them again.");
  }
  if (stopping) console.log("Stopped early â€” run again to continue where it left off.");
  process.exitCode = failures.length ? 1 : 0;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
