import { useEffect, useMemo, useRef } from "react";
import { toEcliptic } from "../../lib/catalog";
import {
  flightIsActive,
  getFlightSample,
  getHomeCamera,
  initialCamera,
  markFlight,
  registerHomeNavigation,
  saveHomeCamera,
  startTargetFlight,
  subscribeFlight,
  type OrreryCameraState,
} from "../../lib/flight";
import {
  AU_PER_PARSEC,
  centuries,
  mapRadial,
  meanAnomaly,
  PLANETS,
  position,
  radialScale,
  raDecToEcliptic,
  type Vec3,
} from "../../lib/orbits";
import { cacheStarfield, loadStarfield } from "../../lib/starfield";
import { galacticToEq } from "../../lib/sky";
import { tokenRgb } from "../../lib/stretch";
import type { CatalogObject } from "../../types";
import { RectGrid } from "./RectGrid";
import s from "./Orrery.module.css";

interface OrreryProps {
  targets: readonly CatalogObject[];
  visibleIds: ReadonlySet<string> | null;
  active: boolean;
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

const FOV_RADIANS = Math.PI / 3;
const MIN_DIST = 2.5;
const MAX_DIST = 120;
const DEFAULT_DIST = 38;
type Camera = Omit<OrreryCameraState, "focus">;
const defaultCamera: Camera = { yaw: initialCamera.yaw, pitch: initialCamera.pitch, dist: DEFAULT_DIST, fade: 1 };
const cinematic = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const ORBIT_STEPS = 128;
const TRAIL_BANDS = 16;
const SPRITE_SIZE = 48;
const PHASE_STEPS = 64;
const DAY_MS = 86400000;
// Anchor geometry in CSS px (scaled with zoom): ring and dot radii, notch dot, hit half-size.
const RING = 5;
const RING_HIGHLIGHT = 7.5;
const DOT = 1.6;
const NOTCH_DOT = 1.8;
const HIT_HALF = 12;
const LABEL_GAP = 16;
const NEAR_RADIUS = 80;
const NEAR_COUNT = 2;
const TAP_RADIUS = 36;
// Catalog names appear once the camera is this close (fraction of the home distance), and
// leave again only past the looser bound, so a zoom at the threshold never oscillates.
const REVEAL_IN = 0.72;
const REVEAL_OUT = 0.82;

/** Zoom-reveal order: brown dwarfs and stars by proper motion, then variables, then the rest. */
function revealOrder(a: CatalogObject, b: CatalogObject) {
  const group = (object: CatalogObject) => object.kind === "brown_dwarf" || object.kind === "star" ? 0 : object.kind === "variable" ? 1 : 2;
  const motion = (object: CatalogObject) => Math.hypot(object.pmra_mas_yr ?? 0, object.pmdec_mas_yr ?? 0);
  return group(a) - group(b) || motion(b) - motion(a);
}

/** Cached Lambert-lit phases, rotated toward the projected Sun when drawn. */
function sphereAtlas(color: [number, number, number]) {
  const atlas = document.createElement("canvas");
  atlas.width = SPRITE_SIZE * (PHASE_STEPS + 1);
  atlas.height = SPRITE_SIZE;
  const context = atlas.getContext("2d")!;
  const pixels = context.createImageData(atlas.width, atlas.height);
  for (let phase = 0; phase <= PHASE_STEPS; phase++) {
    const lightZ = 2 * phase / PHASE_STEPS - 1;
    const lightX = Math.sqrt(1 - lightZ * lightZ);
    for (let y = 0; y < SPRITE_SIZE; y++) {
      for (let x = 0; x < SPRITE_SIZE; x++) {
        const nx = (x + 0.5 - SPRITE_SIZE / 2) / (SPRITE_SIZE / 2 - 1);
        const ny = (y + 0.5 - SPRITE_SIZE / 2) / (SPRITE_SIZE / 2 - 1);
        const radius = Math.hypot(nx, ny);
        if (radius >= 1) continue;
        const nz = Math.sqrt(1 - radius * radius);
        const diffuse = Math.max(0, nx * lightX + nz * lightZ);
        const shade = (0.16 + 1.05 * diffuse) * (0.65 + 0.35 * Math.sqrt(nz));
        const offset = (y * atlas.width + phase * SPRITE_SIZE + x) * 4;
        for (let channel = 0; channel < 3; channel++) pixels.data[offset + channel] = Math.min(255, color[channel] * shade);
        pixels.data[offset + 3] = 255 * Math.min(1, (1 - radius) * (SPRITE_SIZE / 2 - 1));
      }
    }
  }
  context.putImageData(pixels, 0, 0);
  return atlas;
}

const rgba = (color: [number, number, number], alpha: number) =>
  `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;

function cloneCamera(camera: Camera): Camera {
  return { yaw: camera.yaw, pitch: camera.pitch, dist: camera.dist, fade: camera.fade };
}

function flightCamera(camera: Camera): OrreryCameraState {
  return { ...camera };
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
    orbitTime: T,
    orbits: PLANETS.map((planet) =>
      Array.from({ length: ORBIT_STEPS }, (_, index) => mapRadial(position(planet, T, (index / ORBIT_STEPS) * Math.PI * 2))),
    ),
    planets: PLANETS.map((planet) => ({ name: planet.name, pos: mapRadial(position(planet, T)) })),
    ecliptic: Array.from({ length: 97 }, (_, index): Vec3 => {
      const angle = (index / 96) * Math.PI * 2;
      return [Math.cos(angle), Math.sin(angle), 0];
    }),
    galaxy: [[0, 0], [90, 0], [0, 90]].map(([longitude, latitude]) => {
      const point = galacticToEq(longitude, latitude);
      return raDecToEcliptic(point.ra, point.dec);
    }),
    targets: targetPoints,
  };
}

let sceneCache: ReturnType<typeof buildScene> | null = null;

function getScene(targets: readonly CatalogObject[]) {
  const key = JSON.stringify(targets);
  if (!sceneCache || sceneCache.key !== key) sceneCache = buildScene(targets);
  return sceneCache;
}

/** Interactive heliocentric view with a rotation-only celestial background. */
export function Orrery({ targets, visibleIds, active, onPick, onFlightStart, onFlightEnd }: OrreryProps) {
  const visibleTargets = useMemo(() => targets.filter((target) => visibleIds === null || visibleIds.has(target.id)), [targets, visibleIds]);
  const anchorRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pickRef = useRef<(index: number) => void>(() => undefined);
  const focusedRef = useRef<string | null>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const wakeRef = useRef<() => void>(() => undefined);
  const activeRef = useRef(active);
  const cam = useRef<Camera>(homeCamera());
  const onPickRef = useRef(onPick);
  const onFlightStartRef = useRef(onFlightStart);
  const onFlightEndRef = useRef(onFlightEnd);
  const holdRef = useRef(false);
  // Preserve time across catalog/effect changes and while the home scene is hidden.
  const timeRef = useRef({ epoch: 0, start: 0 });

  useEffect(() => {
    activeRef.current = active;
    wakeRef.current();
    onPickRef.current = onPick;
    onFlightStartRef.current = onFlightStart;
    onFlightEndRef.current = onFlightEnd;
  }, [active, onPick, onFlightStart, onFlightEnd]);

  useEffect(() => {
    const anchor = anchorRef.current;
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!anchor || !wrap || !canvas || !context) return;

    if (!timeRef.current.epoch) timeRef.current = { epoch: Date.now(), start: performance.now() };

    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduce = motionPreference.matches;
    const simulatedTime = (now: number) => reduce ? Date.now() : timeRef.current.epoch + (now - timeRef.current.start) * DAY_MS / 1000;
    const clockDate = new Date();
    let clockSecond = -1;
    const tickClock = (time: number) => {
      if (Math.floor(time / 1000) === clockSecond) return;
      clockSecond = Math.floor(time / 1000);
      clockDate.setTime(time);
      if (clockRef.current) clockRef.current.textContent = `Sim ${clockDate.toISOString().slice(0, 19).replace("T", " ")} UTC`;
    };
    const star = tokenRgb("--star");
    const sun = tokenRgb("--sun");
    const text2 = tokenRgb("--text-2");
    const planetColor = PLANETS.map((planet) => tokenRgb(`--planet-${planet.name.toLowerCase()}`));
    const sprites = planetColor.map(sphereAtlas);
    const sunSprite = document.createElement("canvas");
    sunSprite.width = sunSprite.height = 96;
    const sunContext = sunSprite.getContext("2d")!;
    const glow = sunContext.createRadialGradient(48, 48, 0, 48, 48, 48);
    glow.addColorStop(0, rgba(sun, 1));
    glow.addColorStop(0.25, rgba(sun, 0.55));
    glow.addColorStop(1, rgba(sun, 0));
    sunContext.fillStyle = glow;
    sunContext.fillRect(0, 0, 96, 96);
    const trailColors = planetColor.map((color) => Array.from({ length: TRAIL_BANDS }, (_, band) =>
      rgba(color, 0.015 + 0.5 * (1 - band / (TRAIL_BANDS - 1)) ** 2)));
    const planetLabels = PLANETS.map((planet) => (planet.name === "Earth" ? "EARTH · SPHEREx" : planet.name.toUpperCase()).split("").join("\u2009"));
    const planetSizes = [3.4, 4.1, 4.5, 3.7, 6.2, 5.4, 4.7, 4.6];
    const scene = getScene(visibleTargets);
    if (!visibleTargets.some((target) => target.id === focusedRef.current)) {
      focusedRef.current = null;
      holdRef.current = false;
    }
    const planetProjection = scene.planets.map((): Projection => ({ x: 0, y: 0, depth: 0, front: false }));
    const planetLabelX = scene.planets.map(() => 0);
    const planetLabelY = scene.planets.map(() => 0);
    const planetLabelAlign = scene.planets.map((): CanvasTextAlign => "left");
    const targetProjection = scene.targets.map((): Projection => ({ x: 0, y: 0, depth: 0, front: false }));
    const planetLabelOpacity = scene.planets.map(() => 0);
    const labelOffsetX = scene.planets.map(() => NaN);
    const labelOffsetY = scene.planets.map(() => NaN);
    const labelOffsets: readonly (readonly [number, number])[] = [[12, -18], [-12, -18], [12, 18], [-12, 18], [0, -34], [0, 34]];
    // Planets outrank every catalog name; challenge targets outrank the zoom-revealed rest.
    const revealRank = scene.targets.map((target) => target.object)
      .filter((object) => object.preset_id === null).sort(revealOrder);
    const candidates: LabelCandidate[] = [
      ...scene.planets.map((_, index): LabelCandidate => ({ type: "planet", index, priority: 200 + (index === 2 ? 90 : index > 3 ? 70 : index === 3 ? 60 : index === 1 ? 50 : 40), left: 0, right: 0, top: 0, bottom: 0, visible: false })),
      ...scene.targets.map((target, index): LabelCandidate => ({
        type: "target", index, left: 0, right: 0, top: 0, bottom: 0, visible: false,
        priority: target.object.preset_id !== null ? 150 : 100 - 50 * (revealRank.indexOf(target.object) + 1) / (revealRank.length + 1),
      })),
    ];
    const planetCandidates = candidates.slice(0, scene.planets.length);
    const targetCandidates = candidates.slice(scene.planets.length);
    candidates.sort((a, b) => b.priority - a.priority || a.index - b.index);
    const hitRectsForPlanet = { left: 0, right: 0, top: 0, bottom: 0 };
    const labelGrid = new RectGrid(candidates);
    const hitRects = scene.targets.map(() => ({ left: 0, right: 0, top: 0, bottom: 0 }));
    const hitGrid = new RectGrid(hitRects);
    const markerRects = scene.targets.map(() => ({ left: 0, right: 0, top: 0, bottom: 0 }));
    const markerGrid = new RectGrid(markerRects);
    const labelRect = { left: 0, right: 0, top: 0, bottom: 0 };
    const near = new Int32Array(NEAR_COUNT);
    const nearDistance = new Float64Array(NEAR_COUNT);
    const coarsePointer = window.matchMedia("(pointer: coarse)");
    let revealing = false;
    let selected = -1;
    let selectedPlanet = -1;
    const planetNear = new Uint8Array(scene.planets.length);
    const EARTH = 2;
    const targetLabels = scene.targets.map(() => ({
      width: 0, height: 0, x: 0, y: 0, edge: false, angle: 0, chosen: false, opacity: 0, left: false,
      forced: false, leader: false, placement: 0,
      normal: document.createElement("canvas"), highlight: document.createElement("canvas"),
      normalLeft: document.createElement("canvas"), highlightLeft: document.createElement("canvas"),
    }));
    const text1 = tokenRgb("--text-1");
    const accent = tokenRgb("--accent");
    const markerColor = rgba(text1, 0.85);
    const ringColor = rgba(text1, 0.5);
    const leaderColor = rgba(text1, 0.45);
    const highlightColor = rgba(text1, 1);
    const edgeColor = rgba(accent, 0.55);
    const presetEdgeColor = rgba(accent, 1);
    let hovered = -1;
    let markerScale = 1;
    let pointerX = NaN, pointerY = NaN;
    let pointerOnCanvas = false;
    const setHovered = (index: number) => {
      if (hovered === index) return;
      hovered = index;
      holdRef.current = hovered >= 0 || selected >= 0 || selectedPlanet >= 0 || focusedRef.current !== null;
      canvas.style.cursor = index >= 0 ? "pointer" : "";
      dirty = true;
      scheduleFrame();
    };
    const hitTest = (x: number, y: number) => activeRef.current && !flightIsActive()
      ? hitGrid.hit(x, y) : -1;
    const rebuildLabels = (dpr: number) => {
      const style = getComputedStyle(canvas);
      const font = style.fontFamily;
      const mobile = width < 769;
      const maxWidth = Math.min(240, width * 0.6);
      for (let index = 0; index < scene.targets.length; index++) {
        const label = targetLabels[index];
        const name = scene.targets[index].object.name.toUpperCase();
        const kind = scene.targets[index].object.kind.replaceAll("_", " ").toUpperCase();
        context.font = `600 14px ${font}`;
        context.letterSpacing = "4.2px";
        const nameWidth = context.measureText(name).width;
        context.font = `600 10px ${font}`;
        context.letterSpacing = "3px";
        label.width = Math.min(maxWidth, Math.max(nameWidth, mobile ? 0 : context.measureText(kind).width));
        label.height = mobile ? 20.3 : 35.8;
        for (const variant of [0, 1, 2, 3]) {
          const highlighted = variant % 2 === 1;
          const left = variant >= 2;
          const sprite = left ? (highlighted ? label.highlightLeft : label.normalLeft)
            : highlighted ? label.highlight : label.normal;
          sprite.width = Math.ceil((label.width + 20) * dpr);
          sprite.height = Math.ceil((label.height + 20) * dpr);
          const ctx = sprite.getContext("2d")!;
          ctx.scale(dpr, dpr);
          ctx.textBaseline = "top";
          ctx.textAlign = left ? "right" : "left";
          ctx.beginPath();
          ctx.rect(10, 0, label.width, label.height + 20);
          ctx.clip();
          const drawText = (text: string, size: number, y: number) => {
            ctx.font = `600 ${size}px ${font}`;
            ctx.letterSpacing = `${size * 0.3}px`;
            let fitted = text;
            while (ctx.measureText(fitted).width > label.width && fitted.length > 1) fitted = fitted.slice(0, -2) + "…";
            ctx.fillText(fitted, left ? label.width + 10 : 10, y);
          };
          ctx.fillStyle = rgba(text1, highlighted ? 1 : 0.75);
          ctx.shadowColor = style.getPropertyValue("--space-0");
          ctx.shadowBlur = 8;
          // Two passes thicken the dark halo so names stay legible over stars and orbits.
          drawText(name, 14, 14);
          drawText(name, 14, 14);
          if (!mobile) {
            ctx.fillStyle = rgba(text2, 1);
            drawText(kind, 10, 34.3);
          }
        }
      }
      context.letterSpacing = "0px";
    };
    const textWidths = new Map<string, number>();
    let targetDist = cam.current.dist;
    let viewGlide: { start: number; from: Camera; to: Camera } | null = null;

    let disposed = false;
    let width = 0;
    let height = 0;
    let focalLength = 1;
    let dirty = true;
    let sceneBox = { left: 0, top: 0, width: 0, height: 0 };
    let scheduleFrame = () => undefined;
    let bitmapDpr = 0;
    const starfield = cacheStarfield(() => { dirty = true; scheduleFrame(); }, { axes: scene.galaxy, color: star });
    void loadStarfield().then((field) => {
      if (disposed || !field) return;
      starfield.paint({ field });
      dirty = true;
      scheduleFrame();
    });
    const resize = () => {
      if (disposed || !wrap.isConnected) return;
      const wrapBox = wrap.getBoundingClientRect();
      const anchorBox = anchor.getBoundingClientRect();
      const dpr = (window.devicePixelRatio || 1);
      width = wrapBox.width;
      height = wrapBox.height;
      sceneBox = {
        left: anchorBox.left - wrapBox.left,
        top: anchorBox.top - wrapBox.top,
        width: anchorBox.width,
        height: anchorBox.height,
      };
      focalLength = height / (2 * Math.tan(FOV_RADIANS / 2));
      starfield.paint({ width, height, dpr });
      const pixelWidth = Math.round(width * dpr);
      const pixelHeight = Math.round(height * dpr);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight || bitmapDpr !== dpr) {
        markFlight("orrery-resize");
        if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
        if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        bitmapDpr = dpr;
      }
      labelGrid.resize(width, height);
      hitGrid.resize(width, height);
      markerGrid.resize(width, height);
      rebuildLabels(dpr);
      textWidths.clear();
      dirty = true;
      scheduleFrame();
    };
    resize();
    void document.fonts.ready.then(() => { if (!disposed) resize(); });
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(wrap);
    resizeObserver.observe(anchor);

    let trigYaw = NaN;
    let trigPitch = NaN;
    let cy = 1, sy = 0, cp = 1, sp = 0;
    const rotated = { x: 0, y: 0, z: 0 };
    const cameraTrig = (camera: Camera) => {
      if (trigYaw === camera.yaw && trigPitch === camera.pitch) return;
      trigYaw = camera.yaw;
      trigPitch = camera.pitch;
      cy = Math.cos(camera.yaw);
      sy = Math.sin(camera.yaw);
      cp = Math.cos(camera.pitch);
      sp = Math.sin(camera.pitch);
    };
    const rotate = (vector: Vec3, camera: Camera) => {
      const x = vector[0];
      const y = vector[1];
      const z = vector[2];
      cameraTrig(camera);
      const x1 = x * cy - y * sy;
      const y1 = x * sy + y * cy;
      rotated.x = x1;
      rotated.y = y1 * cp - z * sp;
      rotated.z = y1 * sp + z * cp;
      return rotated;
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

    const projectSky = (vector: Vec3, camera: Camera, output?: Projection) => {
      const rotated = rotate(vector, camera);
      const result = output ?? { x: 0, y: 0, depth: 0, front: false };
      result.x = sceneBox.left + sceneBox.width / 2 + focalLength * rotated.x / rotated.y;
      result.y = sceneBox.top + sceneBox.height / 2 - focalLength * rotated.z / rotated.y;
      result.depth = rotated.y;
      result.front = false;
      return result;
    };

    const projectTarget = (target: (typeof scene.targets)[number], camera: Camera, output?: Projection): Projection =>
      target.hasDistance ? projectScene(target.pos, camera, output) : projectSky(target.direction, camera, output);

    const trailPoint = { x: 0, y: 0, depth: 0, front: false };
    const drawOrbit = (index: number, T: number, camera: Camera) => {
      const orbit = scene.orbits[index];
      const phase = (meanAnomaly(PLANETS[index], T) - meanAnomaly(PLANETS[index], scene.orbitTime)) / (2 * Math.PI) * ORBIT_STEPS;
      let previousX = planetProjection[index].x;
      let previousY = planetProjection[index].y;
      let previousDepth = planetProjection[index].depth;
      let band = -1;
      context.lineWidth = 1;
      // Walk backwards in mean anomaly: the bright end always trails the planet.
      for (let step = 0; step < ORBIT_STEPS; step++) {
        const distance = phase - Math.floor(phase) + step;
        const nextBand = Math.min(TRAIL_BANDS - 1, Math.floor(distance / ORBIT_STEPS * TRAIL_BANDS));
        if (nextBand !== band) {
          if (band >= 0) context.stroke();
          context.beginPath();
          band = nextBand;
          context.strokeStyle = trailColors[index][band];
        }
        const sample = ((Math.floor(phase) - step) % ORBIT_STEPS + ORBIT_STEPS) % ORBIT_STEPS;
        const point = projectScene(orbit[sample], camera, trailPoint);
        if (point.depth > 0.05 && previousDepth > 0.05) {
          context.moveTo(previousX, previousY);
          context.lineTo(point.x, point.y);
        }
        previousX = point.x;
        previousY = point.y;
        previousDepth = point.depth;
      }
      context.stroke();
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
      if (!activeRef.current || flightIsActive()) return;
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

    /**
     * Place target `index`'s label: 0 beside the anchor (right, or left near the edge),
     * 1 the other side, 2 above and 3 below with a leader.
     */
    const placeLabel = (index: number, placement: number, scale: number) => {
      const label = targetLabels[index];
      const point = targetProjection[index];
      const w = label.width * scale, h = label.height * scale, gap = LABEL_GAP * scale;
      const rightFirst = point.x + gap + w <= width - 16;
      if (placement < 2) {
        label.left = placement === 0 ? !rightFirst : rightFirst;
        label.x = Math.max(16, Math.min(width - 16 - w, label.left ? point.x - gap - w : point.x + gap));
        label.y = point.y;
      } else {
        label.left = false;
        label.x = Math.max(16, Math.min(width - 16 - w, point.x - 6 * scale));
        label.y = point.y + (placement === 2 ? -1 : 1) * ((RING + 10) * scale + h / 2);
      }
      label.leader = placement >= 2;
      // Label box only: anchors are kept clear through the marker grid, not by blocking planets.
      const candidate = targetCandidates[index];
      candidate.left = label.x;
      candidate.right = label.x + w;
      candidate.top = label.y - h / 2;
      candidate.bottom = label.y + h / 2;
    };
    /** Is the placed label of `index` clear of every anchor but its own? */
    const clearOfAnchors = (index: number, scale: number, clearance: number) => {
      const label = targetLabels[index];
      labelRect.left = label.x;
      labelRect.right = label.x + label.width * scale;
      labelRect.top = label.y - label.height / 2 * scale;
      labelRect.bottom = label.y + label.height / 2 * scale;
      return !markerGrid.overlaps(labelRect, clearance);
    };
    /**
     * Try the label's previous placement first, then the others below `limit`: first a spot clear
     * of labels and anchors, then (unless `strict`) one clear of labels only. Returns false when none fits.
     */
    const placeTarget = (index: number, limit: number, clearance: number, strict: boolean, scale: number) => {
      const label = targetLabels[index];
      const candidate = targetCandidates[index];
      const previous = Math.min(label.placement, limit - 1);
      for (let pass = 0; pass < (strict ? 1 : 2); pass++) {
        for (let k = -1; k < limit; k++) {
          if (k === previous) continue;
          const placement = k < 0 ? previous : k;
          placeLabel(index, placement, scale);
          labelRect.left = label.x;
          labelRect.right = label.x + label.width * scale;
          labelRect.top = label.y - label.height / 2 * scale;
          labelRect.bottom = label.y + label.height / 2 * scale;
          if (labelRect.top < 12 || labelRect.bottom > height - 12 || labelGrid.overlaps(candidate, clearance)) continue;
          if (strict && !labelInBounds(labelRect)) continue;
          if (pass === 0 && !clearOfAnchors(index, scale, strict ? 4 : 0)) continue;
          label.placement = placement;
          return true;
        }
      }
      placeLabel(index, previous, scale);
      return false;
    };
    const labelInBounds = (candidate: { left: number; right: number; top: number; bottom: number }) => candidate.left >= 12 && candidate.right <= width - 12
      && candidate.top >= (width < 769 ? 245 : 200) && candidate.bottom <= height - 60;
    let animationFrame = 0;
    let dragging = false;
    let lastTime = performance.now();
    const frame = (now: number) => {
      animationFrame = 0;
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;
      const time = simulatedTime(now);
      const T = centuries(time);
      tickClock(time);
      if (Math.abs(T - scene.orbitTime) * 36525 >= 1) {
        scene.orbitTime = T;
        scene.orbits.forEach((orbit, index) => orbit.forEach((point, step) => {
          position(PLANETS[index], T, step / ORBIT_STEPS * Math.PI * 2, point);
          mapRadial(point, point);
        }));
      }
      scene.planets.forEach((planet, index) => {
        position(PLANETS[index], T, 0, planet.pos);
        mapRadial(planet.pos, planet.pos);
      });
      if (!reduce) dirty = true;
      holdRef.current = hovered >= 0 || selected >= 0 || selectedPlanet >= 0 || focusedRef.current !== null;
      const camera = cam.current;
      const currentFlight = getFlightSample();

      if (flightIsActive() && currentFlight) {
        Object.assign(camera, currentFlight.camera);
        targetDist = camera.dist;
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
        if (activeRef.current && !reduce && !dragging && !holdRef.current) {
          camera.yaw += dt * 0.025;
          dirty = true;
        }
        if (activeRef.current) saveHomeCamera(flightCamera(camera));
      }

      if (!dirty) {
        if (activeRef.current && !reduce) scheduleFrame();
        return;
      }
      dirty = false;
      context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
      context.globalAlpha = camera.fade;
      cameraTrig(camera);
      const centerX = sceneBox.left + sceneBox.width / 2;
      const centerY = sceneBox.top + sceneBox.height / 2;
      starfield.paint({ ...camera, x: centerX, y: centerY, focal: focalLength });
      if (!starfield.draw(context)) context.clearRect(0, 0, width, height);
      drawSkyLine(scene.ecliptic, camera, text2, 0.16);

      scene.planets.forEach((planet, index) => projectScene(planet.pos, camera, planetProjection[index]));
      scene.orbits.forEach((_, index) => drawOrbit(index, T, camera));
      const sunPoint = projectScene([0, 0, 0], camera);
      const sunRadius = Math.min(26, Math.max(10, 18 * DEFAULT_DIST / camera.dist));
      context.drawImage(sunSprite, sunPoint.x - sunRadius, sunPoint.y - sunRadius, sunRadius * 2, sunRadius * 2);

      const labelScale = Math.min(1.5, Math.max(1, Math.sqrt(DEFAULT_DIST / camera.dist)));
      markerScale = labelScale;
      labelGrid.clear();
      hitGrid.clear();
      scene.planets.forEach((planet, index) => {
        const projected = projectScene(planet.pos, camera, planetProjection[index]);
        const label = planetLabels[index];
        const cacheKey = label;
        context.font = "600 12px 'Manrope Variable', Manrope, system-ui, sans-serif";
        let textWidth = textWidths.get(cacheKey);
        if (textWidth === undefined) {
          textWidth = context.measureText(label).width;
          textWidths.set(cacheKey, textWidth);
        }
        const dx = projected.x - sunPoint.x;
        const dy = projected.y - sunPoint.y;
        const innermost = index < 2;
        const horizontal = !innermost && Math.abs(dx) > Math.abs(dy) * 0.65;
        const align: CanvasTextAlign = horizontal ? (dx >= 0 ? "left" : "right") : "center";
        const labelX = horizontal ? projected.x + (dx >= 0 ? 12 : -12) * labelScale : projected.x;
        let labelY = innermost
          ? projected.y + (index === 0 ? -22 : 22) * labelScale
          : horizontal
            ? projected.y - 5 * labelScale
            : projected.y + (dy >= 0 ? 15 : -15) * labelScale;
        const scaledWidth = textWidth * labelScale;
        const rawLeft = align === "left" ? labelX : align === "right" ? labelX - scaledWidth : labelX - scaledWidth / 2;
        let left = Math.max(12, Math.min(width - 12 - scaledWidth, rawLeft));
        if (Number.isFinite(labelOffsetX[index])) {
          left = projected.x + labelOffsetX[index] * labelScale;
          labelY = projected.y + labelOffsetY[index] * labelScale;
        }
        planetLabelX[index] = left;
        planetLabelY[index] = labelY;
        planetLabelAlign[index] = "left";
        const candidate = planetCandidates[index];
        candidate.left = left;
        candidate.right = left + scaledWidth;
        candidate.top = labelY - 9 * labelScale;
        candidate.bottom = labelY + 9 * labelScale;
        candidate.visible = projected.depth > 0.05 && projected.x > 16 && projected.x < width - 16 && projected.y > 200 && projected.y < height - 60;
      });

      const flight = getFlightSample();
      const flying = flightIsActive();
      markerGrid.clear();
      for (let index = 0; index < scene.targets.length; index++) {
        const target = scene.targets[index];
        const raw = projectTarget(target, camera, targetProjection[index]);
        let markerX = raw.x;
        let markerY = raw.y;
        // Viewport edges inset past the chrome (panel, step guide and title, zoom column, clock):
        // a point outside this frame becomes a notch on it, pointing toward the point.
        const mobileFrame = width < 769;
        const leftMargin = mobileFrame ? 12 : 316;
        const rightMargin = mobileFrame ? 12 : 72;
        const topMargin = mobileFrame ? 120 : 150;
        const bottomMargin = mobileFrame ? 150 : 44;
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
          edgeAngle = Math.atan2(dy, dx);
        }
        const chosen = flying && flight !== null
          && (target.object.preset_id ?? target.object.id) === flight.targetId;
        if (chosen && flight) {
          markerX = flight.pose.x;
          markerY = flight.pose.y;
        }
        raw.x = markerX;
        raw.y = markerY;
        const label = targetLabels[index];
        label.edge = edge;
        label.angle = edgeAngle;
        label.chosen = chosen;
        const marker = markerRects[index];
        marker.left = markerX - HIT_HALF * labelScale;
        marker.right = markerX + HIT_HALF * labelScale;
        marker.top = markerY - HIT_HALF * labelScale;
        marker.bottom = markerY + HIT_HALF * labelScale;
        if (!chosen) markerGrid.insert(index);
      }

      // Proximity labels: the nearest checked points around a fine pointer, never on touch layouts.
      const touchLayout = width < 769 || coarsePointer.matches;
      const proximity = pointerOnCanvas && !touchLayout && !dragging && activeRef.current && !flying;
      let nearCount = proximity ? markerGrid.nearest(pointerX, pointerY, NEAR_RADIUS, near, nearDistance) : 0;
      revealing = camera.dist <= DEFAULT_DIST * (revealing ? REVEAL_OUT : REVEAL_IN);
      // Planets other than Earth are named like catalog points: proximity (sharing the nearest
      // two, coded as -(planet + 1)), a first tap, or the zoom reveal, where they come first.
      if (proximity) {
        for (let planet = 0; planet < scene.planets.length; planet++) {
          const point = planetProjection[planet];
          if (planet === EARTH || point.depth < 0.05) continue;
          const dx = point.x - pointerX, dy = point.y - pointerY;
          const distance = dx * dx + dy * dy;
          if (distance > NEAR_RADIUS * NEAR_RADIUS) continue;
          let slot = nearCount;
          if (slot === NEAR_COUNT) {
            if (distance >= nearDistance[slot - 1]) continue;
            slot--;
          } else nearCount++;
          while (slot > 0 && nearDistance[slot - 1] > distance) {
            near[slot] = near[slot - 1];
            nearDistance[slot] = nearDistance[slot - 1];
            slot--;
          }
          near[slot] = -(planet + 1);
          nearDistance[slot] = distance;
        }
      }
      planetNear.fill(0);
      for (let k = 0; k < nearCount; k++) if (near[k] < 0) planetNear[-near[k] - 1] = 1;
      if (selectedPlanet >= 0) planetNear[selectedPlanet] = 1;
      for (let planet = 0; planet < scene.planets.length; planet++) {
        const candidate = planetCandidates[planet];
        candidate.visible = candidate.visible && (planet === EARTH || revealing || planetNear[planet] === 1);
      }
      for (let index = 0; index < scene.targets.length; index++) {
        const label = targetLabels[index];
        const object = scene.targets[index].object;
        let forced = index === hovered || index === selected || object.id === focusedRef.current;
        for (let k = 0; k < nearCount; k++) if (near[k] === index) forced = true;
        label.forced = forced && !label.chosen;
        placeLabel(index, label.placement, labelScale);
        targetCandidates[index].visible = !label.chosen
          && (label.forced || (!label.edge && (object.preset_id !== null || revealing)));
      }

      // Labels the user asked for first, then planets, then pinned challenge targets and zoom reveals.
      for (let phase = 0; phase < 3; phase++) {
        for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
          const candidate = candidates[candidateIndex];
          if (!candidate.visible) continue;
          const isPlanet = candidate.type === "planet";
          const forced = !isPlanet && targetLabels[candidate.index].forced;
          const first = forced || (isPlanet && (candidate.index === EARTH || planetNear[candidate.index] === 1));
          if ((first ? 0 : isPlanet ? 1 : 2) !== phase) continue;
          if (isPlanet) {
            // Extra clearance before a hidden label returns prevents boundary flicker.
            const clearance = planetLabelOpacity[candidate.index] < 0.5 ? 10 : 6;
            if (labelGrid.overlaps(candidate, clearance) || !labelInBounds(candidate)) {
              const point = planetProjection[candidate.index];
              const w = (candidate.right - candidate.left) / labelScale;
              // Try nearby label positions before fading a lower-priority name.
              for (const [dx, dy] of labelOffsets) {
                candidate.left = point.x + (dx < 0 ? dx - w : dx === 0 ? -w / 2 : dx) * labelScale;
                candidate.right = candidate.left + w * labelScale;
                candidate.top = point.y + dy * labelScale - 9 * labelScale;
                candidate.bottom = candidate.top + 18 * labelScale;
                if (!labelInBounds(candidate)) continue;
                if (!labelGrid.overlaps(candidate, clearance)) {
                  planetLabelX[candidate.index] = candidate.left;
                  planetLabelY[candidate.index] = (candidate.top + candidate.bottom) / 2;
                  planetLabelAlign[candidate.index] = "left";
                  break;
                }
              }
            }
            candidate.visible = !labelGrid.overlaps(candidate, clearance) && labelInBounds(candidate);
            if (candidate.visible) {
              labelGrid.insert(candidateIndex);
              const point = planetProjection[candidate.index];
              labelOffsetX[candidate.index] = (planetLabelX[candidate.index] - point.x) / labelScale;
              labelOffsetY[candidate.index] = (planetLabelY[candidate.index] - point.y) / labelScale;
            }
            continue;
          }
          const index = candidate.index;
          const label = targetLabels[index];
          const shown = label.opacity >= 0.5;
          if (forced) {
            // A requested name always shows; it moves (with a leader) before it covers another label.
            if (!placeTarget(index, 4, 2, false, labelScale)) placeLabel(index, label.placement, labelScale);
          } else if (scene.targets[index].object.preset_id !== null) {
            candidate.visible = placeTarget(index, 4, shown ? 4 : 10, false, labelScale);
          } else {
            // Revealed catalog names stay beside their anchor, in bounds and clear of other anchors.
            candidate.visible = placeTarget(index, 2, shown ? 6 : 16, true, labelScale);
          }
          if (candidate.visible) labelGrid.insert(candidateIndex);
        }
      }

      context.textBaseline = "middle";
      scene.planets.forEach((planet, index) => {
        const projected = planetProjection[index];
        if (projected.depth < 0.05) return;
        const earth = planet.name === "Earth";
        const radius = planetSizes[index] * Math.min(1.4, Math.max(0.85, (DEFAULT_DIST / projected.depth) ** 0.2));
        const point = rotate(planet.pos, camera);
        const length = Math.hypot(point.x, point.y, point.z);
        const depth = point.y + camera.dist;
        const horizontal = Math.hypot(point.x, depth);
        const viewLength = Math.hypot(horizontal, point.z);
        const lightX = -point.x * camera.dist / (length * horizontal);
        const lightY = -point.z * depth * camera.dist / (length * horizontal * viewLength);
        const lightZ = (length * length + point.y * camera.dist) / (length * viewLength);
        const phase = Math.round((Math.max(-1, Math.min(1, lightZ)) + 1) * PHASE_STEPS / 2);
        if (index === 5) {
          context.strokeStyle = rgba(planetColor[index], 0.65);
          context.lineWidth = 1;
          context.beginPath();
          context.ellipse(projected.x, projected.y, radius * 1.85, radius * 0.65, -0.4, Math.PI, Math.PI * 2);
          context.stroke();
        }
        context.save();
        context.translate(projected.x, projected.y);
        context.rotate(Math.atan2(-lightY, lightX));
        context.drawImage(sprites[index], phase * SPRITE_SIZE, 0, SPRITE_SIZE, SPRITE_SIZE, -radius, -radius, radius * 2, radius * 2);
        context.restore();
        if (index === 5 || earth) {
          context.strokeStyle = rgba(planetColor[index], 0.8);
          context.lineWidth = 1;
          context.beginPath();
          if (earth) context.arc(projected.x, projected.y, radius + 4, 0, Math.PI * 2);
          else context.ellipse(projected.x, projected.y, radius * 1.85, radius * 0.65, -0.4, 0, Math.PI);
          context.stroke();
        }
        const candidate = planetCandidates[index];
        const desired = candidate?.visible ? 1 : 0;
        const fade = Math.min(1, dt / 0.15);
        planetLabelOpacity[index] = reduce ? desired : planetLabelOpacity[index] + (desired - planetLabelOpacity[index]) * fade;
        if (!reduce && Math.abs(desired - planetLabelOpacity[index]) > 0.01) dirty = true;
        if (planetLabelOpacity[index] < 0.01) return;
        if (!candidate.visible) {
          const labelWidth = (textWidths.get(planetLabels[index]) ?? 0) * labelScale;
          const labelX = planetLabelX[index];
          const labelY = planetLabelY[index];
          const rect = hitRectsForPlanet;
          rect.left = labelX;
          rect.right = labelX + labelWidth;
          rect.top = labelY - 9 * labelScale;
          rect.bottom = labelY + 9 * labelScale;
          if (labelGrid.overlaps(rect, 0)) return;
        }
        context.font = `600 ${12 * labelScale}px 'Manrope Variable', Manrope, system-ui, sans-serif`;
        context.textAlign = planetLabelAlign[index];
        context.fillStyle = rgba(star, planetLabelOpacity[index] * 0.95);
        const label = planetLabels[index];
        context.fillText(label, planetLabelX[index], planetLabelY[index]);
      });
      context.textAlign = "left";

      // Anchors: a hairline ring with a centre dot; off-screen points become edge notches.
      context.lineWidth = 1;
      for (let pass = 0; pass < 2; pass++) {
        context.beginPath();
        for (let index = 0; index < scene.targets.length; index++) {
          const label = targetLabels[index];
          if (label.chosen) continue;
          const highlighted = index === hovered || index === selected || scene.targets[index].object.id === focusedRef.current;
          if (pass === 0 ? highlighted || label.edge : !highlighted) continue;
          const point = targetProjection[index];
          const radius = (pass === 1 ? RING_HIGHLIGHT : RING) * labelScale;
          context.moveTo(point.x + radius, point.y);
          context.arc(point.x, point.y, radius, 0, Math.PI * 2);
        }
        context.strokeStyle = pass === 1 ? highlightColor : ringColor;
        context.stroke();
      }
      context.beginPath();
      for (let index = 0; index < scene.targets.length; index++) {
        const point = targetProjection[index], label = targetLabels[index];
        if (label.chosen) continue;
        // Challenge-target notches read a step stronger, so the featured five stay findable off-screen.
        const radius = (label.edge ? scene.targets[index].object.preset_id !== null ? NOTCH_DOT * 1.4 : NOTCH_DOT : DOT) * labelScale;
        context.moveTo(point.x + radius, point.y);
        context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      }
      context.fillStyle = markerColor;
      context.fill();
      for (let pass = 0; pass < 2; pass++) {
        context.beginPath();
        for (let index = 0; index < scene.targets.length; index++) {
          const point = targetProjection[index], label = targetLabels[index];
          if (label.chosen || !label.edge || (scene.targets[index].object.preset_id !== null) !== (pass === 1)) continue;
          const dx = Math.cos(label.angle), dy = Math.sin(label.angle);
          const length = pass === 1 ? 13 : 10;
          context.moveTo(point.x + dx * 4 * labelScale, point.y + dy * 4 * labelScale);
          context.lineTo(point.x + dx * length * labelScale, point.y + dy * length * labelScale);
        }
        context.strokeStyle = pass === 1 ? presetEdgeColor : edgeColor;
        context.stroke();
      }
      const fadeStep = Math.min(1, dt / 0.12);
      for (let index = 0; index < scene.targets.length; index++) {
        const label = targetLabels[index];
        const highlighted = index === hovered || index === selected || scene.targets[index].object.id === focusedRef.current;
        const desired = targetCandidates[index].visible ? 1 : 0;
        label.opacity = reduce ? desired : label.opacity + (desired - label.opacity) * fadeStep;
        if (Math.abs(desired - label.opacity) < 0.01) label.opacity = desired;
        else dirty = true;
        if (!label.chosen && label.opacity > 0) {
          context.globalAlpha = camera.fade * label.opacity;
          if (label.leader) {
            const point = targetProjection[index];
            const above = label.y < point.y;
            const endX = Math.max(label.x, Math.min(label.x + label.width * labelScale, point.x));
            context.beginPath();
            context.moveTo(point.x, point.y + (above ? -1 : 1) * (RING + 1) * labelScale);
            context.lineTo(endX, label.y + (above ? 1 : -1) * (label.height / 2 - 2) * labelScale);
            context.strokeStyle = leaderColor;
            context.stroke();
          }
          const sprite = label.left ? (highlighted ? label.highlightLeft : label.normalLeft)
            : highlighted ? label.highlight : label.normal;
          context.drawImage(sprite, label.x - 10 * labelScale, label.y - (label.height / 2 + 10) * labelScale,
            sprite.width / bitmapDpr * labelScale, sprite.height / bitmapDpr * labelScale);
        }
        const rect = hitRects[index];
        const marker = markerRects[index];
        rect.left = marker.left;
        rect.right = marker.right;
        rect.top = marker.top;
        rect.bottom = marker.bottom;
        if (targetCandidates[index].visible) {
          rect.left = Math.min(rect.left, label.x);
          rect.right = Math.max(rect.right, label.x + label.width * labelScale);
          rect.top = Math.min(rect.top, label.y - label.height / 2 * labelScale);
          rect.bottom = Math.max(rect.bottom, label.y + label.height / 2 * labelScale);
        }
        if (!label.chosen) hitGrid.insert(index);
      }
      if (!dragging) setHovered(pointerOnCanvas ? hitTest(pointerX, pointerY) : -1);
      context.globalAlpha = 1;

      const moving = flightIsActive() || viewGlide || Math.abs(targetDist - camera.dist) > 0.001;
      if ((activeRef.current && !reduce) || moving) scheduleFrame();
    };

    scheduleFrame = () => {
      if (!flightIsActive() && !animationFrame) animationFrame = requestAnimationFrame(frame);
    };
    wakeRef.current = () => { dirty = true; scheduleFrame(); };
    scheduleFrame();
    const unsubscribe = subscribeFlight((sample) => {
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      frame(sample.now);
    });
    const unregisterNavigation = registerHomeNavigation({
      pick: (id) => {
        const index = visibleTargets.findIndex((target) => (target.id === id || target.preset_id === id));
        if (index < 0) return false;
        pickRef.current(index);
        return true;
      },
      locate: (id) => {
        const target = scene.targets.find((target) => (target.object.id === id || target.object.preset_id === id));
        if (!target) return null;
        const projected = projectTarget(target, getHomeCamera());
        return { x: projected.x, y: projected.y, side: 20 };
      },
    });

    pickRef.current = (index) => {
      const target = scene.targets[index];
      if (!activeRef.current || flightIsActive() || !target) return;
      const camera = cam.current;
      const point = targetProjection[index];
      const x = point.x, y = point.y;
      const direction = target.direction;
      let yaw = Math.atan2(direction[0], direction[1]);
      while (yaw - camera.yaw > Math.PI) yaw -= 2 * Math.PI;
      while (camera.yaw - yaw > Math.PI) yaw += 2 * Math.PI;
      const pitch = Math.atan2(-direction[2], Math.hypot(direction[0], direction[1]));
      onFlightStartRef.current?.(target.object);
      const flight = startTargetFlight(target.object.preset_id ?? target.object.id, flightCamera(camera), { yaw, pitch }, { x, y, side: 20 * markerScale });
      markFlight("commit");
      onPickRef.current(target.object, { x, y });
      selected = -1;
      setHovered(-1);
      void flight.then(() => onFlightEndRef.current?.());
    };

    tickClock(simulatedTime(performance.now()));
    const clock = window.setInterval(() => {
      // A visible moving scene publishes its date in the same frame as its positions.
      if (reduce || (!activeRef.current && !flightIsActive())) tickClock(simulatedTime(performance.now()));
    }, 1000);
    const motionChange = () => {
      reduce = motionPreference.matches;
      timeRef.current = { epoch: Date.now(), start: performance.now() };
      dirty = true;
      scheduleFrame();
    };
    motionPreference.addEventListener("change", motionChange);

    const pointers = new Map<number, { x: number; y: number }>();
    let previousX = 0;
    let previousY = 0;
    let previousPinch = 0;
    let pendingPick = -1;
    let downOnCanvas = false;
    let downX = 0, downY = 0;
    let moved = false;
    const interactive = (target: EventTarget | null) => target instanceof Element
      && Boolean(target.closest('button, a, input, select, textarea, [role="button"], [role="slider"], [role="dialog"], [contenteditable="true"]'));

    const pointerDown = (event: PointerEvent) => {
      if (!activeRef.current || flightIsActive() || interactive(event.target) || event.shiftKey) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      viewGlide = null;
      pointerX = event.clientX;
      pointerY = event.clientY;
      pointerOnCanvas = event.target === canvas;
      pendingPick = pointerOnCanvas ? hitTest(pointerX, pointerY) : -1;
      downOnCanvas = pointerOnCanvas;
      downX = pointerX;
      downY = pointerY;
      moved = false;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointerOnCanvas) canvas.setPointerCapture(event.pointerId);
      dragging = true;
      previousX = event.clientX;
      previousY = event.clientY;
      wrap.dataset.dragging = "true";
      if (pointers.size === 2) {
        pendingPick = -1;
        moved = true;
        const pair = [...pointers.values()];
        previousPinch = Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y);
      }
    };

    const pointerMove = (event: PointerEvent) => {
      pointerOnCanvas = event.target === canvas;
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (!pointers.has(event.pointerId)) {
        setHovered(pointerOnCanvas ? hitTest(pointerX, pointerY) : -1);
        // Proximity labels follow the pointer; a reduced-motion scene only redraws on demand.
        if (reduce && activeRef.current) {
          dirty = true;
          scheduleFrame();
        }
        return;
      }
      if (flightIsActive()) return;
      if (!moved && Math.hypot(pointerX - downX, pointerY - downY) < 5) return;
      moved = true;
      pendingPick = -1;
      setHovered(-1);
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

    // Touch and narrow layouts: the first tap names and highlights a point, a second tap flies.
    const tap = (event: PointerEvent, pending: number) => {
      if (!activeRef.current || flightIsActive()) return;
      if (event.pointerType === "mouse" && width >= 769 && !coarsePointer.matches) {
        if (pending >= 0 && pending === hitTest(event.clientX, event.clientY)) pickRef.current(pending);
        return;
      }
      let index = hitTest(event.clientX, event.clientY);
      if (index < 0 && markerGrid.nearest(event.clientX, event.clientY, TAP_RADIUS, near, nearDistance) > 0) index = near[0];
      if (index >= 0 && index === selected) {
        pickRef.current(index);
        return;
      }
      selected = index;
      selectedPlanet = -1;
      if (index < 0) {
        // A tap near a planet names it (planets have no flight of their own).
        let best = TAP_RADIUS * TAP_RADIUS;
        for (let planet = 0; planet < scene.planets.length; planet++) {
          const point = planetProjection[planet];
          const distance = (point.x - event.clientX) ** 2 + (point.y - event.clientY) ** 2;
          if (planet !== EARTH && point.depth >= 0.05 && distance < best) {
            best = distance;
            selectedPlanet = planet;
          }
        }
      }
      holdRef.current = hovered >= 0 || selected >= 0 || selectedPlanet >= 0 || focusedRef.current !== null;
      dirty = true;
      scheduleFrame();
    };

    const pointerLeave = () => {
      pointerOnCanvas = false;
      if (!dragging) setHovered(-1);
      dirty = true;
      scheduleFrame();
    };

    const pointerUp = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      const tapped = !moved && pointers.size === 1 && event.type !== "pointercancel" && downOnCanvas;
      const pending = pendingPick;
      pendingPick = -1;
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
        if (tapped) tap(event, pending);
      }
    };

    const wheel = (event: WheelEvent) => {
      if (!activeRef.current || interactive(event.target) || flightIsActive()) return;
      event.preventDefault();
      const sensitivity = event.ctrlKey ? 0.003 : 0.0015;
      zoomBy(Math.exp(Math.max(-150, Math.min(150, event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1))) * sensitivity));
    };

    const keydown = (event: KeyboardEvent) => {
      const editing = event.target instanceof Element && event.target.closest('input, select, textarea, [role="dialog"], [contenteditable="true"]');
      if (!activeRef.current || editing || event.metaKey || event.ctrlKey || event.altKey || flightIsActive()) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomBy(0.8);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomBy(1.2);
      } else if (event.key === "0") {
        event.preventDefault();
        timeRef.current = { epoch: Date.now(), start: performance.now() };
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
    canvas.addEventListener("pointerleave", pointerLeave);
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", keydown);
    window.addEventListener("spherex:orrery-zoom", zoomControl);

    return () => {
      disposed = true;
      starfield.dispose();
      unsubscribe();
      unregisterNavigation();
      delete wrap.dataset.dragging;
      wakeRef.current = () => undefined;
      pickRef.current = () => undefined;
      canvas.style.cursor = "";
      holdRef.current = focusedRef.current !== null;
      cancelAnimationFrame(animationFrame);
      window.clearInterval(clock);
      motionPreference.removeEventListener("change", motionChange);
      resizeObserver.disconnect();
      window.removeEventListener("pointerdown", pointerDown);
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerUp);
      canvas.removeEventListener("pointerleave", pointerLeave);
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("spherex:orrery-zoom", zoomControl);
    };
  }, [visibleTargets]);

  return (
    <>
      <div ref={anchorRef} className={s.anchor}>
        <p className={`${s.hud} mono`}>
          <span>
            <span ref={clockRef} />
          </span>
        </p>
      </div>
      <div ref={wrapRef} className={s.orrery} data-active={active} aria-hidden={!active} inert={!active} aria-label="Solar system and sky targets">
        <canvas ref={canvasRef} className={s.canvas} aria-hidden="true" />
        <ul className={s.accessibleTargets} aria-label="Sky targets">
          {visibleTargets.map((target, index) => (
            <li key={target.id}>
              <button
                type="button"
                onClick={() => pickRef.current(index)}
                onFocus={(event) => {
                  if (!event.currentTarget.matches(":focus-visible")) return;
                  focusedRef.current = target.id;
                  holdRef.current = true;
                  wakeRef.current();
                }}
                onBlur={() => {
                  focusedRef.current = null;
                  holdRef.current = false;
                  wakeRef.current();
                }}
                aria-label={`Fly to ${target.name}`}
              >Fly to {target.name}</button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
