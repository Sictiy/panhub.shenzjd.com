import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { MergedLinks } from "./core/types/models";

export type SearchTask = { kind: "plugin" | "tg"; channels?: string[] };
export type SearchProvider = (keyword: string, category: string | undefined, task: SearchTask) => Promise<MergedLinks>;

const CATEGORIES = new Set(["quark", "baidu", "xunlei", "uc", "mobile", "tianyi", "aliyun", "115", "123", "magnet"]);
const HOT_KEYWORDS = ["电影", "音乐", "动漫", "电子书", "编程", "摄影", "英语", "学习资料"];

export function buildTasks(priority: string[], channels: string[]): SearchTask[] {
  const all = [...new Set([...priority, ...channels])];
  const tasks: SearchTask[] = [{ kind: "plugin" }];
  for (let i = 0; i < all.length; i += 6) tasks.push({ kind: "tg", channels: all.slice(i, i + 6) });
  return tasks;
}

function json(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString();
    if (Buffer.byteLength(body) > 16384) throw new Error("请求体过大");
  }
  const result = JSON.parse(body || "{}");
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("无效请求");
  return result;
}

function validShareUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  const text = value.trim();
  try {
    const url = new URL(text);
    if (url.protocol === "magnet:") return url.searchParams.has("xt") ? text : null;
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return text;
  } catch { return null; }
}

export function createApp(provider: SearchProvider, tasks: SearchTask[], maxConcurrent = 2) {
  let activeSearches = 0;
  return http.createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://localhost");
    try {
      if (req.method === "GET" && path.pathname === "/api/health") return json(res, 200, { status: "ok" });
      if (req.method === "GET" && path.pathname === "/api/hot-keywords") return json(res, 200, { code: 0, data: { keywords: HOT_KEYWORDS } });
      if (req.method === "GET" && path.pathname === "/api/curated-resources") return json(res, 200, { code: 0, data: { items: [] } });
      if (req.method === "POST" && path.pathname === "/api/check") {
        const body = await readJson(req);
        if (!Array.isArray(body.items) || body.items.length > 50) return json(res, 400, { code: 1, message: "无效的检测列表" });
        const results = body.items.map((item: any) => ({ tid: typeof item?.tid === "string" ? item.tid : undefined, url: validShareUrl(item?.url) || "", status: "unsupported" }));
        return json(res, 200, { code: 0, data: { results } });
      }
      if (req.method === "POST" && path.pathname === "/api/transfer") {
        const body = await readJson(req);
        const url = validShareUrl(body.url);
        if (!url) return json(res, 400, { code: 1, message: "没有可用的原始分享链接" });
        return json(res, 200, { code: 0, data: { share_url: url, passcode: typeof body.password === "string" ? body.password.slice(0, 128) : "", name: typeof body.name === "string" ? body.name.slice(0, 512) : "" } });
      }
      if (req.method === "GET" && path.pathname === "/api/search.stream") {
        const keyword = (path.searchParams.get("kw") || "").trim();
        const category = path.searchParams.get("cat") || undefined;
        if (!keyword || keyword.length > 200 || (category && !CATEGORIES.has(category))) return json(res, 400, { code: 1, message: "搜索参数无效" });
        if (activeSearches >= maxConcurrent) return json(res, 429, { code: 1, message: "搜索繁忙，请稍后重试" });
        const skip = new Set((path.searchParams.get("skipTasks") || "").split(",").filter(x => /^\d{1,3}$/.test(x)).map(Number));
        const initial = Math.max(0, Math.min(10000, Number(path.searchParams.get("initialTotal")) || 0));
        const limit = Math.max(1, Math.min(1000, Number(path.searchParams.get("maxResults")) || 90));
        activeSearches++;
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", "x-content-type-options": "nosniff" });
        res.write(": connected\n\n");
        let closed = false;
        res.on("close", () => { closed = true; });
        const completed: number[] = [];
        const seen = new Set<string>();
        let count = initial;
        let reachedLimit = false;
        const send = (type: string, data: unknown) => { if (!closed) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
        try {
          for (let index = 0; index < tasks.length && !closed; index++) {
            if (skip.has(index)) continue;
            const merged = await provider(keyword, category, tasks[index]);
            if (closed) break;
            completed.push(index);
            for (const entries of Object.values(merged)) {
              for (const item of entries) {
                if (item.url && !seen.has(item.url)) { seen.add(item.url); count++; }
              }
            }
            send("chunk", { merged });
            if (count >= limit && tasks.some((_, next) => next > index && !skip.has(next))) { reachedLimit = true; break; }
          }
          send("done", { completedIndices: completed, reachedLimit });
        } catch {
          send("error", { message: "搜索服务暂时不可用，请稍后重试" });
        } finally {
          activeSearches--;
          if (!closed) res.end();
        }
        return;
      }
      return json(res, 404, { code: 1, message: "接口不存在" });
    } catch (error) {
      return json(res, 400, { code: 1, message: error instanceof SyntaxError ? "无效 JSON" : "请求无效" });
    }
  });
}
