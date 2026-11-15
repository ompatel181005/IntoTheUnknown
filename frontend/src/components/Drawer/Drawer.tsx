import { useEffect, useRef, useState } from "react";
import type { LoadedView } from "../../data/source";
import type { AsyncState } from "../../hooks/useAsync";
import { formatDec, formatParallaxDistance, formatProperMotionMoon, formatRa, mjdToDate } from "../../lib/format";
import { isWebUrl } from "../../lib/catalog";
import type { RaDec } from "../../lib/sky";
import { PRESETS, type Preset } from "../../lib/targets";
import { astrometricScatter, sourcePresentation, utcTime } from "../../lib/viewPresentation";
import type { Panel } from "../../lib/url";
import type { CatalogObject, GaiaSelection, LightCurve, Spectrum } from "../../types";
import { AllSkyMap } from "../AllSkyMap/AllSkyMap";
import { Scatter } from "../Charts/Scatter";
import { GlassButton, GlassPanel, Tabs, Term } from "../glass";
import s from "./Drawer.module.css";

interface DrawerProps {
  panel: Panel;
  onPanel: (p: Panel) => void;
  onClose: () => void;
  view: LoadedView | null;
  index: number;
  target: Preset | null;
  point?: CatalogObject | null;
  position: RaDec | null;
  /** Selected grid pixel (FITS orientation) or null for the target at the centre. */
  sel: [number, number] | null;
  spectrum: AsyncState<Spectrum>;
  lightcurve: AsyncState<LightCurve>;
  /** Gaia match label of the measured source in this pass; idle when the view has no Gaia data. */
  gaiaMatch: AsyncState<GaiaSelection | null>;
  onSelectEpoch: (i: number) => void;
}

export const DRAWER_ID = "drawer";

const TABS: { value: Panel; label: string }[] = [
  { value: "pass", label: "This pass" },
  { value: "colours", label: "Spectrum" },
  { value: "brightness", label: "Brightness" },
  { value: "files", label: "Files" },
  { value: "sky", label: "Sky" },
];

/** Upper bound for the opening motion (title absorption is 360 ms), in case an animation never ends. */
const SETTLE_MAX_MS = 700;
/** Upper bound for the body fade (--dur), in case transitionend never fires. */
const REVEAL_MAX_MS = 400;

/**
 * Opening Details starts the drawer slide, the title absorption and the dome resize at once. Until they are over
 * the drawer stays cheap to composite ("enter": no live blur, no float shadow, body laid out but unpainted). Then
 * the body fades in, still flat ("reveal"), and only when it is opaque does the glass get its blur back ("rest").
 */
type Phase = "enter" | "reveal" | "rest";

function useOpeningPhase(bodyRef: React.RefObject<HTMLDivElement | null>): Phase {
  const [phase, setPhase] = useState<Phase>("enter");
  useEffect(() => {
    let alive = true;
    const toReveal = () => {
      if (alive) setPhase((p) => (p === "enter" ? "reveal" : p));
    };
    const cap = window.setTimeout(toReveal, SETTLE_MAX_MS);
    // One frame later, so animations started by this commit are registered.
    const raf = requestAnimationFrame(() => {
      const finite = document
        .getAnimations()
        .filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity));
      void Promise.all(finite.map((a) => a.finished.catch(() => undefined))).then(toReveal);
    });
    return () => {
      alive = false;
      window.clearTimeout(cap);
      cancelAnimationFrame(raf);
    };
  }, []);
  useEffect(() => {
    if (phase !== "reveal") return;
    const body = bodyRef.current;
    const rest = () => setPhase("rest");
    const onEnd = (e: TransitionEvent) => {
      if (e.target === body && e.propertyName === "opacity") rest();
    };
    body?.addEventListener("transitionend", onEnd);
    const cap = window.setTimeout(rest, REVEAL_MAX_MS);
    return () => {
      body?.removeEventListener("transitionend", onEnd);
      window.clearTimeout(cap);
    };
  }, [phase, bodyRef]);
  return phase;
}

/** Measurements and data, one tab each (the "Advanced" pages of the prototype on initialammar). */
export function Drawer(p: DrawerProps) {
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tabsRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
  }, []);
  const bodyRef = useRef<HTMLDivElement>(null);
  const phase = useOpeningPhase(bodyRef);
  const panelId = `drawer-panel-${p.panel}`;
  return (
    <GlassPanel
      strong
      id={DRAWER_ID}
      className={s.drawer}
      role="dialog"
      aria-modal="false"
      aria-label="Details"
      data-tour="details"
      data-flight-hide
      data-phase={phase}
      style={{ ["--flight-hide-x" as string]: "32px" }}
    >
      <div className={s.head} ref={tabsRef}>
        <Tabs label="Details" value={p.panel} onChange={p.onPanel} tabs={TABS.map((t) => ({ ...t, panelId }))} />
        <GlassButton className={s.closeBtn} variant="ghost" icon="close" label="Close details" onClick={p.onClose} />
      </div>
      <div className={s.body} ref={bodyRef} id={panelId} role="tabpanel" aria-labelledby={`tab-${p.panel}`}>
        {p.panel === "pass" && <PassTab {...p} />}
        {p.panel === "colours" && <ColoursTab {...p} />}
        {p.panel === "brightness" && <BrightnessTab {...p} />}
        {p.panel === "files" && <FilesTab view={p.view} index={p.index} onSelectEpoch={p.onSelectEpoch} />}
        {p.panel === "sky" && <SkyTab target={p.target} position={p.position} />}
      </div>
    </GlassPanel>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className={s.hint}>{children}</p>;
}

function where(sel: [number, number] | null) {
  return sel ? (
    <>
      the pixel you picked <span className="mono">({sel[0]}, {sel[1]})</span>
    </>
  ) : (
    "the target at the centre"
  );
}

function PassTab({ view, index, target, point, position }: DrawerProps) {
  if (!view) return <Empty>Load a view to see pass details.</Empty>;
  if (view.manifest.epochs.length === 0) return <Empty>This selection produced no usable passes.</Empty>;
  const m = view.manifest;
  const e = m.epochs[index] ?? m.epochs[0];
  const flagged = Object.entries(e.flagged_px);
  const provenance = sourcePresentation(view);
  return (
    <>
      <section className={s.section} aria-labelledby="d-target">
        <h3 id="d-target" className={`micro ${s.sectionTitle}`}>
          {target ? (target.kind === "motion" ? "Moving target" : "Variable target") : point?.kind.replaceAll("_", " ") ?? "Position"}
        </h3>
        <p className={`display ${s.name}`}>{target?.name ?? point?.name ?? "Custom position"}</p>
        {target && <p className={s.hint}>{target.what}</p>}
        <div className={s.grid}>
          {position && (
            <>
              <Tile label={<Term term="RA">RA</Term>} value={formatRa(position.ra)} mono />
              <Tile label={<Term term="Dec">Dec</Term>} value={formatDec(position.dec)} mono />
            </>
          )}
          {target?.facts.map((f, i, arr) => {
            let labelNode: React.ReactNode = f.label;
            let secondaryNode: React.ReactNode = null;
            let valueNode: React.ReactNode = f.value;

            if (f.label === "Motion") {
              labelNode = <Term term="Proper motion">Motion</Term>;
              secondaryNode = formatProperMotionMoon(f.value);
            } else if (f.label === "Parallax") {
              labelNode = <Term term="Parallax">Parallax</Term>;
              secondaryNode = formatParallaxDistance(f.value);
            } else if (f.label === "Gaia G" || f.label === "Gaia") {
              labelNode = <Term term="Gaia G">{f.label}</Term>;
            }

            if (typeof f.value === "string" && f.value.includes("(lit.)")) {
              const parts = f.value.split("(lit.)");
              valueNode = (
                <>
                  {parts[0]}
                  <Term term="(lit.)">(lit.)</Term>
                  {parts.slice(1).join("(lit.)")}
                </>
              );
            }

            return (
              <Tile
                key={f.label}
                label={labelNode}
                value={valueNode}
                secondary={secondaryNode}
                mono
                full={arr.length % 2 === 1 && i === arr.length - 1}
              />
            );
          })}
          {!target && point && (
            <>
              <Tile
                label={<Term term="Parallax">Parallax</Term>}
                value={point.parallax_mas === null ? "Not available" : `${point.parallax_mas} mas`}
                secondary={formatParallaxDistance(point.parallax_mas)}
              />
              <Tile label="Reference epoch" value={String(point.ref_epoch)} />
              <Tile
                label={<Term term="Proper motion">Proper motion RA</Term>}
                value={point.pmra_mas_yr === null ? "Not available" : `${point.pmra_mas_yr} mas/yr`}
              />
              <Tile
                label={<Term term="Proper motion">Proper motion Dec</Term>}
                value={point.pmdec_mas_yr === null ? "Not available" : `${point.pmdec_mas_yr} mas/yr`}
                secondary={
                  point.pmra_mas_yr !== null && point.pmdec_mas_yr !== null
                    ? formatProperMotionMoon(Math.hypot(point.pmra_mas_yr, point.pmdec_mas_yr) / 1000)
                    : null
                }
              />
              <Tile label={<Term term="RA">Catalog RA</Term>} value={formatRa(point.ra_deg)} />
              <Tile label={<Term term="Dec">Catalog Dec</Term>} value={formatDec(point.dec_deg)} />
            </>
          )}
        </div>
        {!target && point && (
          <p className={s.note}>
            {isWebUrl(point.provenance.ref) ? (
              <a href={point.provenance.ref} target="_blank" rel="noreferrer">
                {point.provenance.catalog}
              </a>
            ) : (
              point.provenance.catalog
            )}
          </p>
        )}
        {target && (
          <p className={s.note}>
            Gaia DR3; <Term term="(lit.)">(lit.)</Term> marks literature values.
          </p>
        )}
        <p className={s.sourceBadge}>{provenance.label} · {provenance.cache}</p>
      </section>
      <section className={s.section} aria-labelledby="d-epoch">
        <h3 id="d-epoch" className={`micro ${s.sectionTitle}`}>
          This pass
        </h3>
        {m.epochs.length === 1 && <p className={s.note}>One pass. Motion needs at least two passes.</p>}
        <div className={s.grid}>
          <div className={`${s.tile} ${s.tileFull}`}>
            <span className={s.tileLabel}>Pass {String(e.i + 1).padStart(2, "0")} / {String(m.epochs.length).padStart(2, "0")}</span>
            <span className={`${s.tileValue} mono`}>{mjdToDate(e.t_mean_mjd)}</span>
          </div>
          <Tile label="Frames" value={`${e.n_frames} frames`} mono />
          <Tile label="Start (UTC)" value={utcTime(e.t_start)} mono />
          <Tile label="End (UTC)" value={utcTime(e.t_end)} mono />
          <Tile label={<Term term="Detectors">Detectors</Term>} value={e.detectors.map((d) => `D${d}`).join(" ")} mono />
          <Tile label="Wavelength" value={`λ ${e.lambda_um[0].toFixed(2)}-${e.lambda_um[1].toFixed(2)} µm`} mono />
          <Tile label={<Term term="Release">Collections</Term>} value={m.catalog.collections.join(" + ") || "Not reported"} mono />
          <Tile label="Alignment scatter" value={astrometricScatter(e.astrom_resid_px)} full />
          <div className={s.tile}>
            <span className={s.tileLabel}>Input flag counts</span>
            <span className={`${s.tileValue} mono`}>
              {flagged.length > 0 ? <span className={s.flagList}>{flagged.map(([k, n]) => <span key={k}><Term term={k}>{k}</Term> {n}{" "}</span>)}</span> : "None reported"}
            </span>
          </div>
          {m.bandpass_matched === false && (
            <Tile
              label={<Term term="Colours">Colours</Term>}
              value={<Term term="Colours not matched">Not matched across passes</Term>}
              mono={false}
              full
            />
          )}
        </div>
        <p className={s.note}>Alignment scatter is the per-axis centroid scatter of reference stars, not a target-position uncertainty. “Not measured” means no usable alignment measurement was reported.</p>
        <p className={s.note}>Flag counts are rounded mean flagged pixels per input frame. Categories overlap; they are not object counts or a distinct-pixel total.</p>
      </section>
    </>
  );
}

function Tile({
  label,
  value,
  secondary,
  mono = true,
  full = false,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  secondary?: React.ReactNode;
  mono?: boolean;
  full?: boolean;
}) {
  return (
    <div className={`${s.tile}${full ? ` ${s.tileFull}` : ""}`}>
      <span className={s.tileLabel}>{label}</span>
      <span className={`${s.tileValue}${mono ? " mono" : ""}`}>{value}</span>
      {secondary && <span className={`${s.tileSecondary} mono`}>{secondary}</span>}
    </div>
  );
}

function Status({ state, what }: { state: AsyncState<unknown>; what: string }) {
  if (state.kind === "loading") return <div className={`${s.slot} ${s.loading}`}>Measuring {what}…</div>;
  if (state.kind === "error") return <div className={s.slot}>Could not measure {what}. Pick another pixel or try again.</div>;
  return null;
}

/** "Gaia match" or "no Gaia match" for the measured source. Silent while loading or when Gaia data is missing. */
function GaiaMatch({ state, index }: { state: AsyncState<GaiaSelection | null>; index: number }) {
  if (state.kind !== "ready" || !state.data) return null;
  const m = state.data;
  if (m.label === "match")
    return (
      <p className={`${s.note} ${s.gaiaMatch}`}>
        Gaia match: a Gaia DR3 star is predicted {m.sep_px?.toFixed(2)} px from this source in pass {index + 1}.
      </p>
    );
  if (m.label === "no_match")
    return <p className={`${s.note} ${s.gaiaNone}`}>No Gaia match: no Gaia DR3 star is predicted within 1 px of this source in pass {index + 1}.</p>;
  return <p className={s.note}>No source bright enough to compare with Gaia here in pass {index + 1}.</p>;
}

function ColoursTab({ view, index, sel, spectrum, gaiaMatch }: DrawerProps) {
  if (!view) return <Empty>Load a target first.</Empty>;
  return (
    <section className={s.section} aria-labelledby="d-spec">
      <h3 id="d-spec" className={`micro ${s.sectionTitle}`}>
        Spectrum · pass {index + 1}
      </h3>
      <p className={s.hint}>
        Brightness of {where(sel)} by wavelength (<Term term="MJy/sr">MJy/sr</Term>). Click the image to change it.
      </p>
      <GaiaMatch state={gaiaMatch} index={index} />
      <Status state={spectrum} what="the spectrum" />
      {spectrum.kind === "ready" &&
        (spectrum.data.points.some((pt) => pt.flux_mjysr !== null) ? (
          <Scatter
            summary={`Spectrum with ${spectrum.data.points.length} points`}
            xLabel="Wavelength (µm)"
            yLabel="Surface brightness (MJy/sr)"
            formatX={(v) => v.toFixed(1)}
            formatY={(v) => v.toPrecision(3)}
            points={spectrum.data.points
              .filter((pt) => pt.flux_mjysr !== null)
              .map((pt) => ({
                x: pt.lambda_um,
                y: pt.flux_mjysr as number,
                xerr: pt.bw_um / 2,
                yerr: pt.err,
                hollow: pt.flagged,
                title: `${pt.lambda_um.toFixed(3)} µm · D${pt.detector}`,
              }))}
          />
        ) : (
          <Saturated />
        ))}
    </section>
  );
}

/** From the prototype: explain saturated cores instead of drawing an empty chart. */
function Saturated() {
  return <div className={s.slot}>This pixel is saturated. Pick a fainter star.</div>;
}

function BrightnessTab({ view, sel, lightcurve, index, gaiaMatch }: DrawerProps) {
  if (!view) return <Empty>Load a target first.</Empty>;
  const epochs = view.manifest.epochs;
  const lc = lightcurve.kind === "ready" ? lightcurve.data : null;
  const lams = lc?.points.map((pt) => pt.lambda_um) ?? [];
  const [lam0, lam1] = [Math.min(...lams), Math.max(...lams)];
  // Calibration floor (#32): the comparison stars' scatter, drawn around this source's median flux.
  const good = lc?.points.filter((pt) => !pt.flagged).map((pt) => pt.flux_ujy).sort((a, b) => a - b) ?? [];
  const median = good.length ? (good[(good.length - 1) >> 1] + good[good.length >> 1]) / 2 : null;
  const floor = lc?.comparison && median !== null && median > 0 ? lc.comparison : null;
  return (
    <section className={s.section} aria-labelledby="d-lc">
      <h3 id="d-lc" className={`micro ${s.sectionTitle}`}>
        Brightness over time
      </h3>
      <p className={s.hint}>
        Brightness of {where(sel)} in <Term term="uJy">µJy</Term>. Hollow points are flagged.
      </p>
      <GaiaMatch state={gaiaMatch} index={index} />
      <Status state={lightcurve} what="the light curve" />
      {lightcurve.kind === "ready" &&
        (lightcurve.data.points.length > 0 && lightcurve.data.points.some((pt) => !pt.flagged) ? (
          <>
            <Scatter
              summary={`Light curve with ${lightcurve.data.points.length} points`}
              xLabel="Date"
              yLabel="Flux (µJy)"
              formatX={(v) => mjdToDate(v).slice(0, 7)}
              formatY={(v) => (Math.abs(v) >= 1e4 ? v.toExponential(1) : v.toFixed(0))}
              band={floor && median !== null ? [median * (1 - floor.rms_frac), median * (1 + floor.rms_frac)] : undefined}
              points={lightcurve.data.points.map((pt) => {
                const ep = epochs.findIndex((e) => Math.abs(e.t_mean_mjd - pt.t_mjd) < 25);
                return {
                  x: pt.t_mjd,
                  y: pt.flux_ujy,
                  yerr: pt.err,
                  hollow: pt.flagged,
                  active: ep === index,
                  // Theme tokens only: accent at the shortest wavelength, mover amber at the longest.
                  color: `color-mix(in oklab, var(--mover) ${lam1 > lam0 ? Math.round(((pt.lambda_um - lam0) / (lam1 - lam0)) * 100) : 0}%, var(--accent))`,
                  title: `${mjdToDate(pt.t_mjd)} · ${pt.lambda_um.toFixed(2)} µm`,
                };
              })}
            />
            <p className={s.note}>
              Colour: blue {lam0.toFixed(2)} µm to amber {lam1.toFixed(2)} µm. Each frame is at a different wavelength, so compare points of
              the same colour. Outlined points are the pass on screen.
            </p>
            {floor ? (
              <p className={s.note}>
                Green band: ±{(floor.rms_frac * 100).toFixed(1)}% around the median, the scatter of {floor.n_stars} steady stars in this field.
                Changes inside it may be calibration noise.
              </p>
            ) : (
              <p className={s.note}>No calibration band: too few steady comparison stars in this field.</p>
            )}
          </>
        ) : (
          <Saturated />
        ))}
    </section>
  );
}

function FilesTab({ view, index, onSelectEpoch }: { view: LoadedView | null; index: number; onSelectEpoch: (i: number) => void }) {
  if (!view) return <Empty>Load a target first.</Empty>;
  const frames = view.manifest.frames;
  return (
    <section className={s.section} aria-labelledby="d-files">
      <h3 id="d-files" className={`micro ${s.sectionTitle}`}>
        {frames.length} frames used
      </h3>
      <div className={s.tableWrap}>
        <table className={`${s.table} mono`}>
          <thead>
            <tr>
              <th scope="col">Pass</th>
              <th scope="col">Date</th>
              <th scope="col"><Term term="Detectors">Det</Term></th>
              <th scope="col">λ µm</th>
            </tr>
          </thead>
          <tbody>
            {frames.map((f) => (
              <tr key={f.obs + f.t_mjd} data-active={f.epoch === index} title={f.obs}>
                <td>
                  <button type="button" className={s.rowButton} onClick={() => onSelectEpoch(f.epoch)} aria-label={`Show pass ${f.epoch + 1}`}>
                    {f.epoch + 1}
                  </button>
                </td>
                <td>{mjdToDate(f.t_mjd)}</td>
                <td>D{f.detector}</td>
                <td>{f.lambda_um.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SkyTab({ target, position }: { target: Preset | null; position: RaDec | null }) {
  return (
    <section className={s.section} aria-labelledby="d-sky">
      <h3 id="d-sky" className={`micro ${s.sectionTitle}`}>
        Whole-sky position
      </h3>
      <AllSkyMap targets={PRESETS} activeId={target?.id ?? null} marker={target ? null : position} compact />
      <p className={s.hint}>Dashed: ecliptic. Glow: Milky Way.</p>
    </section>
  );
}
