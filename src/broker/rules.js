// 토스에서 읽어 온 규칙을 해석합니다. 전부 «순수 함수»입니다 — 응답 모양을 넣으면 숫자·날짜가 나옵니다.
//
// ── 이 파일의 구성 ──────────────────────────────────────────────────────────
//  commissionBpsOn()   그 날짜에 적용되는 미국 주식 수수료(한쪽, bp). 해당 줄이 없으면 null (호출한 쪽이 가정값을 쓴다)
//  nextRegularOpen()   지금 이후 가장 가까운 미국 정규장 개장 시각 (한국 시간 글자와 ISO 둘 다)
//
// 응답 모양은 2026-10-31 읽기 전용 확인(scripts/toss-probe.mjs)에서 확인한 것입니다:
//  · /commissions   → [{ marketCountry:"US", commissionRate:"0.001", startDate:null|"YYYY-MM-DD", endDate:"YYYY-MM-DD" }, ...]
//  · /market-calendar/US → { today, previousBusinessDay, nextBusinessDay: { date, regularMarket: { startTime, endTime } | null, ... } }

/**
 * 수수료표에서 `date` 에 적용되는 미국 줄을 찾아 bp(1bp = 0.01%)로 돌려준다.
 * 시작일이 없으면 «처음부터», 종료일이 없으면 «계속». 여러 줄이 겹치면 시작일이 가장 늦은(가장 새로운) 줄을 쓴다.
 * 적용되는 줄이 없으면 null — 요율표가 끝났는데 새 요율이 아직 안 올라온 경우 등. 다른 값으로 어림하지 않는다.
 */
export function commissionBpsOn(rows, date) {
  if (!Array.isArray(rows)) return null;
  const applicable = rows.filter(
    (row) =>
      row?.marketCountry === "US" &&
      (!row.startDate || row.startDate <= date) &&
      (!row.endDate || row.endDate >= date),
  );
  if (!applicable.length) return null;
  applicable.sort((a, b) => (a.startDate ?? "").localeCompare(b.startDate ?? ""));
  const rate = Number(applicable.at(-1).commissionRate);
  return Number.isFinite(rate) && rate >= 0 ? Math.round(rate * 10_000 * 1e6) / 1e6 : null;
}

/**
 * 오늘·다음 영업일의 정규장 시작 중 `now` 이후로 가장 가까운 것.
 * 토스는 한국 시간(+09:00)으로 줄 때만 «MM/DD HH:MM» 글자를 만든다(다른 오프셋이면 시각만 ISO 로 돌려준다).
 * 정규장이 없는 날(휴장)은 startTime 이 없으므로 건너뛴다.
 * @returns {{iso:string, label:string|null}|null}
 */
export function nextRegularOpen(calendar, now = new Date()) {
  const starts = [calendar?.today, calendar?.nextBusinessDay]
    .map((day) => day?.regularMarket?.startTime)
    .filter(Boolean)
    .filter((iso) => Date.parse(iso) > now.getTime())
    .sort();
  if (!starts.length) return null;
  const iso = starts[0];
  const kst = /^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2}).*\+09:00$/.exec(iso);
  return { iso, label: kst ? `${kst[1]}/${kst[2]} ${kst[3]}` : null };
}
