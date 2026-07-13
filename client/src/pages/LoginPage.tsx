import { useState } from "react";
import ThemeToggle from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { Loader2 } from "lucide-react";

export default function LoginPage() {
  const auth = useAuth();
  const [starting, setStarting] = useState(false);

  const ssoLoginUrl =
    auth.status === "unauthenticated" ? auth.ssoLoginUrl : null;

  const startSsoLogin = () => {
    if (!ssoLoginUrl) return;
    setStarting(true);
    window.location.assign(ssoLoginUrl);
  };

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <div className="absolute right-4 top-4 z-10 sm:right-6 sm:top-6">
        <ThemeToggle />
      </div>

      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 py-12">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-primary">
            <span className="text-xl font-bold text-primary-foreground">ACE</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Ace Image Organizer</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in with your ACE account to upload and organize images.
          </p>
        </div>

        <Button
          type="button"
          className="w-full min-h-11 text-[15px] font-semibold"
          onClick={startSsoLogin}
          disabled={starting || !ssoLoginUrl}
          data-testid="button-sso-login"
        >
          {starting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Connecting…
            </>
          ) : ssoLoginUrl ? (
            "Sign in with ACE SSO"
          ) : (
            "SSO not configured"
          )}
        </Button>

        <p className="mt-5 text-center text-xs tracking-wide text-muted-foreground">
          Secured by ACE SSO
        </p>
      </div>
    </div>
  );
}
