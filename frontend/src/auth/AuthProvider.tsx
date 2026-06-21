import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  api,
  AUTH_UNAUTHORIZED_EVENT,
  getStoredAuthToken,
  setStoredAuthToken,
} from "../api/client";
import { AuthContext } from "./auth-context";

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(() => getStoredAuthToken());
  const [username, setUsername] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  const logout = useCallback(() => {
    setStoredAuthToken(null);
    setToken(null);
    setUsername(null);
    setIsAdmin(false);
    queryClient.clear();
  }, [queryClient]);

  const login = useCallback(async (name: string, password: string) => {
    const session = await api.login({ username: name, password });
    setStoredAuthToken(session.token);
    setToken(session.token);
    setUsername(session.username);
    setIsAdmin(session.is_admin);
  }, []);

  useEffect(() => {
    const handleUnauthorized = () => logout();
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized);
    return () =>
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized);
  }, [logout]);

  useEffect(() => {
    if (!token) return;
    let ignore = false;
    void api
      .getSession()
      .then((session) => {
        if (!ignore) {
          setUsername(session.username);
          setIsAdmin(session.is_admin);
        }
      })
      .catch(() => {
        if (!ignore) logout();
      });
    return () => {
      ignore = true;
    };
  }, [logout, token]);

  const value = useMemo(
    () => ({
      isAuthenticated: Boolean(token),
      username,
      isAdmin,
      login,
      logout,
    }),
    [isAdmin, login, logout, token, username],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
