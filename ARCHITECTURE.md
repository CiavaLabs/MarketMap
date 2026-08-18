# Architecture

Invariants, decisions whose reason is not local, and traps. The public contract
is in [README.md](./README.md) and is not repeated here.

## Boundaries

**Browser ↔ server.** The browser talks to a same-origin API and nothing else:
no provider module, provider URL, secret name, or simulation code reaches
`src/`. `check:boundaries` reads `src/` and `shared/` for those patterns.

**Package ↔ demo page.** Two loaders resolve this code and neither is the
filesystem the repo sits on: the demo page has no bundler, so the browser walks
`index.html`'s graph over HTTP against the prefixes `server/dev.js` serves; a
consumer gets the tarball `files` describes. `check:graph` asserts both. The
unit suite resolves from disk and sees neither failure.

## Identity is persistence

Canonical ids (`XNAS:AAPL`, and a fixed namespace — `FX:`, `CRYPTO:`, `INDEX:`,
`RATE:`, `FUTURE:` — for classes with no exchange to name) live in readers'
saved boards and in the catalog. They are keys:

- Presentation never rewrites them. Yahoo's caret (`^GSPC`) is stripped where a
  name is displayed, and only there; exchange suffixes (`FTSEMIB.MI`) stay,
  because they really do distinguish two listings. Every display path goes
  through `displaySymbolOf`, because the rule is only as good as its least
  careful fallback: one that ends at the raw symbol paints `^GSPC` on a starter
  board until the descriptor arrives.
- Dropping the caret is a fallback with a limit. It yields the market's own
  ticker for `^VIX` and `^TNX`, while `GSPC` and `DX-Y.NYB` are Yahoo's codes and
  belong to no exchange, so those carry a curated display symbol — `SPX`, `DXY` —
  the way continuous futures already do. The table is an override list: an index
  nobody curated still gets the mechanical rule, and the instrument's name is
  what carries the meaning either way.
- The starter workspace id is `us-equities` while the board it names is
  cross-asset, and the `marketmap-boards-v3` key keeps its earlier schemas for
  rollback. Renaming either strands boards to describe them more tidily.
- MICs come only from the `VenueRegistry` allowlist. An unknown venue resolves
  to `kind: "unknown"`, `mic: null` — never a guess, and never a Yahoo suffix
  invented for it.
- Discovery is not identity. Search returns provisional results; only a
  confirming quote hydration mints a descriptor, so a provisional mapping is
  searchable and never addable. A persisted provider symbol is an untrusted
  hint that the quote must reproduce exactly.
- An alias finds an instrument. It never confers identity. Provider results are
  matched against declared provider mappings only, because the lookup index
  answers on symbols, ids, aliases and provider tickers alike: matching on any
  of them let Yahoo's `GOLD` — Barrick's ticker, and also the gold future's
  alias — hand an equity the future's identity before its own was ever derived.
  Asset class follows the same rule and falls back to the provider's declared
  type, which keeps `^TNX` a rate index where Yahoo calls it a plain index.
- The curated catalog is read once, at construction, and never written to again.
  It seeds the resolver's descriptor map and is otherwise inert: identity that
  arrives from a provider lives in the resolver, which is the only thing that
  can evict it. The alternative is two mutable stores kept aligned by hand.
- What the catalog still owns is the curated **alias** text, which is carried
  into the resolver at seed time. Without it, an exact-alias query — `DXY`,
  `BTCUSD`, `10Y` — stops matching the instrument that declares the alias, and
  because a zero score is floored to one, the instrument still comes back,
  ranked last. The aliases sit in a map beside the descriptors: a descriptor is
  replaced wholesale when its id is rediscovered under another provider symbol,
  and anything riding on it would go with it.
- A provider symbol that moves off an instrument is retired when the new
  descriptor arrives. Eviction only ever sees the descriptor current when it
  runs, so a symbol left behind would point at an id for the life of the
  process — past that descriptor's own eviction.
- Search filters are charged before the seed is truncated. A row about to be
  discarded must not spend one of the caller's places and crowd out a relevant
  one.
- Nothing re-derives a descriptor's canonical id from its own venue except the
  resolver, on the way in. It never blocks; it is the operator's only signal
  that identity has drifted, and rehydration from the store is where a
  descriptor written by an older build arrives.
- The resolver's descriptor map is bounded, and the curated seed is pinned.
  Everything else in it was minted from a search or a cold resolve, is
  reproducible from the catalog store or another hydration, and is therefore
  safe to evict; the curated set is not reproducible and never leaves. Eviction
  takes the provider-symbol index with it — including any key that has since
  moved to another instrument, retired on the way in so that it never points at
  a descriptor that has gone — because a board that outlives its descriptor must
  cost one resolution and no more. A board is resolved on every refresh, so it
  stays resident.

## Provider payloads, and what the normalizers refuse

- A boolean is never a number. `Number(true)` is `1`, so an unguarded coercion publishes an upstream
  glitch as a quote priced at 1. Every numeric read refuses booleans; volume and headcount refuse
  negatives as well, because they are counts. Prices are **not** sign-constrained: negative futures
  and negative rate observations are real, and the asset-class policy decides per class.
- A bare number in a timestamp field is an epoch in **seconds**. Yahoo's schema-declared timestamps
  arrive as `Date` objects, but chart metadata carries undeclared ones straight through as integers.
  Read as milliseconds they land in January 1970 and validate cleanly, which is why all three
  converters draw the line at `1e12`.
- A price-less quote carrying `quoteType: "NONE"` is Yahoo's answer for a symbol it no longer lists.
  That is a dead instrument: reporting schema drift would send the orchestrator to the fallback
  provider for something nobody can quote and reach the caller as a retryable 502 where an honest
  404 belongs.
- Yahoo reports margins and yields as fractions and `debtToEquity` as a percentage. Every ratio is
  published in one currency — percentages as percentage points, plain ratios as plain ratios — so
  the client formats by field, with the provider's quirks absorbed at the boundary.
- An unusable clock fails at the clock. Assembling a payload around a null `fetchedAt` and letting
  the contract reject it points the diagnosis at the provider while the misconfiguration is the
  cause.

## The Yahoo transport ships with the package

`server/providers/yahoo/yahooClient.js` speaks to four Yahoo endpoints —
`/v7/finance/quote`, `/v10/finance/quoteSummary`, `/v8/finance/chart`,
`/v1/finance/search` — over `fetch`. The obvious alternative is `yahoo-finance2`,
and it is the reason this package has a transport of its own: its
`@modelcontextprotocol/sdk` edge pulls Express, Hono, `cors` and `eventsource`
into every consumer's tree, 106 transitive packages and six advisories to reach
an HTTP client, and the last release without that edge is a version its author
has since deprecated. Only the transport is taken on here; the normalizers, the
contracts and the capability gating are this package's own.

The response shaping follows `yahoo-finance2` deliberately, because the
normalizers are written against that shape: `quoteSummary` values unwrapped from
their `{raw, fmt}` envelopes, chart columns pivoted into one row per bar, keyed
event maps as arrays, and the listed timestamp fields as `Date`. Two fields
diverge, neither read by anything here: `sharesShortPriorMonth` is a share count
and stays a number, `lastSplitDate` is a date and becomes one.

- **The consent form is parsed as markup.** HTML permits
  attributes in any order, single quotes, unquoted values and extra attributes,
  and Yahoo owns that serialization. A parser bound to `type` then `name` then
  `value` in double quotes submits a form carrying only the two agreements the
  moment Yahoo reorders anything, the crumb never arrives, and every quote and
  details request fails at once. Each `<input>` therefore has its attributes read
  independently. `Max-Age` likewise wins over `Expires` regardless of the order
  they arrive in, so a deletion header actually deletes.
- **The jar and the redirect walk are pinned to Yahoo's own domains.** A
  `Set-Cookie` naming any other domain is discarded, and a `Location` is parsed
  to a URL and checked by hostname before it is followed —
  `https://guce.yahoo.com@attacker.example/` matches a substring test for
  `guce.yahoo.com` and resolves to `attacker.example`, which is how a session
  cookie leaves with one redirect. Both checks read the same allowlist, because
  a cookie accepted for a domain nothing will ever be sent to is only a
  liability.
- **The handshake runs on its own signal and its own budget.** The caller's are
  never used. It is shared: the second caller to arrive during a cold start
  waits on the first one's promise. Binding that promise to whoever happened to
  arrive first means their timeout, or their client hanging up, cancels the
  handshake for everyone still waiting — and the orchestrator gives each request
  2.8 s while the handshake alone measures 1.0–1.3 s before any consent gate.
  Its timer is deliberately not `unref`'d: it is the only thing that can end a
  handshake whose socket never answers.
- **A rejected session is never reported as a rejected credential.** `401` and
  `403` reach `inferErrorCode` as `auth_failed` and `entitlement_missing`, and
  `#callProvider` quarantines those for the life of the process. That suits
  Finnhub, where a bad key or a missing plan will not fix itself. Yahoo has no
  credential to correct, so the same treatment misfires there: two transient
  rejections would otherwise disable the provider until restart, with no breaker
  and no backoff. Every Yahoo path therefore converts an exhausted crumb
  rejection into a retryable upstream failure before it leaves the client, so the
  breaker handles recovery and Finnhub's classification is untouched.
- **Shaping is faithful to that library, including fields nothing here reads.**
  `YahooClient` is exported, so its contract is the whole shape `yahoo-finance2`
  produces, beyond the subset the normalizers consume. That
  extends to arity: `quote("AAPL")` answers with one quote and `quote(["AAPL"])`
  with an array, because a host reading `regularMarketPrice` off an array would
  get `undefined` and no error. The exceptions are named above.
- **A session is retired by generation.** `invalidate(n)` does
  nothing if `n` is no longer the current generation, and nothing at all while a
  handshake is in flight. Concurrent callers all receive `401` against the same
  expired crumb and all try to retire it; an unconditional clear from the second
  one wipes the cookies the first one's handshake has already collected, and the
  handshake then publishes a crumb with no cookie behind it — every retry fails
  until something invalidates again. The generation counter is what makes this
  airtight, since the crumb text is opaque and nothing promises a replacement
  session will be handed a different string.
- **Yahoo answers `429` to a User-Agent that impersonates a browser.** A Chrome string from a server
  is bot traffic without a browser's fingerprint, and the crumb endpoint refuses it outright; a bare
  token like `marketmap/0.1.0` is refused too. What passes is the self-identifying form,
  `Mozilla/5.0 (compatible; <name>; +<url>)`, which is also the honest thing to send. It is one
  constant, `YAHOO_USER_AGENT`, and a host can replace it.
- **`quote` and `quoteSummary` need a crumb; `chart` and `search` do not.** The crumb costs a
  handshake — seed `finance.yahoo.com`, clear the `guce.yahoo.com` consent gate by submitting its
  form, then read `/v1/test/getcrumb` with the cookies that flow back. It is cached for an hour,
  acquired once under concurrency, and dropped and retried once when Yahoo answers `401` or `403`.
  A failed handshake is not cached: the next caller tries again.
- **`firstTradeDateMilliseconds` is milliseconds by declaration.** The `1e12` rule
  above is a heuristic for undeclared fields and it misreads this one: Apple's first trade is
  `345479400000`, which is below the line, so the rule would place it in the year 12917. Fields whose
  unit is named are converted by their name.
- **Yahoo's `adjclose` is not reproducible to the last bit.** Two identical requests in different
  sessions return values that differ around the seventh significant digit, while `close` is
  identical. The adjustment is recomputed upstream in single precision. The behaviour is the
  provider's, and it means a re-fetched `provider_adjusted` series is not guaranteed to hash the
  way the first one did.

## The session calendar is generated, then checked

The grid comes from rules and the data is what checks it. Reading it off SPY's
own history would be circular: a session the provider dropped becomes a day the
exchange was closed, and the hole the missing-session check exists to find
disappears from view.

The rules reproduce NYSE exactly over the 33 years SPY has traded: 8,438
sessions with eleven exceptions, every one an announced closure no rule could
have produced — a hurricane, four days after September 11, and five national
days of mourning. Reconciliation compares generated against observed and **fails
closed**: a disagreement is either a closure missing from that list or a data
fault, and both are findings to act on.

- **A rule carries the years it applies to.** NYSE began observing Martin Luther
  King Jr. Day in 1998 and Juneteenth in 2022, and 1997 is inside the window
  research would use.
- **Observance is per-holiday.** A fixed date usually moves off the weekend,
  while a Saturday New Year is lost entirely: 2028 has nine closures.
- **The revision is a digest of the definition and of the engine evaluating it.**
  Change either and every grid stamped with the old revision is visibly a
  different calendar, which is what stops two calendars claiming one identity.
- **The calendar declines the years it was never checked against.** Memorial Day
  moved to the last Monday in 1971 and the rules here are the exchange's current
  ones, so a question about 1969 is refused. `describedFrom` is where the
  verified record starts.
- **The market week is a parameter.** Tel Aviv trades Sunday to Thursday — a
  different week entirely, so the week is declared and a holiday landing outside
  it is dropped where a shift inward would invent a session.
- **An early close is still a session.** A daily bar exists either way, so those
  days are recorded and deliberately do not affect the grid.

The run assesses one session, and its information set ends there. History
arriving fresher than that session — the provider's partial bar for a day still
trading — falls outside the set, so it is dropped before the series is
validated, hashed or read. Everything describing the retained observations is
rebuilt with it — `asOf`, the row and gap counts, the issue list and the quality
status — including a row the provider itself discarded, which carries the
session it came from so it can be forgotten with the rest. A discarded row whose
timestamp was unreadable belongs to no session and stays. History that stops
*before* the assessed session is a fault and still refuses the run. Without that
split a run started while the market was open could never assess the session
that closed the evening before, which is every local run and every delayed
retry.

One calendar ships, because the movement cohort is US equities by construction
and the analytics declines everything else with `unsupported_asset_class` or
`unsupported_session_model`. The generator is general and its generality is
tested; the instances follow demand as it appears.

## What holds under a stampede

A board refresh is forty instruments arriving together, so simultaneous callers
are the normal case for every primitive here. What
makes the reasoning tractable is that none of these primitives yields inside its
own decision: the breaker's admit-or-refuse, the single flight's
find-or-start, the quota's read-and-decrement and the session's is-there-a-crumb
each complete within one turn, so a caller cannot observe a half-made decision.
Every state change that spans an await is therefore either idempotent or guarded
by a token that identifies which attempt it belongs to.

- **One probe leaves a half-open breaker**, however many callers arrive in the
  same tick, because `probeInFlight` is set inside `#admit` before any await.
  A failed probe reopens the breaker and clears the flag with it.
- **A rejected flight is not cached.** `SingleFlight` removes the key on every
  settle, so one upstream failure does not pin every later caller to it.
- **Retiring a session is idempotent.** Twenty callers invalidating the same
  generation all report success and the session is retired once; the generation
  is refused only after a replacement handshake has advanced it. The boolean
  reports whether the named generation was still current, saying nothing about
  which caller did the clearing.
- **The quota's two phases cannot mint a token.** A refund is capped at the
  limit, so an interleaving where a refund lands after an unrelated refill
  cannot lift a client above its allowance.

## What a request costs

The optional request quota meters upstream work. One HTTP call is no fixed unit
of anything, so a limiter counting requests would let a caller generate eight
times its stated allowance through the cheapest-looking endpoint.
[README.md](./README.md) carries the per-endpoint costs.

Those costs are worst case, because they include the work a cold request causes
before it reaches the provider: a details or history request for an unresolved
id pays for the resolver's own hydration on top of the two calls the provider
then makes, which brings those to three. The same hydration is why the floor on
`limit` reaches past `maxBatchIds` to the dearest single request.

## Capability gating

Effective capability = provider manifest ∩ verified mapping ∩ asset policy ∩
feature flag. It is the only capability surface the client sees; the browser
never reads a provider manifest, and `check:capabilities` holds the manifests
to what the provider code actually implements.

`server/instruments/assetPolicies.js` is the single authority for product
semantics per asset class — what a volume figure means, whether a provider zero
reads as a placeholder or as a traded quantity, whether an order book applies,
whether prices may print below zero (futures and rate indices may). Nothing in
the browser re-derives these from a provider payload.

Finnhub is a selective fallback. The semantic-equivalence matrix permits
Yahoo → Finnhub raw quotes for US-listed equities with a verified mapping, and a
cell it does not name is denied.

That gate answers what an *instrument* supports. It says nothing about what a
*deployment* implements: analytics is inert until a host wires an append-only
store, and a service object built without one has no `getAnalyticsSnapshot` at
all. The two are independent, so an equity whose asset policy allows analytics
still meets a `501` on a deployment that never configured the ledger.

`GET /health` therefore reports `capabilities`, derived from the methods present
on the service object and from whether a resolver is wired. It is the only place
a client can learn the difference, and `AppController` reads it once before its
first analytics request. Discovering the same fact by making the request and
reading the `501` costs a red console error on a normal interaction, which
teaches whoever embeds the board to ignore console errors on that page.

## Fail-closed data

A quantity that cannot be certified is `null` with a reason code — never zero,
never `N/A`, never a placeholder. The rule composes upward: a field omits
itself, a section omits itself, and the statistical context omits itself whole
before it shows one unverifiable line.

- The availability sidecar must explain every null field, and every
  available/stale entry must certify a usable value.
- Last-known-good keeps its provenance: `source` is always the provider that
  produced the observation, `originalSource` appears only on replay. Both must
  be *read* — a stale series arrives looking valid, and only `quality: "stale"`
  and `stale_last_known_good` distinguish it.
- One malformed item degrades its own tile and never the batch.

## Analytics

The movement slice is inert unless a host injects a store, a cohort and a
session grid. What it computes is bounded by discipline:

- **Point-in-time.** `h_t` is emitted before `r_t` is read into the recursion,
  and rarity for session `t` uses exactly the last 756 finite standardized
  scores ending no later than `t-1`.
- **No imputation.** A missing session produces no return and no score; prices
  either side of a gap are never joined into a multi-session observation. The
  conditional variance is carried forward, which is an assumption of the
  zero-mean model and is named as one in the contract.
- **The rank is not a p-value.** It is a rolling empirical exceedance rate with
  a plus-one correction. At 756 prior scores the grid is 0.13 wide and caps at
  the 99.87th percentile — which is why the exceedance count is displayed
  beside the percentile, stating the resolution the rank was read at.
- **Standardization is a scale.** Dividing by the forecast
  volatility makes yesterday comparable to last year; it does not make the
  result normal. Measured over the cohort, moves beyond 3.29σ arrive about
  eleven times more often than the normal curve implies. No threshold, interval
  or label is derived from a multiple of σ; the empirical rank is the only
  rarity stated anywhere.
- **The cohort is not forty independent observations.** Its members move
  together — a cross-sectional correlation near 0.25 leaves roughly four
  independent assets out of forty. A daily count of anything is therefore
  dispersed about three times wider than a per-asset rate implies, and any
  interval built as though asset-days were independent draws is about three
  times too narrow. Both figures come from a single pass over the current
  cohort and are not certified constants.
- **The cohort is equity-only** and comes from the host, never from the board.
  The runner rejects a universe containing its own `ARCX:SPY` benchmark.
- **The host owns the calendar and the clock.** The runner validates a session
  grid's shape and consistency, never its authority, and has no scheduler.
- **`provider_adjusted` is not total return.** Yahoo declares
  `includesDistributions: "unknown"`; the product does not promise more.
- The ledger is append-only. Reads revalidate persisted records against the
  contract that wrote them: no recompute, no backfill, and no fabricated
  `unavailable` for an instrument the runner never assessed.

## Cache and persistence

- Market cache entries live in a namespace that cannot collide with the news
  keys beside them. The `v2` segment inside every cache key, and the `v2_` prefix
  on stored resource types, are **values written to disk** — renaming either
  would orphan every persisted row, so they stay whatever they were the day they
  were first written. `SEMANTIC_REVISION` and the `marketmap-board-v2`
  localStorage key are frozen for the same reason.
- Market contracts live in `server/contracts/market/`, and the shared foundation
  they build on — error codes, the history range allowlist, the news and
  analytics validators — in `server/contracts/core/`. They are two domains, which
  is why both define a `SCHEMA_VERSION` and an `ASSET_CLASSES`, and why the
  market ones carry a `MARKET_` prefix.
- `MARKET_SCHEMA_VERSION` is `2`. It is not an HTTP version and does not track
  one: the API is `/api/market/v1` and stays there. It is the shape number
  stamped into persisted records, and it reached 2 before the transport was ever
  published. Leave it alone.
- Persisted records are hash-checked and re-validated on read, never trusted.
- The snapshot cache's `DATETIME` columns hold UTC, and both directions say so
  without asking the connection: writes bind a UTC wall-clock string, and reads
  cast the columns to characters. A `Date` handed to mysql2 is converted using
  the session timezone, while the read path tags what comes back as UTC — two
  instances in different zones would have disagreed about freshness by their
  offset. The instrument catalog store is deliberately exempt: its columns are
  `TIMESTAMP`, which MySQL converts symmetrically, so casting them would
  introduce the very skew this avoids.
- Expiry is a read filter in both stores and pruning is the host's to call, so
  the in-memory stores carry their own LRU bound.
- A snapshot store holds the last good value per key. It is not a point-in-time
  history and cannot serve as the analytics ledger. The instrument catalog store
  is a third thing again: identity must survive a restart even when every quote
  in the cache has expired.

The ledger tables (`server/analytics/persistence/migrations/`) carry their own
rules:

- Instants are stored as fixed UTC ISO strings, so ledger identity never depends
  on a mysql2 connection timezone.
- Observations are immutable. Rewriting unchanged content is idempotent, while
  A → B → A is three revisions: the third A is its own event.
- A forecast row holds the point-in-time forecast alone. Realized values and
  scoring belong to the later, equally immutable assessment records.
- One assessment per instrument per run. The indexed identity and session
  columns are re-checked against `assessment_json` on every hydration, so an
  index that hands back the wrong row cannot pass as data.
- A manifest captures the analytics-relevant projection *after* contract
  validation, with ordered bar membership and the host's versioned grid kept
  explicit. The grid is recorded as context; the ledger does not certify it.
- Two executions of the same deterministic run stay two audit attempts.

## Browser composition

The vanilla controllers own everything with a policy in it — networking,
capabilities, abort and request generations, data semantics — and the React
islands own interaction state only. Both hosts therefore share one policy.

- `gridStore` gives each cell a per-instrument subscription, so a price tick
  renders one tile and leaves the board alone.
- Overlays live outside `.container` but inside `.marketmap-app`: `.container`
  is a query container, and layout containment traps `position: fixed`
  descendants. Portals therefore target their own mount node, never
  `document.body`.
- `.marketmap-app` is also the `[data-ds-root]` element, so `css/tokens.css`
  mirrors `@ciavalabs/ds-tokens` by hand and must move with it in the same
  change. A drifted token shows up as two greens on one row, and no check fires.
- The board pulse is deliberately equity-only; aggregate data status covers the
  whole quote-capable board. Neither follows the filtered grid. Advancing and
  declining count from zero; the ±0.5% bands belong to the movement filter.
- The design system renders the news feed and the tiles, so it owns their class
  names. A `.mm-*` rule written against markup this repository does not emit
  matches nothing and reports nothing, and a consumer reading the stylesheet for
  a styling hook finds it only by testing the DOM. `css/news.css` styles the
  cell chrome around the feed; changing the feed itself goes through the design
  system's props and tokens.
- Contrast is measured where the two packages meet. `check:contrast` compares
  `--mm-*` foregrounds against `--mm-*` backgrounds, and the design system holds
  its own tokens to the same bar; neither sees a design system component painted
  on a Market Map surface. The change pills live exactly there — a `--ds-*`
  foreground over a translucent tint over this board's tile, surface and page —
  and were below 4.5:1 in both themes with both gates green. The browser suite
  composites them as rendered and holds every one to 4.5:1, which is the only
  place the whole stack exists.
- The status line carries no `aria-live`. Its text ends in a wall-clock time
  that a ten-second refresh rewrites whether or not a price moved, and a live
  region there speaks the clock on a loop for as long as the page is open. A
  visually hidden sibling announces the state instead, and only when the state
  changes.
- The dialogs are opened imperatively, without a `Dialog.Trigger`, so Base UI
  has no element to hand focus back to on close. The Add instrument dialog
  records what was focused when it opened and passes it as `finalFocus`; without
  that, Escape drops focus to the document body and a keyboard visitor restarts
  from the top of the host page.
- Every tile is followed by a reorder handle that is 1px and clipped until it
  takes focus — the only way to reorder the board without a pointer. A 40-name
  board therefore costs 80 tab stops with nothing visible to explain them, and
  the shell opens the grid with a skip link to a target after it. The design
  system's `SkipLink` is a different primitive and is deliberately not used
  here: it is fixed to the top-left of the viewport and belongs first inside
  `<body>`, where it bypasses a page's navigation. This one bypasses one block
  inside a host's page, sits in the flow, and is rendered by a shell that
  produces markup as a string with no React root at that point.

The demo page (`index.html`) carries two loading decisions of its own: the
inline canvas paints before the stylesheets land, mirroring `--mm-bg` for the
theme `main.js` will set; and the island bundles are declared as
`modulepreload` because they are dynamic imports at the end of the module
graph, found only once `src/` has resolved and otherwise fetched late.

## Dragging and packing the board

### Picking a tile up

The whole cell is the drag surface: a tile has one meaning, so nothing on its
face competes for a press. A grip stays in the DOM for the keyboard, hidden
until focus reaches it. The news block is a panel with links inside it and keeps
a visible grip of its own.

A press is told apart from two other gestures. **From a click**, because a tile
opens its instrument on click: a mouse or pen declares a drag by moving past a
small threshold. **From a scroll** on touch, because the first millimetres
belong to the page: a finger declares a drag by *staying still* for a hold. Once
a touch drag is live, a non-passive `touchmove` listener vetoes the scroll for
that gesture only — React's own touch listeners are passive, so the veto is
registered outside them.

The pointer is deliberately not captured. `setPointerCapture` retargets
`pointerup` onto the captured element and the browser then fires `click` on the
nearest common ancestor of press and release; with the drag surface covering the
whole tile, every press would resolve to the cell that holds the tile, and
opening an instrument would quietly stop working. Document listeners follow the
gesture, which also keeps a drag alive when the pointer leaves the board.

### How the board fills

The user owns the sequence, the market owns the size. The packer walks the
sequence in order and gives every tile the earliest free region — scanning the
whole board from the top — that holds it. A cell a hero had to skip because it
cannot start in the last column stays open, and the next tile that fits comes
back for it.

The contract is density: the board never keeps a hole that any tile in the
sequence could close. The price is that a compact tile may land visually ahead
of larger tiles authored before it. Bounding that travel with a look-ahead
window is the alternative, and it accepts holes; the holes read as a broken
board, so density wins.

### Moving

The board is packed from the order the drop *would* leave behind: the held tile
is lifted out of the sequence and put back at the insertion index, so the others
open a real gap for it.

Order moves while a tile is held; size does not. Re-tiering runs on its own
background cadence, and a tile that doubles mid-drag moves the goalposts under
the hand. The ranking captured at pick-up governs until the tile is let
go, and governs the cells as well as the packing, because a slot and the tile in
it are one size.

Which tile the pointer is over decides everything; *where* inside it does not.
That is one swap per tile entered, and three rules keep it from oscillating:

1. **The target comes from the resting layout.**
   Hit-testing the painted DOM reads tiles mid-animation — one still travelling out of
   the way is found where it no longer belongs, the insertion index follows it
   back, and the board ping-pongs for as long as the pointer sits near the seam.
   Measured over a single straight sweep, that was 22 rearrangements across 4
   distinct layouts.
2. **One reorder in flight at a time.** The resting map is true again only once
   the board has repacked and been measured; until then every answer is read off
   the arrangement the previous swap already replaced, which is how a fast drag
   swaps the same pair back and forth.
3. **A reorder is paid for in pointer travel.** The board reorders because the
   hand went somewhere. A boundary falling under a stationary cursor buys
   nothing.

Geometry is kept in document coordinates, so scrolling mid-drag moves the board
and leaves the tile where it is. The tile is placed from the point the pointer took hold of it,
against the slot it currently occupies — and that slot travels, because the
board is repacking around the gap. Anchoring to the press position would peel
the tile off the pointer the first time the gap moved; re-anchoring happens
inside the same layout pass that repacks, so the tile never leaves the pointer
for a frame. That travel is an inline transform written per frame, never React
state: a render per pointer frame is the stutter. The lift is carried by `scale`
and `filter`, which compose with the transform and can therefore be handed to a
CSS transition.

### Dropping

The slot is already open, so the drop is only the journey into it: a longer
decelerating curve than the reflow.

The gesture is not torn down at the drop. It is held open until the reordered
board comes back through `order`, because tearing it down immediately would
repack to the *old* order for as long as the host takes to answer, undoing the
move on screen. A timeout releases it if that answer never arrives.

### Motion

One FLIP pass owns every structural reposition: filter and sort, tier changes,
resize, news collapse, a drag opening a gap, and the committed order all flow
through the same explicit placement map. Before each change the *animated*
positions are captured, leaving the resting ones the last pass recorded —
starting a new flight from where the previous one would have ended is what makes
a quick reorder stutter. A board making room under a live gesture animates
faster than one settling after a filter.

## Performance decisions that look like premature optimization

| Decision | Why it is there |
|---|---|
| `clonePlain` in place of `structuredClone` | ~4× faster on the JSON shapes crossing the isolation boundaries; deeper structures delegate back to keep semantics and bound recursion |
| Memoised `Intl` constructors | Building one costs one to two orders of magnitude more than using one, and the chart formats a timestamp per point on every hover |
| Tier hysteresis before publishing | Republishing unchanged tiers repacks the layout and re-measures every cell inside a `flushSync` — the board hitches for nothing |
| Detail model walked backwards in place | Reversing it allocates a second array, and it is rebuilt on every quote tick and every chart hover, over several hundred points |
| Same-bar hover republishes nothing | Otherwise the model rebuilds and renders synchronously once per pointer frame |
| Drag frame writes style directly | Browsers already coalesce `pointermove` per frame; routing it through React re-renders the board per frame |
| Batches dedupe on canonical identity | `AAPL` and `XNAS:AAPL` are one instrument: fetched, cached and returned once |
| Bounded concurrency on cold reads and snapshot writes | A 40-item request must neither serialize 40 round trips nor open 40 at once |
| Memoised grid and benchmark validation | One run revalidates the same frozen grid and the same benchmark against every asset |
| `idx_market_assessment_latest` read in reverse | Makes `LIMIT 1` a backward index scan; an `IS NULL` term would force a filesort |
| News budget starts before identity resolution | Cold descriptors can need a quote hydration, and a timer started after it lets a request exceed its advertised deadline |

## Traps

| Trap | What happens |
|---|---|
| `// @vitest-environment jsdom` | A functional pragma. Remove it and that file's DOM tests run in node |
| `/* scoped: marketmap-app */` | `scripts/scope-css.mjs` reads it as its idempotency marker |
| Yahoo `close` is split-adjusted | The contract calls the basis `raw` with `adjustment.status: "none"`. Volume is adjusted on the inverse scale, so `close · volume` is split-invariant by cancellation, with both fields adjusted |
| Yahoo `currency: "GBp"` | A minor unit, and uppercasing it mints a valid-looking ISO code against a price 100× too large. `server/providers/yahoo/minorUnits.js` rescales at the provider boundary so nothing downstream has to know. Yahoo mixes units within one payload: prices, 52-week bounds, analyst targets and dividend amounts are in the minor unit, while `marketCap` and `trailingEps` are already in the major one — measured against Vodafone — so the field lists are allowlists and stay that way |
| Empty intraday payload | A legitimate provider outcome outside a trading session (a 1D chart over a weekend). Classifying it as schema drift poisons the shared raw-history breaker and blocks healthy ranges |
| `droppedRows` carry a count and no date | A series with a dropped bar is indistinguishable from a dense one. Alignment against the session grid is the only way to see the hole |
| esbuild plugin matching | Tag by import specifier, since an npm-linked package resolves outside `node_modules` and its resolved path gives nothing away. Resolve with Node's `require.resolve`: `build.resolve()` re-enters the same `onResolve` filter and recurses forever |
| Base UI portals | An explicit `null` container means "do not mount", and a dialog portal commits on the next task |
| `pointermove` in React | A continuous event: its state is flushed in a task, where a click or keydown gets a microtask |
| `maxBoardSize` governs growth | Refusing a board already in storage from a host that allowed more would strand it behind its own owner |
