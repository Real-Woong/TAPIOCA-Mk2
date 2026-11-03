import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { findBarProblem, validateBatch } from "../../src/server/validate.js";
import { bar, makeBatch, withDir } from "./helpers.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");

/** bars.jsonl 을 고치고 manifest 해시·줄 수도 맞춰서, «해시는 맞는데 내용이 이상한» 배치를 만든다. */
async function rewriteBars(dir, mutate) {
  const file = path.join(dir, "bars.jsonl");
  const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const next = mutate(lines);
  const text = next.map((l) => JSON.stringify(l)).join("\n") + "\n";
  await writeFile(file, text);
  const manifestFile = path.join(dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.files.bars.sha256 = sha(text);
  manifest.files.bars.lines = next.length;
  manifest.counts.ok = next.length;
  await writeFile(manifestFile, JSON.stringify(manifest));
}

test("정상 배치는 통과한다", async () => {
  await withDir(async (dir) => {
    await makeBatch(dir);
    const result = await validateBatch(dir);
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
    assert.equal(result.data.lines.length, 2);
  });
});

test("manifest 가 없으면(수집이 안 끝난 배치) 탈락", async () => {
  await withDir(async (dir) => {
    await makeBatch(dir);
    await rm(path.join(dir, "manifest.json"));
    const result = await validateBatch(dir);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /manifest\.json/);
  });
});

test("bars.jsonl 이 한 글자라도 바뀌면 해시 불일치로 탈락", async () => {
  await withDir(async (dir) => {
    await makeBatch(dir);
    const file = path.join(dir, "bars.jsonl");
    await writeFile(file, (await readFile(file, "utf8")).replace('"v":1000', '"v":1001'));
    const result = await validateBatch(dir);
    assert.equal(result.ok, false);
    assert.match(result.errors.join(), /sha256/);
  });
});

test("ABORTED 는 받지 않는다", async () => {
  await withDir(async (dir) => {
    await makeBatch(dir);
    const file = path.join(dir, "manifest.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.status = "ABORTED";
    await writeFile(file, JSON.stringify(manifest));
    const result = await validateBatch(dir);
    assert.equal(result.ok, false);
    assert.match(result.errors.join(), /ABORTED/);
  });
});

test("PARTIAL 은 허용 비율 안이면 받고 경고를 남긴다, 넘으면 탈락", async () => {
  await withDir(async (dir) => {
    const symbols = Array.from({ length: 100 }, (_, i) => `T${String(i).padStart(3, "0")}`);
    await makeBatch(dir, { symbols, barsFor: (s) => (s === "T000" ? null : [bar("2026-11-02"), bar("2026-11-03")]) });
    const lenient = await validateBatch(dir, { maxMissingRatio: 0.02 });
    assert.equal(lenient.ok, true);
    assert.match(lenient.warnings.join(), /PARTIAL/);
    const strict = await validateBatch(dir, { maxMissingRatio: 0.005 });
    assert.equal(strict.ok, false);
    assert.match(strict.errors.join(), /허용/);
  });
});

test("해시는 맞아도 봉 내용이 모순이면(고가<종가) 탈락", async () => {
  await withDir(async (dir) => {
    await makeBatch(dir);
    await rewriteBars(dir, (lines) => {
      lines[0].bars[0].h = 5;
      return lines;
    });
    const result = await validateBatch(dir);
    assert.equal(result.ok, false);
    assert.match(result.errors.join(), /AAA/);
  });
});

test("해시는 맞아도 같은 종목이 두 줄이면 탈락", async () => {
  await withDir(async (dir) => {
    await makeBatch(dir);
    await rewriteBars(dir, (lines) => [...lines, lines[0]]);
    const result = await validateBatch(dir);
    assert.equal(result.ok, false);
  });
});

test("findBarProblem: 날짜 순서·음수 가격·거래량을 잡는다", () => {
  assert.equal(findBarProblem([bar("2026-11-02"), bar("2026-11-03")]), null);
  assert.match(findBarProblem([bar("2026-11-03"), bar("2026-11-02")]), /오름차순/);
  assert.match(findBarProblem([{ ...bar("2026-11-02"), c: -1 }]), /c 값/);
  assert.match(findBarProblem([{ ...bar("2026-11-02"), v: -5 }]), /거래량/);
});
