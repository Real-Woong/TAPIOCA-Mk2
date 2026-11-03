// 종목 하나의 «전체 봉 기록»을 처음부터 끝까지 훑으며 후보를 만들고 진행시킵니다. 순수 함수입니다.
//
// ── 이 파일의 구성 ──────────────────────────────────────────────────────────
//  replayTicker()   봉을 날짜순으로 한 칸씩 보며: ① 진행 중인 후보를 advance, ② 오늘이 새 급증일이면 후보 생성
//  dryUpOf()        확인 구간의 거래량이 평소보다 얼마나 줄었는지 (기록만 하는 변수, 조건 아님)
//
// 왜 «처음부터 다시 훑나»: 매일 어제 상태를 이어받는 방식은 한 번 어긋나면 계속 어긋납니다.
// 훑는 방식은 봉만 같으면 항상 같은 결과가 나오고(결정적), DB가 지워져도 봉에서 복원됩니다.
// 이미 끝난 후보를 어떻게 지키는지는 runner.js 를 보세요.
//
// ── 반복 급증 규칙 (구현 가정으로 고정) ─────────────────────────────────────
// 같은 종목에 아직 끝나지 않은 후보(확인 중 / 돌파 대기)가 있으면, 그 사이에 또 급증 조건이 맞아도
// 새 후보를 만들지 않습니다. 한 사건을 독립된 거래로 두 번 세지 않으려는 것입니다.
// 후보가 끝난 뒤(돌파·무효·만료)의 급증은 새 후보가 됩니다.

import { atrSeries, evaluateDay, highN } from "../compute/indicators.js";
import { SETTINGS, STRATEGY_VERSION } from "../compute/settings.js";
import { CONFIRM_DAYS, STATES, advance, newCandidate } from "./step.js";

const TERMINAL = new Set([STATES.BROKE_OUT, STATES.INVALID, STATES.EXPIRED]);
const mean = (bars, from, to) => {
  let sum = 0;
  for (let k = from; k <= to; k += 1) sum += bars[k].v;
  return sum / (to - from + 1);
};

/**
 * DryUp = mean[V(t0+1…t0+3)] / mean[V(t0-20…t0-1)]. 급증일 거래량이 아니라 «평소» 거래량과 비교합니다.
 * v1 에서는 기록만 하고 통과 조건으로 쓰지 않습니다.
 */
export function dryUpOf(bars, surgeIndex) {
  if (surgeIndex < 20 || surgeIndex + CONFIRM_DAYS >= bars.length) return null;
  const usual = mean(bars, surgeIndex - 20, surgeIndex - 1);
  return usual > 0 ? mean(bars, surgeIndex + 1, surgeIndex + CONFIRM_DAYS) / usual : null;
}

/**
 * @param {string} ticker
 * @param {{date:string,o:number,h:number,l:number,c:number,v:number}[]} bars  날짜 오름차순
 * @returns {{ candidate: object, events: object[], surgeIndex: number }[]}  후보와, 그 후보에서 일어난 사건들(시간순)
 */
export function replayTicker(ticker, bars, { settings = SETTINGS, strategyVersion = STRATEGY_VERSION } = {}) {
  const atr = atrSeries(bars, settings.atrWindow);
  const results = [];
  let active = null; // 지금 진행 중인 후보 (results 안의 같은 객체)

  for (let i = 0; i < bars.length; i += 1) {
    // ① 진행 중인 후보를 오늘 봉으로 한 칸. 돌파 기준은 «어제까지의» ATR 입니다.
    if (active) {
      const { candidate, event } = advance(active.candidate, bars[i], atr[i - 1] ?? null);
      active.candidate = candidate;
      if (event) {
        if (event.type === "CONFIRMED") event.dryUp = dryUpOf(bars, active.surgeIndex);
        active.events.push(event);
      }
      if (TERMINAL.has(candidate.state)) active = null;
    }

    // ② 진행 중인 후보가 없을 때만, 오늘이 급증일인지 본다 (반복 급증 규칙)
    if (active) continue;
    const day = evaluateDay(bars, i, settings);
    if (!day?.all) continue;

    const candidate = newCandidate({
      ticker,
      surgeBar: bars[i],
      windowHigh: highN(bars, i, settings.rangeWindow),
      strategyVersion,
    });
    active = {
      candidate,
      surgeIndex: i,
      events: [{
        candidateId: candidate.id,
        type: "DISCOVERED",
        date: bars[i].date,
        ...day.values,
        close: bars[i].c,
        surgeLow: candidate.surgeLow,
        windowHigh: candidate.windowHigh,
      }],
    };
    results.push(active);
  }
  return results;
}
