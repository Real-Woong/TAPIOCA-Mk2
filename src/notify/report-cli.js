#!/usr/bin/env node

// 텔레그램 보고를 보냅니다. 서버에서 receive → candidates → paper 다음에 실행합니다.
//   npm run report                    오늘 보고 (이미 보고한 기준일이면 건너뜀)
//   npm run report -- --dry           보내지 않고 화면에만 출력 (표식도 안 옮김)
//   npm run report -- --force         이미 보고한 기준일이어도 다시 보냄
//   npm run report -- --watchdog      수집이 늦었는지 점검해서 늦었으면 경고 (하루 한 번, cron/타이머로)
//   npm run report -- --data /path/to/data
//
// 토큰은 프로젝트 폴더의 .env 에서 읽습니다 (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID).
// 종료 코드: 0 정상 · 1 전송/설정 오류

import process from "node:process";

import { openDb } from "../server/db.js";
import { dataPaths } from "../server/paths.js";
import { runReport, runWatchdog } from "./report.js";
import { loadEnv, telegramConfig } from "./telegram.js";

const has = (flag) => process.argv.includes(flag);
const idx = process.argv.indexOf("--data");
const paths = dataPaths(idx >= 0 ? process.argv[idx + 1] : "data");

loadEnv();
const config = telegramConfig();
const dry = has("--dry");
const db = openDb(paths.dbFile);

try {
  const result = has("--watchdog")
    ? await runWatchdog(db, { config, dry })
    : await runReport(db, { config, dry, force: has("--force") });

  if (result.text && (dry || result.status.endsWith("NO_CONFIG"))) console.log(`\n${result.text}\n`);
  const note = {
    OK: "수집이 제때 들어와 있습니다",
    NO_DATA: "DB 에 배치가 없습니다. 먼저 npm run receive",
    ALREADY_REPORTED: "이 기준일은 이미 보고했습니다 (--force 로 다시 보낼 수 있음)",
    DRY: "시험 출력입니다. 보내지 않았고 표식도 그대로입니다",
    SENT: "보고를 보냈습니다",
    STARTED: "보고 시작 안내를 보냈습니다. 표식을 현재로 맞췄습니다",
    LATE_SENT: "수집 지연 경고를 보냈습니다",
  }[result.status];
  if (note) console.log(`■ ${note}`);
  if (result.status === "NO_CONFIG" || result.status === "LATE_NO_CONFIG") {
    console.error("■ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 가 .env 에 없어 보내지 못했습니다 (위 문구는 화면에만 출력)");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`■ 보고 실패: ${error.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
