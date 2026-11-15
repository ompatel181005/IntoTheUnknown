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

export interface OrreryCameraState {
  yaw: number;
  pitch: number;
  dist: number;
  fade: number;
}

interface DepartureState {
  targetId: string;
  before: OrreryCameraState;
  commit: OrreryCameraState;
}

export interface ReturnFlightState {
  targetId: string | null;
  from: OrreryCameraState;
  to: OrreryCameraState;
}

export const initialCamera: OrreryCameraState = {
  yaw: -1.08,
  pitch: 1.15,
  dist: 38,
  fade: 1,
};
let homeCamera = { ...initialCamera };
let departure: DepartureState | null = null;
let returnFlight: ReturnFlightState | null = null;

function cloneCamera(camera: OrreryCameraState): OrreryCameraState {
  return { ...camera };
}

export function getHomeCamera(): OrreryCameraState {
  return cloneCamera(homeCamera);
}

/** Keep the slowly rotating or dragged home view across target mounts. */
export function saveHomeCamera(camera: OrreryCameraState) {
  homeCamera = { ...cloneCamera(camera), fade: 1 };
}

export function startTargetFlight(targetId: string, before: OrreryCameraState) {
  homeCamera = { ...cloneCamera(before), fade: 1 };
  departure = { targetId, before: { ...cloneCamera(before), fade: 1 }, commit: cloneCamera(before) };
}

export function saveTargetCommit(targetId: string, camera: OrreryCameraState) {
  if (departure?.targetId === targetId) departure.commit = cloneCamera(camera);
}

function cameraFacing(ra: number, dec: number, near: boolean): OrreryCameraState {
  const d2r = Math.PI / 180;
  const a = ra * d2r;
  const d = dec * d2r;
  const eps = 23.4393 * d2r;
  const x = Math.cos(d) * Math.cos(a);
  const yEq = Math.cos(d) * Math.sin(a);
  const zEq = Math.sin(d);
  const y = yEq * Math.cos(eps) + zEq * Math.sin(eps);
  const z = -yEq * Math.sin(eps) + zEq * Math.cos(eps);
  let yaw = Math.atan2(x, y);
  while (yaw - homeCamera.yaw > Math.PI) yaw -= 2 * Math.PI;
  while (homeCamera.yaw - yaw > Math.PI) yaw += 2 * Math.PI;
  return {
    yaw,
    pitch: Math.atan2(-z, Math.hypot(x, y)),
    dist: near ? 2.5 : homeCamera.dist,
    fade: near ? 0.15 : 1,
  };
}

/** Queue the camera state the home orrery will use when it remounts. */
export function prepareReturnFlight(target: { id: string | null; ra: number; dec: number } | null) {
  const matching = target?.id && departure?.targetId === target.id ? departure : null;
  returnFlight = {
    targetId: target?.id ?? null,
    from: matching ? cloneCamera(matching.commit) : target ? cameraFacing(target.ra, target.dec, true) : { ...cloneCamera(homeCamera), dist: 2.5, fade: 0.15 },
    to: matching ? { ...cloneCamera(matching.before), fade: 1 } : { ...cloneCamera(homeCamera), fade: 1 },
  };
}

export function getReturnFlight(): ReturnFlightState | null {
  return returnFlight ? { ...returnFlight, from: cloneCamera(returnFlight.from), to: cloneCamera(returnFlight.to) } : null;
}

export function finishReturnFlight(camera: OrreryCameraState) {
  homeCamera = { ...cloneCamera(camera), fade: 1 };
  returnFlight = null;
  departure = null;
}

interface DomeFlightController {
  centre: () => { x: number; y: number };
  shrink: () => Promise<void>;
}

let domeController: DomeFlightController | null = null;

export function registerDomeFlight(controller: DomeFlightController) {
  domeController = controller;
  return () => {
    if (domeController === controller) domeController = null;
  };
}

/** Collapse the live dome before swapping it for the reverse-flying orrery. */
export async function shrinkDomeForHome() {
  const controller = domeController;
  if (!controller) return;
  const centre = controller.centre();
  setFlightFocus(centre.x, centre.y);
  await controller.shrink();
}

/** Bounded phase marks for browser traces, retaining only the latest occurrence of each phase. */
export function markFlight(phase: string) {
  const name = `flight:${phase}`;
  performance.clearMarks(name);
  performance.mark(name);
}
