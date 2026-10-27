<template>
  <section class="rcs-section">
    <div class="rcs-head">
      <span class="rcs-head__bar" aria-hidden="true" />
      <h2 class="rcs-head__text">资源合集</h2>
      <span class="rcs-head__count">{{ total }} 个精选资源</span>
    </div>

    <div class="rcs-cats">
      <button
        type="button"
        :class="['rcs-cat', { 'rcs-cat--on': activeCat === 'all' }]"
        @click="activeCat = 'all'">
        全部 {{ total }}
      </button>
      <button
        v-for="cat in cats"
        :key="cat.key"
        type="button"
        :class="['rcs-cat', { 'rcs-cat--on': activeCat === cat.key }]"
        @click="activeCat = activeCat === cat.key ? 'all' : cat.key">
        {{ cat.emoji }} {{ cat.label }} {{ countOf(cat.key) }}
      </button>
    </div>

    <div v-if="visible.length" class="rcs-list">
      <a
        v-for="item in visible"
        :key="item.u"
        class="rcs-item"
        :href="item.u"
        target="_blank"
        rel="noopener noreferrer">
        <img class="rcs-item__icon" :src="xunleiIcon" alt="" width="18" height="18" loading="lazy" />
        <span class="rcs-item__name">{{ item.t }}</span>
        <span class="rcs-item__go">去保存 <span aria-hidden="true">→</span></span>
      </a>
    </div>
    <div v-else-if="loaded" class="rcs-empty">该分类暂无资源</div>

    <div v-if="loaded && visible.length < filtered.length" class="rcs-more">
      <button type="button" class="rcs-more__btn" @click="visibleCount += BATCH">
        加载更多（还有 {{ filtered.length - visible.length }} 个）
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * 资源合集区块（对齐官方站 2026-10-12）：迁移的 1849 个精选资源直接放首页。
 * 数据跨域取官方站 /resource-data/collection.json（CORS 已放开），
 * 客户端懒加载（idle 时拉取），模块级缓存防重复请求。
 */
import { computed, onMounted, ref } from "vue";
import { CURATED_CATEGORIES } from "../config/curatedCategories";
import { PLATFORM_INFO } from "../config/platforms";
import { API_BASE } from "../config";
import { isPromotionalLink } from "../utils/promotionalLinks";

interface CollectionItem {
  t: string;
  u: string;
  c: string;
}
interface CollectionPayload {
  total: number;
  items: CollectionItem[];
}

const BATCH = 20;
const items = ref<CollectionItem[]>([]);
const loaded = ref(false);
const activeCat = ref("all");
const visibleCount = ref(BATCH);

let cache: CollectionItem[] | null = null;

const xunleiIcon = PLATFORM_INFO.xunlei?.icon || PLATFORM_INFO.others.icon;

const cats = computed(() =>
  CURATED_CATEGORIES.filter((c) => items.value.some((it) => (it.c || "hot") === c.key))
);
const countOf = (key: string) => items.value.filter((it) => (it.c || "hot") === key).length;
const total = computed(() => items.value.length);

const filtered = computed(() =>
  activeCat.value === "all"
    ? items.value
    : items.value.filter((it) => (it.c || "hot") === activeCat.value)
);
const visible = computed(() => filtered.value.slice(0, visibleCount.value));

async function load() {
  if (cache) {
    items.value = cache;
    loaded.value = true;
    return;
  }
  try {
    // API_BASE 形如 https://panhub.shenzjd.com/api → 数据在同源根路径下
    const origin = API_BASE.replace(/\/api\/?$/, "");
    const res = await fetch(`${origin}/resource-data/collection.json`);
    const data: CollectionPayload = await res.json();
    cache = Array.isArray(data?.items) ? data.items.filter((item) => !isPromotionalLink(item.u) && !isPromotionalLink(item.t)) : [];
  } catch {
    cache = [];
  }
  items.value = cache;
  loaded.value = true;
}

onMounted(() => {
  const ric = (window as any).requestIdleCallback as
    | ((cb: () => void, opts?: { timeout: number }) => number)
    | undefined;
  if (ric) ric(() => void load(), { timeout: 3000 });
  else setTimeout(() => void load(), 1200);
});
</script>

<style scoped>
.rcs-section {
  background: var(--bg-primary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  padding: 14px;
}

.rcs-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 4px 8px;
}

.rcs-head__bar {
  flex: none;
  width: 3px;
  height: 14px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--primary) 0%, var(--secondary) 100%);
}

.rcs-head__text {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
}

.rcs-head__count {
  font-size: 12px;
  color: var(--text-tertiary);
}

.rcs-cats {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding: 0 4px 10px;
}

.rcs-cat {
  padding: 4px 12px;
  border: 1px solid var(--border-light);
  background: var(--bg-secondary);
  border-radius: 999px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.rcs-cat:hover {
  color: var(--primary);
  border-color: var(--primary);
}

.rcs-cat--on {
  color: #fff;
  background: linear-gradient(135deg, var(--primary), var(--secondary));
  border-color: transparent;
}

.rcs-list {
  border-top: 1px solid var(--border-light);
}

.rcs-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 4px;
  border-bottom: 1px solid var(--border-light);
  text-decoration: none;
  transition: background-color var(--transition-fast);
}

.rcs-item:last-child {
  border-bottom: none;
}

.rcs-item:hover {
  background: var(--bg-secondary);
}

.rcs-item__icon {
  flex: none;
  width: 18px;
  height: 18px;
  margin-top: 2px;
  border-radius: 4px;
  object-fit: contain;
}

.rcs-item__name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--text-primary);
  word-break: break-word;
}

.rcs-item:hover .rcs-item__name {
  color: var(--primary);
}

.rcs-item__go {
  flex: none;
  margin-left: auto;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
  white-space: nowrap;
}

.rcs-item:hover .rcs-item__go {
  color: var(--primary);
}

.rcs-empty {
  padding: 24px 0;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
}

.rcs-more {
  display: flex;
  justify-content: center;
  padding-top: 12px;
}

.rcs-more__btn {
  padding: 8px 22px;
  border: 1px solid var(--border-light);
  background: var(--bg-secondary);
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.rcs-more__btn:hover {
  color: var(--primary);
  border-color: var(--primary);
}
</style>
