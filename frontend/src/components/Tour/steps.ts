export interface TourStep {
  /** Matches a data-tour attribute on the element to spotlight. */
  target: string;
  /** Used when `target` is not on screen (e.g. the phone layout). */
  fallback?: string;
  /** Round spotlight (for the dome). */
  round?: boolean;
  title: string;
  text: string;
  /** What the app must show before this step: a loaded target, the drawer, or the Customize panel. */
  needs?: "view" | "drawer" | "customize";
}

// Adapted from the guided tour on the initialammar prototype, rewritten for this layout.
export const TOUR: TourStep[] = [
  {
    target: "targets",
    title: "Find a target",
    text: "Search by name or enter RA, Dec.",
  },
  {
    target: "dome",
    needs: "view",
    round: true,
    title: "View the sky",
    text: "These are SPHEREx infrared images.",
  },
  {
    target: "play",
    needs: "view",
    title: "Press play",
    text: "Each frame is a different pass. Press Space to play or pause.",
  },
  {
    target: "modes",
    needs: "view",
    title: "Compare passes",
    text: "Blink alternates two passes. Difference compares a pass with the reference.",
  },
  {
    target: "details",
    needs: "drawer",
    title: "Measure a pixel",
    text: "Click the image to pick a pixel, then view its spectrum or brightness.",
  },
];
