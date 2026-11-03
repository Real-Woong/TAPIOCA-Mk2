// 후보 시험용 가짜 시세. 모든 숫자는 손으로 계산하기 쉽게 잡았습니다.
//
//  · 평소 봉: 종가 100, 고가 102, 저가 98, 거래량 100,000
//  · 급증일(surgeAt): 거래량 400,000(=RVOL 4), 종가 102.5, 고가 104, 저가 100
//      → Return20 = 2.5%, Range20 = 104/98−1 = 6.1%, CLV = 0.625, 거래대금 평균 $11.55M  (발견 조건 5개 전부 통과)
//  · 급증 이후 봉: 시가 101, 저가 100.5 (급증일 저가 100 위), 고가 103, 종가 101
//  ※ 시가는 반드시 저가~고가 사이여야 합니다. 벗어나면 수집기의 봉 정리가 그 봉을 버려서 종목이 «봉 부족»이 됩니다
//  · 돌파일(breakoutAt): 시가 106, 종가 110  (박스 상단 104 + 0.1×ATR 보다 훨씬 위)
import { cp } from "node:fs/promises";
import path from "node:path";

import { dataPaths } from "../../src/server/paths.js";
import { receiveAll } from "../../src/server/receive.js";
import { makeBatch } from "../server/helpers.js";

const dateOf = (i) => new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10); // 2026-06-01 부터 하루씩

export function scenario({ n = 90, surgeAt = 70, breakoutAt = null, extraSurgeAt = null, brokenLowAt = null } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const base = { date: dateOf(i), o: 100, h: 102, l: 98, c: 100, v: 100_000 };
    if (i === surgeAt || i === extraSurgeAt) return { ...base, v: i === surgeAt ? 400_000 : 500_000, c: 102.5, h: 104, l: 100 };
    if (i === breakoutAt) return { ...base, o: 106, h: 111, l: 105, c: 110 };
    if (i === brokenLowAt) return { ...base, h: 103, l: 95, c: 99 };
    if (i > surgeAt) return { ...base, o: 101, h: 103, l: 100.5, c: 101 };
    return base;
  });
}

/** 배치를 만들어 서버 inbox 에 «올린 것처럼» 놓고 receive 까지 돌린다. 이름 앞 날짜가 수집일. */
export async function receiveBatch(root, name, options) {
  const paths = dataPaths(path.join(root, "data"));
  const now = new Date(`${name.slice(0, 10)}T22:00:00Z`);
  await makeBatch(path.join(root, "_s", name), { now, ...options });
  await cp(path.join(root, "_s", name), path.join(paths.inbox, name), { recursive: true });
  await receiveAll({ dataRoot: paths.root });
  return paths;
}
