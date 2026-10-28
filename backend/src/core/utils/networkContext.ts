import { AsyncLocalStorage } from "node:async_hooks";
import { ofetch } from "ofetch";

export interface NetworkActivity {
  signal: AbortSignal;
  attempts: number;
  successes: number;
}

const networkContext = new AsyncLocalStorage<NetworkActivity>();

export function runWithNetworkContext<T>(activity: NetworkActivity, task: () => Promise<T>): Promise<T> {
  return networkContext.run(activity, task);
}

export function currentNetworkSignal(): AbortSignal | undefined {
  return networkContext.getStore()?.signal;
}

/** All inherited plugins use this wrapper so cancellation reaches their HTTP calls. */
export async function requestFetch<T>(url: string, options: any = {}): Promise<T> {
  const context = networkContext.getStore();
  const inherited = context?.signal;
  const explicit = options.signal as AbortSignal | undefined;
  const signal = inherited && explicit && inherited !== explicit
    ? AbortSignal.any([inherited, explicit]) : inherited || explicit;
  signal?.throwIfAborted();
  if (context) context.attempts++;
  const result = await ofetch<T>(url, { ...options, signal });
  if (context) context.successes++;
  return result;
}
