export interface TourStep {
  /** Matches a data-tour attribute on the element to spotlight. */
  target: string;
  /** Used when `target` is not on screen (e.g. the phone layout). */
  fallback?: string | string[];
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
    target: "home-target-search",
    fallback: ["view-target-search", "home-targets-tab"],
    title: "Find a target",
    text: "Search by name or coordinates to choose a sky target. On the home view, you can also browse the Targets panel.",
  },
  {
    target: "target-sort",
    fallback: "home-targets-tab",
    title: "Sort the targets",
    text: "Sort prepared targets by frames, passes, or name. The counts describe how much data is available.",
  },
  {
    target: "dome",
    needs: "view",
    round: true,
    spotlightCenter: true,
    title: "View the sky",
    text: "The dome shows SPHEREx infrared passes for the selected patch. North is up and east is left.",
  },
  {
    target: "play",
    needs: "view",
    title: "Press play",
    text: "Play steps through the available survey passes. Look for motion or brightness changes.",
  },
  {
    target: "modes",
    needs: "view",
    title: "Compare passes",
    text: "Blink alternates between two passes. Difference subtracts a reference pass to reveal what changed.",
  },
  {
    target: "details",
    fallback: "details-btn",
    needs: "drawer",
    title: "Open details",
    text: "Use Details to compare colour, brightness, files, and sky information. Pick a pixel to measure that position.",
  },
];
