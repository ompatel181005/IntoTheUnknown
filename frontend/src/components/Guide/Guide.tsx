import { useEffect, useRef, useState } from "react";
import { APP_NAME } from "../../lib/brand";
import { PRESETS } from "../../lib/targets";
import { GlassButton, Tabs } from "../glass";
import s from "./Guide.module.css";

type Section = "about" | "use" | "science" | "data";

const SECTIONS: { value: Section; label: string }[] = [
  { value: "about", label: "About" },
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
  const [section, setSection] = useState<Section>("about");

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const panelId = `guide-${section}`;
  const keys = [
    ...(hasTarget && multi ? [["Space", "Play or pause"], ["← →", "Previous or next pass"], ["B", "Blink"], ["D", "Difference"]] : []),
    ...(hasTarget ? [["C", "Toggle Customize"], ["I", "Open details"], ["Arrows, Enter", "Move cursor; Enter measures"]] : []),
    ["?", "Open this guide"],
    ["Esc", "Close panels"],
  ];
  return (
    <dialog ref={ref} className={s.dialog} aria-labelledby="guide-title" onClose={onClose} onCancel={onClose}>
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
      <div className={s.tabs}>
        <Tabs label="Guide sections" value={section} onChange={setSection} tabs={SECTIONS.map((t) => ({ ...t, panelId }))} />
      </div>
      <div className={s.body} id={panelId} role="tabpanel" aria-labelledby={`tab-${section}`}>
        {section === "about" && (
          <>
            <h3>About</h3>
            <p>Play SPHEREx passes as a flipbook to spot motion or brightness changes.</p>
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
