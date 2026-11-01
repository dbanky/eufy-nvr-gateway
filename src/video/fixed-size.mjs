// Cuts a byte stream into pieces of one fixed size (raw pictures, thumbnails), however the bytes
// arrive. A piece is its own copy: later chunks never change it.
export class FixedSizeSplitter {
  constructor(size) {
    this.size = size;
    this.pending = [];
    this.have = 0;
  }

  // Returns the whole pieces completed by this chunk (often none).
  push(chunk) {
    this.pending.push(chunk);
    this.have += chunk.length;
    if (this.have < this.size) return [];
    const all = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending);
    const whole = Math.floor(all.length / this.size);
    const pieces = [];
    for (let i = 0; i < whole; i++) pieces.push(Buffer.from(all.subarray(i * this.size, (i + 1) * this.size)));
    const rest = all.subarray(whole * this.size);
    this.pending = rest.length ? [Buffer.from(rest)] : [];
    this.have = rest.length;
    return pieces;
  }
}
