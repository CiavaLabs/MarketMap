# Market Map

[![Tests](https://github.com/CiavaLabs/MarketMap/actions/workflows/ci.yml/badge.svg)](https://github.com/CiavaLabs/MarketMap/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FCiavaLabs%2FMarketMap%2Fmain%2F.github%2Fbadges%2Fcoverage.json)](#development)
[![Version](https://img.shields.io/github/v/tag/CiavaLabs/MarketMap?label=version)](https://github.com/CiavaLabs/MarketMap/releases)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022-brightgreen)](#requirements)
[![License](https://img.shields.io/github/license/CiavaLabs/MarketMap)](./LICENSE)

Market Map is an embeddable, capability-aware market board for equities, ETFs,
indices, FX, crypto, continuous commodity futures, and rate indices. The
browser talks only to a same-origin API; provider access, identity resolution,
normalization, cache policy, and credentials stay on the server.

## Requirements

- Node.js 22 or newer
- npm
- Access to GitHub Packages for the private Design System dependency. Authenticate
  the GitHub CLI with a token that includes `read:packages`, or provide the same
  token as `GITHUB_TOKEN` before running `npm install`.
- Network access from the server to Yahoo Finance
- Optional: a Finnhub key and a MySQL-compatible database

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

Open [http://localhost:6060](http://localhost:6060).

[.env.example](./.env.example) carries every setting the local server reads,
each at its default: host and port, log level, enabled asset classes, the batch
ceiling, the development image sources, and the provider canary's flags. Two of
them have consequences outside the local process.

`FINNHUB_API_KEY` is optional and is read by server code only. It belongs in no
browser configuration, log line, canary report, or provider URL.

`MARKET_CANARY_LIVE` reaches live providers when it is set to `1`, and is `0`
everywhere else.

## API

Use the single `/api/market/v1` surface for identity, quotes, history, details,
news, analytics, and health. Every envelope declares schema version 2 plus its
semantic and capability revisions; partial batch failures remain item-local.

| Endpoint | Purpose |
|---|---|
| `GET /snapshot?ids=XNAS:AAPL,ARCX:SPY` | Validated quotes for up to 40 canonical instruments per request. |
| `GET /history?ids=...&range=5d&interval=15m&priceBasis=raw` | Batch history with an explicit price basis. |
| `GET /instruments/search?q=apple&assetClass=equity&limit=10` | Hydrated search with optional asset class, venue/MIC, and currency filters. |
| `GET /instruments/:id` | Resolved descriptor, effective capabilities, and addability. |
| `GET /instruments/:id/history?range=1y&interval=1d&priceBasis=provider_adjusted` | One validated history series without semantic basis substitution. |
| `GET /instruments/:id/details` | Capability-gated, asset-specific detail sections. |
| `GET /news?ids=...&limit=12` | Deduplicated board news with item-local errors. |
| `GET /instruments/:id/news?limit=6` | Provider-neutral news feed for one instrument. |
| `GET /analytics/snapshot?ids=...` | Latest persisted end-of-day movement assessments (max 40 ids). Read-only over the analytics ledger; `501` unless the host configures an analytics store. |
| `GET /health` | Provider, cache, persistence, feature-policy, and manifest status, plus `capabilities`: the operations the wired service implements. |

Canonical IDs use a market namespace and symbol, for example `XNAS:AAPL` and
`XNYS:JPM`. Batch responses may include per-instrument errors while preserving
the quotes that were available.

`capabilities` names the operations a deployment answers, so a client asks for
what exists rather than discovering the gap through a `501`. It reflects the
service object wired into `createMarketDataHandler`, not what an instrument
supports: an operation missing there is missing for every instrument, and one
present there is still capability-gated per instrument.

```bash
curl 'http://localhost:6060/api/market/v1/health'
curl 'http://localhost:6060/api/market/v1/snapshot?ids=XNAS%3AAAPL%2CARCX%3ASPY'
curl 'http://localhost:6060/api/market/v1/instruments/FX%3AEURUSD/history?range=5d&interval=15m&priceBasis=raw'
curl 'http://localhost:6060/api/market/v1/news?ids=XNAS%3AAAPL%2CXNAS%3AMSFT&limit=12'
```

News articles use one provider-neutral contract:

```js
{
  id: "yahoo:<uuid>",
  title: "...",
  publisher: "...",
  url: "https://...",
  publishedAt: "2026-07-15T16:10:00.000Z",
  instrumentIds: ["XNAS:AAPL"],
  provider: "yahoo"
}
```

The single-instrument route returns a normalized feed in the standard API envelope. The board
route returns `{ data: { articles }, errors, sources: { news }, meta }`; `errors` may contain
per-instrument failures while `data.articles` preserves the coverage that succeeded.
`meta.nextRefreshAt` tells clients when to refresh, while `meta.lastUpdatedAt` conservatively
identifies when the oldest contributing feed was last confirmed.

## Data handling

Yahoo Finance is the primary provider. Finnhub serves one explicitly approved,
semantically equivalent fallback cell: raw quotes for US equities with a
verified mapping and an allowlisted MIC. A configured key does not broaden that
policy, and Finnhub never silently replaces Yahoo adjusted history. Responses
are runtime-validated and normalized before they reach the browser.

Quotes, details, history, search results, and news use memory caching. The service
coalesces concurrent work, applies provider circuit breakers, and can serve a
labelled last-known-good observation while refreshing in the background.

Company news covers the latest 7 days. Yahoo Finance is queried first; Finnhub is attempted only
when Yahoo fails or returns an empty feed and the server-side key and instrument eligibility allow
it. Without `FINNHUB_API_KEY`, Yahoo news continues to work and no configuration error is exposed
to the browser. The board selects up to 12 deduplicated articles with broad instrument coverage;
the instrument dialog shows up to 4 articles for its selected asset.

Non-empty news feeds are fresh for 15 minutes and may be served stale for up to 24 hours while a
background revalidation runs. Valid empty feeds use a shorter 5-minute fresh TTL and a 1-hour stale
window. The normal UI refresh therefore follows the server's 15-minute hint; stale or retryable
results may request an earlier check. Board aggregation uses at most five concurrent
per-instrument requests and a 25-second server budget, returning per-instrument timeout errors
and any completed coverage before the browser's 30-second deadline.
The single-instrument path remains inside the standard 6-second client budget.

Every quote separates value, field availability, surface quality, data
quality issues, session semantics, and provenance. Cached last-known-good data
is labelled stale without erasing its original provider or fallback chain.

History ranges are `1d`, `5d`, `1m`, `6m`, `1y`, and `5y`. Five-year requests
use weekly bars by default and accept daily, weekly, or monthly intervals.
Yahoo does not impose a one-year limit on daily-or-coarser chart history, but
intraday retention is limited (about 60 days for one-minute data). Snapshot
refresh is automatic and follows the server refresh hint with bounded retry
backoff; there is no user-managed auto-refresh mode. Tile histories refresh on
a five-minute cadence with a dedicated 30-second batch timeout. Yahoo Finance
uses unofficial endpoints for chart data and news and has no availability SLA,
so schema changes, rate limits, licensing, and delistings can still reduce
coverage. Finnhub requires a key; verify that its current plan and licence cover
the intended commercial or public deployment separately.

The local server uses an in-memory snapshot store. Hosts that need durable
snapshots can pass `MySQLSnapshotStore` to `createMarketDataService`; the SQL
definition is in [server/cache/migrations/001_create_market_data_cache.sql](./server/cache/migrations/001_create_market_data_cache.sql).
Dynamic instrument descriptors can likewise use `MySQLInstrumentCatalogStore`;
its schema is in [server/cache/migrations/002_create_instrument_catalog.sql](./server/cache/migrations/002_create_instrument_catalog.sql).

## Install

The package is published to GitHub Packages under the `@ciavalabs` scope, so the
consuming project declares that registry in its own `.npmrc`:

```dotenv
@ciavalabs:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
npm install @ciavalabs/marketmap
```

The package has no production dependencies. `react`, `react-dom`, and
`@ciavalabs/ds-react` are optional peer dependencies: a host that mounts the
React islands below installs them, and one that embeds the vanilla board does
not. The server reaches Yahoo Finance over `fetch` through a client that ships
with the package, so a host inherits nothing it did not ask for.

## Embed the client

```js
import {
  createMarketMapExperience,
  MarketDataClient,
  renderMarketMapShell,
} from "@ciavalabs/marketmap";
import "@ciavalabs/marketmap/embed.css";
// …or embed.nofonts.css if the host already serves Inter and Newsreader:
// the package's @font-face rules carry no unicode-range and would compete
// with a host's own subsets — same families, fetched twice.

const root = document.querySelector("[data-market-map]");

renderMarketMapShell(root, {
  footer: false,
  themeControl: false,
});

const client = new MarketDataClient({
  apiBaseUrl: "/api/market/v1",
  maxBatchIds: 40,
  batchConcurrency: 2,
});

const experience = createMarketMapExperience({
  root,
  client,
  maxBoardSize: 60,
  refreshPolicy: "automatic",
  pauseWhenHidden: true,
  theme: "dark", // omit to follow the stored choice, then the system scheme
  onThemeRequest: applyHostTheme,
  setScrollLocked: toggleHostScrollLock,
});

experience.pause();
experience.resume();
experience.destroy();
```

Two smaller exports round out the client surface:

- `displaySymbolOf(instrument)` renders a symbol the way the UI does: the
  curated `displaySymbol` where there is one, otherwise the provider symbol with
  its venue prefix and any leading `^` stripped, so an index reads `VIX` where
  the provider says `^VIX`. Every label printed beside the board goes through
  it, or the two drift apart.
- `helpers.debounce` is an optional slot on `createMarketMap`. The filter
  controls are debounced either way: omit it and they use a built-in 250 ms
  timer, supply one and they route through it. A host that already schedules
  work therefore avoids a second timer competing with its own.

### From a React host

The example above is the vanilla path: `src/core/main.js` loads the bundled
mount adapters and the board owns its own React roots. A host that is already a
React application does not want a second runtime. It imports the components
instead — they are published with `react`, `react-dom` and `@ciavalabs/ds-react`
left external — and passes its own mount adapters through `reactIslands`:

```js
import {
  AddInstrumentDialog,
  AssetGrid,
  ConsoleActions,
  InstrumentDetail,
  ToastHost,
  Toolbar,
} from "@ciavalabs/marketmap/react";

createMarketMapExperience({
  root,
  reactIslands: {
    mountAssetGrid, // (container, callbacks) => imperative handle
    mountToolbar,
    mountConsoleActions,
    mountAddInstrument,
    mountInstrumentDetail,
    mountToastHost,
  },
});
```

Each adapter returns the imperative handle the board drives (see
`src/react/*.entry.jsx` for the reference implementations). The host is
responsible for the React root it creates and for unmounting it when
`destroy()` runs.

`./react` is a barrel that re-exports one file per island, and the package
declares `sideEffects: ["**/*.css"]`: a host that uses two islands does not pay
for six.

`maxBoardSize` is a product/UI limit (default `60`, hard ceiling `100`).
`maxBatchIds` is a transport limit (default `40`) and is deliberately
independent: the client deduplicates and chunks a larger board while preserving
board order and item-local errors.

### Boards

A host holds several named boards, each with its own instruments, its own
arrangement and its own news state. `switchBoard`, `createBoard`, `renameBoard`,
`duplicateBoard` and `deleteBoard` are on the returned experience; the naming
ones answer `{ ok: true, board }` or `{ ok: false, message }` so the caller can
put the refusal where the user is looking. `reorderBoard` and `setNewsOpen` move
and fold the sequence, and `getState()` reports `boards`, `activeBoardId` and
`layout` alongside the board itself. `onBoardsChange`, `onActiveBoardChange` and
`onBoardLayoutChange` mirror all of it outwards.

The default board is the workspace board: it keeps its name, cannot be deleted,
and `restoreDefaultTickers()` refills it. `maxBoardSize` governs *growth*, so a
board already in storage from a host that allowed more stays reachable and can
still be edited downwards.

Boards live in `localStorage` under `marketmap-boards-v3`, and the two earlier
single-board schemas (`marketmap-board-v2`, `marketmap-board-v1`) are migrated
into it on first read. Clearing site data clears the boards: there is no account
and no sync. Pass `storage: null` to opt out of persistence entirely.

## Embed the server

The server entry point accepts a web-standard `Request` and returns a
web-standard `Response`.

```js
import {
  createMarketDataService,
  MySQLInstrumentCatalogStore,
  MySQLSnapshotStore,
} from "@ciavalabs/marketmap/server";

const enabledAssetClasses = [
  "equity",
  "etf",
  "index",
  "fx",
  "crypto",
  "commodity_future",
  "rate_index",
];

export const serverOptions = {
  finnhubApiKey: process.env.FINNHUB_API_KEY,
  enabledAssetClasses,
  snapshotStore: new MySQLSnapshotStore(existingMysqlPool),
  instrumentCatalogStore: new MySQLInstrumentCatalogStore(existingMysqlPool),
  basePath: "/api/market/v1",
  maxResolvedDescriptors: 2_000,
};

const market = createMarketDataService(serverOptions);

export async function handleMarketRequest(request) {
  return market.handleRequest(request);
}
```

`enabledAssetClasses` is the server-side rollout and rollback policy. Search
may diagnose disabled classes, but disabled instruments are not addable. Keep
the browser build's feature-policy mirror aligned with the server. Roll back a
problematic class by removing it from this list and redeploying; persisted
descriptors and boards require no destructive migration.

Nothing here limits how often a caller may ask. Pass `quota` to meter them, and
`clientKey` with it — only the host knows how to identify a caller behind its own
proxy, so the library will not guess:

```js
const market = createMarketDataService({
  ...serverOptions,
  quota: {
    clientKey: (request) => request.headers.get("cf-connecting-ip"),
    limit: 600,
    windowMs: 60_000,
  },
});
```

`limit` counts instruments of upstream work per window, because a request and
its cost are not the same thing. A 40-id snapshot costs 40. A search costs 8,
because it hydrates up to that many symbols behind one HTTP call. Details and a
single history cost 2 each, for the two provider operations they issue.
Everything else costs 1.

It follows that `limit` must be at least the dearest single request — the larger
of `maxBatchIds` and 8 — and a configuration below that floor is refused at
construction, since those requests would otherwise be permanently unaffordable.
A request pays its route's cost before it is routed and the rest of a batch only
once its ids validate and the operation exists, so a malformed request cannot
drain an allowance; a request the quota then refuses is refunded in full.

A request whose `clientKey` returns `null` is exempt from metering, which is how
an internal caller is let through. Derive the key from something the caller
cannot forge: the bucket roster is bounded, and evicting a caller returns them a
full allowance. Exceeding the allowance answers `429` with `retry-after` and the
`quota_exceeded` code. Without `quota` there is no limiting at all, and the API
is as open as whatever sits in front of it.

`GET /health` answers with a summary: status, which providers are enabled,
whether persistence is configured, and the `capabilities` above. Circuit state,
cache depth and telemetry counters are withheld, because the endpoint is
unauthenticated by default and those describe when the service is weakest. Pass
`exposeHealthInternals: true` to serve the whole picture, and place the endpoint
behind authentication when you do — [RUNBOOK.md](./RUNBOOK.md) reads the full
response field by field.

`maxResolvedDescriptors` bounds how much discovered identity the process keeps
in memory. The curated instruments are pinned and never counted against it; the
bound applies to everything minted from a search or a cold resolve, all of which
can be resolved again. Raise it for a host that searches widely, lower it for a
memory-tight one. The default is 2000.

Finnhub is optional. With no key, Yahoo remains primary and the approved
Finnhub fallback is unavailable. Verify provider entitlement, caching,
redistribution, and licensing separately for the deployment.

### Movement analytics (optional)

End-of-day movement analytics stays inert unless the host injects a dedicated
append-only store and an explicit equity universe. There is no hidden
scheduler: the host invokes the daily runner after 22:30 UTC with the
completed/next session dates and a versioned session grid. The runner validates
a grid's shape and consistency and leaves its authority to the host, so the grid
has to come from a calendar and never from the data being assessed —
`nyseCalendar` is that calendar and ships with the package.

```js
import { MySQLAnalyticsStore, nyseCalendar } from "@ciavalabs/marketmap/server";

const market = createMarketDataService({
  ...serverOptions,
  analyticsStore: new MySQLAnalyticsStore(existingMysqlPool),
  analyticsConfig: { equityInstrumentIds: curatedEquityIds },
});

await market.runDailyAnalytics({
  completedSessionDate,
  nextSessionDate,
  sessionGrid: nyseCalendar.sessionGridFor({ from: windowStart, to: completedSessionDate }),
});
```

The grid must end on the session it declares complete, and the next session must
be one the calendar names and the clock has not reached. Before running, check
the calendar against the sessions the market actually traded and stop if they
disagree — a disagreement is either an unscheduled closure missing from the
calendar or a fault in the data, and neither should be absorbed silently:

```js
import { nyseCalendar, reconcileSessionGrid } from "@ciavalabs/marketmap/server";

const reconciliation = reconcileSessionGrid({ sessionGrid, observedSessionDates });
if (!reconciliation.reconciled) throw new Error(reconciliation.reasonCode);
```

`nyseCalendar` covers US equities, which is the only market the movement cohort
assesses. A host that needs another builds one with `createExchangeCalendar`,
which takes the market's own week, its holiday rules and its unscheduled
closures — Tel Aviv's Sunday-to-Thursday week is one of those parameters.

With the store configured, `GET /analytics/snapshot?ids=...` serves the latest
persisted assessment per instrument, re-validated through the same runtime
contract the engine wrote it with. The instrument dialog renders a
"Statistical context" section from that record only when every displayed
quantity is present and finite; anything less and the section is omitted
entirely — no `N/A`, no placeholders, no recomputation in the browser. Without
the store the endpoint answers `501` and the UI asks once, remembers, and
shows nothing.

Locally there is no cron, so `npm run dev:analytics` (or `MARKET_ANALYTICS=1 npm
run dev`) wires an in-memory ledger and runs the runner once at startup against
the same `nyseCalendar` a deployment would use, reconciled against SPY's traded
sessions. It assesses the last session the clock says is closed, never an open
one, and a run started before the cutoff is recorded at that cutoff. The ledger
is ephemeral: restarting recomputes it. Plain `npm run dev` leaves the endpoint
at `501`. Neither shortcut belongs in a deployment, which needs a durable store
and the host's own scheduler.

The section carries four registers: the measured quantities; the empirical
percentile with the exceedance count that states its rank resolution; the
windows both are taken over; and the method — standardization, empirical rate,
source, calendar, model and warnings. The first three are always open, since no
figure means anything without its window; the method opens on demand.

## Development

| Command | Purpose |
|---|---|
| `npm run dev` | Start the local UI and API server. |
| `npm run dev:analytics` | Same, plus an in-memory movement ledger computed once at startup. |
| `npm test` | Run the full test suite. |
| `npm run check` | Run every guardrail; see below. |
| `npm run test:browser` | Run every Chromium suite: quality, layout, motion, boards, commands, multi-asset, and visual. |
| `npm run test:browser:quality` | Run deterministic Chromium layout, theme, and Axe checks. |
| `npm run test:visual` | Compare the reviewed Chromium visual snapshots. |
| `npm run test:visual:update` | Intentionally regenerate visual snapshots for review. |
| `npm run test:performance` | Run the deterministic 60-board load/fault harness; no provider network. |
| `npm run canary:providers` | Run the provider canary; it skips unless `MARKET_CANARY_LIVE=1`. |

Browser tests intercept every market API request with deterministic fixtures; they never contact a
live market-data provider. Install the pinned Chromium runtime once with
`npx playwright install chromium` before running them locally.

`npm run check` is a set of independent guardrails, each runnable on its own:

| Guardrail | Asserts |
|---|---|
| `check:syntax` | Every shipped and tested file parses as ESM under Node. |
| `check:history` | Every range/interval pair written anywhere in the repository, prose included, is one the history contract supports. |
| `check:calendar` | The session calendar's definition digest, its closures and session counts over the pinned years, its early closes, and its refusal of the years it never described. |
| `check:css` | Selectors stay under `.marketmap-app` with one owning file and layer; entry points keep their import order; `--mm-*` resolve in both themes; colour literals stay in `tokens.css`. Reviewed exceptions live in an identity-based baseline; regenerate it with `node scripts/check-css-scope.mjs --update` and review the diff. |
| `check:contrast` | The theme colour pairs Market-Map's own CSS paints clear 4.5:1 for text and 3:1 for graphics, in dark and light. |
| `check:boundaries` | Browser code imports no server module, provider URL, secret name, or simulation code. |
| `check:capabilities` | Provider manifests match the implemented provider surface and current taxonomy. |
| `check:graph` | Every import reachable from `index.html` resolves under a path the dev server serves, and every import reachable from the package exports lands inside `files`. |
| `check:fonts` | The published font binaries carry the SIL Open Font License notice that names them. |

The live canary is intentionally outside deterministic CI. It records only
contract state, row/availability counts, key/type paths, and shape hashes —
never prices, tokens, response bodies, stacks, or raw URLs. Set
`MARKET_CANARY_OUTPUT` to save a JSON report with file mode `0600` and
`MARKET_CANARY_BASELINE` to compare raw shape hashes against a reviewed prior
report. Fixture updates remain a reviewed code change; the canary never writes
fixtures.

### UI design contract

`css/marketmap.css` is the only stylesheet entry point. Its ordered layers move from tokens and
base rules to components, states, motion, and utilities; every application selector stays scoped to
`.marketmap-app` and has a single owning file. `css/news.css` exclusively owns the `.mm-news*`
namespace in the existing components layer, after details and before overlays. Shared structural
tokens live on the app root, while dark and light each provide a complete semantic colour contract.

A stylesheet here styles what the board puts in the DOM. Where a design system component renders
the markup — the news feed, the tiles — that component owns its class names, and the way to change
its appearance is its own props and tokens. A `.mm-*` rule that matches nothing is a hook a
consumer would find by reading the CSS and then discover was never real; `npm run test:unit`
fails the news sheet on one.

The semantic colours in `css/tokens.css` mirror `@ciavalabs/ds-tokens` and are kept in lockstep by
hand: when the design system moves a palette value, this file follows it in the same change.

The visual language is deliberately restrained: Inter carries headings, controls, and data, panels
use hairlines and small radii, and strong elevation belongs to overlays. Directional tile colour is
the data visualization. New UI must not introduce local colour literals, ID selectors,
`transition: all`, unreviewed `!important`, or a second override stylesheet; `npm run check`
enforces these constraints. Text drawn by a design system component over a board surface belongs to
neither package's token guardrail, so `npm run test:browser` measures it composited as rendered.
Intentional visual changes must regenerate and review all browser baselines with
`npm run test:visual:update`.

## Notes

The bundled workspace is a 40-instrument cross-asset starting board — equities
beside funds, indices, FX, rates, crypto and one continuous future, interleaved
across the board — while the product board defaults to 60 and may contain any
enabled, resolved asset class. The analytics cohort stays equity-only: it comes
from the curated universe the host passes to the runner, the board never feeds
it, and neither the board limit nor multi-asset fetching widens it.

Market data is informational and may be delayed, stale, incomplete, or
unavailable. It is not investment advice.

The code carries no comments: the invariants, the decisions whose reason is not
local, and the traps are in [ARCHITECTURE.md](./ARCHITECTURE.md),
which ships with the package.

## Versioning

Semantic versioning. Changes to the package surface — the API contract, the
exports, the CSS entry points — are recorded in [CHANGELOG.md](./CHANGELOG.md).

## Reporting a vulnerability

Weaknesses go to
[GitHub's private advisory form](https://github.com/CiavaLabs/MarketMap/security/advisories/new).
Include the request or configuration that reproduces the problem, and what the
server or the browser did with it.

Two boundaries are worth stating up front. Provider credentials are server-side
by construction, so anything that carries `FINNHUB_API_KEY` towards the browser,
a log line, or a canary report is in scope. Request metering is opt-in: without
`quota` the API applies no limit of its own, and that is documented behaviour.

## License

[MIT](./LICENSE)

The package also redistributes two variable fonts, Inter and Newsreader, under
the SIL Open Font License 1.1. Their notice travels with the binaries in
[`assets/fonts/OFL.txt`](./assets/fonts/OFL.txt); `check:fonts` keeps it there.
Hosts that already serve those families should import the `nofonts` stylesheet
entry instead and carry neither.
