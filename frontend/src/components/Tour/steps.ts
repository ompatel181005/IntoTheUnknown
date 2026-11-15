export interface TourStep {
  /** Matches a data-tour attribute on the element to spotlight. */
  target: string;
  /** Used when `target` is not on screen (e.g. the phone layout). */
  fallback?: string;
  /** Round spotlight (for the dome or target star). */
  round?: boolean;
  /** Spotlight the centre of the target element (for the target star in the dome). */
  spotlightCenter?: boolean;
  title: string;
  text: string;
  /** What the app must show before this step: a loaded target, the drawer, or the Customize panel. */
  needs?: "view" | "drawer" | "customize";
}

export const TOUR: TourStep[] = [
  {
    target: "targets",
    title: "Find a target",
    text: "Explore 5 featured challenge targets or search by name and coordinates (RA, Dec).",
  },
  {
    target: "dome",
    needs: "view",
    round: true,
    title: "View the sky",
    text: "SPHEREx infrared images of this sky patch. North is up and East is left, looking up from Earth.",
  },
  {
    target: "target-star",
    fallback: "dome",
    needs: "view",
    round: true,
    spotlightCenter: true,
    title: "Spot the mover",
    text: "This star moves; the background stars do not. Watch the centre star hop across passes while distant stars stay still.",
  },
  {
    target: "play",
    needs: "view",
    title: "Press play",
    text: "Step through 6-month survey passes. Watch for position jumps in a straight line or brightness changes.",
  },
  {
    target: "modes",
    needs: "view",
    title: "Compare passes",
    text: "Blink toggles two passes to reveal jumps. Difference subtracts a baseline pass to leave a silver and amber pair.",
  },
  {
    target: "details",
    fallback: "details-btn",
    needs: "drawer",
    title: "Inspect measurements",
    text: "Click any pixel to inspect its 102-band infrared spectrum, track brightness over time, or check data flags.",
  },
];
