import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/hooks/use-theme";
import { AuthProvider, useAuth } from "@/lib/auth";
import HomePage from "@/pages/HomePage";
import LoginPage from "@/pages/LoginPage";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/" component={HomePage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AuthGate() {
  const auth = useAuth();

  if (auth.status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <p className="text-sm text-muted-foreground">Checking session…</p>
      </div>
    );
  }

  // No local login UI — bounce to central ACE SSO (or fallback LoginPage redirect).
  if (auth.status === "unauthenticated") {
    if (auth.ssoLoginUrl && typeof window !== "undefined") {
      window.location.replace(auth.ssoLoginUrl);
      return (
        <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
          <p className="text-sm text-muted-foreground">Redirecting to ACE SSO…</p>
        </div>
      );
    }
    return <LoginPage />;
  }

  return <Router />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <AuthProvider>
            <Toaster />
            <AuthGate />
          </AuthProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
