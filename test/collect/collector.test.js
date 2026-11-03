import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { collect } from "../../src/collect/collector.js";
import { dropIncompleteBars } from "../../src/collect/session.js";
import { BlockedError, NotFoundError } from "../../src/collect/sources.js";

// 2026-11-03(화) 뉴욕 17:00 — 서머타임이 끝난 뒤라 UTC-5. 오늘 봉이 확정된 시각이다.
const AFTER_CLOSE = new Date("2026-11-03T22:00:00Z");
// 같은 날 뉴욕 13:00 — 장중. 오늘 봉은 아직 미완성이다.
const DURING_SESSION = new Date("2026-11-03T18:00:00Z");

const bar = (date) => ({ date, o: 10, h: 11, l: 9, c: 10.5, v: 1000 });
const days = (...dates) => dates.map(bar);
const universeOf = (...symbols) => ({ included: symbols.map((symbol) => ({ symbol })), excluded: [] });
const noSleep = async () => {};

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "screener-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const base = (dir, extra) => ({
  mode: "daily",
  source: "fake",
  outDir: dir,
  now: AFTER_CLOSE,
  sleep: noSleep,
  ...extra,
});

test("장중에 받은 오늘 봉은 버리고, 마감 뒤에는 남긴다", () => {
  const bars = days("2026-11-02", "2026-11-03");
  assert.deepEqual(dropIncompleteBars(bars, DURING_SESSION).bars.map((b) => b.date), ["2026-11-02"]);
  assert.equal(dropIncompleteBars(bars, AFTER_CLOSE).bars.length, 2);
});

test("전부 받으면 COMPLETE이고 manifest가 파일 내용과 맞는다", async () => {
  await withDir(async (dir) => {
    const manifest = await collect(base(dir, {
      universe: universeOf("AAA", "BBB", "CCC"),
      fetchBarsImpl: async () => ({ bars: days("2026-11-02", "2026-11-03"), adjustment: "x" }),
    }));
    assert.equal(manifest.status, "COMPLETE");
    assert.equal(manifest.asOf, "2026-11-03");
    assert.equal(manifest.counts.ok, 3);
    assert.equal(manifest.counts.atAsOf, 3);
    assert.equal(manifest.files.bars.lines, 3);

    const onDisk = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    assert.equal(onDisk.files.bars.sha256, manifest.files.bars.sha256);
  });
});

test("장중에 돌리면 오늘 봉이 빠지고 그 개수가 기록된다", async () => {
  await withDir(async (dir) => {
    const manifest = await collect(base(dir, {
      now: DURING_SESSION,
      universe: universeOf("AAA"),
      fetchBarsImpl: async () => ({ bars: days("2026-11-02", "2026-11-03"), adjustment: "x" }),
    }));
    assert.equal(manifest.asOf, "2026-11-02");
    assert.equal(manifest.counts.barsDroppedIncomplete, 1);
  });
});

test("없는 종목이 있으면 PARTIAL이고 사유별로 센다", async () => {
  await withDir(async (dir) => {
    const manifest = await collect(base(dir, {
      universe: universeOf("AAA", "GONE"),
      fetchBarsImpl: async (symbol) => {
        if (symbol === "GONE") throw new NotFoundError("HTTP 404");
        return { bars: days("2026-11-03"), adjustment: "x" };
      },
    }));
    assert.equal(manifest.status, "PARTIAL");
    assert.equal(manifest.counts.missing, 1);
    assert.equal(manifest.counts.notFound, 1);
  });
});

test("마지막 봉이 기준일이 아닌 종목(거래 정지 등)은 stale로 갈라 센다", async () => {
  await withDir(async (dir) => {
    const manifest = await collect(base(dir, {
      universe: universeOf("AAA", "BBB", "HALT"),
      fetchBarsImpl: async (symbol) => ({
        bars: symbol === "HALT" ? days("2026-10-20") : days("2026-11-03"),
        adjustment: "x",
      }),
    }));
    assert.equal(manifest.counts.atAsOf, 2);
    assert.equal(manifest.counts.stale, 1);
    assert.deepEqual(manifest.staleTickers, [{ ticker: "HALT", last: "2026-10-20" }]);
  });
});

test("daily는 최근 5봉만 싣고 backfill은 전부 싣는다", async () => {
  await withDir(async (dir) => {
    const many = days("2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28");
    await collect(base(path.join(dir, "d"), { universe: universeOf("AAA"), fetchBarsImpl: async () => ({ bars: many, adjustment: "x" }) }));
    await collect(base(path.join(dir, "b"), { mode: "backfill", universe: universeOf("AAA"), fetchBarsImpl: async () => ({ bars: many, adjustment: "x" }) }));
    const line = async (sub) => JSON.parse((await readFile(path.join(dir, sub, "bars.jsonl"), "utf8")).trim());
    assert.equal((await line("d")).bars.length, 5);
    assert.equal((await line("b")).bars.length, 7);
  });
});

test("일시 오류는 다시 시도하고, 재시도가 다 떨어지면 RETRY_EXHAUSTED로 남긴다", async () => {
  await withDir(async (dir) => {
    let calls = 0;
    const manifest = await collect(base(path.join(dir, "ok"), {
      universe: universeOf("AAA"),
      retries: 2,
      fetchBarsImpl: async () => {
        calls += 1;
        if (calls < 3) throw new Error("timeout");
        return { bars: days("2026-11-03"), adjustment: "x" };
      },
    }));
    assert.equal(manifest.status, "COMPLETE");
    assert.equal(calls, 3);

    const failed = await collect(base(path.join(dir, "bad"), {
      universe: universeOf("AAA"),
      retries: 1,
      fetchBarsImpl: async () => { throw new Error("timeout"); },
    }));
    assert.equal(failed.counts.retryExhausted, 1);
  });
});

test("연속 차단이 쌓이면 중단하고 ABORTED로 남긴다 — 못 해 본 종목은 notAttempted다", async () => {
  await withDir(async (dir) => {
    const manifest = await collect(base(dir, {
      universe: universeOf("A", "B", "C", "D", "E"),
      maxConsecutiveBlocks: 3,
      fetchBarsImpl: async () => { throw new BlockedError("HTTP 429"); },
    }));
    assert.equal(manifest.status, "ABORTED");
    assert.equal(manifest.counts.blocked, 3);
    assert.equal(manifest.counts.notAttempted, 2);
    // 중단돼도 manifest는 있다 — 없으면 Oracle은 이 배치가 무엇인지 모른다
    await readFile(path.join(dir, "manifest.json"), "utf8");
  });
});

test("중단된 배치를 같은 폴더로 이어서 하면 받은 종목은 건너뛴다", async () => {
  await withDir(async (dir) => {
    let phase = 1;
    const asked = [];
    const fetchBarsImpl = async (symbol) => {
      asked.push(symbol);
      if (phase === 1 && symbol !== "A") throw new BlockedError("HTTP 429");
      return { bars: days("2026-11-03"), adjustment: "x" };
    };
    const universe = universeOf("A", "B", "C", "D", "E");

    const first = await collect(base(dir, { universe, fetchBarsImpl, maxConsecutiveBlocks: 3 }));
    assert.equal(first.status, "ABORTED");

    phase = 2;
    asked.length = 0;
    const second = await collect(base(dir, { universe, fetchBarsImpl }));
    assert.equal(second.status, "COMPLETE");
    assert.deepEqual(asked, ["B", "C", "D", "E"]); // A는 다시 받지 않는다
    assert.equal(second.counts.ok, 5);
  });
});

test("이어서 할 때는 처음 정한 대상 목록을 쓴다 — 목록이 바뀌어도 manifest가 거짓이 되지 않는다", async () => {
  await withDir(async (dir) => {
    const fetchBarsImpl = async () => ({ bars: days("2026-11-03"), adjustment: "x" });
    await collect(base(dir, { universe: universeOf("A", "B"), fetchBarsImpl }));
    const again = await collect(base(dir, { universe: universeOf("A", "B", "NEW"), fetchBarsImpl }));
    assert.equal(again.counts.requested, 2);
  });
});
