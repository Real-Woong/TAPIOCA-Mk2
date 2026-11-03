// 보고에 들어갈 데이터를 DB 에서 모으고, 보내고, «어디까지 보고했는지»를 기록합니다.
//
// ── 이 파일의 구성 ──────────────────────────────────────────────────────────
//  gatherReport()   마지막 보고 이후 달라진 것(후보 사건·모의 체결/청산·계좌·후보 현황)을 모은다
//  runReport()      모으기 → 문구 만들기 → 전송 → 성공했을 때만 표식 갱신 (실패하면 다음 실행이 다시 보낸다)
//  runWatchdog()    최신 기준일이 늦으면 경고를 보낸다 (하루 한 번 따로 돌린다)
//
// ── 보고하지 않는 것 ────────────────────────────────────────────────────────
//  · 소급 기록된 사건(기록이 사건 날짜보다 3일 넘게 늦음). 실시간으로 본 일이 아니라 나중에 계산해 채운 일입니다.
//  · 첫 보고에서는 쌓여 있던 사건을 한꺼번에 쏟아내지 않고 «시작 안내»만 보내며 표식을 현재로 맞춥니다.

import { nextRegularOpen } from "../broker/rules.js";
import { latestFractional } from "../broker/fractional.js";
import { loadBrokerRule } from "../broker/refresh.js";
import { formatDailyReport, formatStartReport, formatWatchdog, expectedAsOf } from "./format.js";
import { sendTelegram } from "./telegram.js";

const DAY_MS = 86_400_000;
const MAX_LAG_DAYS = 3;

export function gatherReport(db, { sinceEventId, sinceDate, now = new Date() }) {
  const batch = db.prepare("SELECT * FROM batches ORDER BY seq DESC LIMIT 1").get();

  const rows = db.prepare(`SELECT e.id, e.type, e.date, e.detail, e.recorded_at, c.ticker
    FROM candidate_events e JOIN candidates c ON c.id = e.candidate_id WHERE e.id > ? ORDER BY e.id`).all(sinceEventId);
  // 시장 전체 급증일(그날 거래량이 터진 종목이 유난히 많은 날)에 발견된 후보는 표시해 둔다 — 판단에는 쓰지 않는 참고 표식
  const wideDays = new Map(db.prepare("SELECT * FROM market_breadth WHERE market_wide = 1").all().map((r) => [r.date, r]));
  let retroCount = 0;
  let breadth = null;
  const events = [];
  for (const row of rows) {
    const lag = Math.round((Date.parse(row.recorded_at.slice(0, 10)) - Date.parse(row.date)) / DAY_MS);
    if (lag > MAX_LAG_DAYS) {
      retroCount += 1;
      continue;
    }
    const marketWide = row.type === "DISCOVERED" && wideDays.has(row.date);
    if (marketWide) breadth ??= wideDays.get(row.date);
    events.push({ ...row, detail: JSON.parse(row.detail), marketWide });
  }
  const maxEventId = rows.length ? rows.at(-1).id : sinceEventId;

  const paper = {
    fills: db.prepare("SELECT * FROM paper_trades WHERE entry_date > ? ORDER BY entry_date, ticker").all(sinceDate),
    exits: db.prepare("SELECT * FROM paper_trades WHERE exit_date > ? ORDER BY exit_date, ticker").all(sinceDate),
    skips: db.prepare("SELECT * FROM paper_orders WHERE status = 'SKIPPED' AND decided_date > ? ORDER BY decided_date, ticker").all(sinceDate),
    open: db.prepare("SELECT * FROM paper_trades WHERE status = 'OPEN' ORDER BY entry_date, ticker").all(),
    account: null,
    fx: null,
    closedCount: 0,
    avgR: 0,
    sumPnlKrw: 0,
  };
  const state = db.prepare("SELECT * FROM paper_state WHERE id = 1").get();
  if (state) {
    const eq = db.prepare("SELECT * FROM paper_equity ORDER BY date DESC LIMIT 1").get();
    paper.account = { equity: eq?.equity ?? state.cash, cash: state.cash, start: state.start_equity };
    paper.fx = eq?.fx ?? null;
  }
  const closed = db.prepare("SELECT r_multiple, pnl_krw FROM paper_trades WHERE status = 'CLOSED'").all();
  paper.closedCount = closed.length;
  paper.avgR = closed.length ? closed.reduce((a, t) => a + t.r_multiple, 0) / closed.length : 0;
  paper.sumPnlKrw = closed.reduce((a, t) => a + t.pnl_krw, 0);

  const counts = Object.fromEntries(db.prepare("SELECT state, COUNT(*) AS n FROM candidates GROUP BY state").all().map((r) => [r.state, r.n]));
  const waiting = db.prepare("SELECT ticker, box_top, days FROM candidates WHERE state = 'WAITING' ORDER BY days").all();

  // 매수 신호 종목의 «금액주문 가능 여부» 기록(없으면 아직 모름) — 앱에서 확인하고 npm run fractional 로 적는다
  const fractional = {};
  for (const e of events) if (e.type === "BREAKOUT") fractional[e.ticker] = latestFractional(db, e.ticker)?.result ?? null;

  // 다음 정규장 개장 시각(한국 시간): 토스 장 일정 스냅샷이 있고 아직 지나지 않은 것만. 없으면 null
  const nextOpen = nextRegularOpen(loadBrokerRule(db, "market_calendar_us")?.payload, now)?.label ?? null;

  return { batch, events, retroCount, paper, counts, waiting, maxEventId, breadth, nextOpen, fractional };
}

/**
 * @param {object} options
 * @param {{token:string, chatId:string}|null} options.config   null 이면 보내지 않고 문구만 만든다
 * @param {boolean} options.dry     true 면 보내지도, 표식을 옮기지도 않는다
 * @param {boolean} options.force   이미 보고한 기준일이어도 다시 보낸다
 * @returns {Promise<{status:string, text?:string}>}
 *          status: NO_DATA | ALREADY_REPORTED | DRY | NO_CONFIG | SENT | STARTED
 */
export async function runReport(db, { config, fetchImpl, dry = false, force = false, now = new Date() } = {}) {
  const batch = db.prepare("SELECT * FROM batches ORDER BY seq DESC LIMIT 1").get();
  if (!batch) return { status: "NO_DATA" };

  const state = db.prepare("SELECT * FROM report_state WHERE id = 1").get();
  const isStart = !state;
  if (!isStart && state.last_report_date >= batch.as_of && !force) return { status: "ALREADY_REPORTED" };

  const maxId = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM candidate_events").get().m;
  const data = isStart
    ? gatherReport(db, { sinceEventId: maxId, sinceDate: batch.as_of, now })
    : gatherReport(db, { sinceEventId: state.last_event_id, sinceDate: state.last_report_date, now });
  const text = isStart ? formatStartReport(data) : formatDailyReport(data);

  if (dry) return { status: "DRY", text };
  if (!config) return { status: "NO_CONFIG", text };

  await sendTelegram(text, { ...config, fetchImpl });
  // 전송이 성공한 뒤에만 표식을 옮긴다 — 실패하면 다음 실행이 같은 내용을 다시 보낸다
  db.prepare(`INSERT INTO report_state (id, last_event_id, last_report_date, sent_at) VALUES (1,?,?,?)
    ON CONFLICT(id) DO UPDATE SET last_event_id = excluded.last_event_id, last_report_date = excluded.last_report_date, sent_at = excluded.sent_at`)
    .run(data.maxEventId, batch.as_of, now.toISOString());
  return { status: isStart ? "STARTED" : "SENT", text };
}

/**
 * 최신 기준일이 «지금 있어야 할 날짜»보다 늦으면 경고를 보낸다. 하루 한 번만 돌리세요(중복 방지 표식이 없습니다).
 * @returns {Promise<{status:'OK'|'LATE_SENT'|'LATE_NO_CONFIG'|'DRY', text?:string}>}
 */
export async function runWatchdog(db, { config, fetchImpl, dry = false, now = new Date() } = {}) {
  const latest = db.prepare("SELECT MAX(as_of) AS d FROM batches").get().d ?? null;
  const expected = expectedAsOf(now);
  if (latest !== null && latest >= expected) return { status: "OK" };

  const last = db.prepare("SELECT batch, loaded_at FROM batches ORDER BY seq DESC LIMIT 1").get();
  const text = formatWatchdog({ latestAsOf: latest, expected, lastBatch: last ? `${last.batch} (${last.loaded_at.slice(0, 16)}Z)` : null });
  if (dry) return { status: "DRY", text };
  if (!config) return { status: "LATE_NO_CONFIG", text };
  await sendTelegram(text, { ...config, fetchImpl });
  return { status: "LATE_SENT", text };
}
