import { useEffect, useMemo, useState } from "react";

type Story = {
  id: string;
  key: string;
  title: string;
  status: string;
  priority: string;
  ac_total: number;
  ac_done: number;
  epic_id: string | null;
};

type Epic = { id: string; key: string; title: string };

type BacklogResponse = { epics: Epic[]; stories: Story[] };

const DEFAULT_HUB = "https://aceerp.aceelectronics.com";
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; data: BacklogResponse }>();

function hubBase(): string {
  try {
    return (
      (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_HUB_PUBLIC_URL?.trim().replace(
        /\/$/,
        "",
      ) || DEFAULT_HUB
    );
  } catch {
    return DEFAULT_HUB;
  }
}

async function fetchBacklog(appSlug: string): Promise<BacklogResponse | null> {
  const key = appSlug.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  try {
    const res = await fetch(`${hubBase()}/api/platform/sdlc/backlog/${encodeURIComponent(key)}`, {
      credentials: "omit",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as BacklogResponse;
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch {
    return null;
  }
}

export function AceBacklogPanel({
  appSlug,
  className = "",
  compact = false,
}: {
  appSlug: string;
  className?: string;
  compact?: boolean;
}) {
  const [stories, setStories] = useState<Story[]>([]);
  const [epics, setEpics] = useState<Epic[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchBacklog(appSlug).then((data) => {
      if (cancelled) return;
      if (!data) {
        setFailed(true);
        setStories([]);
        setEpics([]);
      } else {
        setFailed(false);
        setStories(data.stories ?? []);
        setEpics(data.epics ?? []);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [appSlug]);

  const epicKey = useMemo(() => new Map(epics.map((e) => [e.id, e.key])), [epics]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return stories;
    return stories.filter((s) =>
      `${s.key} ${s.title} ${s.status} ${s.priority} ${s.epic_id ? epicKey.get(s.epic_id) : ""}`
        .toLowerCase()
        .includes(needle),
    );
  }, [stories, q, epicKey]);

  const openHub = (storyId?: string) => {
    const base = `${hubBase()}/sdlc#backlog?app=${encodeURIComponent(appSlug)}`;
    window.open(storyId ? `${base}&story=${encodeURIComponent(storyId)}` : base, "_blank", "noopener,noreferrer");
  };

  return (
    <section className={className} data-testid="ace-backlog-panel">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Product backlog</h2>
          <p className="text-xs text-muted-foreground">Managed in ACE Hub Â· read-only here</p>
        </div>
        <button
          type="button"
          onClick={() => openHub()}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted/60"
        >
          Open in Hub
        </button>
      </div>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search storiesâ€¦"
        className="mb-3 h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
        aria-label="Search backlog"
      />
      {loading ? (
        <p className="text-xs text-muted-foreground">Loadingâ€¦</p>
      ) : failed ? (
        <p className="text-xs text-muted-foreground">
          Could not reach Hub backlog.{" "}
          <button type="button" className="underline" onClick={() => openHub()}>
            Open Hub
          </button>
        </p>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground">No stories yet.</p>
      ) : (
        <div className={compact ? "max-h-64 overflow-auto" : "max-h-96 overflow-auto"}>
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-background text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-2 font-medium">Key</th>
                <th className="py-1.5 pr-2 font-medium">Summary</th>
                <th className="py-1.5 pr-2 font-medium">Status</th>
                <th className="py-1.5 pr-2 font-medium">AC</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr
                  key={s.id}
                  className="cursor-pointer border-t border-border/60 hover:bg-muted/40"
                  onClick={() => openHub(s.id)}
                >
                  <td className="py-1.5 pr-2 font-mono text-[11px]">{s.key}</td>
                  <td className="py-1.5 pr-2">{s.title}</td>
                  <td className="py-1.5 pr-2 capitalize">{s.status.replace(/_/g, " ")}</td>
                  <td className="py-1.5 pr-2 tabular-nums">
                    {s.ac_done}/{s.ac_total}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

