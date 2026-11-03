#!/usr/bin/env node

// Oracle 서버에서 돌리는 수신 명령입니다. 받은 편지함(1_inbox)을 검수하고 SQLite에 적재합니다.
//
//   npm run receive                              data/ 기준
//   npm run receive -- --data /path/to/data      다른 위치
//   npm run receive -- --max-missing 0.05        PARTIAL 허용 비율(기본 0.02 = 2%)
//   npm run receive -- --rebuild                 DB를 지우고 2_accepted 전체에서 다시 만듦
//
// 종료 코드: 0 이상 없음 · 2 탈락/이상한 배치가 있음 · 1 그 밖의 오류(알림을 걸 때 0이 아니면 알리도록)

import process from "node:process";

import { receiveAll } from "./receive.js";

function parseArgs(argv) {
  const options = { rebuild: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, "");
    if (key === "rebuild") options.rebuild = true;
    else if (argv[i + 1] === undefined) throw new Error(`옵션 값이 없습니다: ${argv[i]}`);
    else options[key] = argv[(i += 1)];
  }
  return options;
}

const args = parseArgs(process.argv.slice(2));
const { results, loaded } = await receiveAll({
  dataRoot: args.data ?? "data",
  maxMissingRatio: args["max-missing"] !== undefined ? Number(args["max-missing"]) : undefined,
  rebuild: args.rebuild,
  log: (line) => console.log(`  ${line}`),
});

const rejected = results.filter((r) => r.outcome === "REJECTED" || r.outcome === "ACCEPTED_BROKEN");
for (const r of results.filter((x) => x.warnings?.length)) {
  console.log(`  ⚠ ${r.batch}: ${r.warnings.join(" / ")}`);
}
if (rejected.length) {
  for (const r of rejected) console.log(`\n  [${r.batch}] 탈락 이유\n${r.errors.map((e) => `    - ${e}`).join("\n")}`);
}
console.log(`\n■ 적재 ${loaded.length}건 · 탈락 ${rejected.length}건${results.length ? "" : " (처리할 배치 없음)"}`);
process.exit(rejected.length ? 2 : 0);
