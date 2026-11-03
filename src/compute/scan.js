// DB 의 최신 봉 전체에 «발견 조건(A절)»을 적용해, 조건을 하나씩 더할 때마다 몇 건이 남는지(깔때기) 셉니다.
// 읽기 전용입니다 — 후보 기록(상태 머신)은 다음 단계에서 이 결과를 받아 만듭니다.

import { evaluateDay } from "./indicators.js";
import { SETTINGS } from "./settings.js";

/**
 * «분할 의심» 종목: 가격이 소급 조정됐다는 증거(정정 기록의 종가 비율이 0.8 미만 또는 1.25 초과)가 있고,
 * 지금 DB 의 종가 열에도 가격 단위가 끊기는 곳(인접 종가 비율이 0.7 미만 또는 1.43 초과)이 남아 있는 종목.
 * daily 는 최근 5봉만 다시 받기 때문에 이런 종목은 한 종목 안에서 가격 단위가 섞입니다(실제로 AXG 가 이랬습니다).
 * 섞인 채로 계산하면 수익률·범위가 가짜가 됩니다. 그 종목을 backfill 로 다시 받으면 옛 봉도 정정되어 끊김이 사라지고
 * 저절로 풀립니다.
 * (두 증거를 «함께» 요구하는 이유: 끊김만 보면 진짜 급등락 종목 200여 개가 같이 빠집니다.)
 */
export function loadSplitSuspects(db) {
  const evidence = db.prepare(`
    SELECT DISTINCT ticker FROM bar_corrections
    WHERE field = 'c' AND old_value > 0 AND (new_value / old_value < 0.8 OR new_value / old_value > 1.25)`).all();
  const closes = db.prepare("SELECT c FROM latest_bars WHERE ticker = ? ORDER BY date");
  const suspects = new Set();
  for (const { ticker } of evidence) {
    const series = closes.all(ticker);
    for (let i = 1; i < series.length; i += 1) {
      const ratio = series[i].c / series[i - 1].c;
      if (ratio < 0.7 || ratio > 1 / 0.7) {
        suspects.add(ticker);
        break;
      }
    }
  }
  return suspects;
}

const STEPS = ["rvol", "return20", "range20", "clv", "addv20"];

/** latest_bars 를 종목별 봉 배열로 읽습니다. */
export function loadBarsByTicker(db) {
  const rows = db.prepare("SELECT ticker, date, o, h, l, c, v FROM latest_bars ORDER BY ticker, date").all();
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.ticker)) map.set(row.ticker, []);
    map.get(row.ticker).push(row);
  }
  return map;
}

/**
 * @returns {{
 *   tickersEvaluated:number, tickersSkippedShort:number, tickersSkippedDiscontinuity:number, latestDate:string|null,
 *   funnelAllDays:Record<string,number>, funnelLatest:Record<string,number>,
 *   hitsLatest:object[], hitsAllDays:number
 * }}
 */
export function scan(barsByTicker, s = SETTINGS, splitSuspects = new Set()) {
  const empty = () => ({ evaluated: 0, ...Object.fromEntries(STEPS.map((step) => [step, 0])) });
  const funnelAllDays = empty();
  const funnelLatest = empty();
  const hitsLatest = [];
  let hitsAllDays = 0;
  let tickersEvaluated = 0;
  let tickersSkippedShort = 0;
  let tickersSkippedDiscontinuity = 0;

  let latestDate = null;
  for (const bars of barsByTicker.values()) {
    const last = bars.at(-1)?.date;
    if (last && (!latestDate || last > latestDate)) latestDate = last;
  }

  for (const [ticker, bars] of barsByTicker) {
    if (bars.length < s.minBars) {
      tickersSkippedShort += 1;
      continue;
    }
    if (splitSuspects.has(ticker)) {
      tickersSkippedDiscontinuity += 1;
      continue;
    }
    tickersEvaluated += 1;
    for (let i = s.rvolWindow; i < bars.length; i += 1) {
      const day = evaluateDay(bars, i, s);
      if (!day) continue;
      const isLatest = day.date === latestDate;
      // 깔때기: 앞 조건을 모두 통과한 건만 다음 칸에 센다
      for (const target of isLatest ? [funnelAllDays, funnelLatest] : [funnelAllDays]) {
        target.evaluated += 1;
        for (const step of STEPS) {
          if (!day.pass[step]) break;
          target[step] += 1;
        }
      }
      if (day.all) {
        hitsAllDays += 1;
        if (isLatest) hitsLatest.push({ ticker, ...day.values, close: bars[i].c });
      }
    }
  }
  hitsLatest.sort((a, b) => b.rvol - a.rvol);
  return { tickersEvaluated, tickersSkippedShort, tickersSkippedDiscontinuity, latestDate, funnelAllDays, funnelLatest, hitsLatest, hitsAllDays };
}
