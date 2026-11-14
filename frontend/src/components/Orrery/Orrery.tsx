import { useEffect, useRef } from "react";
import { centuries, PLANETS, position, raDecToEcliptic, type Vec3 } from "../../lib/orbits";
import { galacticToEq } from "../../lib/sky";
import { tokenRgb } from "../../lib/stretch";
import type { Preset } from "../../lib/targets";
import s from "./Orrery.module.css";

interface OrreryProps {
  targets: readonly Preset[];
  /** Called the moment a flight starts, so the starfield can begin its jump in the same instant. */
  onFlightStart?: (p: Preset) => void;
  /** Called part-way through the flight (or at once under reduced motion) to open the target. */
  onPick: (p: Preset) => void;
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

/**
 * Home view: a live holographic orrery. Planets sit at today's positions (approximate), SPHEREx rides with
 * Earth, and the five targets hang on a wireframe celestial sphere in their real directions. Drag to turn it.
 */
export function Orrery({ targets, onPick, onFlightStart }: OrreryProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const markerRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const clockRef = useRef<HTMLSpanElement>(null);
  const cam = useRef({ yaw: -0.6, pitch: 1.05, dist: 3.2, fade: 1 });
  const fly = useRef<{ start: number; from: typeof cam.current; to: { yaw: number; pitch: number }; p: Preset; k: number } | null>(null);
  const onPickRef = useRef(onPick);
  /** Pause the slow spin while a target is hovered or focused, so it holds still to be clicked. */
  const holdRef = useRef(false);
  useEffect(() => {
    onPickRef.current = onPick;
  }, [onPick]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const cv = canvasRef.current;
    const ctx = cv?.getContext("2d");
    if (!wrap || !cv || !ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const holo = tokenRgb("--holo");
    const star = tokenRgb("--star");
    const sun = tokenRgb("--sun");
    const band = tokenRgb("--holo");
    const T = centuries(new Date());
    // Lower resolution on small machines keeps the loop under a frame budget.
    const dprCap = (navigator.hardwareConcurrency || 8) <= 4 ? 1.25 : 2;

    // Static geometry, built once.
    const orbits = PLANETS.map((p) => Array.from({ length: 129 }, (_, k) => scale(position(p, T, (k / 128) * Math.PI * 2))));
    const planets = PLANETS.map((p) => ({ name: p.name, pos: scale(position(p, T)) }));
    const earth = planets.find((p) => p.name === "Earth")!.pos;
    const onSky = (ra: number, dec: number): Vec3 => {
      const u = raDecToEcliptic(ra, dec);
      return [u[0] * SKY_R, u[1] * SKY_R, u[2] * SKY_R];
    };
    const meridians = Array.from({ length: 12 }, (_, m) => Array.from({ length: 49 }, (_, k) => onSky(m * 30, -90 + (k / 48) * 180)));
    const parallels = [-60, -30, 0, 30, 60].map((d) => Array.from({ length: 97 }, (_, k) => onSky((k / 96) * 360, d)));
    const ecliptic = Array.from({ length: 97 }, (_, k): Vec3 => {
      const a = (k / 96) * Math.PI * 2;
      return [Math.cos(a) * SKY_R, Math.sin(a) * SKY_R, 0];
    });
    const galaxy = Array.from({ length: 145 }, (_, k) => {
      const q = galacticToEq((k / 144) * 360, 0);
      return { p: onSky(q.ra, q.dec), w: 0.35 + 0.65 * Math.max(0, Math.cos(((k / 144) * 360 * Math.PI) / 180)) ** 2 };
    });
    const sights = targets.map((t) => onSky(t.ra, t.dec));

    let w = 0;
    let h = 0;
    let dirty = true;
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = Math.min(dprCap, window.devicePixelRatio || 1);
      w = r.width;
      dirty = true;
      h = r.height;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const project = (v: Vec3, c: typeof cam.current) => {
      const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw), cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
      const x1 = v[0] * cy - v[1] * sy;
      const y1 = v[0] * sy + v[1] * cy;
      const y2 = y1 * cp - v[2] * sp;
      const z2 = y1 * sp + v[2] * cp;
      const depth = y2 + c.dist;
      const f = Math.min(w, h * 1.4) * 0.62;
      return { x: w / 2 + (f * x1) / depth, y: h / 2 - (f * z2) / depth, depth, front: y2 < 0 };
    };

    const line = (pts: Vec3[], c: typeof cam.current, color: [number, number, number], alpha: number, width = 1, dash: number[] = []) => {
      ctx.setLineDash(dash);
      ctx.lineWidth = width;
      for (let k = 1; k < pts.length; k++) {
        const a = project(pts[k - 1], c);
        const b = project(pts[k], c);
        if (a.depth < 0.05 || b.depth < 0.05) continue;
        ctx.strokeStyle = rgba(color, alpha * (a.front ? 1 : 0.35));
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    };

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const c = cam.current;
      const f = fly.current;
      if (f) {
        if (f.start < 0) f.start = now;
        const t = Math.min(1, (now - f.start) / FLY_MS);
        const e = cinematic(t);
        c.yaw = f.from.yaw + (f.to.yaw - f.from.yaw) * e;
        c.pitch = f.from.pitch + (f.to.pitch - f.from.pitch) * e;
        c.dist = f.from.dist + (0.15 - f.from.dist) * e ** 1.6;
        c.fade = 1 - e * 0.85;
        if (t >= COMMIT_AT) {
          fly.current = null;
          // The clicked ring becomes the shared element that grows into the dome.
          const el = markerRefs.current[f.k];
          if (el) el.style.setProperty("view-transition-name", "aperture");
          onPickRef.current(f.p);
          return; // the view takes over
        }
        dirty = true;
      } else if (!reduce && !dragging && !holdRef.current) {
        c.yaw += dt * 0.05;
        dirty = true;
      }
      if (!dirty) {
        raf = requestAnimationFrame(frame);
        return; // still scene (reduced motion): draw only when something changed
      }
      dirty = false;

      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = c.fade;
      // Celestial sphere: grid, galactic band, ecliptic.
      meridians.forEach((m) => line(m, c, holo, 0.14));
      parallels.forEach((p, k) => line(p, c, holo, k === 2 ? 0.3 : 0.14, k === 2 ? 1.2 : 1));
      // Galactic band as stacked translucent strokes (no shadowBlur, which is slow in Firefox).
      ctx.lineCap = "round";
      for (const [widthK, alphaK, color] of [
        [22, 0.035, band],
        [11, 0.06, star],
        [4, 0.1, star],
      ] as const) {
        for (let k = 1; k < galaxy.length; k++) {
          const a = project(galaxy[k - 1].p, c);
          const b = project(galaxy[k].p, c);
          if (a.depth < 0.05) continue;
          ctx.strokeStyle = rgba(color, alphaK * (0.4 + galaxy[k].w) * (a.front ? 1 : 0.45));
          ctx.lineWidth = widthK * (0.5 + galaxy[k].w * 0.5);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
      ctx.lineCap = "butt";
      line(ecliptic, c, holo, 0.35, 1, [4, 6]);

      // Orbits, sun, planets.
      orbits.forEach((o) => {
        line(o, c, holo, 0.08, 4);
        line(o, c, holo, 0.42, 1);
      });
      const sp = project([0, 0, 0], c);
      const g = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, 26);
      g.addColorStop(0, rgba(sun, 1));
      g.addColorStop(0.25, rgba(sun, 0.55));
      g.addColorStop(1, rgba(sun, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "600 10px 'JetBrains Mono', monospace";
      ctx.textBaseline = "middle";
      for (const p of planets) {
        const q = project(p.pos, c);
        if (q.depth < 0.05) continue;
        const isEarth = p.name === "Earth";
        ctx.fillStyle = rgba(star, 0.95);
        ctx.beginPath();
        ctx.arc(q.x, q.y, isEarth ? 3.4 : 2.6, 0, Math.PI * 2);
        ctx.fill();
        if (isEarth) {
          ctx.strokeStyle = rgba(holo, 0.9);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(q.x, q.y, 8, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = rgba(star, isEarth ? 0.95 : 0.6);
        ctx.fillText((isEarth ? "EARTH · SPHEREx" : p.name.toUpperCase()).split("").join(" "), q.x + (isEarth ? 13 : 8), q.y);
      }

      // Lines of sight from Earth to each target, and the HTML target markers.
      const eq = project(earth, c);
      sights.forEach((v, k) => {
        const q = project(v, c);
        ctx.strokeStyle = rgba(holo, 0.22);
        ctx.setLineDash([2, 5]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(eq.x, eq.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
        ctx.setLineDash([]);
        const el = markerRefs.current[k];
        if (el) {
          el.style.transform = `translate(${q.x}px, ${q.y}px)`;
          el.style.opacity = String(c.fade * (q.front ? 1 : 0.55));
          el.dataset.behind = String(!q.front);
        }
      });
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const tickClock = () => {
      if (clockRef.current) clockRef.current.textContent = new Date().toISOString().slice(0, 19).replace("T", " ");
    };
    tickClock();
    const clock = window.setInterval(tickClock, 1000);

    // Drag to turn the view.
    let dragging = false;
    let px = 0;
    let py = 0;
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest("button")) return;
      dragging = true;
      px = e.clientX;
      py = e.clientY;
      wrap.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging || fly.current) return;
      cam.current.yaw += (e.clientX - px) * 0.006;
      cam.current.pitch = Math.min(1.5, Math.max(0.15, cam.current.pitch + (e.clientY - py) * 0.004));
      dirty = true;
      px = e.clientX;
      py = e.clientY;
    };
    const up = () => {
      dragging = false;
    };
    wrap.addEventListener("pointerdown", down);
    wrap.addEventListener("pointermove", move);
    wrap.addEventListener("pointerup", up);
    wrap.addEventListener("pointercancel", up);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(clock);
      ro.disconnect();
      wrap.removeEventListener("pointerdown", down);
      wrap.removeEventListener("pointermove", move);
      wrap.removeEventListener("pointerup", up);
      wrap.removeEventListener("pointercancel", up);
    };
  }, [targets]);

  const pick = (p: Preset, k: number) => {
    if (fly.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return onPick(p);
    markerRefs.current[k]?.setAttribute("data-picked", "true");
    onFlightStart?.(p);
    // Turn so the target's direction faces the camera, then fly out toward it.
    // Camera space: the view looks along +y. Put the target straight ahead (x = 0, z = 0, y > 0).
    const v = raDecToEcliptic(p.ra, p.dec);
    const c = cam.current;
    let yaw = Math.atan2(v[0], v[1]);
    while (yaw - c.yaw > Math.PI) yaw -= 2 * Math.PI;
    while (c.yaw - yaw > Math.PI) yaw += 2 * Math.PI;
    const pitch = Math.atan2(-v[2], Math.hypot(v[0], v[1]));
    fly.current = { start: -1, from: { ...c }, to: { yaw, pitch }, p, k }; // the next frame stamps the start
  };

  return (
    <div ref={wrapRef} className={s.orrery} aria-label="The solar system today, with the five targets on the sky around it">
      <canvas ref={canvasRef} className={s.canvas} aria-hidden="true" />
      <div className={s.scan} aria-hidden="true" />
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
      <p className={`${s.hud} mono`}>
        <span className={s.live}>
          <span className={s.liveDot} aria-hidden="true" />
          SKY CONTEXT
        </span>
        <span>
          UTC NOW <span ref={clockRef} />
        </span>
        <span className={s.hudNote}>Planet positions approximate · distances compressed · drag to turn</span>
      </p>
    </div>
  );
}
