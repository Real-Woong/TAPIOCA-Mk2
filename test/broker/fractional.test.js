import test from "node:test";
import assert from "node:assert/strict";

import { fractionalSummary, latestFractional, parseResult, recordFractional } from "../../src/broker/fractional.js";
import { hasSqlite, openDb } from "../../src/server/db.js";
import { withDir } from "../server/helpers.js";
import path from "node:path";

const skip = hasSqlite ? false : "이 Node에는 node:sqlite 가 없음(22.13+ 필요)";

test("사람이 쓰는 말을 OK/NO 로 바꾸고, 모르는 말은 null", () => {
  for (const t of ["ok", "OK", "가능", "y"]) assert.equal(parseResult(t), "OK");
  for (const t of ["no", "불가", "안됨"]) assert.equal(parseResult(t), "NO");
  assert.equal(parseResult("글쎄"), null);
  assert.equal(parseResult(undefined), null);
});

test("기록은 쌓이고 가장 새 줄이 현재 판단이며, 종목 코드는 대문자로 정리된다", { skip }, async () => {
  await withDir(async (root) => {
    const db = openDb(path.join(root, "t.sqlite"));
    assert.equal(latestFractional(db, "SVA"), null); // 기록이 없으면 «모름»
    assert.equal(recordFractional(db, " sva ", "NO", { note: "앱에 금액주문 없음" }), "SVA");
    assert.equal(latestFractional(db, "SVA").result, "NO");
    recordFractional(db, "SVA", "OK", { source: "ORDER" }); // 마음이 바뀌면 새 줄
    assert.equal(latestFractional(db, "SVA").result, "OK");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fractional_checks").get().n, 2); // 지우지 않는다
    db.close();
  });
});

test("요약은 종목마다 가장 새 판단만 센다, 잘못된 입력은 거부한다", { skip }, async () => {
  await withDir(async (root) => {
    const db = openDb(path.join(root, "t.sqlite"));
    recordFractional(db, "AAA", "NO");
    recordFractional(db, "AAA", "OK");
    recordFractional(db, "BBB", "NO");
    recordFractional(db, "CCC", "OK");
    assert.deepEqual(fractionalSummary(db), { ok: 2, no: 1, tickers: 3 });
    assert.throws(() => recordFractional(db, "AAA", "MAYBE"), /OK 또는 NO/);
    assert.throws(() => recordFractional(db, "AAA", "OK", { source: "소문" }), /APP 또는 ORDER/);
    assert.throws(() => recordFractional(db, "A B!", "OK"), /종목 코드/);
    db.close();
  });
});
