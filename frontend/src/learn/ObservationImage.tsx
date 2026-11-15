import { useEffect, useRef } from "react";
import type { LoadedView } from "../data/source";
import { epochCanvas } from "./postcard";
import { imagePixel } from "./state";
import s from "./Learn.module.css";

interface Props { view: LoadedView; epoch: number; selection: [number, number] | null; onSelect: (pixel: [number, number]) => void; label: string; north: string }
export function ObservationImage({ view, epoch, selection, onSelect, label, north }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { nx, ny } = view.manifest.grid;
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, nx, ny);
    ctx.drawImage(epochCanvas(view, epoch), 0, 0);
  }, [view, epoch, nx, ny]);
  return <div className={s.imageWrap}>
    <canvas ref={ref} width={nx} height={ny} role="img" aria-label={label} onClick={e => {
      const r = e.currentTarget.getBoundingClientRect();
      onSelect(imagePixel((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, nx, ny));
    }} />
    <span className={s.compass}>{north}</span>
    {selection && <span className={s.marker} aria-hidden="true" style={{ left: `${(selection[0] + 0.5) / nx * 100}%`, top: `${(ny - selection[1] - 0.5) / ny * 100}%` }} />}
  </div>;
}
