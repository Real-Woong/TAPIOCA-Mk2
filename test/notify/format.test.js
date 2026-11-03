import test from "node:test";
import assert from "node:assert/strict";

import { expectedAsOf, formatDailyReport, formatStartReport, formatWatchdog } from "../../src/notify/format.js";

const base = () => ({
  batch: { as_of: "2026-11-05", status: "COMPLETE", ok: 2790, requested: 2790, stale: 0 },
  events: [],
  retroCount: 0,
  paper: { fills: [], exits: [], skips: [], open: [], account: { equity: 1_005_000, cash: 900_000, start: 1_000_000 }, fx: 1400, closedCount: 0, avgR: 0, sumPnlKrw: 0 },
  counts: { CONFIRMING: 2, WAITING: 1 },
  waiting: [{ ticker: "AAA", box_top: 104, days: 5 }],
});

test("사건이 없으면 «할 일 없음» 한 줄로 끝나고, 계좌와 돌파 대기 목록만 붙는다", () => {
  const text = formatDailyReport(base());
  assert.match(text, /^TAPIoca 모의 · 11\/05 마감분\n오늘은 할 일 없음/);
  assert.match(text, /돌파 대기 1: AAA/);
  assert.match(text, /계좌 ₩1,005,000 \(\+0\.50%\) · 현금 ₩900,000/); // 장부는 원화
  assert.doesNotMatch(text, /RVOL|DryUp|환율|박스상단/); // 지표 숫자는 보고에서 뺐다
});

test("결론 한 줄에 오늘 할 일의 건수가 모이고, 매수 신호는 종가와 박스를 보여 준다", () => {
  const d = base();
  d.events = [{ type: "BREAKOUT", ticker: "AAA", detail: { close: 110, boxTop: 104 } }];
  const text = formatDailyReport(d);
  assert.match(text.split("\n")[1], /🔔 매수 신호 1건/);
  assert.match(text, /AAA\s+종가 \$110\.00 \(박스 \$104\.00 돌파\)/);
});

test("매수 신호에는 토스 장 일정이 있으면 다음 정규장 개장 시각(한국 시간)을 적는다", () => {
  const d = base();
  d.events = [{ type: "BREAKOUT", ticker: "AAA", detail: { close: 110, boxTop: 104 } }];
  assert.match(formatDailyReport(d), /매수 신호 — 내일 시가에 모의 진입/); // 일정이 없으면 기존 문구
  d.nextOpen = "11/02 23:30";
  assert.match(formatDailyReport(d), /매수 신호 — 11\/02 23:30 정규장 개장에 모의 진입 \(한국 시간\)/);
});

test("매수 신호 종목마다 금액주문 가능 여부 기록을 보여 주고, 모르면 확인 방법을 안내한다", () => {
  const d = base();
  d.events = [
    { type: "BREAKOUT", ticker: "AAA", detail: { close: 110, boxTop: 104 } },
    { type: "BREAKOUT", ticker: "BBB", detail: { close: 20, boxTop: 19 } },
    { type: "BREAKOUT", ticker: "CCC", detail: { close: 30, boxTop: 29 } },
  ];
  d.fractional = { AAA: "OK", BBB: "NO", CCC: null };
  const text = formatDailyReport(d);
  assert.match(text, /AAA.*· 금액주문 가능/);
  assert.match(text, /BBB.*· 금액주문 불가/);
  assert.match(text, /CCC.*· 금액주문 확인 필요/);
  assert.match(text, /npm run fractional -- 종목 ok\|no/);
  d.fractional = { AAA: "OK", BBB: "NO", CCC: "OK" }; // 전부 알면 안내 줄은 없다
  assert.doesNotMatch(formatDailyReport(d), /npm run fractional/);
});

test("후보 사건은 이름만 한 줄로 줄이고, 종료는 건수만 센다", () => {
  const d = base();
  d.events = [
    { type: "CONFIRMED", ticker: "BBB", detail: { boxTop: 50 } },
    { type: "DISCOVERED", ticker: "CCC", detail: {} },
    { type: "DISCOVERED", ticker: "CCD", detail: {} },
    { type: "INVALIDATED", ticker: "DDD", detail: {} },
    { type: "EXPIRED", ticker: "EEE", detail: {} },
  ];
  const text = formatDailyReport(d);
  assert.match(text, /새 후보 2: CCC CCD/);
  assert.match(text, /3일 확인 통과 1: BBB/);
  assert.match(text, /종료 2건/);
  assert.doesNotMatch(text, /DDD|EEE/);
});

test("모의 체결·청산·건너뜀: 원화 금액과 사람 말 사유로 보여 준다", () => {
  const d = base();
  d.paper.fills = [{ ticker: "AAA", cost_krw: 140_000, initial_stop: 99.8 }];
  d.paper.exits = [{ ticker: "BBB", exit_reason: "STOP", pnl_krw: -12_500, return_krw: -0.0312 }];
  d.paper.skips = [{ ticker: "CCC", reason: "GAP" }];
  d.paper.open = [{ ticker: "AAA", qty: 0.9891, entry_price: 101.1, stop: 99.8, last_close: 103, cost_krw: 140_000, pending_exit: null }];
  const text = formatDailyReport(d);
  assert.match(text, /🟢 모의 매수 AAA\s+₩140,000어치 · 손절 \$99\.80/);
  assert.match(text, /🔴 청산 BBB\s+-₩12,500 \(-3\.1%\) · 손절/);
  assert.match(text, /건너뜀 CCC\s+시가가 너무 높음/);
  assert.match(text, /^TAPIoca[^\n]*\n청산 1건 · 모의 매수 1건/);
  assert.match(text, /보유 1종목\n\s+AAA\s+\+₩2,628 \(\+1\.9%\)/); // 0.9891 × 103 × 1400 − 140,000
});

test("내일 시가에 팔 예정인 보유 종목은 경고 표시와 사유가 붙는다", () => {
  const d = base();
  d.paper.open = [{ ticker: "AAA", qty: 1, entry_price: 100, stop: 95, last_close: 94, cost_krw: 140_000, pending_exit: "STOP" }];
  assert.match(formatDailyReport(d), /AAA.*⚠ 내일 시가 매도\(손절\)/);
});

test("시장 전체 급증일에 발견된 후보는 * 로 표시하고 각주를 단다", () => {
  const d = base();
  d.events = [{ type: "DISCOVERED", ticker: "CCC", marketWide: true, detail: {} }, { type: "DISCOVERED", ticker: "CCD", marketWide: false, detail: {} }];
  d.breadth = { surge: 312 };
  const text = formatDailyReport(d);
  assert.match(text, /새 후보 2: CCC\* CCD/);
  assert.match(text, /\* 시장 전체 거래량이 터진 날 \(급증 종목 312개\)/);
});

test("수집 누락은 1% 를 넘을 때만 알린다", () => {
  const d = base();
  d.batch = { ...d.batch, ok: 2789, requested: 2790 };
  assert.doesNotMatch(formatDailyReport(d), /수집 누락/);
  d.batch = { ...d.batch, ok: 2700, requested: 2790 };
  assert.match(formatDailyReport(d), /⚠ 수집 누락 90종목 \(2700\/2790\)/);
});

test("목록이 길면 이름 8개까지만 보이고 나머지는 건수로 줄인다", () => {
  const d = base();
  d.events = Array.from({ length: 20 }, (_, i) => ({ type: "DISCOVERED", ticker: `T${i}`, detail: {} }));
  assert.match(formatDailyReport(d), /외 12/);
});

test("시작 안내는 쌓여 있던 과거 후보를 보고하지 않는다고 밝힌다", () => {
  assert.match(formatStartReport(base()), /과거에 쌓인 후보는 보고하지 않습니다/);
});

test("지연 경고에는 최신 기준일과 기대 기준일이 들어간다", () => {
  const text = formatWatchdog({ latestAsOf: "2026-11-03", expected: "2026-11-05", lastBatch: "2026-11-04-daily" });
  assert.match(text, /서버 최신 11\/03 · 있어야 할 날짜 11\/05/);
  assert.match(text, /휴장일이면 정상/);
});

test("expectedAsOf: 마감 확정(16:30) 전이면 전 평일, 후이면 오늘, 주말은 금요일", () => {
  // 11월 초는 표준시(UTC-5)
  assert.equal(expectedAsOf(new Date("2026-11-04T12:00:00Z")), "2026-11-03"); // 수 07:00 NY → 화
  assert.equal(expectedAsOf(new Date("2026-11-05T22:00:00Z")), "2026-11-05"); // 목 17:00 NY → 목
  assert.equal(expectedAsOf(new Date("2026-11-05T21:00:00Z")), "2026-11-04"); // 목 16:00 NY: 아직 확정 전 → 수
  assert.equal(expectedAsOf(new Date("2026-11-07T15:00:00Z")), "2026-11-06"); // 토 → 금
  assert.equal(expectedAsOf(new Date("2026-11-09T15:00:00Z")), "2026-11-06"); // 월 10:00 NY → 금
});
