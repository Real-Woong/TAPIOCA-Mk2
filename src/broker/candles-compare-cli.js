#!/usr/bin/env node

// 토스 일봉과 우리 DB 일봉(Yahoo)을 비교합니다. 읽기 전용 — 주문 API 도, DB 쓰기도 없습니다. 서버(Oracle)에서 실행하세요.
//   npm run candles-compare                       종목 20개를 고르게 뽑아 최근 10봉 비교
//   npm run candles-compare -- --tickers SVA,AMAL --count 20
//   npm run candles-compare -- --sample 40
//   npm run candles-compare -- --raw              첫 종목의 토스 응답 모양을 그대로 보여 줌(파라미터·필드 확인용)
//
// 보는 것: 종가가 얼마나 다른가(수정주가 기준 차이), 거래량 비율(토스/Yahoo — 1보다 크면 시간외가 섞였을 수 있음), 날짜 어긋남.
// 호출 한도(MARKET_DATA_CHART 초당 20회)를 넘지 않게 호출 사이에 간격을 둡니다.

import process from "node:process";

import { loadEnv } from "../notify/telegram.js";
import { openDb } from "../server/db.js";
import { dataPaths } from "../server/paths.js";
import { createClientIfConfigured } from "./refresh.js";
import { aggregate, compareBars, normalizeCandles } from "./candles-compare.js";

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const pct = (x) => (x === null ? "-" : `${(x * 100).toFixed(2)}%`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

loadEnv();
const client = createClientIfConfigured();
if (!client) {
  console.error("■ 토스 키(TOSS_CLIENT_ID/SECRET)가 없습니다 — 서버의 .env 를 확인하세요");
  process.exit(1);
}

const db = openDb(dataPaths(arg("data", "data")).dbFile);
const count = Number(arg("count", 10));
try {
  const given = arg("tickers");
  let tickers;
  if (given) tickers = given.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  else {
    // 알파벳 순으로 정렬한 종목에서 같은 간격으로 뽑는다(무작위가 아니라 다시 돌려도 같은 종목)
    const all = db.prepare("SELECT DISTINCT ticker FROM latest_bars ORDER BY ticker").all().map((r) => r.ticker);
    const n = Math.min(Number(arg("sample", 20)), all.length);
    tickers = Array.from({ length: n }, (_, k) => all[Math.floor((k * all.length) / n)]);
  }

  const ourBars = db.prepare("SELECT date, c, v FROM latest_bars WHERE ticker = ? ORDER BY date");
  const results = [];
  console.log(`■ 토스 일봉 ↔ 우리 DB(Yahoo) 비교 · ${tickers.length}종목 · 최근 ${count}봉\n`);
  console.log("  종목    맞춘 날짜  어긋남  종가 차이(중앙/최대)  거래량 비율(토스/Yahoo 중앙)");
  for (const [i, ticker] of tickers.entries()) {
    if (i > 0) await sleep(700);
    try {
      let payload;
      try {
        payload = await client.getCandles(ticker, { count });
      } catch (error) {
        // 요청 한도(429)면 잠시 쉬었다가 한 번만 다시 시도한다
        if (error.code !== "rate-limit-exceeded") throw error;
        await sleep(3000);
        payload = await client.getCandles(ticker, { count });
      }
      if (process.argv.includes("--raw") && i === 0) console.log(`\n[원본 응답 앞부분] ${JSON.stringify(payload).slice(0, 700)}\n`);
      const result = compareBars(normalizeCandles(payload), ourBars.all(ticker));
      results.push(result);
      console.log(`  ${ticker.padEnd(7)} ${String(result.matched).padStart(4)}/${String(result.tossBars).padEnd(4)} ${String(result.offsetDays).padStart(4)}   ${pct(result.closeDiffMedian).padStart(7)} / ${pct(result.closeDiffMax).padEnd(7)}   ${result.volRatioMedian === null ? "-" : result.volRatioMedian.toFixed(3)}`);
    } catch (error) {
      console.log(`  ${ticker.padEnd(7)} 조회 실패: ${error.message}${error.code ? ` (${error.code})` : ""}`);
    }
  }
  const sum = aggregate(results);
  console.log(`\n■ 요약: 비교 가능 ${sum.comparable}/${sum.tickers}종목 · 종가 차이 중앙 ${pct(sum.closeDiffMedian)} (최악 ${pct(sum.closeDiffWorst)}) · 거래량 비율 중앙 ${sum.volRatioMedian === null ? "-" : sum.volRatioMedian.toFixed(3)} · 날짜 어긋남 ${sum.offsets.join(", ") || "-"}`);
  console.log("  해석: 종가 차이가 0.1% 안팎이고 거래량 비율이 1.00 근처면 사실상 같은 데이터. 비율이 1.05 이상이면 시간외 거래량이 섞인 것.");
  console.log("  ※ 이 비교는 아무 곳에도 저장하지 않았고, 전략 입력은 그대로 Yahoo 입니다.\n");
} catch (error) {
  console.error(`■ 실패: ${error.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
