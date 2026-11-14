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

const KEYS: [string, string][] = [
  ["Space", "Play or pause"],
  ["← →", "Previous or next pass"],
  ["B", "Blink"],
  ["D", "Difference"],
  ["C", "Show or hide Customize"],
  ["I", "Details and measurements"],
  ["Arrows, Enter", "On the image: move the cursor, measure"],
  ["?", "This guide"],
  ["Esc", "Close panels"],
];

// Detailed notes per target, adapted from the initialammar guide. (lit.) marks values not yet verified.
const NOTES: Record<string, string> = {
  barnard:
    "The fastest-moving star on the sky, 10.4″ per year, which is 1.7 SPHEREx pixels. Between passes six months apart it shifts visibly north. Its core is bright enough to saturate SPHEREx, so measure it on the wings or pick a fainter star.",
  "eps-ind-b":
    "A pair of brown dwarfs orbiting the star ε Indi A. It moves 4.7″ per year toward the east-southeast. Methane absorbs light near 1.6, 2.2 and 3.3 µm (lit.), so its spectrum has sharp dips.",
  "wise-0855":
    "The coldest known brown dwarf, close to room temperature (lit.). It is nearly invisible at short wavelengths, so its preset uses band B6 (4.42 to 5.0 µm). It is not in Gaia, which is exactly how an unknown mover would look.",
  "rw-aur":
    "A young star still wrapped in its dusty birth disc. It dims and brightens irregularly as dust passes in front of it, so look for a change in brightness rather than motion.",
  "r-dra":
    "A Mira variable: a pulsating red giant with a period of about 246 days (lit.). It changes brightness a lot between passes. It sits near the ecliptic pole, so SPHEREx sees it on many short visits.",
};

/** About, how to use, the science and the data, in one dialog. */
export function Guide({ onClose, onTour }: { onClose: () => void; onTour: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState<Section>("about");

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const panelId = `guide-${section}`;
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
          Take the tour
        </GlassButton>
        <GlassButton variant="ghost" icon="close" label="Close guide" onClick={onClose} />
      </div>
      <div className={s.tabs}>
        <Tabs label="Guide sections" value={section} onChange={setSection} tabs={SECTIONS.map((t) => ({ ...t, panelId }))} />
      </div>
      <div className={s.body} id={panelId} role="tabpanel" aria-labelledby={`tab-${section}`}>
        {section === "about" && (
          <>
            <h3>What this is</h3>
            <p>
              Pick a spot on the sky and see every pass NASA's SPHEREx telescope has made over it, played as a flipbook. Anything that moves
              or changes brightness between passes stands out against the fixed background stars.
            </p>
            <p>
              Astronomers have "blinked" images like this for a century. Clyde Tombaugh found Pluto in 1930 by flipping between two
              photographic plates. SPHEREx brings the method to an infrared survey of the whole sky, repeated every six months.
            </p>
            <h3>Built for</h3>
            <p>NASA Space Apps 2026, challenge "Planet X and SPHEREx". Citizen scientists first: no login, no install.</p>
          </>
        )}
        {section === "use" && (
          <>
            <h3>Three steps</h3>
            <ol>
              <li>Pick a target from the top bar or the whole-sky map, or search a name or RA, Dec.</li>
              <li>Press Play. Each frame is a different pass, months apart.</li>
              <li>Watch for the dot that moves. Try Blink and Difference to make it pop.</li>
            </ol>
            <h3>Ways to look</h3>
            <dl className={s.kv}>
              <dt>Play all</dt>
              <dd>Every pass in order.</dd>
              <dt>Blink</dt>
              <dd>Flips between two passes, like Tombaugh's blink comparator.</dd>
              <dt>Difference</dt>
              <dd>Each pass minus a reference pass. Everything that stayed the same turns black. A moving star leaves silver where it was and amber where it is now; a star that changes brightness glows one colour.</dd>
              <dt>Investigate</dt>
              <dd>Opens the measurements for the current pass.</dd>
            </dl>
            <h3>Measurements</h3>
            <dl className={s.kv}>
              <dt>Spectrum</dt>
              <dd>The brightness of the spot you clicked in every frame of this pass, by infrared wavelength.</dd>
              <dt>Brightness</dt>
              <dd>Whether it gets brighter or fainter between passes.</dd>
              <dt>Files</dt>
              <dd>Every SPHEREx image used, with date, detector and wavelength.</dd>
              <dt>Sky</dt>
              <dd>Where this patch is on the whole sky.</dd>
            </dl>
            <h3>Keyboard</h3>
            <dl className={s.keys}>
              {KEYS.map(([k, v]) => (
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
            <h3>What SPHEREx is</h3>
            <p>
              NASA's SPHEREx telescope launched on 11 March 2025. It maps the whole sky every six months in 102 infrared colours from 0.75 to
              5.0 µm. Six detectors each sit behind a filter whose colour changes smoothly across the detector, so as SPHEREx steps across the
              sky a star lands on a different colour in each exposure.
            </p>
            <h3>What to look for</h3>
            {PRESETS.map((p) => (
              <div key={p.id} className={s.target}>
                <h4>{p.name}</h4>
                <p>{NOTES[p.id]}</p>
              </div>
            ))}
            <h3>Hunting for something new</h3>
            <p>
              A distant, undiscovered planet would move only a little between passes. Look for something in Difference mode that leaves a
              silver and amber pair but is not a known Gaia star. Near the ecliptic (the dashed line on the sky map), asteroids do this too,
              so check before you get excited.
            </p>
          </>
        )}
        {section === "data" && (
          <>
            <h3>Where the images come from</h3>
            <p>
              The five targets use real SPHEREx Level 2 cutouts downloaded from NASA/IPAC IRSA and bundled with the app, so they load even
              when the archive is busy. Any other position is fetched live from IRSA through our server.
            </p>
            <h3>How the images are processed</h3>
            <ul>
              <li>Subtract the zodiacal light and each image's sky level, and mask flagged pixels.</li>
              <li>Resample every cutout onto one north-up grid of 6.15″ pixels, because SPHEREx rotates between visits.</li>
              <li>Group frames into passes and stack each pass, using the same colour channels in every pass where possible.</li>
              <li>Show every pass with one shared brightness stretch, so changes are real and not a display effect.</li>
            </ul>
            <p className={s.note}>Every number on screen comes from these files or from the catalogues listed in docs/TARGETS.md. Data: NASA/IPAC SPHEREx.</p>
          </>
        )}
      </div>
    </dialog>
  );
}
