// 모의매매 규칙. 전부 «순수 함수»입니다 — 가격 몇 개를 넣으면 결정이 나옵니다. DB를 읽지 않습니다.
//
// ── 이 파일의 구성 ──────────────────────────────────────────────────────────
//  initialStopOf()   초기 손절가 = 확인 3일 최저가 − 0.2 ATR
//  positionSize()    수량 = min(위험 기준 수량, 비중 상한 수량) 을 내림 (소수점 주문 가정이면 소수 4자리까지)
//  floorQty()        수량을 자릿수에 맞춰 내림
//  isGapSkipped()    다음 날 시가가 너무 높으면 추격하지 않는다
//  fillPrice()       슬리피지를 반영한 체결가
//  onOpen()          장 시작: 예약된 청산(손절·박스 이탈·시간)을 시가에 체결
//  onSession()       마감: 종가가 손절선 이하인지 확인 → 추적 손절 갱신 → 다음 날 청산 예약
//
// ── 손절을 «종가»로 판단하는 이유 (paper-v3) ───────────────────────────────
// 토스 금액 주문은 시장가뿐이고, 이 시스템은 마감 뒤에 하루 한 번 판단합니다. 장중에 손절선에 닿는 순간 체결되는
// 역지정가 주문이 없습니다. 그래서 «종가가 손절선 이하로 마감하면, 다음 날 시가에 판다»로 모의합니다.
// 손절선 아래로 갭하락하는 날의 손실이 그대로 반영되고, 장중에 손절선을 찍고 올라와 마감하면 보유를 유지합니다(실제 운용과 같다).
//
// ── 하루의 순서 ─────────────────────────────────────────────────────────────
//   ① 시가: 어제 예약된 청산(손절·박스 이탈·시간)이 있으면 그 날 시가에 청산한다
//   ② 마감: 종가가 «어제까지의» 손절선 이하면 내일 시가 청산을 예약 (STOP / TRAIL_STOP)
//   ③ 마감: 손절이 아니면 최고 종가·+1R 도달·추적 손절선을 갱신하고, 다음 청산 조건을 예약
//           (손절 > 박스 이탈 > 시간 청산 순서로 하나만 예약)

import { PAPER_SETTINGS } from "./settings.js";

/** 급증일 다음 3거래일의 최저 저가 − buffer × ATR. 봉이 3개 미만이면 null */
export function initialStopOf(bars, surgeIndex, atrRef, s = PAPER_SETTINGS) {
  if (surgeIndex < 0 || surgeIndex + 3 >= bars.length || atrRef == null) return null;
  const lowest = Math.min(bars[surgeIndex + 1].l, bars[surgeIndex + 2].l, bars[surgeIndex + 3].l);
  return lowest - s.stopAtrBuffer * atrRef;
}

/** 수량을 내림한다. 소수점 주문이면 qtyDecimals 자리까지, 아니면 정수. (올림하면 계획한 위험·상한을 넘는다) */
export function floorQty(qty, s = PAPER_SETTINGS) {
  if (!(qty > 0)) return 0;
  if (!s.allowFractional) return Math.floor(qty);
  const k = 10 ** s.qtyDecimals;
  return Math.floor(qty * k + 1e-9) / k;
}

/**
 * 수량 = min(계좌 × 위험비율 ÷ (진입가 − 손절가), 계좌 × 비중상한 ÷ 진입가) 를 내림.
 * equity 는 «달러로 환산한 계좌 평가액»입니다 (원화 평가액 ÷ 그날 환율). 가격·손절폭이 달러라서 단위를 맞춥니다.
 */
export function positionSize({ equity, entry, stop, s = PAPER_SETTINGS }) {
  if (!(entry > stop) || !(equity > 0)) return 0;
  const byRisk = (equity * s.riskPerTrade) / (entry - stop);
  const byCap = (equity * s.positionCap) / entry;
  return floorQty(Math.min(byRisk, byCap), s);
}

/** 시가가 «신호일 종가 + 0.5 ATR» 보다 «높으면»(같으면 아님) 추격하지 않는다 */
export function isGapSkipped({ open, signalClose, atrRef, s = PAPER_SETTINGS }) {
  return atrRef != null && open > signalClose + s.gapSkipAtr * atrRef;
}

/** 슬리피지 반영: 매수는 비싸게, 매도는 싸게 */
export function fillPrice(raw, side, s = PAPER_SETTINGS) {
  const k = s.slippageBps / 10_000;
  return side === "BUY" ? raw * (1 + k) : raw * (1 - k);
}

/**
 * 포지션 모양:
 * { entryPrice, initialStop, stop, r, boxTop, highestClose|null, barsHeld, reached1R, pendingExit|null }
 */

/** ① 장 시작. 예약된 청산이 있으면 시가에 청산한다. */
export function onOpen(position, bar) {
  return position.pendingExit ? { reason: position.pendingExit, price: bar.o } : null;
}

/**
 * ②③ 마감 후 판단. 청산은 «내일 시가»에 예약만 하고, 오늘은 체결하지 않는다.
 * @param atrClose 오늘 마감까지의 ATR14 (내일의 추적 손절선 계산용, 없으면 갱신 생략)
 * @returns {{position: object, exit: null}}  exit 는 항상 null (청산은 onOpen 에서)
 */
export function onSession(position, bar, atrClose, s = PAPER_SETTINGS) {
  const next = { ...position, barsHeld: position.barsHeld + 1 };

  // ② 종가가 손절선 이하 → 내일 시가 청산 예약. 추적선도 올리지 않는다(어차피 나간다)
  if (bar.c <= position.stop) {
    next.pendingExit = position.stop > position.initialStop ? "TRAIL_STOP" : "STOP";
    return { position: next, exit: null };
  }

  // ③ 마감 갱신
  next.highestClose = position.highestClose === null ? bar.c : Math.max(position.highestClose, bar.c);
  if (bar.c >= position.entryPrice + position.r) next.reached1R = true;
  // 추적 손절: 최고 종가 − 3 ATR. 손절선은 내리지 않고(max), 초기 손절선보다 낮아지지도 않는다
  if (atrClose != null) next.stop = Math.max(position.stop, next.highestClose - s.trailAtr * atrClose);

  if (bar.c < position.boxTop) next.pendingExit = "BELOW_BOX";
  else if (next.barsHeld >= s.timeExitDays && !next.reached1R) next.pendingExit = "TIME";
  return { position: next, exit: null };
}
