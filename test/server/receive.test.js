import test from "node:test";
import assert from "node:assert/strict";
import { cp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { hasSqlite, openDb } from "../../src/server/db.js";
import { dataPaths } from "../../src/server/paths.js";
import { receiveAll } from "../../src/server/receive.js";
import { bar, makeBatch, withDir } from "./helpers.js";

const skip = hasSqlite ? false : "이 Node에는 node:sqlite 가 없음(22.13+ 필요)";
const exists = (p) => stat(p).then(() => true, () => false);

/** 만든 배치를 서버 inbox 에 «올린 것처럼» 복사한다. */
async function putInInbox(root, name, options) {
  const staging = path.join(root, "_staging", name);
  await makeBatch(staging, options);
  const paths = dataPaths(path.join(root, "data"));
  await cp(staging, path.join(paths.inbox, name), { recursive: true });
  return paths;
}

const mkInbox = async (root) => {
  const paths = dataPaths(path.join(root, "data"));
  await receiveAll({ dataRoot: paths.root }); // 선반 폴더 생성
  return paths;
};

test("통과한 배치는 2_accepted 로 옮겨지고 DB에 적재된다", { skip }, async () => {
  await withDir(async (root) => {
    await mkInbox(root);
    const paths = await putInInbox(root, "2026-11-03-daily");
    const { results, loaded } = await receiveAll({ dataRoot: paths.root });

    assert.equal(results[0].outcome, "LOADED");
    assert.equal(loaded[0].barsInserted, 4); // 2종목 × 2봉
    assert.equal(await exists(path.join(paths.inbox, "2026-11-03-daily")), false);
    assert.equal(await exists(path.join(paths.accepted, "2026-11-03-daily", "manifest.json")), true);

    const db = openDb(paths.dbFile);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM latest_bars").get().n, 4);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM universe").get().n, 2);
    db.close();
  });
});

test("보관본 파일은 읽기 전용으로 잠긴다", { skip }, async () => {
  await withDir(async (root) => {
    await mkInbox(root);
    const paths = await putInInbox(root, "2026-11-03-daily");
    await receiveAll({ dataRoot: paths.root });
    const mode = (await stat(path.join(paths.accepted, "2026-11-03-daily", "bars.jsonl"))).mode & 0o777;
    assert.equal(mode, 0o444);
  });
});

test("깨진 배치는 3_rejected 로 가고 REJECTED.txt 에 이유가 남으며 DB는 비어 있다", { skip }, async () => {
  await withDir(async (root) => {
    await mkInbox(root);
    const paths = await putInInbox(root, "2026-11-03-daily");
    const bars = path.join(paths.inbox, "2026-11-03-daily", "bars.jsonl");
    await writeFile(bars, "{}\n"); // 해시 불일치

    const { results } = await receiveAll({ dataRoot: paths.root });
    assert.equal(results[0].outcome, "REJECTED");
    const reason = await readFile(path.join(paths.rejected, "2026-11-03-daily", "REJECTED.txt"), "utf8");
    assert.match(reason, /sha256/);
    assert.equal(await exists(path.join(paths.accepted, "2026-11-03-daily")), false);
    const db = openDb(paths.dbFile);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bars").get().n, 0);
    db.close();
  });
});

test("전송 중(.partial) 폴더는 건드리지 않는다", { skip }, async () => {
  await withDir(async (root) => {
    await mkInbox(root);
    const paths = await putInInbox(root, "2026-11-03-daily.partial");
    const { results } = await receiveAll({ dataRoot: paths.root });
    assert.equal(results.length, 0);
    assert.equal(await exists(path.join(paths.inbox, "2026-11-03-daily.partial")), true);
  });
});

test("다시 실행해도 중복 적재되지 않는다(멱등)", { skip }, async () => {
  await withDir(async (root) => {
    await mkInbox(root);
    const paths = await putInInbox(root, "2026-11-03-daily");
    await receiveAll({ dataRoot: paths.root });
    const second = await receiveAll({ dataRoot: paths.root });
    assert.equal(second.results.length, 0);
    const db = openDb(paths.dbFile);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM batches").get().n, 1);
    db.close();
  });
});

test("겹치는 봉이 같으면 다시 저장하지 않고, 값이 바뀌면 새 줄과 정정 기록이 남는다", { skip }, async () => {
  await withDir(async (root) => {
    await mkInbox(root);
    const paths = await putInInbox(root, "2026-11-02-daily", {
      barsFor: () => [bar("2026-11-02", 10.5)],
    });
    await receiveAll({ dataRoot: paths.root });

    // 다음 날: 11-02 봉은 같은 값(AAA)·정정된 값(BBB), 11-03 은 새 봉
    const staging = path.join(root, "_staging", "2026-11-03-daily");
    await makeBatch(staging, {
      barsFor: (symbol) => [bar("2026-11-02", symbol === "BBB" ? 10.75 : 10.5), bar("2026-11-03")],
    });
    await cp(staging, path.join(paths.inbox, "2026-11-03-daily"), { recursive: true });
    const { loaded } = await receiveAll({ dataRoot: paths.root });

    assert.equal(loaded[0].barsUnchanged, 1); // AAA 11-02
    assert.equal(loaded[0].corrections, 1); // BBB 11-02 의 c
    assert.equal(loaded[0].barsInserted, 3); // AAA 11-03, BBB 11-03, BBB 11-02(정정)

    const db = openDb(paths.dbFile);
    assert.equal(db.prepare("SELECT c FROM latest_bars WHERE ticker='BBB' AND date='2026-11-02'").get().c, 10.75);
    const correction = db.prepare("SELECT * FROM bar_corrections").get();
    assert.deepEqual([correction.ticker, correction.field, correction.old_value, correction.new_value], ["BBB", "c", 10.5, 10.75]);
    db.close();
  });
});

test("가격은 소수 4자리로 반올림해 저장한다(Yahoo 32비트 꼬리 제거)", { skip }, async () => {
  await withDir(async (root) => {
    await mkInbox(root);
    const paths = await putInInbox(root, "2026-11-03-daily", {
      barsFor: () => [{ date: "2026-11-03", o: 12.390000343322754, h: 12.5, l: 12, c: 12.4, v: 5 }],
    });
    await receiveAll({ dataRoot: paths.root });
    const db = openDb(paths.dbFile);
    assert.equal(db.prepare("SELECT o FROM latest_bars WHERE ticker='AAA'").get().o, 12.39);
    db.close();
  });
});

test("--rebuild 는 DB를 지우고 2_accepted 에서 같은 내용을 다시 만든다", { skip }, async () => {
  await withDir(async (root) => {
    await mkInbox(root);
    const paths = await putInInbox(root, "2026-11-03-daily");
    await receiveAll({ dataRoot: paths.root });
    const again = await receiveAll({ dataRoot: paths.root, rebuild: true });
    assert.equal(again.loaded.length, 1);
    const db = openDb(paths.dbFile);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM latest_bars").get().n, 4);
    db.close();
  });
});

test("선반 폴더가 번호 순서로 만들어진다", { skip }, async () => {
  await withDir(async (root) => {
    const paths = await mkInbox(root);
    assert.deepEqual((await readdir(paths.root)).sort(), ["1_inbox", "2_accepted", "3_rejected", "4_db"]);
  });
});
