import { getCatalog } from "../api";
import type { Catalog } from "../types";
import { useAsync } from "./useAsync";

export type CatalogStatus = "loading" | "ready" | "error";

export interface CatalogState {
  status: CatalogStatus;
  catalog: Catalog | null;
  error: string | null;
}

/** Load one catalog set once per set name. */
export function useCatalog(setName = "targets"): CatalogState {
  const state = useAsync(`catalog:${setName}`, (signal) => getCatalog(setName, signal));
  if (state.kind === "ready") return { status: "ready", catalog: state.data, error: null };
  if (state.kind === "error") return { status: "error", catalog: null, error: state.message };
  return { status: "loading", catalog: null, error: null };
}
