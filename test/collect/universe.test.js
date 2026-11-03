import test from "node:test";
import assert from "node:assert/strict";

import { filterUniverse, parseNasdaqListed } from "../../src/collect/universe.js";

const SAMPLE = [
  "Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares",
  "AAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N",
  "QQQ|Invesco QQQ Trust, Series 1|G|N|N|100|Y|N",
  "ZZZZ|NASDAQ TEST STOCK|G|Y|N|100|N|N",
  "ABCDW|Abc Corp. - Warrant|S|N|N|100|N|N",
  "XYZ|Xyz Holdings American Depositary Shares|S|N|N|100|N|N",
  "BADC|Bad Co - Common Stock|S|N|D|100|N|N",
  "AACI|Armada Acquisition Corp. III - Class A Ordinary Share|S|N|N|100|N|N",
  "SOFI|SoFi Technologies, Inc. - Common Stock|Q|N|N|100|N|N",
  "File Creation Time: 1029202616:00|||||||",
].join("\n");

test("심볼 파일을 읽고 꼬리표 줄은 종목으로 세지 않는다", () => {
  const { rows, footer } = parseNasdaqListed(SAMPLE);
  assert.equal(rows.length, 8);
  assert.match(footer, /^File Creation Time/);
});

test("ETF·테스트·워런트·ADR·재무 결함 종목을 이유와 함께 뺀다", () => {
  const { included, excluded } = filterUniverse(parseNasdaqListed(SAMPLE).rows);
  assert.deepEqual(included.map((s) => s.symbol), ["AAPL", "SOFI"]);
  const reasons = Object.fromEntries(excluded.map((e) => [e.symbol, e.reason]));
  assert.deepEqual(reasons, {
    QQQ: "ETF",
    ZZZZ: "TEST_ISSUE",
    ABCDW: "NOT_COMMON_WARRANT",
    XYZ: "NOT_COMMON_DEPOSITARY(ADR)",
    BADC: "FINANCIAL_STATUS_D",
    AACI: "NOT_COMMON_SPAC",
  });
});

test("열 이름이 바뀐 파일은 조용히 통과시키지 않고 멈춘다", () => {
  assert.throws(() => parseNasdaqListed("Ticker|Name\nAAPL|Apple"), /형식이 바뀌었습니다/);
});
