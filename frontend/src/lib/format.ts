const pad = (n: number, w: number) => String(n).padStart(w, "0");

/** 269.44627 -> "17:57:47.1" */
export function formatRa(deg: number): string {
  const totalSec = (((deg % 360) + 360) % 360) / 15 * 3600;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec - h * 3600) / 60);
  const s = totalSec - h * 3600 - m * 60;
  const sStr = s.toFixed(1).padStart(4, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${sStr}`;
}

/** 4.7682 -> "+04:46:06" */
export function formatDec(deg: number): string {
  const sign = deg < 0 ? "-" : "+";
  const totalSec = Math.round(Math.abs(deg) * 3600);
  const d = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec - d * 3600) / 60);
  const s = totalSec - d * 3600 - m * 60;
  return `${sign}${pad(d, 2)}:${pad(m, 2)}:${pad(s, 2)}`;
}

/** MJD -> "2025-09-14" (UTC). */
export function mjdToDate(mjd: number): string {
  const ms = (mjd - 40587) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function pad2(n: number): string {
  return pad(n, 2);
}

/**
 * Parse "RA, Dec" typed by a person. Accepts decimal degrees ("269.446, 4.768"),
 * colon sexagesimal ("17:57:48.5 +04:41:36") and h/m/s d/m/s ("17h57m48.5s +4d41m36s").
 * Returns null when the text is not a coordinate pair.
 */
export function parseCoords(text: string): { ra: number; dec: number } | null {
  const t = text.trim().replace(/[−–]/g, "-");
  const dec2 = t.match(/^([+-]?\d+(?:\.\d+)?)\s*[,\s]\s*([+-]?\d+(?:\.\d+)?)$/);
  if (dec2) {
    const ra = Number(dec2[1]);
    const dec = Number(dec2[2]);
    return valid(ra, dec);
  }
  const sexa = t
    .replace(/[hdm°'′:]/gi, " ")
    .replace(/[s"″]/gi, " ")
    .replace(/,/g, " ")
    .trim()
    .split(/\s+/);
  if (sexa.length === 6 && sexa.every((p) => /^[+-]?\d+(\.\d+)?$/.test(p))) {
    const [rh, rm, rs, dd, dm, ds] = sexa.map(Number);
    const neg = sexa[3].startsWith("-");
    const ra = (rh + rm / 60 + rs / 3600) * 15;
    const dec = (Math.abs(dd) + dm / 60 + ds / 3600) * (neg ? -1 : 1);
    return valid(ra, dec);
  }
  return null;
}

function valid(ra: number, dec: number) {
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) return null;
  if (ra < 0 || ra >= 360 || dec < -90 || dec > 90) return null;
  return { ra, dec };
}

/**
 * Distance in light-years from annual trigonometric parallax in milliarcseconds (mas).
 * distance_ly = 3261.56 / parallax_mas
 * Examples: 1.25 mas -> "~2,600 ly", 547.0 mas -> "5.96 ly"
 */
export function formatParallaxDistance(masVal: number | string | null | undefined): string | null {
  if (masVal == null) return null;
  let mas: number;
  if (typeof masVal === "number") {
    mas = masVal;
  } else {
    const match = masVal.match(/(\d+(?:\.\d+)?)/);
    if (!match) return null;
    mas = Number(match[1]);
  }
  if (!Number.isFinite(mas) || mas <= 0) return null;
  const distLy = 3261.56 / mas;
  if (distLy >= 2000) {
    const rounded = Math.round(distLy / 100) * 100;
    return `~${rounded.toLocaleString()} ly`;
  }
  if (distLy >= 1000) {
    const rounded = Math.round(distLy / 50) * 50;
    return `~${rounded.toLocaleString()} ly`;
  }
  if (distLy >= 100) {
    return `~${Math.round(distLy)} ly`;
  }
  if (distLy >= 10) {
    return `${distLy.toFixed(1)} ly`;
  }
  return `${distLy.toFixed(2)} ly`;
}

/**
 * Proper motion plain-meaning analogy: time to cross the full Moon's angular width (~31 arcminutes),
 * or "barely moves" when under 0.1"/yr.
 * Examples: 10.39"/yr -> "Moon width in ~180 yrs", 0.02"/yr -> "barely moves"
 */
export function formatProperMotionMoon(pmVal: number | string | null | undefined): string | null {
  if (pmVal == null) return null;
  let rate: number;
  if (typeof pmVal === "number") {
    rate = pmVal;
  } else {
    if (pmVal.toLowerCase().includes("static") || pmVal.toLowerCase().includes("no match")) {
      return "barely moves";
    }
    const match = pmVal.match(/(\d+(?:\.\d+)?)/);
    if (!match) return null;
    rate = Number(match[1]);
  }
  if (!Number.isFinite(rate)) return null;
  if (rate < 0.1) return "barely moves";
  // Full Moon angular width is about 31 arcminutes = 1860 arcseconds
  const years = 1860 / rate;
  if (years >= 100) {
    const rounded = Math.round(years / 10) * 10;
    return `Moon width in ~${rounded.toLocaleString()} yrs`;
  }
  return `Moon width in ~${Math.round(years)} yrs`;
}

/**
 * Field of view as a fraction of the full Moon's width (~30-31 arcminutes).
 * Examples: 6' -> "about 1/5 of the Moon's width"
 */
export function formatFovMoonFraction(fovArcmin: number): string {
  if (fovArcmin === 2) return "~1/15 of the Moon's width";
  if (fovArcmin === 4) return "~1/8 of the Moon's width";
  if (fovArcmin === 6) return "about 1/5 of the Moon's width";
  if (fovArcmin === 10) return "~1/3 of the Moon's width";
  if (fovArcmin === 15) return "~1/2 of the Moon's width";
  const frac = 30 / fovArcmin;
  return `~1/${Math.round(frac)} of the Moon's width`;
}

