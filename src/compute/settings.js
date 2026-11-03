// 전략 v1 의 «고정값»입니다. 스펙(docs/STRATEGY_SPEC.md)에서 정한 숫자를 코드 한곳에 못 박아 둡니다.
//
// 값을 바꾸면 STRATEGY_VERSION 을 올리세요. 후보·이벤트 기록에 이 버전이 같이 남아서,
// «어느 규칙으로 뽑은 후보인가»를 나중에 구분할 수 있습니다(백테스트 과적합 방지: 시도한 조건을 전부 기록).

export const STRATEGY_VERSION = "ver2-v1";

export const SETTINGS = Object.freeze({
  /** 직전 몇 거래일 평균과 비교하는가 (급증일 자신은 평균에서 뺀다) */
  rvolWindow: 60,
  rvolMin: 3.0,
  returnWindow: 20,
  returnMin: -0.03,
  returnMax: 0.03,
  rangeWindow: 20,
  rangeMax: 0.12,
  clvMin: 0.5,
  addvWindow: 20,
  addvMinUsd: 10_000_000,
  atrWindow: 14,
  /** 봉이 이보다 적은 종목은 계산에서 제외(신규 상장 등) */
  minBars: 80,
});
