#!/usr/bin/env node

// 후보 상태 머신을 DB 전체에 한 번 돌리고, 오늘 달라진 것을 보여 줍니다. (receive 뒤에 매일 실행)
//   npm run candidates
//   npm run candidates -- --data /path/to/data

import process from "node:process";

import { openDb } from "../server/db.js";
import { dataPaths } from "../server/paths.js";
import { STRATEGY_VERSION } from "../compute/settings.js";
import { runCandidates } from "./runner.js";

const idx = process.argv.indexOf("--data");
const paths = dataPaths(idx >= 0 ? process.argv[idx + 1] : "data");

const db = openDb(paths.dbFile);
const summary = runCandidates(db);

const LABEL = { CONFIRMING: "확인 중(3일)", WAITING: "돌파 대기", BROKE_OUT: "돌파(매수 신호)", INVALID: "무효", EXPIRED: "만료" };
console.log(`\n■ 전략 ${STRATEGY_VERSION} · 계산 ${summary.tickersRun}종목 · 제외 ${summary.tickersSkipped}종목`);
console.log(`■ 이번에 새로 만든 후보 ${summary.newCandidates}개 · 새로 기록된 사건 ${summary.newEvents.length}건`);
console.log("■ 후보 현황: " + (Object.entries(summary.byState).map(([k, v]) => `${LABEL[k] ?? k} ${v}`).join(" · ") || "없음"));

const byType = (type) => summary.newEvents.filter((e) => e.type === type);
for (const [type, title] of [["BREAKOUT", "매수 신호(돌파)"], ["CONFIRMED", "확인 통과"], ["DISCOVERED", "새로 발견"], ["INVALIDATED", "무효"], ["EXPIRED", "만료"]]) {
  const list = byType(type);
  if (!list.length) continue;
  console.log(`\n▶ ${title} ${list.length}건`);
  for (const e of list.slice(0, 20)) console.log(`   ${e.ticker.padEnd(6)} ${e.date}${e.boxTop ? `  박스상단 ${e.boxTop}` : ""}${e.rvol ? `  RVOL ${e.rvol.toFixed(1)}` : ""}`);
}

const latestBreadth = db.prepare("SELECT * FROM market_breadth ORDER BY date DESC LIMIT 1").get();
if (latestBreadth) {
  console.log(`\n■ 시장 폭 ${latestBreadth.date}: 평가 ${latestBreadth.evaluated}종목 중 거래량 급증 ${latestBreadth.surge}개 (${(latestBreadth.ratio * 100).toFixed(1)}%) · 후보 조건 통과 ${latestBreadth.all_pass}개${latestBreadth.market_wide ? " · ★ 시장 전체 급증일" : ""}`);
}

const waiting = db.prepare("SELECT ticker, surge_date, box_top, days FROM candidates WHERE state = 'WAITING' ORDER BY days").all();
if (waiting.length) {
  console.log(`\n▶ 지금 돌파를 기다리는 후보 ${waiting.length}개`);
  for (const w of waiting) console.log(`   ${w.ticker.padEnd(6)} 급증일 ${w.surge_date}  박스상단 ${w.box_top}  대기 ${w.days - 3}/10일`);
}
// 새 후보가 하루에 5개 이상 생겼다면 과거 봉을 처음 훑은 것이다 — 이때만 소급 경고를 낸다
if (summary.newCandidates >= 5) console.log("\n※ 과거 봉을 처음 훑어 «지난 일»이 한꺼번에 기록됐습니다(소급). 모의매매는 기록 당일의 신호만 씁니다.\n");
else console.log("");
db.close();
