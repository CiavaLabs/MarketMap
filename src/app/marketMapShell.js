const infoIcon = '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><circle cx="12" cy="7.5" r="0.6" fill="currentColor"></circle></svg>';

function consoleActions(options) {
  const showTheme = options.themeControl !== false;
  return `
    <div class="mm-actions" role="group" aria-label="Board actions">
      <div class="mm-actions__island" id="react-console-actions" data-mm-react-root${showTheme ? "" : ' data-theme-control="false"'}></div>
    </div>`;
}

function workspace(options) {
  return `
  <div class="container">
    <header class="mm-masthead">
      <div class="mm-masthead__identity">
        <h1 class="mm-masthead__title">Market Map</h1>
      </div>
      <div class="mm-status" data-state="empty">
          <span class="mm-status__dot" aria-hidden="true"></span>
          <strong class="mm-status__copy" id="feed-status-copy">No instruments</strong>
          <span class="sr-only" id="feed-status-announcement" role="status" aria-live="polite"></span>
          <span class="mm-popover-anchor">
            <button class="mm-info" id="feed-status-info" type="button" aria-expanded="false" aria-controls="feed-status-popover" aria-label="About the update status">${infoIcon}</button>
            <div class="mm-popover" id="feed-status-popover" role="region" aria-label="Update status" hidden>
              <p><strong>Last updated</strong> — a recent refresh succeeded for most instruments.</p>
              <p><strong>Last confirmed</strong> — the current refresh failed; last-known-good values are shown.</p>
              <p><strong>Partial update</strong> — the refresh landed but some instruments are unavailable.</p>
              <p><strong>Update unavailable</strong> — no instrument has usable data.</p>
            </div>
          </span>
      </div>
    </header>

    <section class="mm-pulse-band" aria-label="Board pulse and actions">
      <dl class="mm-pulse" aria-label="Equity pulse — 0 of 0 equities · insufficient coverage">
        <div class="mm-stat">
          <dt class="mm-stat__label">Advance / decline</dt>
          <dd class="mm-stat__value" id="snap-spread"><button class="mm-stat__spread-action positive" id="snap-advancing" type="button" title="Filter to advancing equities" disabled>—</button><span class="mm-stat__slash" aria-hidden="true">/</span><button class="mm-stat__spread-action negative" id="snap-declining" type="button" title="Filter to declining equities" disabled>—</button></dd>
          <dd class="mm-stat__bar" id="snap-bar" aria-hidden="true" hidden><span data-side="up"></span><span data-side="flat"></span><span data-side="down"></span></dd>
        </div>
        <div class="mm-stat">
          <dt class="mm-stat__label">Breadth</dt>
          <dd class="mm-stat__value neutral" id="snap-breadth">—</dd>
        </div>
        <div class="mm-stat">
          <dt class="mm-stat__label">Average move</dt>
          <dd class="mm-stat__value neutral" id="snap-average">—</dd>
        </div>
        <div class="mm-stat">
          <dt class="mm-stat__label">Dispersion</dt>
          <dd class="mm-stat__value neutral" id="snap-dispersion">—</dd>
        </div>
        <div class="mm-stat">
          <dt class="mm-stat__label">Top mover</dt>
          <dd><button class="mm-stat__value mm-stat__value--action neutral" id="snap-mover" type="button" title="Open instrument details" disabled>—</button></dd>
        </div>
        <div class="mm-stat mm-stat--leading">
          <dt class="mm-stat__label">Leading sector</dt>
          <dd><button class="mm-stat__value mm-stat__value--leading mm-stat__value--action neutral" id="snap-leading" type="button" title="Filter to the leading equity sector" disabled>—</button></dd>
        </div>
      </dl>
      ${consoleActions(options)}
    </section>

    <section class="mm-toolbar" aria-label="Board tools">
      <div class="mm-toolbar__island" id="react-toolbar" data-mm-react-root></div>
      <div class="mm-toolbar__meta">
        <p class="mm-result-count" id="result-count" aria-live="polite">0 instruments</p>
        <span class="mm-popover-anchor">
          <button class="mm-info mm-info--labelled" id="board-guide-info" type="button" aria-expanded="false" aria-controls="board-guide-popover" aria-label="Board guide">${infoIcon}<span class="mm-info__text">Guide</span></button>
          <div class="mm-popover mm-popover--wide" id="board-guide-popover" role="region" aria-label="Board guide" hidden>
            <p class="mm-popover__heading">Reading the map</p>
            <p><strong>Colour</strong> — green for gains, red for losses, neutral is flat. Intensity tracks the daily change up to ±3%.</p>
            <p><strong>Marker</strong> — circle for current, diamond for delayed, ring for last confirmed, dash for unavailable.</p>
            <p><strong>Sparkline</strong> — today's price in 5-minute bars.</p>
            <p class="mm-popover__heading">Equity pulse</p>
            <p><strong>Advance / decline</strong> — equities above vs below zero today; the bar shows the comparable equity mix, flat included.</p>
            <p><strong>Breadth</strong> — (advancing − declining) ÷ equities with a value, as a percentage.</p>
            <p><strong>Average move</strong> — the equal-weight mean daily change across eligible equities.</p>
            <p><strong>Dispersion</strong> — the standard deviation of daily change.</p>
            <p><strong>Top mover</strong> — the largest absolute move on the board; select it to open its details.</p>
            <p><strong>Leading sector</strong> — the sector with the highest equal-weight average.</p>
            <p><strong>Movement filters</strong> — gainers and losers exclude the near-flat band from −0.5% to +0.5%.</p>
            <p class="mm-popover__note">The pulse is equity-only and never follows the filtered grid. Update status still covers the whole quote-capable board. Colour shows daily percentage change, not a forecast.</p>
          </div>
        </span>
      </div>
    </section>

    <a class="mm-skip-board" href="#marketmap-end">Skip the board</a>
    <div class="marketmap-grid" id="marketmap" data-mm-react-root></div>
    <div id="marketmap-end" tabindex="-1"></div>
  </div>`;
}

const overlays = `
  <div id="react-instrument-detail" data-mm-react-root></div>
  <div id="react-add-instrument" data-mm-react-root></div>
  <div id="react-toast-host" data-mm-react-root></div>
  <div id="mm-overlay-root" data-mm-react-root></div>`;

export function getMarketMapShell(options = {}) {
  const footer = options.footer === false
    ? ""
    : '<footer class="page-footer"><p class="footer-copyright">&copy; 2026 Mario Ciavarella</p></footer>';
  return `${workspace(options)}${footer}${overlays}`;
}

export function renderMarketMapShell(root, options) {
  if (!root?.replaceChildren) {
    throw new TypeError("renderMarketMapShell requires a root Element");
  }
  const template = root.ownerDocument.createElement("template");
  template.innerHTML = getMarketMapShell(options);
  root.replaceChildren(template.content.cloneNode(true));
  return root;
}
