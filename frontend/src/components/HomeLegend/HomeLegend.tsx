import { useMemo } from "react";
import type { CatalogObject } from "../../types";
import s from "./HomeLegend.module.css";

/**
 * A quiet key for the sky points. The orrery draws every kind with one marker, so the key shows that
 * single marker once (kinds are named on each label) instead of repeating identical glyphs.
 */
export function HomeLegend({ objects, flying }: { objects: readonly CatalogObject[]; flying: boolean }) {
  const kinds = useMemo(
    () => [...new Set(objects.map((object) => object.kind.replaceAll("_", " ")))].sort().join(", "),
    [objects],
  );
  if (kinds === "") return null;
  // Focusable so keyboard users get the same raised contrast as hover.
  return (
    <ul className={s.legend} aria-label="Point key" data-flight-hide inert={flying} tabIndex={0} title={`Kinds shown: ${kinds}`}>
      <li className={s.item}>
        <svg className={s.glyph} viewBox="-7 -7 14 14" aria-hidden="true">
          <circle r={5} className={s.ring} />
          <circle r={1.6} className={s.dot} />
        </svg>
        Sky point (kind shown on its label)
      </li>
    </ul>
  );
}
