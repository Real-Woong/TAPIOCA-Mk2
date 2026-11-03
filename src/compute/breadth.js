// «시장 전체 폭» — 그날 시장 전체에서 거래량이 평소의 3배를 넘긴 종목이 얼마나 되는가.
// 순수 함수입니다 (DB·파일을 읽지 않음).
//
// ── 이 파일의 구성 ──────────────────────────────────────────────────────────
//  BREADTH            시장 전체 급증일로 부를 기준 (기록용)
//  computeBreadth()   날짜별로 «평가한 종목 수 / RVOL 통과 수 / 5조건 모두 통과 수 / 비율 / 시장 전체 여부»를 센다
//
// ── 왜 필요한가 ─────────────────────────────────────────────────────────────
// 선물옵션 동시만기·지수 재조정일(예: 2026-09-18)에는 종목 고유의 이유 없이 시장 전체 거래량이 터집니다.
// 이날 생긴 후보는 «누가 조용히 모으는 중»이라는 가설과 상관이 약합니다. 지금은 후보에서 빼지 않고(조건 변경 금지)
// 사건에 표시만 해서, 시장 전체 급증일 후보의 성과가 따로 어떤지 나중에 비교할 수 있게 기록합니다.
//
// 기준값 0.08(평가 종목의 8%)은 «평소 약 4%의 두 배»로 잡은 시험값입니다. 분포가 쌓이면 다시 보세요.
// 값을 바꿔도 후보·모의매매 판단에는 영향이 없습니다(기록 전용).

import { evaluateDay } from "./indicators.js";
import { SETTINGS } from "./settings.js";

export const BREADTH = Object.freeze({
  /** RVOL 통과 종목이 평가 종목 중 이 비율 이상이면 «시장 전체 급증일» */
  marketWideRatio: 0.08,
});

/**
 * @param {Map<string, object[]>} barsByTicker  종목별 봉 (날짜 오름차순)
 * @param {Set<string>} excluded  계산에서 뺄 종목 (분할 의심 등)
 * @returns {{date:string, evaluated:number, surge:number, allPass:number, ratio:number, marketWide:boolean}[]}  날짜 오름차순
 */
export function computeBreadth(barsByTicker, excluded = new Set(), s = SETTINGS, b = BREADTH) {
  const byDate = new Map();
  for (const [ticker, bars] of barsByTicker) {
    if (bars.length < s.minBars || excluded.has(ticker)) continue;
    for (let i = s.rvolWindow; i < bars.length; i += 1) {
      const day = evaluateDay(bars, i, s);
      if (!day || day.values.rvol === null) continue;
      let row = byDate.get(day.date);
      if (!row) {
        row = { date: day.date, evaluated: 0, surge: 0, allPass: 0 };
        byDate.set(day.date, row);
      }
      row.evaluated += 1;
      if (day.pass.rvol) row.surge += 1;
      if (day.all) row.allPass += 1;
    }
  }
  return [...byDate.values()]
    .sort((x, y) => x.date.localeCompare(y.date))
    .map((row) => {
      const ratio = row.evaluated ? row.surge / row.evaluated : 0;
      return { ...row, ratio, marketWide: ratio >= b.marketWideRatio };
    });
}
