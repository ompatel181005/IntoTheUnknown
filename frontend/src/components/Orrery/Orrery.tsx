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
const DEFAULT_DIST = 38;
type Camera = Omit<OrreryCameraState, "focus">;
const defaultCamera: Camera = { yaw: initialCamera.yaw, pitch: initialCamera.pitch, dist: DEFAULT_DIST, fade: 1 };
const cinematic = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const rgba = (color: [number, number, number], alpha: number) =>
  `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;

function cloneCamera(camera: Camera): Camera {
  return { yaw: camera.yaw, pitch: camera.pitch, dist: camera.dist, fade: camera.fade };
}

// The flight module still requires this legacy field. Home never reads or changes it.
function flightCamera(camera: Camera): OrreryCameraState {
  return { ...camera, focus: [0, 0, 0] };
}

function homeCamera(): Camera {
  const saved = getHomeCamera();
  return saved.dist === initialCamera.dist && saved.yaw === initialCamera.yaw && saved.pitch === initialCamera.pitch
    ? cloneCamera(defaultCamera) : cloneCamera(saved);
}

function buildScene(targets: readonly CatalogObject[]) {
  const T = centuries(new Date());
  const targetPoints = targets.map((object) => {
    const astrometry = toEcliptic(object);
    const radius = astrometry.distancePc === null
      ? 1
      : radialScale(astrometry.distancePc * AU_PER_PARSEC);
    return {
      object,
      hasDistance: astrometry.distancePc !== null,
      pos: astrometry.direction.map((component) => component * radius) as Vec3,
      direction: astrometry.direction as Vec3,
    };
  });
  const key = JSON.stringify(targets);
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
  const key = JSON.stringify(targets);
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
  const returnHandledRef = useRef(false);
  const wakeRef = useRef<() => void>(() => undefined);
  const [returnFlight] = useState(getReturnFlight);
  const cam = useRef<Camera>(cloneCamera(returnFlight?.from ?? homeCamera()));
  const fly = useRef<
    | { mode: "forward"; start: number; from: Camera; to: { yaw: number; pitch: number }; target: CatalogObject; index: number }
    | { mode: "return"; start: number; from: Camera; to: Camera; targetId: string | null; index: number }
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
    const candidates: LabelCandidate[] = [
      ...scene.planets.map((_, index): LabelCandidate => ({ type: "planet", index, priority: index === 2 ? 90 : index > 3 ? 70 : index === 3 ? 60 : index === 1 ? 50 : 40, left: 0, right: 0, top: 0, bottom: 0, visible: false })),
      ...scene.targets.map((_, index): LabelCandidate => ({ type: "target", index, priority: 100, left: 0, right: 0, top: 0, bottom: 0, visible: false })),
    ];
    const planetCandidates = candidates.slice(0, scene.planets.length);
    const targetCandidates = candidates.slice(scene.planets.length);
    candidates.sort((a, b) => b.priority - a.priority || a.index - b.index);
    const targetLabelWidths = scene.targets.map(() => 0);
    const targetLabelHeights = scene.targets.map(() => 0);
    const accepted: LabelCandidate[] = [];
    const textWidths = new Map<string, number>();
    let targetDist = cam.current.dist;
    let viewGlide: { start: number; from: Camera; to: Camera } | null = null;

    let disposed = false;
    if (returnFlight && !returnHandledRef.current) {
      if (reduce) {
        cam.current = cloneCamera(returnFlight.to);
        targetDist = cam.current.dist;
        queueMicrotask(() => {
          if (disposed || returnHandledRef.current) return;
          returnHandledRef.current = true;
          finishReturnFlight(flightCamera(cam.current));
          onFlightEndRef.current?.();
        });
      } else if (!fly.current) {
        fly.current = {
          mode: "return", start: -1,
          from: cloneCamera(returnFlight.from), to: cloneCamera(returnFlight.to),
          targetId: returnFlight.targetId,
          index: returnFlight.targetId
            ? scene.targets.findIndex((target) => target.object.preset_id === returnFlight.targetId) : -1,
        };
      }
    }

    const activeReturn = fly.current;
    if (activeReturn?.mode === "return") {
      activeReturn.index = scene.targets.findIndex((target) => target.object.preset_id === activeReturn.targetId);
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
      focalLength = height / (2 * Math.tan(FOV_RADIANS / 2));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      markerRefs.current.forEach((element, index) => {
        const label = element?.querySelector<HTMLElement>(`.${s.label}`);
        targetLabelWidths[index] = label?.offsetWidth ?? 0;
        targetLabelHeights[index] = label?.offsetHeight ?? 0;
      });
      textWidths.clear();
      dirty = true;
      scheduleFrame();
    };
    resize();
    void document.fonts.ready.then(() => { if (!disposed) resize(); });
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(wrap);
    resizeObserver.observe(anchor);

    const rotate = (vector: Vec3, camera: Camera) => {
      const x = vector[0];
      const y = vector[1];
      const z = vector[2];
      const cy = Math.cos(camera.yaw);
      const sy = Math.sin(camera.yaw);
      const cp = Math.cos(camera.pitch);
      const sp = Math.sin(camera.pitch);
      const x1 = x * cy - y * sy;
      const y1 = x * sy + y * cy;
      return { x: x1, y: y1 * cp - z * sp, z: y1 * sp + z * cp };
    };

    const projectScene = (vector: Vec3, camera: Camera, output?: Projection): Projection => {
      const rotated = rotate(vector, camera);
      const depth = rotated.y + camera.dist;
      const result = output ?? { x: 0, y: 0, depth: 0, front: false };
      result.x = sceneBox.left + sceneBox.width / 2 + focalLength * rotated.x / depth;
      result.y = sceneBox.top + sceneBox.height / 2 - focalLength * rotated.z / depth;
      result.depth = depth;
      result.front = rotated.y < 0;
      return result;
    };

    const projectSky = (vector: Vec3, camera: Camera) => {
      const rotated = rotate(vector, camera);
      return {
        x: sceneBox.left + sceneBox.width / 2 + focalLength * rotated.x / rotated.y,
        y: sceneBox.top + sceneBox.height / 2 - focalLength * rotated.z / rotated.y,
        depth: rotated.y,
      };
    };

    const projectTarget = (target: (typeof scene.targets)[number], camera: Camera, output?: Projection): Projection => {
      if (target.hasDistance) return projectScene(target.pos, camera, output);
      const projected = projectSky(target.direction, camera);
      return Object.assign(output ?? { front: false }, projected, { front: false });
    };

    const drawSceneLine = (points: Vec3[], camera: Camera, color: [number, number, number], alpha: number, lineWidth = 1) => {
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

    const drawSkyLine = (points: Vec3[], camera: Camera, color: [number, number, number], alpha: number) => {
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

    const zoomBy = (factor: number) => {
      if (fly.current) return;
      viewGlide = null;
      const limitedFactor = Math.min(1.2, Math.max(0.8, factor));
      let next = targetDist * limitedFactor;
      if (next < MIN_DIST) next = MIN_DIST + (targetDist - MIN_DIST) * 0.08;
      if (next > MAX_DIST) next = MAX_DIST - (MAX_DIST - targetDist) * 0.08;
      targetDist = Math.min(MAX_DIST, Math.max(MIN_DIST, next));
      if (reduce) {
        cam.current.dist = targetDist;
        saveHomeCamera(flightCamera(cam.current));
      }
      dirty = true;
      scheduleFrame();
    };

    const glideTo = (to: Camera) => {
      if (reduce) {
        cam.current = cloneCamera(to);
        targetDist = to.dist;
        saveHomeCamera(flightCamera(cam.current));
      } else {
        viewGlide = { start: -1, from: cloneCamera(cam.current), to: cloneCamera(to) };
      }
      dirty = true;
      scheduleFrame();
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
          const projected = projectTarget(scene.targets[activeFlight.index], camera);
          setFlightFocus(projected.x, projected.y);
          saveTargetCommit(activeFlight.target.preset_id ?? activeFlight.target.id, flightCamera(camera));
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
          if (activeFlight.index >= 0) {
            const projected = projectTarget(scene.targets[activeFlight.index], camera);
            setFlightFocus(projected.x, projected.y);
          }
          if (t >= 1) {
            fly.current = null;
            targetDist = camera.dist;
            returnHandledRef.current = true;
            finishReturnFlight(flightCamera(camera));
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
        targetDist = camera.dist;
        if (t >= 1) viewGlide = null;
        dirty = true;
      } else {
        const damping = reduce ? 1 : 1 - Math.exp(-dt / 0.14);
        const distanceDelta = targetDist - camera.dist;
        if (Math.abs(distanceDelta) > 0.001) {
          camera.dist += distanceDelta * damping;
          dirty = true;
        } else {
          camera.dist = targetDist;
        }
        if (!reduce && !dragging && !holdRef.current) {
          camera.yaw += dt * 0.025;
          dirty = true;
        }
        saveHomeCamera(flightCamera(camera));
      }

      if (!dirty) {
        if (!reduce) scheduleFrame();
        return;
      }
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
      const sunRadius = Math.min(26, Math.max(10, 18 * DEFAULT_DIST / camera.dist));
      const glow = context.createRadialGradient(sunPoint.x, sunPoint.y, 0, sunPoint.x, sunPoint.y, sunRadius);
      glow.addColorStop(0, rgba(sun, 1));
      glow.addColorStop(0.25, rgba(sun, 0.55));
      glow.addColorStop(1, rgba(sun, 0));
      context.fillStyle = glow;
      context.beginPath();
      context.arc(sunPoint.x, sunPoint.y, sunRadius, 0, Math.PI * 2);
      context.fill();

      const labelScale = Math.min(1.5, Math.max(1, Math.sqrt(DEFAULT_DIST / camera.dist)));
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
        const rawLeft = align === "left" ? labelX : align === "right" ? labelX - scaledWidth : labelX - scaledWidth / 2;
        const left = Math.max(12, Math.min(width - 12 - scaledWidth, rawLeft));
        planetLabelX[index] = left;
        planetLabelY[index] = labelY;
        planetLabelAlign[index] = "left";
        Object.assign(planetCandidates[index], {
          left, right: left + scaledWidth,
          top: labelY - 9 * labelScale, bottom: labelY + 9 * labelScale,
          visible: projected.depth > 0.05 && projected.x > 16 && projected.x < width - 16 && projected.y > 200 && projected.y < height - 60,
        });
      });

      scene.targets.forEach((target, index) => {
        const raw = projectTarget(target, camera, targetProjection[index]);
        let markerX = raw.x;
        let markerY = raw.y;
        const leftMargin = 28 * labelScale;
        const rightMargin = (width < 769 ? 28 : 90) * labelScale;
        const topMargin = width < 769 ? 270 : 220;
        const bottomMargin = width < 769 ? 210 : 100;
        const centerX = sceneBox.left + sceneBox.width / 2;
        const centerY = sceneBox.top + sceneBox.height / 2;
        const edge = raw.depth <= 0.05
          || markerX < leftMargin
          || markerX > width - rightMargin
          || markerY < topMargin
          || markerY > height - bottomMargin;
        let edgeAngle = 0;
        if (edge) {
          const rotated = rotate(target.pos, camera);
          const dx = rotated.x;
          let dy = -rotated.z;
          if (Math.abs(dx) + Math.abs(dy) < 0.0001) dy = -1;
          const horizontalRoom = dx >= 0 ? width - rightMargin - centerX : centerX - leftMargin;
          const verticalRoom = dy >= 0 ? height - bottomMargin - centerY : centerY - topMargin;
          const factor = Math.min(horizontalRoom / Math.max(0.001, Math.abs(dx)), verticalRoom / Math.max(0.001, Math.abs(dy)));
          markerX = centerX + dx * factor;
          markerY = centerY + dy * factor;
          edgeAngle = Math.atan2(dy, dx) * 180 / Math.PI;
        }
        raw.x = markerX;
        raw.y = markerY;
        const labelWidth = targetLabelWidths[index] * labelScale;
        const labelHeight = targetLabelHeights[index] * labelScale;
        const labelLeft = markerX + 32 * labelScale + labelWidth > width - 24;
        const labelX = Math.max(16, Math.min(width - 16 - labelWidth,
          labelLeft ? markerX - 32 * labelScale - labelWidth : markerX + 32 * labelScale));
        const labelY = labelX < markerX + 22 * labelScale && labelX + labelWidth > markerX - 22 * labelScale
          ? markerY - 32 * labelScale - labelHeight / 2 : markerY;
        const element = markerRefs.current[index];
        if (element) {
          element.style.setProperty("--label-top", `${22 + (labelY - markerY) / labelScale}px`);
          element.dataset.labelLeft = String(labelLeft);
          element.style.setProperty("--label-offset", `${22 + (labelX - markerX) / labelScale}px`);
          element.style.transform = `translate(${markerX}px, ${markerY}px)`;
          element.style.scale = String(labelScale);
          element.style.setProperty("--edge-angle", `${edgeAngle}deg`);
          element.dataset.edge = String(edge);
          element.dataset.behind = String(raw.depth <= 0.05);
        }
        Object.assign(targetCandidates[index], {
          left: Math.min(markerX - 22 * labelScale, labelX),
          right: Math.max(markerX + 22 * labelScale, labelX + labelWidth),
          top: Math.min(markerY - 22 * labelScale, labelY - labelHeight / 2),
          bottom: Math.max(markerY + 22 * labelScale, labelY + labelHeight / 2),
          visible: true,
        });
      });

      for (const candidate of candidates) {
        if (!candidate.visible) continue;
        const overlaps = () => accepted.some((other) =>
          candidate.left < other.right + 6 && candidate.right > other.left - 6
          && candidate.top < other.bottom + 5 && candidate.bottom > other.top - 5,
        );
        if (candidate.type === "planet" && overlaps()) {
          const point = planetProjection[candidate.index];
          const w = (candidate.right - candidate.left) / labelScale;
          // Try nearby label positions before fading a lower-priority name.
          const offsets = [[12, -18], [-12 - w, -18], [12, 18], [-12 - w, 18], [-w / 2, -34], [-w / 2, 34]];
          for (const [dx, dy] of offsets) {
            candidate.left = point.x + dx * labelScale;
            candidate.right = candidate.left + w * labelScale;
            candidate.top = point.y + dy * labelScale - 9 * labelScale;
            candidate.bottom = candidate.top + 18 * labelScale;
            if (candidate.left < 12 || candidate.right > width - 12 || candidate.top < 210 || candidate.bottom > height - 60) continue;
            if (!overlaps()) {
              planetLabelX[candidate.index] = candidate.left;
              planetLabelY[candidate.index] = (candidate.top + candidate.bottom) / 2;
              planetLabelAlign[candidate.index] = "left";
              break;
            }
          }
        }
        candidate.visible = !overlaps() && (candidate.type === "target" || (
          candidate.left >= 12 && candidate.right <= width - 12
          && candidate.top >= (width < 769 ? 245 : 200) && candidate.bottom <= height - 60
        ));
        if (candidate.visible) accepted.push(candidate);
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
        const candidate = planetCandidates[index];
        const desired = candidate?.visible ? 1 : 0;
        const fade = Math.min(1, dt / 0.15);
        planetLabelOpacity[index] = reduce ? desired : planetLabelOpacity[index] + (desired - planetLabelOpacity[index]) * fade;
        if (!reduce && Math.abs(desired - planetLabelOpacity[index]) > 0.01) dirty = true;
        if (planetLabelOpacity[index] < 0.01) return;
        if (!candidate.visible) {
          const labelWidth = (textWidths.get(`planet:${earth ? "EARTH · SPHEREx" : planet.name.toUpperCase()}`) ?? 0) * labelScale;
          const labelX = planetLabelX[index];
          const labelY = planetLabelY[index];
          if (accepted.some((other) => labelX < other.right && labelX + labelWidth > other.left
            && labelY - 9 * labelScale < other.bottom && labelY + 9 * labelScale > other.top)) return;
        }
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
        const candidate = targetCandidates[index];
        element.style.opacity = String(camera.fade);
        element.dataset.labelHidden = String(!candidate.visible);
        element.style.pointerEvents = scene.targets[index].object.preset_id ? "auto" : "none";
      });
      context.globalAlpha = 1;

      const moving = fly.current || viewGlide || Math.abs(targetDist - camera.dist) > 0.001;
      if (!reduce || moving) scheduleFrame();
    };

    scheduleFrame = () => {
      if (!animationFrame) animationFrame = requestAnimationFrame(frame);
    };
    wakeRef.current = () => { dirty = true; scheduleFrame(); };
    scheduleFrame();

    const tickClock = () => {
      if (clockRef.current) clockRef.current.textContent = new Date().toISOString().slice(0, 19).replace("T", " ");
    };
    tickClock();
    const clock = window.setInterval(tickClock, 1000);

    const pointers = new Map<number, { x: number; y: number }>();
    let previousX = 0;
    let previousY = 0;
    let previousPinch = 0;
    const interactive = (target: EventTarget | null) => target instanceof Element
      && Boolean(target.closest('button, a, input, select, textarea, [role="button"], [role="slider"], [role="dialog"], [contenteditable="true"]'));

    const pointerDown = (event: PointerEvent) => {
      if (fly.current || interactive(event.target) || event.shiftKey) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      viewGlide = null;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      dragging = true;
      previousX = event.clientX;
      previousY = event.clientY;
      wrap.dataset.dragging = "true";
      if (pointers.size === 2) {
        const pair = [...pointers.values()];
        previousPinch = Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y);
      }
    };

    const pointerMove = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId) || fly.current) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size >= 2) {
        const pair = [...pointers.values()].slice(0, 2);
        const pinch = Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y);
        if (previousPinch > 0 && pinch > 0) zoomBy(previousPinch / pinch);
        previousPinch = pinch;
        return;
      }
      const dx = event.clientX - previousX;
      const dy = event.clientY - previousY;
      cam.current.yaw += dx * 0.006;
      cam.current.pitch = Math.min(1.48, Math.max(-1.48, cam.current.pitch + dy * 0.004));
      dirty = true;
      scheduleFrame();
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
        saveHomeCamera(flightCamera(cam.current));
      }
    };

    const wheel = (event: WheelEvent) => {
      if (interactive(event.target) || fly.current) return;
      event.preventDefault();
      const sensitivity = event.ctrlKey ? 0.003 : 0.0015;
      zoomBy(Math.exp(Math.max(-150, Math.min(150, event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1))) * sensitivity));
    };

    const keydown = (event: KeyboardEvent) => {
      const editing = event.target instanceof Element && event.target.closest('input, select, textarea, [role="dialog"], [contenteditable="true"]');
      if (editing || event.metaKey || event.ctrlKey || event.altKey || fly.current) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomBy(0.8);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomBy(1.2);
      } else if (event.key === "0") {
        event.preventDefault();
        glideTo(cloneCamera(defaultCamera));
      }
    };

    const zoomControl = (event: Event) => {
      const direction = (event as CustomEvent<number>).detail;
      zoomBy(direction > 0 ? 0.8 : 1.2);
    };

    window.addEventListener("pointerdown", pointerDown);
    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerUp);
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", keydown);
    window.addEventListener("spherex:orrery-zoom", zoomControl);

    return () => {
      disposed = true;
      delete wrap.dataset.dragging;
      wakeRef.current = () => undefined;
      cancelAnimationFrame(animationFrame);
      window.clearInterval(clock);
      resizeObserver.disconnect();
      window.removeEventListener("pointerdown", pointerDown);
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerUp);
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("spherex:orrery-zoom", zoomControl);
    };
  }, [returnFlight, targets]);

  const pick = (target: CatalogObject, index: number) => {
    if (fly.current || !target.preset_id) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return onPick(target, null);
    markerRefs.current[index]?.setAttribute("data-picked", "true");
    onFlightStartRef.current?.(target);
    const astrometry = toEcliptic(target);
    const camera = cam.current;
    startTargetFlight(target.preset_id, flightCamera(camera));
    let yaw = Math.atan2(astrometry.direction[0], astrometry.direction[1]);
    while (yaw - camera.yaw > Math.PI) yaw -= 2 * Math.PI;
    while (camera.yaw - yaw > Math.PI) yaw += 2 * Math.PI;
    const pitch = Math.atan2(-astrometry.direction[2], Math.hypot(astrometry.direction[0], astrometry.direction[1]));
    fly.current = { mode: "forward", start: -1, from: cloneCamera(camera), to: { yaw, pitch }, target, index };
    wakeRef.current();
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
              onClick={() => pick(target, index)}
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
