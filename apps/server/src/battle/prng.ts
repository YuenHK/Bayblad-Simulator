const UINT32_LIMIT = 0x1_0000_0000;

/** Small deterministic Mulberry32 generator. It never reads ambient time or entropy. */
export class DeterministicPrng {
  #state: number;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed >= UINT32_LIMIT) {
      throw new RangeError("seed must be a safe uint32 integer");
    }
    this.#state = seed >>> 0;
  }

  nextFloat(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let value = this.#state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / UINT32_LIMIT;
  }

  nextRange(minimum: number, maximum: number): number {
    if (
      !Number.isFinite(minimum) ||
      !Number.isFinite(maximum) ||
      maximum <= minimum
    ) {
      throw new RangeError("range bounds must be finite and increasing");
    }
    return minimum + (maximum - minimum) * this.nextFloat();
  }

  nextInt(minimum: number, maximumExclusive: number): number {
    if (
      !Number.isSafeInteger(minimum) ||
      !Number.isSafeInteger(maximumExclusive) ||
      maximumExclusive <= minimum
    ) {
      throw new RangeError("integer range bounds must be safe and increasing");
    }
    return Math.floor(this.nextRange(minimum, maximumExclusive));
  }
}
