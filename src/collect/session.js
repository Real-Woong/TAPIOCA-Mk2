import { getUsRegularSessionStatus } from "./us-market-session.js";

// 정규장 마감(16:00) 뒤 30분을 «일봉이 확정됐다»고 보는 선입니다.
// 장중에 받으면 소스가 오늘의 미완성 봉을 함께 돌려주는데, 그것이 장부에 들어가면
// 거래량이 «그 시각까지의 값»으로 박혀 RVOL이 조용히 틀립니다.
// 조기 폐장일(13:00 마감)에도 이 선이면 확정 뒤입니다.
export const BAR_FINAL_AFTER_MINUTES = 16 * 60 + 30;

export function newYorkNow(now = new Date()) {
  const [date, time] = getUsRegularSessionStatus(now).newYorkTime.split(" ");
  const [hour, minute] = time.split(":").map(Number);
  return { date, minutes: hour * 60 + minute };
}

/** 뉴욕 오늘 날짜의 봉은 마감 확정 전이면 버립니다. 미래 날짜 봉도 버립니다. */
export function dropIncompleteBars(bars, now = new Date()) {
  const { date: today, minutes } = newYorkNow(now);
  const kept = bars.filter(
    (bar) => bar.date < today || (bar.date === today && minutes >= BAR_FINAL_AFTER_MINUTES),
  );
  return { bars: kept, dropped: bars.length - kept.length };
}
