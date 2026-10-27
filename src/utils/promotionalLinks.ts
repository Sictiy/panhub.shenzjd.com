import type { MergedLinks } from "../types";

// The upstream can substitute its own landing page for a search result.
export function isPromotionalLink(value: string | undefined): boolean {
  return typeof value === "string" && /(?:^|[^a-z0-9.-])(?:[a-z0-9-]+\.)*shenzjd\.com(?=[:/?#\s]|$)/i.test(value);
}

export function filterPromotionalResults(input: MergedLinks): MergedLinks {
  const result: MergedLinks = {};
  for (const [type, items] of Object.entries(input)) {
    const filtered = items.filter((item) => !isPromotionalLink(item.url) && !isPromotionalLink(item.note));
    if (filtered.length) result[type] = filtered;
  }
  return result;
}
