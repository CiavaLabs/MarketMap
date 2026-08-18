import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Accordion, Badge, Button, Callout, Dialog, Meter, SegmentedControl } from "@ciavalabs/ds-react";
import {
  ChangePill,
  MetricList,
  NewsList,
  PriceChart,
  RangeRail,
  Stat,
  StatGroup,
} from "@ciavalabs/ds-react/market";
import { CONFIG } from "../config.js";

const EMPTY_MODEL = Object.freeze({
  navigation: { position: null, total: 0, canPrevious: false, canNext: false },
  header: { symbol: "", name: "", badges: [], value: "—", changeLabel: "—", changePercent: null },
  chart: { state: "idle", series: [], ranges: [], heading: "Price history", summary: "Price history is loading." },
  stats: [],
  ranges: [],
  statisticalContext: null,
  details: { state: "idle", sections: [], message: "Loading instrument details…" },
  news: { supported: false, state: "idle", articles: [], message: "" },
  provenance: {},
});

const frameStyle = {
  width: "min(calc(100vw - 6rem), 57.5rem)",
};

function toneOf(tone) {
  return tone === "gain" ? "positive" : tone === "loss" ? "negative" : "neutral";
}

function AnalystTake({ className = "" }) {
  return (
    <Callout className={className} title="Analyst take" badge="Coming soon">
      Synthesized analyst sentiment and price-target context will appear here when the analytics layer ships.
    </Callout>
  );
}

function isAnalystOutlook(section) {
  return section.id === "analyst_outlook" || String(section.title).toLowerCase() === "outlook";
}

function isBusinessQuality(section) {
  return String(section.title).toLowerCase() === "business quality";
}

function arrangeDetailSections(sections) {
  const arranged = [...sections];
  const outlookIndex = arranged.findIndex(isAnalystOutlook);
  const businessIndex = arranged.findIndex(isBusinessQuality);
  if (outlookIndex < 0 || businessIndex < 0 || outlookIndex === businessIndex + 1) return arranged;
  const [outlook] = arranged.splice(outlookIndex, 1);
  const nextBusinessIndex = arranged.findIndex(isBusinessQuality);
  arranged.splice(nextBusinessIndex + 1, 0, outlook);
  return arranged;
}

function DescriptionGrid({ className, rows }) {
  return (
    <dl className={className}>
      {rows.map((row) => (
        <div key={row.id}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function StatisticalContext({ context }) {
  if (!context) return null;
  const { rarity } = context;
  return (
    <section
      className="mm-instrument-detail__panel mm-instrument-detail__statistical-context"
      aria-label={`${context.title} for the ${context.sessionDate} session`}
    >
      <div className="mm-instrument-detail__context-head">
        <h3>{context.title}</h3>
        <Badge variant="neutral">{context.badge}</Badge>
      </div>
      <p className="mm-detail-message">{context.subtitle}</p>
      {context.note ? <p className="mm-instrument-detail__context-note">{context.note}</p> : null}
      {context.advisory
        ? <p className="mm-instrument-detail__context-note">{context.advisory}</p>
        : null}

      <div className="mm-instrument-detail__context-figures">
        {context.movement.map((figure) => (
          <div className="mm-instrument-detail__context-figure" key={figure.id}>
            <span>{figure.label}</span>
            <strong>{figure.value}</strong>
          </div>
        ))}
      </div>

      <div className="mm-instrument-detail__context-rarity">
        <span>{rarity.label}</span>
        <strong>{rarity.value}</strong>
        <Meter
          className="mm-instrument-detail__context-meter"
          value={rarity.fraction}
          aria-hidden="true"
        />
        <p>{rarity.exceedance}</p>
      </div>

      <DescriptionGrid className="mm-instrument-detail__context-windows" rows={context.windows} />

      <Accordion.Root className="mm-instrument-detail__context-method">
        <Accordion.Section title="Method &amp; data" headingAs="h4">
          <DescriptionGrid className="mm-instrument-detail__context-methodology" rows={context.methodology} />
        </Accordion.Section>
      </Accordion.Root>
    </section>
  );
}

function DetailPanel({ section, className = "" }) {
  return (
    <section className={`mm-instrument-detail__panel ${className}`.trim()}>
      <h3 style={{ margin: "0 0 .75rem", color: "var(--mm-ink)", fontSize: ".9rem" }}>{section.title}</h3>
      {section.items.length ? <MetricList items={section.items} /> : <p className="mm-detail-message">{section.message || "No applicable fields were returned."}</p>}
    </section>
  );
}

function DetailSections({ details }) {
  if (!details.sections.length) {
    return (
      <>
        <p className="mm-detail-message" data-detail-state={details.state}>{details.message}</p>
        <AnalystTake />
      </>
    );
  }
  const sections = arrangeDetailSections(details.sections);
  const unpairedIndex = sections.length % 2 ? sections.length - 1 : -1;
  return (
    <div className="mm-detail-sections" data-detail-state={details.state}>
      {sections.map((section, index) => (
        <DetailPanel
          key={section.id || section.title}
          section={section}
          className={index === unpairedIndex ? "mm-instrument-detail__panel--full" : ""}
        />
      ))}
      <AnalystTake className="mm-instrument-detail__analyst-take" />
    </div>
  );
}

export const InstrumentDetail = forwardRef(function InstrumentDetail(
  { onClose, onRemove, onRangeChange, onHoverChange, onNavigate, portalContainer },
  ref,
) {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState(EMPTY_MODEL);
  const modelRef = useRef(EMPTY_MODEL);
  const [hoverIndex, setHoverIndex] = useState(null);

  useImperativeHandle(ref, () => ({
    setOpen: (next) => flushSync(() => {
      setOpen(Boolean(next));
      if (!next) setHoverIndex(null);
    }),
    setModel: (next) => flushSync(() => {
      modelRef.current = { ...EMPTY_MODEL, ...next };
      setModel(modelRef.current);
    }),
    getModel: () => modelRef.current,
  }), []);

  const chart = model.chart || EMPTY_MODEL.chart;
  const activeHoverIndex = chart.hoveredIndex ?? hoverIndex;
  const hoveredPoint = activeHoverIndex === null ? null : chart.series?.[activeHoverIndex] || null;
  const headingValue = hoveredPoint
    ? chart.formatPrice?.(hoveredPoint.value) || String(hoveredPoint.value)
    : chart.changeLabel || "—";
  const headingContext = hoveredPoint ? hoveredPoint.label : chart.heading;
  const navigation = model.navigation || EMPTY_MODEL.navigation;
  const handleNavigationKeyDown = (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const isModifiedShortcut = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    const isInteractive = Boolean(event.target?.closest?.(
      "input, textarea, select, button, summary, a, [contenteditable='true']",
    ));
    if (!isModifiedShortcut && isInteractive) return;
    const offset = event.key === "ArrowLeft" ? -1 : 1;
    const canMove = offset < 0 ? navigation.canPrevious : navigation.canNext;
    if (isModifiedShortcut || canMove) event.preventDefault();
    if (!canMove) return;
    onNavigate?.(offset);
  };
  const chartHeading = (
    <div className="mm-instrument-detail__chart-heading">
      <div>
        <span>Price performance</span>
        <p><strong className={hoveredPoint ? "neutral" : toneOf(chart.tone)}>{headingValue}</strong><em>{headingContext}</em></p>
      </div>
      <SegmentedControl
        className="mm-instrument-detail__range-selector"
        aria-label="Chart range"
        size="xs"
        value={chart.range}
        onValueChange={onRangeChange}
        options={chart.ranges || []}
      />
    </div>
  );

  return (
    <Dialog.Root
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(next) => { if (!next) onClose?.(); }}
    >
      <Dialog.Content
        id="instrument-detail-dialog"
        className="mm-instrument-detail-dialog"
        container={portalContainer}
        style={frameStyle}
        onKeyDown={handleNavigationKeyDown}
      >
        <article className="mm-instrument-detail">
          <nav className="mm-instrument-detail__navigation" aria-label="Instrument navigation">
            <Button
              variant="subtle"
              size="sm"
              disabled={!navigation.canPrevious}
              aria-keyshortcuts="Alt+ArrowLeft"
              onClick={() => onNavigate?.(-1)}
            >
              ← Previous
            </Button>
            <p aria-live="polite">
              {navigation.position
                ? `${navigation.position} of ${navigation.total} in current filter`
                : "Not in current filter"}
            </p>
            <Button
              variant="subtle"
              size="sm"
              disabled={!navigation.canNext}
              aria-keyshortcuts="Alt+ArrowRight"
              onClick={() => onNavigate?.(1)}
            >
              Next →
            </Button>
          </nav>
          <header className="mm-instrument-detail__header">
            <div className="mm-instrument-detail__identity">
              <div className="mm-instrument-detail__name-row">
                <Dialog.Title className="mm-instrument-detail__ticker" size="display">{model.header.symbol}</Dialog.Title>
                <span>{model.header.name}</span>
              </div>
              <div className="mm-instrument-detail__badges">
                {(model.header.badges || []).map((badge) => <Badge key={badge} variant="neutral">{badge}</Badge>)}
              </div>
            </div>
            <div className="mm-instrument-detail__quote">
              <strong>{model.header.value}</strong>
              <ChangePill value={model.header.changePercent ?? 0}>{model.header.changeLabel}</ChangePill>
            </div>
          </header>

          <section
            className="mm-instrument-detail__chart"
            aria-busy={chart.state === "loading"}
            data-chart-transitioning={chart.transitioning ? "true" : undefined}
          >
            {chart.series?.length >= 2 ? (
              <PriceChart
                series={chart.series}
                baseline={chart.baseline}
                tone={chart.tone || "auto"}
                showVolume={chart.showVolume !== false}
                formatPrice={chart.formatPrice}
                startLabel={chart.startLabel}
                endLabel={chart.endLabel}
                onHoverChange={(index) => {
                  setHoverIndex(index);
                  onHoverChange?.(index);
                }}
                heading={chartHeading}
              />
            ) : (
              <div className="mm-detail-chart-empty" data-chart-state={chart.state}>
                {chartHeading}
                <p>{chart.summary}</p>
              </div>
            )}
          </section>

          {model.stats?.length ? (
            <StatGroup className="mm-instrument-detail__stats">
              {model.stats.map((stat) => (
                <Stat
                  key={stat.id || stat.label}
                  label={stat.label}
                  value={stat.value}
                  tone={stat.tone || "neutral"}
                  note={stat.meter ? <Meter value={stat.meter.value} label={stat.meter.label} /> : stat.note}
                />
              ))}
            </StatGroup>
          ) : null}

          {model.ranges?.length ? (
            <div className="mm-instrument-detail__ranges">
              {model.ranges.map((range) => (
                <RangeRail key={range.label} {...range} />
              ))}
            </div>
          ) : null}

          <StatisticalContext context={model.statisticalContext} />

          <DetailSections details={model.details || EMPTY_MODEL.details} />

          {model.news?.supported ? (
            <NewsList
              className="mm-instrument-detail__news"
              variant="modal"
              title="Latest news"
              titleAs="h3"
              subtitle={model.news.subtitle}
              articles={model.news.articles || []}
              emptyState={model.news.message}
              provenance={model.news.provenance}
              limit={CONFIG.NEWS.MODAL_LIMIT}
            />
          ) : null}

          <footer className="mm-instrument-detail__footer">
            <div className="mm-instrument-detail__provenance">
              <p>{model.provenance.market || "Market data: source unavailable"}</p>
              {model.news?.supported ? <p>{model.provenance.news || "News data: source unavailable"}</p> : null}
            </div>
            <Button variant="danger" onClick={onRemove}>Remove from board</Button>
            <p>For informational purposes only. Not investment advice.</p>
          </footer>
        </article>
      </Dialog.Content>
    </Dialog.Root>
  );
});
