# API

## Parts

The line is `EventSchema` of `@agentage/extension/logs`. The ingest adds two rules: a `ts` inside the
30-day TTL, and a subject that is an opaque id `[A-Za-z0-9_-]{1,64}`, never an email.
The api, mcp and worker read the store connection from `/run/secrets/store-url` on first use. The
estate mounts that file (`http://logs:{pw}@logs_store:8123/logs`: user, password, host, database).
`/health` of the api carries two checks, each bounded at 900 ms:

- `checks.clickhouse`: a `SELECT 1`.
- `checks.disk`: the free bytes of the events table's disks, with the estate's 1 GiB reserve included.
  Under 1.5 GiB, or unreadable, is `degraded`, never `unavailable`. A full disk stops the ingest with
  503 while the reads still answer.

## Ingest and the store's limits

`POST /api/v1/events` takes a bare JSON array of lines, not an object. It answers
`{ accepted, rejected }`. A line that fails the schema or the two rules counts as `rejected`.
One batch (at most 1000 lines, 1 MB) is one ClickHouse insert.

- `accepted: N` means the store has the rows. A failed insert answers 503 `UNAVAILABLE` or 500 `INTERNAL`, never a count.
- 503 means the store is down, slow past 10 s, at one of its limits or unable to write (no space, a read-only table).
- A retry is safe. The api sets `non_replicated_deduplication_window = 1000` on the table and sends each batch with a token (the sha256 of its rows). The same batch again stores nothing, even when the first attempt landed after its 503.
- Two identical batches sent on purpose count once. The window counts inserts, not time: a retry more than 1000 inserts later is stored again.
- The api runs the `ALTER` only when `SHOW CREATE TABLE events` lacks the setting.

Every read runs with `max_execution_time` 9 s, `max_memory_usage` 256 MB and `max_result_rows` 10000.
A read past a limit throws, never cuts silently. It answers 503 `UNAVAILABLE`: "The store is busy: narrow
the query or retry". The `services` widget reads `/stats` through `logs__aggregate` and shows `truncated` in its caption.

Retention: the table has a TTL of 30 days on `ts`. The worker job `retention` runs daily at 03:17 (timeout 60 s).
It only checks the oldest partition and fails when it is older than 31 days. It never deletes.

## The two reads

`GET /api/v1/events` (tool `logs__query`) answers rows. `GET /api/v1/stats` (tool `logs__aggregate`)
answers groups, and requires `kind`; without it, or with `window`, it is a 400. Both take `kind` and these filters:

- `since` and `until`: `15m`, `2h`, `7d` or an ISO time.
- `extension`, `part`, `host`, `level`, `route`, `status`, `agcid`, `sub`, `ok` (`true` or `false`).
- `name`: what `by=name` groups. It is the event name on `event`, `any` or no kind, and the container name on `container`. Another kind is a 400.
- `q`: text in `msg`, or an agcid. `/stats` also takes `user_type`.

`/events` adds:

- `order`: `desc` (newest first) or `asc`.
- `sort`: `ts`, or `ms` for the slowest first (ties by time).
- `limit`: at most 1000.
- `cursor`: bound to its query. With another kind, filter, sort or order it is a 400.

`/stats` adds:

- `by`: a comma list (below).
- `bucket`: `1m`, `5m`, `1h` or `1d`. It draws at most 1500 steps.
- `under`: ms, on `http` and `mcp`. It adds the measure `under`, the share of the group's rows at or under it.
- `sort`: a measure or a `by` name. Any other name is a 400 that lists the allowed ones.
- `order`, `limit` (100, at most 1000) and `cursor`. A group without a value sorts last.
- `meta.nextCursor` pins the window of page 1, so every page is cut from the same rows. A cursor sent with another kind, `by`, sort, order or filter is a 400.
- Page 1 ends 5 s before now (unless `until` is given), so a late row cannot move a group between pages. A call groups at most 100000 groups; past that it answers 503 busy.
- `kind` also takes `http,mcp` (one number over both) and `log,event`, in either order, and `any` (every row: count, firstSeen, lastSeen). Another list is a 400 that names the allowed ones. A list and `any` add `kind` to `by`.
- Quantiles, averages and percents answer at most 2 decimals; availability and `under` 4.

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

`by` takes `extension`, `part`, `route`, `method`, `status`, `host`, `level`, `client`, `user_type`,
`sub`, `version`; `error` adds `type`, `fingerprint`; `event` and `any` add `name` (the event name),
`container` adds `name` (the container name); a list of kinds and `any` add `kind`. availability is the admin
console's formula (5xx, and 502 to 504 at the edge, against requests; a 429 is no request; null under
50 requests); tests and services are left out of `http` and `mcp` unless the call filters on or
groups by `user_type`. A
`host` or `container` sample is the newest without `bucket` and the step's average with it. The
default window is 24 h (`host` 1 h, `container` 5 min); the default sort is the busiest first, with
`bucket` time oldest first. Every identifier in the SQL comes from the kind's table
([`src/lib/kinds.ts`](../src/lib/kinds.ts)); every value is a query parameter.

| Question                               | Call                                                              |
| -------------------------------------- | ----------------------------------------------------------------- |
| Errors that mention a timeout, 2 hours | `/events?level=error&q=timeout&since=2h`                          |
| One request, every hop in time order   | `/events?agcid=<agcid>&order=asc&since=30d`                       |
| Reliability per route, a day           | `/stats?kind=http&by=extension,part,route&since=24h`              |
| Worst availability first               | `/stats?kind=http&by=extension,route&sort=availability&order=asc` |
| Cpu of each machine in 5 minute steps  | `/stats?kind=host&by=host&bucket=5m&since=6h`                     |
| Share under 300 ms per route, worst    | `/stats?kind=http&by=route&under=300&sort=under&order=asc`        |
| Rows per kind                          | `/stats?kind=any&by=kind`                                         |
| Requests and tool calls as one number  | `/stats?kind=http,mcp&by=extension&since=24h`                     |
