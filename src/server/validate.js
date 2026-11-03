// 배치 하나를 «받아도 되는가» 검사합니다. 파일만 읽고 아무것도 바꾸지 않습니다(SQLite도 안 씁니다).
//
// 원칙: 수집기가 이미 걸렀다고 믿지 않고, 파일에 실제로 있는 것을 다시 셉니다.
// 하나라도 어긋나면 errors 에 쌓고 ok=false — 그 배치는 통째로 3_rejected 로 갑니다.
// (일부만 받는 «반쯤 받기»는 하지 않습니다. 종목별 부분 누락은 PARTIAL 허용치로만 다룹니다.)

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const SUPPORTED_FORMAT_VERSION = 1;
export const ACCEPTED_STATUSES = new Set(["COMPLETE", "PARTIAL"]);
/** PARTIAL 에서 빠진 종목이 대상의 이 비율을 넘으면 탈락시킵니다. */
export const DEFAULT_MAX_MISSING_RATIO = 0.02;
/** 기준일이 수집일보다 이만큼(일) 넘게 옛날이면 경고합니다(주말·휴장 감안). */
const STALE_ASOF_WARN_DAYS = 5;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

/** 봉 한 줄 묶음의 문제를 찾아 첫 문제를 문자열로 돌려줍니다. 없으면 null. */
export function findBarProblem(bars) {
  let previous = null;
  for (const bar of bars) {
    if (typeof bar?.date !== "string" || !DATE_RE.test(bar.date)) return `날짜 형식이 이상합니다: ${bar?.date}`;
    if (previous && bar.date <= previous) return `날짜가 오름차순이 아닙니다: ${previous} → ${bar.date}`;
    previous = bar.date;
    for (const key of ["o", "h", "l", "c"]) {
      if (!isNum(bar[key]) || bar[key] <= 0) return `${bar.date} ${key} 값이 이상합니다: ${bar[key]}`;
    }
    if (!isNum(bar.v) || bar.v < 0) return `${bar.date} 거래량이 이상합니다: ${bar.v}`;
    if (bar.h < Math.max(bar.o, bar.c, bar.l) || bar.l > Math.min(bar.o, bar.c, bar.h)) {
      return `${bar.date} 고가·저가가 시가·종가와 모순입니다`;
    }
    if (bar.ac !== undefined && bar.ac !== null && (!isNum(bar.ac) || bar.ac <= 0)) return `${bar.date} ac 값이 이상합니다: ${bar.ac}`;
  }
  return null;
}

function parseJsonl(text, fileName, errors) {
  const rows = [];
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  lines.forEach((line, index) => {
    try {
      rows.push(JSON.parse(line));
    } catch {
      errors.push(`${fileName} ${index + 1}번째 줄이 JSON이 아닙니다`);
    }
  });
  return rows;
}

/**
 * @param {string} dir 배치 폴더
 * @returns {Promise<{ok:boolean, errors:string[], warnings:string[], data:null|{manifest:object, manifestSha256:string, universe:object, lines:object[], failures:object[]}}>}
 */
export async function validateBatch(dir, { maxMissingRatio = DEFAULT_MAX_MISSING_RATIO } = {}) {
  const errors = [];
  const warnings = [];
  const done = () => ({ ok: errors.length === 0, errors, warnings, data: null });

  // ① manifest 는 수집이 «끝난 뒤» 마지막에 쓰입니다. 없으면 미완성 배치입니다.
  let manifestBuffer;
  let manifest;
  try {
    manifestBuffer = await readFile(path.join(dir, "manifest.json"));
    manifest = JSON.parse(manifestBuffer.toString("utf8"));
  } catch (error) {
    errors.push(`manifest.json 을 읽을 수 없습니다(${error.code ?? error.message}) — 수집이 끝나지 않았거나 전송이 덜 된 배치입니다`);
    return done();
  }

  if (manifest.formatVersion !== SUPPORTED_FORMAT_VERSION) {
    errors.push(`지원하지 않는 formatVersion 입니다: ${manifest.formatVersion} (지원 ${SUPPORTED_FORMAT_VERSION})`);
  }
  if (!ACCEPTED_STATUSES.has(manifest.status)) {
    errors.push(`상태가 ${manifest.status} 입니다 — COMPLETE/PARTIAL 만 받습니다(ABORTED 는 이어서 받은 뒤 다시 올리세요)`);
  }
  if (!["backfill", "daily"].includes(manifest.mode)) errors.push(`mode 가 이상합니다: ${manifest.mode}`);
  if (typeof manifest.source !== "string" || !manifest.source) errors.push("source 가 없습니다");
  if (!DATE_RE.test(manifest.asOf ?? "")) errors.push(`기준일(asOf)이 이상합니다: ${manifest.asOf}`);
  if (!DATE_RE.test(manifest.runDate ?? "")) errors.push(`수집일(runDate)이 이상합니다: ${manifest.runDate}`);
  if (!manifest.files?.universe?.sha256 || !manifest.files?.bars?.sha256) errors.push("manifest 에 파일 해시가 없습니다");
  if (errors.length) return done();

  // ② 파일 해시 — 전송 중 깨졌거나 누가 고쳤다면 여기서 걸립니다.
  const readChecked = async (entry) => {
    let buffer;
    try {
      buffer = await readFile(path.join(dir, entry.name));
    } catch (error) {
      errors.push(`${entry.name} 을 읽을 수 없습니다(${error.code ?? error.message})`);
      return null;
    }
    if (sha256(buffer) !== entry.sha256) {
      errors.push(`${entry.name} 의 sha256 이 manifest 와 다릅니다 — 전송 중 깨졌거나 수정된 파일입니다`);
      return null;
    }
    return buffer;
  };
  const universeBuffer = await readChecked(manifest.files.universe);
  const barsBuffer = await readChecked(manifest.files.bars);
  if (!universeBuffer || !barsBuffer) return done();

  let universe;
  try {
    universe = JSON.parse(universeBuffer.toString("utf8"));
  } catch {
    errors.push("universe.json 이 JSON이 아닙니다");
    return done();
  }
  const universeSymbols = new Set((universe.symbols ?? []).map((entry) => entry.symbol));

  // ③ 줄 수·건수가 서로 맞아야 합니다.
  const lines = parseJsonl(barsBuffer.toString("utf8"), "bars.jsonl", errors);
  if (errors.length) return done();
  if (lines.length !== manifest.files.bars.lines) errors.push(`bars.jsonl 줄 수 ${lines.length} ≠ manifest ${manifest.files.bars.lines}`);
  if (manifest.counts?.ok !== lines.length) errors.push(`counts.ok ${manifest.counts?.ok} ≠ 실제 종목 수 ${lines.length}`);
  if (universe.count !== universeSymbols.size || manifest.counts?.requested !== universe.count) {
    errors.push(`대상 수가 어긋납니다 — universe ${universeSymbols.size}/${universe.count}, manifest ${manifest.counts?.requested}`);
  }

  // ④ 종목별 검사
  const seen = new Set();
  let badBars = 0;
  for (const line of lines) {
    if (typeof line.ticker !== "string" || !universeSymbols.has(line.ticker)) {
      errors.push(`대상 목록에 없는 종목입니다: ${line.ticker}`);
      continue;
    }
    if (seen.has(line.ticker)) errors.push(`종목이 중복입니다: ${line.ticker}`);
    seen.add(line.ticker);
    if (line.source !== manifest.source) errors.push(`${line.ticker}: source ${line.source} ≠ manifest ${manifest.source}`);
    if (!Array.isArray(line.bars) || line.bars.length === 0) {
      errors.push(`${line.ticker}: 봉이 없습니다`);
      continue;
    }
    if (!Number.isFinite(Date.parse(line.fetchedAt ?? ""))) errors.push(`${line.ticker}: fetchedAt 이 이상합니다`);
    const problem = findBarProblem(line.bars);
    if (problem) {
      badBars += 1;
      if (badBars <= 5) errors.push(`${line.ticker}: ${problem}`);
    }
    if (line.bars.at(-1).date > manifest.runDate) errors.push(`${line.ticker}: 수집일(${manifest.runDate})보다 미래의 봉이 있습니다`);
  }
  if (badBars > 5) errors.push(`… 봉에 문제가 있는 종목이 ${badBars}개입니다(위에는 5개만)`);

  // ⑤ 얼마나 빠져도 받을지는 여기서 정합니다(수집기의 COMPLETE/PARTIAL 은 «사실»만 말합니다)
  const requested = manifest.counts?.requested ?? 0;
  const missing = requested - lines.length;
  if (requested > 0 && missing / requested > maxMissingRatio) {
    errors.push(`빠진 종목이 ${missing}/${requested} (${((missing / requested) * 100).toFixed(1)}%) — 허용 ${(maxMissingRatio * 100).toFixed(1)}% 초과`);
  }
  if (manifest.asOf > manifest.runDate) errors.push(`기준일(${manifest.asOf})이 수집일(${manifest.runDate})보다 미래입니다`);
  const ageDays = (Date.parse(manifest.runDate) - Date.parse(manifest.asOf)) / 86_400_000;
  if (ageDays > STALE_ASOF_WARN_DAYS) warnings.push(`기준일(${manifest.asOf})이 수집일(${manifest.runDate})보다 ${ageDays}일 전입니다 — 휴장이 길었거나 소스가 낡았을 수 있습니다`);
  if (manifest.counts?.stale > 0) warnings.push(`기준일 봉이 없는(stale) 종목 ${manifest.counts.stale}개 — 계산에서 제외됩니다`);
  if (manifest.status === "PARTIAL") warnings.push(`PARTIAL: ${missing}개 종목이 빠졌습니다(허용 범위 안)`);

  // failures.jsonl 은 기록용이라 없어도 되지만, 있으면 같이 보관·적재합니다.
  let failures = [];
  try {
    failures = parseJsonl(await readFile(path.join(dir, "failures.jsonl"), "utf8"), "failures.jsonl", errors);
  } catch (error) {
    if (error.code !== "ENOENT") errors.push(`failures.jsonl 을 읽을 수 없습니다(${error.code ?? error.message})`);
  }

  if (errors.length) return done();
  return {
    ok: true,
    errors,
    warnings,
    data: { manifest, manifestSha256: sha256(manifestBuffer), universe, lines, failures },
  };
}
