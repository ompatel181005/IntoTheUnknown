import { starfieldPainter, type Galaxy, type StarfieldMessage } from "../../lib/starfield";

let canvas: OffscreenCanvas;
let paint: ReturnType<typeof starfieldPainter>;
self.onmessage = ({ data }: MessageEvent<StarfieldMessage | { galaxy: Galaxy | undefined }>) => {
  if ("galaxy" in data) {
    canvas = new OffscreenCanvas(1, 1);
    paint = starfieldPainter(canvas, data.galaxy);
  } else {
    paint(data);
    if ("yaw" in data) {
      const bitmap = canvas.transferToImageBitmap();
      self.postMessage(bitmap, { transfer: [bitmap] });
    }
  }
};
