import test from "node:test";
import assert from "node:assert/strict";

import { commissionBpsOn, nextRegularOpen } from "../../src/broker/rules.js";

// 2026-10-31 토스 읽기 전용 확인에서 받은 모양 그대로
const TABLE = [
  { marketCountry: "KR", commissionRate: "0.00015", startDate: "2021-01-01", endDate: "9999-12-31" },
  { marketCountry: "US", commissionRate: "0.001", startDate: null, endDate: "2026-11-01" },
];

test("수수료: 그 날짜에 적용되는 미국 줄을 bp 로 돌려준다 (0.001 = 10bp)", () => {
  assert.equal(commissionBpsOn(TABLE, "2026-10-31"), 10);
  assert.equal(commissionBpsOn(TABLE, "2026-11-01"), 10); // 종료일 당일까지 적용
  assert.equal(commissionBpsOn(TABLE, "2020-01-01"), 10); // 시작일이 없으면 처음부터
});

test("수수료: 기간이 지났으면 null — 한국 줄이나 옛 요율로 어림하지 않는다", () => {
  assert.equal(commissionBpsOn(TABLE, "2026-11-02"), null);
  assert.equal(commissionBpsOn([], "2026-10-31"), null);
  assert.equal(commissionBpsOn(null, "2026-10-31"), null);
});

test("수수료: 줄이 겹치면 시작일이 가장 늦은 줄, 이상한 값은 null", () => {
  const rows = [
    { marketCountry: "US", commissionRate: "0.001", startDate: null, endDate: "9999-12-31" },
    { marketCountry: "US", commissionRate: "0.0025", startDate: "2026-11-02", endDate: "9999-12-31" },
  ];
  assert.equal(commissionBpsOn(rows, "2026-11-05"), 25);
  assert.equal(commissionBpsOn(rows, "2026-11-01"), 10);
  assert.equal(commissionBpsOn([{ marketCountry: "US", commissionRate: "abc", startDate: null, endDate: null }], "2026-11-01"), null);
});

const CALENDAR = {
  today: { date: "2026-10-31", regularMarket: null },
  previousBusinessDay: { date: "2026-10-30", regularMarket: { startTime: "2026-10-30T22:30:00.000+09:00", endTime: "2026-10-31T05:00:00.000+09:00" } },
  nextBusinessDay: { date: "2026-11-02", regularMarket: { startTime: "2026-11-02T23:30:00.000+09:00", endTime: "2026-11-03T06:00:00.000+09:00" } },
};

test("다음 정규장 개장: 지금 이후 가장 가까운 시작 시각을 한국 시간 글자로", () => {
  const open = nextRegularOpen(CALENDAR, new Date("2026-10-31T00:00:00Z"));
  assert.deepEqual(open, { iso: "2026-11-02T23:30:00.000+09:00", label: "11/02 23:30" });
});

test("다음 정규장 개장: 이미 지났거나 휴장(정규장 없음)이면 건너뛰고, 없으면 null", () => {
  assert.equal(nextRegularOpen(CALENDAR, new Date("2026-11-03T00:00:00Z")), null); // 11/02 23:30 KST 는 이미 지남
  assert.equal(nextRegularOpen({ today: { regularMarket: null }, nextBusinessDay: { regularMarket: null } }, new Date()), null);
  assert.equal(nextRegularOpen(null), null);
  // 오늘 정규장이 아직 시작 전이면 오늘 것
  const today = { today: { regularMarket: { startTime: "2026-11-02T23:30:00.000+09:00" } }, nextBusinessDay: { regularMarket: { startTime: "2026-11-03T23:30:00.000+09:00" } } };
  assert.equal(nextRegularOpen(today, new Date("2026-11-02T10:00:00Z")).label, "11/02 23:30");
});
