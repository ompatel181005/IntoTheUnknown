import { useMemo } from "react";
import type { CatalogObject } from "../../types";
import s from "./HomeLegend.module.css";

/** A quiet key for the point kinds in the loaded catalog, drawn with the orrery's own marker. */
export function HomeLegend({ objects, flying }: { objects: readonly CatalogObject[]; flying: boolean }) {
  const kinds = useMemo(() => [...new Set(objects.map((object) => object.kind))].sort(), [objects]);
  if (kinds.length === 0) return null;
  // Focusable so keyboard users get the same raised contrast as hover.
  return (
    <ul className={s.legend} aria-label="Point kinds" data-flight-hide inert={flying} tabIndex={0}>
      {kinds.map((kind) => (
        <li key={kind} className={s.item}>
          <svg className={s.glyph} viewBox="-7 -7 14 14" aria-hidden="true">
            <circle r={5} className={s.ring} />
            <circle r={1.6} className={s.dot} />
          </svg>
          {kind.replaceAll("_", " ")}
        </li>
      ))}
    </ul>
  );
}
