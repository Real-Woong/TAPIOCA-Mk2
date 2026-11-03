#!/usr/bin/env node

// Mac mini에서 하루 한 번(미국 정규장 마감 30분 뒤 이후) 돌리는 수집 명령입니다.
//
//   npm run collect -- --mode backfill --source yahoo        최초 1회: 최근 약 6개월
//   npm run collect -- --mode daily                          매일: 최근 5봉
//   npm run collect -- --tickers AAPL,SOFI --mode backfill   일부만 (시험용)
//   npm run collect -- --limit 20                            알파벳 앞 20종목만 (시험용)
//   npm run collect -- --out data/outbox/2026-11-02-daily   중단된 배치를 이어서
//
// 종료 코드: 0 COMPLETE · 2 PARTIAL · 3 ABORTED(차단으로 중단) · 1 그 밖의 오류
// 스케줄러(launchd 등)는 0이 아니면 알리도록 걸어 두면 됩니다.

import path from "node:path";
import process from "node:process";

import { collect, makeFetchBars } from "./collector.js";
import { newYorkNow } from "./session.js";
import { SOURCES } from "./sources.js";
import { fetchUniverse } from "./universe.js";

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (!key || argv[i + 1] === undefined) throw new Error(`옵션 값이 없습니다: ${argv[i]}`);
    options[key] = argv[i + 1];
  }
  return options;
}

const args = parseArgs(process.argv.slice(2));
const mode = args.mode ?? "daily";
const source = args.source ?? process.env.SCREENER_SOURCE ?? "yahoo";
if (!SOURCES[source]) throw new Error(`소스는 ${Object.keys(SOURCES).join("|")} 중 하나입니다: ${source}`);

const universe = args.tickers
  ? { included: args.tickers.split(",").map((symbol) => ({ symbol: symbol.trim().toUpperCase() })), excluded: [] }
  : await fetchUniverse();
if (args.limit) universe.included = universe.included.slice(0, Number(args.limit));

const runDate = newYorkNow().date;
const outDir = path.resolve(args.out ?? `data/outbox/${runDate}-${mode}`);
console.log(`■ 수집 시작 — ${mode} · ${source} · 대상 ${universe.included.length}개 · 출력 ${outDir}`);
if (universe.excluded.length) console.log(`■ 제외 ${universe.excluded.length}개 (이유는 universe.json 에 있습니다)`);

const manifest = await collect({
  mode,
  source,
  universe,
  outDir,
  fetchBarsImpl: makeFetchBars(source),
  delayMs: Number(args.delay ?? 1000),
  retries: Number(args.retries ?? 2),
  log: (line) => console.log(`  ${line}`),
});

const { counts } = manifest;
console.log(
  `\n■ ${manifest.status} — 기준일 ${manifest.asOf ?? "없음"} · 성공 ${counts.ok}/${counts.requested} · ` +
    `없음 ${counts.notFound} · 차단 ${counts.blocked} · 재시도 실패 ${counts.retryExhausted} · 미시도 ${counts.notAttempted} · ` +
    `기준일 아님(stale) ${counts.stale}`,
);
process.exit({ COMPLETE: 0, PARTIAL: 2, ABORTED: 3 }[manifest.status] ?? 1);
