export const DEFAULT_TTL_POLICY = Object.freeze({
  quote: Object.freeze({ freshMs: 30_000, staleMs: 24 * 60 * 60 * 1_000 }),
  quoteClosed: Object.freeze({ freshMs: 3 * 60_000, staleMs: 24 * 60 * 60 * 1_000 }),
  quote24x5: Object.freeze({ freshMs: 30_000, staleMs: 24 * 60 * 60 * 1_000 }),
  quote24x7: Object.freeze({ freshMs: 20_000, staleMs: 24 * 60 * 60 * 1_000 }),
  quotePublisher: Object.freeze({ freshMs: 60_000, staleMs: 24 * 60 * 60 * 1_000 }),
  quoteFuture: Object.freeze({ freshMs: 20_000, staleMs: 24 * 60 * 60 * 1_000 }),
  historyIntraday: Object.freeze({ freshMs: 2 * 60_000, staleMs: 24 * 60 * 60 * 1_000 }),
  historyDaily: Object.freeze({ freshMs: 60 * 60_000, staleMs: 7 * 24 * 60 * 60 * 1_000 }),
  profile: Object.freeze({ freshMs: 24 * 60 * 60 * 1_000, staleMs: 30 * 24 * 60 * 60 * 1_000 }),
  search: Object.freeze({ freshMs: 30 * 60_000, staleMs: 60 * 60_000 }),
  news: Object.freeze({ freshMs: 15 * 60_000, staleMs: 24 * 60 * 60 * 1_000 }),
  newsEmpty: Object.freeze({ freshMs: 5 * 60_000, staleMs: 60 * 60_000 }),
});

export function ttlForNews(resourceType, value, policy = DEFAULT_TTL_POLICY) {
  if (resourceType === "quote") {
    return value?.marketState === "closed" ? policy.quoteClosed : policy.quote;
  }
  if (resourceType === "history") {
    return ["1m", "5m", "15m", "30m", "1h"].includes(value?.interval)
      ? policy.historyIntraday
      : policy.historyDaily;
  }
  if (resourceType === "news") {
    return Array.isArray(value?.articles) && value.articles.length === 0
      ? policy.newsEmpty
      : policy.news;
  }
  return policy[resourceType] || policy.profile;
}

export function ttlFor(resourceType, value, policy = DEFAULT_TTL_POLICY) {
  if (resourceType === "quote") {
    const model = value?.session?.model;
    if (model === "24x7") return policy.quote24x7 || policy.quote;
    if (model === "24x5") {
      return value?.session?.phase === "closed"
        ? policy.quoteClosed
        : policy.quote24x5 || policy.quote;
    }
    if (model === "publisher_schedule") return policy.quotePublisher || policy.quote;
    if (model === "provider_schedule" || value?.assetClass === "commodity_future") {
      return policy.quoteFuture || policy.quote;
    }
    return value?.session?.phase === "closed" ? policy.quoteClosed : policy.quote;
  }
  if (resourceType === "history") {
    return ["1m", "5m", "15m", "30m", "1h"].includes(value?.interval)
      ? policy.historyIntraday
      : policy.historyDaily;
  }
  if (resourceType === "details") return policy.details || policy.profile;
  return policy[resourceType] || policy.profile;
}
