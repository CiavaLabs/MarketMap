# Runbook

For the operator of a deployment, mid-incident. Design reasoning is in
[ARCHITECTURE.md](./ARCHITECTURE.md) and the contract is in
[README.md](./README.md); neither is repeated here.

## What the board is already telling you

Market Map is built to degrade. Before escalating, read what the interface
already says, because it distinguishes four situations the logs do not.

| Board status | Meaning | Urgency |
|---|---|---|
| Last updated | A recent refresh succeeded for most instruments | None |
| Partial update | The refresh landed; some instruments are unavailable | Watch |
| Last confirmed | The refresh failed; last-known-good values are on screen | Investigate |
| Update unavailable | No instrument has usable data | Page |

A tile showing `—` is a certified absence: the value could not be verified, so it
is not shown. Nothing has failed in the renderer.

## Reading `/health`

`GET /api/market/v1/health` answers with a summary — status, which providers are
enabled, whether persistence is configured, and `capabilities`. It deliberately
withholds circuit state, cache depth and telemetry counters, because an
unauthenticated caller should not learn when a breaker reopens.

`capabilities` lists the operations the wired service implements, derived from
the service object and from whether a resolver is present. It describes the
deployment, not an instrument: an operation missing from the list is missing for
every instrument, and one present is still capability-gated per instrument. A
board reads it once and stops asking for what this deployment does not serve, so
a missing entry is the first thing to check when a section never appears.

Set `exposeHealthInternals: true` on `createMarketDataService` **only behind your
own authentication**, then the same endpoint carries:

| Field | Read it for |
|---|---|
| `circuits` | Which provider/operation pairs are open, and `retryAt` for each |
| `providers.<id>.quarantinedCapabilities` | Capabilities disabled for the life of the process after an `auth_failed` or `entitlement_missing` answer |
| `persistence.healthy` | Whether the snapshot store is answering |
| `memoryCache.entries` | Cache depth against its bound |
| `singleFlight.active` | Requests in flight and coalescing |
| `telemetry.counters` | `provider_error`, `cache_miss`, `quota_rejected_total`, and the rest |

`status` is `degraded` when any breaker is not closed, any capability is
quarantined, persistence is configured but unhealthy, or no provider is enabled.
Degraded is not down: the board is still serving, from cache or from a fallback.

## Symptoms

### Every quote is stale, `circuits` shows `yahoo:quote` open

The breaker tripped after repeated failures and is serving last-known-good while
it waits out `retryAt`. It reopens on its own, with exponential backoff. Do not
restart to clear it — a restart drops the cache too, and the board goes from
stale to empty.

Look at `provider_error` by `code`, or at `provider_schema_invalid_total`. If the
code is `schema_invalid`, Yahoo changed a payload shape and the normalizer is
refusing it: that will not clear on its own and needs a fix.

A capability in `quarantinedCapabilities` is a different problem and does not
clear itself. Only `auth_failed` and `entitlement_missing` put one there, and the
entry lasts until the process restarts. For Finnhub that is the honest answer —
the key or the plan is wrong. For Yahoo it should not happen at all: a rejected
crumb is reported as a retryable upstream failure so the breaker handles it. A
quarantined Yahoo capability means something reached the classifier that should
not have, and is worth a bug report.

### Everything fails at once, right after a deploy or an IP change

Check the crumb handshake, and `YAHOO_USER_AGENT` first: if a host overrode the
default with a browser string or a bare token, Yahoo answers `429`. Only the
self-identifying `Mozilla/5.0 (compatible; …)` form passes.

A failed handshake is not cached, so the next request retries. Sustained failure
means the shape of the request is wrong.

### A few quote requests fail on the very first traffic after a restart

Expected, and it clears itself. The handshake costs 1.0–1.3 s before any consent
gate, against a 2.8 s per-request provider budget, so a cold start can spend most
of one request's time acquiring a crumb. The handshake runs on its own 20 s
budget and survives the request that triggered it, so the crumb is there for the
next one. Concurrent callers coalesce onto a single handshake rather than
starting one each, which is why this costs a few requests and not a stampede.
It recurs hourly when the crumb expires, and after any restart.

### Search works, quotes do not

`chart` and `search` need no crumb; `quote` and `quoteSummary` do. That split is
the signature of a handshake problem.

### The service refuses to start with a `RangeError` about the quota

`quota.limit` is below the dearest single request, so that request could never be
afforded and would answer `429` forever while promising a retry that would never
help. The floor is the **larger** of `maxBatchIds` and the search cost of 8 —
lowering `maxBatchIds` alone will not clear the error once it is under eight. The
message names the figure it wants.

### `429` from this API

That is the request quota answering, with Yahoo uninvolved. `quota_rejected_total`
by `endpoint` names who is being turned away. The unit is upstream work — README
gives the per-endpoint costs — so a client well under any request-per-minute
figure can still be over its allowance. Raise `quota.limit`, or leave it: it is
doing its job.

The bucket roster is bounded by `maxClients`, and reaching it evicts the least
recently seen caller — whose next request then starts from a full allowance. If
`clientKey` comes from a header a caller can set, that is a way to reset one's
own throttle for the price of `maxClients` cheap requests. Derive the key from
something the caller cannot forge.

### Memory climbing on a long-running process

Everything with a bound reports it. `memoryCache.entries` against `maxMemoryEntries`,
the resolver against `maxResolvedDescriptors`, the snapshot store against its own
`maxEntries`.

`InMemoryAnalyticsStore` is the exception: it refuses the write that would take
it past `maxScopes`, throwing a `RangeError` that names the count. It is not a
production ledger — the append-only contract forbids eviction, so a bounded
in-memory ledger can only stop. Configure `MySQLAnalyticsStore`.

### The analytics run refuses to start, naming sessions the calendar disagrees on

The generated calendar and the sessions the market actually traded do not match,
and the run stops, because the ruler it would measure against cannot be trusted.
The message names both directions.

**Traded sessions the calendar does not list** means the calendar removed a real
session: a rule is wrong, or an `adHocClosure` names a day the exchange actually
opened. Adding a closure makes this worse. Check the exchange's own notice, then
correct the rule or delete the entry.

**Listed sessions that did not trade** is the other direction. If the exchange
announced a closure — a day of mourning, a storm — that is the entry
`adHocClosures` is missing. If it announced nothing, suspect the data first: the
provider dropped a day. Compare a second liquid instrument before touching the
calendar, because a closure added to hide a data fault is permanent and silent.

### The analytics section vanished from the instrument dialog

Read `capabilities` first. Without `analytics-snapshot` the deployment has no
analytics store wired, the board never requests one, and the section is absent
by configuration rather than by fault.

With the capability present, the section still omits itself whole when any
displayed quantity is missing or non-finite. Check that the daily runner
actually ran — `listRunAttempts` for the session — before looking at the
browser.

### Persistence unhealthy but the board is fine

Expected. The snapshot store is a durability layer; quotes come from memory and
the provider. Fix it before a restart, because a restart with persistence down
starts cold.

## Things not to do

- **Do not clear the cache to "get fresh data".** Every eviction is a cold read
  against a provider that is already the reason you are here.
- **Do not raise `maxBatchIds` under load.** It multiplies the upstream fan-out of
  a single request. The quota charges per instrument for exactly this reason.
- **Do not point the analytics runner at a session it has already assessed** to
  force a recompute. Two executions of the same deterministic run are two audit
  attempts, by design, and the ledger will record both.
- **Do not set `MARKET_CANARY_LIVE=1` in a deployment.** It reaches providers for
  real and is meant to run outside deterministic CI.
