# Cinema Booking — Concurrency & Observability Demo

**NestJS · PostgreSQL · Redis · Redlock · OpenTelemetry · Prometheus · Tempo · Loki · Grafana · k6 — fully Dockerized**

**The problem:** 1,000 booking requests arrive within one second, and the cinema has only **50 seats**.
The system must sell **at most 50 tickets and never sell the same seat twice**, even when it runs as
several replicas. Every step must also be **observable** through the three pillars: metrics, traces and logs.

The project shows two things:

1. **Correctness under concurrency:** a naive implementation double-sells seats. Redis plus a
   distributed lock (Redlock) fixes it, and the result is proven with k6 load tests.
2. **Production-style observability:** OpenTelemetry → Collector → Prometheus / Tempo / Loki → Grafana,
   with one-click navigation from a latency spike to the slow trace to the exact log line.

## Results (measured locally, 1,000 requests in 1 s, 50 seats, 2 API replicas)

| | `unsafe` mode (no lock) | `redlock` mode |
|---|---|---|
| Tickets sold | **106** for 50 seats ❌ | **50** ✅ |
| Seats sold more than once | **33** | **0** |
| Rejected (409: seat taken / sold out / held) | 895 | 950 |
| 5xx errors | 0 | 0 |
| DB consistent (`bookings == BOOKED seats`) | ✗ | ✓ |

k6 checks these invariants automatically at the end of every run (`teardown`).

Under fault injection (30% of DB calls hit a statement timeout), the redlock mode still keeps the data
consistent: failed transactions roll back, and 0 seats are double-sold.

## Architecture

```
 k6 ──HTTP──> nginx :8080 ──> booking-api (NestJS) ×2 replicas ──> PostgreSQL  (source of truth)
  │                                 │                          └─> Redis       (inventory cache + Redlock)
  │                                 │ OTLP/gRPC: traces, metrics, logs
  │                                 ▼
  │                          OTel Collector ── filter · batch · add env label · hash userId
  │                           │        │          │
  │                    traces ▼        ▼ metrics  ▼ logs
  │                        Tempo    Prometheus   Loki
  │                          │  span-metrics ▲     │
  └───── remote-write ───────┼───────────────┘     │
                             └──────► Grafana ◄────┘   (cross-linked by trace_id)
```

| Component | Role | URL |
|---|---|---|
| booking-api ×2 | NestJS app instrumented with the OTel SDK | via nginx: http://localhost:8080 |
| OTel Collector | The only telemetry endpoint the app knows about | `:4317` gRPC / `:4318` HTTP |
| Prometheus | Metrics + alert rules | http://localhost:9090 |
| Tempo | Traces (also generates span-metrics and a service graph) | http://localhost:3200 |
| Loki | Logs (native OTLP ingestion) | http://localhost:3100 |
| Grafana | Dashboards + Metrics ↔ Traces ↔ Logs links | **http://localhost:3000** (no login) |
| k6 | Load generator; remote-writes its results to Prometheus | `docker compose run --rm k6 …` |
| redis-exporter, postgres-exporter | Infrastructure metrics | internal |

## Quick start

Requirements: Docker Desktop. Free ports: 3000, 8080, 9090, 3100, 3200, 4317, 5432, 6379.

```bash
make up              # docker compose up -d --build   (first build takes ~2-3 min)
make burst-unsafe    # 1,000 req/s without a lock -> seats get double-sold
make burst           # 1,000 req/s with Redis + Redlock -> exactly 50 tickets sold
```

Then open Grafana at http://localhost:3000. The **Cinema Booking — Observability** dashboard is the home page.

No `make`? Every target in the [Makefile](Makefile) is a plain `docker compose` or `curl` command.

## How the booking works (`redlock` mode)

Source: [app/src/booking/booking.service.ts](app/src/booking/booking.service.ts)

1. **Redis fast path.** One pipelined round trip: `GET showtime:1:remaining` + `SISMEMBER showtime:1:booked A1`.
   If the showtime is sold out or the seat is already taken, the request gets an immediate 409, with no lock
   and no database query. Most of the 950 losing requests stop here.
2. **Distributed lock per seat.** `lock:showtime:1:seat:A1` via Redlock (TTL 5 s, 3 retries). Both replicas
   share Redis, so only one request in the whole system can process a given seat at a time.
3. **Re-check and write inside the lock.** Read the seat status from PostgreSQL (the source of truth), run a
   simulated payment (50–100 ms), then `INSERT booking` + `UPDATE seat` in a single transaction.
4. **Update the cache.** `SADD` + `DECR` inside `MULTI`, then release the lock.

**`unsafe` mode** skips steps 1, 2 and 4. Many requests read the seat as `AVAILABLE` during the payment
window and all of them write, so the seat gets double-sold. The `bookings` table deliberately has **no**
`UNIQUE(showtime_id, seat_code)` constraint, so the bug shows up instead of being masked.

> **For production:** also add the unique constraint as a final safety net, and run Redlock on ≥ 3
> independent Redis nodes (`REDLOCK_NODES=redis://r1:6379,redis://r2:6379,redis://r3:6379`).

## Demo scenarios

### 1. Race condition vs. distributed lock

```bash
make burst-unsafe
make burst
```

- **Terminal:** k6 prints the final report and passes or fails three invariants.
- **Grafana:** the **Double-sold tickets** stat turns red after the unsafe run.
- **Loki:** shows `OVERBOOKING detected: seat C1 sold more than once` with its `trace_id`.
- **Prometheus:** the `Overbooking` alert fires (http://localhost:9090/alerts).

### 2. Incident drill: "p95 spikes → the trace shows a slow DB step → the log says why"

```bash
make chaos-timeout   # 20% of requests: Postgres statement timeout (pg_sleep 3s vs 1s timeout)
make load            # 3 minutes of sustained traffic
make chaos-off
```

1. **Metrics (Prometheus).** *Booking latency p95/p99* jumps, *System errors (5xx)* turns red,
   and the `BookingErrors` / `BookingHighP95Latency` alerts fire.
2. **Traces (Tempo).** In *Failed traces (HTTP 5xx)*, click a Trace ID. The `booking.db_transaction` →
   `pg.query` span is red after ~1 s with `canceling statement due to statement timeout`.
   *p95 latency per step* shows which step is slow.
3. **Logs (Loki).** In the trace view, click **Logs for this span**. Loki filters by `trace_id` and shows
   `Booking failed: canceling statement due to statement timeout`. It works the other way too: expand any
   line in *ERROR logs* and click **View trace in Tempo**.

`make chaos-slow` makes the DB slow (3 s) without failing, which shows the "slow but not broken" case.

> **Tip:** a 1-second burst is only one or two points on a Prometheus graph. For a nicer live demo, run
> `make load` (it resets the showtime every 15 s at ~300 req/s).

## API

| Method | Path | Description |
|---|---|---|
| POST | `/api/bookings?mode=redlock\|unsafe` | Body `{"showtimeId":1,"seatCode":"A1","userId":"u1"}`. Returns 201 / 409 / 500. |
| GET | `/api/showtimes` | Showtimes with available-seat counts |
| GET | `/api/showtimes/:id/report` | Tickets sold, double-sold seats, Redis inventory, `consistent` flag |
| POST | `/api/showtimes/:id/reset` | Releases all seats |
| GET / POST | `/api/chaos` | `{"mode":"none\|slow-db\|db-timeout","ratio":0.2}`. Shared by all replicas through Redis. |
| GET | `/health` | Checks DB + Redis |

The `error` field of a 409 response says why: `seat_taken`, `sold_out` or `lock_busy`.

## Telemetry

**Metrics** ([app/src/telemetry/metrics.ts](app/src/telemetry/metrics.ts)):

- `booking_attempts_total{mode,result}`, `booking_duration_seconds_bucket{mode,result}`
- `booking_overbooked_total{mode}`, `booking_seats_remaining{showtime_id}`
- `redlock_acquire_total{result}`, `redlock_acquire_duration_seconds_bucket{result}`
- `http_server_request_duration_seconds_*` (auto-instrumentation)
- `traces_spanmetrics_*`, `traces_service_graph_*` (derived from traces by Tempo)
- `k6_*` (k6 remote-write), `redis_*`, `pg_*` (exporters)

**Traces:** auto-instrumented spans for HTTP, Express, NestJS, `pg` and `ioredis`, plus business spans
`booking.redis_fast_check`, `redlock.acquire`, `booking.db_transaction`, `payment.charge` and
`booking.redis_update`.

**Logs:** pino writes JSON logs. The OTel pino instrumentation adds `trace_id`/`span_id` and ships each record
over OTLP to Loki: `service_name` becomes a label, and `trace_id`, `detected_level`, `seatCode`… go into
structured metadata. The Collector hashes `userId` before storage to show PII redaction.

Example LogQL:

```logql
{service_name="booking-api"} | detected_level="error"
{service_name="booking-api"} |= "OVERBOOKING"
{service_name="booking-api"} | trace_id="<trace id>"
sum by (detected_level) (count_over_time({service_name="booking-api"}[1m]))
```

Example TraceQL:

```traceql
{resource.service.name="booking-api" && name="POST /api/bookings" && duration > 500ms}
{name="redlock.acquire" && span.booking.rejected != nil}
{span.http.response.status_code >= 500}
```

## Design decisions

- **The app only talks to the Collector.** Swapping Tempo for Jaeger, or Loki for Elasticsearch, is a
  Collector config change with zero code changes.
- **Redis is a cache; PostgreSQL is the source of truth.** The re-check inside the lock protects against a
  stale cache. Redis is re-warmed from Postgres on startup.
- **Fail fast under contention.** Redis rejects hopeless requests before they take a lock or a DB
  connection, which keeps p50 at ~1–5 ms during the burst.
- **Business rejections are not errors.** 409s are recorded as `result=seat_taken|sold_out|lock_busy`, and
  the business spans are not marked as failed. Error alerts only fire on real 5xx failures.
- **The first burst is not lost.** A 1-second burst creates brand-new series. Prometheus normally ignores a
  series' first sample in `rate()`/`increase()`. The Collector exposes OpenMetrics `_created` timestamps, and
  Prometheus runs with `created-timestamp-zero-ingestion`, so the first burst is counted. Counters are also
  pre-initialised to 0.
- **The dashboard is code:** [scripts/gen_dashboard.py](scripts/gen_dashboard.py) generates the provisioned
  Grafana JSON.

## Project layout

```
app/                       NestJS booking-api
  src/tracing.ts           OTel SDK bootstrap (loaded with node --require)
  src/telemetry/           Custom metrics + span helper
  src/booking/             Booking controller/service (unsafe vs redlock)
  src/chaos/               Fault injection (slow DB / DB timeout)
  src/infra/               PostgreSQL pool, Redis + Redlock
db/init.sql                Schema + 2 showtimes × 50 seats
infra/otel-collector/      Traces / metrics / logs pipelines
infra/prometheus/          Scrape config + alert rules
infra/tempo/, infra/loki/  Storage backends
infra/grafana/             Datasources (cross-linked) + dashboard
infra/nginx/               Load balancer for the 2 replicas
k6/burst.js                1,000 requests in 1 second
k6/load.js                 Sustained load
scripts/gen_dashboard.py   Dashboard as code
```

## Cleanup

```bash
make down    # stop
make clean   # stop and delete all volumes
```
