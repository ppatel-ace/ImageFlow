import ImageUploadForm from "@/components/ImageUploadForm";
import ThemeToggle from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { useAuth, userInitials } from "@/lib/auth";
import { getHubAppsUrl } from "@/lib/hub";

export default function HomePage() {
  const auth = useAuth();
  const user = auth.status === "authenticated" ? auth.user : null;

  const handleLogout = async () => {
    await auth.logout();
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-3 py-3 sm:px-4 sm:py-4 md:px-6">
          <a
            href={getHubAppsUrl()}
            className="flex items-center gap-2 no-underline rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:gap-3"
            aria-label="Back to ACE ERP"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary sm:h-10 sm:w-10">
              <span className="text-base font-bold text-primary-foreground sm:text-lg">ACE</span>
            </div>
            <div>
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

      <main className="py-4 sm:py-6 md:py-8">
        <ImageUploadForm />
      </main>
    </div>
  );
}
