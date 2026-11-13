# API

The rules of the api and mcp parts that a wrong guess would break. The full contracts are generated:
[openapi.json](../openapi.json) for the api and [logs.mcpc.json](../logs.mcpc.json) for the tools.
Which scope each call needs is in the README section [Scopes](../README.md#scopes).

## Store connection

The api, mcp and worker read the store connection from `/run/secrets/store-url` on first use. The
estate mounts that file. Its value has the form `http://logs:{pw}@logs_store:8123/logs`: user,
password, host, database.

## Health

`/health` of the api carries two checks. Each check is bounded at 900 ms.

- `checks.clickhouse`: a `SELECT 1`.
- `checks.disk`: the free bytes of the events table's disks, with the estate's 1 GiB reserve
  included. Under 1.5 GiB, the check is `degraded`. An unreadable value is also `degraded`. The
  check is never `unavailable`.

A full disk stops the ingest with 503. The reads still answer.

## Ingest

A line is `EventSchema` of `@agentage/extension/logs`. The ingest adds two rules:

- `ts` is inside the 30-day TTL (time to live) of the table.
- `ts` is at most one hour in the future.
- The subject is an opaque id `[A-Za-z0-9_-]{1,64}`, never an email.

`POST /api/v1/events` takes a bare JSON array of lines, not an object. It answers
`{ accepted, rejected }`. A line that fails the schema or the two rules counts as `rejected`.
One batch holds at most 1000 lines and 1 MB. One batch is one ClickHouse insert.

- `accepted: N` means the store has the rows. A failed insert answers 503 `UNAVAILABLE` or 500
  `INTERNAL`, never a count.
- 503 means one of these: the store is down, the store is slower than 10 s, the store is at one of
  its limits, or the store cannot write (no space, a read-only table).
- A retry is safe. The api sends each batch with a token: the sha256 of its rows. The table
  remembers the last 1000 tokens (`non_replicated_deduplication_window = 1000`). A batch with a
  known token is not stored again. This holds also when the first attempt landed after its 503.
- Two identical batches sent on purpose count once.
- The window counts inserts, not time. A retry more than 1000 inserts later is stored again.
- The api runs the `ALTER` that sets the window only when `SHOW CREATE TABLE events` lacks the
  setting.

## The store's limits

Every read runs with these limits: `max_execution_time` 9 s, `max_memory_usage` 256 MB and
`max_result_rows` 10000. A read past a limit throws. It never cuts the result silently. It answers
503 `UNAVAILABLE`: "The store is busy: narrow the query or retry". The `services` widget reads
`/stats` through `logs__aggregate` and shows `truncated` in its caption.

## Retention

The table has a TTL of 30 days on `ts`. The worker job `retention` runs daily at 03:17, with a
timeout of 60 s. It only checks the oldest partition. It fails when that partition is older than
31 days. It never deletes.

## Reads

`GET /api/v1/events` (tool `logs__query`) answers rows. `GET /api/v1/stats` (tool
`logs__aggregate`) answers groups. `/stats` requires `kind`. Without `kind`, or with `window`, it
answers 400.

### Filters for both reads

Both reads take `kind` and these filters:

- `since` and `until`: `15m`, `2h`, `7d` or an ISO time.
- `extension`, `part`, `host`, `level`, `route`, `status`, `agcid`, `sub`, `ok` (`true` or `false`).
- `name`: the value that `by=name` groups. On `event`, `any` or no kind, it is the event name. On
  `container`, it is the container name. With another kind it is a 400.
- `q`: text in `msg`, or an agcid.
- `/stats` also takes `user_type`.

### Options of `/events`

- `order`: `desc` (newest first) or `asc`.
- `sort`: `ts`, or `ms` for the slowest first. Ties sort by time.
- `limit`: at most 1000.
- `cursor`: bound to its query. With another kind, filter, sort or order it is a 400.

### Options of `/stats`

- `by`: a comma list (see [Groups](#groups)).
- `bucket`: `1m`, `5m`, `1h` or `1d`. It draws at most 1500 steps.
- `under`: a time in ms, on `http` and `mcp`. It adds the measure `under`: the share of the group's
  rows at or under that time.
- `sort`: a measure or a `by` name. Any other name is a 400 that lists the allowed ones.
- `order`, `limit` (default 100, at most 1000) and `cursor`. A group without a value sorts last.
- `meta.nextCursor` keeps the time window of page 1. So every page comes from the same rows. A
  cursor sent with another kind, `by`, sort, order or filter is a 400.
- Page 1 ends 5 s before now, unless `until` is given. So a late row cannot move a group between
  pages.
- A call groups at most 100000 groups. Past that it answers 503 busy.
- `kind` also takes the lists `http,mcp` (one number over both) and `log,event`, in either order.
  It also takes `any`: every row, with count, firstSeen and lastSeen. Another list is a 400 that
  names the allowed ones. A list and `any` add `kind` to `by`.
- Quantiles, averages and percents answer at most 2 decimals. Availability and `under` answer at
  most 4.

### Measures

| kind                                  | `/stats` measures, per group                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `http`, `mcp`                         | calls, failed, requests, availability, p50, p95, p99, users, firstSeen, lastSeen, agcid (with `under`: under) |
| `job`                                 | runs, failed, p50, p95                                                                                        |
| `span`                                | count, p50, p95, p99                                                                                          |
| `error`                               | count, lastSeen, sample, agcid                                                                                |
| `log`, `event`                        | count                                                                                                         |
| `host` (event `host.stats`)           | cpu, cpu_avg, cpu_max, mem, mem_max, disk, disk_max, load1, containers, at                                    |
| `container` (event `container.stats`) | cpu, cpu_avg, cpu_max, mem, mem_max, limit, at                                                                |
| `any` (every kind)                    | count, firstSeen, lastSeen                                                                                    |

### Groups

`by` takes `extension`, `part`, `route`, `method`, `status`, `host`, `level`, `client`,
`user_type`, `sub` and `version`.

- `error` adds `type` and `fingerprint`.
- `event` and `any` add `name` (the event name).
- `container` adds `name` (the container name).
- A list of kinds and `any` add `kind`.

### Availability

Availability is the share of requests that did not fail.

- An `http` row with a 5xx status is a failure. At the edge, only 502 to 504 are failures.
- An `mcp` row fails when `ok` is false.
- An `http` 429 does not count as a request. At the edge, only 502 to 504 rows count as requests.
  Every `mcp` row is a request.
- Under 50 requests, availability is null.
- Test and service traffic is left out of `http` and `mcp`, unless you filter or group by
  `user_type`.

### Defaults

- A `host` or `container` sample is the newest one without `bucket`. With `bucket` it is the step's
  average.
- The default window is 24 h. For `host` it is 1 h, for `container` 5 min.
- The default sort is the busiest group first. With `bucket` it is time, oldest first.
- Every identifier in the SQL comes from the kind's table
  ([`src/lib/kinds.ts`](../src/lib/kinds.ts)). Every value is a query parameter.

The README section [The two reads](../README.md#the-two-reads) lists example calls.
