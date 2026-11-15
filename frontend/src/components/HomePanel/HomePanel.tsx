import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { GlassPanel, Icon } from "../glass";
import s from "./HomePanel.module.css";

export interface HomePanelItem {
  id: string;
  name: string;
  kind: string;
  detail?: string;
  clickable: boolean;
}

export interface HomePanelProps {
  items: HomePanelItem[];
  checked: ReadonlySet<string>;
  onToggle: (id: string, on: boolean) => void;
  onSetAll: (on: boolean) => void;
  query: string;
  onQuery: (q: string) => void;
  coordsHint?: string | null;
  onGoToCoords?: () => void;
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

export function HomePanel({
  items,
  checked,
  onToggle,
  onSetAll,
  query,
  onQuery,
  coordsHint,
  onGoToCoords,
  onFly,
  open,
  onOpenChange,
  brand,
  onGuide,
}: HomePanelProps) {
  const tabRef = useRef<HTMLButtonElement>(null);
  const collapseBtnRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const prevOpenRef = useRef(open);

  useEffect(() => {
    if (prevOpenRef.current !== open) {
      if (open) {
        collapseBtnRef.current?.focus();
      } else {
        tabRef.current?.focus();
      }
      prevOpenRef.current = open;
    }
  }, [open]);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.id.toLowerCase().includes(q) ||
        item.kind.toLowerCase().includes(q)
    );
  }, [items, query]);

  const handleSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onQuery("");
    } else if (e.key === "Enter" && coordsHint && onGoToCoords) {
      e.preventDefault();
      onGoToCoords();
    }
  };

  const handlePanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && !query) {
      onOpenChange(false);
    }
  };

  return (
    <>
      <button
        ref={tabRef}
        type="button"
        className={s.tab}
        data-open={open}
        onClick={() => onOpenChange(true)}
        aria-label="Show list"
        aria-expanded={open}
        aria-controls="home-panel"
        tabIndex={open ? -1 : 0}
        title="Show list"
      >
        <Icon name="search" size={16} />
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
        onKeyDown={handlePanelKeyDown}
      >
        <div className={s.head}>
          <div className={s.brand}>
            <Mark />
            <span className={s.brandName}>{brand}</span>
          </div>
          <div className={s.headActions}>
            <button
              type="button"
              className={s.actionBtn}
              aria-label="Guide"
              title="Guide"
              onClick={onGuide}
            >
              <Icon name="help" size={16} />
            </button>
            <button
              ref={collapseBtnRef}
              type="button"
              className={s.actionBtn}
              aria-label="Hide list"
              title="Hide list"
              onClick={() => onOpenChange(false)}
            >
              <Icon name="collapse" size={16} />
            </button>
          </div>
        </div>

        <div className={s.searchWrap} role="search">
          <label className={s.searchField}>
            <Icon name="search" size={16} />
            <span className="sr-only">Search targets</span>
            <input
              ref={searchInputRef}
              className={s.searchInput}
              value={query}
              onChange={(e) => onQuery(e.target.value)}
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
                onClick={() => onQuery("")}
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </label>
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
              onClick={onGoToCoords}
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
                    <span className={s.itemKind}>{item.kind}</span>
                    {item.detail && <span className={s.itemDetail}>{item.detail}</span>}
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
    </>
  );
}
