/** 静默初始化上游匿名票据，不提供交互式登录。 */
import { WX_AUTH_API_BASE, WX_AUTH_SDK_URLS } from "../config";

/** wx-auth-sdk UMD 暴露的全局单例接口（只列本工程用到的） */
export interface WxAuthSDK {
  init(options?: Record<string, any>): void;
  /**
   * 匿名票据（SDK ≥1.2.44，2026-09-24 访客准入）：
   * init() 时已自动预签一张票存 localStorage（180 天有效），
   * 这里取现成的（签发失败/断网返回 null —— fail-open）。
   * 旧版本 SDK 没有该方法（运行时用可选调用兜底）。
   */
  getOrCreateAnonTicket?: () => Promise<string | null>;
}

declare global {
  interface Window {
    WxAuth?: WxAuthSDK;
  }
}

const SDK_SCRIPT_ID = "wx-auth-sdk-umd";
const TOKEN_COOKIE = "wxauth-token";

// ===== SDK 加载 =====

let sdkPromise: Promise<WxAuthSDK> | null = null;

/** Load the anonymous-ticket SDK, falling back when a CDN is unavailable. */
export function resolveWxAuth(): Promise<WxAuthSDK> {
  if (window.WxAuth) return Promise.resolve(window.WxAuth);
  if (sdkPromise) return sdkPromise;
  sdkPromise = (async () => {
    for (const url of WX_AUTH_SDK_URLS) {
      await new Promise<void>((resolve) => {
        const script = document.createElement("script");
        script.id = SDK_SCRIPT_ID;
        script.src = url;
        const timer = setTimeout(finish, 6000);
        function finish() {
          clearTimeout(timer);
          script.onload = null;
          script.onerror = null;
          if (!window.WxAuth) script.remove();
          resolve();
        }
        script.onload = finish;
        script.onerror = finish;
        document.head.appendChild(script);
      });
      if (window.WxAuth) return window.WxAuth;
    }
    throw new Error("匿名票据 SDK 加载失败");
  })().catch((error) => {
    sdkPromise = null;
    throw error;
  });
  return sdkPromise;
}

// ---------------------------------------------------------------------------
// 匿名票据（对齐官方站 2026-09-24 访客准入）
//
// 搜索对未登录访客放开后，建 SSE 连接前要把票据拼在 URL ?at= 上。刻意不走
// Cookie：跨站部署写不回 Cookie，统一 localStorage + URL 参数；且流式连接
// 不能靠「401 再补签重试」（EventSource/fetch 流遇错重连会抖成风暴），
// 票必须在建连前就位（init 预签已保证，这里只是取现成的）。
// ---------------------------------------------------------------------------

const ANON_TICKET_RETRY_MS = 60_000;
let anonTicketPromise: Promise<string | null> | null = null;
let anonTicketFailedAt = 0;

/**
 * 安全获取匿名票据（任何失败返回 null —— fail-open，是否放行无票请求由
 * 服务端定夺：观察期放行 + 记日志）。失败缓存 60s，防每次搜索都空撞 SDK。
 */
export async function getAnonTicketSafe(timeoutMs = 3000): Promise<string | null> {
  if (typeof window === "undefined") return null;
  if (anonTicketPromise) return anonTicketPromise;
  if (Date.now() - anonTicketFailedAt < ANON_TICKET_RETRY_MS) return null;
  anonTicketPromise = (async () => {
    try {
      const WxAuth = await resolveWxAuth();
      const fn = WxAuth.getOrCreateAnonTicket;
      if (typeof fn !== "function") {
        // 旧版 SDK（<1.2.44）：无票据能力，按无票处理
        return null;
      }
      const t = await Promise.race([
        Promise.resolve(fn.call(WxAuth)),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      if (typeof t !== "string" || t.length === 0) {
        throw new Error("匿名票据签发失败或为空");
      }
      return t;
    } catch (e) {
      anonTicketFailedAt = Date.now();
      console.warn("[wx-auth] 匿名票据获取失败（按无票请求发送）", e);
      return null;
    } finally {
      anonTicketPromise = null; // 允许下次调用重试（成功路径读 localStorage，开销极小）
    }
  })();
  return anonTicketPromise;
}

// ===== token 读写 =====

/** 从本域 Cookie 读取登录凭证（SDK 登录成功时写入） */
export function getToken(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${TOKEN_COOKIE}=([^;]*)`)
  );
  return match && match[1] ? decodeURIComponent(match[1]) : null;
}

/** Initialize the SDK silently so it can issue anonymous search tickets. */
export function initAuth(): void {
  void resolveWxAuth()
    .then((sdk) => sdk.init({ apiBase: WX_AUTH_API_BASE, silent: true }))
    .catch(() => console.warn("匿名票据 SDK 不可用"));
}
