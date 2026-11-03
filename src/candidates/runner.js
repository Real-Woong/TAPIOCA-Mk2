// DB 의 봉을 읽어 모든 종목의 후보를 갱신하고, 결과를 candidates / candidate_events 에 기록합니다.
//
// ── 이 파일의 구성 ──────────────────────────────────────────────────────────
//  runCandidates()   DB 전체를 한 번 돌린다 (매일 receive 뒤에 실행). 다시 돌려도 결과가 같다(멱등)
//  persist()         한 후보를 DB 에 저장한다 (내부용)
//  (같이 하는 일)    날짜별 «시장 전체 폭»(market_breadth)을 계산해 기록한다 — 후보 판단에는 쓰지 않는 기록 전용 값
//
// ── 기록을 지키는 규칙 ──────────────────────────────────────────────────────
//  · 사건(candidate_events)은 추가만 한다. (후보, 종류, 날짜)가 같으면 두 번 넣지 않는다.
//  · 이미 끝난 후보(돌파·무효·만료)는 다시 쓰지 않는다. 나중에 Yahoo 가 과거 값을 정정해도
//    «그때 내린 판단과 기록»은 그대로 남습니다.
//  · 진행 중인 후보만 새 봉으로 상태 사본을 갱신한다.
//  · 첫 실행은 보유한 과거 봉 전체를 훑으므로 «지난 일»이 한꺼번에 기록됩니다.
//    사건의 date(시장 날짜)와 recorded_at(기록 시각)이 크게 다르면 소급 계산입니다.
//    모의매매는 소급분으로 진입하지 않고, 기록 당일의 사건만 신호로 씁니다.

import { computeBreadth } from "../compute/breadth.js";
import { loadBarsByTicker, loadSplitSuspects } from "../compute/scan.js";
import { SETTINGS, STRATEGY_VERSION } from "../compute/settings.js";
import { replayTicker } from "./replay.js";
import { STATES } from "./step.js";

const TERMINAL = new Set([STATES.BROKE_OUT, STATES.INVALID, STATES.EXPIRED]);

function persist(db, ticker, entry, lastDate, nowIso, stmts) {
  const { candidate: c, events } = entry;
  const existing = stmts.get.get(c.id);
  if (existing && TERMINAL.has(existing.state)) return { newCandidate: false, newEvents: [] }; // 끝난 후보는 건드리지 않는다

  const discovered = JSON.stringify(events[0]);
  if (!existing) {
    stmts.insert.run(c.id, ticker, c.surgeDate, c.id.split("|")[2], c.state, c.days, c.surgeLow, c.windowHigh, c.boxTop, discovered, lastDate, nowIso);
  } else {
    stmts.update.run(c.state, c.days, c.windowHigh, c.boxTop, lastDate, nowIso, c.id);
  }

  const newEvents = [];
  for (const event of events) {
    const { candidateId, type, date, ...detail } = event;
    const result = stmts.event.run(candidateId, type, date, JSON.stringify(detail), nowIso);
    if (result.changes === 1) newEvents.push({ ...event, ticker });
  }
  return { newCandidate: !existing, newEvents };
}

/**
 * @returns {{ tickersRun:number, tickersSkipped:number, newCandidates:number, newEvents:object[], byState:Record<string,number>, breadthDates:number }}
 *          newEvents = 이번 실행에서 «처음 기록된» 사건들 (텔레그램 보고·모의매매 신호의 재료)
 */
export function runCandidates(db, { now = new Date(), settings = SETTINGS, strategyVersion = STRATEGY_VERSION } = {}) {
  const barsByTicker = loadBarsByTicker(db);
  const suspects = loadSplitSuspects(db);
  const nowIso = now.toISOString();
  const stmts = {
    get: db.prepare("SELECT state FROM candidates WHERE id = ?"),
    insert: db.prepare(`INSERT INTO candidates
      (id, ticker, surge_date, strategy_version, state, days, surge_low, window_high, box_top, discovered, last_date, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
    update: db.prepare("UPDATE candidates SET state=?, days=?, window_high=?, box_top=?, last_date=?, updated_at=? WHERE id=?"),
    event: db.prepare("INSERT OR IGNORE INTO candidate_events (candidate_id, type, date, detail, recorded_at) VALUES (?,?,?,?,?)"),
  };

  const summary = { tickersRun: 0, tickersSkipped: 0, newCandidates: 0, newEvents: [], byState: {}, breadthDates: 0 };
  db.exec("BEGIN");
  try {
    for (const [ticker, bars] of barsByTicker) {
      // scan 과 같은 대상: 봉이 부족하거나 분할 의심인 종목은 계산하지 않는다
      if (bars.length < settings.minBars || suspects.has(ticker)) {
        summary.tickersSkipped += 1;
        continue;
      }
      summary.tickersRun += 1;
      const lastDate = bars.at(-1).date;
      for (const entry of replayTicker(ticker, bars, { settings, strategyVersion })) {
        const result = persist(db, ticker, entry, lastDate, nowIso, stmts);
        if (result.newCandidate) summary.newCandidates += 1;
        summary.newEvents.push(...result.newEvents);
      }
    }
    // 시장 전체 폭: 기록 전용. 봉이 정정되면 같은 날짜 값이 바뀔 수 있어 매번 덮어쓴다
    const putBreadth = db.prepare(`INSERT OR REPLACE INTO market_breadth (date, evaluated, surge, all_pass, ratio, market_wide, computed_at)
      VALUES (?,?,?,?,?,?,?)`);
    for (const row of computeBreadth(barsByTicker, suspects, settings)) {
      putBreadth.run(row.date, row.evaluated, row.surge, row.allPass, row.ratio, row.marketWide ? 1 : 0, nowIso);
      summary.breadthDates += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  for (const row of db.prepare("SELECT state, COUNT(*) AS n FROM candidates GROUP BY state").all()) summary.byState[row.state] = row.n;
  return summary;
}
