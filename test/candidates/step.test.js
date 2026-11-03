import test from "node:test";
import assert from "node:assert/strict";

import { STATES, advance, newCandidate } from "../../src/candidates/step.js";

// 기본 시나리오: 급증일 저가 10, 최근 20일 최고가 12, ATR(전일) 1
const fresh = () => newCandidate({ ticker: "AAA", surgeBar: { date: "d0", l: 10 }, windowHigh: 12, strategyVersion: "v1" });
const bar = (date, l, h, c) => ({ date, l, h, c });
const CONFIRM_BARS = [bar("d1", 10.5, 11, 10.8), bar("d2", 10.2, 11.5, 11), bar("d3", 10.1, 12.5, 12)];

/** 확인 3일을 통과시킨 WAITING 후보 (박스 상단 B = 12.5) */
function confirmed() {
  let c = fresh();
  for (const b of CONFIRM_BARS) ({ candidate: c } = advance(c, b, 1));
  return c;
}

test("새 후보는 ID와 출발 상태를 갖는다", () => {
  const c = fresh();
  assert.equal(c.id, "AAA|d0|v1");
  assert.equal(c.state, STATES.CONFIRMING);
  assert.equal(c.boxTop, null);
  assert.equal(c.days, 0);
});

test("3일 저점을 지키면 확인되고, 확인 기간의 고가까지 박스에 들어간다", () => {
  let c = fresh();
  ({ candidate: c } = advance(c, CONFIRM_BARS[0], 1));
  ({ candidate: c } = advance(c, CONFIRM_BARS[1], 1));
  const r = advance(c, CONFIRM_BARS[2], 1);
  assert.equal(r.candidate.state, STATES.WAITING);
  assert.equal(r.candidate.boxTop, 12.5); // 출발값 12 가 아니라 확인 기간 최고가
  assert.equal(r.event.type, "CONFIRMED");
});

test("돌파는 B + 0.1×ATR 을 «초과»해야 한다 (같으면 아님)", () => {
  const c = confirmed(); // 기준선 = 12.5 + 0.1 × 1 = 12.6
  assert.equal(advance(c, bar("d4", 11, 13, 12.6), 1).event, null);
  const r = advance(c, bar("d5", 11, 13, 12.7), 1);
  assert.equal(r.candidate.state, STATES.BROKE_OUT);
  assert.equal(r.event.type, "BREAKOUT");
});

test("돌파일의 고가는 박스 상단에 들어가지 않는다", () => {
  const r = advance(confirmed(), bar("d4", 11, 99, 12.7), 1);
  assert.equal(r.candidate.boxTop, 12.5);
});

test("ATR 을 모르면 돌파 판정을 건너뛴다", () => {
  assert.equal(advance(confirmed(), bar("d4", 11, 99, 99), null).candidate.state, STATES.WAITING);
});

test("급증일 저가보다 낮은 저가가 나오면 무효", () => {
  const r = advance(fresh(), bar("d1", 9.9, 11, 10.5), 1);
  assert.equal(r.candidate.state, STATES.INVALID);
  assert.equal(r.event.reason, "SURGE_LOW_BROKEN");
});

test("저가가 급증일 저가와 «같은» 것은 무효가 아니다", () => {
  assert.equal(advance(fresh(), bar("d1", 10, 11, 10.5), 1).candidate.state, STATES.CONFIRMING);
});

test("저가 이탈은 같은 날 종가가 돌파여도 우선한다", () => {
  const r = advance(confirmed(), bar("d4", 9.5, 14, 14), 1);
  assert.equal(r.candidate.state, STATES.INVALID);
});

test("확인 뒤 10거래일 안에 돌파가 없으면 만료 (9일째까지는 대기)", () => {
  let c = confirmed();
  for (let k = 1; k <= 9; k += 1) {
    const r = advance(c, bar(`w${k}`, 11, 12, 12), 1);
    assert.equal(r.candidate.state, STATES.WAITING);
    c = r.candidate;
  }
  assert.equal(advance(c, bar("w10", 11, 12, 12), 1).candidate.state, STATES.EXPIRED);
});

test("10일째 돌파는 만료보다 우선한다", () => {
  let c = confirmed();
  for (let k = 1; k <= 9; k += 1) ({ candidate: c } = advance(c, bar(`w${k}`, 11, 12, 12), 1));
  assert.equal(advance(c, bar("w10", 11, 14, 13), 1).candidate.state, STATES.BROKE_OUT);
});

test("원본 후보는 고쳐지지 않는다", () => {
  const c = fresh();
  advance(c, CONFIRM_BARS[0], 1);
  assert.equal(c.days, 0);
});

test("끝난 후보는 더 이상 움직이지 않는다", () => {
  const dead = advance(fresh(), bar("d1", 9, 11, 10), 1).candidate;
  assert.deepEqual(advance(dead, bar("d2", 10, 20, 20), 1), { candidate: dead, event: null });
});
