import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { hasSqlite, openDb } from "../../src/server/db.js";
import { withDir } from "./helpers.js";

const skip = hasSqlite ? false : "이 Node에는 node:sqlite 가 없음(22.13+ 필요)";

test("DB 폴더가 없으면 «서버에서 실행하세요» 로 안내한다 (다른 기기에서 서버 명령을 돌린 경우)", { skip }, async () => {
  await withDir(async (dir) => {
    assert.throws(() => openDb(path.join(dir, "data", "4_db", "tapioca.sqlite")), /서버\(Oracle\)에서 실행하세요/);
  });
});
