import test from "node:test";
import assert from "node:assert/strict";

import { aggregate, compareBars, normalizeCandles } from "../../src/broker/candles-compare.js";

const candle = (timestamp, close, volume) => ({ timestamp, openPrice: String(close), highPrice: String(close + 1), lowPrice: String(close - 1), closePrice: String(close), volume: String(volume), currency: "USD" });

test("토스 응답(최신순)을 날짜 오름차순 봉으로 바꾸고, 이상한 줄은 버린다", () => {
  const bars = normalizeCandles({
    candles: [
      candle("2026-10-30T22:30:00.000+09:00", 12, 500),
      candle("2026-10-29T22:30:00.000+09:00", 10, 400),
      { timestamp: "이상", closePrice: "5" },
      { timestamp: "2026-10-28T22:30:00.000+09:00", closePrice: "0", openPrice: "1", highPrice: "1", lowPrice: "1", volume: "1" },
    ],
    nextBefore: "x",
  });
  assert.deepEqual(bars.map((b) => [b.date, b.c, b.v]), [["2026-10-29", 10, 400], ["2026-10-30", 12, 500]]);
  assert.deepEqual(normalizeCandles(null), []);
  assert.equal(normalizeCandles([candle("2026-10-30T00:00:00Z", 3, 1)]).length, 1); // 배열로 와도 읽는다
});

test("종가 차이와 거래량 비율을 같은 날짜끼리 비교한다", () => {
  const toss = normalizeCandles([candle("2026-10-29T22:30:00+09:00", 10.1, 440), candle("2026-10-30T22:30:00+09:00", 12, 500)]);
  const ours = [{ date: "2026-10-29", c: 10, v: 400 }, { date: "2026-10-30", c: 12, v: 500 }, { date: "2026-10-28", c: 9, v: 300 }];
  const r = compareBars(toss, ours);
  assert.equal(r.offsetDays, 0);
  assert.equal(r.matched, 2);
  assert.ok(Math.abs(r.closeDiffMax - 0.01) < 1e-9); // |10.1−10|/10
  assert.ok(Math.abs(r.volRatioMax - 1.1) < 1e-9);
  assert.equal(r.volRatioMin, 1);
});

test("토스 날짜가 하루 어긋나 있으면 자동으로 알아내고 어긋남을 알려 준다", () => {
  // 토스 timestamp 가 마감 시각(다음 날 새벽 한국 시간)이라 날짜가 +1일인 경우
  const toss = normalizeCandles([candle("2026-10-30T05:00:00+09:00", 10, 400), candle("2026-10-31T05:00:00+09:00", 12, 500)]);
  const ours = [{ date: "2026-10-29", c: 10, v: 400 }, { date: "2026-10-30", c: 12, v: 500 }];
  const r = compareBars(toss, ours);
  assert.equal(r.offsetDays, -1);
  assert.equal(r.matched, 2);
  assert.equal(r.closeDiffMax, 0);
});

test("겹치는 날짜가 없으면 matched 0 이고 숫자는 null — 억지로 맞추지 않는다", () => {
  const r = compareBars(normalizeCandles([candle("2026-01-01T00:00:00Z", 10, 1)]), [{ date: "2026-10-29", c: 10, v: 1 }]);
  assert.equal(r.matched, 0);
  assert.equal(r.closeDiffMax, null);
  assert.equal(r.volRatioMedian, null);
});

test("요약: 비교할 수 있는 종목만 중앙값으로 모은다", () => {
  const a = { matched: 5, closeDiffMedian: 0.001, closeDiffMax: 0.004, volRatioMedian: 1.0, offsetDays: 0 };
  const b = { matched: 5, closeDiffMedian: 0.003, closeDiffMax: 0.02, volRatioMedian: 1.2, offsetDays: 0 };
  const none = { matched: 0, closeDiffMedian: null, closeDiffMax: null, volRatioMedian: null, offsetDays: 0 };
  const s = aggregate([a, b, none]);
  assert.equal(s.tickers, 3);
  assert.equal(s.comparable, 2);
  assert.ok(Math.abs(s.closeDiffMedian - 0.002) < 1e-12);
  assert.equal(s.closeDiffWorst, 0.02);
  assert.ok(Math.abs(s.volRatioMedian - 1.1) < 1e-12);
});
