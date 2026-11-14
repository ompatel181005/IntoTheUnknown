// One stroke icon set, drawn inline (no icon dependency). 24px grid, 1.75 stroke.
const PATHS = {
  play: "M8 5.5v13l10.5-6.5z",
  pause: "M8 5v14M16 5v14",
  prev: "M15 6l-6 6 6 6",
  next: "M9 6l6 6-6 6",
  share: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  close: "M6 6l12 12M18 6L6 18",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  sliders: "M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4",
  check: "M5 12.5l4.5 4.5L19 7.5",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01",
  retry: "M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5h.01",
  chevron: "M9 6l6 6-6 6",
  grid: "M3 9h18M3 15h18M9 3c-2 6-2 12 0 18M15 3c2 6 2 12 0 18M3 3h18v18H3z",
  gaia: "M12 4v3M12 17v3M4 12h3M17 12h3M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  flag: "M5 21V4M5 4h11l-2 4 2 4H5",
  invert: "M12 21a9 9 0 1 0 0-18v18zM12 3a9 9 0 0 1 0 18",
  fullscreen: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  collapse: "M11 6l-6 6 6 6M19 6l-6 6 6 6",
  tour: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15.5 8.5l-2 5-5 2 2-5z",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const filled = name === "play";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
