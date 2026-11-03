import test from "node:test";
import assert from "node:assert/strict";

import { runCandidates } from "../../src/candidates/runner.js";
import { atrSeries } from "../../src/compute/indicators.js";
import { runPaper } from "../../src/paper/engine.js";
import { PAPER_SETTINGS } from "../../src/paper/settings.js";
import { hasSqlite, openDb } from "../../src/server/db.js";
import { receiveBatch, scenario } from "../candidates/support.js";
import { withDir } from "../server/helpers.js";

const skip = hasSqlite ? false : "이 Node에는 node:sqlite 가 없음(22.13+ 필요)";
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

// 시나리오: 급증 08-10(idx70) → 확인 08-13(73) → 돌파 신호 08-16(76, 종가 110) → 진입 08-17(77) → 박스(104) 아래 마감 → 08-18 시가 청산
const SIGNAL_DAY = "2026-08-16";
const LIVE = new Date("2026-08-16T22:00:00Z"); // 신호 당일 밤에 기록 = 실시간

// 계산을 단순하게: 계좌 1,000만 원 = 환율 1,000 에서 $10,000, 정수 주식 (= 달러 계좌 시절과 같은 수량 9주)
const S = { ...PAPER_SETTINGS, startEquityKrw: 10_000_000, allowFractional: false };

/** 08-01 ~ 08-31 매일의 환율. fxFrom 날짜부터 다른 값. */
function seedRates(db, { before = 1000, after = 1010, from = "2026-08-18" } = {}) {
  for (let d = 1; d <= 31; d += 1) {
    const date = `2026-08-${String(d).padStart(2, "0")}`;
    db.prepare("INSERT INTO fx_rates (date, usdkrw, source, fetched_at) VALUES (?,?,'TEST','x')").run(date, date >= from ? after : before);
  }
}

async function prepare(root, bars, { recordedAt = LIVE, rates = {} } = {}) {
  const paths = await receiveBatch(root, "2026-11-03-backfill", { mode: "backfill", symbols: ["AAA"], barsFor: () => bars });
  const db = openDb(paths.dbFile);
  runCandidates(db, { now: recordedAt });
  if (rates !== null) seedRates(db, rates);
  return db;
}

test("돌파 신호 → 다음 날 시가 진입 → 박스 아래 마감 → 그다음 날 시가 청산, 원화 장부를 손으로 계산한 값과 대조", { skip }, async () => {
  await withDir(async (root) => {
    const bars = scenario({ surgeAt: 70, breakoutAt: 76 });
    const db = await prepare(root, bars); // 진입일 환율 1,000 → 청산일 1,010
    const summary = runPaper(db, { now: LIVE, startAfterDate: SIGNAL_DAY, s: S });

    const atrRef = atrSeries(bars)[75];
    const stop = 100.5 - 0.2 * atrRef;
    const entry = 101 * 1.001; // 08-17 시가 101 + 슬리피지 10bp
    const exit = 101 * 0.999; // 08-18 시가 101 − 슬리피지
    const cost = 9 * entry * 1000 * 1.002; // 수량 × 진입가 × 진입일 환율 × (1 + 환전비용 10bp + 거래 수수료 10bp(가정값))
    const proceeds = 9 * exit * 1010 * 0.998; // 수량 × 청산가 × 청산일 환율 × (1 − 환전비용 − 거래 수수료)

    const order = db.prepare("SELECT * FROM paper_orders").get();
    assert.equal(order.status, "FILLED");
    assert.equal(order.signal_close, 110);
    near(order.atr_ref, atrRef);

    const trade = db.prepare("SELECT * FROM paper_trades").get();
    assert.equal(trade.entry_date, "2026-08-17");
    near(trade.entry_price, entry);
    near(trade.initial_stop, stop);
    assert.equal(trade.qty, 9); // 위험 기준은 수십 주, 비중 상한 $1,000/101.101 = 9.89 → 정수 9주
    near(trade.fx_entry, 1000);
    near(trade.cost_krw, cost);

    assert.equal(trade.status, "CLOSED");
    assert.equal(trade.exit_date, "2026-08-18");
    assert.equal(trade.exit_reason, "BELOW_BOX"); // 08-17 종가 101 < 박스 상단 104
    near(trade.exit_price, exit);
    near(trade.fx_exit, 1010);
    near(trade.proceeds_krw, proceeds);
    near(trade.pnl_krw, proceeds - cost); // 회수금 − 매입금
    near(trade.return_krw, (proceeds - cost) / cost);
    near(trade.return_usd, exit / entry - 1); // 주가 수익률
    near(trade.fx_effect, 0.01); // 1000 → 1010
    near(trade.r_multiple, (exit - entry) / (entry - stop)); // R 배수는 주가 기준

    const state = db.prepare("SELECT * FROM paper_state").get();
    near(state.cash, 10_000_000 - cost + proceeds);
    assert.equal(state.last_date, "2026-08-29");
    const equityRows = db.prepare("SELECT * FROM paper_equity ORDER BY date").all();
    assert.equal(equityRows.length, 13); // 08-17 ~ 08-29
    near(equityRows[0].fx, 1000);
    near(equityRows.at(-1).equity, state.cash); // 보유 없음 → 평가액 = 현금
    assert.equal(summary.fills.length, 1);
    assert.equal(summary.exits.length, 1);
    db.close();
  });
});

test("종가가 손절선 아래로 마감하면 다음 날 시가에 청산한다 — 갭하락이면 손절가가 아니라 시가 (낙관하지 않는다)", { skip }, async () => {
  await withDir(async (root) => {
    const bars = scenario({ surgeAt: 70, breakoutAt: 76 });
    bars[77] = { ...bars[77], o: 101, h: 101.5, l: 90, c: 92 }; // 진입일(08-17): 손절선 아래로 마감
    bars[78] = { ...bars[78], o: 85, h: 86, l: 84, c: 85 }; // 다음 날 갭하락 시가 85
    const db = await prepare(root, bars, { rates: { before: 1000, after: 1000 } });
    runPaper(db, { now: LIVE, startAfterDate: SIGNAL_DAY, s: S });

    const trade = db.prepare("SELECT * FROM paper_trades").get();
    assert.equal(trade.exit_reason, "STOP"); // 종가 92 < 박스 상단 104 이기도 하지만 손절이 먼저
    assert.equal(trade.exit_date, "2026-08-18");
    near(trade.exit_price, 85 * 0.999); // 손절가(약 100)가 아니라 갭하락한 시가
    assert.ok(trade.initial_stop > 95, "손절선은 85 보다 한참 위에 있었다");
    assert.ok(trade.r_multiple < -1, "손절선보다 더 잃었다 — 갭 손실이 기록에 남는다");
    db.close();
  });
});

test("장중에 손절선을 찍었어도 종가가 위면 청산하지 않는다", { skip }, async () => {
  await withDir(async (root) => {
    const bars = scenario({ surgeAt: 70, breakoutAt: 76 });
    bars[77] = { ...bars[77], o: 101, h: 105, l: 90, c: 105 }; // 장중 90 까지 빠졌지만 박스 상단(104) 위로 마감
    const db = await prepare(root, bars);
    runPaper(db, { now: LIVE, startAfterDate: SIGNAL_DAY, s: S });
    const trade = db.prepare("SELECT * FROM paper_trades").get();
    assert.notEqual(trade.exit_date, "2026-08-18", "08-18 시가에 청산되면 안 된다");
    db.close();
  });
});

test("거래 수수료는 토스에서 읽어 둔 요율표의 그 날짜 값을 쓰고, 해당 줄이 없으면 가정값을 쓴다", { skip }, async () => {
  await withDir(async (root) => {
    const bars = scenario({ surgeAt: 70, breakoutAt: 76 });
    // ① 요율표 30bp(0.3%)가 진입·청산 날짜에 모두 적용 → 환전 10bp + 수수료 30bp = 한쪽 40bp
    const db = await prepare(root, bars, { rates: { before: 1000, after: 1000 } });
    db.prepare("INSERT INTO broker_rules (kind, payload, fetched_at) VALUES ('commissions', ?, 'x')")
      .run(JSON.stringify([{ marketCountry: "US", commissionRate: "0.003", startDate: null, endDate: "9999-12-31" }]));
    runPaper(db, { now: LIVE, startAfterDate: SIGNAL_DAY, s: S });
    const trade = db.prepare("SELECT * FROM paper_trades").get();
    near(trade.cost_krw, 9 * trade.entry_price * 1000 * 1.004);
    near(trade.proceeds_krw, 9 * trade.exit_price * 1000 * 0.996);
    db.close();
  });

  await withDir(async (root) => {
    // ② 요율표의 기간이 끝나 그 날짜에 해당하는 줄이 없으면 어림하지 않고 가정값(10bp)
    const db = await prepare(root, scenario({ surgeAt: 70, breakoutAt: 76 }), { rates: { before: 1000, after: 1000 } });
    db.prepare("INSERT INTO broker_rules (kind, payload, fetched_at) VALUES ('commissions', ?, 'x')")
      .run(JSON.stringify([{ marketCountry: "US", commissionRate: "0.009", startDate: null, endDate: "2026-08-01" }]));
    runPaper(db, { now: LIVE, startAfterDate: SIGNAL_DAY, s: S });
    const trade = db.prepare("SELECT * FROM paper_trades").get();
    near(trade.cost_krw, 9 * trade.entry_price * 1000 * 1.002);
    db.close();
  });
});

test("달러로는 이익인데 환율이 떨어지면 원화로는 손실이다 — 원화 손익은 달러 손익 × 환율이 아니다", { skip }, async () => {
  await withDir(async (root) => {
    const bars = scenario({ surgeAt: 70, breakoutAt: 76 });
    bars[78] = { ...bars[78], o: 105, h: 106, l: 104.5, c: 105 }; // 08-18 시가 105 에 청산 → 주가는 오른 상태
    const db = await prepare(root, bars, { rates: { before: 1000, after: 950 } }); // 환율 −5%
    runPaper(db, { now: LIVE, startAfterDate: SIGNAL_DAY, s: S });

    const trade = db.prepare("SELECT * FROM paper_trades").get();
    assert.ok(trade.return_usd > 0.03, "주가 수익률은 약 +3.75%");
    assert.ok(trade.pnl > 0, "달러 손익은 이익");
    assert.ok(trade.r_multiple > 0);
    near(trade.fx_effect, -0.05);
    assert.ok(trade.pnl_krw < 0, "그런데 원화 손익은 손실");
    assert.ok(trade.return_krw < 0);
    // 잘못된 근사(달러 손익 × 오늘 환율)는 이익으로 나와 부호가 뒤집힌다
    assert.ok(trade.pnl * 950 > 0);
    db.close();
  });
});

test("환율이 없으면 다른 값으로 채우지 않고 멈추며, 그 실행의 기록은 되돌려진다", { skip }, async () => {
  await withDir(async (root) => {
    const db = await prepare(root, scenario({ surgeAt: 70, breakoutAt: 76 }), { rates: null });
    assert.throws(() => runPaper(db, { now: LIVE, startAfterDate: SIGNAL_DAY, s: S }), /환율이 없습니다/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM paper_trades").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM paper_state").get().n, 0);
    db.close();
  });
});

test("다시 실행해도 주문·체결·청산이 중복되지 않는다 (멱등)", { skip }, async () => {
  await withDir(async (root) => {
    const db = await prepare(root, scenario({ surgeAt: 70, breakoutAt: 76 }));
    runPaper(db, { now: LIVE, startAfterDate: SIGNAL_DAY, s: S });
    const again = runPaper(db, { now: LIVE, startAfterDate: SIGNAL_DAY, s: S });
    assert.deepEqual([again.orders.length, again.fills.length, again.exits.length, again.processedDates.length], [0, 0, 0, 0]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM paper_trades").get().n, 1);
    db.close();
  });
});

test("소수점 주문 가정이면 100만 원 계좌도 비싼 종목을 소수 수량으로 산다", { skip }, async () => {
  await withDir(async (root) => {
    const db = await prepare(root, scenario({ surgeAt: 70, breakoutAt: 76 }));
    runPaper(db, { now: LIVE, startAfterDate: SIGNAL_DAY }); // 기본 설정: 100만 원, 소수점 허용
    const trade = db.prepare("SELECT * FROM paper_trades").get();
    // 계좌 100만 원 ÷ 환율 1,000 = $1,000 → 비중 상한 10% = $100 → 100 / 101.101 = 0.9891 주
    near(trade.qty, 0.9891, 1e-9);
    assert.ok(trade.cost_krw < 100_000 * 1.01 && trade.cost_krw > 99_000);
    db.close();
  });
});

test("소급 기록된 돌파 신호로는 진입하지 않는다", { skip }, async () => {
  await withDir(async (root) => {
    const db = await prepare(root, scenario({ surgeAt: 70, breakoutAt: 76 }), { recordedAt: new Date("2026-10-01T00:00:00Z") });
    runPaper(db, { now: LIVE, startAfterDate: SIGNAL_DAY, s: S });
    assert.equal(db.prepare("SELECT status FROM paper_orders").get().status, "IGNORED_RETRO");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM paper_trades").get().n, 0);
    db.close();
  });
});

test("다음 날 시가가 신호 종가 + 0.5 ATR 보다 높게 갭상승하면 건너뛴다 (후보는 그대로)", { skip }, async () => {
  await withDir(async (root) => {
    const bars = scenario({ surgeAt: 70, breakoutAt: 76 });
    bars[77] = { ...bars[77], o: 120, h: 121, l: 119, c: 120 };
    const db = await prepare(root, bars);
    runPaper(db, { now: LIVE, startAfterDate: SIGNAL_DAY, s: S });
    const order = db.prepare("SELECT * FROM paper_orders").get();
    assert.equal(order.status, "SKIPPED");
    assert.equal(order.reason, "GAP");
    assert.equal(db.prepare("SELECT state FROM candidates").get().state, "BROKE_OUT");
    db.close();
  });
});

test("앱에서 금액주문이 안 된다고 기록한 종목은 건너뛰고, OK 로 고치면 다시 살 수 있다", { skip }, async () => {
  await withDir(async (root) => {
    const db = await prepare(root, scenario({ surgeAt: 70, breakoutAt: 76 }));
    db.prepare("INSERT INTO fractional_checks (ticker, result, source, note, checked_at) VALUES ('AAA','NO','APP',NULL,'x')").run();
    runPaper(db, { now: LIVE, startAfterDate: SIGNAL_DAY });
    const order = db.prepare("SELECT * FROM paper_orders").get();
    assert.equal(order.status, "SKIPPED");
    assert.equal(order.reason, "NOT_ELIGIBLE");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM paper_trades").get().n, 0);
    db.close();
  });
});

test("기록이 없는 종목은 가능하다고 가정하고 산다 (낙관적인 가정이라 기록으로 줄여 간다)", { skip }, async () => {
  await withDir(async (root) => {
    const db = await prepare(root, scenario({ surgeAt: 70, breakoutAt: 76 }));
    runPaper(db, { now: LIVE, startAfterDate: SIGNAL_DAY });
    assert.equal(db.prepare("SELECT status FROM paper_orders").get().status, "FILLED");
    db.close();
  });
});

test("동시 보유 상한을 넘으면 건너뛴다", { skip }, async () => {
  await withDir(async (root) => {
    const db = await prepare(root, scenario({ surgeAt: 70, breakoutAt: 76 }));
    runPaper(db, { now: LIVE, startAfterDate: SIGNAL_DAY, s: { ...S, maxPositions: 0 } });
    assert.equal(db.prepare("SELECT reason FROM paper_orders").get().reason, "MAX_POSITIONS");
    db.close();
  });
});

test("첫 실행은 마지막 봉 날짜부터 시작하고, 과거 날짜는 처리하지 않는다 (환율도 필요 없다)", { skip }, async () => {
  await withDir(async (root) => {
    const db = await prepare(root, scenario({ surgeAt: 70, breakoutAt: 76 }), { rates: null });
    const summary = runPaper(db, { now: LIVE, s: S });
    assert.deepEqual(summary.processedDates, []);
    const state = db.prepare("SELECT * FROM paper_state").get();
    assert.equal(state.last_date, "2026-08-29");
    near(state.cash, 10_000_000);
    db.close();
  });
});
