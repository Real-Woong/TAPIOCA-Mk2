import test from "node:test";
import assert from "node:assert/strict";

import { fillPrice, floorQty, initialStopOf, isGapSkipped, onOpen, onSession, positionSize } from "../../src/paper/rules.js";
import { PAPER_SETTINGS } from "../../src/paper/settings.js";

const WHOLE = { ...PAPER_SETTINGS, allowFractional: false };

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

// 기본 포지션: 100 에 샀고, 초기 손절 95 → 1R = 5, 박스 상단 98
const pos = (extra = {}) => ({
  entryPrice: 100, initialStop: 95, stop: 95, r: 5, boxTop: 98, highestClose: null, barsHeld: 0, reached1R: false, pendingExit: null, ...extra,
});
const bar = (o, h, l, c) => ({ o, h, l, c });

test("초기 손절 = 급증 다음 3거래일 최저가 − 0.2 ATR", () => {
  const bars = [{ l: 1 }, { l: 10 }, { l: 9 }, { l: 11 }, { l: 5 }];
  near(initialStopOf(bars, 0, 2), 9 - 0.4); // 급증일(0) 이후 3일 = 10, 9, 11 → 최저 9. 4번째(5)는 안 본다
  assert.equal(initialStopOf(bars, 3, 2), null); // 이후 봉이 3개 미만
  assert.equal(initialStopOf(bars, 0, null), null);
});

test("수량(정수 주식): 위험 기준과 비중 상한 중 작은 쪽, 내림", () => {
  // 계좌 $10,000 → 위험 $50, 비중 상한 $1,000
  const q = (entry, stop) => positionSize({ equity: 10_000, entry, stop, s: WHOLE });
  assert.equal(q(100, 95), 10); // 위험 50/5=10, 상한 1000/100=10
  assert.equal(q(100, 90), 5); // 위험 50/10=5 가 더 작다
  assert.equal(q(100, 99), 10); // 위험 50 → 상한 10 이 더 작다
  assert.equal(q(1500, 1400), 0); // 위험 0.5 → 내림 0
  assert.equal(q(100, 100), 0); // 손절이 진입가 이상
});

test("수량(소수점 주문 가정): 소수 4자리까지 내림 — 올림하지 않는다", () => {
  // 위험 50/(1400→1500 의 100) = 0.5 주, 상한 1000/1500 = 0.6667 → 작은 쪽 0.5
  assert.equal(positionSize({ equity: 10_000, entry: 1500, stop: 1400 }), 0.5);
  // 상한이 작은 쪽: 1000/101.101 = 9.89109… → 소수 4자리 내림 9.891
  assert.equal(positionSize({ equity: 10_000, entry: 101.101, stop: 99.8 }), 9.891);
  assert.equal(floorQty(0.99999), 0.9999);
  assert.equal(floorQty(0), 0);
  assert.equal(floorQty(2.7, WHOLE), 2);
});

test("갭 제한: 시가가 신호 종가 + 0.5 ATR «초과»일 때만 건너뛴다", () => {
  assert.equal(isGapSkipped({ open: 112, signalClose: 110, atrRef: 4 }), false); // 정확히 같다
  assert.equal(isGapSkipped({ open: 112.01, signalClose: 110, atrRef: 4 }), true);
  assert.equal(isGapSkipped({ open: 130, signalClose: 110, atrRef: null }), false);
});

test("슬리피지: 매수는 비싸게, 매도는 싸게", () => {
  near(fillPrice(100, "BUY"), 100.1);
  near(fillPrice(100, "SELL"), 99.9);
});

test("장 시작: 예약된 청산만 시가에 체결", () => {
  assert.equal(onOpen(pos(), bar(100, 101, 99, 100)), null);
  assert.deepEqual(onOpen(pos({ pendingExit: "BELOW_BOX" }), bar(97, 98, 96, 97)), { reason: "BELOW_BOX", price: 97 });
});

test("장중에 손절선을 찍어도 종가가 위면 보유한다 (청산 예약 없음)", () => {
  const r = onSession(pos(), bar(99, 100, 94, 99), 1); // 저가 94 < 손절 95 이지만 종가 99 (박스 상단 98 위)
  assert.equal(r.exit, null);
  assert.equal(r.position.pendingExit, null);
  assert.equal(r.position.barsHeld, 1);
});

test("종가가 손절선 이하면 오늘 청산하지 않고 내일 시가 청산을 예약한다", () => {
  const r = onSession(pos(), bar(99, 100, 93, 95), 1); // 종가 95 = 손절선 → «이하»
  assert.equal(r.exit, null);
  assert.equal(r.position.pendingExit, "STOP");
  assert.equal(onSession(pos(), bar(99, 100, 93, 94.9), 1).position.pendingExit, "STOP");
});

test("추적 손절선 이하 마감이면 사유가 TRAIL_STOP", () => {
  const r = onSession(pos({ stop: 100 }), bar(101, 102, 99, 99.5), 1);
  assert.equal(r.position.pendingExit, "TRAIL_STOP");
});

test("손절과 박스 이탈이 겹치면 손절이 먼저 (사유 STOP)", () => {
  // 종가 94 < 손절 95 이고 < 박스 상단 98 도 만족
  assert.equal(onSession(pos(), bar(97, 97, 93, 94), 1).position.pendingExit, "STOP");
});

test("손절 예약된 날은 시가에 청산 — 손절선 아래로 갭하락하면 시가 그대로 (손절가가 아니다)", () => {
  const reserved = onSession(pos(), bar(99, 100, 93, 94), 1).position;
  assert.deepEqual(onOpen(reserved, bar(88, 90, 87, 89)), { reason: "STOP", price: 88 });
});

test("조용한 상승일: 최고 종가·추적 손절선이 오르고, 아직 +1R 은 아님", () => {
  const { position, exit } = onSession(pos(), bar(100, 104, 99, 103), 1);
  assert.equal(exit, null);
  assert.equal(position.barsHeld, 1);
  assert.equal(position.highestClose, 103);
  assert.equal(position.stop, 100); // 103 − 3×1
  assert.equal(position.reached1R, false); // 103 < 105
  assert.equal(position.pendingExit, null);
});

test("종가가 +1R(진입가 + R) 이상이면 도달로 기록", () => {
  assert.equal(onSession(pos(), bar(100, 107, 100, 105), 1).position.reached1R, true);
});

test("손절선은 내려가지 않는다", () => {
  const r = onSession(pos({ stop: 100, highestClose: 103 }), bar(101, 102, 100.5, 101), 2); // 103 − 6 = 97 < 100
  assert.equal(r.position.stop, 100);
});

test("ATR 을 모르면 추적 손절선을 갱신하지 않는다", () => {
  assert.equal(onSession(pos(), bar(100, 104, 99, 103), null).position.stop, 95);
});

test("종가가 박스 상단 아래면 내일 시가 청산을 예약 (오늘 청산하지 않는다)", () => {
  const r = onSession(pos(), bar(99, 99.5, 96, 97), null);
  assert.equal(r.exit, null);
  assert.equal(r.position.pendingExit, "BELOW_BOX");
});

test("10거래일 동안 +1R 에 못 닿으면 시간 청산 예약, 닿았으면 예약하지 않는다", () => {
  const slow = onSession(pos({ barsHeld: 9 }), bar(101, 103, 100, 102), 1);
  assert.equal(slow.position.barsHeld, 10);
  assert.equal(slow.position.pendingExit, "TIME");
  const reached = onSession(pos({ barsHeld: 9 }), bar(104, 107, 104, 106), 1);
  assert.equal(reached.position.pendingExit, null);
  const earlier = onSession(pos({ barsHeld: 5 }), bar(101, 103, 100, 102), 1);
  assert.equal(earlier.position.pendingExit, null); // 아직 10일 전
});

test("박스 이탈과 시간 청산이 겹치면 박스 이탈이 먼저", () => {
  assert.equal(onSession(pos({ barsHeld: 9 }), bar(99, 99, 96, 97), 1).position.pendingExit, "BELOW_BOX");
});

test("원본 포지션은 고쳐지지 않는다", () => {
  const p = pos();
  onSession(p, bar(100, 104, 99, 103), 1);
  assert.equal(p.barsHeld, 0);
  assert.equal(p.highestClose, null);
});
