import test from "node:test";
import assert from "node:assert/strict";
import { useSearch } from "../src/composables/useSearch";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("search time advances while searching, pauses, resumes, and resets", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  globalThis.fetch = async (_input, options) => {
    const signal = options?.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streams.push(controller);
        signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  };
  const search = useSearch();
  const first = search.performSearch({ keyword: "test" });
  await sleep(250);
  assert.ok(search.elapsedMs.value >= 100, "timer updates before the first result");
  search.pauseSearch();
  const paused = search.elapsedMs.value;
  const resume = search.continueSearch({ keyword: "test" });
  await first;
  await sleep(250);
  assert.ok(search.elapsedMs.value >= paused + 100, "timer continues after pause");
  assert.equal(search.deepLoading.value, true, "cancelled search cannot clear resumed state");
  streams[1].enqueue(new TextEncoder().encode('event: done\ndata: {"completedIndices":[],"reachedLimit":false}\n\n'));
  streams[1].close();
  await resume;
  const finished = search.elapsedMs.value;
  await sleep(150);
  assert.equal(search.elapsedMs.value, finished, "timer stops after completion");
  search.resetSearch();
  assert.equal(search.elapsedMs.value, 0);
});
