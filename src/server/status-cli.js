#!/usr/bin/env node

// DB에 무엇이 들어 있는지 한눈에 봅니다(읽기 전용).
//   npm run status
//   npm run status -- --data /path/to/data

import { stat } from "node:fs/promises";
import process from "node:process";

import { openDb } from "./db.js";
import { dataPaths } from "./paths.js";

const argIndex = process.argv.indexOf("--data");
const paths = dataPaths(argIndex >= 0 ? process.argv[argIndex + 1] : "data");

if (!(await stat(paths.dbFile).then(() => true, () => false))) {
  console.log(`DB가 아직 없습니다: ${paths.dbFile}\n먼저 npm run receive 를 실행하세요.`);
  process.exit(1);
}

const db = openDb(paths.dbFile);
const one = (sql) => db.prepare(sql).get();

console.log("\n■ 적재된 배치");
for (const b of db.prepare("SELECT * FROM batches ORDER BY seq").all()) {
  console.log(`  #${b.seq} ${b.batch}  ${b.mode}  기준일 ${b.as_of}  ${b.status}  ${b.ok}/${b.requested}  stale ${b.stale}`);
}

const bars = one("SELECT COUNT(*) AS n, COUNT(DISTINCT ticker) AS tickers, MIN(date) AS first, MAX(date) AS last FROM latest_bars");
const short = one(`SELECT COUNT(*) AS n FROM (SELECT ticker FROM latest_bars GROUP BY ticker HAVING COUNT(*) < 80)`);
const corrections = one("SELECT COUNT(*) AS n FROM bar_corrections");
console.log(`\n■ 최신 봉: ${bars.n}개 · 종목 ${bars.tickers}개 · ${bars.first} ~ ${bars.last}`);
console.log(`■ 봉이 80개 미만인 종목: ${short.n}개 (RVOL 계산에서 제외)`);
console.log(`■ 정정된 값(bar_corrections): ${corrections.n}건`);
const issues = db.prepare("SELECT kind, COUNT(*) AS n FROM batch_issues GROUP BY kind").all();
if (issues.length) console.log(`■ 기록된 문제: ${issues.map((i) => `${i.kind} ${i.n}`).join(" · ")}`);
console.log(`■ DB 파일: ${paths.dbFile}\n`);
db.close();
