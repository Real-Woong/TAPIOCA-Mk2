import test from "node:test";
import assert from "node:assert/strict";

import {
  BlockedError,
  NotFoundError,
  RetryableError,
  cleanBars,
  classifyResponse,
  COLLECTOR_USER_AGENT,
  fetchBarsFrom,
  httpGet,
  parseStooq,
  parseTwelveData,
  parseYahoo,
} from "../../src/collect/sources.js";

const bar = (date, over = {}) => ({ date, o: 10, h: 11, l: 9, c: 10.5, v: 1000, ...over });

test("Yahoo 응답을 봉으로 바꾸고 조정 종가를 따로 싣는다", () => {
  const t1 = Date.UTC(2026, 9, 28, 13, 30) / 1000;
  const t2 = Date.UTC(2026, 9, 29, 13, 30) / 1000;
  const body = JSON.stringify({
    chart: {
      result: [{
        timestamp: [t1, t2],
        indicators: {
          quote: [{ open: [1, 2], high: [3, 4], low: [0.5, 1.5], close: [2, 3], volume: [100, 200] }],
          adjclose: [{ adjclose: [1.9, 2.9] }],
        },
      }],
    },
  });
  const { bars } = parseYahoo(body);
  assert.deepEqual(bars[1], { date: "2026-10-29", o: 2, h: 4, l: 1.5, c: 3, v: 200, ac: 2.9 });
});

test("Yahoo가 종목이 없다고 답하면 NotFound다", () => {
  const body = JSON.stringify({ chart: { result: null, error: { description: "No data found" } } });
  assert.throws(() => parseYahoo(body), NotFoundError);
});

test("Stooq CSV를 읽고, 'No data'는 NotFound, 낯선 첫 줄은 재시도 대상이다", () => {
  const csv = "Date,Open,High,Low,Close,Volume\n2026-10-28,1,2,0.5,1.5,100\n";
  assert.equal(parseStooq(csv).bars[0].c, 1.5);
  assert.throws(() => parseStooq("No data"), NotFoundError);
  assert.throws(() => parseStooq("무언가 다른 것"), RetryableError);
});

test("Twelve Data는 최신순 응답을 날짜순으로 뒤집고, 429는 차단으로 센다", () => {
  const body = JSON.stringify({
    status: "ok",
    values: [
      { datetime: "2026-10-29", open: "2", high: "3", low: "1", close: "2.5", volume: "20" },
      { datetime: "2026-10-28", open: "1", high: "2", low: "1", close: "1.5", volume: "10" },
    ],
  });
  assert.deepEqual(parseTwelveData(body).bars.map((b) => b.date), ["2026-10-28", "2026-10-29"]);
  assert.throws(() => parseTwelveData(JSON.stringify({ status: "error", code: 429, message: "limit" })), BlockedError);
});

test("차단 벽·한도·없음·서버 오류를 구분한다", () => {
  assert.throws(() => classifyResponse({ status: 429, body: "" }), BlockedError);
  assert.throws(() => classifyResponse({ status: 200, body: "<html>captcha</html>" }), BlockedError);
  assert.throws(() => classifyResponse({ status: 404, body: "{}" }), NotFoundError);
  assert.throws(() => classifyResponse({ status: 503, body: "" }), RetryableError);
  assert.doesNotThrow(() => classifyResponse({ status: 200, body: "{}" }));
});

test("값이 비었거나 모순인 봉은 버리고 날짜순·중복 없이 정렬한다", () => {
  const { bars, dropped } = cleanBars([
    bar("2026-10-29"),
    bar("2026-10-28"),
    bar("2026-10-28", { c: 10.6 }), // 같은 날 중복 — 나중 것이 이긴다
    bar("2026-10-27", { c: null }), // 결측
    bar("2026-10-26", { h: 8 }), // 고가 < 저가
    bar("2026-10-25", { v: -1 }),
  ]);
  assert.deepEqual(bars.map((b) => b.date), ["2026-10-28", "2026-10-29"]);
  assert.equal(bars[0].c, 10.6);
  assert.equal(dropped, 4);
});

test("fetchBarsFrom: 가짜 fetch로 끝까지 흐르고 모드에 맞는 개수만 남긴다", async () => {
  const csvRows = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")},1,2,0.5,1.5,100`);
  const fetchImpl = async () => ({ status: 200, text: async () => ["Date,Open,High,Low,Close,Volume", ...csvRows].join("\n") });
  const { bars, adjustment } = await fetchBarsFrom("stooq", "AAPL", { mode: "daily", fetchImpl });
  assert.equal(bars.length, 10);
  assert.equal(bars.at(-1).date, "2026-09-30");
  assert.equal(adjustment, "unverified");
});

test("fetchBarsFrom: 키가 필요한 소스에 키가 없으면 먼저 알린다", async () => {
  await assert.rejects(
    () => fetchBarsFrom("twelvedata", "AAPL", { env: {}, fetchImpl: async () => { throw new Error("호출되면 안 됨"); } }),
    /TWELVE_DATA_API_KEY/,
  );
});

test("요청은 Chrome 위장이 아니라 수집기를 밝히는 User-Agent로 나간다 (Yahoo가 Chrome UA를 429로 막는다)", async () => {
  let sent;
  const fetchImpl = async (_url, init) => { sent = init.headers["user-agent"]; return { status: 200, text: async () => "{}" }; };
  await httpGet("https://example.test", { fetchImpl });
  assert.equal(sent, COLLECTOR_USER_AGENT);
  assert.doesNotMatch(sent, /Chrome/);
});
