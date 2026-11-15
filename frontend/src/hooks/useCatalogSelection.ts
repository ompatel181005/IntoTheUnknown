import { useEffect, useMemo, useState } from "react";
import type { Catalog } from "../types";

const KEY = "spherex-blink.checked-points";

function readSelection(): string[] | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return Array.isArray(value) && value.every((id) => typeof id === "string") ? value : null;
  } catch { return null; }
}

export function useCatalogSelection(catalog: Catalog | null) {
  const [saved, setSaved] = useState(readSelection);
  const checked = useMemo(() => new Set(saved ?? catalog?.objects.filter((object) => object.preset_id).map((object) => object.id) ?? []), [saved, catalog]);
  useEffect(() => {
    if (!catalog) return;
    try { localStorage.setItem(KEY, JSON.stringify([...checked])); } catch { /* Storage is optional. */ }
  }, [catalog, checked]);
  const toggle = (id: string, on: boolean) => setSaved((previous) => {
    const next = new Set(previous ?? checked);
    if (on) next.add(id); else next.delete(id);
    return [...next];
  });
  const setAll = (on: boolean) => setSaved(on ? catalog?.objects.map((object) => object.id) ?? [] : []);
  return { checked, toggle, setAll };
}
