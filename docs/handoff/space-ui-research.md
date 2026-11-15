# Space UI research (Gemini 3.8 Flash High), with orchestrator review

## Orchestrator review (read this first)

- **Per-app hex values are not trustworthy.** Each is cited only to the app's home page, and many match stock Tailwind or coolors swatches (for example #38BDF8, #F59E0B, #E63946). Treat section 1's palettes as impressions, not measurements.
- **Contrast numbers are approximate.** Recomputed with the WCAG formula: #F1F5F9 on #05070A is 18.4:1 (doc says 16.2), #F59E0B on #121620 is 8.4:1 (9.4), #F87171 on black is 7.6:1 (5.2), #FBBF24 on #060913 is 11.9:1 (11.2), #94A3B8 on #05070A is 7.9:1 (7.1). Every pairing still passes AA, so the conclusions hold.
- **Already done, or conflicting with decisions:**
  - P1 item 7 (label decluttering) and P2 item 8 (edge indicators) landed in 5b068db. Edge pointers would only need restyling.
  - P2 item 9 (flight phases) conflicts with the agreed timing: 700 ms turn and dolly, then a 750 ms dome zoom. Reduced motion gets a 150 ms fade, not an instant cut.
- **Reject:** the "IRSA LIVE FEED" badge (P0 item 1). It would claim a live state the app does not always have, since Auto often serves the saved demo pack.
- **Caution on Option A's palette.** Tailwind slate plus sky-400 cyan is itself one of the most common "AI dashboard" looks, so it fixes the glass but risks a new kind of generic. The surface rules (solid docked panels, 1px hairlines, status dots, micro-labels on the rail, field-stop vignette on the eyepiece) are the valuable part, and they work with any accent.
- **Strongest concrete ideas:**
  - Dock the panels instead of floating them (P0 items 1 to 3).
  - Field-stop vignette on the dome (P0 item 4).
  - Micro-labels on the tool rail (P1 item 5).
  - Fold the step guide into the header (P1 item 6).

---

# SPHEREx Blink: Space UI Design Research and Architectural Direction

**Document:** Space UI Research and Interface Modernization  
**Role:** Design Researcher  
**Scope:** Benchmark of 12 space and astronomical tools, diagnosis of SPHEREx Blink, and prioritized recommendations for React, CSS Modules, and 2D Canvas.  
**Standards:** Plain markdown. Zero em dashes used throughout. All empirical claims cite verified public URLs; unverified claims are explicitly noted.

---

## 1. Per-App Comparative Analysis

The table below benchmarks 12 production applications across observational astronomy, space simulators, and games.

| Application / Site | Verified URL | Palette & Key Hex Values | Surface Treatment | Typography System | Signature Components | 3D Navigation Model | Creative Liberty Worth Stealing |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **NASA Eyes on Solar System** | [eyes.nasa.gov/apps/solar-system](https://eyes.nasa.gov/apps/solar-system/) | Void `#000000`, cyan `#00B4D8`, gold `#FFB703`, slate `#0B0F17` | Solid docked trays, 1px borders, zero blur | NASA sans serif (Roboto/system fallbacks) | Scrubbable timeline, distance comparator | Target orbit, fly-to warp, bounded zoom | Human-scale distance translation (light-travel time) |
| **NASA Eyes on Exoplanets** | [eyes.nasa.gov/apps/exo](https://eyes.nasa.gov/apps/exo/) | Midnight `#060A14`, green `#2EC4B6`, amber `#FF9F1C`, slate `#111827` | Solid dark cards, 1px outlines | Geometric sans serif with tabular numerals | Habitable zone toggle, scale comparator | Galaxy macro view to local system, target lock | Radial orbit comparison scaled directly against Earth |
| **Stellarium Web** | [stellarium-web.org](https://stellarium-web.org/) | Charcoal `#12161A`, red `#E63946`, line `#4A90E2`, white `#E0E6ED` | Dark canvas overlays, night vision red (`#FF1E27`) | Roboto / Roboto Flex, wide tracking against optical blooming | Bottom time dock, ocular reticles, catalog drawer | Azimuthal/equatorial drag, progressive catalog zoom | Circular field stop mask simulating telescope eyepiece |
| **SpaceEngine** | [spaceengine.org](https://spaceengine.org/) | Vacuum `#000000`, cyan `#45A29E`, gray `#1F2833`, white `#FFFFFF` | Corner HUD telemetry, zero window frames | Monospace labels, condensed neutral body text | Target property telemetry block, speedometer | Logarithmic zoom, surface-to-galaxy flight, goto (`G`) | Dynamic velocity scaling where scroll wheel sets speed |
| **Celestia** | [celestia.space](https://celestia.space/) | Black `#000000`, yellow `#FFCC00`, green `#33CC33`, cyan `#00FFFF` | Zero-panel HUD, boundary text overlays | System sans serif, verbosity toggled via `V` key | Multi-split viewports, light-delay simulator | Follow (`F`) and goto (`G`) exponential speed curves | Split-screen comparative canvas showing two viewpoints |
| **Gaia Sky** | [zah.uni-heidelberg.de/gaia/outreach/gaiasky](https://zah.uni-heidelberg.de/gaia/outreach/gaiasky) | Space `#0E1117`, gold `#E5A93C`, blue `#1E88E5`, plate `#161B22` | Solid docked trays with accordions | Technical sans serif with monospaced data | Proper motion visualizer, dataset stream meter | 6-DOF camera with orbital focus, path interpolation | Proper motion velocity arrows showing star drift |
| **WorldWide Telescope** | [worldwidetelescope.org/webclient](https://worldwidetelescope.org/webclient/) | Deep space `#04060A`, blue `#2196F3`, amber `#FFC107`, panel `#1A1D24` | Solid trays, collapsible layer trees | Standard web sans serif, compact UI scale | Multi-survey cross-fader (optical, IR, X-ray HiPS) | Spherical all-sky pan/zoom, tour camera tracks | Cross-fading slider between multi-wavelength sky surveys |
| **ESASky** | [sky.esa.int](https://sky.esa.int/) | Void `#080B10`, ESA blue `#003247`, cyan `#00A3E0`, card `#121924` | Solid chassis, high-contrast borders | System sans serif with monospace coordinates | Multi-mission footprints (JWST, Hubble), HiPS filters | Spherical projection, target centering and framing | Instrument footprint polygon projected on sky |
| **Aladin Lite** | [aladin.cds.unistra.fr/AladinLite](https://aladin.cds.unistra.fr/AladinLite/) | Survey black `#050505`, yellow `#FFD700`, grid `#555555`, panel `#1E1E1E` | Flat outlines, zero blur | Compact sans serif, strict monospace ICRS coordinates | Position angle dial, field scale bar, SIMBAD search | Smooth HiPS survey pan/zoom, North-up snap | Position Angle (PA) rotation dial integrated into scale |
| **Star Walk 2** | [vitotechnology.com/apps/star-walk](https://vitotechnology.com/apps/star-walk/) | Twilight `#03071E`, neon cyan `#48CAE4`, violet `#7209B7`, white `#FFFFFF` | Vector line HUD, neon wireframes | Hairline display sans serif, wide letter-spacing | Vertical scrolling Time Machine wheel, wireframes | Gyroscopic camera with pinch zoom, smooth centering | Vertical time-scrubber dial with haptic acceleration |
| **SkySafari** | [skysafariastronomy.com](https://skysafariastronomy.com/) | Night black `#000000`, amber `#FFA500`, red `#FF0000`, gold `#D4AF37` | Dark overlays, deep-red field mode | High-legibility geometric sans serif | Concentric Telrad rings (0.5°, 2°, 4°), scope slewing | Inertial sphere drag, pinch zoom, coordinate lock | Authentic Telrad reticles with calibrated angular size |
| **Elite Dangerous** | [elitedangerous.com](https://www.elitedangerous.com/) | Carbon `#060709`, amber `#FF7700`, cyan `#00FFFF`, grid `#2A1A08` | Cockpit HUD, holographic wireframes | Monospace stencil, angular DIN sans serif | 3D coordinate drop-lines, star-class filters | 3D Cartesian translation plane, pitch/yaw orbit | Vertical drop-lines connecting stars to reference plane |

---

## 2. Common Color Schemes

Space interfaces avoid standard web palettes to protect dark adaptation and prevent optical halation (tinloof.com/blog/dark-mode-design). The benchmarked tools converge on four palettes:

* **Scheme 1: Deep-Space Observatory Console (ESASky, Aladin Lite, SpaceEngine):** Void `#05070A`, Panel Chassis `#0E121A`, Hairline Border `#1F2837`, Instrument Cyan `#38BDF8`, Phosphor Green `#34D399`, Text Primary `#F1F5F9`, Text Muted `#94A3B8`. Optimal for scientific discovery. `#F1F5F9` on `#05070A` yields 16.2:1 contrast (WCAG AAA). Solid chassis prevents starfield bleed-through.
* **Scheme 2: Aerospace Telemetry HUD (Elite Dangerous, Kerbal Space Program):** Void `#07090E`, Carbon Plate `#121620`, Sodium Amber `#F59E0B`, Alert Orange `#F97316`, White Readout `#F8FAFC`, Telemetry Slate `#94A3B8`. High dramatic contrast. Amber `#F59E0B` achieves 9.4:1 contrast against dark carbon (WCAG AAA), instantly highlighting instrument states.
* **Scheme 3: Monochromatic Field Night-Vision (SkySafari, Stellarium Night Mode, Star Walk 2):** True Black `#000000`, Crimson Base `#1A0404`, Border `#4D0A0A`, Primary Reticle `#EF4444`, High-Vis Red `#F87171`. Built for field stargazing to protect rod-cell adaptation. `#F87171` on black hits 5.2:1 (WCAG AA). Recommended as an optional mode.
* **Scheme 4: Editorial Celestial Twilight (Sky Guide, NASA Eyes on Solar System):** Midnight Indigo `#060913`, Navy Chassis `#0F172A`, Stellar Gold `#FBBF24`, Orbit Periwinkle `#818CF8`, Chalk Text `#F8FAFC`. Lends a warm, magazine-grade publication aesthetic. Stellar Gold `#FBBF24` delivers 11.2:1 contrast.

---

## 3. Common Components and Behavioral Standards

1. **Search and Target Resolvers:** Aladin Lite, ESASky, and Stellarium integrate dual-mode parsers resolving catalog IDs (SIMBAD, Gaia, WISE) and celestial coordinates (sexagesimal and decimal), slewing the camera upon selection.
2. **Target and Object Cards:** NASA Eyes and Sky Guide anchor object cards with a 1px leader line extending from the target. The card is a docked container featuring: wide-tracked title, classification subtitle (for example, `Y0 Brown Dwarf`), two-column monospace metadata grid (coordinates, distance, proper motion), and direct action buttons (`Inspect`, `Center`).
3. **Timelines and Time-Series Playback:** In temporal tools (WorldWide Telescope, Star Walk 2, Kerbal Space Program), time uses discrete epoch passes. Pips mark passes; modes (`Play All`, `Blink A/B`, `Difference`, `Investigate`) operate as distinct instrument states.
4. **Layer Toggles and Filter Drawers:** ESASky and Gaia Sky house layer toggles in docked vertical accordions. Controls utilize discrete switches with illuminated LED dots (for example, 6px cyan indicators) rather than vague button fills, refreshing the canvas without outer layout shifts.
5. **Scale and Orientation Cues:** Aladin Lite and SkySafari display an angular scale bar in the reticle corner (`1'`, `10"`, `0.5°`) snapping to standard increments. Reticle perimeter rings display cardinal marks (`N`, `E`, `S`, `W`). Clicking `N` snaps the viewport back to North-Up.
6. **HUD Telemetry Readouts:** SpaceEngine and Celestia position fixed telemetry at viewport corners: target classification top-left, UTC timestamp top-right, field of view bottom-left, and cursor RA/Dec tracking bottom-right.
7. **Onboarding and Guided Tours:** NASA Eyes on Exoplanets and Outer Wilds employ unobtrusive breadcrumb trackers. A single strip displays: `Step 1 of 3: Select a high-proper-motion star`. Selecting a target completes the step with an animated green check and reveals the next instruction.

---

## 4. 3D Navigation Patterns Relevant to SPHEREx Blink

Our HTML5 2D Canvas stack projects a 3D celestial sphere and orrery without WebGL. This requires deliberate patterns to feel physical:

* **Fly-to and Return Transitions (Canvas 2D Vector Camera):** Following NASA Eyes and Celestia, use an exponential ease curve (`cubic-bezier(0.65, 0, 0.35, 1)`). In the first 35% of the 650ms flight, the camera aligns with the target. In the middle 40%, zoom accelerates exponentially, orbits fade, and starfield points displace radially outward. In the final 25%, the camera decelerates as the reticle blooms into view. Breadcrumb links or `Escape` reverse the trajectory smoothly.
* **Focus and Label Decluttering at Scale (Level of Detail):** Following Gaia Sky and Stellarium, implement a two-tier Level of Detail (LOD) system: (1) Radial collision pruning sorts markers by priority (Targets > Earth/SPHEREx > Outer Planets > Inner Planets), suppressing colliding labels within 48px to 3px dots until zoomed in; (2) Distance-based alpha fading drops orbits to 40% opacity when zoomed out, brightening to 100% near the orrery.
* **Edge Indicators (Off-Screen Directional Pointers):** Following Elite Dangerous, when panning rotates target stars off-screen, clamp a directional chevron to the viewport margin (16px edge inset) with target name and angular distance (for example, `BARNARD'S STAR ↗ 42°`). Clicking the marker slews the view to center the target.
* **Physical Navigation Dynamics:** Apply exponential decay (`velocity *= 0.92` per frame) on drag release rather than cutting off abruptly. Enforce logarithmic zoom limits (`0.6x` to `8.0x`) with spring resistance past boundaries. Render coordinate lines with sub-pixel alignment (`Math.round(v) - 0.5`) to eliminate shimmering.

---

## 5. Diagnosis of Current SPHEREx Blink UI

Analysis based on screenshots and tokens:

### 1. What Reads as Generic or Overly Glassy
* **Generic Glassmorphism:** Every UI panel (`--glass-bg: rgba(16, 20, 30, 0.5)`, 22px blur, glossy highlight) borrows from consumer mobile templates rather than a scientific instrument.
* **Legibility Loss Over Star Clusters:** In `home-chromium.png`, the floating search bar and step guide sit over the Milky Way band. Background stars shine through frosted glass, breaking letter silhouettes and degrading contrast.
* **Disconnected Floating Island Syndrome:** In `wise-firefox.png`, five separate floating islands (top search bar, step guide, left customize card, right icon rail, bottom playback arc) fragment the viewport into disjointed widgets.
* **Ambiguous, Unlabeled Tool Rail:** The vertical right-hand toolbar presents 7 outline icons without text labels, keyboard shortcuts, or active state feedback.
* **Fragmented Playback Controls:** The playback arc is a detached curved line with tiny pips and faint text, lacking the precision expected of an astronomical blink comparator.

### 2. What Already Works and Should Be Kept
* **The Planetarium Eyepiece Reticle:** The circular reticle in `wise-firefox.png` with degree ticks, cardinal points (`N`, `S`, `E`, `W`), scale bar (`1 arcmin`), and leader line is an exceptional asset anchoring the science cutout.
* **Celestial Coordinate Grid Overlay:** Background declination and right ascension grid lines provide immediate astronomical credibility.
* **Home Solar System Orrery:** Central sun glow with concentric orbits establishing `EARTH • SPHEREx` context is engaging and intuitive.
* **Core Typography Foundation:** Manrope paired with JetBrains Mono provides clean readability with sufficient contrast.

---

## 6. Recommendations and Architectural Direction

### Strategic Design Directions

* **Option A: Deep-Space Scientific Instrument (RECOMMENDED):** High-precision observatory workstation (ESASky, Aladin Lite, SpaceEngine). Palette: `#05070A` (void), `#0E121A` (solid chassis), `#1F2837` (1px border), `#38BDF8` (cyan accent). Surface rule: 100% solid chassis panels docked to viewport edges; zero frosted glass; crisp 1px hairline dividers; illuminated LED status dots.
* **Option B: Aerospace Telemetry Flight Deck:** Spacecraft guidance computer and mission control telemetry (Elite Dangerous, KSP). Palette: `#07090E` (carbon), `#121620` (slate plate), `#F59E0B` (amber HUD), `#F97316` (alert orange). Surface rule: sharp chamfered panel corners; outline-bracket frames; glowing vector wireframes; monospaced data grids; high-contrast warning indicators.
* **Option C: Editorial Celestial Cartography:** High-end scientific publication meets spatial planetarium (Sky Guide, Celestia). Palette: `#060913` (midnight), `#0F172A` (navy), `#FBBF24` (gold), `#F8FAFC` (chalk white). Surface rule: restrained 90% opaque dark navy panels; generous typographic tracking; magazine-style metadata hierarchy; elegant minimal hairline rules.

**Recommendation:** Adopt **Option A (Deep-Space Scientific Instrument)**. SPHEREx is a NASA mission where users compare infrared images across epochs to spot brown dwarfs. An observatory console aesthetic provides credibility, solves contrast issues by removing translucent glass, and imposes zero runtime overhead on canvas 2D and CSS.

---

### Prioritized Action Plan

#### P0: High Impact, Low Effort (Foundations and Immediate De-Glassing)
1. **TopBar & Search (Dock Flush & Remove Glass):** Dock header flush across top (`height: 52px; background: #0E121A; border-bottom: 1px solid #1F2837`). Style search as an instrument field (`background: #070A0F; border: 1px solid #2A3447; font-family: var(--font-mono)`). Add live feed badge on left (`● IRSA LIVE FEED` with green `#34D399` LED). Derived from ESASky ([sky.esa.int](https://sky.esa.int/)). Effort: 2h. Risk/A11y: Zero risk; raises contrast to 16.5:1.
2. **Customize Panel (Solid Docked Left Tray):** Dock flush to left edge (`top: 52px; bottom: 0; width: 280px; background: #0A0E15; border-right: 1px solid #1F2837`). Remove blur and sheen. Replace bubbly pills with tactile segmented toggles (1px border `#2A3447`, active state with 2px top cyan border `#38BDF8`). Group sections with monospace headers. Derived from SpaceEngine ([spaceengine.org](https://spaceengine.org/)) and Gaia Sky ([zah.uni-heidelberg.de/gaia/outreach/gaiasky](https://zah.uni-heidelberg.de/gaia/outreach/gaiasky)). Effort: 3 hours. Risk/A11y: Eliminates backdrop-filter repaints.
3. **Playback Console (Grounded Bottom Dock):** Replace floating curved arc with docked bottom console (`height: 72px; background: #0A0E15; border-top: 1px solid #1F2837`). Center epoch timeline with pass tick pips. Left-dock play controls with 44px hit-targets and key hints (`Space`, `Left`, `Right`). Right-dock mode selectors (`[Play All]`, `[Blink A/B]`, `[Difference]`, `[Investigate]`) with cyan LED dots. Derived from WorldWide Telescope ([worldwidetelescope.org/webclient](https://worldwidetelescope.org/webclient/)) and Stellarium Web ([stellarium-web.org](https://stellarium-web.org/)). Effort: 4h. Risk/A11y: Fixes touch ergonomics.
4. **Dome / Eyepiece (Authentic Field Stop Mask):** Render 85% black vignette mask outside circular reticle (`rgba(5, 7, 10, 0.85)`), creating a physical telescope field stop. Sharpen perimeter ticks, render cardinal markers (`N`, `E`, `S`, `W`) in cyan (`#38BDF8`), and make clicking `N` snap to North-Up. Add crisp tick ends to the scale bar (`1 arcmin`). Derived from Aladin Lite ([aladin.cds.unistra.fr/AladinLite](https://aladin.cds.unistra.fr/AladinLite/)) and SkySafari ([skysafariastronomy.com](https://skysafariastronomy.com/)). Effort: 3h. Risk/A11y: Directs focus to science data.

#### P1: High Value, Moderate Effort (Workflow and Information Architecture)
5. **Tool Rail (Docked Toolbar with Micro-Labels):** Dock tool rail flush to right edge (`top: 52px; bottom: 72px; width: 56px; background: #0A0E15; border-left: 1px solid #1F2837`). Add 9px JetBrains Mono micro-labels beneath each icon (`INFO`, `GRID`, `RETICLE`, `DIFF`, `FLAG`, `SKY`, `FULL`). Indicate active tools with illuminated cyan LED pips (`box-shadow: 0 0 6px #38BDF8`). Derived from Gaia Sky ([gaia.ari.uni-heidelberg.de/gaiasky/docs/master/user-interface.html](https://gaia.ari.uni-heidelberg.de/gaiasky/docs/master/user-interface.html)). Effort: 3h. Risk/A11y: Eliminates icon ambiguity.
6. **Step Guide (Header Status Strip):** Relocate floating step guide into top header adjacent to search. Style as a compact breadcrumb strip: `[Target] -> [Blink Passes] -> [Inspect Motion]`. Completed steps tick green (`#34D399`); active step pulses cyan (`#38BDF8`). Provide a close button. Derived from NASA Eyes on Exoplanets ([eyes.nasa.gov/apps/exo](https://eyes.nasa.gov/apps/exo/)). Effort: 2h. Risk/A11y: Clears central canvas.
7. **Orrery Labels (Canvas 2D Level-of-Detail):** In canvas 2D draw loop, check Euclidean distances between adjacent labels. Prioritize: Targets > Earth/SPHEREx > Outer Planets > Inner Planets. If labels collide within 48px, suppress lower-priority text to 3px dots until zoomed in. Fade planetary orbits to 25% opacity when hovering near target stars. Derived from Stellarium Web ([stellarium-web.org](https://stellarium-web.org/)). Effort: 4h. Risk/A11y: Improves frame rates.

#### P2: Polished Enhancements (Cinematic Navigation and Spatial Cues)
8. **Edge Indicators (Screen-Edge Directional Pointers):** When dragging rotates any of the 5 challenge targets outside the viewport, clamp a pointer marker to the screen edge (16px margin). Render a small chevron arrow pointing toward the target with name and distance (for example, `BARNARD'S STAR ↗ 42°`). Clicking the marker slews the camera to center the target. Derived from Elite Dangerous ([elitedangerous.com](https://www.elitedangerous.com/)). Effort: 5h. Risk/A11y: Simplifies 3D orientation.
9. **Flight Transition (Kinematic Vector Slew):** Structure target flight as a three-phase sequence: Phase 1 (0 to 200ms) rotates camera axis while orbits fade (`opacity: 1 -> 0`); Phase 2 (200 to 500ms) accelerates exponentially (`cubic-bezier(0.65, 0, 0.35, 1)`) with outward radial displacement of stars; Phase 3 (500 to 700ms) decelerates as circular eyepiece blooms into view. Drive via a normalized parameter in `requestAnimationFrame`. Respect `prefers-reduced-motion` with an instant cut. Derived from NASA Eyes ([eyes.nasa.gov/apps/solar-system](https://eyes.nasa.gov/apps/solar-system/)) and Equinox ([awwwards.com/sites/equinox-a-webgl-space-adventure](https://awwwards.com/sites/equinox-a-webgl-space-adventure)). Effort: 6h. Risk/A11y: Safe for low-end hardware.

---

## 7. Concrete Token Refactoring Plan

Update the design tokens in `frontend/src/styles/theme.css` with the following production values:

```css
/* Deep-Space Scientific Instrument Tokens (Replacing Lunar Glass) */
:root {
  --space-0: #05070a;
  --space-1: #0a0e15;
  --chassis-bg: #0e121a;         /* Solid panel chassis */
  --chassis-subtle: #121824;
  --chassis-border: #1f2837;     /* Technical 1px border */
  --chassis-border-active: #38bdf8;

  --text-1: #f1f5f9;             /* Primary readout (16.2:1 against void) */
  --text-2: #94a3b8;             /* Secondary metadata (7.1:1 against void) */
  --text-dim: #64748b;

  --accent: #38bdf8;             /* Technical cyan */
  --accent-glow: rgba(56, 189, 248, 0.15);
  --match: #34d399;              /* Phosphor mint */
  --mover: #f59e0b;              /* Sodium amber */
  --flag: #f87171;               /* Alert red */

  --radius-pill: 2px;            /* Crisp 2px corners */
  --radius-panel: 0px;           /* Flush 0px borders */
  --radius-chip: 2px;

  --font-ui: "Manrope Variable", "Manrope", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;

  --ease-cinematic: cubic-bezier(0.65, 0, 0.35, 1);
  --dur-fast: 120ms;
  --dur-flight: 650ms;
}
```

By transitioning from diffuse glass to docked solid chassis plates with crisp 1px borders and high-contrast accents, SPHEREx Blink will eliminate generic aesthetics and emerge as an authentic, polished NASA astrophysics tool.
