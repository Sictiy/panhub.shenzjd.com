const CJK_PATTERN = /[\u3400-\u9fff]/;
const NOISE_PATTERN =
  /\b(4k|8k|720p|1080p|2160p|hdr|h265|x265|web-dl|webdl|bluray|\u84dd\u5149|\u675c\u6bd4|\u56fd\u8bed|\u4e2d\u5b57|\u53cc\u5b57|\u5168\u96c6|\u5b8c\u7ed3)\b/giu;
const BRACKET_PATTERN =
  /[\u3010\u3011\u300a\u300b\[\]()\uff08\uff09]/g;
const SPLIT_PATTERN = /[\s/|,，、·:：;；!?？！+]+/g;
const CJK_CONNECTOR_PATTERN = /[\u7684\u4e4b\u4e0e\u548c\u53ca]/g;

export function normalizeSearchKeyword(input: string): string {
  return (input || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function buildSearchKeywordVariants(keyword: string): string[] {
  const raw = (keyword || "").trim();
  if (!raw) return [];

  const variants: string[] = [];
  const push = (value: string) => {
    const normalized = normalizeSearchKeyword(value);
    if (normalized.length < 2) return;
    if (variants.some((item) => normalizeSearchKeyword(item) === normalized)) return;
    variants.push(value.trim());
  };

  push(raw);

  const cleaned = raw.replace(BRACKET_PATTERN, " ").replace(NOISE_PATTERN, " ");
  push(cleaned);

  const compact = cleaned.replace(SPLIT_PATTERN, " ");
  push(compact);

  if (CJK_PATTERN.test(raw)) {
    const cjkParts = cleaned
      .replace(CJK_CONNECTOR_PATTERN, " ")
      .split(SPLIT_PATTERN)
      .map((part) => part.trim())
      .filter(Boolean);

    if (cjkParts.length > 1) {
      push(cjkParts.join(" "));
    }

    for (const part of cjkParts) {
      push(part);
    }
  }

  return variants.slice(0, 6);
}

export function matchesSearchKeyword(text: string, keyword: string): boolean {
  const source = (text || "").trim();
  if (!keyword.trim()) return true;
  if (!source) return false;

  const normalizedSource = normalizeSearchKeyword(source);
  if (!normalizedSource) return false;

  return buildSearchKeywordVariants(keyword).some((variant) =>
    normalizedSource.includes(normalizeSearchKeyword(variant))
  );
}
