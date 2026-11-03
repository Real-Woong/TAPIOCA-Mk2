// 지표 계산. 모두 «순수 함수»입니다 — 봉 배열(날짜 오름차순)과 위치 i 를 받아 숫자 하나를 돌려줍니다.
// DB·파일을 읽지 않으므로 손으로 계산한 값과 바로 대조할 수 있습니다.
//
// 봉: { date, o, h, l, c, v }.  i = 기준일(t0)의 위치.
// 계산할 수 없으면 null 입니다(0 이나 NaN 으로 얼버무리지 않습니다).
// 정의는 docs/STRATEGY_SPEC.md 의 A절과 같습니다.

import { SETTINGS } from "./settings.js";

/** RVOL(t0) = V(t0) / mean[V(t0-60) … V(t0-1)]  — t0 자신과 이후는 평균에 넣지 않는다 */
export function rvol(bars, i, window = SETTINGS.rvolWindow) {
  if (i < window) return null;
  let sum = 0;
  for (let k = i - window; k < i; k += 1) sum += bars[k].v;
  const mean = sum / window;
  return mean > 0 ? bars[i].v / mean : null;
}

/** Return20(t0) = C(t0) / C(t0-20) − 1 */
export function returnN(bars, i, window = SETTINGS.returnWindow) {
  if (i < window) return null;
  const past = bars[i - window].c;
  return past > 0 ? bars[i].c / past - 1 : null;
}

/** Range20(t0) = max H(t0-19 … t0) / min L(t0-19 … t0) − 1 */
export function rangeN(bars, i, window = SETTINGS.rangeWindow) {
  if (i < window - 1) return null;
  let high = -Infinity;
  let low = Infinity;
  for (let k = i - window + 1; k <= i; k += 1) {
    if (bars[k].h > high) high = bars[k].h;
    if (bars[k].l < low) low = bars[k].l;
  }
  return low > 0 ? high / low - 1 : null;
}

/** 최근 window 봉(기준일 포함)의 최고 고가 — 박스 상단의 출발값 */
export function highN(bars, i, window = SETTINGS.rangeWindow) {
  if (i < window - 1) return null;
  let high = -Infinity;
  for (let k = i - window + 1; k <= i; k += 1) if (bars[k].h > high) high = bars[k].h;
  return high;
}

/** CLV(t0) = (C − L) / (H − L).  H = L 이면 계산 불가 */
export function clv(bars, i) {
  const { h, l, c } = bars[i];
  return h > l ? (c - l) / (h - l) : null;
}

/** ADDV20(t0) = mean[C × V] for t0-19 … t0 (종가×거래량은 거래대금의 근사) */
export function addvN(bars, i, window = SETTINGS.addvWindow) {
  if (i < window - 1) return null;
  let sum = 0;
  for (let k = i - window + 1; k <= i; k += 1) sum += bars[k].c * bars[k].v;
  return sum / window;
}

/** 진짜 변동폭(갭 포함): TR(t) = max(H−L, |H−C(t-1)|, |L−C(t-1)|) */
export function trueRange(bars, i) {
  if (i < 1) return null;
  const { h, l } = bars[i];
  const prevClose = bars[i - 1].c;
  return Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
}

/**
 * ATR14 시계열 (Wilder). 결과[i] = «i 일 종가까지 반영한» ATR.
 *  · 첫 값(i = 14)은 TR 14개의 단순평균
 *  · 이후 ATR(t) = (ATR(t-1) × 13 + TR(t)) / 14
 * 신호일 판단에 쓸 때는 «전일 값» ATR(t-1) 을 읽습니다(스펙: 돌파 기준 C(t) > B + 0.1 × ATR14(t-1)).
 */
export function atrSeries(bars, window = SETTINGS.atrWindow) {
  const out = new Array(bars.length).fill(null);
  if (bars.length <= window) return out;
  let sum = 0;
  for (let i = 1; i <= window; i += 1) sum += trueRange(bars, i);
  out[window] = sum / window;
  for (let i = window + 1; i < bars.length; i += 1) {
    out[i] = (out[i - 1] * (window - 1) + trueRange(bars, i)) / window;
  }
  return out;
}

/**
 * 기준일 i 하나의 발견(A절) 지표와 단계별 통과 여부.
 * 계산에 필요한 과거 봉이 모자라면 null.
 */
export function evaluateDay(bars, i, s = SETTINGS) {
  if (i < s.rvolWindow) return null;
  const values = {
    rvol: rvol(bars, i, s.rvolWindow),
    return20: returnN(bars, i, s.returnWindow),
    range20: rangeN(bars, i, s.rangeWindow),
    clv: clv(bars, i),
    addv20: addvN(bars, i, s.addvWindow),
  };
  const pass = {
    rvol: values.rvol !== null && values.rvol >= s.rvolMin,
    return20: values.return20 !== null && values.return20 >= s.returnMin && values.return20 <= s.returnMax,
    range20: values.range20 !== null && values.range20 <= s.rangeMax,
    clv: values.clv !== null && values.clv >= s.clvMin,
    addv20: values.addv20 !== null && values.addv20 >= s.addvMinUsd,
  };
  return { date: bars[i].date, values, pass, all: Object.values(pass).every(Boolean) };
}
