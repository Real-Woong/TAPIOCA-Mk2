#!/usr/bin/env node

// 발견 조건(RVOL·20일 수익률·20일 범위·CLV·거래대금)을 DB 전체에 적용해 «몇 건이 남는지» 보여 줍니다. 읽기 전용.
//   npm run scan
//   npm run scan -- --data /path/to/data

import process from "node:process";

import { openDb } from "../server/db.js";
import { dataPaths } from "../server/paths.js";
import { SETTINGS, STRATEGY_VERSION } from "./settings.js";
import { loadBarsByTicker, loadSplitSuspects, scan } from "./scan.js";

const idx = process.argv.indexOf("--data");
const paths = dataPaths(idx >= 0 ? process.argv[idx + 1] : "data");

const db = openDb(paths.dbFile);
const suspects = loadSplitSuspects(db);
const result = scan(loadBarsByTicker(db), SETTINGS, suspects);
db.close();
if (suspects.size) console.log(`※ 분할 의심 종목(backfill 로 다시 받기 전까지 제외): ${[...suspects].join(", ")}`);

const labels = [
  ["rvol", `거래량 ≥ 60일 평균의 ${SETTINGS.rvolMin}배`],
  ["return20", `20일 수익률 ${SETTINGS.returnMin * 100}% ~ +${SETTINGS.returnMax * 100}%`],
  ["range20", `20일 범위 ≤ ${SETTINGS.rangeMax * 100}%`],
  ["clv", `종가 위치(CLV) ≥ ${SETTINGS.clvMin}`],
  ["addv20", `20일 평균 거래대금 ≥ $${(SETTINGS.addvMinUsd / 1e6).toFixed(0)}M`],
];
const print = (title, funnel) => {
  console.log(`\n${title}  (평가 ${funnel.evaluated.toLocaleString()}건)`);
  for (const [key, label] of labels) console.log(`  + ${label.padEnd(34)} → ${String(funnel[key]).padStart(6)}`);
};

console.log(`■ 전략 ${STRATEGY_VERSION} · 평가 종목 ${result.tickersEvaluated}개 · 봉 ${SETTINGS.minBars}개 미만 제외 ${result.tickersSkippedShort}개 · 분할 의심 제외 ${result.tickersSkippedDiscontinuity}개 · 최신 기준일 ${result.latestDate}`);
print(`■ 최신 기준일(${result.latestDate}) 하루`, result.funnelLatest);
print("■ 보유한 전체 기간의 (종목×날짜)", result.funnelAllDays);
console.log(`\n■ 전 조건 통과: 최신일 ${result.hitsLatest.length}건 · 전체 기간 ${result.hitsAllDays}건`);
for (const hit of result.hitsLatest.slice(0, 30)) {
  console.log(`  ${hit.ticker.padEnd(6)} RVOL ${hit.rvol.toFixed(1)}  수익률 ${(hit.return20 * 100).toFixed(1)}%  범위 ${(hit.range20 * 100).toFixed(1)}%  CLV ${hit.clv.toFixed(2)}  거래대금 $${(hit.addv20 / 1e6).toFixed(1)}M  종가 ${hit.close}`);
}
console.log("\n※ 후보 «발견»일 뿐입니다. 3일 저점 유지 확인과 박스 돌파는 다음 단계입니다.\n");
