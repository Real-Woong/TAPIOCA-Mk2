// 후보 상태 머신 — «후보 종목 하나를, 새 일봉 하루치로 한 칸 진행시키는» 부분입니다.
//
// ── 이 파일의 구성 ──────────────────────────────────────────────────────────
//
//  [상수]
//   STATES          후보가 가질 수 있는 상태 5가지
//   CONFIRM_DAYS    확인 기간 (3거래일)
//   WAIT_DAYS       돌파 대기 기간 (10거래일)
//   BREAKOUT_ATR    돌파로 인정하려면 박스 상단 위로 얼마나 넘어야 하는지 (0.1 ATR)
//   TERMINAL        더 이상 움직이지 않는 «끝난» 상태 모음 (내부용)
//
//  [함수]
//   newCandidate()  급증일에 새 후보를 만든다
//   advance()       하루가 지날 때마다 후보를 한 칸 진행시킨다 (이 파일의 핵심)
//
// ── 후보의 일생 ─────────────────────────────────────────────────────────────
//
//   CONFIRMING ──(3거래일 동안 저가 유지)──▶ WAITING ──(종가가 B 초과)──▶ BROKE_OUT
//        │                                      │  └──(10거래일 지남)──▶ EXPIRED
//        └──────── 급증일 저가 이탈 ────────────┴──────────────────────▶ INVALID
//
// 이 파일은 DB·파일을 읽지 않는 «순수 함수»입니다.
// 같은 입력이면 항상 같은 결과가 나오므로, 손으로 계산한 시나리오로 그대로 시험할 수 있습니다.

// ═══ 상수 ═══════════════════════════════════════════════════════════════════

/** 후보의 상태. 위 그림의 박스 하나하나입니다. */
export const STATES = {
  CONFIRMING: "CONFIRMING", // 급증 뒤 3거래일 확인 중
  WAITING: "WAITING",       // 박스 상단 B 고정 완료, 돌파 대기 중
  BROKE_OUT: "BROKE_OUT",   // 돌파 = 매수 신호 (끝)
  INVALID: "INVALID",       // 급증일 저가 이탈 (끝)
  EXPIRED: "EXPIRED",       // 대기 기간 안에 돌파 못 함 (끝)
};

/** 급증 뒤 저가 유지를 확인하는 거래일 수 */
export const CONFIRM_DAYS = 3;

/** 확인이 끝난 뒤 돌파를 기다리는 최대 거래일 수 */
export const WAIT_DAYS = 10;

/** 돌파 기준: 종가 > B + BREAKOUT_ATR × ATR14(전일). 미세한 초과를 돌파로 착각하지 않으려는 여유입니다. */
export const BREAKOUT_ATR = 0.1;

/** 끝난 상태. 여기에 들어간 후보는 더 이상 변하지 않습니다. */
const TERMINAL = new Set([STATES.BROKE_OUT, STATES.INVALID, STATES.EXPIRED]);

// ═══ 함수 ═══════════════════════════════════════════════════════════════════

/**
 * 급증일(t0)에 새 후보를 만듭니다.
 *
 * @param {object} input
 * @param {string} input.ticker           종목 코드
 * @param {{date:string, l:number}} input.surgeBar  급증일 봉 (날짜와 저가를 씀)
 * @param {number} input.windowHigh       급증일까지 최근 20봉의 최고가 — 박스 상단의 «출발값»
 * @param {string} input.strategyVersion  전략 버전 (후보 ID에 들어감)
 * @returns {object} 후보. id 는 «종목 | 급증일 | 전략버전» 입니다.
 */
export function newCandidate({ ticker, surgeBar, windowHigh, strategyVersion }) {
  return {
    id: `${ticker}|${surgeBar.date}|${strategyVersion}`,
    ticker,
    surgeDate: surgeBar.date,
    surgeLow: surgeBar.l,   // 앞으로 이 값보다 낮은 저가가 나오면 탈락
    windowHigh,             // 확인 기간 동안 고가를 따라 올라갈 수 있음
    boxTop: null,           // 박스 상단 B. 확인이 끝나는 날 windowHigh 로 확정
    days: 0,                // 급증일 이후 지난 거래일 수
    state: STATES.CONFIRMING,
  };
}

/**
 * 하루가 지났을 때 후보를 한 칸 진행시킵니다. 원본 후보는 고치지 않고 새 객체를 돌려줍니다.
 *
 * 하루에 일어나는 일 (순서가 중요합니다):
 *   1) 이미 끝난 후보면 그대로 둔다
 *   2) 급증일 저가를 깼으면 INVALID  — 확인·돌파보다 먼저 검사한다
 *   3) 확인 중이면 박스 상단을 갱신하고, 3일째에 B 를 고정해 WAITING 으로 간다
 *   4) 대기 중이면 돌파를 검사하고, 돌파 못 한 채 10일이 지나면 EXPIRED
 *
 * @param {object} c        후보 (newCandidate 가 만든 모양)
 * @param {{date:string, h:number, l:number, c:number}} bar  오늘 일봉
 * @param {number|null} atrPrev  어제까지의 ATR14. 돌파 기준은 «전일» ATR 입니다. 없으면 돌파 판정을 건너뜁니다
 * @returns {{candidate: object, event: object|null}}
 *          event 는 상태가 바뀐 날에만 있습니다 (CONFIRMED / BREAKOUT / INVALIDATED / EXPIRED)
 */
export function advance(c, bar, atrPrev) {
  // 1) 끝난 후보는 움직이지 않는다
  if (TERMINAL.has(c.state)) return { candidate: c, event: null };

  // 하루가 지났다. 원본(c)을 고치지 않으려고 복사본을 만든다
  const next = { ...c, days: c.days + 1 };

  // 상태를 바꾸고 사건을 하나 남기는 공통 도구
  const finish = (state, type, detail) => ({
    candidate: { ...next, state },
    event: { candidateId: c.id, type, date: bar.date, ...detail },
  });

  // 2) 급증일 저가 이탈 — 같은 저가는 괜찮고, «더 낮아야» 탈락
  if (bar.l < c.surgeLow) {
    return finish(STATES.INVALID, "INVALIDATED", { reason: "SURGE_LOW_BROKEN", low: bar.l, surgeLow: c.surgeLow });
  }

  // 3) 확인 구간: 박스 상단을 따라 올리다가, 3일째에 고정
  if (c.state === STATES.CONFIRMING) {
    next.windowHigh = Math.max(c.windowHigh, bar.h);
    if (next.days === CONFIRM_DAYS) {
      next.boxTop = next.windowHigh;
      return finish(STATES.WAITING, "CONFIRMED", { boxTop: next.boxTop });
    }
    return { candidate: next, event: null };
  }

  // 4) 돌파 대기: B 는 이미 고정이라 오늘 고가를 넣지 않는다
  if (atrPrev !== null && atrPrev !== undefined && bar.c > c.boxTop + BREAKOUT_ATR * atrPrev) {
    return finish(STATES.BROKE_OUT, "BREAKOUT", { close: bar.c, boxTop: c.boxTop, atrPrev });
  }
  if (next.days - CONFIRM_DAYS >= WAIT_DAYS) return finish(STATES.EXPIRED, "EXPIRED", {});
  return { candidate: next, event: null };
}
