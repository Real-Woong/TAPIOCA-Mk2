// 토스 일봉(/candles)과 우리 DB 의 일봉(Yahoo 기반)을 «같은 날짜끼리» 비교합니다. 순수 함수입니다.
// 전략의 입력 데이터를 토스로 바꿔도 되는지 판단하려는 읽기 전용 비교이며, 비교 결과는 어디에도 쓰이지 않습니다.
//
// ── 이 파일의 구성 ──────────────────────────────────────────────────────────
//  normalizeCandles()   토스 응답 → { date, o, h, l, c, v } (날짜 오름차순)
//  compareBars()        날짜 맞추기(어긋남 자동 보정) → 종가 차이·거래량 비율
//  aggregate()          여러 종목의 비교를 한 줄 요약으로
//
// ── 날짜 맞추기 ─────────────────────────────────────────────────────────────
// 토스 봉의 timestamp 가 «미국 거래일»인지 «한국 시간의 개장/마감 시각»인지 아직 모릅니다. 그래서 0일·-1일·+1일 어긋남을 모두 시험해
// 날짜가 가장 많이 겹치는 쪽을 쓰고, 어느 쪽인지 결과에 남깁니다(offsetDays).

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const shiftDate = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function normalizeCandles(payload) {
  const list = Array.isArray(payload) ? payload : (payload?.candles ?? []);
  return list
    .map((c) => ({
      date: String(c.timestamp ?? "").slice(0, 10),
      o: Number(c.openPrice), h: Number(c.highPrice), l: Number(c.lowPrice), c: Number(c.closePrice), v: Number(c.volume),
    }))
    .filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date) && [b.o, b.h, b.l, b.c].every(Number.isFinite) && b.c > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * @param {{date:string,o:number,h:number,l:number,c:number,v:number}[]} toss  normalizeCandles 결과
 * @param {{date:string,c:number,v:number}[]} ours  우리 DB 의 봉
 */
export function compareBars(toss, ours) {
  const byDate = new Map(ours.map((b) => [b.date, b]));
  let best = { offsetDays: 0, matched: -1 };
  for (const offsetDays of [0, -1, 1]) {
    const matched = toss.filter((t) => byDate.has(shiftDate(t.date, offsetDays))).length;
    if (matched > best.matched) best = { offsetDays, matched };
  }
  const pairs = toss
    .map((t) => ({ t, y: byDate.get(shiftDate(t.date, best.offsetDays)) }))
    .filter((pair) => pair.y);
  const closeDiffs = pairs.map(({ t, y }) => Math.abs(t.c - y.c) / y.c);
  const volRatios = pairs.filter(({ y, t }) => y.v > 0 && Number.isFinite(t.v)).map(({ t, y }) => t.v / y.v);
  return {
    offsetDays: best.offsetDays,
    tossBars: toss.length,
    matched: pairs.length,
    closeDiffMax: closeDiffs.length ? Math.max(...closeDiffs) : null,
    closeDiffMedian: median(closeDiffs),
    volRatioMedian: median(volRatios),
    volRatioMax: volRatios.length ? Math.max(...volRatios) : null,
    volRatioMin: volRatios.length ? Math.min(...volRatios) : null,
  };
}

/** @param {object[]} results compareBars 결과들 (맞춘 날짜가 없는 종목은 건너뜀) */
export function aggregate(results) {
  const used = results.filter((r) => r.matched > 0);
  return {
    tickers: results.length,
    comparable: used.length,
    closeDiffMedian: median(used.map((r) => r.closeDiffMedian)),
    closeDiffWorst: used.length ? Math.max(...used.map((r) => r.closeDiffMax)) : null,
    volRatioMedian: median(used.map((r) => r.volRatioMedian)),
    offsets: [...new Set(used.map((r) => r.offsetDays))],
  };
}
