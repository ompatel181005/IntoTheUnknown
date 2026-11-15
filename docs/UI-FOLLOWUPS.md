# UI follow-ups

Items found during the UI polish rounds (2026-11-15). They are not done yet and are meant to be filed as GitHub issues later. Hotspot items need a team-chat post before anyone edits them.

## Layout and polish

- **Source chip collides under the eyepiece.** The source chip under the dome ("Saved SPHEREx cutouts · Saved snapshot · cached", added in #77) sits in the same strip as the one-time landing hint and the RA grid labels (for example `17:57:48.0`). At 1600x900, with Details closed, the texts overlap for a moment. Give the chip, the hint and the axis labels separate rows, or hide the axis labels under the hint while it shows.
- **Customize inset (hotspot: `App.tsx`).** With Customize open, the handle reaches x=344, but the eyepiece inset still reserves 316 px. Use `PANEL_W + 44 + GUTTER * 2` at `App.tsx` around line 317.
- **Phone Details layout (hotspot: `App.tsx` / `AppShell`).** At 390x844 with Details open, the current bottom reserve leaves the eyepiece dome about 4 px tall.
- **Details card overlaps the title.** For the first 0.2 s of opening Details, the card slides over the right half of the title while the title is still collapsing. This is a design call; it is left as is for now.
- **Saturn label clipping.** Planet labels avoid the screen edge but not the left list panel, so Saturn's label can clip behind it.
- **Home legend.** Add a small legend on the home screen that explains the point kinds (star, brown dwarf, variable, and any later kinds such as dwarf planet). Coordinate with the education panel so it is not duplicated.
- **Tour spotlight.** The new single handles on the list panel and on Customize have not been tested against the Tour spotlight.

## Performance

- **HomePanel re-renders.** HomePanel re-renders its whole list on every App update, which costs about 14 ms on each Details click. Memoise it, or pass stable props from `App.tsx` (hotspot).
- **Search typing.** Each keystroke in the list search commits the whole App. Search state could live inside HomePanel.
- **Number formatting.** `lib/format.ts` should reuse one cached `Intl.NumberFormat`, since `toLocaleString` costs about 4 ms when Details mounts.
- **Phone grid rebuild.** On phones, opening the Details sheet rebuilds the SkyStage grid JSX (about 66 ms), which causes 100 to 200 ms frames.
- **GPU benchmark.** Re-run the RTX benchmark (idle, flight to Barnard's Star, return home) on an idle machine. The 2026-11-15 runs were noisy for both the old and the new build, with 49 to 89 idle frames out of 90 and no regression visible above the noise.

## Data

- **Blob catalog.** Upload `frames/catalog/points.json` to Blob; the command is in the #76 PR description. Until then the app falls back to the bundled copy and logs a 404.

## Pitch-safe claims (checked 2026-11-15)

- **Distances.** "Every target sits in its true direction on the sky, and depth order follows measured Gaia parallaxes exactly: the nearer of any two targets is always drawn nearer. Distance itself is compressed logarithmically, so Proxima Centauri at 4 light-years and R Draconis at 2,600 light-years fit in one view."
  - Do not say "to scale". Each tenfold increase in distance adds 1.5 scene units, so the 45 targets with a distance (4 to 3,100 light-years) sit between 14.3 and 18.6 units, all beyond Neptune at 8.35.
  - Do not say that every target has a distance. CWISE J1249+3621 and V346 Nor have no parallax and sit on the far sky in their true direction.
- **Sky and constellations.** "The background sky is the real night sky: about 8,400 naked-eye stars from the Yale Bright Star Catalogue, and the planets from JPL orbital elements, all placed in the standard J2000 frame. Star positions are accurate to better than a hundredth of a degree, so the constellations look the way you see them from Earth, not mirrored."
  - How it was checked: 20 bright stars matched Astropy to within 0.00001 degrees, and Orion renders the right way round.
  - The catalog rounds positions to 0.001 degrees and freezes the stars at the year 2000, so quote "better than a hundredth of a degree", not the raw conversion figure.
  - Caveats if asked: the home view looks at the solar system from outside, and the planets and the Sun are drawn enlarged.
