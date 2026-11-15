import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { formatDataCounts, sortCatalogItems, type CatalogSort, type DataCounts } from "../../lib/catalogSort";
import { formatDec, formatRa, parseCoords } from "../../lib/format";
import { GlassPanel, Icon } from "../glass";
import s from "./HomePanel.module.css";

export interface HomePanelItem {
  id: string;
  name: string;
  kind: string;
  detail?: string;
  clickable: boolean;
  counts: DataCounts;
}

export interface HomePanelProps {
  items: HomePanelItem[];
  checked: ReadonlySet<string>;
  onToggle: (id: string, on: boolean) => void;
  onSetAll: (on: boolean) => void;
  onGoToCoords: (ra: number, dec: number) => void;
  onFly: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brand: string;
  onGuide: () => void;
}

/** Crescent over a ring: active epoch marker reused as the brand mark. */
function Mark() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <circle cx="14" cy="14" r="11" fill="none" stroke="var(--text-1)" strokeOpacity="0.5" strokeWidth="1.2" />
      <path d="M17.5 5.8a8.8 8.8 0 1 0 0 16.4 7 7 0 0 1 0-16.4z" fill="var(--text-1)" />
    </svg>
  );
}

/** Directional arrow icon for flying to a target. */
function FlyIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 12h14M13 5l7 7-7 7" />
    </svg>
  );
}

export const HomePanel = memo(function HomePanel({
  items,
  checked,
  onToggle,
  onSetAll,
  onGoToCoords,
  onFly,
  open,
  onOpenChange,
  brand,
}: HomePanelProps) {
  const tabRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const prevOpenRef = useRef(open);
  const [sort, setSort] = useState<CatalogSort>("frames");
  // The search text lives here so typing re-renders only this panel, not the whole app.
  const [query, setQuery] = useState("");
  const coords = useMemo(() => parseCoords(query), [query]);
  const coordsHint = coords ? `Go to RA ${formatRa(coords.ra)}, Dec ${formatDec(coords.dec)}` : null;
  const goToCoords = coords ? () => onGoToCoords(coords.ra, coords.dec) : undefined;

  useEffect(() => {
    if (prevOpenRef.current !== open) {
      tabRef.current?.focus({ preventScroll: true });
      prevOpenRef.current = open;
    }
  }, [open]);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matching = !q ? items : items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.id.toLowerCase().includes(q) ||
        item.kind.toLowerCase().includes(q) ||
        item.kind.replaceAll("_", " ").toLowerCase().includes(q)
    );
    return sortCatalogItems(matching, sort);
  }, [items, query, sort]);

  const handleSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setQuery("");
    } else if (e.key === "Enter" && goToCoords) {
      e.preventDefault();
      goToCoords();
    } else if (e.key === "Enter" && filteredItems.length === 1 && checked.has(filteredItems[0].id) && filteredItems[0].clickable) {
      e.preventDefault();
      onFly(filteredItems[0].id);
    }
  };

  const handlePanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && (!query || e.target === tabRef.current)) {
      onOpenChange(false);
    }
  };

  return (
    <div className={s.rail} data-open={open} data-flight-hide onKeyDown={handlePanelKeyDown}>
      <button
        ref={tabRef}
        type="button"
        className={s.tab}
        data-tour="home-targets-tab"
        data-open={open}
        onClick={() => onOpenChange(!open)}
        aria-label={open ? "Hide list" : "Show list"}
        aria-expanded={open}
        aria-controls="home-panel"
        title={open ? "Hide list" : "Show list"}
      >
        <Icon name={open ? "prev" : "next"} size={16} />
        <span className={s.tabLabel}>Targets</span>
      </button>

      <GlassPanel
        strong
        id="home-panel"
        className={s.panel}
        role="region"
        aria-label="Targets"
        data-open={open}
        inert={!open ? true : undefined}
      >
        <div className={s.head}>
          <div className={s.brand}>
            <Mark />
            <span className={s.brandName}>{brand}</span>
          </div>
        </div>

        <div className={s.searchWrap} role="search" data-tour="home-target-search">
          <label className={s.searchField}>
            <Icon name="search" size={16} />
            <span className="sr-only">Search targets</span>
            <input
              ref={searchInputRef}
              className={s.searchInput}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search name, kind or RA, Dec"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="search"
            />
            {query.length > 0 && (
              <button
                type="button"
                className={s.clearBtn}
                aria-label="Clear search"
                title="Clear search"
                onClick={() => setQuery("")}
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </label>
        </div>

        <div className={s.sortWrap} data-tour="target-sort">
          <label className={s.sortLabel} htmlFor="target-sort">Sort targets</label>
          <select id="target-sort" className={s.sortSelect} value={sort} onChange={(e) => setSort(e.target.value as CatalogSort)} aria-describedby="target-sort-note">
            <option value="frames">Most frames</option>
            <option value="passes">Most passes</option>
            <option value="name">Name A–Z</option>
          </select>
          <p id="target-sort-note" className={s.sortNote}>Counts show data quantity, not quality. ? = unknown.</p>
        </div>

        <div className={s.countLine}>
          <span className={s.countText}>
            {filteredItems.length} of {items.length} shown
          </span>
          <div className={s.countActions}>
            <button
              type="button"
              className={s.textBtn}
              onClick={() => onSetAll(true)}
            >
              Show all
            </button>
            <button
              type="button"
              className={s.textBtn}
              onClick={() => onSetAll(false)}
            >
              Hide all
            </button>
          </div>
        </div>

        <div className={s.list} role="list" aria-label="Target list">
          {coordsHint && (
            <button
              type="button"
              className={s.coordsAction}
              onClick={goToCoords}
            >
              <span className={s.coordsMain}>
                <Icon name="globe" size={16} />
                <span className={s.coordsLabel}>{coordsHint}</span>
              </span>
              <FlyIcon />
            </button>
          )}

          {filteredItems.length === 0 && !coordsHint ? (
            <div className={s.noMatch}>No match</div>
          ) : (
            filteredItems.map((item) => {
              const isChecked = checked.has(item.id);
              const isFlyable = isChecked && item.clickable;
              const inputId = `home-item-${item.id}`;
              return (
                <div key={item.id} className={s.itemRow} role="listitem">
                  <input
                    type="checkbox"
                    id={inputId}
                    className={s.checkbox}
                    checked={isChecked}
                    onChange={(e) => onToggle(item.id, e.target.checked)}
                  />
                  <label htmlFor={inputId} className={s.itemLabel}>
                    <span className={s.itemName}>{item.name}</span>
                    <span className={s.itemKind}>{item.kind.replaceAll("_", " ")}</span>
                    {item.detail && <span className={s.itemDetail}>{item.detail}</span>}
                    <span className={s.itemCounts}>{formatDataCounts(item.counts)}</span>
                  </label>
                  <button
                    type="button"
                    className={s.flyBtn}
                    aria-label={`Fly to ${item.name}`}
                    title={`Fly to ${item.name}`}
                    disabled={!isFlyable}
                    onClick={() => onFly(item.id)}
                  >
                    <FlyIcon />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </GlassPanel>
    </div>
  );
});
