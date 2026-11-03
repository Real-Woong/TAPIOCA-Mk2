import test from "node:test";
import assert from "node:assert/strict";

import { dryUpOf, replayTicker } from "../../src/candidates/replay.js";
import { STATES } from "../../src/candidates/step.js";
import { scenario } from "./support.js";

const types = (entry) => entry.events.map((e) => e.type);

test("급증 → 3일 확인 → 박스 확정 → 돌파까지 한 번에 따라간다", () => {
  const bars = scenario({ surgeAt: 70, breakoutAt: 76 });
  const results = replayTicker("AAA", bars);
  assert.equal(results.length, 1);
  const { candidate, events } = results[0];
  assert.deepEqual(types(results[0]), ["DISCOVERED", "CONFIRMED", "BREAKOUT"]);
  assert.equal(candidate.state, STATES.BROKE_OUT);
  assert.equal(candidate.id, "AAA|2026-08-10|ver2-v1"); // 06-01 + 70일
  assert.equal(events[0].date, bars[70].date);
  assert.equal(events[1].date, bars[73].date); // 급증 +3거래일
  assert.equal(events[1].boxTop, 104); // 급증일 고가 104 가 최고, 확인 구간 고가 103 은 더 낮음
  assert.equal(events[2].date, bars[76].date);
});

test("발견 사건에는 그날의 지표 값이 남는다", () => {
  const [found] = replayTicker("AAA", scenario({ surgeAt: 70 }))[0].events;
  assert.equal(found.rvol, 4);
  assert.ok(Math.abs(found.return20 - 0.025) < 1e-9);
  assert.equal(found.clv, 0.625);
});

test("확인 기간이 아직 안 끝났으면 «확인 중»으로 남는다 (미래 봉을 쓰지 않는다)", () => {
  const results = replayTicker("AAA", scenario({ n: 72, surgeAt: 70 })); // 급증 뒤 봉이 1개
  assert.equal(results[0].candidate.state, STATES.CONFIRMING);
  assert.deepEqual(types(results[0]), ["DISCOVERED"]);
});

test("확인 뒤 돌파가 없으면 10거래일 후 만료", () => {
  const results = replayTicker("AAA", scenario({ n: 90, surgeAt: 70 })); // 73 확인, 83 만료
  assert.deepEqual(types(results[0]), ["DISCOVERED", "CONFIRMED", "EXPIRED"]);
  assert.equal(results[0].events[2].date, scenario()[83].date);
});

test("급증일 저가 밑으로 내려가면 무효", () => {
  const results = replayTicker("AAA", scenario({ surgeAt: 70, brokenLowAt: 72 }));
  assert.deepEqual(types(results[0]), ["DISCOVERED", "INVALIDATED"]);
});

test("진행 중인 후보가 있는 동안의 반복 급증은 새 후보를 만들지 않는다", () => {
  const results = replayTicker("AAA", scenario({ surgeAt: 70, extraSurgeAt: 72 }));
  assert.equal(results.length, 1);
});

test("후보가 끝난 뒤의 급증은 새 후보가 된다", () => {
  // 70 급증 → 83 만료 → 85 에서 다시 급증 (평균에 첫 급증이 들어가도 RVOL 3 이상)
  const bars = scenario({ n: 90, surgeAt: 70 });
  bars[85] = { ...bars[85], v: 900_000, c: 102.5, h: 104, l: 100 };
  const results = replayTicker("AAA", bars);
  assert.equal(results.length, 2);
  assert.notEqual(results[0].candidate.id, results[1].candidate.id);
});

test("봉이 80개 미만이어도 replay 자체는 계산하지만, 급증 판정은 60봉 뒤부터다", () => {
  assert.deepEqual(replayTicker("AAA", scenario({ n: 90, surgeAt: 40 })), []);
});

test("DryUp: 확인 3일 평균 거래량 ÷ 급증 전 20일 평균 거래량 (급증일 거래량과 비교하지 않는다)", () => {
  const bars = scenario({ surgeAt: 70 });
  assert.equal(dryUpOf(bars, 70), 1); // 100,000 / 100,000
  bars[71].v = bars[72].v = bars[73].v = 50_000;
  assert.equal(dryUpOf(bars, 70), 0.5);
  assert.equal(dryUpOf(bars, 89), null); // 확인 3일이 아직 없다
});
