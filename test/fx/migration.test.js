import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { hasSqlite, openDb } from "../../src/server/db.js";

const skip = hasSqlite ? false : "이 Node에는 node:sqlite 가 없음(22.13+ 필요)";

/** 달러 장부(스키마 4)였던 DB 를 만든다: 새 DB 를 연 뒤 모의매매 표를 옛 모양으로 바꾸고 버전을 4 로 되돌린다. */
async function oldDb(dir, { withTrade }) {
  const file = path.join(dir, "old.sqlite");
  openDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec("DROP TABLE paper_equity; DROP TABLE paper_trades; DROP TABLE paper_orders; DROP TABLE paper_state;");
  raw.exec("CREATE TABLE paper_trades (candidate_id TEXT PRIMARY KEY, qty INTEGER); CREATE TABLE paper_state (id INTEGER PRIMARY KEY, cash REAL);");
  if (withTrade) raw.exec("INSERT INTO paper_trades VALUES ('x', 9)");
  raw.exec("PRAGMA user_version = 4");
  raw.close();
  return file;
}

test("모의 거래가 없는 달러 장부는 원화 장부로 자동 이전된다", { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tapioca-mig-"));
  try {
    const db = openDb(await oldDb(dir, { withTrade: false }));
    const columns = db.prepare("PRAGMA table_info(paper_trades)").all().map((c) => c.name);
    assert.ok(columns.includes("cost_krw") && columns.includes("fx_entry"));
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 8);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("모의 거래가 이미 있으면 기록을 지우지 않고 멈춘다", { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tapioca-mig-"));
  try {
    const file = await oldDb(dir, { withTrade: true });
    assert.throws(() => openDb(file), /자동으로 이전하지 않습니다|원화 장부로 자동 이전하지 않습니다/);
    const raw = new DatabaseSync(file);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM paper_trades").get().n, 1); // 그대로 남아 있다
    raw.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
