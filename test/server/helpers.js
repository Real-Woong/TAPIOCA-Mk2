// 서버 시험용: 진짜 수집기(collect)로 배치를 만들고, 시험이 그것을 일부러 망가뜨립니다.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { collect } from "../../src/collect/collector.js";
import { NotFoundError } from "../../src/collect/sources.js";

const AFTER_CLOSE = new Date("2026-11-03T22:00:00Z");

export const bar = (date, c = 10.5, v = 1000) => ({ date, o: 10, h: Math.max(11, c), l: 9, c, v });

export async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "tapioca-server-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** barsFor(symbol) → 봉 배열 또는 null(받기 실패). */
export async function makeBatch(outDir, { symbols = ["AAA", "BBB"], barsFor, mode = "daily", now = AFTER_CLOSE } = {}) {
  const fallback = () => [bar("2026-11-02"), bar("2026-11-03")];
  return collect({
    mode,
    source: "fake",
    universe: { included: symbols.map((symbol) => ({ symbol, name: `${symbol} Inc` })), excluded: [] },
    outDir,
    now,
    delayMs: 0,
    retries: 0,
    sleep: async () => {},
    fetchBarsImpl: async (symbol) => {
      const bars = (barsFor ?? fallback)(symbol);
      if (!bars) throw new NotFoundError("없음");
      return { bars, adjustment: "x" };
    },
  });
}
