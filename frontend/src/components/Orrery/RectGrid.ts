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

  /**
   * Up to `out.length` entries whose rect centres lie within `radius` of (x, y), nearest first.
   * Writes into the caller's preallocated arrays and returns the count.
   */
  nearest(x: number, y: number, radius: number, out: Int32Array, distances: Float64Array) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !out.length) return 0;
    const limit = radius * radius;
    const right = this.column(x + radius), bottom = this.row(y + radius);
    let count = 0;
    for (let row = this.row(y - radius); row <= bottom; row++) {
      for (let column = this.column(x - radius); column <= right; column++) {
        const cell = row * this.columns + column;
        for (let entry = 0; entry < this.counts[cell]; entry++) {
          const index = this.entries[cell * this.rectangles.length + entry];
          const rect = this.rectangles[index];
          const dx = (rect.left + rect.right) / 2 - x, dy = (rect.top + rect.bottom) / 2 - y;
          const distance = dx * dx + dy * dy;
          if (distance > limit) continue;
          let seen = false;
          for (let k = 0; k < count; k++) if (out[k] === index) seen = true;
          if (seen) continue;
          let slot = count;
          if (slot === out.length) {
            if (distance >= distances[slot - 1]) continue;
            slot--;
          } else count++;
          while (slot > 0 && distances[slot - 1] > distance) {
            out[slot] = out[slot - 1];
            distances[slot] = distances[slot - 1];
            slot--;
          }
          out[slot] = index;
          distances[slot] = distance;
        }
      }
    }
    return count;
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
