import { useEffect } from "react";
import ThemeToggle from "@/components/ThemeToggle";
import { useAuth } from "@/lib/auth";
import { Loader2 } from "lucide-react";

/**
 * Fallback only — with SSO enabled the server usually redirects to
 * sso.aceelectronics.com before this page renders. If we do land here
 * (e.g. client-only navigation), bounce to SSO immediately.
 */
export default function LoginPage() {
  const auth = useAuth();
  const ssoLoginUrl =
    auth.status === "unauthenticated" ? auth.ssoLoginUrl : null;

  useEffect(() => {
    if (!ssoLoginUrl) return;
    window.location.replace(ssoLoginUrl);
  }, [ssoLoginUrl]);

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <div className="absolute right-4 top-4 z-10 sm:right-6 sm:top-6">
        <ThemeToggle />
      </div>

      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 py-12">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-primary">
            <span className="text-xl font-bold text-primary-foreground">ACE</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Ace Image Organizer</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {ssoLoginUrl
              ? "Redirecting to ACE SSO…"
              : "SSO is not configured. Set SSO_LOGIN_URL and ENABLE_SSO=true."}
          </p>
        </div>

        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          {ssoLoginUrl ? "Taking you to sso.aceelectronics.com" : "Waiting for configuration…"}
        </div>
      </div>
    </div>
  );
}
