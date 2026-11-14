import { useState } from "react";
import { GAINS, SPEEDS, type StretchKind } from "../../lib/url";
import { BAND_OPTIONS, FOV_OPTIONS, type Band, type DataSource, type Epoch, type FovArcmin, type Manifest } from "../../types";
import { GlassButton, GlassPanel, Icon, Segmented, Switch } from "../glass";
import s from "./CustomizePanel.module.css";

export interface CustomizeValues {
  source: DataSource;
  fov: FovArcmin;
  speed: number;
  stretch: StretchKind;
  band: Band;
  invert: boolean;
  smooth: boolean;
  gain: number;
  ref: number;
}

interface CustomizePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  values: CustomizeValues;
  onChange: (v: Partial<CustomizeValues>) => void;
  onReset: () => void;
  epochs: Epoch[];
  /** Where the loaded images came from (null before a view loads). */
  origin: Manifest["origin"] | null;
  collections: string[];
  loading: boolean;
  /** Mobile renders the same panel as a bottom sheet. */
  sheet?: boolean;
}

const BAND_LABEL: Record<Band, string> = {
  auto: "Auto",
  B1: "B1 · 0.75–1.09 µm",
  B2: "B2 · 1.10–1.62 µm",
  B3: "B3 · 1.63–2.41 µm",
  B4: "B4 · 2.42–3.82 µm",
  B5: "B5 · 3.83–4.41 µm",
  B6: "B6 · 4.42–5.00 µm",
  "B1-B2": "B1–B2 · 0.75–1.62 µm",
  "B1-B3": "B1–B3 · 0.75–2.41 µm",
  all: "All bands",
};

/**
 * Always-visible customize panel, docked on the left like the NASA Eyes story rail.
 * The common choices sit on top; less common ones fold away under "More".
 */
export function CustomizePanel({ open, onOpenChange, values: v, onChange, onReset, epochs, origin, collections, loading, sheet }: CustomizePanelProps) {
  const [more, setMore] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        className={s.tab}
        onClick={() => onOpenChange(true)}
        aria-expanded={false}
        aria-controls="customize"
        title="Show Customize (C)"
        data-fade
        data-tour="customize"
      >
        <Icon name="sliders" size={16} />
        <span className={s.tabLabel}>Customize</span>
      </button>
    );
  }
  return (
    <GlassPanel strong={sheet} id="customize" className={`${s.panel} ${sheet ? s.sheet : ""}`} role="region" aria-label="Customize" data-fade data-tour="customize">
      <div className={s.head}>
        <h2 className={`${s.title} micro`}>Customize</h2>
        <GlassButton variant="ghost" icon={sheet ? "close" : "collapse"} label={sheet ? "Close Customize" : "Hide Customize"} onClick={() => onOpenChange(false)} />
      </div>

      <div className={s.body}>
        <section className={s.group} aria-labelledby="cz-data">
          <h3 id="cz-data" className={s.groupTitle}>
            Data
          </h3>
          <Field label="Images from">
            <Segmented
              label="Where the images come from"
              value={v.source}
              onChange={(x) => onChange({ source: x })}
              options={[
                { value: "auto", label: "Auto", title: "Saved cutouts when we have them, otherwise the live archive" },
                { value: "saved", label: "Saved", title: "Real SPHEREx cutouts bundled with the app. Works offline." },
                { value: "live", label: "Live", title: "Fresh from NASA/IPAC IRSA. Slower; needs the archive to be up." },
              ]}
            />
          </Field>
          <p className={s.origin} aria-live="polite">
            {loading ? (
              "Loading…"
            ) : origin ? (
              <>
                <span className={s.originKind}>{origin.kind === "saved" ? "Saved cutouts" : "Live archive"}</span>
                <span className="mono">
                  {collections.join(" + ")} · {origin.files} files
                  {origin.fetched ? ` · fetched ${origin.fetched.slice(0, 10)}` : ""}
                </span>
              </>
            ) : (
              "Pick a target to see where its images come from."
            )}
          </p>
        </section>

        <section className={s.group} aria-labelledby="cz-view">
          <h3 id="cz-view" className={s.groupTitle}>
            View
          </h3>
          <Field label="Field of view" note="Wider views catch faster movers but take longer to load.">
            <Segmented
              label="Field of view in arcminutes"
              value={String(v.fov)}
              onChange={(x) => onChange({ fov: Number(x) as FovArcmin })}
              options={FOV_OPTIONS.map((f) => ({ value: String(f), label: <span className="mono">{f}′</span> }))}
            />
          </Field>
          <Field label="Speed" hint="passes per second">
            <Segmented
              label="Playback speed in passes per second"
              value={String(v.speed)}
              onChange={(x) => onChange({ speed: Number(x) })}
              options={SPEEDS.map((x) => ({ value: String(x), label: <span className="mono">{x}</span> }))}
            />
          </Field>
        </section>

        <section className={s.group} aria-labelledby="cz-image">
          <h3 id="cz-image" className={s.groupTitle}>
            Image
          </h3>
          <Field label="Infrared band">
            <select className={`${s.select} mono`} value={v.band} onChange={(e) => onChange({ band: e.target.value as Band })} aria-label="Infrared band">
              {BAND_OPTIONS.map((b) => (
                <option key={b} value={b}>
                  {BAND_LABEL[b]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Brightness">
            <Segmented
              label="Brightness"
              value={String(v.gain)}
              onChange={(x) => onChange({ gain: Number(x) })}
              options={GAINS.map((g) => ({ value: String(g), label: g === 1 ? "Normal" : g < 1 ? (g === 0.25 ? "Max" : "High") : "Low" }))}
            />
          </Field>
          <Switch
            label="Smooth pixels"
            pressed={v.smooth}
            hint="Off shows SPHEREx's real 6.15″ pixels"
            onToggle={() => onChange({ smooth: !v.smooth })}
          />
          <Switch label="Invert" pressed={v.invert} onToggle={() => onChange({ invert: !v.invert })} />
        </section>

        <button type="button" className={s.more} aria-expanded={more} aria-controls="cz-more" onClick={() => setMore((m) => !m)}>
          <Icon name="chevron" size={14} />
          More options
        </button>
        {more && (
          <section id="cz-more" className={s.group} aria-label="More options">
            <Field label="Stretch">
              <Segmented
                label="Brightness stretch"
                value={v.stretch}
                onChange={(x) => onChange({ stretch: x })}
                options={[
                  { value: "asinh", label: "Asinh", title: "Shows faint and bright stars together" },
                  { value: "linear", label: "Linear" },
                ]}
              />
            </Field>
            <Field label="Compare against" hint="for Blink and Difference">
              <select
                className={`${s.select} mono`}
                value={String(v.ref)}
                onChange={(e) => onChange({ ref: Number(e.target.value) })}
                disabled={epochs.length < 2}
                aria-label="Reference pass for Blink and Difference"
              >
                {epochs.length === 0 && <option value="0">First pass</option>}
                {epochs.map((e) => (
                  <option key={e.i} value={e.i}>
                    Pass {e.i + 1} · {e.label}
                  </option>
                ))}
              </select>
            </Field>
          </section>
        )}
      </div>

      <div className={s.foot}>
        <p className={s.hint}>Saved in the share link</p>
        <GlassButton onClick={onReset}>Reset</GlassButton>
      </div>
    </GlassPanel>
  );
}

function Field({ label, hint, note, children }: { label: string; hint?: string; note?: string; children: React.ReactNode }) {
  return (
    <div className={s.field}>
      <span className={s.label}>
        {label}
        {hint && <span className={s.labelHint}> · {hint}</span>}
      </span>
      {children}
      {note && <span className={s.note}>{note}</span>}
    </div>
  );
}
