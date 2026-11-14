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
    title: "Pick something to look at",
    text: "Five objects from the NASA challenge: a fast star, a cold brown dwarf, stars that change brightness. On the home screen they also hang on the sky sphere around a live view of the solar system. You can search a name or type RA, Dec too.",
  },
  {
    target: "dome",
    needs: "view",
    round: true,
    title: "This is your sky dome",
    text: "SPHEREx's real infrared images of that spot, as if you were looking straight up at it. North is at the top and east is on the left. The grid around the dome shows the real sky coordinates.",
  },
  {
    target: "play",
    needs: "view",
    title: "Press play",
    text: "Each frame is a different SPHEREx pass, months apart. Watch for the dot that moves while the background stars stay still. Space plays and pauses; the arrow keys step.",
  },
  {
    target: "time",
    needs: "view",
    title: "Time runs along the arc",
    text: "Every pass sits on the arc with its date. The crescent marks the pass you are looking at. Click any date to jump to it.",
  },
  {
    target: "modes",
    needs: "view",
    title: "Ways to look",
    text: "Play all shows every pass. Blink flips between two passes. Difference hides everything that stayed the same: a moving star leaves silver where it was and amber where it is now. Investigate opens the measurements.",
  },
  {
    target: "customize",
    fallback: "customize-btn",
    needs: "customize",
    title: "Make it yours",
    text: "Field of view, speed, colour band and brightness. More options holds the stretch and which pass to compare against. Everything you change is saved in the share link.",
  },
  {
    target: "tools",
    needs: "view",
    title: "Overlays and tools",
    text: "Show the RA, Dec grid on the image, flagged pixels, or an inverted view. The globe returns to the whole-sky map.",
  },
  {
    target: "details",
    needs: "drawer",
    title: "Measure it",
    text: "Click any star in the dome (or use the arrow keys and Enter), then read its spectrum and its brightness over time. Files lists every SPHEREx image used, and Sky shows where this patch sits on the whole sky.",
  },
  {
    target: "help",
    title: "Share and learn more",
    text: "Share copies a link to exactly this view. The guide explains the science behind each target. You can replay this tour any time.",
  },
];
