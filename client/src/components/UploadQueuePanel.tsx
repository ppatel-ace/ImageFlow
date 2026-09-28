import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, CloudUpload, Loader2, RotateCw, Search, Trash2, TriangleAlert, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useUploadQueue } from "@/hooks/use-upload-queue";
import {
  clearFinished,
  kickUploadRunner,
  removePhoto,
  retryPhoto,
  type QueuedPhoto,
} from "@/lib/uploadQueue";

type Filter = "active" | "failed" | "done" | "all";

function statusLabel(p: QueuedPhoto): { text: string; tone: "muted" | "busy" | "ok" | "warn" | "bad" } {
  switch (p.status) {
    case "queued":
      return p.attempts > 0
        ? { text: `Retrying (${p.attempts})`, tone: "warn" }
        : { text: "Queued", tone: "muted" };
    case "sending":
      return { text: "Sending", tone: "busy" };
    case "staged":
      return { text: "On server", tone: "busy" };
    case "uploading":
      return { text: "To SharePoint", tone: "busy" };
    case "done":
      return { text: "In SharePoint", tone: "ok" };
    case "failed":
      return { text: "Failed", tone: "bad" };
    default:
      return { text: p.status, tone: "muted" };
  }
}

const toneClass: Record<string, string> = {
  muted: "bg-muted text-muted-foreground",
  busy: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  ok: "bg-green-500/15 text-green-700 dark:text-green-300",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  bad: "bg-destructive/15 text-destructive",
};

function isActive(p: QueuedPhoto): boolean {
  return p.status !== "done" && p.status !== "failed";
}

function Thumb({ photo }: { photo: QueuedPhoto }) {
  const [url, setUrl] = useState<string | null>(null);
  const source = photo.thumb ?? photo.blob;
  useEffect(() => {
    if (!source) return;
    const next = URL.createObjectURL(source);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [source]);
  return (
    <div className="h-14 w-14 shrink-0 overflow-hidden rounded-md bg-muted">
      {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : null}
    </div>
  );
}

export default function UploadQueuePanel() {
  const items = useUploadQueue();
  const [filter, setFilter] = useState<Filter>("active");
  const [search, setSearch] = useState("");
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  const counts = useMemo(
    () => ({
      active: items.filter(isActive).length,
      failed: items.filter((p) => p.status === "failed").length,
      done: items.filter((p) => p.status === "done").length,
      all: items.length,
    }),
    [items],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter((p) =>
        filter === "all"
          ? true
          : filter === "active"
            ? isActive(p)
            : p.status === filter,
      )
      .filter((p) => {
        if (!q) return true;
        const m = p.meta;
        return [m?.imageName, m?.workOrderNumber, m?.customerName, m?.partNumber, m?.dept, p.lastError]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q));
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [items, filter, search]);

  if (items.length === 0) return null;

  const filters: { id: Filter; label: string }[] = [
    { id: "active", label: "In progress" },
    { id: "failed", label: "Failed" },
    { id: "done", label: "Done" },
    { id: "all", label: "All" },
  ];

  return (
    <Card className="p-4 sm:p-6" data-testid="upload-queue-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CloudUpload className="h-5 w-5 text-primary" />
          <h3 className="text-base font-medium sm:text-lg">Upload Queue</h3>
          {counts.active > 0 ? (
            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
              {counts.active} in progress
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {counts.done > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void clearFinished()}
              data-testid="button-queue-clear-done"
            >
              Clear finished
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => kickUploadRunner()}
            data-testid="button-queue-sync"
          >
            <RotateCw className="mr-1 h-4 w-4" />
            Sync now
          </Button>
        </div>
      </div>

      {!online ? (
        <p className="mt-3 flex items-center gap-2 rounded-md bg-amber-500/15 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          <WifiOff className="h-4 w-4" />
          Offline — photos are saved on this device and will upload automatically when the connection returns.
        </p>
      ) : null}

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, work order, customer, part…"
            className="h-10 pl-8"
            data-testid="input-queue-search"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {filters.map((f) => (
            <Button
              key={f.id}
              type="button"
              size="sm"
              variant={filter === f.id ? "default" : "outline"}
              onClick={() => setFilter(f.id)}
              data-testid={`button-queue-filter-${f.id}`}
            >
              {f.label} ({counts[f.id]})
            </Button>
          ))}
        </div>
      </div>

      <ul className="mt-3 max-h-[28rem] divide-y divide-border overflow-auto">
        {visible.length === 0 ? (
          <li className="py-6 text-center text-sm text-muted-foreground">Nothing here.</li>
        ) : (
          visible.map((p) => {
            const label = statusLabel(p);
            const canRetry = p.status === "failed" || (p.status === "queued" && p.attempts > 0);
            const canRemove = p.status !== "sending" && p.status !== "uploading";
            return (
              <li key={p.id} className="flex items-center gap-3 py-2.5">
                <Thumb photo={p} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm text-foreground" title={p.meta?.imageName}>
                    {p.meta?.imageName ?? p.nameStem}.{p.ext}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {p.meta ? `${p.meta.dept} / ${p.meta.customerName} / ${p.meta.workOrderNumber}` : ""}
                  </p>
                  {p.lastError && p.status !== "done" ? (
                    <p className="truncate text-xs text-destructive" title={p.lastError}>
                      {p.lastError}
                    </p>
                  ) : null}
                </div>
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                    toneClass[label.tone],
                  )}
                  data-testid={`status-queue-${p.id}`}
                >
                  {label.tone === "busy" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  {label.tone === "ok" ? <CheckCircle2 className="h-3 w-3" /> : null}
                  {label.tone === "bad" ? <TriangleAlert className="h-3 w-3" /> : null}
                  {label.text}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  {canRetry ? (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label="Retry upload"
                      onClick={() => void retryPhoto(p.id)}
                    >
                      <RotateCw className="h-4 w-4" />
                    </Button>
                  ) : null}
                  {p.status === "done" && p.webUrl ? (
                    <a
                      href={p.webUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="px-2 text-xs text-primary underline-offset-2 hover:underline"
                    >
                      Open
                    </a>
                  ) : null}
                  {canRemove ? (
                    confirmRemoveId === p.id ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          setConfirmRemoveId(null);
                          void removePhoto(p.id);
                        }}
                      >
                        {p.status === "done" ? "Remove" : "Delete photo"}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label="Remove from queue"
                        onClick={() => setConfirmRemoveId(p.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )
                  ) : null}
                </div>
              </li>
            );
          })
        )}
      </ul>
    </Card>
  );
}
