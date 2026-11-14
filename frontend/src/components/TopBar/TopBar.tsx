import { useId, useState, type FormEvent } from "react";
import { Chip, GlassButton, GlassPanel, Icon } from "../glass";
import { parseCoords } from "../../lib/format";
import { matchPresetName, PRESETS, type Preset } from "../../lib/targets";
import { APP_NAME } from "../../lib/brand";
import s from "./TopBar.module.css";

interface TopBarProps {
  activeTarget: string | null;
  /** Shown as a breadcrumb after the app name. */
  crumb: string | null;
  onHome: () => void;
  onPreset: (p: Preset) => void;
  onCoords: (ra: number, dec: number) => void;
  onShare: () => void;
  shareDisabled: boolean;
  onGuide: () => void;
  onTour: () => void;
}

export function TopBar(props: TopBarProps) {
  return (
    <header className={s.bar}>
      <button type="button" className={s.brand} onClick={props.onHome} title="Back to the whole sky">
        <Mark />
        <span className={s.name}>{APP_NAME}</span>
        {props.crumb && (
          <span className={s.crumb}>
            <span aria-hidden="true">›</span> {props.crumb}
          </span>
        )}
      </button>
      <GlassPanel pill className={s.center}>
        <TargetSearch onPreset={props.onPreset} onCoords={props.onCoords} />
        <span className={s.divider} aria-hidden="true" />
        <TargetChips active={props.activeTarget} onPick={props.onPreset} />
      </GlassPanel>
      <GlassPanel pill className={s.end} data-tour="help">
        <GlassButton variant="ghost" icon="tour" onClick={props.onTour} title="A one-minute tour of the screen">
          <span className={s.shareLabel}>Tour</span>
        </GlassButton>
        <GlassButton variant="ghost" icon="help" label="Guide and keyboard shortcuts (?)" onClick={props.onGuide} />
        <GlassButton
          variant="ghost"
          icon="share"
          onClick={props.onShare}
          disabled={props.shareDisabled}
          title={props.shareDisabled ? "Pick a target first" : "Copy a link to this view"}
        >
          <span className={s.shareLabel}>Share</span>
        </GlassButton>
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
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const preset = matchPresetName(text);
    if (preset) {
      setError(null);
      onPreset(preset);
      return;
    }
    const c = parseCoords(text);
    if (c) {
      setError(null);
      onCoords(c.ra, c.dec);
      return;
    }
    setError(
      text.trim()
        ? "Enter RA, Dec such as 269.446, 4.768 or 17:57:47 +04:46:06. Name search covers the five test targets for now."
        : "Type a target name or RA, Dec.",
    );
  };

  return (
    <form className={s.search} onSubmit={submit} role="search">
      <label className={s.field}>
        <Icon name="search" size={16} />
        <span className="sr-only">Target name or RA, Dec</span>
        <input
          className={s.input}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          placeholder="Search a name or RA, Dec"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? id : undefined}
        />
      </label>
      {error && (
        <p id={id} role="alert" className={s.error}>
          {error}
        </p>
      )}
    </form>
  );
}

function TargetChips({ active, onPick }: { active: string | null; onPick: (p: Preset) => void }) {
  return (
    <div className={s.chips} role="group" aria-label="Test targets" data-tour="targets">
      {PRESETS.map((p) => (
        <Chip key={p.id} pressed={active === p.id} onClick={() => onPick(p)} title={p.name} className={s.chip}>
          {p.short}
        </Chip>
      ))}
    </div>
  );
}
