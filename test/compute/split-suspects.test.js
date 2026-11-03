import test from "node:test";
import assert from "node:assert/strict";
import { cp } from "node:fs/promises";
import path from "node:path";

import { hasSqlite, openDb } from "../../src/server/db.js";
import { dataPaths } from "../../src/server/paths.js";
import { receiveAll } from "../../src/server/receive.js";
import { loadSplitSuspects } from "../../src/compute/scan.js";
import { bar, makeBatch, withDir } from "../server/helpers.js";

const skip = hasSqlite ? false : "이 Node에는 node:sqlite 가 없음(22.13+ 필요)";
const scaled = (b, k) => ({ ...b, o: b.o * k, h: b.h * k, l: b.l * k, c: b.c * k });

// 폴더 이름 앞의 날짜가 수집일이다 — 그날 뉴욕 마감 뒤(22:00Z)로 시계를 맞춘다
const clockOf = (name) => new Date(`${name.slice(0, 10)}T22:00:00Z`);

async function receive(root, name, options) {
  const paths = dataPaths(path.join(root, "data"));
  await makeBatch(path.join(root, "_s", name), { now: clockOf(name), ...options });
  await cp(path.join(root, "_s", name), path.join(paths.inbox, name), { recursive: true });
  await receiveAll({ dataRoot: paths.root });
  return paths;
}

test("소급 분할 조정으로 옛 봉이 옛 스케일에 남으면 의심, backfill 로 다시 받으면 풀린다", { skip }, async () => {
  await withDir(async (root) => {
    // 1일차: 5개 봉(가격 ~10). 2일차: 최근 봉만 받았는데 가격이 1/100 로 소급 조정되어 왔다.
    const day1 = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"];
    await receive(root, "2026-11-06-backfill", { mode: "backfill", symbols: ["AXG"], barsFor: () => day1.map((d) => bar(d)) });
    const paths = await receive(root, "2026-11-09-daily", {
      symbols: ["AXG"],
      barsFor: () => ["2026-11-05", "2026-11-06", "2026-11-09"].map((d) => scaled(bar(d), 0.01)),
    });
    let db = openDb(paths.dbFile);
    assert.deepEqual([...loadSplitSuspects(db)], ["AXG"]); // 11-02~04 는 아직 옛 스케일
    db.close();

    // backfill 로 전체를 새 스케일로 다시 받음 → 옛 봉도 정정되어 의심이 풀린다
    await receive(root, "2026-11-10-backfill", {
      mode: "backfill",
      symbols: ["AXG"],
      barsFor: () => [...day1, "2026-11-09"].map((d) => scaled(bar(d), 0.01)),
    });
    db = openDb(paths.dbFile);
    assert.deepEqual([...loadSplitSuspects(db)], []);
    db.close();
  });
});

test("정상적인 소폭 정정(거래량 갱신 등)은 의심으로 보지 않는다", { skip }, async () => {
  await withDir(async (root) => {
    await receive(root, "2026-11-02-daily", { symbols: ["AAA"], barsFor: () => [bar("2026-11-02", 10.5)] });
    const paths = await receive(root, "2026-11-03-daily", {
      symbols: ["AAA"],
      barsFor: () => [bar("2026-11-02", 10.6), bar("2026-11-03")],
    });
    const db = openDb(paths.dbFile);
    assert.equal(loadSplitSuspects(db).size, 0);
    db.close();
  });
});
