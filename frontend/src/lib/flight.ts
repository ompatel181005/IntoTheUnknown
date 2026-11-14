/**
 * The point the camera is flying toward, in viewport pixels. Shared (outside React) by the orrery, which
 * reports where the chosen star is each frame, the dome, which reports its centre on landing, and the
 * starfield, which radiates its warp streaks from here. NaN means "not set: use the screen centre".
 */
export const flightFocus = { tx: NaN, ty: NaN };

export function setFlightFocus(x: number, y: number) {
  flightFocus.tx = x;
  flightFocus.ty = y;
}
