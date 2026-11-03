import test from "node:test";
import assert from "node:assert/strict";

import { BREADTH, computeBreadth } from "../../src/compute/breadth.js";

// 90 거래일짜리 평평한 봉. spikeAt 위치에서만 거래량이 5배
const dateOf = (i) => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
const bars = (spikeAt = null) =>
  Array.from({ length: 90 }, (_, i) => ({ date: dateOf(i), o: 10, h: 10.2, l: 9.8, c: 10, v: i === spikeAt ? 5000 : 1000 }));
const market = (spikes) => new Map(spikes.map((spikeAt, k) => [`T${k}`, bars(spikeAt)]));

test("날짜별로 평가 종목 수·급증 종목 수·비율을 센다", () => {
  const rows = computeBreadth(market([85, null, null, null, null, null, null, null, null, null]));
  const day85 = rows.find((r) => r.date === dateOf(85));
  assert.equal(day85.evaluated, 10);
  assert.equal(day85.surge, 1);
  assert.equal(day85.ratio, 0.1);
  assert.equal(day85.allPass, 0); // 거래대금 1,000만 달러 조건에 못 미친다
  assert.equal(rows.find((r) => r.date === dateOf(80)).surge, 0);
});

test("급증 비율이 기준(8%) 이상인 날만 «시장 전체 급증일»", () => {
  const rows = computeBreadth(market([85, null, null, null, null, null, null, null, null, null])); // 10%
  assert.equal(rows.find((r) => r.date === dateOf(85)).marketWide, true);
  assert.equal(rows.find((r) => r.date === dateOf(84)).marketWide, false);
  const few = computeBreadth(market([85, null, null, null, null, null, null, null, null, null, null, null, null, null])); // 1/14 ≈ 7.1%
  assert.equal(few.find((r) => r.date === dateOf(85)).marketWide, false);
  assert.equal(BREADTH.marketWideRatio, 0.08);
});

test("rvolWindow(60) 이전 날짜는 평가하지 않고, 짧은 종목·제외 종목은 세지 않는다", () => {
  const m = market([85, null]);
  m.set("SHORT", bars(85).slice(0, 50)); // minBars(80) 미만
  m.set("SPLIT", bars(85));
  const rows = computeBreadth(m, new Set(["SPLIT"]));
  assert.equal(rows[0].date, dateOf(60));
  assert.equal(rows.find((r) => r.date === dateOf(85)).evaluated, 2); // T0, T1 만
});
