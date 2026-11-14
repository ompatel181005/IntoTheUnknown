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
