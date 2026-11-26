/** Read view of a time series (oldest first), implemented by SeriesRing and plain arrays. */
export interface SeriesLike {
  readonly length: number;
  timeAt(i: number): number;
  valueAt(i: number): number;
}

/** Wraps `{time, value}[]` (tests, computed math channels) as a SeriesLike. */
export function seriesOf(points: { time: number; value: number }[]): SeriesLike {
  return {
    get length() {
      return points.length;
    },
    timeAt: (i) => points[i].time,
    valueAt: (i) => points[i].value,
  };
}

/** Index of the first sample with time >= t (length when none). Times must be non-decreasing. */
export function lowerBound(s: SeriesLike, t: number): number {
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s.timeAt(mid) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Last value at or before t, or undefined. */
export function sampleAt(s: SeriesLike | undefined, t: number): number | undefined {
  if (!s || s.length === 0) return undefined;
  const i = lowerBound(s, t);
  if (i < s.length && s.timeAt(i) === t) return s.valueAt(i);
  return i === 0 ? undefined : s.valueAt(i - 1);
}

export function lastValue(s: SeriesLike | undefined): number | undefined {
  return s && s.length > 0 ? s.valueAt(s.length - 1) : undefined;
}

/**
 * Fixed-capacity time series in two Float64Arrays: push is O(1) and allocation-free;
 * the oldest samples are overwritten. `version` changes on every push.
 */
export class SeriesRing implements SeriesLike {
  private readonly times: Float64Array;
  private readonly values: Float64Array;
  private start = 0;
  private count = 0;
  public version = 0;

  constructor(public readonly capacity: number) {
    this.times = new Float64Array(capacity);
    this.values = new Float64Array(capacity);
  }

  get length() {
    return this.count;
  }

  public push(time: number, value: number) {
    // Out-of-order samples (e.g. a source restart) start a new series instead of breaking the binary search.
    if (this.count > 0 && time < this.timeAt(this.count - 1)) this.clear();
    const idx = (this.start + this.count) % this.capacity;
    this.times[idx] = time;
    this.values[idx] = value;
    if (this.count < this.capacity) this.count++;
    else this.start = (this.start + 1) % this.capacity;
    this.version++;
  }

  public timeAt(i: number): number {
    return this.times[(this.start + i) % this.capacity];
  }

  public valueAt(i: number): number {
    return this.values[(this.start + i) % this.capacity];
  }

  public toArray(fromTime = -Infinity): { time: number; value: number }[] {
    const out: { time: number; value: number }[] = [];
    for (let i = lowerBound(this, fromTime); i < this.count; i++) out.push({ time: this.timeAt(i), value: this.valueAt(i) });
    return out;
  }

  public clear() {
    this.start = 0;
    this.count = 0;
    this.version++;
  }
}

/** Fixed-capacity FIFO of objects; push is O(1), the oldest entry is dropped. */
export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  private start = 0;
  private count = 0;

  constructor(public readonly capacity: number) {
    this.items = new Array<T | undefined>(capacity);
  }

  get length() {
    return this.count;
  }

  public push(item: T) {
    const idx = (this.start + this.count) % this.capacity;
    this.items[idx] = item;
    if (this.count < this.capacity) this.count++;
    else this.start = (this.start + 1) % this.capacity;
  }

  public at(i: number): T {
    return this.items[(this.start + i) % this.capacity] as T;
  }

  public toArray(): T[] {
    const out: T[] = new Array<T>(this.count);
    for (let i = 0; i < this.count; i++) out[i] = this.at(i);
    return out;
  }

  public clear() {
    this.items.fill(undefined);
    this.start = 0;
    this.count = 0;
  }
}
