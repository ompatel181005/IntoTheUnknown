import { raDecToEcliptic } from "./orbits";
import { tokenRgb } from "./stretch";

// The last three bins remain dust; V < 5.5 carries the naked-eye sky.
const MAG_LEVELS = [
  { limit: 0, radius: 1.5, alpha: 0.96 },
  { limit: 1.5, radius: 1.25, alpha: 0.93 },
  { limit: 2.5, radius: 1.1, alpha: 0.9 },
  { limit: 3.5, radius: 0.98, alpha: 0.84 },
  { limit: 4.5, radius: 0.86, alpha: 0.76 },
  { limit: 5, radius: 0.78, alpha: 0.7 },
  { limit: 5.5, radius: 0.72, alpha: 0.64 },
  { limit: 6, radius: 0.53, alpha: 0.44 },
  { limit: 6.5, radius: 0.43, alpha: 0.32 },
  { limit: Infinity, radius: 0.36, alpha: 0.25 },
] as const;
const COLOR_BINS = 5;

interface BrightStarCatalogue {
  count: number;
  ra: number[];
  dec: number[];
  vmag: number[];
  bv: (number | null)[];
}

export interface Starfield {
  /** Ecliptic unit vectors, packed by magnitude and B-V bucket. */
  xyz: Float32Array;
  buckets: { start: number; end: number; radius: number; alpha: number; color: string }[];
  halos: Starfield["buckets"];
}

let catalogue: Promise<Starfield | null> | undefined;

/** One local BSC5 request shared by both painters; a missing asset leaves the sky empty. */
export function loadStarfield(): Promise<Starfield | null> {
  return catalogue ??= fetch("/sky/bsc5.json")
    .then(async (response) => {
      if (!response.ok) throw new Error("Star catalogue unavailable");
      const data = await response.json() as BrightStarCatalogue;
      if (data.count !== data.ra.length || [data.dec, data.vmag, data.bv].some((a) => a.length !== data.count)) {
        throw new Error("Invalid star catalogue columns");
      }
      const white = tokenRgb("--star");
      const blue = tokenRgb("--accent");
      const warm = tokenRgb("--sun");
      const groups: number[][] = Array.from({ length: MAG_LEVELS.length * COLOR_BINS }, () => []);
      for (let i = 0; i < data.count; i++) {
        if (![data.ra[i], data.dec[i], data.vmag[i]].every(Number.isFinite)) throw new Error("Invalid star coordinates");
        const mag = MAG_LEVELS.findIndex((level) => data.vmag[i] < level.limit);
        // B-V follows stellar temperature: blue-white, white, cream, pale orange.
        const bv = data.bv[i] ?? 0.45;
        const color = Math.min(COLOR_BINS - 1, Math.max(0, Math.floor((bv + 0.4) / 2.4 * COLOR_BINS)));
        groups[mag * COLOR_BINS + color].push(i);
      }
      const xyz = new Float32Array(data.count * 3);
      let cursor = 0;
      const buckets = groups.map((indices, bucket) => {
        const start = cursor;
        for (const i of indices) {
          xyz.set(raDecToEcliptic(data.ra[i], data.dec[i]), cursor * 3);
          cursor++;
        }
        const level = MAG_LEVELS[Math.floor(bucket / COLOR_BINS)];
        const tone = bucket % COLOR_BINS;
        const tint = tone < 1 ? blue : warm;
        const mix = tone < 1 ? 0.16 : Math.max(0, tone - 1) * 0.1;
        const rgb = white.map((c, channel) => Math.round(c + (tint[channel] - c) * mix));
        return { start, end: cursor, radius: level.radius, alpha: level.alpha, color: `rgb(${rgb.join(",")})` };
      });
      // Only the catalogue's brightest 22 stars get layered, low-opacity halos.
      const halos = buckets.slice(0, 2 * COLOR_BINS).filter((b) => b.end > b.start).flatMap((bucket) =>
        [[4, 0.012], [2.8, 0.025], [1.8, 0.05]].map(([scale, alpha]) =>
          ({ ...bucket, radius: bucket.radius * scale, alpha })),
      );
      return { xyz, buckets: buckets.filter((bucket) => bucket.end > bucket.start), halos };
    })
    .catch(() => null);
}

/** Shared bucket painter. Coordinates and radii are CSS pixels under the canvas DPR transform. */
export function drawStarfield(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  field: Starfield,
  projected: Float32Array,
  stride: 3 | 4,
  width: number,
  height: number,
  fade = 1,
  moving = false,
) {
  for (let pass = moving ? 1 : 0; pass < 2; pass++) {
    const buckets = pass === 0 ? field.halos : field.buckets;
    for (const bucket of buckets) {
      const r = bucket.radius;
      const margin = moving ? 50 : r;
      context.beginPath();
      for (let i = bucket.start * stride; i < bucket.end * stride; i += stride) {
        const x = projected[i], y = projected[i + 1];
        if (!Number.isFinite(x) || (stride === 3 && projected[i + 2] <= 0.04)
          || x < -margin || x > width + margin || y < -margin || y > height + margin) continue;
        if (moving) {
          context.moveTo(projected[i + 2], projected[i + 3]);
          context.lineTo(x, y);
        } else {
          context.moveTo(x + r, y);
          context.arc(x, y, r, 0, Math.PI * 2);
        }
      }
      context.globalAlpha = fade * bucket.alpha;
      if (moving) {
        context.strokeStyle = bucket.color;
        context.lineWidth = r * 2;
        context.stroke();
      } else {
        context.fillStyle = bucket.color;
        context.fill();
      }
    }
  }
  context.globalAlpha = fade;
}

export interface StarfieldFrame {
  yaw: number;
  pitch: number;
  x: number;
  y: number;
  focal: number;
  fade: number;
  travel?: number;
  streak?: number;
  prepare?: boolean;
}

export interface Galaxy {
  axes: number[][];
  color: number[];
}

export type StarfieldMessage =
  | { field: Starfield }
  | { width: number; height: number; dpr: number }
  | StarfieldFrame;

/** Paint a complete sky into a detached cache, never a separately presented canvas. */
export function starfieldPainter(canvas: HTMLCanvasElement | OffscreenCanvas, galaxy?: Galaxy) {
  const context = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  let field: Starfield | null = null;
  let projected = new Float32Array(0);
  let geometry = new Float32Array(0);
  let width = 0, height = 0, dpr = 1;
  let previous: StarfieldFrame | null = null;
  let galaxyKey = "";
  const galaxyCanvas = galaxy ? (typeof OffscreenCanvas === "function" ? new OffscreenCanvas(1, 1) : document.createElement("canvas")) : undefined;
  const galaxyContext = galaxyCanvas?.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | undefined;
  let pixels: ImageData | null = null;
  let rays = new Float32Array(0);
  return (message: StarfieldMessage) => {
    if ("field" in message) {
      field = message.field;
      projected = new Float32Array(field.xyz.length / 3 * 4);
      geometry = new Float32Array(field.xyz.length);
      previous = null;
      return;
    }
    if ("width" in message) {
      ({ width, height, dpr } = message);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      previous = null;
      galaxyKey = "";
      return;
    }
    if (!width || !height) return;
    const { yaw, pitch, x: cx, y: cy, focal, fade, travel, streak = 0, prepare } = message;
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw), cosP = Math.cos(pitch), sinP = Math.sin(pitch);
    if (galaxy && galaxyContext && galaxyCanvas) {
      const key = `${yaw},${pitch},${cx},${cy},${focal}`;
      if (key !== galaxyKey) {
        const gw = Math.max(1, Math.ceil(width / 16) + 2), gh = Math.max(1, Math.ceil(height / 16) + 2);
        if (!pixels || pixels.width !== gw || pixels.height !== gh) {
          galaxyCanvas.width = gw;
          galaxyCanvas.height = gh;
          pixels = galaxyContext.createImageData(gw, gh);
          rays = new Float32Array(gw * gh * 3);
          for (let i = 0; i < gw * gh; i++) pixels.data.set(galaxy.color, i * 4);
        }
        if (!previous || cx !== previous.x || cy !== previous.y || focal !== previous.focal || !galaxyKey) {
          for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
            const rx = ((x + 0.5) * (width + 32) / gw - 16 - cx) / focal;
            const rz = (cy + 16 - (y + 0.5) * (height + 32) / gh) / focal;
            const length = Math.hypot(rx, 1, rz), i = (y * gw + x) * 3;
            rays[i] = rx / length; rays[i + 1] = 1 / length; rays[i + 2] = rz / length;
          }
        }
        const axes = galaxy.axes.map(([x, y, z]) => {
          const rx = x * cosY - y * sinY, ry = x * sinY + y * cosY;
          return [rx, ry * cosP - z * sinP, ry * sinP + z * cosP];
        });
        for (let i = 0, pixel = 3; i < rays.length; i += 3, pixel += 4) {
          const rx = rays[i], ry = rays[i + 1], rz = rays[i + 2];
          const gx = rx * axes[0][0] + ry * axes[0][1] + rz * axes[0][2];
          const gy = rx * axes[1][0] + ry * axes[1][1] + rz * axes[1][2];
          const latitude = rx * axes[2][0] + ry * axes[2][1] + rz * axes[2][2];
          const inner = ((1 + gx) * 0.5) ** 2;
          const falloff = Math.max(0, 1 - (latitude / (0.3 + 0.23 * inner)) ** 2);
          const clouds = 0.82 + 0.1 * Math.sin(18 * gy + 7 * gx + 22 * latitude)
            + 0.08 * Math.sin(31 * gy - 13 * gx + 45 * latitude);
          pixels.data[pixel] = 255 * (0.012 + 0.045 * inner) * falloff ** 3 * clouds;
        }
        galaxyContext.putImageData(pixels, 0, 0);
        galaxyKey = key;
      }
    }
    previous = message;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.globalAlpha = fade;
    if (galaxyCanvas) context.drawImage(galaxyCanvas, -16, -16, width + 32, height + 32);
    if (!field) return;
    const xyz = field.xyz;
    const warp = travel !== undefined;
    const stride = warp ? 4 : 3;
    for (let i = 0; i < xyz.length; i += 3) {
      const j = i / 3 * stride;
      if (!warp || prepare) {
        const x = xyz[i] * cosY - xyz[i + 1] * sinY;
        const y = xyz[i] * sinY + xyz[i + 1] * cosY;
        const depth = y * cosP - xyz[i + 2] * sinP;
        const z = y * sinP + xyz[i + 2] * cosP;
        if (warp) {
          const near = 0.04 + Math.max(0, depth) * 0.96;
          geometry[i] = x * near / depth;
          geometry[i + 1] = -z * near / depth;
          geometry[i + 2] = depth > 0.04 ? near : -1;
        } else {
          projected[j] = cx + focal * x / depth;
          projected[j + 1] = cy - focal * z / depth;
          projected[j + 2] = depth;
        }
      }
      if (warp) {
        if (geometry[i + 2] < 0) { projected[j] = NaN; continue; }
        const z = 0.04 + ((geometry[i + 2] - travel - 0.04) % 0.96 + 0.96) % 0.96;
        const z0 = Math.min(1.2, Math.max(0.04, z + streak));
        projected[j] = cx + geometry[i] / z * focal;
        projected[j + 1] = cy + geometry[i + 1] / z * focal;
        projected[j + 2] = cx + geometry[i] / z0 * focal;
        projected[j + 3] = cy + geometry[i + 1] / z0 * focal;
      }
    }
    context.lineCap = "round";
    drawStarfield(context, field, projected, stride, width, height, fade, Math.abs(streak) > 1e-4);
  };
}

/** Rasterize off the main thread, but present only on the scene's own animation frame. */
export function cacheStarfield(onReady: () => void, galaxy?: Galaxy) {
  let worker: Worker | null = null;
  let source: ImageBitmap | HTMLCanvasElement | null = null;
  let fallback: ReturnType<typeof starfieldPainter> | null = null;
  let field: Starfield | null = null;
  let size = { width: 0, height: 0, dpr: 1 };
  let frame: StarfieldFrame | null = null;
  let pending: StarfieldFrame | null = null;
  let busy = false;
  let disposed = false;
  const release = () => { if (source && "close" in source) source.close(); source = null; };
  const startFallback = () => {
    worker?.terminate();
    worker = null;
    busy = false;
    pending = null;
    release();
    const canvas = document.createElement("canvas");
    fallback = starfieldPainter(canvas, galaxy);
    fallback(size);
    if (field) fallback({ field });
    if (frame) fallback({ ...frame, prepare: frame.travel !== undefined });
    source = canvas;
  };
  const send = (next: StarfieldFrame) => {
    busy = true;
    worker!.postMessage(next);
  };
  if (typeof Worker === "function" && typeof OffscreenCanvas === "function"
    && typeof OffscreenCanvas.prototype.transferToImageBitmap === "function") {
    try {
      worker = new Worker(new URL("../components/SkyBackdrop/starfield.worker.ts", import.meta.url), { type: "module" });
      worker.postMessage({ galaxy });
      worker.onmessage = ({ data: bitmap }: MessageEvent<ImageBitmap>) => {
        if (disposed || !worker) { bitmap.close(); return; }
        release();
        source = bitmap;
        busy = false;
        if (pending) { const next = pending; pending = null; send(next); }
        onReady();
      };
      worker.onerror = (event) => {
        event.preventDefault();
        if (disposed) return;
        startFallback();
        onReady();
      };
    } catch { startFallback(); }
  } else startFallback();
  return {
    paint(message: StarfieldMessage) {
      if (disposed) return;
      if ("field" in message) field = message.field;
      else if ("width" in message) {
        if (message.width === size.width && message.height === size.height && message.dpr === size.dpr) return;
        size = message;
      } else {
        const previous = frame;
        frame = message;
        if (previous && !message.prepare && previous.yaw === message.yaw && previous.pitch === message.pitch
          && previous.x === message.x && previous.y === message.y && previous.focal === message.focal
          && previous.fade === message.fade && previous.travel === message.travel && previous.streak === message.streak) return;
        if (worker) {
          // Bound the queue to one raster plus the newest camera; retain warp preparation when coalescing.
          if (busy) pending = { ...message, prepare: message.prepare || pending?.prepare };
          else send(message);
          return;
        }
      }
      if (worker) worker.postMessage(message);
      else fallback!(message);
      if (!("yaw" in message)) frame = null;
    },
    draw(context: CanvasRenderingContext2D | ImageBitmapRenderingContext) {
      if (!source || !size.width || !size.height || frame?.fade === 0) return;
      if ("transferFromImageBitmap" in context) {
        if ("close" in source) {
          context.transferFromImageBitmap(source);
          source = null;
        } else {
          void createImageBitmap(source).then((bitmap) => {
            if (disposed) bitmap.close();
            else context.transferFromImageBitmap(bitmap);
          });
        }
        return;
      }
      const alpha = context.globalAlpha;
      const operation = context.globalCompositeOperation;
      context.globalAlpha = 1;
      context.globalCompositeOperation = "copy";
      context.drawImage(source, 0, 0, size.width, size.height);
      context.globalCompositeOperation = operation;
      context.globalAlpha = alpha;
      return true;
    },
    dispose() { disposed = true; worker?.terminate(); release(); },
  };
}

/** The flight backdrop owns one display canvas; its detached cache never enters the layer tree. */
export function mountStarfield(host: HTMLElement) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
  host.append(canvas);
  const context = (typeof Worker === "function" && typeof OffscreenCanvas === "function"
    && typeof createImageBitmap === "function" && canvas.getContext("bitmaprenderer")) || canvas.getContext("2d")!;
  let size = { width: 0, height: 0, dpr: 1 };
  let raf = 0;
  const present = () => {
    raf = 0;
    if ("clearRect" in context) {
      context.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
      context.clearRect(0, 0, size.width, size.height);
    }
    cache.draw(context);
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(present); };
  const cache = cacheStarfield(schedule);
  return {
    paint(message: StarfieldMessage) {
      if ("width" in message) {
        size = message;
        const width = Math.round(size.width * size.dpr), height = Math.round(size.height * size.dpr);
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
      }
      cache.paint(message);
      schedule();
    },
    dispose() { cancelAnimationFrame(raf); cache.dispose(); canvas.remove(); },
  };
}
