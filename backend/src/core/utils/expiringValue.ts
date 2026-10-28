/** A small TTL cache for non-sensitive upstream metadata. */
export class ExpiringValue<T> {
  private entry: { value: T; expires: number } | null = null;
  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}
  get(): T | undefined {
    if (!this.entry || this.entry.expires <= this.now()) { this.entry = null; return undefined; }
    return this.entry.value;
  }
  set(value: T): T {
    this.entry = { value, expires: this.now() + this.ttlMs };
    return value;
  }
  invalidateIf(value: T): void {
    if (this.entry?.value === value) this.entry = null;
  }
}
