import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { load } from "cheerio";
import { MemoryCache } from "../src/core/cache/memoryCache";
import { fetchTgChannelPosts, parseChannelPage } from "../src/core/services/tg";
import { withTimeout } from "../src/core/utils/timeout";
import { requestFetch, runWithNetworkContext } from "../src/core/utils/networkContext";
import { PluginManager, BaseAsyncPlugin } from "../src/core/plugins/manager";
import { SearchService } from "../src/core/services/searchService";
import { RateLimiter, clientAddress } from "../src/rateLimit";

test("LRU cache evicts old entries, tracks bytes on overwrite, rejects oversized values and expires", () => {
  const cache = new MemoryCache<string>({ maxSize: 2, maxMemoryBytes: 20, cleanupInterval: 100000 });
  cache.set("a", "aaaa", 10000);
  cache.set("b", "bb", 10000);
  assert.equal(cache.memoryUsage, 12);
  assert.equal(cache.get("a").hit, true);
  cache.set("c", "c", 10000);
  assert.equal(cache.get("b").hit, false);
  assert.equal(cache.get("a").hit, true);
  cache.set("a", "a", 10000);
  assert.equal(cache.memoryUsage, 4);
  cache.set("huge", "x".repeat(100), 10000);
  assert.equal(cache.get("huge").hit, false);
  cache.set("expired", "e", 0);
  cache.forceCleanup();
  assert.equal(cache.get("expired").hit, false);
});

test("Telegram parser extracts magnet and nested share links without accepting lookalike domains", () => {
  const html = `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="news/123"><div class="tgme_widget_message_text">电影 资源 提取码: abcd magnet:?xt=urn:btih:0123456789012345678901234567890123456789 <a href="https://t.me/share/url?url=https%3A%2F%2Fpan.quark.cn%2Fs%2F12345">资源</a> https://evilalipan.com/s/fake</div><time datetime="invalid"></time></div></div>`;
  const results = parseChannelPage(load(html), "news", "电影", 10);
  assert.equal(results.length, 1);
  assert.equal(results[0].datetime, "");
  assert.deepEqual(results[0].links.map(x => x.type).sort(), ["magnet", "quark"]);
  assert.equal(results[0].links.find(x => x.type === "quark")?.password, "abcd");
});

test("Telegram search sends the keyword on every page and preserves it for the mirror", async () => {
  const calls: string[] = [];
  const page = (id: number, more: boolean) => `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="news/${id}"><div class="tgme_widget_message_text">王楚然 <a href="https://pan.quark.cn/s/${id}">资源</a></div></div></div>${more ? '<a href="/s/news?q=ignored&amp;before=123">more</a>' : ''}`;
  const results = await fetchTgChannelPosts("news", "王楚然", {
    limitPerChannel: 40,
    fetchPage: async (url) => {
      calls.push(url);
      if (calls.length === 1) throw new Error("direct unavailable");
      return calls.length === 2 ? page(1, true) : page(2, false);
    },
  });
  assert.equal(results.length, 2);
  const direct = new URL(calls[0]);
  const mirror = new URL(calls[1]);
  const next = new URL(calls[2]);
  assert.equal(direct.searchParams.get("q"), "王楚然");
  assert.equal(mirror.searchParams.get("q"), "王楚然");
  assert.equal(next.searchParams.get("q"), "王楚然");
  assert.equal(next.searchParams.get("before"), "123");
});

test("timeout and cancellation abort underlying HTTP requests", async (t) => {
  let closed = false;
  const upstream = http.createServer((_req, res) => { res.on("close", () => { closed = true; }); });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => upstream.close());
  const url = `http://127.0.0.1:${(upstream.address() as any).port}/`;
  const start = Date.now();
  await assert.rejects(withTimeout(async signal => {
    const activity = { signal, attempts: 0, successes: 0 };
    return runWithNetworkContext(activity, () => requestFetch(url, { retry: 0 }));
  }, 1000));
  for (let i = 0; i < 50 && !closed; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(closed, true);
  assert.ok(Date.now() - start < 3500);
});

test("source failures open the circuit without treating empty successful sources as failures", async (t) => {
  let requests = 0;
  const upstream = http.createServer((_req, res) => { requests++; res.writeHead(503); res.end("error"); });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => upstream.close());
  const url = `http://127.0.0.1:${(upstream.address() as any).port}/`;
  class Broken extends BaseAsyncPlugin {
    constructor() { super("broken", 1); }
    override async search() { await requestFetch(url, { retry: 0 }).catch(() => null); return []; }
  }
  const pm = new PluginManager(); pm.registerPlugin(new Broken());
  const service = new SearchService({ priorityChannels: [], defaultChannels: [], defaultConcurrency: 1, pluginTimeoutMs: 3000, cacheEnabled: false, cacheTtlMinutes: 1 }, pm);
  for (let i = 0; i < 6; i++) await service.searchWithWarnings("example", undefined, 1, false, "merged_by_type", "plugin", undefined, undefined, {});
  assert.equal(requests, 5);
  assert.equal(service.getPluginHealthStatus()[0].isHealthy, false);
});

test("rate limits reset by window, bound memory, and do not trust forwarded-for", () => {
  let time = 1000;
  const limiter = new RateLimiter(2, () => time);
  assert.equal(limiter.take("a", 2, 1000), 0);
  assert.equal(limiter.take("a", 2, 1000), 0);
  assert.equal(limiter.take("a", 2, 1000), 1);
  time += 1000;
  assert.equal(limiter.take("a", 2, 1000), 0);
  limiter.take("b", 2, 1000); limiter.take("c", 2, 1000);
  assert.equal(limiter.take("a", 2, 1000), 0);
  const req = { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-real-ip": "203.0.113.5", "x-forwarded-for": "198.51.100.7" } } as any;
  assert.equal(clientAddress(req), "203.0.113.5");
  req.socket.remoteAddress = "203.0.113.10";
  assert.equal(clientAddress(req), "203.0.113.10");
});

test("build metadata cache expires and invalidates only the stale value", async () => {
  const { ExpiringValue } = await import("../src/core/utils/expiringValue");
  let now = 0;
  const cache = new ExpiringValue<string>(1000, () => now);
  assert.equal(cache.get(), undefined);
  cache.set("first");
  assert.equal(cache.get(), "first");
  cache.set("newer");
  cache.invalidateIf("first");
  assert.equal(cache.get(), "newer");
  cache.invalidateIf("newer");
  assert.equal(cache.get(), undefined);
  cache.set("latest");
  now = 1000;
  assert.equal(cache.get(), undefined);
});

test("client cancellation skips queued search sources and is not counted as source failure", async () => {
  const pm = new PluginManager();
  let started = 0;
  class Waiting extends BaseAsyncPlugin {
    constructor(name: string) { super(name, 1); }
    override async search(_keyword: string, _ext?: Record<string, any>) {
      started++;
      const { currentNetworkSignal } = await import("../src/core/utils/networkContext");
      const signal = currentNetworkSignal()!;
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return [];
    }
  }
  pm.registerPlugin(new Waiting("one")); pm.registerPlugin(new Waiting("two"));
  const service = new SearchService({ priorityChannels: [], defaultChannels: [], defaultConcurrency: 1, pluginTimeoutMs: 3000, cacheEnabled: false, cacheTtlMinutes: 1 }, pm);
  const controller = new AbortController();
  const search = service.searchWithWarnings("example", undefined, 1, false, "merged_by_type", "plugin", undefined, undefined, {}, controller.signal);
  for (let i = 0; i < 20 && !started; i++) await new Promise(r => setTimeout(r, 10));
  controller.abort();
  await assert.rejects(search);
  assert.equal(started, 1);
  assert.equal(service.getPluginHealthStatus().length, 0);
});

test("Pansearch caches its build ID and refreshes it after a stale 404", async () => {
  const { PansearchPlugin } = await import("../src/core/plugins/pansearch");
  let homeCalls = 0;
  let staleCalls = 0;
  let freshCalls = 0;
  const fetcher = async (url: string) => {
    if (url.endsWith("/search")) {
      homeCalls++;
      return `{"buildId":"${homeCalls === 1 ? "old" : "new"}"}`;
    }
    if (url.includes("/_next/data/old/")) {
      staleCalls++;
      throw Object.assign(new Error("stale"), { statusCode: 404 });
    }
    if (url.includes("/_next/data/new/")) {
      freshCalls++;
      return { pageProps: { data: { data: [{ id: 1, content: '<a href="https://pan.quark.cn/s/abc">名称：test</a>' }] } } };
    }
    throw new Error("unexpected URL");
  };
  const plugin = new PansearchPlugin(fetcher as any);
  assert.equal((await plugin.search("test")).length, 1);
  assert.equal((await plugin.search("test2")).length, 1);
  assert.equal(homeCalls, 2);
  assert.equal(staleCalls, 1);
  assert.equal(freshCalls, 2);
});

test("a source with a successful empty response stays healthy", async (t) => {
  const upstream = http.createServer((_req, res) => { res.writeHead(200); res.end("no results"); });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(() => upstream.close());
  const url = `http://127.0.0.1:${(upstream.address() as any).port}/`;
  class Empty extends BaseAsyncPlugin {
    constructor() { super("empty", 1); }
    override async search() { await requestFetch(url, { retry: 0 }); return []; }
  }
  const pm = new PluginManager(); pm.registerPlugin(new Empty());
  const service = new SearchService({ priorityChannels: [], defaultChannels: [], defaultConcurrency: 1, pluginTimeoutMs: 3000, cacheEnabled: false, cacheTtlMinutes: 1 }, pm);
  for (let i = 0; i < 6; i++) await service.searchWithWarnings("example", undefined, 1, false, "merged_by_type", "plugin", undefined, undefined, {});
  assert.equal(service.getPluginHealthStatus()[0].isHealthy, true);
  assert.equal(service.getPluginHealthStatus()[0].failureCount, 0);
});

test("invalid dates sort after valid recent results", async () => {
  class Dates extends BaseAsyncPlugin {
    constructor() { super("dates", 1); }
    override async search() {
      return ["invalid", "2025-01-01", "2026-01-01"].map((date, i) => ({
        message_id: "", unique_id: String(i), channel: "", datetime: date, title: date, content: "", links: [{type: "baidu", url: `https://pan.baidu.com/s/${i}`, password: ""}],
      }));
    }
  }
  const pm = new PluginManager(); pm.registerPlugin(new Dates());
  const service = new SearchService({ priorityChannels: [], defaultChannels: [], defaultConcurrency: 1, pluginTimeoutMs: 3000, cacheEnabled: false, cacheTtlMinutes: 1 }, pm);
  const { response } = await service.searchWithWarnings("example", undefined, 1, false, "merged_by_type", "plugin", undefined, undefined, {});
  assert.deepEqual(response.merged_by_type?.baidu.map(x => x.note), ["2026-01-01", "2025-01-01", "invalid"]);
});
