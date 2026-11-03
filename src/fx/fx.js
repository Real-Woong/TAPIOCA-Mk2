// 원/달러 환율. 한국은행 ECOS 일별 «원/미국달러(매매기준율)» — 토스 앱이 해외주식 원화 평가에 쓰는 하루 고정 기준환율과
// 같은 값입니다(ETF 시스템 src/portfolio/base-fx.js 에서 같은 날 앱 평가 환율 역산값과 일치함을 확인).
//
// ── 이 파일의 구성 ──────────────────────────────────────────────────────────
//  fetchEcosRates()   ECOS 에서 최근 며칠의 일별 환율을 받는다
//  saveRates()        DB(fx_rates)에 넣는다 (같은 날짜는 덮어쓴다 — 확정 전 값이 정정될 수 있다)
//  refreshRates()     받아서 저장한다. 실패하면 던지지만, 이미 저장된 환율은 그대로 쓸 수 있다
//  rateOn()           어느 날짜의 환율 = 그날 또는 그 이전 가장 가까운 영업일의 값
//
// ── 날짜 대응 (근사) ────────────────────────────────────────────────────────
// 미국 거래일 d 의 환율 = 달력 날짜 d 의 매매기준율(없으면 직전 영업일). 실제 체결은 한국 시간 d 밤, 마감 평가는 d+1 아침이라
// 하루쯤 어긋날 수 있습니다. 앱의 평가 환율과 최대 하루치 차이가 나는 근사이고, 그 차이는 환율의 하루 변동폭 안입니다.
//
// ── 환율이 없을 때 ──────────────────────────────────────────────────────────
// 달러 값에 다른 환율을 대신 곱해서 원화를 채우지 않습니다. 환율이 없으면 호출한 쪽이 멈추게 합니다
// (10/14 개발로그: 달러 손익 × 오늘 환율은 부호까지 틀릴 수 있었다).

const ECOS_BASE_URL = "https://ecos.bok.or.kr/api/StatisticSearch";
const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const MAX_RATE_GAP_DAYS = 7;

const kstYyyymmdd = (date) => new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10).replaceAll("-", "");

/**
 * @returns {Promise<{date:string, rate:number}[]>} 날짜 오름차순
 * ECOS_API_KEY 가 없으면 한국은행이 주는 sample 키(10건 제한)를 씁니다 — 매일 최근 며칠만 받으니 충분합니다.
 */
export async function fetchEcosRates({ apiKey = process.env.ECOS_API_KEY || "sample", fetchImpl = fetch, now = new Date(), lookbackDays = 14, timeoutMs = 10_000 } = {}) {
  const end = kstYyyymmdd(now);
  const start = kstYyyymmdd(new Date(now.getTime() - lookbackDays * DAY_MS));
  const url = `${ECOS_BASE_URL}/${encodeURIComponent(apiKey)}/json/kr/1/10/731Y001/D/${start}/${end}/0000001`;

  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`한국은행 ECOS 연결 실패(${error.cause?.code ?? error.code ?? error.name})`); // 주소에 키가 있어 원인 코드만 남긴다
  }
  if (!response.ok) throw new Error(`한국은행 ECOS 응답 오류 (HTTP ${response.status})`);
  const body = await response.json();
  const rows = body?.StatisticSearch?.row;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`한국은행 ECOS: ${String(body?.RESULT?.MESSAGE ?? "조회된 환율이 없습니다").split("\n")[0]}`);
  }
  const rates = rows
    .map((row) => ({ t: String(row.TIME), rate: Number(row.DATA_VALUE) }))
    .filter((row) => /^\d{8}$/.test(row.t) && Number.isFinite(row.rate) && row.rate > 0)
    .map((row) => ({ date: `${row.t.slice(0, 4)}-${row.t.slice(4, 6)}-${row.t.slice(6, 8)}`, rate: row.rate }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!rates.length) throw new Error("한국은행 ECOS: 읽을 수 있는 환율 값이 없습니다");
  return rates;
}

export function saveRates(db, rates, nowIso = new Date().toISOString()) {
  const upsert = db.prepare(`INSERT INTO fx_rates (date, usdkrw, source, fetched_at) VALUES (?,?,'ECOS',?)
    ON CONFLICT(date) DO UPDATE SET usdkrw = excluded.usdkrw, fetched_at = excluded.fetched_at`);
  for (const { date, rate } of rates) upsert.run(date, rate, nowIso);
  return rates.length;
}

export async function refreshRates(db, options = {}) {
  const rates = await fetchEcosRates(options);
  return { saved: saveRates(db, rates, (options.now ?? new Date()).toISOString()), latest: rates.at(-1) };
}

/** date 당일 또는 그 이전 가장 가까운 영업일의 환율. 7일 넘게 비어 있으면 null. */
export function rateOn(db, date) {
  const row = db.prepare("SELECT date, usdkrw FROM fx_rates WHERE date <= ? ORDER BY date DESC LIMIT 1").get(date);
  if (!row) return null;
  const gap = (Date.parse(date) - Date.parse(row.date)) / DAY_MS;
  return gap > MAX_RATE_GAP_DAYS ? null : { rate: row.usdkrw, date: row.date };
}
