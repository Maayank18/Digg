import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { ApiError, api } from "./api";
import { queryClient } from "./query";

export interface Session {
  user: { id: string; name: string; email: string; role: string };
  workspace: { id: string; name: string };
}

export const DEFAULT_SESSION: Session = {
  user: {
    id: "08e86e12-83f0-47aa-9f29-810db54a02e7",
    name: "Mayank Garg",
    email: "maayank51518@gmail.com",
    role: "",
  },
  workspace: {
    id: "eab790e8-cfca-408b-be1d-0334cdaf365a",
    name: "Mayank Garg’s workspace",
  },
};

/** The signed-in user (defaults to Mayank Garg workspace when auth is removed). */
export function useSession() {
  const query = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        const res = await api<Session>("/api/auth/me");
        return res ?? DEFAULT_SESSION;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return DEFAULT_SESSION;
        return DEFAULT_SESSION;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
  return { session: query.data ?? DEFAULT_SESSION, loading: query.isLoading && !query.data, error: query.error };
}

export async function logOut() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } finally {
    queryClient.clear();
    queryClient.setQueryData(["me"], DEFAULT_SESSION);
  }
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "")).toUpperCase();
}

/** Renders app screens without requiring login since authentication has been removed. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { loading, error } = useSession();
  if (loading) return <div className="boot">Loading…</div>;
  if (error) {
    return (
      <div className="boot">
        <div>
          <b>Dig can’t reach its server.</b>
          <p>{error instanceof Error ? error.message : String(error)}</p>
          <button className="btn" onClick={() => void queryClient.invalidateQueries({ queryKey: ["me"] })}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
