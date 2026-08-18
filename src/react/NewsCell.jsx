import { memo, useMemo } from "react";
import { NewsList } from "@ciavalabs/ds-react/market";
import { CONFIG } from "../config.js";
import { BOARD_NEWS_ID } from "../ui/models/boardLayout.js";
import { instrumentLabelFor } from "../ui/models/instrumentFormat.js";
import { formatMarketMapTime } from "../utils/dateTime.js";
import { formatNewsSourceNames, formatNewsTimestamp, MAX_VISIBLE_INSTRUMENTS } from "../ui/models/newsPresentation.js";

const SUBTITLE = "Recent coverage across your board.";

const chevronIcon = (
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <path d="m6 9 6 6 6-6"></path>
  </svg>
);

function formatUpdateTime(value) {
  const formatted = formatMarketMapTime(value, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return formatted === "—" ? null : formatted;
}

function articleMeta(article, instrumentLabels) {
  const ids = [...new Set(article.instrumentIds || [])];
  if (!ids.length) return null;
  const visible = ids.slice(0, MAX_VISIBLE_INSTRUMENTS)
    .map((id) => instrumentLabelFor(id, instrumentLabels))
    .filter(Boolean);
  if (!visible.length) return null;
  const remaining = ids.length - Math.min(ids.length, MAX_VISIBLE_INSTRUMENTS);
  return `${visible.join(", ")}${remaining > 0 ? ` +${remaining}` : ""}`;
}

function partialNotice(count) {
  return count ? `Coverage unavailable for ${count} instrument${count === 1 ? "" : "s"}.` : null;
}

function collapsedSummary(status, count) {
  if (count > 0) return { value: String(count), label: count === 1 ? "story" : "stories" };
  if (status === "error") return { label: "Coverage unavailable" };
  if (status === "loading" || status === "idle") return { label: "Loading coverage…" };
  return { label: "No recent coverage" };
}

function NewsCellImpl({
  status = "idle",
  articles = [],
  errors,
  sources,
  quality,
  lastUpdatedAt,
  instrumentLabels,
  hasBoard,
  open = true,
  placementStyle,
  grabbed,
  onRetry,
  onToggleOpen,
  onReorderKeyDown,
  onReorderClick,
  onReorderBlur,
  onReorderPointerDown,
}) {
  const hasInstruments = hasBoard
    || (instrumentLabels instanceof Map ? instrumentLabels.size > 0 : Boolean(instrumentLabels));
  const mapped = useMemo(() => articles.map((article) => ({
    id: article.id,
    title: article.title,
    url: article.url,
    publisher: article.publisher,
    publishedAt: article.publishedAt,
    meta: articleMeta(article, instrumentLabels),
  })), [articles, instrumentLabels]);

  if (!hasInstruments) return null;

  const controls = (
    <div className="mm-news-cell__controls">
      <button
        type="button"
        className="mm-news-cell__grip mm-reorder-handle"
        aria-label="Reorder latest news"
        aria-describedby="board-reorder-instructions"
        data-reorder-handle="news"
        onClick={onReorderClick}
        onBlur={onReorderBlur}
        onKeyDown={onReorderKeyDown}
        onPointerDown={onReorderPointerDown}
      >
        <span aria-hidden="true">⠿</span>
      </button>
      <button
        type="button"
        className="mm-news-cell__toggle"
        aria-expanded={open}
        aria-label={open ? "Collapse latest news" : "Show latest news"}
        onClick={onToggleOpen}
      >
        {chevronIcon}
      </button>
    </div>
  );

  if (!open) {
    const summary = collapsedSummary(status, articles.length);
    return (
      <section
        className="mm-news mm-news-cell mm-news-cell--collapsed"
        data-cell="news"
        data-layout-id={BOARD_NEWS_ID}
        data-state={status}
        data-open="false"
        data-grabbed={grabbed ? "true" : undefined}
        style={placementStyle}
      >
        <h2 className="mm-news__title">Latest news</h2>
        {controls}
        <p className="mm-news-cell__summary">
          {summary.value ? <strong>{summary.value}</strong> : null}
          <span>{summary.label}</span>
        </p>
      </section>
    );
  }

  let emptyState = null;
  if (articles.length === 0) {
    if (status === "loading" || status === "idle") emptyState = "Loading recent coverage…";
    else if (status === "error") {
      emptyState = (
        <>
          News is unavailable right now.{" "}
          <button type="button" className="mm-news__retry" onClick={onRetry}>Retry</button>
        </>
      );
    } else {
      emptyState = [
        "No coverage was published for these instruments in the last 7 days.",
        partialNotice(errors?.length),
      ].filter(Boolean).join(" ");
    }
  }

  const notice = articles.length && status === "loading" ? "Refreshing recent coverage…" : null;
  const subtitle = notice
    || (articles.length ? partialNotice(errors?.length) : null)
    || SUBTITLE;
  const updateTime = formatUpdateTime(lastUpdatedAt);
  const provenance = articles.length
    ? `News coverage from ${formatNewsSourceNames(articles, sources)} · ${quality === "stale" ? "Last confirmed" : "Updated"}${updateTime ? ` ${updateTime}` : ""}`
    : null;

  return (
    <section
      className="mm-news mm-news-cell"
      data-cell="news"
      data-layout-id={BOARD_NEWS_ID}
      data-state={status}
      data-open="true"
      data-grabbed={grabbed ? "true" : undefined}
      style={placementStyle}
    >
      {controls}
      <NewsList
        articles={mapped}
        title="Latest news"
        subtitle={subtitle}
        limit={CONFIG.NEWS.BOARD_LIMIT}
        provenance={provenance}
        emptyState={emptyState}
        dateFormatter={(date) => formatNewsTimestamp(date)}
      />
    </section>
  );
}

export const NewsCell = memo(NewsCellImpl);
