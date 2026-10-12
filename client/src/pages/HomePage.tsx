import { useEffect, useState } from "react";
import ImageUploadForm from "@/components/ImageUploadForm";
import { startUploadRunner } from "@/lib/uploadQueue";
import UploadHistoryPanel from "@/components/UploadHistoryPanel";
import ThemeToggle from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth, userInitials } from "@/lib/auth";
import { getHubAppsUrl } from "@/lib/hub";
import { AceAppVersionFooter } from "@/components/AceAppVersionFooter";
import { trackFeature } from "@/components/AceUsageBeacon";

type BuildInfo = { sha: string; sourceHash: string | null; builtAt: string | null };

/** Which server build this tablet is talking to (BUILD_INFO.json via /health). */
function BuildStamp() {
  const [build, setBuild] = useState<BuildInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/health", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.build) setBuild(data.build as BuildInfo);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  if (!build) return null;
  const built = build.builtAt ? new Date(build.builtAt).toLocaleString() : "dev";
  return (
    <p className="mt-1 text-[11px] text-muted-foreground/70" data-testid="text-build-stamp">
      Build {build.sourceHash ?? build.sha} · {built}
    </p>
  );
}

export default function HomePage() {
  const auth = useAuth();
  const user = auth.status === "authenticated" ? auth.user : null;

  useEffect(
    () =>
      startUploadRunner({
        onAuthRequired: (loginUrl) => window.location.assign(loginUrl),
      }),
    [],
  );

  const handleLogout = async () => {
    await auth.logout();
  };

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-3 py-3 sm:px-4 sm:py-4 md:px-6">
          <a
            href={getHubAppsUrl()}
            className="flex items-center gap-3 no-underline rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Back to ACE ERP"
          >
            <img
              src="/ace-logo-white.png"
              alt="Ace Electronics"
              className="h-9 w-auto sm:h-11 brightness-0 dark:brightness-100"
            />
            <div className="min-w-0 border-l border-border pl-3">
              <h1 className="text-base font-semibold text-foreground sm:text-lg md:text-xl">
                Ace Image Organizer
              </h1>
              <p className="hidden text-xs text-muted-foreground sm:block sm:text-sm">
                Cloud Integration
              </p>
            </div>
          </a>

          <div className="flex min-w-0 items-center justify-end gap-2 sm:gap-3">
            <ThemeToggle />
            {user && auth.status === "authenticated" && auth.ssoEnabled ? (
              <div className="flex items-center gap-2 sm:gap-2.5">
                <div className="hidden items-center gap-2 sm:flex">
                  <span
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary"
                    aria-hidden
                  >
                    {userInitials(user.name || user.email)}
                  </span>
                  <span
                    className="max-w-[10rem] truncate text-sm text-foreground"
                    title={user.email}
                    data-testid="text-user-name"
                  >
                    {user.name || user.email}
                  </span>
                </div>
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary sm:hidden"
                  aria-label={user.name || user.email}
                  title={user.name || user.email}
                >
                  {userInitials(user.name || user.email)}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleLogout}
                  className="shrink-0"
                  data-testid="button-logout"
                >
                  Sign out
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <main className="flex-1 py-4 sm:py-6 md:py-8">
        <Tabs
          defaultValue="upload"
          className="mx-auto max-w-7xl px-3 sm:px-4 md:px-6"
          onValueChange={(tab) => {
            if (tab === "history") trackFeature("imageflow.history.view", "View upload history");
          }}
        >
          <TabsList className="mb-4 grid w-full grid-cols-2 sm:inline-flex sm:w-auto">
            <TabsTrigger value="upload" data-testid="tab-upload">
              Upload
            </TabsTrigger>
            <TabsTrigger value="history" data-testid="tab-history">
              History
            </TabsTrigger>
          </TabsList>
          <TabsContent value="upload" className="mt-0">
            <ImageUploadForm />
          </TabsContent>
          <TabsContent value="history" className="mt-0">
            <UploadHistoryPanel />
          </TabsContent>
        </Tabs>
      </main>

      <footer className="border-t border-border py-4 text-center">
        <AceAppVersionFooter
          appSlug="imageflow"
          displayName="ImageFlow"
          fallbackVersion="1.1.0"
          className="text-xs text-muted-foreground"
        />
        <BuildStamp />
      </footer>
    </div>
  );
}
