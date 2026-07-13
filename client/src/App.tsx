import { useEffect, useState } from "react";
import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/hooks/use-theme";
import HomePage from "@/pages/HomePage";
import NotFound from "@/pages/not-found";

type SsoSession =
  | { status: "checking" }
  | { status: "authenticated"; user: { id: string; email: string; name: string } }
  | { status: "redirecting" };

function useAceSsoGate(): SsoSession {
  const [session, setSession] = useState<SsoSession>({ status: "checking" });

  useEffect(() => {
    let cancelled = false;

    fetch("/api/auth/sso/session", { credentials: "include" })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          authenticated?: boolean;
          ssoLoginUrl?: string;
          user?: { id: string; email: string; name: string };
        };
        if (cancelled) return;
        if (data.authenticated && data.user) {
          setSession({ status: "authenticated", user: data.user });
          return;
        }
        if (data.ssoLoginUrl) {
          setSession({ status: "redirecting" });
          window.location.assign(data.ssoLoginUrl);
          return;
        }
        setSession({ status: "redirecting" });
      })
      .catch(() => {
        if (!cancelled) setSession({ status: "redirecting" });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return session;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={HomePage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const session = useAceSsoGate();

  if (session.status === "checking" || session.status === "redirecting") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-foreground">
        <p className="text-sm text-muted-foreground">Checking session…</p>
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
