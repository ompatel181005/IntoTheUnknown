import type { Band, FovArcmin } from "../types";

export interface Preset {
  id: string;
  name: string;
  /** Short catalogue-style name used as a search term. */
  short: string;
  /** Plain-language summary shown in target search results. */
  tagline: string;
  /** Additional terms people may use to find this target. */
  aliases: readonly string[];
  kind: "motion" | "variability";
  ra: number;
  dec: number;
  fov: FovArcmin;
  band: Band;
  /** One plain line on what the object is (README.md target table). */
  what: string;
  /** What to watch for in the flipbook (README.md target table). */
  watch: string;
  /** Catalogue values for the object card, from docs/TARGETS.md. "(lit.)" marks unverified values. */
  facts: { label: string; value: string }[];
}

// Centring positions (propagated to 2026.0) and catalogue values from docs/TARGETS.md. Bands use the plan's
// preset where it is a valid request band; otherwise "auto". Replace with GET /api/targets when it ships.
export const PRESETS: readonly Preset[] = [
  {
    id: "barnard", name: "Barnard's Star", short: "Barnard", kind: "motion", ra: 269.44627, dec: 4.7682, fov: 6, band: "B1-B2",
    tagline: "Fast-moving nearby red dwarf",
    aliases: ["barnard star", "fastest-moving star"],
    what: "Nearby red dwarf with the sky's highest proper motion.",
    watch: "Moves north between passes.",
    facts: [
      { label: "Motion", value: "10.39″/yr · PA 356°" },
      { label: "Parallax", value: "547.0 mas" },
      { label: "Gaia G", value: "8.19" },
    ],
  },
  {
    id: "eps-ind-b", name: "Epsilon Indi B", short: "ε Indi B", kind: "motion", ra: 331.09665, dec: -56.80066, fov: 6, band: "auto",
    tagline: "Nearby brown dwarf pair",
    aliases: ["eps indi b", "eps indi", "epsilon indi", "brown dwarf"],
    what: "A pair of T-type brown dwarfs orbiting ε Indi A.",
    watch: "Moves east-southeast between passes.",
    facts: [
      { label: "Motion", value: "4.71″/yr · PA 122°" },
      { label: "Parallax", value: "274.99 mas" },
      { label: "Gaia G", value: "18.03" },
    ],
  },
  {
    id: "wise-0855", name: "WISE 0855-0714", short: "WISE 0855", kind: "motion", ra: 133.7599, dec: -7.2422, fov: 6, band: "B6",
    tagline: "Coldest known brown dwarf",
    aliases: ["wise 0855", "brown dwarf", "coldest brown dwarf"],
    what: "Cold brown dwarf not detected by Gaia.",
    watch: "Brightest at 4 to 5 µm; moves west between passes.",
    facts: [
      { label: "Motion", value: "≈8.15″/yr · PA 275° (lit.)" },
      { label: "Parallax", value: "≈439 mas (lit.)" },
      { label: "Gaia", value: "No match" },
    ],
  },
  {
    id: "rw-aur", name: "RW Aurigae", short: "RW Aur", kind: "variability", ra: 76.95608, dec: 30.40113, fov: 6, band: "auto",
    tagline: "Young variable star",
    aliases: ["rw aur", "t tauri", "variable star"],
    what: "A young T Tauri star with a dusty disc.",
    watch: "Watch for irregular dimming.",
    facts: [
      { label: "Motion", value: "0.03″/yr (static)" },
      { label: "Parallax", value: "5.4541 mas" },
      { label: "Gaia G", value: "12.18" },
    ],
  },
  {
    id: "r-dra", name: "R Draconis", short: "R Dra", kind: "variability", ra: 248.16723, dec: 66.75502, fov: 6, band: "auto",
    tagline: "Pulsating red giant",
    aliases: ["r dra", "mira", "mira variable", "variable star"],
    what: "A Mira variable with a roughly 246-day period (lit.).",
    watch: "Watch for large brightness changes.",
    facts: [
      { label: "Motion", value: "0.02″/yr (static)" },
      { label: "Parallax", value: "1.25 mas" },
      { label: "Gaia G", value: "6.37" },
    ],
  },
];

export function findPreset(id: string | null | undefined): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** Match free text against preset names, case and punctuation insensitive. */
export function matchPresetName(text: string): Preset | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9ε]/g, "").replace("epsilon", "ε").replace("eps", "ε");
  const q = norm(text);
  if (!q) return undefined;
  return PRESETS.find((p) => [p.name, p.short, p.id, ...p.aliases].some((term) => norm(term) === q));
}

/** Find presets by any familiar name or descriptive alias. */
export function searchPresets(text: string): readonly Preset[] {
  const query = text.trim().toLocaleLowerCase();
  if (!query) return PRESETS;
  return PRESETS.filter((preset) =>
    [preset.name, preset.short, preset.id, ...preset.aliases].some((term) => term.toLocaleLowerCase().includes(query)),
  );
}
