import { NEWS_BOARD_DEFAULT_LIMIT } from "../contracts/core/news.js";

export function normalizeNewsUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function compareNewsArticles(left, right) {
  const timeDifference = Date.parse(right?.publishedAt) - Date.parse(left?.publishedAt);
  if (Number.isFinite(timeDifference) && timeDifference !== 0) return timeDifference;
  const leftId = String(left?.id || "");
  const rightId = String(right?.id || "");
  if (leftId !== rightId) return leftId < rightId ? -1 : 1;
  const leftUrl = String(left?.url || "");
  const rightUrl = String(right?.url || "");
  return leftUrl === rightUrl ? 0 : (leftUrl < rightUrl ? -1 : 1);
}

export function sortNewsArticles(articles) {
  return [...(Array.isArray(articles) ? articles : [])].sort(compareNewsArticles);
}

export function newsArticleKey(article) {
  const url = normalizeNewsUrl(article?.url);
  if (url) return `url:${url}`;
  const id = typeof article?.id === "string" ? article.id.trim() : "";
  return id ? `id:${id}` : null;
}

export function deduplicateNewsArticles(articles) {
  const groups = new Set();
  const groupsById = new Map();
  const groupsByUrl = new Map();

  for (const article of sortNewsArticles(articles)) {
    const id = typeof article?.id === "string" ? article.id.trim() : "";
    const normalizedUrl = normalizeNewsUrl(article.url);
    if (!id && !normalizedUrl) continue;

    const matching = [...new Set([
      id ? groupsById.get(id) : null,
      normalizedUrl ? groupsByUrl.get(normalizedUrl) : null,
    ].filter(Boolean))].sort((left, right) => compareNewsArticles(left.article, right.article));

    let group = matching[0];
    if (!group) {
      group = {
        article: {
          ...article,
          ...(normalizedUrl ? { url: normalizedUrl } : {}),
          instrumentIds: [],
        },
        ids: new Set(),
        instrumentIds: new Set(),
        urls: new Set(),
      };
      groups.add(group);
    }

    for (const duplicate of matching.slice(1)) {
      duplicate.ids.forEach((key) => {
        group.ids.add(key);
        groupsById.set(key, group);
      });
      duplicate.urls.forEach((key) => {
        group.urls.add(key);
        groupsByUrl.set(key, group);
      });
      duplicate.instrumentIds.forEach((instrumentId) => group.instrumentIds.add(instrumentId));
      groups.delete(duplicate);
    }

    for (const instrumentId of article.instrumentIds || []) group.instrumentIds.add(instrumentId);
    if (id) {
      group.ids.add(id);
      groupsById.set(id, group);
    }
    if (normalizedUrl) {
      group.urls.add(normalizedUrl);
      groupsByUrl.set(normalizedUrl, group);
    }
  }

  return sortNewsArticles([...groups].map((group) => ({
    ...group.article,
    instrumentIds: [...group.instrumentIds].sort(),
  })));
}

function asFeeds(value) {
  if (Array.isArray(value)) {
    if (value.every((item) => item && Array.isArray(item.articles))) return value;
    const byInstrument = new Map();
    for (const article of value) {
      for (const instrumentId of article?.instrumentIds || []) {
        if (!byInstrument.has(instrumentId)) byInstrument.set(instrumentId, []);
        byInstrument.get(instrumentId).push(article);
      }
    }
    return [...byInstrument].map(([instrumentId, articles]) => ({ instrumentId, articles }));
  }
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function requestedLimit(value) {
  const candidate = typeof value === "object" && value !== null ? value.limit : value;
  const parsed = Number(candidate ?? NEWS_BOARD_DEFAULT_LIMIT);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : NEWS_BOARD_DEFAULT_LIMIT;
}

export function selectBalancedNewsArticles(value, options = {}) {
  const feeds = asFeeds(value);
  const limit = requestedLimit(options);
  if (!feeds.length || limit <= 0) return [];

  const allArticles = deduplicateNewsArticles(feeds.flatMap((feed) => feed?.articles || []));
  const selectedKeys = new Set();
  const representatives = [];
  const instrumentIds = [...new Set(feeds.map((feed) => feed?.instrumentId).filter(Boolean))].sort();

  for (const instrumentId of instrumentIds) {
    const article = allArticles.find((candidate) => candidate.instrumentIds?.includes(instrumentId));
    const key = newsArticleKey(article);
    if (!article || !key || selectedKeys.has(key)) continue;
    representatives.push(article);
    selectedKeys.add(key);
  }

  const selected = sortNewsArticles(representatives).slice(0, limit);
  const finalKeys = new Set(selected.map(newsArticleKey));
  if (selected.length < limit) {
    for (const article of allArticles) {
      const key = newsArticleKey(article);
      if (!key || finalKeys.has(key)) continue;
      selected.push(article);
      finalKeys.add(key);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}
