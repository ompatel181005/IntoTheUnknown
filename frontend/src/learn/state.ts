export const missionIds = ["motion", "wavelength", "uncertainty"] as const;
export type MissionId = (typeof missionIds)[number];
export type Locale = "en" | "es" | "hi";
export interface LearnState { lang: Locale; mission: MissionId; epoch: number; selection: [number, number] | null }

export function parseLearnState(search: string): LearnState {
  const p = new URLSearchParams(search);
  const lang = p.get("lang");
  const mission = p.get("mission");
  const epoch = Number(p.get("epoch"));
  const rawSelection = p.get("sel");
  const selection = rawSelection && /^\d+,\d+$/.test(rawSelection) ? rawSelection.split(",").map(Number) : null;
  return {
    lang: lang === "es" || lang === "hi" ? lang : "en",
    mission: missionIds.includes(mission as MissionId) ? mission as MissionId : "motion",
    epoch: Number.isInteger(epoch) && epoch >= 1 && epoch <= 100 ? epoch - 1 : 0,
    selection: selection?.length === 2 && selection.every(n => Number.isInteger(n) && n >= 0 && n < 4096)
      ? selection as [number, number] : null,
  };
}

export function learnSearch(state: LearnState): string {
  const p = new URLSearchParams({ lang: state.lang, mission: state.mission, epoch: String(state.epoch + 1) });
  if (state.selection) p.set("sel", state.selection.join(","));
  return `?${p}`;
}

/** Canvas is north up; scientific image rows start at the south edge. */
export function imagePixel(u: number, v: number, nx: number, ny: number): [number, number] {
  return [Math.max(0, Math.min(nx - 1, Math.floor(u * nx))), Math.max(0, Math.min(ny - 1, ny - 1 - Math.floor(v * ny)))];
}

export function validSelection(selection: [number, number] | null, nx: number, ny: number) {
  return selection && selection[0] < nx && selection[1] < ny ? selection : null;
}
