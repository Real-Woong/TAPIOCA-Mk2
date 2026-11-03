import test from "node:test";
import assert from "node:assert/strict";

import { runCandidates } from "../../src/candidates/runner.js";
import { gatherReport, runReport, runWatchdog } from "../../src/notify/report.js";
import { runPaper } from "../../src/paper/engine.js";
import { hasSqlite, openDb } from "../../src/server/db.js";
import { receiveBatch, scenario } from "../candidates/support.js";
import { withDir } from "../server/helpers.js";

const skip = hasSqlite ? false : "이 Node에는 node:sqlite 가 없음(22.13+ 필요)";
const LIVE = new Date("2026-08-16T22:00:00Z"); // 돌파 신호 당일 밤에 기록
const config = { token: "123:SECRET", chatId: "42" };

const sender = (calls, { fail = false } = {}) => async (url, init) => {
  calls.push(JSON.parse(init.body).text);
  return fail
    ? { ok: false, status: 500, json: async () => ({ description: "boom" }) }
    : { ok: true, status: 200, json: async () => ({ ok: true }) };
};

async function prepare(root) {
  const paths = await receiveBatch(root, "2026-11-03-backfill", {
    mode: "backfill", symbols: ["AAA"], barsFor: () => scenario({ surgeAt: 70, breakoutAt: 76 }),
  });
  const db = openDb(paths.dbFile);
  runCandidates(db, { now: LIVE });
  for (let d = 1; d <= 31; d += 1) {
    db.prepare("INSERT INTO fx_rates (date, usdkrw, source, fetched_at) VALUES (?,?,'TEST','x')").run(`2026-08-${String(d).padStart(2, "0")}`, 1000);
  }
  runPaper(db, { now: LIVE, startAfterDate: "2026-08-16" });
  return db;
}

test("gatherReport: 소급 기록(3일 넘게 늦음)은 빼고 건수만 센다, 실시간 사건은 넣는다", { skip }, async () => {
  await withDir(async (root) => {
    const db = await prepare(root);
    const d = gatherReport(db, { sinceEventId: 0, sinceDate: "2026-08-15" });
    // DISCOVERED(08-10)는 6일 늦게 기록 → 소급. CONFIRMED(08-13)는 3일, BREAKOUT(08-16)은 0일 → 실시간
    assert.deepEqual(d.events.map((e) => e.type), ["CONFIRMED", "BREAKOUT"]);
    assert.equal(d.retroCount, 1);
    assert.equal(d.paper.fills.length, 1);
    assert.equal(d.paper.exits.length, 1);
    assert.equal(d.counts.BROKE_OUT, 1);
    db.close();
  });
});

test("첫 실행은 시작 안내만 보내고 표식을 현재로 맞춘다, 다시 실행하면 이미 보고함", { skip }, async () => {
  await withDir(async (root) => {
    const db = await prepare(root);
    const calls = [];
    const first = await runReport(db, { config, fetchImpl: sender(calls), now: LIVE });
    assert.equal(first.status, "STARTED");
    assert.match(calls[0], /보고를 시작합니다/);
    assert.doesNotMatch(calls[0], /매수 신호/); // 쌓여 있던 사건을 쏟아내지 않는다

    const second = await runReport(db, { config, fetchImpl: sender(calls), now: LIVE });
    assert.equal(second.status, "ALREADY_REPORTED");
    assert.equal(calls.length, 1);
    db.close();
  });
});

test("일일 보고: 마지막 보고 이후의 사건·체결·청산을 보내고 표식을 옮긴다", { skip }, async () => {
  await withDir(async (root) => {
    const db = await prepare(root);
    db.prepare("INSERT INTO report_state (id, last_event_id, last_report_date, sent_at) VALUES (1, 0, '2026-08-15', 'x')").run();
    const calls = [];
    const result = await runReport(db, { config, fetchImpl: sender(calls), now: LIVE });
    assert.equal(result.status, "SENT");
    assert.match(calls[0], /🔔 매수 신호 1건/);
    assert.match(calls[0], /🟢 모의 매수 AAA/);
    assert.match(calls[0], /🔴 청산 AAA.*박스 이탈/);
    assert.doesNotMatch(calls[0], /소급/); // 소급분은 조용히 뺀다(건수는 gatherReport 가 따로 센다)

    const state = db.prepare("SELECT * FROM report_state").get();
    assert.equal(state.last_report_date, "2026-08-29"); // 최신 배치의 기준일
    assert.equal((await runReport(db, { config, fetchImpl: sender(calls), now: LIVE })).status, "ALREADY_REPORTED");
    db.close();
  });
});

test("전송이 실패하면 표식을 옮기지 않는다 — 다음 실행이 다시 보낸다", { skip }, async () => {
  await withDir(async (root) => {
    const db = await prepare(root);
    db.prepare("INSERT INTO report_state (id, last_event_id, last_report_date, sent_at) VALUES (1, 0, '2026-08-15', 'x')").run();
    await assert.rejects(runReport(db, { config, fetchImpl: sender([], { fail: true }), now: LIVE }), /HTTP 500/);
    assert.equal(db.prepare("SELECT last_report_date FROM report_state").get().last_report_date, "2026-08-15");
    const retry = await runReport(db, { config, fetchImpl: sender([]), now: LIVE });
    assert.equal(retry.status, "SENT");
    db.close();
  });
});

test("--dry 는 보내지도 표식을 옮기지도 않는다, 설정이 없으면 문구만 돌려준다", { skip }, async () => {
  await withDir(async (root) => {
    const db = await prepare(root);
    const dry = await runReport(db, { config, dry: true, now: LIVE });
    assert.equal(dry.status, "DRY");
    assert.ok(dry.text.length > 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM report_state").get().n, 0);
    assert.equal((await runReport(db, { config: null, now: LIVE })).status, "NO_CONFIG");
    db.close();
  });
});

test("watchdog: 최신 기준일이 기대보다 늦으면 경고, 제때면 조용", { skip }, async () => {
  await withDir(async (root) => {
    const db = await prepare(root); // 최신 기준일 2026-08-29(토요일에 만든 가짜 봉)
    const calls = [];
    const late = await runWatchdog(db, { config, fetchImpl: sender(calls), now: new Date("2026-09-01T12:00:00Z") }); // 화 08:00 NY → 기대 08-31
    assert.equal(late.status, "LATE_SENT");
    assert.match(calls[0], /수집이 안 들어왔습니다/);
    const ok = await runWatchdog(db, { config, fetchImpl: sender(calls), now: new Date("2026-08-31T12:00:00Z") }); // 월 08:00 NY → 기대 08-28
    assert.equal(ok.status, "OK");
    assert.equal(calls.length, 1);
    db.close();
  });
});
