import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type AceSsoUser = {
  id: string;
  email: string;
  name: string;
};

type AuthState =
  | { status: "loading" }
  | { status: "authenticated"; user: AceSsoUser }
  | { status: "unauthenticated"; ssoLoginUrl: string | null };

type AuthContextValue = AuthState & {
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/sso/session", {
        credentials: "include",
        cache: "no-store",
      });
      const data = (await res.json().catch(() => ({}))) as {
        authenticated?: boolean;
        ssoLoginUrl?: string;
        user?: AceSsoUser;
      };
      if (data.authenticated && data.user) {
        setState({ status: "authenticated", user: data.user });
        return;
      }
      setState({
        status: "unauthenticated",
        ssoLoginUrl: data.ssoLoginUrl ?? null,
      });
    } catch {
      setState({ status: "unauthenticated", ssoLoginUrl: null });
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/sso/logout", {
        method: "POST",
        credentials: "include",
      });
    } catch {
      /* ignore */
    }
    setState({ status: "unauthenticated", ssoLoginUrl: null });
    await refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, refresh, logout }),
    [state, refresh, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function userInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
