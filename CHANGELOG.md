# Changelog
All notable changes to this project will be documented in this file.
This project adheres to [Keep a Changelog](https://keepachangelog.com/) and uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-08-18
First public release. An embeddable market board for equities, ETFs, indices, FX, crypto, continuous commodity futures and rate indices, with a provider-agnostic server API and no production dependencies.

### Added
- One `/api/market/v1` surface for identity, quotes, history, details, news, analytics and health. Every envelope declares schema version 2 with its semantic and capability revisions, responses are capability-gated, and a partial batch failure stays local to the item that caused it.
- Embeddable browser client: `createMarketMapExperience`, `MarketDataClient` and `renderMarketMapShell`. A host holds several named boards, each with its own instruments, arrangement and news state, persisted in `localStorage`.
- React islands under `@ciavalabs/marketmap/react`, published as an unbundled barrel with `react`, `react-dom` and `@ciavalabs/ds-react` left external, for hosts that already run React.
- Server composition through `createMarketDataService`, with optional MySQL snapshot, instrument-catalog and analytics stores, and a `Request`/`Response` entry point.
- A Yahoo Finance transport that ships with the package: `YahooClient`, `YahooSession` and `YahooCookieJar` speak to the quote, quoteSummary, chart and search endpoints over `fetch`, including the cookie and crumb handshake the first two require.
- An optional request quota, charged by the upstream work a request causes. It requires a `clientKey`, because only the host can identify a caller behind its own proxy. Exceeding the allowance answers `429` with `retry-after` and the `quota_exceeded` code; without `quota` there is no limiting.
- `nyseCalendar`, `createExchangeCalendar` and `reconcileSessionGrid`: session grids generated from an exchange's published rules and reconciled against the sessions the market actually traded. Reconciliation fails closed, a market's own week is a parameter, and the calendar declines the years its rules were never checked against.
- Optional end-of-day movement analytics, inert unless the host supplies an append-only store, an explicit equity universe and a versioned session grid. `GET /analytics/snapshot` serves the persisted assessments and answers `501` where no store is configured.
- Instrument identity as a first-class surface: canonical ids, an allowlisted venue registry, a curated catalog, and a resolver bounded by `maxResolvedDescriptors` that pins the curated set and evicts only what can be resolved again.
- Four stylesheet entry points — the full board and the embed, each with and without fonts — plus the Inter and Newsreader variable fonts under the SIL Open Font License 1.1.
- `ARCHITECTURE.md` and `RUNBOOK.md`, both shipped inside the package: the invariants and traps behind the code, and what an operator reads mid-incident.
- `GET /health` names its `capabilities`: the operations the wired service implements. An instrument's asset policy says whether an operation applies to it, and says nothing about whether a deployment configured the store behind it. A client reads the list once instead of discovering the difference through a `501` on a normal interaction.
- Accessibility the board owns rather than inherits: the update status announces a change of state and never the clock it also displays, the Add instrument dialog returns focus to whatever opened it, and a skip link ahead of the grid carries a keyboard visitor past the per-tile reorder stops.
- The browser suite measures text a design system component paints on a board surface — foreground and translucent tint composited through tile, surface and page — and holds it to 4.5:1 in both themes. Neither package's token guardrail can see that combination on its own.

### Data handling
- Yahoo Finance is the primary provider. Finnhub serves one approved, semantically equivalent fallback cell — raw quotes for US equities with a verified mapping and an allowlisted MIC — and a configured key does not broaden that policy.
- Yahoo's chart and news endpoints are unofficial and carry no availability SLA. Finnhub requires a key, and whether its plan and licence cover a given deployment has to be verified separately.
- A quantity that cannot be certified is published as `null` with a reason code, and the rule composes upward: a field omits itself, a section omits itself, and the statistical context omits itself whole before showing one unverifiable line.

### Packaging
- No production dependencies. `react`, `react-dom` and `@ciavalabs/ds-react` (`^0.2.0`) are optional peers, installed only by a host that mounts the React islands. Node.js 22 or newer.
- The source, the SQL migrations and the configuration files carry no comments. The reasoning lives in `ARCHITECTURE.md`.
- Nine guardrails behind `npm run check`, deterministic Chromium quality and visual suites, and a provider canary that stays outside deterministic CI.

See **Data handling** in `README.md` for what the providers guarantee, and `ARCHITECTURE.md` for where each component stops.
