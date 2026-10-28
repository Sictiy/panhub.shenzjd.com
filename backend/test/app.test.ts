import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp, buildTasks } from "../src/app";

const tasks = [{ kind: "plugin" as const }, { kind: "tg" as const, channels: ["priority", "other"] }];

test("builds individually scheduled, deduplicated channels in priority order", () => {
  assert.deepEqual(buildTasks(["priority"], ["priority", "other"]), [
    { kind: "plugin" }, { kind: "tg", channels: ["priority"] }, { kind: "tg", channels: ["other"] },
  ]);
  assert.deepEqual(buildTasks([], ["channel"], ["one", "two", "one"]), [
    { kind: "plugin", plugins: ["one"] }, { kind: "plugin", plugins: ["two"] }, { kind: "tg", channels: ["channel"] },
  ]);
});

test("streams search batches, stops at the limit, and resumes from completed tasks", async (t) => {
  const calls: string[] = [];
  const app = createApp(async (keyword, category, task) => {
    calls.push(`${keyword}:${category}:${task.kind}`);
    return { baidu: [{ url: `https://pan.baidu.com/s/${task.kind}`, password: "1234", note: "资源", datetime: "2026-01-01" }] };
  }, tasks, 2, 1);
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.address() as any).port}`;
  const first = await fetch(`${base}/api/search.stream?kw=test&cat=baidu&maxResults=1`);
  assert.equal(first.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const stream = await first.text();
  assert.match(stream, /event: chunk/);
  assert.match(stream, /"completedIndices":\[0\],"reachedLimit":true/);
  const second = await fetch(`${base}/api/search.stream?kw=test&cat=baidu&skipTasks=0&initialTotal=1&maxResults=2`);
  assert.match(await second.text(), /"completedIndices":\[1\],"reachedLimit":false/);
  assert.deepEqual(calls, ["test:baidu:plugin", "test:baidu:tg"]);
  assert.equal((await fetch(`${base}/api/search.stream?kw=`)).status, 400);
  assert.equal((await fetch(`${base}/api/search.stream?kw=x&cat=bad`)).status, 400);
});

test("streams faster tasks before slow ones and resumes cancelled tasks", async (t) => {
  const calls: string[] = [];
  let cancelled = false;
  const app = createApp(async (_keyword, _category, task, signal) => {
    const name = task.channels![0];
    calls.push(name);
    if (name === "slow" && calls.filter(x => x === name).length === 1) {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
      return { baidu: [] };
    }
    return { baidu: [{ url: `https://pan.baidu.com/s/${name}`, password: "", note: name, datetime: "" }] };
  }, [{ kind: "tg", channels: ["slow"] }, { kind: "tg", channels: ["fast"] }], 1, 2);
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.address() as any).port}`;
  const first = await (await fetch(`${base}/api/search.stream?kw=test&maxResults=1`)).text();
  assert.match(first, /"completedIndices":\[1\],"reachedLimit":true/);
  assert.equal(cancelled, true);
  const second = await (await fetch(`${base}/api/search.stream?kw=test&skipTasks=1&initialTotal=1&maxResults=2`)).text();
  assert.match(second, /"completedIndices":\[0\],"reachedLimit":false/);
  assert.deepEqual(calls, ["slow", "fast", "slow"]);
});

test("returns original links and passwords, rejects unsafe schemes, and reports unchecked links honestly", async (t) => {
  const app = createApp(async () => ({}), []);
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.address() as any).port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const transfer = await post("/api/transfer", { url: "https://pan.baidu.com/s/example", password: "abcd", name: "测试" });
  assert.deepEqual((await transfer.json()).data, { share_url: "https://pan.baidu.com/s/example", passcode: "abcd", name: "测试" });
  assert.equal((await post("/api/transfer", { url: "javascript:alert(1)" })).status, 400);
  assert.equal((await post("/api/transfer", { id: "unresolvable" })).status, 400);
  const check = await post("/api/check", { items: [{ url: "https://pan.baidu.com/s/example" }] });
  assert.equal((await check.json()).data.results[0].status, "unsupported");
});

test("limits concurrent searches and releases the slot after completion", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const app = createApp(async () => { await gate; return {}; }, [{ kind: "plugin" }], 1);
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => { release(); app.close(); });
  const base = `http://127.0.0.1:${(app.address() as any).port}`;
  const first = await fetch(`${base}/api/search.stream?kw=one`);
  assert.equal((await fetch(`${base}/api/search.stream?kw=two`)).status, 429);
  release();
  await first.text();
  assert.equal((await fetch(`${base}/api/search.stream?kw=three`)).status, 200);
});

test("disconnect aborts the active provider and frees the search slot", async (t) => {
  let aborted = false;
  const app = createApp(async (keyword, _category, _task, signal) => {
    if (keyword !== "cancel") return {};
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    return {};
  }, [{ kind: "plugin" }], 1);
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.address() as any).port}`;
  const response = await fetch(`${base}/api/search.stream?kw=cancel`);
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  for (let i = 0; i < 20 && !aborted; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(aborted, true);
  assert.equal((await fetch(`${base}/api/search.stream?kw=next`)).status, 200);
});

test("search rate limit returns Retry-After while unrelated health checks remain available", async (t) => {
  const app = createApp(async () => ({}), []);
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.address() as any).port}`;
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${base}/api/search.stream?kw=test`, { headers: { "X-Forwarded-For": String(i) } });
    assert.equal(res.status, 200);
    await res.text();
  }
  const limited = await fetch(`${base}/api/search.stream?kw=test`, { headers: { "X-Forwarded-For": "another-forged-address" } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});
