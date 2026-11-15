import { useEffect, useRef } from "react";
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
import { drawStarfield, loadStarfield, type Starfield } from "../../lib/starfield";
import { galacticToEq } from "../../lib/sky";
import { tokenRgb } from "../../lib/stretch";
import type { CatalogObject } from "../../types";
import s from "./Orrery.module.css";

interface OrreryProps {
  targets: readonly CatalogObject[];
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
export function Orrery({ targets, active, onPick, onFlightStart, onFlightEnd }: OrreryProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const markerRefs = useRef<(HTMLElement | null)[]>([]);
  const clockRef = useRef<HTMLSpanElement>(null);
  const wakeRef = useRef<() => void>(() => undefined);
  const activeRef = useRef(active);
  const cam = useRef<Camera>(homeCamera());
  const onPickRef = useRef(onPick);
  const onFlightStartRef = useRef(onFlightStart);
  const onFlightEndRef = useRef(onFlightEnd);
  const holdRef = useRef(false);
  // Preserve time across catalog/effect changes and while the home scene is hidden.
  const timeRef = useRef({ epoch: Date.now(), start: performance.now() });

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
    const scene = getScene(targets);
    const planetProjection = scene.planets.map((): Projection => ({ x: 0, y: 0, depth: 0, front: false }));
    const planetLabelX = scene.planets.map(() => 0);
    const planetLabelY = scene.planets.map(() => 0);
    const planetLabelAlign = scene.planets.map((): CanvasTextAlign => "left");
    const targetProjection = scene.targets.map((): Projection => ({ x: 0, y: 0, depth: 0, front: false }));
    const planetLabelOpacity = scene.planets.map(() => 0);
    const labelOffsetX = scene.planets.map(() => NaN);
    const labelOffsetY = scene.planets.map(() => NaN);
    const labelOffsets: readonly (readonly [number, number])[] = [[12, -18], [-12, -18], [12, 18], [-12, 18], [0, -34], [0, 34]];
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
    let width = 0;
    let height = 0;
    let focalLength = 1;
    let dirty = true;
    let sceneBox = { left: 0, top: 0, width: 0, height: 0 };
    let scheduleFrame = () => undefined;
    let bitmapDpr = 0;
    // Diffuse light needs only a small reusable raster, not full-resolution blur or strokes.
    const galaxyCanvas = document.createElement("canvas");
    const galaxyContext = galaxyCanvas.getContext("2d");
    let galaxyImage: ImageData | null = null;
    let galaxyRays = new Float32Array(0);
    let stars: Starfield | null = null;
    let starProjection = new Float32Array(0);
    void loadStarfield().then((field) => {
      if (disposed || !field) return;
      stars = field;
      starProjection = new Float32Array(field.xyz.length);
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
      if (galaxyContext) {
        const gw = Math.max(1, Math.ceil(width / 16) + 2);
        const gh = Math.max(1, Math.ceil(height / 16) + 2);
        if (galaxyCanvas.width !== gw || galaxyCanvas.height !== gh || !galaxyImage) {
          galaxyCanvas.width = gw;
          galaxyCanvas.height = gh;
          galaxyImage = galaxyContext.createImageData(gw, gh);
          galaxyRays = new Float32Array(gw * gh * 3);
          for (let i = 0; i < gw * gh; i++) {
            galaxyImage.data[i * 4] = star[0];
            galaxyImage.data[i * 4 + 1] = star[1];
            galaxyImage.data[i * 4 + 2] = star[2];
          }
        }
        for (let y = 0; y < gh; y++) {
          for (let x = 0; x < gw; x++) {
            const rx = ((x + 0.5) * (width + 32) / gw - 16 - sceneBox.left - sceneBox.width / 2) / focalLength;
            const rz = (sceneBox.top + sceneBox.height / 2 + 16 - (y + 0.5) * (height + 32) / gh) / focalLength;
            const length = Math.hypot(rx, 1, rz);
            const i = (y * gw + x) * 3;
            galaxyRays[i] = rx / length;
            galaxyRays[i + 1] = 1 / length;
            galaxyRays[i + 2] = rz / length;
          }
        }
      }
      const pixelWidth = Math.round(width * dpr);
      const pixelHeight = Math.round(height * dpr);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight || bitmapDpr !== dpr) {
        markFlight("orrery-resize");
        if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
        if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        bitmapDpr = dpr;
      }
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
      context.clearRect(0, 0, width, height);
      context.globalAlpha = camera.fade;
      cameraTrig(camera);
      const centerX = sceneBox.left + sceneBox.width / 2;
      const centerY = sceneBox.top + sceneBox.height / 2;
      if (galaxyImage && galaxyContext) {
        const centre = rotate(scene.galaxy[0], camera);
        const gx0 = centre.x, gx1 = centre.y, gx2 = centre.z;
        const tangent = rotate(scene.galaxy[1], camera);
        const gy0 = tangent.x, gy1 = tangent.y, gy2 = tangent.z;
        const pole = rotate(scene.galaxy[2], camera);
        const gz0 = pole.x, gz1 = pole.y, gz2 = pole.z;
        const pixels = galaxyImage.data;
        for (let i = 0, pixel = 3; i < galaxyRays.length; i += 3, pixel += 4) {
          const rx = galaxyRays[i], ry = galaxyRays[i + 1], rz = galaxyRays[i + 2];
          const gx = rx * gx0 + ry * gx1 + rz * gx2;
          const gy = rx * gy0 + ry * gy1 + rz * gy2;
          const latitude = rx * gz0 + ry * gz1 + rz * gz2;
          const inner = ((1 + gx) * 0.5) ** 2;
          // Cubic falloff gives an 8 to 15 degree half-width, with zero slope at the edges.
          const support = 0.3 + 0.23 * inner;
          const falloff = Math.max(0, 1 - (latitude / support) ** 2);
          // Decorative, sky-locked mottling, not a survey intensity map.
          const clouds = 0.82 + 0.1 * Math.sin(18 * gy + 7 * gx + 22 * latitude)
            + 0.08 * Math.sin(31 * gy - 13 * gx + 45 * latitude);
          pixels[pixel] = 255 * (0.012 + 0.045 * inner) * falloff ** 3 * clouds;
        }
        galaxyContext.putImageData(galaxyImage, 0, 0);
        context.drawImage(galaxyCanvas, -16, -16, width + 32, height + 32);
      }

      if (stars) {
        const xyz = stars.xyz;
        // Packed projections and canvas paths avoid allocating objects or paths per star/frame.
        for (let i = 0; i < xyz.length; i += 3) {
          const x = xyz[i] * cy - xyz[i + 1] * sy;
          const y = xyz[i] * sy + xyz[i + 1] * cy;
          const depth = y * cp - xyz[i + 2] * sp;
          starProjection[i] = centerX + focalLength * x / depth;
          starProjection[i + 1] = centerY - focalLength * (y * sp + xyz[i + 2] * cp) / depth;
          starProjection[i + 2] = depth;
        }
        drawStarfield(context, stars, starProjection, 3, width, height, camera.fade);
      }
      drawSkyLine(scene.ecliptic, camera, text2, 0.16);

      scene.planets.forEach((planet, index) => projectScene(planet.pos, camera, planetProjection[index]));
      scene.orbits.forEach((_, index) => drawOrbit(index, T, camera));
      const sunPoint = projectScene([0, 0, 0], camera);
      const sunRadius = Math.min(26, Math.max(10, 18 * DEFAULT_DIST / camera.dist));
      context.drawImage(sunSprite, sunPoint.x - sunRadius, sunPoint.y - sunRadius, sunRadius * 2, sunRadius * 2);

      const labelScale = Math.min(1.5, Math.max(1, Math.sqrt(DEFAULT_DIST / camera.dist)));
      accepted.length = 0;
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
        const flight = getFlightSample();
        const chosen = flightIsActive() && flight && target.object.preset_id
          && target.object.preset_id === flight.targetId;
        if (chosen) {
          markerX = flight.pose.x;
          markerY = flight.pose.y;
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
          element.dataset.flightTarget = String(Boolean(chosen));
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
        // Extra clearance before a hidden label returns prevents boundary flicker.
        const clearance = candidate.type === "planet" && planetLabelOpacity[candidate.index] < 0.5 ? 10 : 6;
        const overlaps = () => accepted.some((other) =>
          candidate.left < other.right + clearance && candidate.right > other.left - clearance
          && candidate.top < other.bottom + clearance && candidate.bottom > other.top - clearance,
        );
        const inBounds = () => candidate.left >= 12 && candidate.right <= width - 12
          && candidate.top >= (width < 769 ? 245 : 200) && candidate.bottom <= height - 60;
        if (candidate.type === "planet" && (overlaps() || !inBounds())) {
          const point = planetProjection[candidate.index];
          const w = (candidate.right - candidate.left) / labelScale;
          // Try nearby label positions before fading a lower-priority name.
          for (const [dx, dy] of labelOffsets) {
            candidate.left = point.x + (dx < 0 ? dx - w : dx === 0 ? -w / 2 : dx) * labelScale;
            candidate.right = candidate.left + w * labelScale;
            candidate.top = point.y + dy * labelScale - 9 * labelScale;
            candidate.bottom = candidate.top + 18 * labelScale;
            if (!inBounds()) continue;
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
        if (candidate.visible) {
          accepted.push(candidate);
          if (candidate.type === "planet") {
            const point = planetProjection[candidate.index];
            labelOffsetX[candidate.index] = (planetLabelX[candidate.index] - point.x) / labelScale;
            labelOffsetY[candidate.index] = (planetLabelY[candidate.index] - point.y) / labelScale;
          }
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
          if (accepted.some((other) => labelX < other.right && labelX + labelWidth > other.left
            && labelY - 9 * labelScale < other.bottom && labelY + 9 * labelScale > other.top)) return;
        }
        context.font = `600 ${12 * labelScale}px 'Manrope Variable', Manrope, system-ui, sans-serif`;
        context.textAlign = planetLabelAlign[index];
        context.fillStyle = rgba(star, planetLabelOpacity[index] * 0.95);
        const label = planetLabels[index];
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
        const index = targets.findIndex((target) => target.preset_id === id);
        if (index < 0) return false;
        markerRefs.current[index]?.click();
        return true;
      },
      locate: (id) => {
        const target = scene.targets.find((target) => target.object.preset_id === id);
        if (!target) return null;
        const projected = projectTarget(target, getHomeCamera());
        return { x: projected.x, y: projected.y, side: 20 };
      },
    });

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
    const interactive = (target: EventTarget | null) => target instanceof Element
      && Boolean(target.closest('button, a, input, select, textarea, [role="button"], [role="slider"], [role="dialog"], [contenteditable="true"]'));

    const pointerDown = (event: PointerEvent) => {
      if (!activeRef.current || flightIsActive() || interactive(event.target) || event.shiftKey) return;
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
      if (!pointers.has(event.pointerId) || flightIsActive()) return;
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
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", keydown);
    window.addEventListener("spherex:orrery-zoom", zoomControl);

    return () => {
      disposed = true;
      unsubscribe();
      unregisterNavigation();
      delete wrap.dataset.dragging;
      wakeRef.current = () => undefined;
      cancelAnimationFrame(animationFrame);
      window.clearInterval(clock);
      motionPreference.removeEventListener("change", motionChange);
      resizeObserver.disconnect();
      window.removeEventListener("pointerdown", pointerDown);
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerUp);
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("spherex:orrery-zoom", zoomControl);
    };
  }, [targets]);

  const pick = (target: CatalogObject, index: number) => {
    if (flightIsActive() || !target.preset_id) return;
    markerRefs.current.forEach((marker, candidate) => {
      if (marker) marker.dataset.flightTarget = String(candidate === index);
    });
    const astrometry = toEcliptic(target);
    const camera = cam.current;
    const ring = markerRefs.current[index]?.querySelector<HTMLElement>(`.${s.ring}`)?.getBoundingClientRect();
    if (!ring) return;
    let yaw = Math.atan2(astrometry.direction[0], astrometry.direction[1]);
    while (yaw - camera.yaw > Math.PI) yaw -= 2 * Math.PI;
    while (camera.yaw - yaw > Math.PI) yaw += 2 * Math.PI;
    const pitch = Math.atan2(-astrometry.direction[2], Math.hypot(astrometry.direction[0], astrometry.direction[1]));
    onFlightStartRef.current?.(target);
    const flight = startTargetFlight(target.preset_id, flightCamera(camera), { yaw, pitch }, {
      x: ring.left + ring.width / 2, y: ring.top + ring.height / 2, side: ring.width * 20 / 44,
    });
    markFlight("commit");
    onPickRef.current(target, { x: ring.left + ring.width / 2, y: ring.top + ring.height / 2 });
    void flight.then(() => onFlightEndRef.current?.());
  };

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
