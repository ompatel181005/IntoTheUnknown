import { useEffect, useRef, useState } from "react";
import {
  finishReturnFlight,
  getHomeCamera,
  getReturnFlight,
  saveHomeCamera,
  saveTargetCommit,
  setFlightFocus,
  startTargetFlight,
  type OrreryCameraState,
} from "../../lib/flight";
import { centuries, PLANETS, position, raDecToEcliptic, skyStars, type Vec3 } from "../../lib/orbits";
import { galacticToEq } from "../../lib/sky";
import { tokenRgb } from "../../lib/stretch";
import type { Preset } from "../../lib/targets";
import s from "./Orrery.module.css";

interface OrreryProps {
  targets: readonly Preset[];
  /** Called the moment a flight starts, so the starfield can begin its jump in the same instant. */
  onFlightStart?: (p: Preset) => void;
  /** Called near the end of the flight (or at once under reduced motion) to open the target.
   *  `from` is the clicked marker's position on screen, so the dome can grow out of it. */
  onPick: (p: Preset, from: { x: number; y: number } | null) => void;
  /** Called after a reverse flight has restored the whole-sky camera. */
  onFlightEnd?: () => void;
}

/** One continuous flight: turn toward the target, then hand off to the dome while still moving. */
const FLY_MS = 700;
const COMMIT_AT = 0.78; // about 550 ms in
const cinematic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const NEPTUNE_AU = 30.07;
/** Distances are compressed so Mercury and Neptune fit on one screen. */
const squash = (au: number) => Math.pow(au / NEPTUNE_AU, 0.42);
const SKY_R = 1.32; // celestial sphere radius, in squashed units (Neptune = 1)

function scale(v: Vec3): Vec3 {
  const r = Math.hypot(v[0], v[1], v[2]) || 1;
  const k = squash(r) / r;
  return [v[0] * k, v[1] * k, v[2] * k];
}

const rgba = (c: [number, number, number], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

function buildScene(targets: readonly Preset[]) {
  const T = centuries(new Date());
  const onSky = (ra: number, dec: number): Vec3 => {
    const u = raDecToEcliptic(ra, dec);
    return [u[0] * SKY_R, u[1] * SKY_R, u[2] * SKY_R];
  };
  return {
    key: targets.map((target) => `${target.id}:${target.ra}:${target.dec}`).join("|"),
    orbits: PLANETS.map((planet) => Array.from({ length: 129 }, (_, k) => scale(position(planet, T, (k / 128) * Math.PI * 2)))),
    planets: PLANETS.map((planet) => ({ name: planet.name, pos: scale(position(planet, T)) })),
    ecliptic: Array.from({ length: 97 }, (_, k): Vec3 => {
      const angle = (k / 96) * Math.PI * 2;
      return [Math.cos(angle) * SKY_R, Math.sin(angle) * SKY_R, 0];
    }),
    galaxy: Array.from({ length: 361 }, (_, k) => {
      const point = galacticToEq((k / 360) * 360, 0);
      return { p: onSky(point.ra, point.dec), w: 0.35 + 0.65 * Math.max(0, Math.cos(((k / 360) * 360 * Math.PI) / 180)) ** 2 };
    }),
    sights: targets.map((target) => onSky(target.ra, target.dec)),
    backgroundStars: skyStars(4000, SKY_R * 1.8),
  };
}

let sceneCache: ReturnType<typeof buildScene> | null = null;

function getScene(targets: readonly Preset[]) {
  const key = targets.map((target) => `${target.id}:${target.ra}:${target.dec}`).join("|");
  if (!sceneCache || sceneCache.key !== key) sceneCache = buildScene(targets);
  return sceneCache;
}

/**
 * Home view: a live orrery in a fixed celestial sky. Planets sit at today's positions (approximate),
 * SPHEREx rides with Earth, and the five targets hang in their real sky directions. Drag to turn it.
 */
export function Orrery({ targets, onPick, onFlightStart, onFlightEnd }: OrreryProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const markerRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const clockRef = useRef<HTMLSpanElement>(null);
  const [returnFlight] = useState(getReturnFlight);
  const cam = useRef<OrreryCameraState>(returnFlight?.from ?? getHomeCamera());
  const fly = useRef<
    | { mode: "forward"; start: number; from: OrreryCameraState; to: { yaw: number; pitch: number }; p: Preset; k: number }
    | { mode: "return"; start: number; from: OrreryCameraState; to: OrreryCameraState; targetId: string | null; k: number }
    | null
  >(null);
  const onPickRef = useRef(onPick);
  const onFlightEndRef = useRef(onFlightEnd);
  /** Pause the slow spin while a target is hovered or focused, so it holds still to be clicked. */
  const holdRef = useRef(false);
  useEffect(() => {
    onPickRef.current = onPick;
  }, [onPick]);
  useEffect(() => {
    onFlightEndRef.current = onFlightEnd;
  }, [onFlightEnd]);

  useEffect(() => {
    const anchor = anchorRef.current;
    const wrap = wrapRef.current;
    const cv = canvasRef.current;
    const ctx = cv?.getContext("2d");
    if (!anchor || !wrap || !cv || !ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const star = tokenRgb("--star");
    const sun = tokenRgb("--sun");
    const accent = tokenRgb("--accent");
    const text2 = tokenRgb("--text-2");
    const planetColor = PLANETS.map((p) => tokenRgb(`--planet-${p.name.toLowerCase()}`));
    // Keep the full-screen painter bounded on high-density displays.
    const dprCap = (navigator.hardwareConcurrency || 8) <= 4 ? 1.25 : 1.5;

    const { orbits, planets, ecliptic, galaxy, sights, backgroundStars } = getScene(targets);
    const returning = returnFlight;
    if (returning) {
      if (reduce) {
        cam.current = { ...returning.to };
        finishReturnFlight(cam.current);
        queueMicrotask(() => onFlightEndRef.current?.());
      } else {
        fly.current = {
          mode: "return",
          start: -1,
          from: { ...returning.from },
          to: { ...returning.to },
          targetId: returning.targetId,
          k: returning.targetId ? targets.findIndex((target) => target.id === returning.targetId) : -1,
        };
      }
    }

    let w = 0;
    let h = 0;
    let dirty = true;
    let sceneBox = { left: 0, top: 0, width: 0, height: 0 };
    let scheduleFrame = () => {};
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      const scene = anchor.getBoundingClientRect();
      const dpr = Math.min(dprCap, window.devicePixelRatio || 1);
      w = r.width;
      h = r.height;
      sceneBox = { left: scene.left - r.left, top: scene.top - r.top, width: scene.width, height: scene.height };
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dirty = true;
      scheduleFrame();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    ro.observe(anchor);

    const rotate = (v: Vec3, c: typeof cam.current) => {
      const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw), cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
      const x1 = v[0] * cy - v[1] * sy;
      const y1 = v[0] * sy + v[1] * cy;
      const y2 = y1 * cp - v[2] * sp;
      const z2 = y1 * sp + v[2] * cp;
      return { x: x1, y: y2, z: z2 };
    };

    /** Nearby solar-system geometry keeps the original home-map framing and camera dolly. */
    const projectScene = (v: Vec3, c: typeof cam.current) => {
      const rotated = rotate(v, c);
      const { x: x1, y: y2, z: z2 } = rotated;
      const depth = y2 + c.dist;
      const f = Math.min(sceneBox.width, sceneBox.height * 1.4) * 0.62;
      return {
        x: sceneBox.left + sceneBox.width / 2 + (f * x1) / depth,
        y: sceneBox.top + sceneBox.height / 2 - (f * z2) / depth,
        depth,
        front: y2 < 0,
      };
    };

    /** The celestial sphere is infinitely far away, so only camera rotation affects it. */
    const projectSky = (v: Vec3, c: typeof cam.current) => {
      const rotated = rotate(v, c);
      const depth = rotated.y;
      const f = Math.min(w, h) * 0.48;
      return {
        x: w / 2 + (f * rotated.x) / depth,
        y: h / 2 - (f * rotated.z) / depth,
        depth,
      };
    };

    // One path per run of front-facing or back-facing points, instead of one stroke per segment.
    const line = (pts: Vec3[], c: typeof cam.current, color: [number, number, number], alpha: number, width = 1, dash: number[] = []) => {
      ctx.setLineDash(dash);
      ctx.lineWidth = width;
      const front = new Path2D();
      const back = new Path2D();
      let prev: ReturnType<typeof projectScene> | null = null;
      for (const v of pts) {
        const q = projectScene(v, c);
        if (q.depth < 0.05) {
          prev = null;
          continue;
        }
        if (prev) {
          const path = prev.front ? front : back;
          path.moveTo(prev.x, prev.y);
          path.lineTo(q.x, q.y);
        }
        prev = q;
      }
      ctx.strokeStyle = rgba(color, alpha * 0.35);
      ctx.stroke(back);
      ctx.strokeStyle = rgba(color, alpha);
      ctx.stroke(front);
      ctx.setLineDash([]);
    };

    let raf = 0;
    let dragging = false;
    let last = performance.now();
    const frame = (now: number) => {
      raf = 0;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const c = cam.current;
      const f = fly.current;
      if (f) {
        if (f.start < 0) f.start = now;
        const t = Math.min(1, (now - f.start) / FLY_MS);
        const e = cinematic(t);
        if (f.mode === "forward") {
          // Turn first (done by ~70% of the flight) so the star is centred when the dome takes over.
          const turn = cinematic(Math.min(1, t / 0.7));
          c.yaw = f.from.yaw + (f.to.yaw - f.from.yaw) * turn;
          c.pitch = f.from.pitch + (f.to.pitch - f.from.pitch) * turn;
          c.dist = f.from.dist + (0.15 - f.from.dist) * e ** 1.6;
          c.fade = 1 - e * 0.85;
          const q = projectScene(sights[f.k], c);
          setFlightFocus(q.x, q.y);
          saveTargetCommit(f.p.id, c);
          if (t >= COMMIT_AT) {
            fly.current = null;
            onPickRef.current(f.p, { x: q.x, y: q.y });
            return;
          }
        } else {
          c.yaw = f.from.yaw + (f.to.yaw - f.from.yaw) * e;
          c.pitch = f.from.pitch + (f.to.pitch - f.from.pitch) * e;
          c.dist = f.from.dist + (f.to.dist - f.from.dist) * e;
          c.fade = f.from.fade + (1 - f.from.fade) * e;
          if (f.k >= 0) {
            const q = projectScene(sights[f.k], c);
            setFlightFocus(q.x, q.y);
          }
          if (t >= 1) {
            fly.current = null;
            finishReturnFlight(c);
            onFlightEndRef.current?.();
          }
        }
        dirty = true;
      } else if (!reduce && !dragging && !holdRef.current) {
        c.yaw += dt * 0.05;
        saveHomeCamera(c);
        dirty = true;
      }
      if (!dirty) {
        if (!reduce) scheduleFrame();
        return;
      }
      dirty = false;

      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = c.fade;
      const skyMarginX = w * 0.2;
      const skyMarginY = h * 0.2;
      const maxSkySegment = Math.max(w, h) * 0.35;
      const skyInRange = (q: { x: number; y: number }) =>
        q.x > -skyMarginX && q.x < w + skyMarginX && q.y > -skyMarginY && q.y < h + skyMarginY;
      // The Milky Way is a broad neutral glow with the dense galactic star field over it.
      ctx.lineCap = "round";
      for (const [widthK, alphaK, color] of [
        [38, 0.018, star],
        [20, 0.028, star],
        [7, 0.05, star],
      ] as const) {
        for (let bucket = 0; bucket < 4; bucket++) {
          const lo = bucket / 4;
          const hi = (bucket + 1) / 4;
          const wMid = (lo + hi) / 2;
          const front = new Path2D();
          for (let k = 1; k < galaxy.length; k++) {
            const gw = galaxy[k].w;
            if (gw < lo || (gw >= hi && bucket < 3)) continue;
            const a = projectSky(galaxy[k - 1].p, c);
            const b = projectSky(galaxy[k].p, c);
            if (a.depth <= 0.04 || b.depth <= 0.04) continue;
            if (Math.hypot(b.x - a.x, b.y - a.y) > maxSkySegment) continue;
            if (!skyInRange(a) && !skyInRange(b)) continue;
            front.moveTo(a.x, a.y);
            front.lineTo(b.x, b.y);
          }
          ctx.lineWidth = widthK * (0.5 + wMid * 0.5);
          ctx.strokeStyle = rgba(color, alphaK * (0.4 + wMid));
          ctx.stroke(front);
        }
      }
      ctx.lineCap = "butt";

      // Batch the rotation-only sky by brightness and tone. Points behind the camera are culled.
      const starPaths = Array.from({ length: 5 }, () => [new Path2D(), new Path2D(), new Path2D()]);
      for (const point of backgroundStars) {
        const q = projectSky(point.pos, c);
        if (q.depth <= 0.04 || q.x < -point.size || q.x > w + point.size || q.y < -point.size || q.y > h + point.size) continue;
        const bin = Math.min(4, Math.floor(point.brightness * 5));
        starPaths[bin][point.tone].moveTo(q.x + point.size, q.y);
        starPaths[bin][point.tone].arc(q.x, q.y, point.size, 0, Math.PI * 2);
      }
      const starAlpha = [0.22, 0.34, 0.5, 0.72, 0.96];
      const starTone = [star, sun, accent];
      starPaths.forEach((paths, bin) => {
        paths.forEach((path, tone) => {
          ctx.fillStyle = rgba(starTone[tone], starAlpha[bin]);
          ctx.fill(path);
        });
      });
      line(ecliptic, c, text2, 0.16, 1, [4, 7]);

      // Orbits, sun, planets.
      orbits.forEach((o, k) => {
        line(o, c, planetColor[k], 0.12, 4);
        line(o, c, planetColor[k], 0.7, 1);
      });
      const sp = projectScene([0, 0, 0], c);
      const g = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, 26);
      g.addColorStop(0, rgba(sun, 1));
      g.addColorStop(0.25, rgba(sun, 0.55));
      g.addColorStop(1, rgba(sun, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 26, 0, Math.PI * 2);
      ctx.fill();
      // Eyes-style planet labels: a ring in the planet's colour, uppercase name with wide tracking.
      ctx.font = "600 11px 'Manrope Variable', Manrope, system-ui, sans-serif";
      ctx.textBaseline = "middle";
      planets.forEach((p, k) => {
        const q = projectScene(p.pos, c);
        if (q.depth < 0.05) return;
        const isEarth = p.name === "Earth";
        ctx.fillStyle = rgba(planetColor[k], 1);
        ctx.beginPath();
        ctx.arc(q.x, q.y, isEarth ? 3 : 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = rgba(planetColor[k], 0.9);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(q.x, q.y, isEarth ? 9 : 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = rgba(star, isEarth ? 0.95 : 0.75);
        const text = (isEarth ? "EARTH · SPHEREx" : p.name.toUpperCase()).split("").join("\u2009");
        ctx.fillText(text, q.x + (isEarth ? 15 : 12), q.y - 5);
      });

      // Position the HTML target markers in their fixed sky directions.
      sights.forEach((v, k) => {
        const q = projectScene(v, c);
        const el = markerRefs.current[k];
        if (el) {
          el.style.transform = `translate(${q.x}px, ${q.y}px)`;
          el.style.opacity = String(c.fade * (q.front ? 1 : 0.55));
          el.dataset.behind = String(!q.front);
        }
      });
      ctx.globalAlpha = 1;
      if (!reduce || fly.current) scheduleFrame();
    };
    scheduleFrame = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    scheduleFrame();
    const tickClock = () => {
      if (clockRef.current) clockRef.current.textContent = new Date().toISOString().slice(0, 19).replace("T", " ");
    };
    tickClock();
    const clock = window.setInterval(tickClock, 1000);

    // Drag to turn the view.
    let px = 0;
    let py = 0;
    const down = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('button, a, input, select, textarea, [role="button"], [role="slider"], [role="dialog"], [contenteditable="true"]')) return;
      dragging = true;
      px = e.clientX;
      py = e.clientY;
      wrap.dataset.dragging = "true";
    };
    const move = (e: PointerEvent) => {
      if (!dragging || fly.current) return;
      cam.current.yaw += (e.clientX - px) * 0.006;
      cam.current.pitch = Math.min(1.5, Math.max(0.15, cam.current.pitch + (e.clientY - py) * 0.004));
      saveHomeCamera(cam.current);
      dirty = true;
      scheduleFrame();
      px = e.clientX;
      py = e.clientY;
    };
    const up = () => {
      dragging = false;
      delete wrap.dataset.dragging;
    };
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(clock);
      ro.disconnect();
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [returnFlight, targets]);

  const pick = (p: Preset, k: number) => {
    if (fly.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return onPick(p, null);
    markerRefs.current[k]?.setAttribute("data-picked", "true");
    onFlightStart?.(p);
    // Turn so the target's direction faces the camera, then fly out toward it.
    // Camera space: the view looks along +y. Put the target straight ahead (x = 0, z = 0, y > 0).
    const v = raDecToEcliptic(p.ra, p.dec);
    const c = cam.current;
    startTargetFlight(p.id, c);
    let yaw = Math.atan2(v[0], v[1]);
    while (yaw - c.yaw > Math.PI) yaw -= 2 * Math.PI;
    while (c.yaw - yaw > Math.PI) yaw += 2 * Math.PI;
    const pitch = Math.atan2(-v[2], Math.hypot(v[0], v[1]));
    fly.current = { mode: "forward", start: -1, from: { ...c }, to: { yaw, pitch }, p, k }; // the next frame stamps the start
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
        {targets.map((t, k) => (
          <button
            key={t.id}
            ref={(el) => {
              markerRefs.current[k] = el;
            }}
            type="button"
            className={s.target}
            onClick={() => pick(t, k)}
            onPointerEnter={() => (holdRef.current = true)}
            onPointerDown={() => (holdRef.current = true)}
            onPointerLeave={() => (holdRef.current = false)}
            onFocus={() => (holdRef.current = true)}
            onBlur={() => (holdRef.current = false)}
            aria-label={`Fly to ${t.name}`}
          >
            <span className={s.ring} aria-hidden="true" />
            <span className={s.label}>
              <span className={s.name}>{t.name}</span>
              <span className={s.kind}>{t.kind === "motion" ? "Moves" : "Changes brightness"}</span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
