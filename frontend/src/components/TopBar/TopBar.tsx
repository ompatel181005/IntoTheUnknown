import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { GlassButton, GlassPanel, Icon } from "../glass";
import { formatDec, formatRa, parseCoords } from "../../lib/format";
import { searchPresets, type Preset } from "../../lib/targets";
import { APP_NAME } from "../../lib/brand";
import s from "./TopBar.module.css";

interface TopBarProps {
  /** Shown as a breadcrumb after the app name. */
  crumb: string | null;
  onHome: () => void;
  homeDisabled: boolean;
  onPreset: (p: Preset) => void;
  onCoords: (ra: number, dec: number) => void;
  onShare: () => void;
  shareDisabled: boolean;
  onGuide: () => void;
  onTour: () => void;
}

export function HomeGuideButton({ onGuide }: { onGuide: () => void }) {
  return <GlassPanel pill className={s.homeGuide} data-tour="help">
    <GlassButton variant="ghost" icon="help" label="Guide" onClick={onGuide} />
  </GlassPanel>;
}

export function TopBar(props: TopBarProps) {
  return (
    <header className={s.bar}>
      {props.crumb === null ? (
        <div className={s.brand}>
          <Mark />
          <span className={s.name}>{APP_NAME}</span>
        </div>
      ) : (
        <button type="button" className={s.brand} onClick={props.onHome} disabled={props.homeDisabled} title="Whole sky">
          <Mark />
          <span className={s.name}>{APP_NAME}</span>
          {props.crumb && (
            <span className={s.crumb}>
              <span aria-hidden="true">›</span> {props.crumb}
            </span>
          )}
        </button>
      )}
      <GlassPanel pill className={s.center}>
        <TargetSearch onPreset={props.onPreset} onCoords={props.onCoords} />
      </GlassPanel>
      <GlassPanel pill className={s.end} data-tour="help">
        <a className={s.learnLink} href="/learn.html">Learn &amp; explore</a>
        <GlassButton variant="ghost" icon="help" label="Guide" onClick={props.onGuide} />
        {props.crumb !== null && (
          <GlassButton
            variant="ghost"
            icon="share"
            onClick={props.onShare}
            disabled={props.shareDisabled}
            title={props.shareDisabled ? "Pick a target" : "Share link"}
          >
            <span className={s.shareLabel}>Share</span>
          </GlassButton>
        )}
      </GlassPanel>
    </header>
  );
}

/** Crescent over a ring: the timeline's active-epoch marker, reused as the brand mark. */
function Mark() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
      <circle cx="14" cy="14" r="11" fill="none" stroke="var(--text-1)" strokeOpacity="0.5" strokeWidth="1.2" />
      <path d="M17.5 5.8a8.8 8.8 0 1 0 0 16.4 7 7 0 0 1 0-16.4z" fill="var(--text-1)" />
    </svg>
  );
}

function TargetSearch({ onPreset, onCoords }: Pick<TopBarProps, "onPreset" | "onCoords">) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const uid = useId();
  const listboxId = `${uid}-results`;
  const query = text.trim();
  const coords = parseCoords(text);
  const presets = searchPresets(text);
  const options: SearchOption[] = [
    ...(coords ? [{ type: "coords" as const, key: "coords", ra: coords.ra, dec: coords.dec }] : []),
    ...presets.map((preset) => ({ type: "preset" as const, key: preset.id, preset })),
  ].slice(0, 8);
  const activeIndex = options.length ? Math.min(highlighted, options.length - 1) : -1;
  const activeId = activeIndex >= 0 ? `${uid}-option-${activeIndex}` : undefined;

  const pick = (option: SearchOption) => {
    if (option.type === "preset") onPreset(option.preset);
    else onCoords(option.ra, option.dec);
    setText("");
    setOpen(false);
    setHighlighted(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (!options.length) return;
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((activeIndex + direction + options.length) % options.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (open && activeIndex >= 0) pick(options[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (open) setOpen(false);
      else event.currentTarget.blur();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className={s.search} role="search" data-tour="targets">
      <label className={s.field}>
        <Icon name="search" size={16} />
        <span className="sr-only">Search targets</span>
        <input
          className={s.input}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setHighlighted(0);
            setOpen(true);
          }}
          onFocus={() => {
            setHighlighted(0);
            setOpen(true);
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          placeholder="Search name or RA, Dec"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={open ? activeId : undefined}
        />
      </label>
      {open && (
        <div id={listboxId} className={s.results} role="listbox" aria-label="Suggestions">
          {options.length ? (
            options.map((option, index) => (
              <div
                id={`${uid}-option-${index}`}
                key={option.key}
                className={s.option}
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setHighlighted(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(option)}
              >
                {option.type === "coords" ? (
                  <span className={s.coordLabel}>
                    Go to RA {formatRa(option.ra)}, Dec {formatDec(option.dec)}
                  </span>
                ) : (
                  <>
                    <span className={s.optionCopy}>
                      <span className={s.optionName}>{highlightMatch(option.preset.name, query)}</span>
                      <span className={s.tagline}>{highlightMatch(option.preset.tagline, query)}</span>
                    </span>
                    <span className={s.kindLabel}>{option.preset.kind === "motion" ? "Moves" : "Changes brightness"}</span>
                  </>
                )}
              </div>
            ))
          ) : (
            <div className={`${s.option} ${s.noMatch}`} role="option" aria-selected="false" aria-disabled="true">
              No match. Try a name or RA, Dec.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type SearchOption =
  | { type: "preset"; key: string; preset: Preset }
  | { type: "coords"; key: string; ra: number; dec: number };

function highlightMatch(value: string, query: string): ReactNode {
  if (!query) return value;
  const index = value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return value;
  return (
    <>
      {value.slice(0, index)}
      <strong>{value.slice(index, index + query.length)}</strong>
      {value.slice(index + query.length)}
    </>
  );
}
