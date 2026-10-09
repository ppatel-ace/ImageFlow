import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowDown, ArrowUp, ArrowUpDown, ExternalLink, Loader2, Pause, Play, RotateCw, ScanSearch, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";

type PlannedRename = { dept: string; from: string; to: string };
type Plan = {
  rootName: string;
  totals: { files: number; photos: number; mapped: number; oldPhotos: number; skipped: number; bytes: number };
  byDept: Record<string, number>;
  customers: { drive: string; dept: string; target: string; existing: boolean; files: number }[];
  oldPhotoFolders: { path: string; files: number }[];
  skippedReasons: Record<string, number>;
  skippedTopLevel: string[];
  renames: PlannedRename[];
  renameConflicts: PlannedRename[];
  renameResults?: (PlannedRename & { ok: boolean; error?: string })[];
  scanErrors: string[];
};
type Run = {
  id: string;
  status: "scanning" | "scanned" | "running" | "paused" | "completed" | "failed" | "cancelled";
  root_folder_id: string;
  root_folder_name: string | null;
  plan: Plan | null;
  error: string | null;
  cleanup_checked_in: number;
  cleanup_failed: number;
  started_by: string;
  created_at: string;
  counts: Record<string, number>;
  bytesCopied: number;
};
type Overview = {
  drive: { configured: boolean; serviceAccountEmail: string | null };
  defaultRootFolderId: string | null;
  databaseConfigured: boolean;
  workerActive: boolean;
  concurrency: number;
  run: Run | null;
};
type Item = {
  id: string;
  drive_path: string;
  kind: string;
  target_folder: string | null;
  file_name: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  size_bytes: string | null;
  web_url: string | null;
  updated_at: string;
};

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error || `${res.status} ${res.statusText}`), { status: res.status });
  return data as T;
}

function mb(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Waiting",
  copying: "Copying",
  done: "Copied + checked in",
  exists: "Already in SharePoint",
  skipped: "Skipped (not a photo)",
  failed: "Failed",
};

const RUN_LABEL: Record<Run["status"], string> = {
  scanning: "Scanning Google Drive…",
  scanned: "Dry run ready — review, then Start",
  running: "Copying",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

type SortKey = "drive_path" | "target" | "status" | "size" | "attempts" | "updated";

export default function DriveMigrationPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [rootFolder, setRootFolder] = useState("");
  const [skipFolders, setSkipFolders] = useState("TestCustomer");
  const [busy, setBusy] = useState<string | null>(null);

  const overview = useQuery<Overview, Error & { status?: number }>({
    queryKey: ["drive-migration"],
    queryFn: () => call<Overview>("GET", "/api/admin/drive-migration"),
    refetchInterval: (q) => {
      const s = q.state.data?.run?.status;
      return s === "scanning" || s === "running" ? 4000 : false;
    },
  });
  const run = overview.data?.run ?? null;

  useEffect(() => {
    if (!rootFolder && overview.data?.defaultRootFolderId) setRootFolder(overview.data.defaultRootFolderId);
  }, [overview.data?.defaultRootFolderId, rootFolder]);

  const act = async (label: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(label);
    try {
      await fn();
      toast({ title: success });
      await queryClient.invalidateQueries({ queryKey: ["drive-migration"] });
      await queryClient.invalidateQueries({ queryKey: ["drive-migration-items"] });
    } catch (err) {
      toast({ title: `${label} failed`, description: (err as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  if (overview.error?.status === 403) {
    return (
      <Shell>
        <Card className="p-6 text-sm">Admin only. Ask IT to add you to an ImageFlow admin group.</Card>
      </Shell>
    );
  }
  if (overview.isLoading || !overview.data) {
    return (
      <Shell>
        <Card className="flex items-center gap-2 p-6 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </Card>
      </Shell>
    );
  }

  const { drive } = overview.data;
  const counts = run?.counts ?? {};
  const copyable = (counts.pending ?? 0) + (counts.copying ?? 0) + (counts.done ?? 0) + (counts.exists ?? 0) + (counts.failed ?? 0);
  const finished = (counts.done ?? 0) + (counts.exists ?? 0);
  const pct = copyable ? Math.round((finished / copyable) * 100) : 0;
  const canScan = drive.configured && run?.status !== "scanning" && run?.status !== "running";
  const canStart = run && ["scanned", "paused"].includes(run.status);

  return (
    <Shell>
      <Card className="space-y-3 p-4 sm:p-6">
        <h2 className="text-lg font-medium">1. Google Drive access</h2>
        {drive.configured ? (
          <p className="text-sm">
            Share the Google Drive <b>ACE</b> folder (Viewer) with{" "}
            <code className="rounded bg-muted px-1 py-0.5" data-testid="text-service-account">{drive.serviceAccountEmail}</code>. Drive is
            only read — nothing in Drive is changed or deleted.
          </p>
        ) : (
          <p className="text-sm text-red-600 dark:text-red-400">
            GOOGLE_SERVICE_ACCOUNT_JSON is not set on the server. Add the service-account key in Portainer and redeploy.
          </p>
        )}
      </Card>

      <Card className="space-y-3 p-4 sm:p-6">
        <h2 className="text-lg font-medium">2. Dry run</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="root-folder">Drive folder link or ID (the ACE folder)</Label>
            <Input
              id="root-folder"
              value={rootFolder}
              onChange={(e) => setRootFolder(e.target.value)}
              placeholder="https://drive.google.com/drive/folders/…"
              data-testid="input-root-folder"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="skip-folders">Top-level folders to skip (comma separated)</Label>
            <Input id="skip-folders" value={skipFolders} onChange={(e) => setSkipFolders(e.target.value)} data-testid="input-skip-folders" />
          </div>
        </div>
        <Button
          disabled={!canScan || !rootFolder.trim() || busy !== null}
          onClick={() =>
            act(
              "Scan",
              () =>
                call("POST", "/api/admin/drive-migration/scan", {
                  rootFolder,
                  skipFolders: skipFolders.split(",").map((s) => s.trim()).filter(Boolean),
                }),
              "Scan started",
            )
          }
          data-testid="button-scan"
        >
          <ScanSearch className="mr-2 h-4 w-4" />
          {run?.plan ? "Scan again" : "Scan Google Drive"}
        </Button>
      </Card>

      {run ? (
        <Card className="space-y-4 p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-medium">3. Migration — {run.root_folder_name ?? run.root_folder_id}</h2>
              <p className="text-sm text-muted-foreground" data-testid="text-run-status">
                {run.status === "scanning" || run.status === "running" ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : null}
                {RUN_LABEL[run.status]} · started by {run.started_by}
              </p>
            </div>
            <div className="flex gap-2">
              {canStart ? (
                <Button
                  disabled={busy !== null}
                  onClick={() => act("Start", () => call("POST", "/api/admin/drive-migration/start"), "Migration started")}
                  data-testid="button-start"
                >
                  <Play className="mr-2 h-4 w-4" />
                  {run.status === "paused" ? "Resume" : "Start copying"}
                </Button>
              ) : null}
              {run.status === "running" ? (
                <Button
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => act("Pause", () => call("POST", "/api/admin/drive-migration/pause"), "Paused after the current files")}
                  data-testid="button-pause"
                >
                  <Pause className="mr-2 h-4 w-4" /> Pause
                </Button>
              ) : null}
              {(counts.failed ?? 0) > 0 ? (
                <Button
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => act("Retry", () => call("POST", "/api/admin/drive-migration/retry-failed"), "Failed files queued again")}
                  data-testid="button-retry-failed"
                >
                  <RotateCw className="mr-2 h-4 w-4" /> Retry failed ({counts.failed})
                </Button>
              ) : null}
            </div>
          </div>

          {run.error ? <p className="text-sm text-red-600 dark:text-red-400">{run.error}</p> : null}

          {run.status !== "scanning" && run.plan ? (
            <>
              <div className="space-y-1">
                <Progress value={pct} />
                <p className="text-sm text-muted-foreground" data-testid="text-progress">
                  {finished.toLocaleString()} of {copyable.toLocaleString()} photos in SharePoint ({pct}%) · copied {counts.done ?? 0}, already there{" "}
                  {counts.exists ?? 0}, waiting {(counts.pending ?? 0) + (counts.copying ?? 0)}, failed {counts.failed ?? 0} · {mb(run.bytesCopied)} copied
                  {run.cleanup_checked_in || run.cleanup_failed
                    ? ` · checked in ${run.cleanup_checked_in} leftover file(s)${run.cleanup_failed ? `, ${run.cleanup_failed} could not be checked in` : ""}`
                    : ""}
                </p>
              </div>
              <PlanSummary plan={run.plan} />
            </>
          ) : null}
        </Card>
      ) : null}

      {run && run.status !== "scanning" ? <ItemsTable runId={run.id} live={run.status === "running"} /> : null}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Google Drive → SharePoint photo migration</h1>
        <Link href="/" className="text-sm text-primary underline">
          Back to ImageFlow
        </Link>
      </div>
      {children}
    </div>
  );
}

function PlanSummary({ plan }: { plan: Plan }) {
  const newCustomers = plan.customers.filter((c) => !c.existing);
  return (
    <div className="grid gap-4 text-sm lg:grid-cols-2">
      <div className="space-y-1">
        <h3 className="font-medium">What will be copied</h3>
        <p>
          {plan.totals.photos.toLocaleString()} photos ({mb(plan.totals.bytes)}) of {plan.totals.files.toLocaleString()} files.
        </p>
        <ul className="list-disc pl-5">
          {Object.entries(plan.byDept).map(([dept, n]) => (
            <li key={dept}>
              {dept}: {n.toLocaleString()} → <code>{dept}/Customer/Work order</code>
            </li>
          ))}
          <li>
            Old Photos: {plan.totals.oldPhotos.toLocaleString()} (folders that don't match Customer / Dept / Work order)
          </li>
          {Object.entries(plan.skippedReasons).map(([reason, n]) => (
            <li key={reason}>
              Skipped — {reason}: {n.toLocaleString()}
            </li>
          ))}
        </ul>
        {plan.skippedTopLevel.length ? <p>Skipped folders: {plan.skippedTopLevel.join(", ")}</p> : null}
        {plan.scanErrors.length ? (
          <p className="text-red-600 dark:text-red-400">Could not read {plan.scanErrors.length} folder(s): {plan.scanErrors.slice(0, 3).join(" · ")}</p>
        ) : null}
      </div>
      <div className="space-y-1">
        <h3 className="font-medium">Customer folders</h3>
        <p>
          {plan.customers.length - newCustomers.length} match existing SharePoint folders; {newCustomers.length} will be created
          {newCustomers.length ? `: ${newCustomers.slice(0, 12).map((c) => `${c.dept}/${c.target}`).join(", ")}${newCustomers.length > 12 ? "…" : ""}` : "."}
        </p>
        {plan.renames.length ? (
          <>
            <h3 className="pt-2 font-medium">Folder name fixes (on Start)</h3>
            <ul className="list-disc pl-5">
              {plan.renames.map((r) => {
                const result = plan.renameResults?.find((x) => x.dept === r.dept && x.from === r.from);
                return (
                  <li key={`${r.dept}/${r.from}`}>
                    {r.dept}/{r.from} → {r.to}
                    {result ? (result.ok ? " ✓" : ` — failed: ${result.error}`) : ""}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
        {plan.renameConflicts.length ? (
          <p className="text-amber-700 dark:text-amber-300">
            Both spellings already exist (photos go to the "&" one; merge manually):{" "}
            {plan.renameConflicts.map((r) => `${r.dept}/${r.from}`).join(", ")}
          </p>
        ) : null}
        {plan.oldPhotoFolders.length ? (
          <>
            <h3 className="pt-2 font-medium">Going to Old Photos</h3>
            <ul className="max-h-40 list-disc overflow-auto pl-5">
              {plan.oldPhotoFolders.map((f) => (
                <li key={f.path}>
                  {f.path} ({f.files})
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  );
}

function ItemsTable({ runId, live }: { runId: string; live: boolean }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState("all");
  const [kind, setKind] = useState("all");
  const [sort, setSort] = useState<SortKey>("drive_path");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const pageSize = 50;

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => setPage(1), [debounced, status, kind, sort, dir]);

  const params = useMemo(() => {
    const p = new URLSearchParams({ sort, dir, page: String(page), pageSize: String(pageSize) });
    if (debounced.trim()) p.set("q", debounced.trim());
    if (status !== "all") p.set("status", status);
    if (kind !== "all") p.set("kind", kind);
    return p.toString();
  }, [debounced, status, kind, sort, dir, page]);

  const items = useQuery<{ items: Item[]; total: number }>({
    queryKey: ["drive-migration-items", runId, params],
    queryFn: () => call("GET", `/api/admin/drive-migration/items?${params}`),
    refetchInterval: live ? 5000 : false,
  });
  const total = items.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  const header = (key: SortKey, label: string) => (
    <TableHead>
      <button
        type="button"
        className="inline-flex items-center gap-1"
        onClick={() => {
          if (sort === key) setDir(dir === "asc" ? "desc" : "asc");
          else {
            setSort(key);
            setDir("asc");
          }
        }}
        data-testid={`sort-${key}`}
      >
        {label}
        {sort !== key ? <ArrowUpDown className="h-3 w-3 opacity-50" /> : dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
      </button>
    </TableHead>
  );

  return (
    <Card className="space-y-3 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[16rem] flex-1">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search Drive path, SharePoint folder, file name or error"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            data-testid="input-items-search"
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-48" data-testid="select-items-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {Object.entries(STATUS_LABEL).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-44" data-testid="select-items-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All destinations</SelectItem>
            <SelectItem value="mapped">Dept / Customer / WO</SelectItem>
            <SelectItem value="old_photos">Old Photos</SelectItem>
            <SelectItem value="not_photo">Not a photo</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">{total.toLocaleString()} files</span>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {header("drive_path", "Google Drive path")}
              {header("target", "SharePoint location")}
              {header("status", "Status")}
              {header("size", "Size")}
              {header("attempts", "Tries")}
              {header("updated", "Updated")}
            </TableRow>
          </TableHeader>
          <TableBody>
            {(items.data?.items ?? []).map((it) => (
              <TableRow key={it.id}>
                <TableCell className="max-w-[18rem] break-all text-xs">{it.drive_path}</TableCell>
                <TableCell className="max-w-[18rem] break-all text-xs">
                  {it.target_folder ? `${it.target_folder}/${it.file_name}` : "—"}
                  {it.web_url ? (
                    <a href={it.web_url} target="_blank" rel="noreferrer" className="ml-1 inline-flex text-primary" aria-label="Open in SharePoint">
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : null}
                </TableCell>
                <TableCell className="text-xs">
                  {STATUS_LABEL[it.status] ?? it.status}
                  {it.last_error ? <div className="text-muted-foreground">{it.last_error}</div> : null}
                </TableCell>
                <TableCell className="text-xs">{it.size_bytes ? mb(Number(it.size_bytes)) : "—"}</TableCell>
                <TableCell className="text-xs">{it.attempts}</TableCell>
                <TableCell className="text-xs">{new Date(it.updated_at).toLocaleString()}</TableCell>
              </TableRow>
            ))}
            {items.data && items.data.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                  No files match.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-end gap-2 text-sm">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)} data-testid="button-items-prev">
          Previous
        </Button>
        <span>
          Page {page} of {pages}
        </span>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)} data-testid="button-items-next">
          Next
        </Button>
      </div>
    </Card>
  );
}
