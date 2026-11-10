// The events table, logs-events section 3 verbatim.
export const EVENTS_DDL = `CREATE TABLE IF NOT EXISTS events (      -- run by the api at start; idempotent
  id         UUID DEFAULT generateUUIDv7(), -- for paging: the cursor is (ts, id)
  ts         DateTime64(3, 'UTC'),
  level      LowCardinality(String),
  kind       LowCardinality(String),
  msg        String,
  extension  LowCardinality(String),
  part       LowCardinality(String),
  version    LowCardinality(String),
  host       LowCardinality(String),      -- the machine that sent the event
  agcid      Nullable(FixedString(32)),  -- null on a raw store line
  sub        Nullable(String),           -- null when anonymous
  session    Nullable(String),           -- agsid header, else the token jti (Q12)
  user_type  LowCardinality(String),      -- user agent automation service test bot (Q13)
  client     LowCardinality(String),      -- claude-code cursor chatgpt cli obsidian browser curl, '' unknown (Q14)
  -- hot fields promoted to typed columns, filled by the api from fields
  method     LowCardinality(String),      -- http.request.method, '' otherwise
  route      String,                      -- http.route, or gen_ai.tool.name for mcp
  status     UInt16,                      -- http.response.status_code, 0 otherwise
  ms         UInt32,                      -- agentage.duration_ms, 0 otherwise
  ok         Bool,                        -- mcp and job: no error.type; http: status < 500
  fields     JSON,                        -- everything, dotted names become nested paths
  INDEX ix_agcid agcid TYPE bloom_filter GRANULARITY 4,
  INDEX ix_sub   sub   TYPE bloom_filter GRANULARITY 4,
  INDEX ix_msg   msg   TYPE text(tokenizer = 'splitByNonAlpha') GRANULARITY 1
) ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (extension, part, ts)
TTL ts + INTERVAL 30 DAY;              -- Q5
`;

// Off by default on a non-replicated MergeTree; keeps the last 1000 batch tokens, so a retry stores nothing twice.
export const EVENTS_DEDUP =
  'ALTER TABLE events MODIFY SETTING non_replicated_deduplication_window = 1000';
