import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

interface Bucket { count: number; reset: number }

/** X-Real-IP is set by our local Nginx; never trust X-Forwarded-For. */
export function clientAddress(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress || "unknown";
  const local = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  const header = req.headers["x-real-ip"];
  return local && typeof header === "string" && isIP(header) ? header : peer;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private readonly maxBuckets = 10000, private readonly now: () => number = Date.now) {}
  take(key: string, limit: number, windowMs: number): number {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.reset <= now) {
      this.buckets.delete(key);
      while (this.buckets.size >= this.maxBuckets) {
        const oldest = this.buckets.keys().next().value;
        if (oldest === undefined) break;
        this.buckets.delete(oldest);
      }
      bucket = { count: 0, reset: now + windowMs };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= limit) return Math.max(1, Math.ceil((bucket.reset - now) / 1000));
    bucket.count++;
    return 0;
  }
}
