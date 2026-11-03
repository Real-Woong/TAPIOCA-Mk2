// 서버 수신기: 1_inbox → 검수 → 2_accepted(통과) / 3_rejected(탈락) → SQLite 적재.
//
// 다시 실행해도 안전합니다(멱등).
//  · 이미 옮긴 배치는 inbox 에 없으니 건드리지 않고,
//  · 2_accepted 에 있는데 DB에 없는 배치(적재 도중 죽은 경우)는 이번 실행에서 이어서 적재합니다.
// 배치 이름순(=날짜순)으로 처리합니다. 정정 비교가 «시간 순서»에 의존하기 때문입니다.

import { chmod, mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { isLoaded, loadBatch, openDb } from "./db.js";
import { SHELF_NOTES, dataPaths } from "./paths.js";
import { DEFAULT_MAX_MISSING_RATIO, validateBatch } from "./validate.js";

const NOTE_FILE = "_이_폴더는_무엇.txt";

async function ensureShelves(paths) {
  for (const [key, dir] of [["inbox", paths.inbox], ["accepted", paths.accepted], ["rejected", paths.rejected], ["db", paths.dbDir]]) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, NOTE_FILE), SHELF_NOTES[key]).catch(() => {});
  }
}

async function listBatchDirs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".partial") && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

const exists = (target) => stat(target).then(() => true, () => false);

/** 보관본은 고치지 못하게 파일을 읽기 전용으로 잠급니다. */
async function lockReadOnly(dir) {
  for (const name of await readdir(dir)) {
    await chmod(path.join(dir, name), 0o444).catch(() => {});
  }
}

async function moveToRejected(paths, name, errors, warnings, now) {
  let target = path.join(paths.rejected, name);
  if (await exists(target)) target = `${target}__${now.toISOString().replace(/[:.]/g, "-")}`;
  await rename(path.join(paths.inbox, name), target);
  const text = [
    `탈락한 배치: ${name}`,
    `탈락 시각: ${now.toISOString()}`,
    "",
    "탈락 이유:",
    ...errors.map((e) => `  - ${e}`),
    ...(warnings.length ? ["", "참고(경고):", ...warnings.map((w) => `  - ${w}`)] : []),
    "",
    "→ Mac mini에서 원인을 고쳐 다시 수집한 뒤, 새 이름의 폴더로 push 하세요.",
    "",
  ].join("\n");
  await writeFile(path.join(target, "REJECTED.txt"), text);
  return target;
}

/**
 * @param {object} options
 * @param {string} [options.dataRoot]   서버의 data 폴더
 * @param {boolean} [options.rebuild]   DB를 지우고 2_accepted 전체에서 다시 만듭니다
 * @returns {Promise<{results: object[], loaded: object[]}>}
 */
export async function receiveAll({
  dataRoot = "data",
  maxMissingRatio = DEFAULT_MAX_MISSING_RATIO,
  rebuild = false,
  now = new Date(),
  log = () => {},
} = {}) {
  const paths = dataPaths(dataRoot);
  await ensureShelves(paths);

  if (rebuild) {
    const { rm } = await import("node:fs/promises");
    for (const suffix of ["", "-wal", "-shm"]) await rm(paths.dbFile + suffix, { force: true });
    log("DB를 지우고 2_accepted 에서 다시 만듭니다");
  }

  const results = [];
  const cache = new Map(); // 방금 검수한 배치의 읽은 데이터를 적재에 재사용(50MB를 두 번 파싱하지 않으려고)

  // ── 1) 받은 편지함 검수
  for (const name of await listBatchDirs(paths.inbox)) {
    const validation = await validateBatch(path.join(paths.inbox, name), { maxMissingRatio });
    if (!validation.ok) {
      const where = await moveToRejected(paths, name, validation.errors, validation.warnings, now);
      results.push({ batch: name, outcome: "REJECTED", errors: validation.errors, warnings: validation.warnings, where });
      log(`✖ 탈락 ${name} — ${validation.errors[0]}`);
      continue;
    }
    if (await exists(path.join(paths.accepted, name))) {
      const errors = ["같은 이름의 배치가 이미 2_accepted 에 있습니다 — 원본은 덮어쓰지 않습니다. 새 이름으로 다시 수집하세요"];
      const where = await moveToRejected(paths, name, errors, validation.warnings, now);
      results.push({ batch: name, outcome: "REJECTED", errors, warnings: validation.warnings, where });
      log(`✖ 탈락 ${name} — ${errors[0]}`);
      continue;
    }
    await rename(path.join(paths.inbox, name), path.join(paths.accepted, name));
    await lockReadOnly(path.join(paths.accepted, name));
    cache.set(name, validation);
    log(`✔ 통과 ${name}`);
  }

  // ── 2) 아직 DB에 없는 보관본을 날짜순으로 적재
  const db = openDb(paths.dbFile);
  const loaded = [];
  try {
    for (const name of await listBatchDirs(paths.accepted)) {
      if (isLoaded(db, name)) continue;
      const validation = cache.get(name) ?? (await validateBatch(path.join(paths.accepted, name), { maxMissingRatio: 1 }));
      if (!validation.ok) {
        // 보관본이 깨졌다 — 조용히 넘어가지 않고 실패로 알립니다(원본 변조 의심)
        results.push({ batch: name, outcome: "ACCEPTED_BROKEN", errors: validation.errors, warnings: [] });
        log(`✖ 보관본 이상 ${name} — ${validation.errors[0]}`);
        continue;
      }
      const stats = loadBatch(db, { batch: name, data: validation.data, now });
      loaded.push({ batch: name, ...stats });
      results.push({ batch: name, outcome: "LOADED", warnings: validation.warnings, stats });
      log(`✔ 적재 ${name} — 새 봉 ${stats.barsInserted}, 그대로 ${stats.barsUnchanged}, 정정 ${stats.corrections}`);
    }
  } finally {
    db.close();
  }
  return { results, loaded };
}
