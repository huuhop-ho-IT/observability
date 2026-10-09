"""Generates infra/grafana/dashboards/cinema-booking.json (dashboard as code).

Usage: python3 scripts/gen_dashboard.py infra/grafana/dashboards/cinema-booking.json
"""
import json, sys

PROM = {"type": "prometheus", "uid": "prometheus"}
LOKI = {"type": "loki", "uid": "loki"}
TEMPO = {"type": "tempo", "uid": "tempo"}
M = 'mode=~"$mode"'

panels = []
pid = [0]
y = [0]


def nid():
    pid[0] += 1
    return pid[0]


def row(title):
    panels.append({"type": "row", "title": title, "id": nid(), "collapsed": False,
                   "gridPos": {"h": 1, "w": 24, "x": 0, "y": y[0]}, "panels": []})
    y[0] += 1


def prom(expr, legend="", instant=False):
    t = {"datasource": PROM, "expr": expr, "legendFormat": legend, "refId": "ABCDEFGH"[0]}
    if instant:
        t["instant"] = True
        t["range"] = False
    return t


def targets(*ts):
    out = []
    for i, t in enumerate(ts):
        t = dict(t)
        t["refId"] = "ABCDEFGH"[i]
        out.append(t)
    return out



def delta(selector):
    """Exact counter delta over the dashboard range (matches k6/DB numbers exactly).
    increase() extrapolates and would show e.g. 111 instead of 105 for a 1-second burst."""
    return (f"sum(max_over_time({selector}[$__range]) - min_over_time({selector}[$__range])) or vector(0)")

def stat(title, expr, x, w, color="green", thresholds=None, unit="short", desc=""):
    steps = thresholds or [{"color": color, "value": None}]
    panels.append({
        "type": "stat", "title": title, "id": nid(), "datasource": PROM, "description": desc,
        "gridPos": {"h": 5, "w": w, "x": x, "y": y[0]},
        "targets": targets(prom(expr, instant=True)),
        "fieldConfig": {"defaults": {"unit": unit, "decimals": 0,
                                     "thresholds": {"mode": "absolute", "steps": steps}},
                        "overrides": []},
        "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                    "colorMode": "background", "graphMode": "none", "textMode": "value", "justifyMode": "center"},
    })


def ts(title, tgts, x, w, h=8, unit="short", desc="", stack=False, ds=PROM, overrides=None):
    panels.append({
        "type": "timeseries", "title": title, "id": nid(), "datasource": ds, "description": desc,
        "gridPos": {"h": h, "w": w, "x": x, "y": y[0]},
        "targets": targets(*tgts),
        "fieldConfig": {"defaults": {"unit": unit, "custom": {
            "drawStyle": "line", "lineWidth": 2, "fillOpacity": 15, "showPoints": "never",
            "spanNulls": False, "stacking": {"mode": "normal" if stack else "none", "group": "A"}}},
            "overrides": overrides or []},
        "options": {"legend": {"displayMode": "table", "placement": "right", "calcs": ["max", "lastNotNull"]},
                    "tooltip": {"mode": "multi", "sort": "desc"}},
    })


def color(name, c):
    return {"matcher": {"id": "byName", "options": name},
            "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": c}}]}


RESULT_COLORS = [color("success", "green"), color("seat_taken", "yellow"), color("sold_out", "blue"),
                 color("lock_busy", "purple"), color("error", "red"), color("not_found", "orange")]

# ---------------------------------------------------------------- Business
row("① Business: 1,000 requests fighting for 50 seats (Prometheus)")
stat("Tickets sold", delta(f'booking_attempts_total{{result="success",{M}}}'),
     0, 5, color="green",
     desc="Total over the selected time range (every test run adds up). Per run: redlock always sells <= 50; unsafe can sell more than 50.")
stat("Rejected (409)", delta(f'booking_attempts_total{{result=~"seat_taken|sold_out|lock_busy",{M}}}'),
     5, 5, color="blue")
stat("System errors (5xx)", delta(f'booking_attempts_total{{result="error",{M}}}'),
     10, 4, thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}])
stat("Double-sold tickets", delta(f'booking_overbooked_total{{{M}}}'), 14, 5,
     thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}],
     desc="Race condition: an already-sold seat sold again to someone else (only happens in unsafe mode).")
stat("Seats left (showtime #1)", 'max(redis_key_value{key="showtime:1:remaining"})', 19, 5,
     thresholds=[{"color": "red", "value": None}, {"color": "orange", "value": 1}, {"color": "green", "value": 10}])
y[0] += 5

ts("Booking rate by result (req/s)",
   [prom(f'sum by (result) (rate(booking_attempts_total{{{M}}}[$__rate_interval]))', "{{result}}")],
   0, 12, unit="reqps", stack=True, overrides=RESULT_COLORS)
ts("Booking latency (p50 / p95 / p99)",
   [prom(f'histogram_quantile(0.50, sum by (le) (rate(booking_duration_seconds_bucket{{{M}}}[$__rate_interval])))', "p50"),
    prom(f'histogram_quantile(0.95, sum by (le) (rate(booking_duration_seconds_bucket{{{M}}}[$__rate_interval])))', "p95"),
    prom(f'histogram_quantile(0.99, sum by (le) (rate(booking_duration_seconds_bucket{{{M}}}[$__rate_interval])))', "p99")],
   12, 12, unit="s", desc="Spike here? Open the slow-trace table below (or Explore -> Tempo) to see which step is slow.")
y[0] += 8

# ---------------------------------------------------------------- HTTP
row("② HTTP (OTel auto-instrumentation)")
ts("HTTP req/s by route & status",
   [prom('sum by (http_route, http_response_status_code) (rate(http_server_request_duration_seconds_count[$__rate_interval]))',
         "{{http_route}} {{http_response_status_code}}")], 0, 12, unit="reqps")
ts("HTTP p95 by route",
   [prom('histogram_quantile(0.95, sum by (le, http_route) (rate(http_server_request_duration_seconds_bucket[$__rate_interval])))',
         "{{http_route}}")], 12, 12, unit="s")
y[0] += 8
ts("Load balanced across replicas (req/s per instance)",
   [prom('sum by (service_instance_id) (rate(http_server_request_duration_seconds_count{http_route="/api/bookings"}[$__rate_interval]))',
         "{{service_instance_id}}")], 0, 24, h=6, unit="reqps")
y[0] += 6

# ---------------------------------------------------------------- Redis / Redlock / Postgres
row("③ Redis, Redlock & PostgreSQL")
ts("Redlock acquire (ops/s)",
   [prom('sum by (result) (rate(redlock_acquire_total[$__rate_interval]))', "{{result}}")], 0, 8, unit="ops",
   overrides=[color("acquired", "green"), color("busy", "purple")])
ts("Redlock acquire p95",
   [prom('histogram_quantile(0.95, sum by (le, result) (rate(redlock_acquire_duration_seconds_bucket[$__rate_interval])))',
         "{{result}}")], 8, 8, unit="s")
ts("Redis commands/s",
   [prom('sum by (cmd) (rate(redis_commands_total[$__rate_interval])) > 0', "{{cmd}}")], 16, 8, unit="ops")
y[0] += 8
ts("PostgreSQL open connections",
   [prom('sum(pg_stat_database_numbackends{datname="cinema"})', "connections")], 0, 8)
ts("PostgreSQL transactions/s",
   [prom('rate(pg_stat_database_xact_commit{datname="cinema"}[$__rate_interval])', "commit"),
    prom('rate(pg_stat_database_xact_rollback{datname="cinema"}[$__rate_interval])', "rollback")], 8, 8, unit="ops")
ts("p95 latency per step (Tempo span-metrics)",
   [prom('histogram_quantile(0.95, sum by (le, span_name) (rate(traces_spanmetrics_latency_bucket{service="booking-api", span_name=~"booking.*|redlock.*|payment.*|pg.query.*|pg-pool.*"}[$__rate_interval])))',
         "{{span_name}}")], 16, 8, unit="s",
   desc="Derived from traces by the Tempo metrics-generator: shows which step (DB, lock, payment) is slow.")
y[0] += 8

# ---------------------------------------------------------------- k6
row("④ k6 load generator (remote-written into Prometheus)")
ts("k6 requests sent per run (by HTTP status)",
   [prom('sum by (status) (k6_http_reqs_total{name=~".*/api/bookings.*"})', "HTTP {{status}}")], 0, 12, unit="short",
   desc="Cumulative count k6 reported for its current run. A 1-second burst flushes only once, so rate() would be empty; the raw total works for bursts and long runs alike.",
   overrides=[color("HTTP 201", "green"), color("HTTP 409", "blue"), color("HTTP 500", "red")])
ts("k6 http_req_duration (client side)",
   [prom('max(k6_http_req_duration_p95)', "p95"), prom('max(k6_http_req_duration_p99)', "p99"),
    prom('max(k6_http_req_duration_max)', "max")], 12, 12, unit="s")
y[0] += 8

# ---------------------------------------------------------------- Traces & Logs
row("⑤ Traces (Tempo) & Logs (Loki) — click a trace_id to jump between them")
panels.append({
    "type": "table", "title": "Slowest booking traces (> 200ms) — click a Trace ID", "id": nid(), "datasource": TEMPO,
    "gridPos": {"h": 10, "w": 12, "x": 0, "y": y[0]},
    "targets": [{"datasource": TEMPO, "refId": "A", "queryType": "traceql", "limit": 20, "tableType": "traces",
                 "query": '{resource.service.name="booking-api" && name="POST /api/bookings" && duration > 200ms}'}],
    "fieldConfig": {"defaults": {}, "overrides": []}, "options": {"showHeader": True},
})
panels.append({
    "type": "table", "title": "Failed traces (HTTP 5xx)", "id": nid(), "datasource": TEMPO,
    "gridPos": {"h": 10, "w": 12, "x": 12, "y": y[0]},
    "targets": [{"datasource": TEMPO, "refId": "A", "queryType": "traceql", "limit": 20, "tableType": "traces",
                 "query": '{resource.service.name="booking-api" && span.http.response.status_code >= 500}'}],
    "fieldConfig": {"defaults": {}, "overrides": []}, "options": {"showHeader": True},
})
y[0] += 10
ts("Log volume by level",
   [{"datasource": LOKI, "expr": 'sum by (detected_level) (count_over_time({service_name="booking-api"} [$__auto]))',
     "legendFormat": "{{detected_level}}", "queryType": "range"}], 0, 24, h=6, ds=LOKI, stack=True,
   overrides=[color("error", "red"), color("warn", "yellow"), color("info", "green")])
y[0] += 6
panels.append({
    "type": "logs", "title": "ERROR logs (expand a line -> TraceID -> 'View trace in Tempo')", "id": nid(),
    "datasource": LOKI, "gridPos": {"h": 12, "w": 24, "x": 0, "y": y[0]},
    "targets": [{"datasource": LOKI, "refId": "A", "queryType": "range",
                 "expr": '{service_name="booking-api"} | detected_level="error"'}],
    "options": {"showTime": True, "wrapLogMessage": True, "enableLogDetails": True, "sortOrder": "Descending",
                "dedupStrategy": "none", "prettifyLogMessage": False},
})
y[0] += 12

dashboard = {
    "uid": "cinema-booking",
    "title": "Cinema Booking — Observability (Metrics · Traces · Logs)",
    "tags": ["cinema", "otel", "k6"],
    "timezone": "browser",
    "schemaVersion": 39,
    "version": 1,
    "editable": True,
    "refresh": "5s",
    "time": {"from": "now-15m", "to": "now"},
    "templating": {"list": [{
        "name": "mode", "label": "Booking mode", "type": "custom",
        "query": "redlock,unsafe", "includeAll": True, "allValue": ".*", "multi": False,
        "current": {"selected": True, "text": "All", "value": "$__all"},
        "options": [],
    }]},
    "annotations": {"list": []},
    "panels": panels,
}

json.dump(dashboard, open(sys.argv[1], "w"), ensure_ascii=False, indent=2)
print("panels:", len(panels))
