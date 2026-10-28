import channels from "./channels.json";
import { getOrCreateSearchService } from "./core/services/index";
import { buildTasks, createApp } from "./app";

const service = getOrCreateSearchService({
  ...channels,
  defaultConcurrency: 4,
  pluginTimeoutMs: 5000,
  cacheEnabled: true,
});
const tasks = buildTasks(channels.priorityChannels, channels.defaultChannels);
const app = createApp(async (keyword, category, task) => {
  const { response } = await service.searchWithWarnings(
    keyword, task.channels, 4, false, "merged_by_type", task.kind,
    undefined, category ? [category] : undefined, {}
  );
  return response.merged_by_type || {};
}, tasks, 1);
const port = Number(process.env.PANHUB_API_PORT || 4100);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid PANHUB_API_PORT");
app.listen(port, "127.0.0.1", () => console.log(`PanHub API listening on 127.0.0.1:${port}`));
