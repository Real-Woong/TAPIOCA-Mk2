// 모의매매 엔진: 돌파 신호 → 주문 → 체결 → 보유 → 청산을 가상 «원화» 계좌에 기록합니다. 실제 주문과 무관합니다.
//
// ── 원화 장부 규칙 ──────────────────────────────────────────────────────────
//  · 매입금(원)  = 수량 × 진입가($) × 진입일 환율 × (1 + 환전비용 + 거래 수수료)
//  · 회수금(원)  = 수량 × 청산가($) × 청산일 환율 × (1 − 환전비용 − 거래 수수료)
//    (거래 수수료는 토스에서 읽어 둔 요율표의 그 날짜 값, 없으면 settings 의 가정값. 환전비용은 아직 가정값)
//  · 원화 손익   = 회수금 − 매입금        ← «달러 손익 × 환율»이 아니다 (환율 변동분이 빠지면 부호까지 틀릴 수 있다)
//  · 평가액(원)  = 현금 + Σ 수량 × 마지막 종가($) × 그날 환율
//  · 주가 수익률·R 배수는 달러(주가) 기준으로 따로 기록해, 원화 손익이 «주가 때문인지 환율 때문인지» 갈라 볼 수 있다
//  · 환율이 없으면 다른 값으로 채우지 않고 멈춘다 (그 실행의 기록은 전부 되돌려진다)
//
// ── 이 파일의 구성 ──────────────────────────────────────────────────────────
//  runPaper()          하루(또는 밀린 여러 날)를 처리한다. receive → candidates 다음에 매일 실행. 다시 돌려도 안전하다
//  createOrders()      새 돌파 사건에서 주문을 만든다 (소급 기록된 사건은 무시)
//  fillOrders()        어제까지의 대기 주문을 «오늘 시가»에 체결하거나 건너뛴다
//  sessionUpdate()     보유 종목을 오늘 봉으로 갱신하고 손절·청산을 처리한다
//  closeTrade()        청산 기록과 현금 반영
//  (참고) 금액주문이 안 된다고 기록된 종목(fractional_checks)은 체결 때 NOT_ELIGIBLE 로 건너뛴다
//
// ── 시간 순서 (하루 d 에 일어나는 일) ───────────────────────────────────────
//   (장 시작) 예약된 청산 체결 → 어제까지의 대기 주문 체결(자리가 났으면)
//   (마감) 모든 보유 종목: 종가가 손절선 이하인지 확인 → 종가 기준 갱신·내일 시가 청산 예약 → 계좌 평가액 기록
//   ※ 청산은 전부 «다음 날 시가»입니다(손절도). 토스 금액 주문은 시장가뿐이고 판단은 마감 뒤에 하기 때문입니다(rules.js 머리말)
//
// ── 소급 방지 ───────────────────────────────────────────────────────────────
// 돌파 사건의 기록 시각(recorded_at)이 사건 날짜보다 maxSignalLagDays 넘게 늦으면 IGNORED_RETRO 로 남기고 진입하지 않는다.
// 첫 실행에서 과거 봉을 훑어 만든 «지난 신호»로 모의 진입하면, 이미 아는 결과로 매매하는 것이 되기 때문입니다.
//
// 모의매매는 첫 실행 시점의 마지막 봉 날짜부터 시작합니다. 그 이전 날짜는 처리하지 않습니다.

import { atrSeries } from "../compute/indicators.js";
import { rateOn } from "../fx/fx.js";
import { loadBarsByTicker } from "../compute/scan.js";
import { commissionBpsOn } from "../broker/rules.js";
import { latestFractional } from "../broker/fractional.js";
import { loadBrokerRule } from "../broker/refresh.js";
import { PAPER_SETTINGS, PAPER_VERSION } from "./settings.js";
import { fillPrice, floorQty, initialStopOf, isGapSkipped, onOpen, onSession, positionSize } from "./rules.js";

const DAY_MS = 86_400_000;

export function runPaper(db, { now = new Date(), s = PAPER_SETTINGS, startAfterDate = null } = {}) {
  const nowIso = now.toISOString();
  const summary = { orders: [], fills: [], skips: [], exits: [], processedDates: [] };

  // ── 준비: 종목별 시계열 (날짜 → 위치, ATR 은 필요할 때만 계산)
  const barsByTicker = loadBarsByTicker(db);
  const cache = new Map();
  const series = (ticker) => {
    if (!cache.has(ticker)) {
      const bars = barsByTicker.get(ticker) ?? [];
      cache.set(ticker, { bars, index: new Map(bars.map((b, i) => [b.date, i])), atr: null });
    }
    return cache.get(ticker);
  };
  const atrAt = (ticker, i) => {
    const ser = series(ticker);
    ser.atr ??= atrSeries(ser.bars);
    return ser.atr[i] ?? null;
  };

  const fxOn = (date) => {
    const found = rateOn(db, date);
    if (!found) throw new Error(`${date} 의 원/달러 환율이 없습니다 — npm run paper 는 실행 때 환율을 먼저 받습니다(ECOS 연결·키 확인)`);
    return found.rate;
  };

  // 날짜별 «한쪽 비용 bp» = 환전비용 + 거래 수수료. 수수료는 토스에서 읽어 둔 요율표(없으면 가정값)
  const commissionTable = loadBrokerRule(db, "commissions")?.payload ?? null;
  const feeBpsOn = (date) => s.fxCostBps + (commissionBpsOn(commissionTable, date) ?? s.commissionBps);

  db.exec("BEGIN");
  try {
    let state = db.prepare("SELECT * FROM paper_state WHERE id = 1").get();
    if (!state) {
      const latest = db.prepare("SELECT MAX(date) AS d FROM latest_bars").get().d;
      if (!latest) {
        db.exec("COMMIT");
        return summary;
      }
      db.prepare("INSERT INTO paper_state (id, last_date, cash, start_equity, paper_version, started_at) VALUES (1,?,?,?,?,?)")
        .run(startAfterDate ?? latest, s.startEquityKrw, s.startEquityKrw, PAPER_VERSION, nowIso);
      state = db.prepare("SELECT * FROM paper_state WHERE id = 1").get();
    }
    // 거래가 아직 없으면 설정 버전만 최신으로 맞춘다(규칙이 바뀐 뒤의 기록에 옛 버전 꼬리표가 붙지 않게)
    if (state.paper_version !== PAPER_VERSION && !db.prepare("SELECT 1 FROM paper_trades LIMIT 1").get()) {
      db.prepare("UPDATE paper_state SET paper_version = ? WHERE id = 1").run(PAPER_VERSION);
    }
    const ctx = { db, s, nowIso, series, atrAt, fxOn, feeBpsOn, cash: state.cash, summary, lastDate: state.last_date };

    createOrders(ctx);

    const dates = db.prepare("SELECT DISTINCT date FROM latest_bars WHERE date > ? ORDER BY date").all(state.last_date).map((r) => r.date);
    for (const date of dates) {
      // (장 시작) 예약된 청산 → 대기 주문 체결
      for (const trade of openTrades(db)) {
        const bar = barOf(ctx, trade.ticker, date);
        if (!bar || !trade.pending_exit) continue;
        const exit = onOpen(toPosition(trade), bar);
        if (exit) closeTrade(ctx, trade, date, exit);
      }
      fillOrders(ctx, date);
      // (마감) 보유 종목 갱신
      for (const trade of openTrades(db)) sessionUpdate(ctx, trade, date);
      recordEquity(ctx, date);
      summary.processedDates.push(date);
    }

    if (dates.length) db.prepare("UPDATE paper_state SET last_date = ?, cash = ? WHERE id = 1").run(dates.at(-1), ctx.cash);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return summary;
}

// ═══ 주문 만들기 ════════════════════════════════════════════════════════════

function createOrders(ctx) {
  const { db, s, nowIso, summary } = ctx;
  const events = db.prepare(`
    SELECT e.candidate_id, e.date, e.recorded_at, e.detail, c.ticker, c.discovered
    FROM candidate_events e
    JOIN candidates c ON c.id = e.candidate_id
    LEFT JOIN paper_orders o ON o.candidate_id = e.candidate_id
    WHERE e.type = 'BREAKOUT' AND o.candidate_id IS NULL
    ORDER BY e.date`).all();
  const insert = db.prepare(`INSERT INTO paper_orders
    (candidate_id, ticker, signal_date, signal_close, atr_ref, rvol, status, reason, decided_date, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);

  for (const e of events) {
    const detail = JSON.parse(e.detail);
    const rvol = JSON.parse(e.discovered).rvol ?? null;
    const lagDays = Math.round((Date.parse(e.recorded_at.slice(0, 10)) - Date.parse(e.date)) / DAY_MS);
    let status = "PENDING";
    let reason = null;
    let decided = null;
    if (lagDays > s.maxSignalLagDays) {
      status = "IGNORED_RETRO";
      reason = `소급 기록: 사건 ${e.date}, 기록 ${lagDays}일 뒤`;
      decided = e.date;
    } else if (e.date < ctx.lastDate) {
      status = "IGNORED_RETRO";
      reason = `모의매매 시작(${ctx.lastDate}) 이전 신호`;
      decided = e.date;
    }
    insert.run(e.candidate_id, e.ticker, e.date, detail.close, detail.atrPrev ?? null, rvol, status, reason, decided, nowIso);
    summary.orders.push({ candidateId: e.candidate_id, ticker: e.ticker, signalDate: e.date, status, reason });
  }
}

// ═══ 체결 ═══════════════════════════════════════════════════════════════════

function fillOrders(ctx, date) {
  const { db, s, summary } = ctx;
  // 어제까지 나온 신호만 오늘 시가에 체결된다. 동시 신호는 RVOL 높은 순(사전 고정된 순위 기준)
  const pending = db.prepare(`SELECT o.*, c.surge_date, c.box_top FROM paper_orders o JOIN candidates c ON c.id = o.candidate_id
    WHERE o.status = 'PENDING' AND o.signal_date < ? ORDER BY o.signal_date, o.rvol DESC, o.ticker`).all(date);

  const skip = (order, reason) => {
    db.prepare("UPDATE paper_orders SET status='SKIPPED', reason=?, decided_date=? WHERE candidate_id=?").run(reason, date, order.candidate_id);
    summary.skips.push({ candidateId: order.candidate_id, ticker: order.ticker, date, reason });
  };

  for (const order of pending) {
    const ser = ctx.series(order.ticker);
    const i = ser.index.get(date);
    if (i === undefined) { skip(order, "NO_BAR_NEXT_DAY"); continue; }
    const bar = ser.bars[i];
    // 사람이 «이 종목은 앱에서 금액주문이 안 된다»고 기록해 둔 종목은 사지 못한다(기록이 없으면 가능하다고 가정 — 낙관적인 가정)
    if (s.allowFractional && latestFractional(db, order.ticker)?.result === "NO") { skip(order, "NOT_ELIGIBLE"); continue; }
    if (isGapSkipped({ open: bar.o, signalClose: order.signal_close, atrRef: order.atr_ref, s })) { skip(order, "GAP"); continue; }

    const open = openTrades(db);
    if (open.length >= s.maxPositions) { skip(order, "MAX_POSITIONS"); continue; }

    const surgeIndex = ser.index.get(order.surge_date);
    const stop = surgeIndex === undefined ? null : initialStopOf(ser.bars, surgeIndex, order.atr_ref, s);
    const entry = fillPrice(bar.o, "BUY", s);
    if (stop === null || stop >= entry) { skip(order, "BAD_STOP"); continue; }

    // 수량은 달러로 계산한다(가격·손절폭이 달러) — 원화 평가액을 그날 환율로 달러로 바꿔서 넣는다
    const fx = ctx.fxOn(date);
    const equityKrw = ctx.cash + open.reduce((sum, t) => sum + t.qty * (t.last_close ?? t.entry_price) * fx, 0);
    let qty = positionSize({ equity: equityKrw / fx, entry, stop, s });
    if (qty * entry < s.minOrderUsd) { skip(order, "SIZE_ZERO"); continue; }
    const costPerShareKrw = entry * fx * (1 + ctx.feeBpsOn(date) / 10_000);
    qty = Math.min(qty, floorQty(ctx.cash / costPerShareKrw, s));
    if (qty * entry < s.minOrderUsd) { skip(order, "NO_CASH"); continue; }

    const costKrw = qty * costPerShareKrw;
    ctx.cash -= costKrw;
    db.prepare(`INSERT INTO paper_trades
      (candidate_id, ticker, entry_date, entry_price, qty, fx_entry, cost_krw, initial_stop, stop, r, box_top, highest_close, bars_held, reached_1r, pending_exit, last_close, last_date, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,0,0,NULL,NULL,NULL,'OPEN')`)
      .run(order.candidate_id, order.ticker, date, entry, qty, fx, costKrw, stop, stop, entry - stop, order.box_top);
    db.prepare("UPDATE paper_orders SET status='FILLED', decided_date=? WHERE candidate_id=?").run(date, order.candidate_id);
    summary.fills.push({ candidateId: order.candidate_id, ticker: order.ticker, date, price: entry, qty, stop, fx, costKrw });
  }
}

// ═══ 보유 종목 갱신과 청산 ═══════════════════════════════════════════════════

const openTrades = (db) => db.prepare("SELECT * FROM paper_trades WHERE status = 'OPEN' ORDER BY entry_date, ticker").all();
const barOf = (ctx, ticker, date) => {
  const ser = ctx.series(ticker);
  const i = ser.index.get(date);
  return i === undefined ? null : ser.bars[i];
};

const toPosition = (t) => ({
  entryPrice: t.entry_price, initialStop: t.initial_stop, stop: t.stop, r: t.r, boxTop: t.box_top,
  highestClose: t.highest_close, barsHeld: t.bars_held, reached1R: Boolean(t.reached_1r), pendingExit: t.pending_exit,
});

function sessionUpdate(ctx, trade, date) {
  const ser = ctx.series(trade.ticker);
  const i = ser.index.get(date);
  if (i === undefined || date < trade.entry_date) return; // 오늘 봉이 없으면(거래 정지 등) 그대로 둔다
  const bar = ser.bars[i];
  const { position } = onSession(toPosition(trade), bar, ctx.atrAt(trade.ticker, i), ctx.s); // 청산은 onOpen(다음 날 시가)에서
  ctx.db.prepare(`UPDATE paper_trades SET stop=?, highest_close=?, bars_held=?, reached_1r=?, pending_exit=?, last_close=?, last_date=?
    WHERE candidate_id=?`)
    .run(position.stop, position.highestClose, position.barsHeld, position.reached1R ? 1 : 0, position.pendingExit, bar.c, date, trade.candidate_id);
}

function closeTrade(ctx, trade, date, exit) {
  const price = fillPrice(exit.price, "SELL", ctx.s);
  const fxExit = ctx.fxOn(date);
  const proceedsKrw = trade.qty * price * fxExit * (1 - ctx.feeBpsOn(date) / 10_000);
  const pnlKrw = proceedsKrw - trade.cost_krw; // 회수금 − 매입금. 달러 손익 × 환율이 아니다
  const returnKrw = pnlKrw / trade.cost_krw;
  const returnUsd = price / trade.entry_price - 1; // 주가 수익률(슬리피지 반영, 환율·환전비용 제외)
  const fxEffect = fxExit / trade.fx_entry - 1;
  const pnlUsd = (price - trade.entry_price) * trade.qty;
  const rMultiple = (price - trade.entry_price) / trade.r;
  ctx.cash += proceedsKrw;
  ctx.db.prepare(`UPDATE paper_trades SET status='CLOSED', exit_date=?, exit_price=?, exit_reason=?, fx_exit=?, proceeds_krw=?, pnl_krw=?,
    return_krw=?, return_usd=?, fx_effect=?, pnl=?, r_multiple=?, last_date=? WHERE candidate_id=?`)
    .run(date, price, exit.reason, fxExit, proceedsKrw, pnlKrw, returnKrw, returnUsd, fxEffect, pnlUsd, rMultiple, date, trade.candidate_id);
  ctx.summary.exits.push({ candidateId: trade.candidate_id, ticker: trade.ticker, date, reason: exit.reason, price, fxExit, pnlKrw, returnKrw, returnUsd, fxEffect, rMultiple });
}

function recordEquity(ctx, date) {
  const open = openTrades(ctx.db);
  const fx = ctx.fxOn(date);
  const positionsValue = open.reduce((sum, t) => sum + t.qty * (t.last_close ?? t.entry_price) * fx, 0);
  ctx.db.prepare("INSERT OR REPLACE INTO paper_equity (date, cash, positions_value, equity, open_positions, fx) VALUES (?,?,?,?,?,?)")
    .run(date, ctx.cash, positionsValue, ctx.cash + positionsValue, open.length, fx);
}
