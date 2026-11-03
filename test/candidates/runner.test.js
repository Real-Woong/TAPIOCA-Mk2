import test from "node:test";
import assert from "node:assert/strict";

import { runCandidates } from "../../src/candidates/runner.js";
import { hasSqlite, openDb } from "../../src/server/db.js";
import { receiveBatch, scenario } from "./support.js";
import { withDir } from "../server/helpers.js";

const skip = hasSqlite ? false : "이 Node에는 node:sqlite 가 없음(22.13+ 필요)";
const NOW = new Date("2026-11-03T23:00:00Z");

async function setup(root, bars) {
  return receiveBatch(root, "2026-11-03-backfill", { mode: "backfill", symbols: ["AAA"], barsFor: () => bars });
}

test("후보와 사건이 DB 에 기록된다", { skip }, async () => {
  await withDir(async (root) => {
    const paths = await setup(root, scenario({ surgeAt: 70, breakoutAt: 76 }));
    const db = openDb(paths.dbFile);
    const summary = runCandidates(db, { now: NOW });

    assert.equal(summary.newCandidates, 1);
    assert.deepEqual(summary.newEvents.map((e) => e.type), ["DISCOVERED", "CONFIRMED", "BREAKOUT"]);
    assert.equal(summary.byState.BROKE_OUT, 1);
    const row = db.prepare("SELECT * FROM candidates").get();
    assert.equal(row.state, "BROKE_OUT");
    assert.equal(row.box_top, 104);
    const confirmed = db.prepare("SELECT detail FROM candidate_events WHERE type = 'CONFIRMED'").get();
    assert.equal(JSON.parse(confirmed.detail).dryUp, 1);
    db.close();
  });
});

test("다시 실행해도 같은 사건이 두 번 기록되지 않는다 (멱등)", { skip }, async () => {
  await withDir(async (root) => {
    const paths = await setup(root, scenario({ surgeAt: 70, breakoutAt: 76 }));
    const db = openDb(paths.dbFile);
    runCandidates(db, { now: NOW });
    const again = runCandidates(db, { now: NOW });
    assert.equal(again.newCandidates, 0);
    assert.equal(again.newEvents.length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM candidate_events").get().n, 3);
    db.close();
  });
});

test("사건 기록은 고치거나 지울 수 없다", { skip }, async () => {
  await withDir(async (root) => {
    const paths = await setup(root, scenario({ surgeAt: 70, breakoutAt: 76 }));
    const db = openDb(paths.dbFile);
    runCandidates(db, { now: NOW });
    assert.throws(() => db.exec("UPDATE candidate_events SET type = 'X'"), /추가만 가능/);
    assert.throws(() => db.exec("DELETE FROM candidate_events"), /추가만 가능/);
    db.close();
  });
});

test("끝난 후보는 나중에 과거 값이 정정돼도 다시 쓰지 않는다", { skip }, async () => {
  await withDir(async (root) => {
    const paths = await setup(root, scenario({ surgeAt: 70, breakoutAt: 76 }));
    const db = openDb(paths.dbFile);
    runCandidates(db, { now: NOW });
    db.exec("UPDATE candidates SET box_top = 999"); // 끝난 후보의 기록이 보존되는지 확인용 표식
    runCandidates(db, { now: NOW });
    assert.equal(db.prepare("SELECT box_top FROM candidates").get().box_top, 999);
    db.close();
  });
});

test("봉이 80개 미만인 종목은 계산에서 제외한다", { skip }, async () => {
  await withDir(async (root) => {
    const paths = await setup(root, scenario({ n: 70, surgeAt: 62 }));
    const db = openDb(paths.dbFile);
    const summary = runCandidates(db, { now: NOW });
    assert.equal(summary.tickersSkipped, 1);
    assert.equal(summary.newCandidates, 0);
    db.close();
  });
});

test("시장 전체 폭이 날짜별로 기록되고, 다시 실행해도 행이 늘지 않는다 (기록 전용)", { skip }, async () => {
  await withDir(async (root) => {
    const paths = await setup(root, scenario({ surgeAt: 70, breakoutAt: 76 }));
    const db = openDb(paths.dbFile);
    const summary = runCandidates(db, { now: NOW });
    const rows = db.prepare("SELECT * FROM market_breadth ORDER BY date").all();
    assert.equal(rows.length, summary.breadthDates);
    assert.ok(rows.length > 0);
    const surgeDay = db.prepare("SELECT * FROM candidates").get().surge_date;
    const row = rows.find((r) => r.date === surgeDay);
    assert.equal(row.evaluated, 1); // 종목이 하나뿐인 시장
    assert.equal(row.surge, 1);
    assert.equal(row.all_pass, 1); // 그 종목이 후보 조건을 모두 통과한 날
    assert.equal(row.market_wide, 1); // 1/1 = 100% → 시장 전체 급증일로 표시된다(종목 수가 적은 시험 시장이라 당연)

    runCandidates(db, { now: NOW });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM market_breadth").get().n, rows.length);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM candidates").get().n, 1); // 후보 판단은 시장 폭과 무관하다
    db.close();
  });
});
