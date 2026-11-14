import { useEffect, useRef, useState } from "react";
import { toEcliptic } from "../../lib/catalog";
import {
  finishReturnFlight,
  getHomeCamera,
  getReturnFlight,
  initialCamera,
  saveHomeCamera,
  saveTargetCommit,
  setFlightFocus,
  startTargetFlight,
  type OrreryCameraState,
} from "../../lib/flight";
import {
  AU_PER_PARSEC,
  centuries,
  mapRadial,
  PLANETS,
  position,
  radialScale,
  raDecToEcliptic,
  skyStars,
  type Vec3,
} from "../../lib/orbits";
import { galacticToEq } from "../../lib/sky";
import { tokenRgb } from "../../lib/stretch";
import type { CatalogObject } from "../../types";
import s from "./Orrery.module.css";

interface OrreryProps {
  targets: readonly CatalogObject[];
  onFlightStart?: (target: CatalogObject) => void;
  onPick: (target: CatalogObject, from: { x: number; y: number } | null) => void;
  onFlightEnd?: () => void;
}

interface Projection {
  x: number;
  y: number;
  depth: number;
  front: boolean;
}

interface LabelCandidate {
  type: "planet" | "target";
  index: number;
  priority: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  visible: boolean;
}

const FLY_MS = 700;
const COMMIT_AT = 0.78;
const FOV_RADIANS = Math.PI / 3;
const MIN_DIST = 2.5;
const MAX_DIST = 120;
const MAX_FOCUS = 20;
const DEFAULT_DIST = 28;
const cinematic = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const rgba = (color: [number, number, number], alpha: number) =>
  `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;

function cloneCamera(camera: OrreryCameraState): OrreryCameraState {
  return { ...camera, focus: [...camera.focus] };
}

function boundedFocus(focus: Vec3): Vec3 {
  const radius = Math.hypot(focus[0], focus[1], focus[2]);
  if (radius <= MAX_FOCUS) return focus;
  const factor = MAX_FOCUS / radius;
  return [focus[0] * factor, focus[1] * factor, focus[2] * factor];
}

function buildScene(targets: readonly CatalogObject[]) {
  const T = centuries(new Date());
  const targetPoints = targets.map((object) => {
    const astrometry = toEcliptic(object);
    const radius = astrometry.distancePc === null
      ? radialScale(30)
      : radialScale(astrometry.distancePc * AU_PER_PARSEC);
    return {
      object,
      pos: astrometry.direction.map((component) => component * radius) as Vec3,
      direction: astrometry.direction as Vec3,
    };
  });
  const key = targets
    .map((target) => [target.id, target.ra_deg, target.dec_deg, target.parallax_mas, target.distance_pc].join(":"))
    .join("|");
  return {
    key,
    orbits: PLANETS.map((planet) =>
      Array.from({ length: 129 }, (_, index) => mapRadial(position(planet, T, (index / 128) * Math.PI * 2))),
    ),
    planets: PLANETS.map((planet) => ({ name: planet.name, pos: mapRadial(position(planet, T)) })),
    ecliptic: Array.from({ length: 97 }, (_, index): Vec3 => {
      const angle = (index / 96) * Math.PI * 2;
      return [Math.cos(angle), Math.sin(angle), 0];
    }),
    galaxy: Array.from({ length: 361 }, (_, longitude) => {
      const point = galacticToEq(longitude, 0);
      return {
        p: raDecToEcliptic(point.ra, point.dec),
        w: 0.35 + 0.65 * Math.max(0, Math.cos(longitude * Math.PI / 180)) ** 2,
      };
    }),
    targets: targetPoints,
    backgroundStars: skyStars(4000, 1),
  };
}

let sceneCache: ReturnType<typeof buildScene> | null = null;

function getScene(targets: readonly CatalogObject[]) {
  const key = targets
    .map((target) => [target.id, target.ra_deg, target.dec_deg, target.parallax_mas, target.distance_pc].join(":"))
    .join("|");
  if (!sceneCache || sceneCache.key !== key) sceneCache = buildScene(targets);
  return sceneCache;
}

/** Interactive heliocentric view with a rotation-only celestial background. */
export function Orrery({ targets, onPick, onFlightStart, onFlightEnd }: OrreryProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const markerRefs = useRef<(HTMLElement | null)[]>([]);
  const clockRef = useRef<HTMLSpanElement>(null);
  const clickTimerRef = useRef<number | null>(null);
  const [returnFlight] = useState(getReturnFlight);
  const cam = useRef<OrreryCameraState>(cloneCamera(returnFlight?.from ?? getHomeCamera()));
  const fly = useRef<
    | { mode: "forward"; start: number; from: OrreryCameraState; to: { yaw: number; pitch: number }; target: CatalogObject; index: number }
    | { mode: "return"; start: number; from: OrreryCameraState; to: OrreryCameraState; targetId: string | null; index: number }
    | null
  >(null);
  const onPickRef = useRef(onPick);
  const onFlightStartRef = useRef(onFlightStart);
  const onFlightEndRef = useRef(onFlightEnd);
  const holdRef = useRef(false);

  useEffect(() => {
    onPickRef.current = onPick;
    onFlightStartRef.current = onFlightStart;
    onFlightEndRef.current = onFlightEnd;
  }, [onPick, onFlightStart, onFlightEnd]);

  useEffect(() => {
    const anchor = anchorRef.current;
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!anchor || !wrap || !canvas || !context) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const star = tokenRgb("--star");
    const sun = tokenRgb("--sun");
    const accent = tokenRgb("--accent");
    const text2 = tokenRgb("--text-2");
    const planetColor = PLANETS.map((planet) => tokenRgb(`--planet-${planet.name.toLowerCase()}`));
    const dprCap = (navigator.hardwareConcurrency || 8) <= 4 ? 1.25 : 1.5;
    const scene = getScene(targets);
    const planetProjection = scene.planets.map((): Projection => ({ x: 0, y: 0, depth: 0, front: false }));
    const planetLabelX = scene.planets.map(() => 0);
    const planetLabelY = scene.planets.map(() => 0);
    const planetLabelAlign = scene.planets.map((): CanvasTextAlign => "left");
    const targetProjection = scene.targets.map((): Projection => ({ x: 0, y: 0, depth: 0, front: false }));
    const planetLabelOpacity = scene.planets.map(() => 0);
    const candidates: LabelCandidate[] = [];
    const accepted: LabelCandidate[] = [];
    const textWidths = new Map<string, number>();
    let targetDist = cam.current.dist;
    let targetFocus: Vec3 = [...cam.current.focus];
    let viewGlide: { start: number; from: OrreryCameraState; to: OrreryCameraState } | null = null;

    if (returnFlight) {
      if (reduce) {
        cam.current = cloneCamera(returnFlight.to);
        targetDist = cam.current.dist;
        targetFocus = [...cam.current.focus];
        finishReturnFlight(cam.current);
        queueMicrotask(() => onFlightEndRef.current?.());
      } else {
        fly.current = {
          mode: "return",
          start: -1,
          from: cloneCamera(returnFlight.from),
          to: cloneCamera(returnFlight.to),
          targetId: returnFlight.targetId,
          index: returnFlight.targetId
            ? scene.targets.findIndex((target) => target.object.preset_id === returnFlight.targetId)
            : -1,
        };
      }
    }

    let width = 0;
    let height = 0;
    let focalLength = 1;
    let dirty = true;
    let sceneBox = { left: 0, top: 0, width: 0, height: 0 };
    let scheduleFrame = () => undefined;
    const resize = () => {
      const wrapBox = wrap.getBoundingClientRect();
      const anchorBox = anchor.getBoundingClientRect();
      const dpr = Math.min(dprCap, window.devicePixelRatio || 1);
      width = wrapBox.width;
      height = wrapBox.height;
      sceneBox = {
        left: anchorBox.left - wrapBox.left,
        top: anchorBox.top - wrapBox.top,
        width: anchorBox.width,
        height: anchorBox.height,
      };
      focalLength = sceneBox.height / (2 * Math.tan(FOV_RADIANS / 2));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      dirty = true;
      scheduleFrame();
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(wrap);
    resizeObserver.observe(anchor);

    const rotate = (vector: Vec3, camera: OrreryCameraState, relative = true) => {
      const x = relative ? vector[0] - camera.focus[0] : vector[0];
      const y = relative ? vector[1] - camera.focus[1] : vector[1];
      const z = relative ? vector[2] - camera.focus[2] : vector[2];
      const cy = Math.cos(camera.yaw);
      const sy = Math.sin(camera.yaw);
      const cp = Math.cos(camera.pitch);
      const sp = Math.sin(camera.pitch);
      const x1 = x * cy - y * sy;
      const y1 = x * sy + y * cy;
      return { x: x1, y: y1 * cp - z * sp, z: y1 * sp + z * cp };
    };

    const projectScene = (vector: Vec3, camera: OrreryCameraState, output?: Projection): Projection => {
      const rotated = rotate(vector, camera);
      const depth = rotated.y + camera.dist;
      const result = output ?? { x: 0, y: 0, depth: 0, front: false };
      result.x = sceneBox.left + sceneBox.width / 2 + focalLength * rotated.x / depth;
      result.y = sceneBox.top + sceneBox.height / 2 - focalLength * rotated.z / depth;
      result.depth = depth;
      result.front = rotated.y < 0;
      return result;
    };

    const projectSky = (vector: Vec3, camera: OrreryCameraState) => {
      const rotated = rotate(vector, camera, false);
      return {
        x: sceneBox.left + sceneBox.width / 2 + focalLength * rotated.x / rotated.y,
        y: sceneBox.top + sceneBox.height / 2 - focalLength * rotated.z / rotated.y,
        depth: rotated.y,
      };
    };

    const drawSceneLine = (points: Vec3[], camera: OrreryCameraState, color: [number, number, number], alpha: number, lineWidth = 1) => {
      const frontPath = new Path2D();
      const backPath = new Path2D();
      let previous: Projection | null = null;
      for (const point of points) {
        const projected = projectScene(point, camera);
        if (projected.depth < 0.05) {
          previous = null;
          continue;
        }
        if (previous) {
          const path = previous.front ? frontPath : backPath;
          path.moveTo(previous.x, previous.y);
          path.lineTo(projected.x, projected.y);
        }
        previous = projected;
      }
      context.lineWidth = lineWidth;
      context.strokeStyle = rgba(color, alpha * 0.35);
      context.stroke(backPath);
      context.strokeStyle = rgba(color, alpha);
      context.stroke(frontPath);
    };

    const drawSkyLine = (points: Vec3[], camera: OrreryCameraState, color: [number, number, number], alpha: number) => {
      const path = new Path2D();
      let previous: ReturnType<typeof projectSky> | null = null;
      for (const point of points) {
        const projected = projectSky(point, camera);
        if (projected.depth <= 0.04) {
          previous = null;
          continue;
        }
        if (previous && Math.hypot(projected.x - previous.x, projected.y - previous.y) < Math.max(width, height) * 0.4) {
          path.moveTo(previous.x, previous.y);
          path.lineTo(projected.x, projected.y);
        }
        previous = projected;
      }
      context.setLineDash([4, 7]);
      context.lineWidth = 1;
      context.strokeStyle = rgba(color, alpha);
      context.stroke(path);
      context.setLineDash([]);
    };

    const basis = (camera: OrreryCameraState) => {
      const cy = Math.cos(camera.yaw);
      const sy = Math.sin(camera.yaw);
      const sp = Math.sin(camera.pitch);
      const cp = Math.cos(camera.pitch);
      return {
        right: [cy, -sy, 0] as Vec3,
        up: [sy * sp, cy * sp, cp] as Vec3,
      };
    };

    const shiftFocusForZoom = (newDistance: number, clientX: number, clientY: number) => {
      const oldDistance = targetDist;
      if (oldDistance === newDistance) return;
      const ratio = newDistance / oldDistance;
      const centerX = sceneBox.left + sceneBox.width / 2;
      const centerY = sceneBox.top + sceneBox.height / 2;
      const xCamera = (clientX - centerX) * oldDistance / focalLength;
      const zCamera = -(clientY - centerY) * oldDistance / focalLength;
      const axes = basis(cam.current);
      const amount = 1 - ratio;
      targetFocus = boundedFocus([
        targetFocus[0] + (axes.right[0] * xCamera + axes.up[0] * zCamera) * amount,
        targetFocus[1] + (axes.right[1] * xCamera + axes.up[1] * zCamera) * amount,
        targetFocus[2] + (axes.right[2] * xCamera + axes.up[2] * zCamera) * amount,
      ]);
      targetDist = newDistance;
      if (reduce) {
        cam.current.dist = targetDist;
        cam.current.focus = [...targetFocus];
        saveHomeCamera(cam.current);
      }
      dirty = true;
      scheduleFrame();
    };

    const zoomBy = (factor: number, clientX = sceneBox.left + sceneBox.width / 2, clientY = sceneBox.top + sceneBox.height / 2) => {
      if (fly.current) return;
      const limitedFactor = Math.min(1.2, Math.max(0.8, factor));
      let next = targetDist * limitedFactor;
      if (next < MIN_DIST) next = MIN_DIST + (targetDist - MIN_DIST) * 0.08;
      if (next > MAX_DIST) next = MAX_DIST - (MAX_DIST - targetDist) * 0.08;
      next = Math.min(MAX_DIST, Math.max(MIN_DIST, next));
      shiftFocusForZoom(next, clientX, clientY);
    };

    const panBy = (dx: number, dy: number) => {
      const axes = basis(cam.current);
      const units = targetDist / focalLength;
      targetFocus = boundedFocus([
        targetFocus[0] - axes.right[0] * dx * units + axes.up[0] * dy * units,
        targetFocus[1] - axes.right[1] * dx * units + axes.up[1] * dy * units,
        targetFocus[2] - axes.right[2] * dx * units + axes.up[2] * dy * units,
      ]);
      if (reduce) cam.current.focus = [...targetFocus];
      dirty = true;
      scheduleFrame();
    };

    const glideTo = (to: OrreryCameraState) => {
      if (reduce) {
        cam.current = cloneCamera(to);
        targetDist = to.dist;
        targetFocus = [...to.focus];
        saveHomeCamera(cam.current);
      } else {
        viewGlide = { start: -1, from: cloneCamera(cam.current), to: cloneCamera(to) };
      }
      dirty = true;
      scheduleFrame();
    };

    const glideFocus = (focus: Vec3) => {
      glideTo({ ...cloneCamera(cam.current), focus: boundedFocus([...focus]) });
    };

    let animationFrame = 0;
    let dragging = false;
    let lastTime = performance.now();
    const frame = (now: number) => {
      animationFrame = 0;
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;
      const camera = cam.current;
      const activeFlight = fly.current;

      if (activeFlight) {
        if (activeFlight.start < 0) activeFlight.start = now;
        const t = Math.min(1, (now - activeFlight.start) / FLY_MS);
        const eased = cinematic(t);
        if (activeFlight.mode === "forward") {
          const turn = cinematic(Math.min(1, t / 0.7));
          camera.yaw = activeFlight.from.yaw + (activeFlight.to.yaw - activeFlight.from.yaw) * turn;
          camera.pitch = activeFlight.from.pitch + (activeFlight.to.pitch - activeFlight.from.pitch) * turn;
          camera.dist = activeFlight.from.dist + (MIN_DIST - activeFlight.from.dist) * eased ** 1.6;
          camera.fade = 1 - eased * 0.85;
          const projected = projectScene(scene.targets[activeFlight.index].pos, camera);
          setFlightFocus(projected.x, projected.y);
          saveTargetCommit(activeFlight.target.preset_id ?? activeFlight.target.id, camera);
          if (t >= COMMIT_AT) {
            fly.current = null;
            onPickRef.current(activeFlight.target, { x: projected.x, y: projected.y });
            return;
          }
        } else {
          camera.yaw = activeFlight.from.yaw + (activeFlight.to.yaw - activeFlight.from.yaw) * eased;
          camera.pitch = activeFlight.from.pitch + (activeFlight.to.pitch - activeFlight.from.pitch) * eased;
          camera.dist = activeFlight.from.dist + (activeFlight.to.dist - activeFlight.from.dist) * eased;
          camera.fade = activeFlight.from.fade + (activeFlight.to.fade - activeFlight.from.fade) * eased;
          camera.focus = activeFlight.from.focus.map((value, index) =>
            value + (activeFlight.to.focus[index] - value) * eased,
          ) as Vec3;
          if (activeFlight.index >= 0) {
            const projected = projectScene(scene.targets[activeFlight.index].pos, camera);
            setFlightFocus(projected.x, projected.y);
          }
          if (t >= 1) {
            fly.current = null;
            targetDist = camera.dist;
            targetFocus = [...camera.focus];
            finishReturnFlight(camera);
            onFlightEndRef.current?.();
          }
        }
        dirty = true;
      } else if (viewGlide) {
        if (viewGlide.start < 0) viewGlide.start = now;
        const activeGlide = viewGlide;
        const t = Math.min(1, (now - activeGlide.start) / 420);
        const eased = cinematic(t);
        camera.yaw = activeGlide.from.yaw + (activeGlide.to.yaw - activeGlide.from.yaw) * eased;
        camera.pitch = activeGlide.from.pitch + (activeGlide.to.pitch - activeGlide.from.pitch) * eased;
        camera.dist = activeGlide.from.dist + (activeGlide.to.dist - activeGlide.from.dist) * eased;
        camera.focus = activeGlide.from.focus.map((value, index) => value + (activeGlide.to.focus[index] - value) * eased) as Vec3;
        targetDist = camera.dist;
        targetFocus = [...camera.focus];
        if (t >= 1) viewGlide = null;
        dirty = true;
      } else {
        const damping = reduce ? 1 : 1 - Math.exp(-dt / 0.14);
        const distanceDelta = targetDist - camera.dist;
        const focusDelta = targetFocus.map((value, index) => value - camera.focus[index]) as Vec3;
        if (Math.abs(distanceDelta) > 0.001 || Math.hypot(focusDelta[0], focusDelta[1], focusDelta[2]) > 0.001) {
          camera.dist += distanceDelta * damping;
          camera.focus = camera.focus.map((value, index) => value + focusDelta[index] * damping) as Vec3;
          dirty = true;
        } else {
          camera.dist = targetDist;
          camera.focus = [...targetFocus];
        }
        if (!reduce && !dragging && !holdRef.current) {
          camera.yaw += dt * 0.025;
          dirty = true;
        }
        saveHomeCamera(camera);
      }

      if (!dirty) return;
      dirty = false;
      context.clearRect(0, 0, width, height);
      context.globalAlpha = camera.fade;
      const skyMarginX = width * 0.2;
      const skyMarginY = height * 0.2;
      const maxSkySegment = Math.max(width, height) * 0.35;

      context.lineCap = "round";
      for (const [lineWidth, alpha, color] of [
        [38, 0.018, star],
        [20, 0.028, star],
        [7, 0.05, star],
      ] as const) {
        for (let bucket = 0; bucket < 4; bucket++) {
          const low = bucket / 4;
          const high = (bucket + 1) / 4;
          const middle = (low + high) / 2;
          const path = new Path2D();
          for (let index = 1; index < scene.galaxy.length; index++) {
            const weight = scene.galaxy[index].w;
            if (weight < low || (weight >= high && bucket < 3)) continue;
            const a = projectSky(scene.galaxy[index - 1].p, camera);
            const b = projectSky(scene.galaxy[index].p, camera);
            if (a.depth <= 0.04 || b.depth <= 0.04) continue;
            if (Math.hypot(b.x - a.x, b.y - a.y) > maxSkySegment) continue;
            const aOutside = a.x < -skyMarginX || a.x > width + skyMarginX || a.y < -skyMarginY || a.y > height + skyMarginY;
            const bOutside = b.x < -skyMarginX || b.x > width + skyMarginX || b.y < -skyMarginY || b.y > height + skyMarginY;
            if (aOutside && bOutside) continue;
            path.moveTo(a.x, a.y);
            path.lineTo(b.x, b.y);
          }
          context.lineWidth = lineWidth * (0.5 + middle * 0.5);
          context.strokeStyle = rgba(color, alpha * (0.4 + middle));
          context.stroke(path);
        }
      }
      context.lineCap = "butt";

      const starPaths = Array.from({ length: 5 }, () => [new Path2D(), new Path2D(), new Path2D()]);
      for (const point of scene.backgroundStars) {
        const projected = projectSky(point.pos, camera);
        if (projected.depth <= 0.04 || projected.x < -point.size || projected.x > width + point.size || projected.y < -point.size || projected.y > height + point.size) continue;
        const bin = Math.min(4, Math.floor(point.brightness * 5));
        starPaths[bin][point.tone].moveTo(projected.x + point.size, projected.y);
        starPaths[bin][point.tone].arc(projected.x, projected.y, point.size, 0, Math.PI * 2);
      }
      const starAlpha = [0.22, 0.34, 0.5, 0.72, 0.96];
      const starTone = [star, sun, accent];
      starPaths.forEach((paths, bin) => paths.forEach((path, tone) => {
        context.fillStyle = rgba(starTone[tone], starAlpha[bin]);
        context.fill(path);
      }));
      drawSkyLine(scene.ecliptic, camera, text2, 0.16);

      scene.orbits.forEach((orbit, index) => {
        drawSceneLine(orbit, camera, planetColor[index], 0.12, 4);
        drawSceneLine(orbit, camera, planetColor[index], 0.7, 1);
      });
      const sunPoint = projectScene([0, 0, 0], camera);
      const sunRadius = Math.min(26, Math.max(10, 26 * DEFAULT_DIST / camera.dist));
      const glow = context.createRadialGradient(sunPoint.x, sunPoint.y, 0, sunPoint.x, sunPoint.y, sunRadius);
      glow.addColorStop(0, rgba(sun, 1));
      glow.addColorStop(0.25, rgba(sun, 0.55));
      glow.addColorStop(1, rgba(sun, 0));
      context.fillStyle = glow;
      context.beginPath();
      context.arc(sunPoint.x, sunPoint.y, sunRadius, 0, Math.PI * 2);
      context.fill();

      const labelScale = Math.min(1.5, Math.max(0.85, Math.sqrt(DEFAULT_DIST / camera.dist)));
      candidates.length = 0;
      accepted.length = 0;
      scene.planets.forEach((planet, index) => {
        const projected = projectScene(planet.pos, camera, planetProjection[index]);
        const earth = planet.name === "Earth";
        const label = earth ? "EARTH · SPHEREx" : planet.name.toUpperCase();
        const cacheKey = `planet:${label}`;
        context.font = "600 12px 'Manrope Variable', Manrope, system-ui, sans-serif";
        let textWidth = textWidths.get(cacheKey);
        if (textWidth === undefined) {
          textWidth = context.measureText(label.split("").join("\u2009")).width;
          textWidths.set(cacheKey, textWidth);
        }
        const dx = projected.x - sunPoint.x;
        const dy = projected.y - sunPoint.y;
        const innermost = index < 2;
        const horizontal = !innermost && Math.abs(dx) > Math.abs(dy) * 0.65;
        const align: CanvasTextAlign = horizontal ? (dx >= 0 ? "left" : "right") : "center";
        const labelX = horizontal ? projected.x + (dx >= 0 ? 12 : -12) * labelScale : projected.x;
        const labelY = innermost
          ? projected.y + (index === 0 ? -22 : 22) * labelScale
          : horizontal
            ? projected.y - 5 * labelScale
            : projected.y + (dy >= 0 ? 15 : -15) * labelScale;
        const scaledWidth = textWidth * labelScale;
        const left = align === "left" ? labelX : align === "right" ? labelX - scaledWidth : labelX - scaledWidth / 2;
        planetLabelX[index] = labelX;
        planetLabelY[index] = labelY;
        planetLabelAlign[index] = align;
        const priority = earth ? 90 : planet.name === "Mars" ? 60 : planet.name === "Venus" ? 50 : planet.name === "Mercury" ? 40 : 70;
        candidates.push({
          type: "planet",
          index,
          priority,
          left,
          right: left + scaledWidth,
          top: labelY - 9 * labelScale,
          bottom: labelY + 9 * labelScale,
          visible: projected.depth > 0.05 && projected.x > 0 && projected.x < width && projected.y > 0 && projected.y < height,
        });
      });

      scene.targets.forEach((target, index) => {
        const raw = projectScene(target.pos, camera, targetProjection[index]);
        let markerX = raw.x;
        let markerY = raw.y;
        const leftMargin = 30;
        const rightMargin = 90;
        const topMargin = 210;
        const bottomMargin = 90;
        const edge = raw.depth <= 0.05
          || markerX < leftMargin
          || markerX > width - rightMargin
          || markerY < topMargin
          || markerY > height - bottomMargin;
        let edgeAngle = 0;
        if (edge) {
          const rotated = rotate(target.pos, camera);
          const side = raw.depth > 0 ? 1 : -1;
          const dx = rotated.x * side;
          let dy = -rotated.z * side;
          if (Math.abs(dx) + Math.abs(dy) < 0.0001) dy = -1;
          const horizontalRoom = dx >= 0 ? width - rightMargin - width / 2 : width / 2 - leftMargin;
          const verticalRoom = dy >= 0 ? height - bottomMargin - height / 2 : height / 2 - topMargin;
          const factor = Math.min(horizontalRoom / Math.max(0.001, Math.abs(dx)), verticalRoom / Math.max(0.001, Math.abs(dy)));
          markerX = width / 2 + dx * factor;
          markerY = height / 2 + dy * factor;
          edgeAngle = Math.atan2(dy, dx) * 180 / Math.PI;
        }
        raw.x = markerX;
        raw.y = markerY;
        const element = markerRefs.current[index];
        if (element) {
          element.style.transform = `translate(${markerX}px, ${markerY}px)`;
          element.style.scale = String(labelScale);
          element.style.setProperty("--edge-angle", `${edgeAngle}deg`);
          element.dataset.edge = String(edge);
          element.dataset.behind = String(raw.depth <= 0.05);
        }
        const cacheKey = `target:${target.object.name}`;
        context.font = "600 14px 'Manrope Variable', Manrope, system-ui, sans-serif";
        let textWidth = textWidths.get(cacheKey);
        if (textWidth === undefined) {
          textWidth = context.measureText(target.object.name.toUpperCase()).width;
          textWidths.set(cacheKey, textWidth);
        }
        candidates.push({
          type: "target",
          index,
          priority: 100,
          left: markerX - 22 * labelScale,
          right: markerX + (32 + textWidth) * labelScale,
          top: markerY - 22 * labelScale,
          bottom: markerY + 22 * labelScale,
          visible: true,
        });
      });

      candidates.sort((a, b) => b.priority - a.priority || a.index - b.index);
      for (const candidate of candidates) {
        if (!candidate.visible) continue;
        const overlaps = accepted.some((other) =>
          candidate.left < other.right + 5 && candidate.right > other.left - 5
          && candidate.top < other.bottom + 4 && candidate.bottom > other.top - 4,
        );
        candidate.visible = !overlaps;
        if (!overlaps) accepted.push(candidate);
      }

      context.textBaseline = "middle";
      scene.planets.forEach((planet, index) => {
        const projected = planetProjection[index];
        if (projected.depth < 0.05) return;
        const earth = planet.name === "Earth";
        context.fillStyle = rgba(planetColor[index], 1);
        context.beginPath();
        context.arc(projected.x, projected.y, (earth ? 3 : 2.4) * labelScale, 0, Math.PI * 2);
        context.fill();
        context.strokeStyle = rgba(planetColor[index], 0.9);
        context.lineWidth = 1;
        context.beginPath();
        context.arc(projected.x, projected.y, (earth ? 9 : 7) * labelScale, 0, Math.PI * 2);
        context.stroke();
        const candidate = candidates.find((item) => item.type === "planet" && item.index === index);
        const desired = candidate?.visible ? 1 : 0;
        const fade = Math.min(1, dt / 0.15);
        planetLabelOpacity[index] += (desired - planetLabelOpacity[index]) * fade;
        if (planetLabelOpacity[index] < 0.01) return;
        context.font = `600 ${12 * labelScale}px 'Manrope Variable', Manrope, system-ui, sans-serif`;
        context.textAlign = planetLabelAlign[index];
        context.fillStyle = rgba(star, planetLabelOpacity[index] * 0.95);
        const label = (earth ? "EARTH · SPHEREx" : planet.name.toUpperCase()).split("").join("\u2009");
        context.fillText(label, planetLabelX[index], planetLabelY[index]);
      });
      context.textAlign = "left";

      scene.targets.forEach((_, index) => {
        const element = markerRefs.current[index];
        if (!element) return;
        const candidate = candidates.find((item) => item.type === "target" && item.index === index);
        element.style.opacity = String(camera.fade * (candidate?.visible ? 1 : 0));
        element.style.pointerEvents = candidate?.visible === false ? "none" : "";
      });
      context.globalAlpha = 1;

      const moving = fly.current || viewGlide
        || Math.abs(targetDist - camera.dist) > 0.001
        || Math.hypot(targetFocus[0] - camera.focus[0], targetFocus[1] - camera.focus[1], targetFocus[2] - camera.focus[2]) > 0.001;
      if (!reduce || moving) scheduleFrame();
    };

    scheduleFrame = () => {
      if (!animationFrame) animationFrame = requestAnimationFrame(frame);
    };
    scheduleFrame();

    const tickClock = () => {
      if (clockRef.current) clockRef.current.textContent = new Date().toISOString().slice(0, 19).replace("T", " ");
    };
    tickClock();
    const clock = window.setInterval(tickClock, 1000);

    const pointers = new Map<number, { x: number; y: number }>();
    let dragMode: "rotate" | "pan" = "rotate";
    let previousX = 0;
    let previousY = 0;
    let previousPinch = 0;
    let previousCenter = { x: 0, y: 0 };
    const interactive = (target: EventTarget | null) => target instanceof Element
      && Boolean(target.closest('button, a, input, select, textarea, [role="button"], [role="slider"], [role="dialog"], [contenteditable="true"]'));

    const pointerDown = (event: PointerEvent) => {
      if (fly.current || interactive(event.target)) return;
      if (event.pointerType === "mouse" && event.button > 2) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      dragging = true;
      previousX = event.clientX;
      previousY = event.clientY;
      dragMode = event.shiftKey || event.button === 1 || event.button === 2 ? "pan" : "rotate";
      wrap.dataset.dragging = "true";
      if (pointers.size === 2) {
        const pair = [...pointers.values()];
        previousPinch = Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y);
        previousCenter = { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 };
      }
    };

    const pointerMove = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId) || fly.current) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size >= 2) {
        const pair = [...pointers.values()].slice(0, 2);
        const center = { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 };
        const pinch = Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y);
        panBy(center.x - previousCenter.x, center.y - previousCenter.y);
        if (previousPinch > 0 && pinch > 0) zoomBy(previousPinch / pinch, center.x, center.y);
        previousPinch = pinch;
        previousCenter = center;
        return;
      }
      const dx = event.clientX - previousX;
      const dy = event.clientY - previousY;
      if (dragMode === "pan") {
        panBy(dx, dy);
      } else {
        cam.current.yaw += dx * 0.006;
        cam.current.pitch = Math.min(1.48, Math.max(-1.48, cam.current.pitch + dy * 0.004));
        dirty = true;
        scheduleFrame();
      }
      previousX = event.clientX;
      previousY = event.clientY;
    };

    const pointerUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (pointers.size === 1) {
        const remaining = [...pointers.values()][0];
        previousX = remaining.x;
        previousY = remaining.y;
      }
      if (!pointers.size) {
        dragging = false;
        delete wrap.dataset.dragging;
        saveHomeCamera(cam.current);
      }
    };

    const wheel = (event: WheelEvent) => {
      if (interactive(event.target) || fly.current) return;
      event.preventDefault();
      const sensitivity = event.ctrlKey ? 0.003 : 0.0015;
      zoomBy(Math.exp(event.deltaY * sensitivity), event.clientX, event.clientY);
    };

    const keydown = (event: KeyboardEvent) => {
      if (interactive(event.target) || event.metaKey || event.ctrlKey || event.altKey || fly.current) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomBy(0.8);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomBy(1.2);
      } else if (event.key === "0") {
        event.preventDefault();
        glideTo(cloneCamera(initialCamera));
      }
    };

    const zoomControl = (event: Event) => {
      const direction = (event as CustomEvent<number>).detail;
      zoomBy(direction > 0 ? 0.8 : 1.2);
    };

    const focusControl = (event: Event) => {
      const index = (event as CustomEvent<number>).detail;
      const target = scene.targets[index];
      if (target) glideFocus(target.pos);
    };

    const contextMenu = (event: MouseEvent) => {
      if (!interactive(event.target)) event.preventDefault();
    };

    const planetDoubleClick = (event: MouseEvent) => {
      const bounds = canvas.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      let nearest = -1;
      let nearestDistance = 24;
      planetProjection.forEach((point, index) => {
        const distance = Math.hypot(point.x - x, point.y - y);
        if (distance < nearestDistance) {
          nearest = index;
          nearestDistance = distance;
        }
      });
      if (nearest >= 0) glideFocus(scene.planets[nearest].pos);
    };

    window.addEventListener("pointerdown", pointerDown);
    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerUp);
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", keydown);
    window.addEventListener("spherex:orrery-zoom", zoomControl);
    window.addEventListener("spherex:orrery-focus", focusControl);
    wrap.addEventListener("contextmenu", contextMenu);
    canvas.addEventListener("dblclick", planetDoubleClick);

    return () => {
      cancelAnimationFrame(animationFrame);
      window.clearInterval(clock);
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
      resizeObserver.disconnect();
      window.removeEventListener("pointerdown", pointerDown);
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerUp);
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("spherex:orrery-zoom", zoomControl);
      window.removeEventListener("spherex:orrery-focus", focusControl);
      wrap.removeEventListener("contextmenu", contextMenu);
      canvas.removeEventListener("dblclick", planetDoubleClick);
    };
  }, [returnFlight, targets]);

  const pick = (target: CatalogObject, index: number) => {
    if (fly.current || !target.preset_id) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return onPick(target, null);
    markerRefs.current[index]?.setAttribute("data-picked", "true");
    onFlightStartRef.current?.(target);
    const astrometry = toEcliptic(target);
    const camera = cam.current;
    startTargetFlight(target.preset_id, camera);
    let yaw = Math.atan2(astrometry.direction[0], astrometry.direction[1]);
    while (yaw - camera.yaw > Math.PI) yaw -= 2 * Math.PI;
    while (camera.yaw - yaw > Math.PI) yaw += 2 * Math.PI;
    const pitch = Math.atan2(-astrometry.direction[2], Math.hypot(astrometry.direction[0], astrometry.direction[1]));
    fly.current = { mode: "forward", start: -1, from: cloneCamera(camera), to: { yaw, pitch }, target, index };
  };

  const queuePick = (target: CatalogObject, index: number) => {
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      pick(target, index);
    }, 220);
  };

  const focusTarget = (index: number) => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    window.dispatchEvent(new CustomEvent("spherex:orrery-focus", { detail: index }));
  };

  return (
    <>
      <div ref={anchorRef} className={s.anchor}>
        <p className={`${s.hud} mono`}>
          <span className={s.live}>
            <span className={s.liveDot} aria-hidden="true" />
            Sky context
          </span>
          <span>
            UTC now <span ref={clockRef} />
          </span>
        </p>
      </div>
      <div ref={wrapRef} className={s.orrery} aria-label="Solar system and sky targets">
        <canvas ref={canvasRef} className={s.canvas} aria-hidden="true" />
        {targets.map((target, index) => {
          const content = (
            <>
              <span className={s.ring} aria-hidden="true" />
              <span className={s.label}>
                <span className={s.name}>{target.name}</span>
                <span className={s.kind}>{target.kind.replaceAll("_", " ")}</span>
              </span>
            </>
          );
          return target.preset_id ? (
            <button
              key={target.id}
              ref={(element) => { markerRefs.current[index] = element; }}
              type="button"
              className={s.target}
              onClick={() => queuePick(target, index)}
              onDoubleClick={() => focusTarget(index)}
              onPointerEnter={() => { holdRef.current = true; }}
              onPointerDown={() => { holdRef.current = true; }}
              onPointerLeave={() => { holdRef.current = false; }}
              onFocus={() => { holdRef.current = true; }}
              onBlur={() => { holdRef.current = false; }}
              aria-label={`Fly to ${target.name}`}
            >
              {content}
            </button>
          ) : (
            <div
              key={target.id}
              ref={(element) => { markerRefs.current[index] = element; }}
              className={`${s.target} ${s.targetStatic}`}
              aria-hidden="true"
            >
              {content}
            </div>
          );
        })}
      </div>
    </>
  );
}
