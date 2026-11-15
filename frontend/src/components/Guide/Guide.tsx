import { useEffect, useRef, useState } from "react";
import { APP_NAME } from "../../lib/brand";
import { PRESETS } from "../../lib/targets";
import { GlassButton, Tabs, Term } from "../glass";
import s from "./Guide.module.css";

type Section = "about" | "fieldguide" | "use" | "science" | "data";

const SECTIONS: { value: Section; label: string }[] = [
  { value: "about", label: "About" },
  { value: "fieldguide", label: "Field guide" },
  { value: "use", label: "How to use" },
  { value: "science", label: "The science" },
  { value: "data", label: "Data" },
];

// Detailed notes per target, adapted from the initialammar guide. (lit.) marks values not yet verified.
const NOTES: Record<string, string> = {
  barnard:
    "Its 10.4″ yearly motion is about 1.7 SPHEREx pixels. Its bright core can saturate, so measure a fainter pixel nearby.",
  "eps-ind-b":
    "This brown dwarf pair moves 4.7″ per year east-southeast. Methane causes dips near 1.6, 2.2 and 3.3 µm (lit.).",
  "wise-0855":
    "This very cold brown dwarf is brightest in band B6, from 4.42 to 5.0 µm. Gaia does not detect it.",
  "rw-aur":
    "Dust crossing this young star causes irregular brightness changes.",
  "r-dra":
    "This pulsating red giant has a period of about 246 days (lit.). Look for large brightness changes.",
};

/** About, how to use, the science and the data, in one dialog. */
export function Guide({ onClose, onTour, hasTarget, multi }: { onClose: () => void; onTour: () => void; hasTarget: boolean; multi: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<Section>("about");

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
    tabsRef.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [section]);

  const panelId = `guide-${section}`;
  const keys = [
    ...(hasTarget && multi ? [["Space", "Play or pause"], ["← →", "Previous or next pass"], ["B", "Blink"], ["D", "Difference"]] : []),
    ...(hasTarget ? [["C", "Toggle Customize"], ["I", "Open details"], ["Arrows, Enter", "Move cursor; Enter measures"]] : []),
    ["?", "Open this guide"],
    ["Esc", "Close panels"],
  ];
  return (
    <dialog ref={ref} role="dialog" className={s.dialog} aria-labelledby="guide-title" onClose={onClose} onCancel={onClose}>
      <div className={s.head}>
        <h2 id="guide-title" className={`display ${s.title}`}>
          {APP_NAME}
        </h2>
        <GlassButton
          onClick={() => {
            onClose();
            onTour();
          }}
          icon="tour"
        >
          Start tour
        </GlassButton>
        <GlassButton variant="ghost" icon="close" label="Close guide" onClick={onClose} />
      </div>
      <div ref={tabsRef} className={s.tabs}>
        <Tabs label="Guide sections" value={section} onChange={setSection} tabs={SECTIONS.map((t) => ({ ...t, panelId }))} />
      </div>
      <div
        ref={bodyRef}
        className={s.body}
        id={panelId}
        role="tabpanel"
        aria-labelledby={`tab-${section}`}
        aria-label={`${SECTIONS.find((item) => item.value === section)?.label} guide content`}
        tabIndex={0}
      >
        {section === "about" && (
          <>
            <h3>About</h3>
            <p>Play SPHEREx passes as a flipbook to spot motion or brightness changes.</p>
          </>
        )}
        {section === "fieldguide" && (
          <>
            <h3>Spotting patterns</h3>
            <p className={s.note}>
              Citizen-science guide for distinguishing real celestial objects from instrumental artifacts.
            </p>
            <div className={s.cardGrid}>
              <div className={s.patternCard}>
                <svg viewBox="0 0 160 90" className={s.cardSvg} aria-label="Fast mover diagram">
                  <rect width="160" height="90" fill="var(--space-0)" />
                  <circle cx="26" cy="22" r="1.5" fill="var(--text-2)" opacity="0.35" />
                  <circle cx="132" cy="72" r="1.2" fill="var(--text-2)" opacity="0.3" />
                  <circle cx="138" cy="20" r="1.5" fill="var(--text-2)" opacity="0.35" />
                  <circle cx="38" cy="74" r="1.2" fill="var(--text-2)" opacity="0.3" />
                  <line x1="48" y1="58" x2="112" y2="34" stroke="var(--mover)" strokeWidth="1.5" strokeDasharray="3 3" opacity="0.65" />
                  <circle cx="48" cy="58" r="3" fill="var(--mover)" opacity="0.45" />
                  <circle cx="80" cy="46" r="3.5" fill="var(--mover)" opacity="0.75" />
                  <circle cx="112" cy="34" r="4.5" fill="var(--mover)" />
                  <path d="M110 30 L118 34 L111 38" fill="none" stroke="var(--mover)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <h4 className={s.cardTitle}>Mover (Real Motion)</h4>
                <p className={s.cardDesc}>
                  Watch for an object that jumps across pixels in a straight line between passes. Background stars stay completely stationary.
                </p>
              </div>

              <div className={s.patternCard}>
                <svg viewBox="0 0 160 90" className={s.cardSvg} aria-label="Difference dipole diagram">
                  <rect width="160" height="90" fill="var(--space-0)" />
                  <circle cx="24" cy="68" r="1.5" fill="var(--text-2)" opacity="0.3" />
                  <circle cx="136" cy="24" r="1.5" fill="var(--text-2)" opacity="0.3" />
                  <line x1="64" y1="45" x2="96" y2="45" stroke="var(--text-2)" strokeWidth="1" strokeDasharray="2 2" opacity="0.5" />
                  <circle cx="64" cy="45" r="8" fill="var(--text-2)" />
                  <text x="64" y="49" textAnchor="middle" fontSize="12" fontWeight="bold" fill="var(--space-0)">−</text>
                  <circle cx="96" cy="45" r="8" fill="var(--mover)" />
                  <text x="96" y="49" textAnchor="middle" fontSize="12" fontWeight="bold" fill="var(--space-0)">+</text>
                  <text x="64" y="70" textAnchor="middle" fontSize="8.5" fill="var(--text-2)">Was −</text>
                  <text x="96" y="70" textAnchor="middle" fontSize="8.5" fill="var(--mover)">Now +</text>
                </svg>
                <h4 className={s.cardTitle}>Difference Pair (Dipole)</h4>
                <p className={s.cardDesc}>
                  Subtracting an earlier pass leaves a side-by-side dipole: silver marks where the star was (past), amber marks where it is now (present).
                </p>
              </div>

              <div className={s.patternCard}>
                <svg viewBox="0 0 160 90" className={s.cardSvg} aria-label="Variable star diagram">
                  <rect width="160" height="90" fill="var(--space-0)" />
                  <line x1="80" y1="20" x2="80" y2="70" stroke="var(--grid-line)" strokeWidth="1" strokeDasharray="2 2" />
                  <line x1="55" y1="45" x2="105" y2="45" stroke="var(--grid-line)" strokeWidth="1" strokeDasharray="2 2" />
                  <circle cx="80" cy="45" r="18" fill="none" stroke="var(--accent)" strokeWidth="1" strokeDasharray="3 3" opacity="0.3" />
                  <circle cx="80" cy="45" r="11" fill="none" stroke="var(--accent)" strokeWidth="1.5" opacity="0.55" />
                  <circle cx="80" cy="45" r="5" fill="var(--accent)" />
                  <circle cx="28" cy="25" r="1.5" fill="var(--text-2)" opacity="0.3" />
                  <circle cx="132" cy="65" r="1.5" fill="var(--text-2)" opacity="0.3" />
                </svg>
                <h4 className={s.cardTitle}>Variable Star</h4>
                <p className={s.cardDesc}>
                  A pulsating star fluctuates in brightness and apparent size across survey dates while remaining centered at the exact same coordinates.
                </p>
              </div>

              <div className={s.patternCard}>
                <svg viewBox="0 0 160 90" className={s.cardSvg} aria-label="Cosmic-ray speck diagram">
                  <rect width="160" height="90" fill="var(--space-0)" />
                  <radialGradient id="starPsf" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="var(--star)" stopOpacity="0.8" />
                    <stop offset="100%" stopColor="var(--star)" stopOpacity="0" />
                  </radialGradient>
                  <circle cx="48" cy="45" r="10" fill="url(#starPsf)" />
                  <circle cx="48" cy="45" r="2.5" fill="var(--text-1)" />
                  <circle cx="122" cy="52" r="8" fill="url(#starPsf)" opacity="0.7" />
                  <circle cx="122" cy="52" r="2" fill="var(--text-1)" />
                  <rect x="83" y="36" width="3" height="3" fill="var(--flag)" />
                  <line x1="84.5" y1="28" x2="84.5" y2="47" stroke="var(--flag)" strokeWidth="1" opacity="0.8" />
                  <line x1="75" y1="37.5" x2="94" y2="37.5" stroke="var(--flag)" strokeWidth="1" opacity="0.8" />
                  <text x="84.5" y="66" textAnchor="middle" fontSize="9" fill="var(--flag)">1-frame artifact</text>
                </svg>
                <h4 className={s.cardTitle}>Cosmic-Ray Speck (Artifact)</h4>
                <p className={s.cardDesc}>
                  A sharp, single-pixel transient spike appearing in only one pass without a counterpart or motion vector. Cleaned as a masked flag.
                </p>
              </div>
            </div>

            <h3>Glossary</h3>
            <dl className={s.glossaryList}>
              <dt className={s.glossaryTerm}><Term term="arcminute">arcminute (′)</Term></dt>
              <dd className={s.glossaryDef}>Unit of angular width on the sky equal to 1/60th of a degree. The full Moon is about 31 arcminutes across.</dd>
              <dt className={s.glossaryTerm}><Term term="arcsecond">arcsecond (″)</Term></dt>
              <dd className={s.glossaryDef}>Unit of angular width equal to 1/60th of an arcminute (1/3600th of a degree). SPHEREx detector pixels are 6.15 arcseconds wide.</dd>
              <dt className={s.glossaryTerm}><Term term="mas">mas</Term></dt>
              <dd className={s.glossaryDef}>Milliarcsecond: one thousandth of an arcsecond. Used for precision stellar parallax and tiny annual shift measurements.</dd>
              <dt className={s.glossaryTerm}><Term term="parallax">parallax</Term></dt>
              <dd className={s.glossaryDef}>Apparent annual wobble of a nearby star against background stars as Earth orbits the Sun. Directly yields distance in light-years.</dd>
              <dt className={s.glossaryTerm}><Term term="proper motion">proper motion</Term></dt>
              <dd className={s.glossaryDef}>The true physical motion of a star through space across the sky, measured in arcseconds per year (″/yr).</dd>
              <dt className={s.glossaryTerm}><Term term="pass">pass</Term></dt>
              <dd className={s.glossaryDef}>One complete six-month survey sweep of the entire sky by the SPHEREx satellite.</dd>
              <dt className={s.glossaryTerm}><Term term="band">band</Term></dt>
              <dd className={s.glossaryDef}>One of SPHEREx's 6 spectral detector arrays (B1 to B6) spanning wavelengths from 0.75 to 5.0 µm.</dd>
              <dt className={s.glossaryTerm}><Term term="micron">micron (µm)</Term></dt>
              <dd className={s.glossaryDef}>One millionth of a metre (micrometer). Standard unit of wavelength for infrared light.</dd>
            </dl>
          </>
        )}
        {section === "use" && (
          <>
            <h3>Ways to look</h3>
            <dl className={s.kv}>
              <dt>Play all</dt>
              <dd>Every pass in order.</dd>
              <dt>Blink</dt>
              <dd>Alternates two passes.</dd>
              <dt>Difference</dt>
              <dd>Compares each pass with a reference. Silver marks where an object was; amber marks where it is now.</dd>
              <dt>Investigate</dt>
              <dd>Opens measurements.</dd>
            </dl>
            <h3>Measurements</h3>
            <dl className={s.kv}>
              <dt>Spectrum</dt>
              <dd>Brightness by infrared wavelength.</dd>
              <dt>Brightness</dt>
              <dd>Change between passes.</dd>
              <dt>Files</dt>
              <dd>Images used, with dates and wavelengths.</dd>
              <dt>Sky</dt>
              <dd>Position on the whole sky.</dd>
            </dl>
            <h3>Keyboard</h3>
            <dl className={s.keys}>
              {keys.map(([k, v]) => (
                <div key={k} className={s.keyRow}>
                  <dt>
                    <kbd className="mono">{k}</kbd>
                  </dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
        {section === "science" && (
          <>
            <h3>SPHEREx</h3>
            <p>Launched on 11 March 2025, SPHEREx maps the whole sky every six months in 102 infrared bands from 0.75 to 5.0 µm.</p>
            <h3>What to look for</h3>
            {PRESETS.map((p) => (
              <div key={p.id} className={s.target}>
                <h4>{p.name}</h4>
                <p>{NOTES[p.id]}</p>
              </div>
            ))}
            <h3>New movers</h3>
            <p>A distant object may leave a small silver and amber pair in Difference mode. Compare it with known asteroids.</p>
          </>
        )}
        {section === "data" && (
          <>
            <h3>Source</h3>
            <p>Featured targets use saved SPHEREx Level 2 cutouts. Other positions come from NASA/IPAC IRSA through our server.</p>
            <h3>Processing</h3>
            <ul>
              <li>Subtract sky background and mask flagged pixels.</li>
              <li>Align all cutouts to one grid.</li>
              <li>Stack frames into passes with matched bands where possible.</li>
              <li>Use one brightness stretch across all passes.</li>
            </ul>
            <p className={s.note}>Data: NASA/IPAC SPHEREx. Catalogue values: Gaia DR3 and cited literature.</p>
          </>
        )}
      </div>
    </dialog>
  );
}
