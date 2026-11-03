#!/usr/bin/env node

// 신호 종목의 금액주문(소수점) 가능 여부를 기록하거나 봅니다. DB 가 있는 서버(Oracle)에서 실행하세요.
//   npm run fractional -- SVA ok  [메모]     앱에서 «금액으로 사기»가 보였다
//   npm run fractional -- SVA no  [메모]     안 보였다 / 주문이 거절됐다 → 모의매매는 이 종목을 건너뜁니다(NOT_ELIGIBLE)
//   npm run fractional -- list               기록 보기와 가능/불가 개수
//   (Mac 에서는)  npm run server -- "npm run fractional -- SVA ok"
//
// 기록은 쌓기만 합니다. 마음이 바뀌면 같은 종목에 새 줄을 넣으세요(가장 새 줄이 현재 판단).

import process from "node:process";

import { openDb } from "../server/db.js";
import { dataPaths } from "../server/paths.js";
import { fractionalSummary, parseResult, recordFractional } from "./fractional.js";

const args = process.argv.slice(2);
const dataIdx = args.indexOf("--data");
const dataDir = dataIdx >= 0 ? args.splice(dataIdx, 2)[1] : "data";
const db = openDb(dataPaths(dataDir).dbFile);

try {
  if (args[0] === "list" || args.length === 0) {
    const rows = db.prepare(`SELECT ticker, result, source, note, checked_at FROM fractional_checks
      WHERE id IN (SELECT MAX(id) FROM fractional_checks GROUP BY ticker) ORDER BY ticker`).all();
    for (const r of rows) console.log(`  ${r.ticker.padEnd(6)} ${r.result === "OK" ? "가능" : "불가"}  (${r.source}, ${r.checked_at.slice(0, 10)})${r.note ? `  ${r.note}` : ""}`);
    const sum = fractionalSummary(db);
    console.log(`\n■ 종목 ${sum.tickers}개 확인: 가능 ${sum.ok} · 불가 ${sum.no}${sum.tickers ? "" : "  (아직 기록 없음)"}`);
  } else {
    const result = parseResult(args[1]);
    if (!result) throw new Error("사용법: npm run fractional -- <종목> ok|no [메모]   (또는 list)");
    const ticker = recordFractional(db, args[0], result, { note: args.slice(2).join(" ") || null });
    console.log(`■ ${ticker} 금액주문 ${result === "OK" ? "가능" : "불가"} 으로 기록했습니다${result === "NO" ? " — 모의매매는 이 종목의 대기 주문을 건너뜁니다" : ""}`);
  }
} catch (error) {
  console.error(`■ ${error.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
