// SQLite 적재. 이 DB는 «사본»입니다 — 원본은 2_accepted 의 JSONL이고, 여기는 언제든 거기서 다시 만듭니다.
//
// Node 내장 node:sqlite 를 씁니다(22.13 이상, 의존성 0). 없으면 친절한 오류로 멈춥니다.
//
// 설계에서 정한 것
//  · bars 는 «바뀐 것만» 쌓습니다. 매일 5봉씩 겹쳐 받아 오는데, 어제와 같은 봉을 또 저장하지 않고,
//    값이 달라졌을 때만 새 줄(새 seq)을 넣고 bar_corrections 에 무엇이 어떻게 바뀌었는지 남깁니다.
//    (정정·분할 조정을 몰래 덮어쓰지 않으려는 것 — 시점별 값이 필요한 백테스트용)
//  · 최신 값은 latest_bars 뷰로 봅니다. 계산은 이 뷰만 읽으면 됩니다.
//  · 가격은 소수 4자리로 반올림해 넣습니다(Yahoo의 32비트 꼬리 12.390000343322754 제거). 원본 JSONL은 그대로입니다.

import { existsSync } from "node:fs";
import path from "node:path";

let sqlite = null;
let sqliteError = null;
try {
  sqlite = await import("node:sqlite");
} catch (error) {
  sqliteError = error;
}

export const SCHEMA_VERSION = 8;
export const hasSqlite = sqlite !== null;

const r4 = (x) => (x === null || x === undefined ? null : Math.round(x * 1e4) / 1e4);
const FIELDS = ["o", "h", "l", "c", "v", "ac"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  batch           TEXT NOT NULL UNIQUE,      -- 폴더 이름 (예: 2026-10-29-backfill)
  mode            TEXT NOT NULL,             -- backfill | daily
  source          TEXT NOT NULL,
  as_of           TEXT NOT NULL,             -- 기준일 (대다수 종목의 마지막 봉)
  run_date        TEXT NOT NULL,
  status          TEXT NOT NULL,             -- COMPLETE | PARTIAL
  requested       INTEGER NOT NULL,
  ok              INTEGER NOT NULL,
  missing         INTEGER NOT NULL,
  stale           INTEGER NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  loaded_at       TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL
);

-- 배치마다 «그날의 대상 목록». 상장·폐지로 목록이 바뀌어도 그때의 모습이 남습니다.
CREATE TABLE IF NOT EXISTS universe (
  seq    INTEGER NOT NULL REFERENCES batches(seq),
  ticker TEXT NOT NULL,
  name   TEXT,
  PRIMARY KEY (seq, ticker)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS bars (
  ticker     TEXT NOT NULL,
  date       TEXT NOT NULL,
  seq        INTEGER NOT NULL REFERENCES batches(seq),  -- 이 값을 처음/새로 가져온 배치
  o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
  v INTEGER NOT NULL,
  ac REAL,
  fetched_at TEXT NOT NULL,
  adjustment TEXT,
  PRIMARY KEY (ticker, date, seq)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS bar_corrections (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker    TEXT NOT NULL,
  date      TEXT NOT NULL,
  seq       INTEGER NOT NULL REFERENCES batches(seq),   -- 바뀐 값을 가져온 배치
  field     TEXT NOT NULL,
  old_value REAL,
  new_value REAL
);

-- 실패·기준일 아님(stale) 기록. 한 배치에서 «왜 이 종목이 없는가»를 남깁니다.
CREATE TABLE IF NOT EXISTS batch_issues (
  seq    INTEGER NOT NULL REFERENCES batches(seq),
  ticker TEXT NOT NULL,
  kind   TEXT NOT NULL,        -- NOT_FOUND | BLOCKED | RETRY_EXHAUSTED | EMPTY | STALE
  detail TEXT,
  PRIMARY KEY (seq, ticker, kind)
) WITHOUT ROWID;

-- ── 후보 상태 머신 (src/candidates) ──────────────────────────────────────────
-- candidates 는 «현재 상태» 사본이고, candidate_events 는 «일어난 일의 기록»(추가만 가능)입니다.
CREATE TABLE IF NOT EXISTS candidates (
  id               TEXT PRIMARY KEY,        -- 종목|급증일|전략버전
  ticker           TEXT NOT NULL,
  surge_date       TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  state            TEXT NOT NULL,           -- CONFIRMING | WAITING | BROKE_OUT | INVALID | EXPIRED
  days             INTEGER NOT NULL,        -- 급증일 이후 지난 거래일(봉) 수
  surge_low        REAL NOT NULL,
  window_high      REAL NOT NULL,
  box_top          REAL,                    -- 박스 상단 B (확인이 끝나면 고정)
  discovered       TEXT NOT NULL,           -- 발견 당시 지표 값 (JSON)
  last_date        TEXT NOT NULL,           -- 마지막으로 반영한 봉 날짜
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS candidate_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  type         TEXT NOT NULL,               -- DISCOVERED | CONFIRMED | BREAKOUT | INVALIDATED | EXPIRED
  date         TEXT NOT NULL,               -- 사건이 일어난 «시장 날짜»
  detail       TEXT NOT NULL,               -- JSON
  recorded_at  TEXT NOT NULL,               -- 우리가 기록한 «실제 시각». date 보다 한참 뒤면 소급 계산입니다
  UNIQUE (candidate_id, type, date)
);
CREATE TRIGGER IF NOT EXISTS candidate_events_no_update BEFORE UPDATE ON candidate_events
BEGIN SELECT RAISE(ABORT, 'candidate_events 는 추가만 가능합니다'); END;
CREATE TRIGGER IF NOT EXISTS candidate_events_no_delete BEFORE DELETE ON candidate_events
BEGIN SELECT RAISE(ABORT, 'candidate_events 는 추가만 가능합니다'); END;

-- ── 환율 (src/fx) ────────────────────────────────────────────────────────────
-- 한국은행 ECOS 원/달러 매매기준율(토스 앱 평가 환율과 같은 값). 하루 하나.
-- 그날 시장 전체에서 거래량이 터진 종목이 얼마나 되는가(기록 전용, 판단에 쓰지 않음). 계산은 src/compute/breadth.js
-- 봉이 정정되면 다시 계산해 덮어쓴다(원본 봉은 bars 에 그대로 남아 있다).
CREATE TABLE IF NOT EXISTS market_breadth (
  date        TEXT PRIMARY KEY,
  evaluated   INTEGER NOT NULL,          -- RVOL 을 계산할 수 있었던 종목 수
  surge       INTEGER NOT NULL,          -- 그중 RVOL ≥ 3
  all_pass    INTEGER NOT NULL,          -- 5개 발견 조건을 모두 통과(= 후보 조건에 맞는 종목 수)
  ratio       REAL NOT NULL,             -- surge / evaluated
  market_wide INTEGER NOT NULL,          -- 1 이면 «시장 전체 급증일»
  computed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fx_rates (
  date       TEXT PRIMARY KEY,
  usdkrw     REAL NOT NULL,
  source     TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- ── 모의매매 (src/paper) — 가상 «원화» 계좌입니다. 실제 주문과 아무 관계가 없습니다 ──────
-- 장부(현금·평가액·손익)는 원화입니다. 주가·손절선·R 배수는 달러(주가 기준)입니다 — 전략이 주가에서 나오기 때문입니다.
CREATE TABLE IF NOT EXISTS paper_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  last_date     TEXT NOT NULL,              -- 여기까지의 시장 날짜를 처리했다
  cash          REAL NOT NULL,              -- 원화
  start_equity  REAL NOT NULL,              -- 원화
  paper_version TEXT NOT NULL,
  started_at    TEXT NOT NULL
);

-- 돌파 신호 하나당 주문 하나. 진입은 «신호 다음 거래일 시가»에 체결됩니다.
CREATE TABLE IF NOT EXISTS paper_orders (
  candidate_id TEXT PRIMARY KEY REFERENCES candidates(id),
  ticker       TEXT NOT NULL,
  signal_date  TEXT NOT NULL,
  signal_close REAL NOT NULL,                -- 달러
  atr_ref      REAL,                         -- 신호 전일까지의 ATR14 (갭 제한·손절 폭의 기준, 달러)
  rvol         REAL,                         -- 발견일 RVOL (동시 신호의 순위 기준)
  status       TEXT NOT NULL,                -- PENDING | FILLED | SKIPPED | IGNORED_RETRO
  reason       TEXT,
  decided_date TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_trades (
  candidate_id  TEXT PRIMARY KEY REFERENCES candidates(id),
  ticker        TEXT NOT NULL,
  entry_date    TEXT NOT NULL,
  entry_price   REAL NOT NULL,              -- 달러, 슬리피지 반영 후
  qty           REAL NOT NULL,              -- 소수점 주문을 가정한다 (settings.allowFractional)
  fx_entry      REAL NOT NULL,              -- 진입일 원/달러
  cost_krw      REAL NOT NULL,              -- 원화 매입금 = 수량 × 진입가 × 진입 환율 × (1 + 환전비용)
  initial_stop  REAL NOT NULL,              -- 달러
  stop          REAL NOT NULL,              -- 달러, 내려가지 않음
  r             REAL NOT NULL,              -- 1R(달러) = 진입가 − 초기 손절가
  box_top       REAL NOT NULL,
  highest_close REAL,
  bars_held     INTEGER NOT NULL,
  reached_1r    INTEGER NOT NULL,
  pending_exit  TEXT,                       -- BELOW_BOX | TIME : 다음 거래일 시가에 청산
  last_close    REAL,
  last_date     TEXT,
  status        TEXT NOT NULL,              -- OPEN | CLOSED
  exit_date     TEXT,
  exit_price    REAL,                       -- 달러, 슬리피지 반영 후
  exit_reason   TEXT,                       -- STOP | TRAIL_STOP | BELOW_BOX | TIME
  fx_exit       REAL,
  proceeds_krw  REAL,                       -- 원화 회수금 = 수량 × 청산가 × 청산 환율 × (1 − 환전비용)
  pnl_krw       REAL,                       -- 원화 손익 = 회수금 − 매입금   (달러 손익 × 환율이 아니다)
  return_krw    REAL,                       -- 원화 수익률
  return_usd    REAL,                       -- 주가 수익률 (슬리피지 반영, 환율·환전비용 제외)
  fx_effect     REAL,                       -- 환율 변화율 = 청산 환율 / 진입 환율 − 1
  pnl           REAL,                       -- 달러 손익(참고)
  r_multiple    REAL                        -- 주가 기준 R 배수. 전략의 질을 환율과 분리해서 보는 지표
);

CREATE TABLE IF NOT EXISTS paper_equity (
  date            TEXT PRIMARY KEY,
  cash            REAL NOT NULL,            -- 원화
  positions_value REAL NOT NULL,            -- 원화 (그날 환율로 평가)
  equity          REAL NOT NULL,            -- 원화
  open_positions  INTEGER NOT NULL,
  fx              REAL NOT NULL             -- 평가에 쓴 원/달러
);

-- ── 증권사(토스) 규칙 스냅샷 (src/broker) ────────────────────────────────────
-- 토스에서 «읽기만 해서» 받아 둔 수수료표·미국 장 일정. 종류마다 최신 한 줄만 둔다(덮어쓰기).
-- 모의매매는 수수료를 여기서 읽고, 없으면 settings 의 가정값을 쓴다.
CREATE TABLE IF NOT EXISTS broker_rules (
  kind       TEXT PRIMARY KEY,           -- commissions | market_calendar_us
  payload    TEXT NOT NULL,              -- 토스 응답의 result 를 그대로 JSON 으로
  fetched_at TEXT NOT NULL
);

-- 신호 종목이 «금액주문(소수점)으로 살 수 있는가»의 기록. API 로는 미리 알 수 없어서 사람이 앱에서 보고 적거나(source=APP),
-- 실제 주문의 성공·거절로 알게 된 것(source=ORDER)을 남긴다. 덮어쓰지 않고 쌓는다 — 종목마다 가장 새 줄이 현재 판단.
CREATE TABLE IF NOT EXISTS fractional_checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker     TEXT NOT NULL,
  result     TEXT NOT NULL CHECK (result IN ('OK','NO')),
  source     TEXT NOT NULL,              -- APP | ORDER
  note       TEXT,
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fractional_ticker ON fractional_checks (ticker, id);

-- ── 텔레그램 보고 (src/notify) ───────────────────────────────────────────────
-- «어디까지 보고했나»의 표식. 전송이 성공한 뒤에만 앞으로 옮기므로, 실패하면 다음 실행이 다시 보냅니다.
CREATE TABLE IF NOT EXISTS report_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  last_event_id    INTEGER NOT NULL,       -- 여기까지의 candidate_events 를 보고했다
  last_report_date TEXT NOT NULL,          -- 여기까지의 시장 날짜(기준일)를 보고했다
  sent_at          TEXT NOT NULL
);

-- 같은 (종목, 날짜)에 값이 여러 번 있으면 가장 늦게 받은 것
CREATE VIEW IF NOT EXISTS latest_bars AS
SELECT b.*
FROM bars b
JOIN (SELECT ticker, date, MAX(seq) AS seq FROM bars GROUP BY ticker, date) m
  ON b.ticker = m.ticker AND b.date = m.date AND b.seq = m.seq;
`;

/**
 * 모의매매 표가 달러 장부(스키마 3·4)였을 때의 이전. 거래가 하나도 없으면 표를 지우고 새로 만든다(주문은 사건에서 다시 만들어진다).
 * 거래가 있으면 자동으로 지우지 않고 멈춘다 — 원화 환산에 필요한 진입일 환율이 그 기록에 없다.
 */
function migratePaperToKrw(db) {
  const exists = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='paper_trades'").get();
  if (!exists) return;
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM paper_trades").get();
  if (n > 0) throw new Error(`달러 장부의 모의 거래 ${n}건이 있어 원화 장부로 자동 이전하지 않습니다. 기록을 보존하려면 먼저 알려 주세요.`);
  for (const table of ["paper_equity", "paper_trades", "paper_orders", "paper_state"]) db.exec(`DROP TABLE IF EXISTS ${table}`);
}

export function openDb(file) {
  if (!sqlite) {
    throw new Error(
      `이 Node(${process.version})에는 node:sqlite 가 없습니다. Node 22.13 이상이 필요합니다 ` +
        `(${sqliteError?.code ?? sqliteError?.message}). 서버 Node를 올리거나, 그 전에는 Mac에서 receive 를 돌려 DB를 만든 뒤 4_db 만 옮기세요.`,
    );
  }
  // 데이터 폴더(4_db)는 서버의 receive 가 만든다. 없으면 대개 «서버에서 돌릴 명령을 다른 기기에서 돌린» 경우다
  if (file !== ":memory:" && !existsSync(path.dirname(file))) {
    throw new Error(`DB 폴더가 없습니다: ${path.dirname(file)} — 이 명령은 DB가 있는 서버(Oracle)에서 실행하세요. (서버에서 npm run receive 가 이 폴더를 만듭니다)`);
  }
  const db = new sqlite.DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const { user_version: version } = db.prepare("PRAGMA user_version").get();
  if (version > SCHEMA_VERSION) throw new Error(`DB 스키마(${version})가 이 코드(${SCHEMA_VERSION})보다 새롭습니다`);
  if (version >= 3 && version < 5) migratePaperToKrw(db);
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

export function isLoaded(db, batch) {
  return db.prepare("SELECT 1 AS x FROM batches WHERE batch = ?").get(batch) !== undefined;
}

/**
 * 검수를 통과한 배치 하나를 한 트랜잭션으로 적재합니다. 중간에 실패하면 전부 되돌립니다.
 * @returns {{seq:number, tickers:number, barsInserted:number, barsUnchanged:number, corrections:number}}
 */
export function loadBatch(db, { batch, data, now = new Date() }) {
  const { manifest, manifestSha256, universe, lines, failures } = data;
  if (isLoaded(db, batch)) throw new Error(`이미 적재된 배치입니다: ${batch}`);

  const insertBatch = db.prepare(`INSERT INTO batches
    (batch, mode, source, as_of, run_date, status, requested, ok, missing, stale, started_at, finished_at, loaded_at, manifest_sha256)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertUniverse = db.prepare("INSERT INTO universe (seq, ticker, name) VALUES (?,?,?)");
  const selectLatest = db.prepare("SELECT date, o, h, l, c, v, ac FROM latest_bars WHERE ticker = ?");
  const insertBar = db.prepare(`INSERT INTO bars (ticker, date, seq, o, h, l, c, v, ac, fetched_at, adjustment)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insertCorrection = db.prepare("INSERT INTO bar_corrections (ticker, date, seq, field, old_value, new_value) VALUES (?,?,?,?,?,?)");
  const insertIssue = db.prepare("INSERT OR IGNORE INTO batch_issues (seq, ticker, kind, detail) VALUES (?,?,?,?)");

  const stats = { seq: 0, tickers: lines.length, barsInserted: 0, barsUnchanged: 0, corrections: 0 };
  db.exec("BEGIN");
  try {
    const { counts } = manifest;
    const result = insertBatch.run(
      batch, manifest.mode, manifest.source, manifest.asOf, manifest.runDate, manifest.status,
      counts.requested, counts.ok, counts.missing, counts.stale,
      manifest.startedAt ?? null, manifest.finishedAt ?? null, now.toISOString(), manifestSha256,
    );
    const seq = Number(result.lastInsertRowid);
    stats.seq = seq;

    for (const entry of universe.symbols) insertUniverse.run(seq, entry.symbol, entry.name ?? null);

    for (const line of lines) {
      const existing = new Map(selectLatest.all(line.ticker).map((row) => [row.date, row]));
      for (const raw of line.bars) {
        const bar = { o: r4(raw.o), h: r4(raw.h), l: r4(raw.l), c: r4(raw.c), v: raw.v, ac: r4(raw.ac ?? null) };
        const before = existing.get(raw.date);
        if (before) {
          const changed = FIELDS.filter((field) => (before[field] ?? null) !== (bar[field] ?? null));
          if (changed.length === 0) {
            stats.barsUnchanged += 1;
            continue;
          }
          for (const field of changed) {
            insertCorrection.run(line.ticker, raw.date, seq, field, before[field] ?? null, bar[field] ?? null);
            stats.corrections += 1;
          }
        }
        insertBar.run(line.ticker, raw.date, seq, bar.o, bar.h, bar.l, bar.c, bar.v, bar.ac, line.fetchedAt, line.adjustment ?? null);
        stats.barsInserted += 1;
      }
    }

    for (const failure of failures) insertIssue.run(seq, failure.ticker, failure.kind, failure.message ?? null);
    for (const stale of manifest.staleTickers ?? []) insertIssue.run(seq, stale.ticker, "STALE", `마지막 봉 ${stale.last}`);

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return stats;
}
