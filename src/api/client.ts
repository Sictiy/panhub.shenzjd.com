/**
 * 统一请求封装
 *
 * 请求通过同域名的 /api/ 代理访问独立后端，不使用登录凭证。
 */
import { API_BASE } from "../config";

export class ApiError extends Error {
  statusCode: number;
  data: any;
  constructor(message: string, statusCode: number, data?: any) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.data = data;
  }
}

/** 拼完整 URL（含查询参数，自动跳过 undefined/null/空串） */
export function apiUrl(
  path: string,
  params?: Record<string, string | number | undefined | null>
): string {
  const url = `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  if (!params) return url;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    q.set(k, String(v));
  }
  const qs = q.toString();
  return qs ? `${url}?${qs}` : url;
}

/** 本地后端不需要认证头。 */
export function authHeaders(): Record<string, string> {
  return {};
}

async function readError(resp: Response): Promise<ApiError> {
  let message = `请求失败（${resp.status}）`;
  let data: any = undefined;
  try {
    data = await resp.json();
    if (data?.message) message = String(data.message);
    else if (data?.statusMessage) message = String(data.statusMessage);
  } catch {}
  return new ApiError(message, resp.status, data);
}

export async function apiGet<T>(
  path: string,
  params?: Record<string, any>,
  init?: RequestInit
): Promise<T> {
  const resp = await fetch(apiUrl(path, params), {
    method: "GET",
    credentials: "omit",
    headers: { accept: "application/json", ...authHeaders() },
    ...init,
  });
  if (!resp.ok) throw await readError(resp);
  return (await resp.json()) as T;
}

export async function apiPost<T>(
  path: string,
  body?: any,
  init?: RequestInit
): Promise<T> {
  const resp = await fetch(apiUrl(path), {
    method: "POST",
    credentials: "omit",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...authHeaders(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init,
  });
  if (!resp.ok) throw await readError(resp);
  return (await resp.json()) as T;
}
