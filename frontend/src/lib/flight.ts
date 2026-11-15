export interface OrreryCameraState {
  yaw: number;
  pitch: number;
  dist: number;
  fade: number;
}

export interface FlightPose {
  x: number;
  y: number;
  side: number;
}

export interface FlightSample {
  now: number;
  targetId: string | null;
  progress: number;
  /** Forward progress, also used in reverse so every layer retraces the same curve. */
  u: number;
  direction: 1 | -1;
  pose: FlightPose;
  camera: OrreryCameraState;
  reduced: boolean;
}

export const FLIGHT_MS = 1300;
export const initialCamera: OrreryCameraState = { yaw: -1.08, pitch: 1.15, dist: 38, fade: 1 };
export const flightFocus = { tx: NaN, ty: NaN };
export function setFlightFocus(x: number, y: number) {
  flightFocus.tx = x;
  flightFocus.ty = y;
}

let homeCamera = { ...initialCamera };
interface Route {
  targetId: string | null;
  home: OrreryCameraState;
  near: OrreryCameraState;
  marker: FlightPose;
  dome: FlightPose;
}
let route: Route | null = null;
let active: { start: number; direction: 1 | -1; reduced: boolean; resolve: () => void } | null = null;
let sample: FlightSample | null = null;
let frame = 0;
const listeners = new Set<(sample: FlightSample) => void>();
const smooth = (t: number) => t * t * (3 - 2 * t);
const mix = (a: number, b: number, u: number) => a + (b - a) * u;
export const mixLog = (a: number, b: number, u: number) => Math.exp(mix(Math.log(a), Math.log(b), u));

export function getHomeCamera() { return { ...homeCamera }; }
export function saveHomeCamera(camera: OrreryCameraState) {
  if (!active) homeCamera = { ...camera, fade: 1 };
}
export function getFlightSample() { return sample; }
export function getFlightStartPose() { return route ? { ...(active?.direction === -1 ? route.dome : route.marker) } : null; }
export function flightIsActive() { return active !== null; }
export function subscribeFlight(listener: (sample: FlightSample) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function tick(now: number) {
  frame = 0;
  if (!active || !route) return;
  if (active.start < 0) {
    active.start = now;
    markFlight(active.direction === 1 ? "forward-start" : "return-start");
  }
  const progress = Math.min(1, (now - active.start) / (active.reduced ? 150 : FLIGHT_MS));
  const u = active.reduced ? (active.direction === 1 ? 1 : 0) : smooth(active.direction === 1 ? progress : 1 - progress);
  const pose = {
    x: mix(route.marker.x, route.dome.x, u),
    y: mix(route.marker.y, route.dome.y, u),
    side: mixLog(route.marker.side, route.dome.side, u),
  };
  const camera = active.reduced ? { ...route.home, fade: active.direction === 1 ? 1 - progress : progress } : {
    yaw: mix(route.home.yaw, route.near.yaw, u),
    pitch: mix(route.home.pitch, route.near.pitch, u),
    dist: mixLog(route.home.dist, route.near.dist, u),
    fade: 1 - smooth(Math.min(1, Math.max(0, (u - 0.15) / 0.7))),
  };
  const previous = sample?.progress ?? 0;
  sample = { now, targetId: route.targetId, progress, u, pose, camera, direction: active.direction, reduced: active.reduced };
  setFlightFocus(pose.x, pose.y);
  // Diagnostic boundaries do not start new animations or reset velocity.
  if (previous < 0.25 && progress >= 0.25) markFlight("blend-start");
  if (previous < 0.75 && progress >= 0.75) markFlight("blend-end");
  listeners.forEach((listener) => listener(sample!));
  if (progress < 1) frame = requestAnimationFrame(tick);
  else {
    const finished = active;
    active = null;
    markFlight(finished.direction === 1 ? "dome-land" : "home-land");
    window.dispatchEvent(new Event("spherex:dome-landed"));
    finished.resolve();
  }
}

function begin(direction: 1 | -1) {
  cancelAnimationFrame(frame);
  active?.resolve();
  sample = null;
  return new Promise<void>((resolve) => {
    active = { start: -1, direction, resolve, reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches };
    frame = requestAnimationFrame(tick);
  });
}

export function startTargetFlight(targetId: string, before: OrreryCameraState, facing: { yaw: number; pitch: number }, marker: FlightPose) {
  homeCamera = { ...before, fade: 1 };
  route = { targetId, home: { ...homeCamera }, near: { ...before, ...facing, fade: 0 }, marker, dome: { ...marker } };
  return begin(1);
}

/** Set once before the first animation frame; update the landed endpoint after a layout change. */
export function setDomeDestination(dome: FlightPose) {
  if (!route || (active && active.start >= 0)) return;
  route.dome = dome;
  // The camera's log-distance rate exactly matches the dome's log-scale rate.
  route.near.dist = route.home.dist * route.marker.side / dome.side;
}

let homeNavigation: { pick: (id: string) => boolean; locate: (id: string | null) => FlightPose | null } | null = null;
export function registerHomeNavigation(navigation: NonNullable<typeof homeNavigation>) {
  homeNavigation = navigation;
  return () => { if (homeNavigation === navigation) homeNavigation = null; };
}
export function requestTargetFlight(id: string) { return homeNavigation?.pick(id) ?? false; }

/** The home renderer is already present at the forward route's near camera. */
export function prepareReturnFlight(target: { id: string | null; ra: number; dec: number }, dome: FlightPose | null) {
  if (!route || route.targetId !== target.id) {
    const marker = homeNavigation?.locate(target.id) ?? { x: window.innerWidth / 2, y: window.innerHeight / 2, side: 20 };
    const a = target.ra * Math.PI / 180, d = target.dec * Math.PI / 180, eps = 23.4393 * Math.PI / 180;
    const x = Math.cos(d) * Math.cos(a), y = Math.cos(d) * Math.sin(a) * Math.cos(eps) + Math.sin(d) * Math.sin(eps);
    const z = -Math.cos(d) * Math.sin(a) * Math.sin(eps) + Math.sin(d) * Math.cos(eps);
    let yaw = Math.atan2(x, y);
    while (yaw - homeCamera.yaw > Math.PI) yaw -= 2 * Math.PI;
    while (homeCamera.yaw - yaw > Math.PI) yaw += 2 * Math.PI;
    route = { targetId: target.id, home: { ...homeCamera }, near: { ...homeCamera, yaw, pitch: Math.atan2(-z, Math.hypot(x, y)), fade: 0 }, marker, dome: dome ?? marker };
  }
  if (dome) setDomeDestination(dome);
  return begin(-1);
}

/** Bounded marks for browser measurements, retaining the latest occurrence of each phase. */
export function markFlight(phase: string) {
  const name = `flight:${phase}`;
  performance.clearMarks(name);
  performance.mark(name);
}
