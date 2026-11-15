import type { CatalogObject } from "../types";

export type CatalogSort = "frames" | "passes" | "name";
export interface DataCounts { frames: number | null; passes: number | null; bands: number | null }
export interface CatalogAvailability {
  schema: number;
  objects: Record<string, DataCounts & { manifest_url: string; render_key: string }>;
}

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Counts describe only the immutable prepared view which the catalog will open. */
export function catalogCounts(object: CatalogObject, availability: CatalogAvailability): DataCounts {
  const view = object.view;
  const known = availability.schema === 1 ? availability.objects[object.id] : undefined;
  const key = view?.manifest_url.match(/\/r\/([^/?#]+)\/manifest\.json$/)?.[1];
  if (key && known?.manifest_url === view?.manifest_url && known.render_key === key) {
    return { frames: count(known.frames), passes: count(known.passes), bands: count(known.bands) };
  }
  return { frames: null, passes: count(view?.passes), bands: null };
}

/** Known zero sorts ahead of unknown. Never mutate the catalog or its selection IDs. */
export function sortCatalogItems<T extends { id: string; name: string; counts: DataCounts }>(items: readonly T[], sort: CatalogSort): T[] {
  const descending = (a: number | null, b: number | null) =>
    a === null ? (b === null ? 0 : 1) : b === null ? -1 : b - a;
  return [...items].sort((a, b) => {
    const quantity = sort === "frames"
      ? descending(a.counts.frames, b.counts.frames) || descending(a.counts.passes, b.counts.passes)
      : sort === "passes" ? descending(a.counts.passes, b.counts.passes) : 0;
    return quantity || a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en");
  });
}

export function formatDataCounts(counts: DataCounts): string {
  return `${counts.frames ?? "?"} frames · ${counts.passes ?? "?"} passes · ${counts.bands ?? "?"} bands`;
}
