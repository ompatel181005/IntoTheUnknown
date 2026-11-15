export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const CELL = 64;

/** Reusable cell storage. Accepted, non-overlapping labels bound each collision query. */
export class RectGrid {
  private columns = 1;
  private rows = 1;
  private counts = new Uint32Array(0);
  private entries = new Uint32Array(0);

  constructor(private readonly rectangles: readonly Rect[]) {}

  resize(width: number, height: number) {
    this.columns = Math.max(1, Math.ceil(width / CELL));
    this.rows = Math.max(1, Math.ceil(height / CELL));
    this.counts = new Uint32Array(this.columns * this.rows);
    this.entries = new Uint32Array(this.counts.length * this.rectangles.length);
  }

  clear() {
    this.counts.fill(0);
  }

  private column(x: number) {
    return Math.max(0, Math.min(this.columns - 1, Math.floor(x / CELL)));
  }

  private row(y: number) {
    return Math.max(0, Math.min(this.rows - 1, Math.floor(y / CELL)));
  }

  insert(index: number) {
    const rect = this.rectangles[index];
    const right = this.column(rect.right), bottom = this.row(rect.bottom);
    for (let y = this.row(rect.top); y <= bottom; y++) {
      for (let x = this.column(rect.left); x <= right; x++) {
        const cell = y * this.columns + x;
        this.entries[cell * this.rectangles.length + this.counts[cell]++] = index;
      }
    }
  }

  overlaps(rect: Rect, clearance: number) {
    const right = this.column(rect.right + clearance), bottom = this.row(rect.bottom + clearance);
    for (let y = this.row(rect.top - clearance); y <= bottom; y++) {
      for (let x = this.column(rect.left - clearance); x <= right; x++) {
        const cell = y * this.columns + x;
        for (let entry = 0; entry < this.counts[cell]; entry++) {
          const other = this.rectangles[this.entries[cell * this.rectangles.length + entry]];
          if (rect.left < other.right + clearance && rect.right > other.left - clearance
            && rect.top < other.bottom + clearance && rect.bottom > other.top - clearance) return true;
        }
      }
    }
    return false;
  }

  hit(x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
    const cell = this.row(y) * this.columns + this.column(x);
    for (let entry = this.counts[cell] - 1; entry >= 0; entry--) {
      const index = this.entries[cell * this.rectangles.length + entry];
      const rect = this.rectangles[index];
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return index;
    }
    return -1;
  }
}
