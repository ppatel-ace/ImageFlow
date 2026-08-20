import { useEffect, useMemo, useState } from "react";

type DesignPack = {
  id: string;
  change_id: string;
  app_slug: string;
  status: string;
  change_title: string | null;
  change_stage: string | null;
  data_model: unknown[];
  api_contracts: unknown[];
  architecture_summary: string;
};

const DEFAULT_HUB = "https://aceerp.aceelectronics.com";
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; data: DesignPack[] }>();

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

async function fetchPacks(appSlug: string): Promise<DesignPack[] | null> {
  const key = appSlug.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  try {
    const res = await fetch(
      `${hubBase()}/api/platform/sdlc/design-packs/by-app/${encodeURIComponent(key)}`,
      { credentials: "omit" },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { packs: DesignPack[] };
    const packs = data.packs ?? [];
    cache.set(key, { at: Date.now(), data: packs });
    return packs;
  } catch {
    return null;
  }
}

export function AceDesignPanel({
  appSlug,
  className = "",
  compact = false,
}: {
  appSlug: string;
  className?: string;
  compact?: boolean;
}) {
  const [packs, setPacks] = useState<DesignPack[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchPacks(appSlug).then((data) => {
      if (cancelled) return;
      if (!data) {
        setFailed(true);
        setPacks([]);
      } else {
        setFailed(false);
        setPacks(data);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [appSlug]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return packs;
    return packs.filter((p) =>
      `${p.change_title ?? ""} ${p.status} ${p.change_stage ?? ""} ${p.architecture_summary}`
        .toLowerCase()
        .includes(needle),
    );
  }, [packs, q]);

  const openHub = (changeId?: string) => {
    const base = `${hubBase()}/sdlc#design`;
    window.open(
      changeId ? `${base}?change=${encodeURIComponent(changeId)}` : base,
      "_blank",
      "noopener,noreferrer",
    );
  };

  return (
    <section className={className} data-testid="ace-design-panel">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">System design</h2>
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
        placeholder="Search design packsâ€¦"
        className="mb-3 h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
        aria-label="Search design packs"
      />
      {loading ? (
        <p className="text-xs text-muted-foreground">Loadingâ€¦</p>
      ) : failed ? (
        <p className="text-xs text-muted-foreground">
          Could not reach Hub design packs.{" "}
          <button type="button" className="underline" onClick={() => openHub()}>
            Open Hub
          </button>
        </p>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground">No design packs yet.</p>
      ) : (
        <div className={compact ? "max-h-64 overflow-auto" : "max-h-96 overflow-auto"}>
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-background text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-2 font-medium">Change</th>
                <th className="py-1.5 pr-2 font-medium">Stage</th>
                <th className="py-1.5 pr-2 font-medium">Pack</th>
                <th className="py-1.5 pr-2 font-medium">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr
                  key={p.id}
                  className="cursor-pointer border-t border-border/60 hover:bg-muted/40"
                  onClick={() => openHub(p.change_id)}
                >
                  <td className="py-1.5 pr-2">{p.change_title ?? p.change_id.slice(0, 8)}</td>
                  <td className="py-1.5 pr-2 capitalize">{p.change_stage ?? "â€”"}</td>
                  <td className="py-1.5 pr-2 capitalize">{p.status}</td>
                  <td className="py-1.5 pr-2 tabular-nums">
                    {(p.data_model?.length ?? 0)} tables Â· {(p.api_contracts?.length ?? 0)} APIs
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

