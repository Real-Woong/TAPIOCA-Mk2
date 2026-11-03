import test from "node:test";
import assert from "node:assert/strict";

import { addvN, atrSeries, clv, evaluateDay, rangeN, returnN, rvol, trueRange } from "../../src/compute/indicators.js";
import { SETTINGS } from "../../src/compute/settings.js";
import { scan } from "../../src/compute/scan.js";

const near = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) < eps, `${actual} ≉ ${expected}`);
const mk = (n, f) => Array.from({ length: n }, (_, i) => ({ date: `d${String(i).padStart(3, "0")}`, o: 10, h: 11, l: 9, c: 10, v: 100, ...f(i) }));

test("RVOL: 직전 60일 평균과 비교하고 급증일 자신은 평균에서 뺀다", () => {
  const bars = mk(61, (i) => ({ v: i === 60 ? 400 : 100 }));
  near(rvol(bars, 60), 4); // 400 / 100
  // 급증일 «다음 날»에 계산하면 평균에 급증일이 들어가므로 값이 달라진다
  const next = [...bars, { ...bars[0], date: "d061", v: 400 }];
  near(rvol(next, 61), 400 / ((59 * 100 + 400) / 60));
});

test("RVOL: 과거 봉이 60개 미만이거나 평균 거래량이 0이면 null", () => {
  assert.equal(rvol(mk(60, () => ({})), 59), null);
  assert.equal(rvol(mk(61, (i) => ({ v: i === 60 ? 5 : 0 })), 60), null);
});

test("Return20: C(t0)/C(t0-20) − 1", () => {
  const bars = mk(21, (i) => ({ c: i === 0 ? 100 : i === 20 ? 110 : 105, h: 120, l: 90 }));
  near(returnN(bars, 20), 0.1);
  assert.equal(returnN(bars, 19), null);
});

test("Range20: 20봉 최고가/최저가 − 1, 20봉 밖의 극값은 무시", () => {
  const bars = mk(25, (i) => ({ h: i === 3 ? 99 : i === 10 ? 12 : 11, l: i === 15 ? 10 : 10.5 }));
  // i = 24 → 창은 5…24. i=3 의 99 는 밖. 최고 12, 최저 10 → 0.2
  near(rangeN(bars, 24), 0.2);
  assert.equal(rangeN(bars, 18), null);
});

test("CLV: (C−L)/(H−L), 고가=저가면 null", () => {
  near(clv([{ h: 12, l: 10, c: 11.5 }], 0), 0.75);
  near(clv([{ h: 12, l: 10, c: 10 }], 0), 0);
  assert.equal(clv([{ h: 10, l: 10, c: 10 }], 0), null);
});

test("ADDV20: 종가×거래량의 20일 평균(기준일 포함)", () => {
  const bars = mk(20, (i) => ({ c: 10, v: i === 19 ? 300 : 100 }));
  // (19 × 1000 + 3000) / 20 = 1100
  near(addvN(bars, 19), 1100);
  assert.equal(addvN(bars, 18), null);
});

test("TR은 갭을 포함한다 (전일 종가 대비)", () => {
  const bars = [{ h: 11, l: 9, c: 10 }, { h: 16, l: 14, c: 15 }];
  assert.equal(trueRange(bars, 1), 6); // |16 − 10| 이 H−L(2) 보다 크다
  assert.equal(trueRange(bars, 0), null);
});

test("ATR14: 첫 값은 TR 14개 평균, 이후는 Wilder 평활", () => {
  const bars = mk(16, () => ({})); // 매일 h11 l9 c10 → TR = 2
  const atr = atrSeries(bars);
  assert.equal(atr[13], null);
  near(atr[14], 2);
  bars[15] = { ...bars[15], h: 14 }; // TR = max(5, |14−10|, |9−10|) = 5
  near(atrSeries(bars)[15], (2 * 13 + 5) / 14);
});

test("evaluateDay: 조건 5개를 따로 판정하고 전부 통과해야 all", () => {
  // 61봉: 거래량 급증 + 횡보 + 윗꼬리 없는 상단 마감 + 충분한 거래대금
  const bars = mk(61, (i) => ({
    c: 100, h: i === 60 ? 104 : 102, l: i === 60 ? 100 : 98, v: i === 60 ? 400_000 : 100_000,
  }));
  bars[60].c = 102.5; // CLV = (102.5−100)/(104−100) = 0.625
  const day = evaluateDay(bars, 60);
  near(day.values.rvol, 4);
  near(day.values.return20, 0.025); // 102.5/100 − 1
  near(day.values.range20, 104 / 98 - 1);
  near(day.values.clv, 0.625);
  assert.equal(day.pass.rvol, true);
  assert.equal(day.pass.return20, true);
  assert.equal(day.pass.range20, true);
  assert.equal(day.pass.clv, true);
  assert.equal(day.pass.addv20, true); // (19 × $10M + $41M) / 20 = $11.55M
  assert.equal(day.all, true);

  const weak = bars.map((b) => ({ ...b }));
  weak[60].c = 100.5; // CLV 0.125
  assert.equal(evaluateDay(weak, 60).pass.clv, false);
  assert.equal(evaluateDay(weak, 60).all, false);
});

test("scan: 깔때기는 앞 조건을 통과한 건만 다음 칸에 센다, 봉이 적은 종목은 제외", () => {
  const spike = mk(SETTINGS.minBars, (i) => ({
    c: 100, h: i === 79 ? 104 : 102, l: i === 79 ? 100 : 98, v: i === 79 ? 400_000 : 100_000,
  }));
  spike[79].c = 102.5;
  const flat = mk(SETTINGS.minBars, () => ({ c: 100, h: 102, l: 98, v: 100_000 }));
  const result = scan(new Map([["SPK", spike], ["FLT", flat], ["NEW", spike.slice(0, 30)]]));
  assert.equal(result.tickersEvaluated, 2);
  assert.equal(result.tickersSkippedShort, 1);
  assert.equal(result.latestDate, "d079");
  assert.equal(result.funnelLatest.rvol, 1); // SPK 만
  assert.equal(result.funnelLatest.addv20, 1);
  assert.deepEqual(result.hitsLatest.map((h) => h.ticker), ["SPK"]);
  assert.equal(result.funnelAllDays.evaluated, 2 * (SETTINGS.minBars - SETTINGS.rvolWindow));
});

test("분할 의심 종목으로 넘겨받은 티커는 계산에서 뺀다", () => {
  const flat = mk(SETTINGS.minBars, () => ({}));
  const result = scan(new Map([["AXG", flat], ["OK", flat]]), SETTINGS, new Set(["AXG"]));
  assert.equal(result.tickersSkippedDiscontinuity, 1);
  assert.equal(result.tickersEvaluated, 1);
});
