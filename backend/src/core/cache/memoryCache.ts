type CacheRecord<T> = { value: T; expireAt: number; size: number };

export interface MemoryCacheOptions {
  maxSize?: number;
  maxMemoryBytes?: number;
  cleanupInterval?: number;
  memoryThreshold?: number;
}

export interface MemoryCacheStats {
  total: number;
  active: number;
  expired: number;
  maxSize: number;
  memoryBytes: number;
  maxMemoryBytes: number;
  memoryUsagePercent: number;
  hits: number;
  misses: number;
  evictions: number;
}

/**
 * 高性能 LRU 内存缓存
 *
 * - Map 插入序即 LRU 序：访问时 delete+re-insert 移到末尾，淘汰从头部取 O(1)
 * - 增量追踪内存：set/remove 时增减 totalMemoryBytes，不再遍历
 * - 插入时估算对象大小，避免低估大搜索结果
 * - 仅 set() 触发周期清理，get() 只清理被访问的那个过期 key
 */
export class MemoryCache<T = unknown> {
  private store = new Map<string, CacheRecord<T>>();
  private totalMemoryBytes = 0;
  private lastCleanup = 0;
  private metrics = { hits: 0, misses: 0, evictions: 0 };
  private options: Required<MemoryCacheOptions>;

  constructor(options: MemoryCacheOptions = {}) {
    this.options = {
      maxSize: options.maxSize ?? 1000,
      maxMemoryBytes: options.maxMemoryBytes ?? 100 * 1024 * 1024,
      cleanupInterval: options.cleanupInterval ?? 5 * 60 * 1000,
      memoryThreshold: options.memoryThreshold ?? 0.8,
    };
  }

  private estimateSize(value: T): number {
    try {
      if (value === null || value === undefined) return 8;
      if (typeof value === "string") return value.length * 2;
      if (typeof value === "number") return 8;
      if (typeof value === "boolean") return 4;
      const encoded = JSON.stringify(value);
      return encoded ? encoded.length * 2 : 64;
    } catch { return 64; }
  }

  private removeEntry(key: string, rec: CacheRecord<T>): void {
    this.store.delete(key);
    this.totalMemoryBytes -= rec.size;
  }

  /** O(1) LRU 淘汰：Map 第一个 entry 即最旧 */
  private evictOne(): void {
    const firstKey = this.store.keys().next().value;
    if (firstKey !== undefined) {
      const rec = this.store.get(firstKey)!;
      this.removeEntry(firstKey, rec);
      this.metrics.evictions++;
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, rec] of this.store) {
      if (rec.expireAt <= now) {
        this.removeEntry(key, rec);
      }
    }
  }

  /** 仅 set() 调用：按 cleanupInterval 周期清理 */
  private maybeCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanup < this.options.cleanupInterval &&
        this.totalMemoryBytes < this.options.maxMemoryBytes * this.options.memoryThreshold) return;
    this.lastCleanup = now;
    this.cleanup();
  }

  get(key: string): { hit: boolean; value?: T } {
    const rec = this.store.get(key);
    if (!rec) {
      this.metrics.misses++;
      return { hit: false };
    }

    if (rec.expireAt <= Date.now()) {
      this.removeEntry(key, rec);
      this.metrics.misses++;
      return { hit: false };
    }

    // LRU refresh: delete + re-insert 移到末尾 O(1)
    this.store.delete(key);
    this.store.set(key, rec);
    this.metrics.hits++;
    return { hit: true, value: rec.value };
  }

  set(key: string, value: T, ttlMs: number): void {
    this.maybeCleanup();

    const existing = this.store.get(key);
    if (existing) {
      this.removeEntry(key, existing);
    }

    const size = this.estimateSize(value);
    if (size > this.options.maxMemoryBytes || this.options.maxSize <= 0) return;
    const record: CacheRecord<T> = {
      value,
      expireAt: Date.now() + Math.max(0, ttlMs),
      size,
    };

    // 淘汰直到有空间
    while (
      (this.store.size >= this.options.maxSize ||
        this.totalMemoryBytes + size > this.options.maxMemoryBytes) &&
      this.store.size > 0
    ) {
      this.evictOne();
    }

    this.store.set(key, record);
    this.totalMemoryBytes += size;
  }

  delete(key: string): void {
    const rec = this.store.get(key);
    if (rec) this.removeEntry(key, rec);
  }

  clear(): void {
    this.store.clear();
    this.totalMemoryBytes = 0;
    this.metrics = { hits: 0, misses: 0, evictions: 0 };
  }

  get size(): number {
    return this.store.size;
  }

  get memoryUsage(): number {
    return this.totalMemoryBytes;
  }

  getStats(): MemoryCacheStats {
    const now = Date.now();
    let active = 0;
    let expired = 0;
    for (const [, rec] of this.store) {
      if (rec.expireAt > now) active++;
      else expired++;
    }
    return {
      total: this.store.size,
      active,
      expired,
      maxSize: this.options.maxSize,
      memoryBytes: this.totalMemoryBytes,
      maxMemoryBytes: this.options.maxMemoryBytes,
      memoryUsagePercent:
        Math.round(
          (this.totalMemoryBytes / this.options.maxMemoryBytes) * 10000
        ) / 100,
      hits: this.metrics.hits,
      misses: this.metrics.misses,
      evictions: this.metrics.evictions,
    };
  }

  forceCleanup(): void {
    this.lastCleanup = 0;
    this.maybeCleanup();
  }
}
