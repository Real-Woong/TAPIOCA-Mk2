import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BlockedError,
  NotFoundError,
  cleanBars,
  fetchBarsFrom,
} from "./sources.js";
import { dropIncompleteBars } from "./session.js";

// Mac mini에서 도는 수집기입니다. «받아서 포장하기»만 하고 지표나 판정은 계산하지 않습니다.
// 한 번의 실행이 폴더 하나(배치)를 만듭니다:
//
//   universe.json   수집 대상과 제외 이유
//   bars.jsonl      종목당 한 줄 — 받은 봉 그대로(정리만 함)
//   failures.jsonl  못 받은 종목과 이유 (재시도하면 같은 종목이 여러 줄일 수 있다)
//   manifest.json   «이 묶음이 무엇이고 완전한가» — **마지막에** 쓴다
//
// manifest가 없으면 Oracle은 그 배치를 받지 않습니다. 중간에 죽어도 불완전한 배치가
// 완전한 척 들어가지 못하게 하는 장치입니다.
export const COLLECTOR_FORMAT_VERSION = 1;

// 매일 수집은 최근 N개 봉만 싣습니다. 하루치가 아니라 겹치게 싣는 이유는 분할·정정으로
// 어제 값이 바뀌었는지 Oracle이 비교할 수 있게 하기 위해서입니다.
export const DAILY_KEEP_BARS = 5;

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJsonl(file) {
  try {
    const text = await readFile(file, "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * @param {object} options
 * @param {"backfill"|"daily"} options.mode
 * @param {string} options.source           기록용 소스 이름
 * @param {{included: {symbol:string,name?:string}[], excluded: object[]}} options.universe
 * @param {string} options.outDir           같은 폴더로 다시 실행하면 이어서 합니다
 * @param {(symbol:string, ctx:{mode:string}) => Promise<{bars:object[], adjustment:string}>} options.fetchBarsImpl
 */
export async function collect({
  mode = "daily",
  source,
  universe,
  outDir,
  fetchBarsImpl,
  now = new Date(),
  delayMs = 1000,
  retries = 2,
  backoffMs = 2000,
  maxConsecutiveBlocks = 3,
  sleep = defaultSleep,
  log = () => {},
}) {
  if (!["backfill", "daily"].includes(mode)) throw new Error(`mode 는 backfill|daily 입니다: ${mode}`);
  await mkdir(outDir, { recursive: true });
  const startedAt = new Date().toISOString();

  // ── 대상: 이어서 할 때는 처음 정한 목록을 그대로 씁니다 (도중에 목록이 바뀌면 manifest가 거짓이 된다)
  const universePath = path.join(outDir, "universe.json");
  let stored = await readJsonIfExists(universePath);
  if (!stored) {
    stored = {
      runDate: now.toISOString().slice(0, 10), // 주입된 시계를 따릅니다(시험에서 «미래 봉» 검사가 실제 오늘에 흔들리지 않게)
      count: universe.included.length,
      symbols: universe.included,
      excluded: universe.excluded,
      listedCount: universe.listedCount ?? null,
      sourceFooter: universe.sourceFooter ?? null,
    };
    await writeFile(universePath, JSON.stringify(stored, null, 2));
  }

  const barsPath = path.join(outDir, "bars.jsonl");
  const failuresPath = path.join(outDir, "failures.jsonl");
  const done = new Set((await readJsonl(barsPath)).map((line) => line.ticker));
  // NOT_FOUND는 다시 해도 같으므로 이어서 할 때 건너뜁니다. 차단·시간 초과는 다시 시도합니다.
  for (const failure of await readJsonl(failuresPath)) {
    if (failure.kind === "NOT_FOUND") done.add(failure.ticker);
  }
  const todo = stored.symbols.map((s) => s.symbol).filter((symbol) => !done.has(symbol));
  log(`대상 ${stored.count}개 · 이미 처리 ${stored.count - todo.length}개 · 이번에 ${todo.length}개`);

  // ── 한 종목: 일시 오류만 재시도하고, 차단과 «없음»은 즉시 결론을 냅니다
  async function fetchOne(symbol) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return { ok: true, ...(await fetchBarsImpl(symbol, { mode })) };
      } catch (error) {
        if (error instanceof BlockedError) return { ok: false, kind: "BLOCKED", message: error.message };
        if (error instanceof NotFoundError) return { ok: false, kind: "NOT_FOUND", message: error.message };
        if (attempt === retries) return { ok: false, kind: "RETRY_EXHAUSTED", message: error.message };
        await sleep(backoffMs * (attempt + 1));
      }
    }
    return { ok: false, kind: "RETRY_EXHAUSTED", message: "도달 불가" };
  }

  let consecutiveBlocks = 0;
  let aborted = false;
  let droppedInvalid = 0;
  let droppedIncomplete = 0;

  for (let i = 0; i < todo.length; i += 1) {
    const symbol = todo[i];
    if (i > 0) await sleep(delayMs);
    const result = await fetchOne(symbol);

    if (!result.ok) {
      await appendFile(failuresPath, `${JSON.stringify({ ticker: symbol, kind: result.kind, message: result.message, at: new Date().toISOString() })}\n`);
      consecutiveBlocks = result.kind === "BLOCKED" ? consecutiveBlocks + 1 : 0;
      if (consecutiveBlocks >= maxConsecutiveBlocks) {
        aborted = true;
        log(`연속 ${maxConsecutiveBlocks}회 차단 — ${symbol}에서 중단합니다 (IP를 더 괴롭히지 않습니다)`);
        break;
      }
      continue;
    }
    consecutiveBlocks = 0;

    const cleaned = cleanBars(result.bars);
    const finalized = dropIncompleteBars(cleaned.bars, now);
    const bars = mode === "daily" ? finalized.bars.slice(-DAILY_KEEP_BARS) : finalized.bars;
    droppedInvalid += cleaned.dropped;
    droppedIncomplete += finalized.dropped;
    if (!bars.length) {
      await appendFile(failuresPath, `${JSON.stringify({ ticker: symbol, kind: "EMPTY", message: "정리 후 봉이 없음", at: new Date().toISOString() })}\n`);
      continue;
    }
    await appendFile(
      barsPath,
      `${JSON.stringify({ ticker: symbol, source, fetchedAt: new Date().toISOString(), adjustment: result.adjustment, bars })}\n`,
    );
    if ((i + 1) % 100 === 0) log(`${i + 1}/${todo.length}`);
  }

  // ── 포장: 파일에 실제로 있는 것을 다시 읽어 셉니다 (메모리 카운터를 믿지 않는다)
  const okLines = await readJsonl(barsPath);
  const okSet = new Set(okLines.map((line) => line.ticker));
  const latestFailure = new Map();
  for (const failure of await readJsonl(failuresPath)) latestFailure.set(failure.ticker, failure);
  const unresolved = [...latestFailure.values()].filter((f) => !okSet.has(f.ticker));
  const countKind = (kind) => unresolved.filter((f) => f.kind === kind).length;

  // 기준일 = 대다수 종목의 마지막 봉 날짜. 거래 정지·상장폐지 종목은 마지막 봉이 더 옛날이라 stale로 갈립니다.
  const lastDates = okLines.map((line) => ({ ticker: line.ticker, last: line.bars.at(-1).date }));
  const votes = new Map();
  for (const { last } of lastDates) votes.set(last, (votes.get(last) ?? 0) + 1);
  const asOf = [...votes.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0]?.[0] ?? null;
  const stale = lastDates.filter(({ last }) => last !== asOf);

  const barsBuffer = await readFile(barsPath).catch(() => Buffer.alloc(0));
  const universeBuffer = await readFile(universePath);
  const requested = stored.count;
  const missing = requested - okSet.size;
  const manifest = {
    formatVersion: COLLECTOR_FORMAT_VERSION,
    mode,
    source,
    asOf,
    runDate: stored.runDate,
    startedAt,
    finishedAt: new Date().toISOString(),
    // COMPLETE는 «전부 받았다»뿐입니다. 얼마나 빠져도 받을지는 Oracle이 정합니다.
    status: aborted ? "ABORTED" : missing === 0 ? "COMPLETE" : "PARTIAL",
    counts: {
      requested,
      ok: okSet.size,
      missing,
      notFound: countKind("NOT_FOUND"),
      blocked: countKind("BLOCKED"),
      retryExhausted: countKind("RETRY_EXHAUSTED"),
      empty: countKind("EMPTY"),
      notAttempted: requested - okSet.size - unresolved.length,
      atAsOf: lastDates.length - stale.length,
      stale: stale.length,
      barsDroppedInvalid: droppedInvalid,
      barsDroppedIncomplete: droppedIncomplete,
    },
    staleTickers: stale.slice(0, 200),
    files: {
      universe: { name: "universe.json", sha256: sha256(universeBuffer) },
      bars: { name: "bars.jsonl", lines: okLines.length, sha256: sha256(barsBuffer) },
      failures: { name: "failures.jsonl" },
    },
  };
  // 임시 파일에 쓰고 이름을 바꿔서, manifest가 «반쯤 쓰인 채로» 보이는 순간을 없앱니다.
  const tmp = path.join(outDir, "manifest.json.tmp");
  await writeFile(tmp, JSON.stringify(manifest, null, 2));
  await rename(tmp, path.join(outDir, "manifest.json"));
  return manifest;
}

/** 실제 소스를 쓰는 fetchBarsImpl을 만듭니다. 테스트는 이 자리에 가짜를 넣습니다. */
export function makeFetchBars(sourceName, { env = process.env, fetchImpl } = {}) {
  return (symbol, { mode }) => fetchBarsFrom(sourceName, symbol, { mode, env, fetchImpl });
}
