import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { fetchEcosRates, rateOn, refreshRates, saveRates } from "../../src/fx/fx.js";
import { hasSqlite, openDb } from "../../src/server/db.js";

const skip = hasSqlite ? false : "이 Node에는 node:sqlite 가 없음(22.13+ 필요)";

const ecos = (rows) => async () => ({ ok: true, status: 200, json: async () => ({ StatisticSearch: { row: rows } }) });
const row = (t, v) => ({ TIME: t, DATA_VALUE: String(v) });

test("ECOS 응답을 날짜 오름차순 {date, rate} 로 바꾼다", async () => {
  const rates = await fetchEcosRates({ fetchImpl: ecos([row("20261030", 1401.5), row("20261029", 1399.2)]), apiKey: "k" });
  assert.deepEqual(rates, [{ date: "2026-10-29", rate: 1399.2 }, { date: "2026-10-30", rate: 1401.5 }]);
});

test("값이 이상한 행은 버리고, 읽을 수 있는 게 없으면 던진다", async () => {
  const rates = await fetchEcosRates({ fetchImpl: ecos([row("20261029", "abc"), row("2026", 1), row("20261030", 1400)]), apiKey: "k" });
  assert.deepEqual(rates, [{ date: "2026-10-30", rate: 1400 }]);
  await assert.rejects(fetchEcosRates({ fetchImpl: ecos([row("20261029", "abc")]), apiKey: "k" }), /읽을 수 있는 환율/);
});

test("ECOS 가 오류를 주면 사유를 알려 준다", async () => {
  const empty = async () => ({ ok: true, status: 200, json: async () => ({ RESULT: { MESSAGE: "INFO-200 해당하는 데이터가 없습니다.\n상세" } }) });
  await assert.rejects(fetchEcosRates({ fetchImpl: empty, apiKey: "k" }), /해당하는 데이터가 없습니다/);
  const down = async () => ({ ok: false, status: 503 });
  await assert.rejects(fetchEcosRates({ fetchImpl: down, apiKey: "k" }), /HTTP 503/);
});

test("연결 오류 문구에 API 키가 새지 않는다", async () => {
  const boom = async () => {
    throw Object.assign(new TypeError("fetch failed https://ecos.bok.or.kr/api/StatisticSearch/SECRETKEY/json"), { cause: { code: "ECONNRESET" } });
  };
  await assert.rejects(fetchEcosRates({ fetchImpl: boom, apiKey: "SECRETKEY" }), (e) => /ECONNRESET/.test(e.message) && !e.message.includes("SECRETKEY"));
});

async function withDb(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "tapioca-fx-"));
  const db = openDb(path.join(dir, "t.sqlite"));
  try {
    await fn(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("저장은 같은 날짜를 덮어쓴다 (확정 전 값이 정정될 수 있다)", { skip }, async () => {
  await withDb((db) => {
    saveRates(db, [{ date: "2026-10-29", rate: 1399 }]);
    saveRates(db, [{ date: "2026-10-29", rate: 1400 }, { date: "2026-10-30", rate: 1401 }]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM fx_rates").get().n, 2);
    assert.equal(rateOn(db, "2026-10-29").rate, 1400);
  });
});

test("환율은 그날 값, 없으면 직전 영업일 값 (주말·휴일), 7일 넘게 비면 없음", { skip }, async () => {
  await withDb((db) => {
    saveRates(db, [{ date: "2026-10-30", rate: 1401 }]); // 금요일
    assert.deepEqual(rateOn(db, "2026-10-30"), { rate: 1401, date: "2026-10-30" });
    assert.deepEqual(rateOn(db, "2026-11-01"), { rate: 1401, date: "2026-10-30" }); // 일요일 → 금요일 값
    assert.equal(rateOn(db, "2026-11-06").rate, 1401); // 정확히 7일
    assert.equal(rateOn(db, "2026-11-07"), null); // 8일 — 낡은 값을 쓰지 않는다
    assert.equal(rateOn(db, "2026-10-29"), null); // 이전 값이 없다
  });
});

test("refreshRates: 받아서 저장하고 가장 최근 값을 알려 준다", { skip }, async () => {
  await withDb(async (db) => {
    const result = await refreshRates(db, { fetchImpl: ecos([row("20261029", 1399), row("20261030", 1401)]), apiKey: "k", now: new Date("2026-10-30T03:00:00Z") });
    assert.equal(result.saved, 2);
    assert.deepEqual(result.latest, { date: "2026-10-30", rate: 1401 });
  });
});
