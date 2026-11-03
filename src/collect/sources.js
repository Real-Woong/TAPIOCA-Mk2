// TAPIOCA Ver2 수집기의 가격 소스 어댑터입니다. 소스마다 응답 모양이 달라서 여기서 한 모양으로 맞춥니다.
//
//   봉 하나: { date: "YYYY-MM-DD", o, h, l, c, v }   (Yahoo는 배당 조정 종가 ac가 더 붙습니다)
//
// 실패는 세 종류로만 나눕니다 — 수집기가 대응을 다르게 하기 때문입니다.
//   BlockedError   차단/한도(429·403·HTML 벽). 재시도하면 IP만 더 불리해지므로 멈추는 쪽으로 셉니다.
//   NotFoundError  그 종목이 소스에 없음. 재시도해도 같으므로 기록하고 넘어갑니다.
//   RetryableError 시간 초과·5xx·파싱 실패. 간격을 두고 다시 시도합니다.

export class BlockedError extends Error {}
export class NotFoundError extends Error {}
export class RetryableError extends Error {}

// Yahoo는 Chrome으로 위장한 User-Agent를 429로 막고, 스스로를 밝히는 단순한 값은 통과시킵니다
// (2026-10-29 같은 URL을 두 UA로 번갈아 요청해 확인: 단순 UA 200 · Chrome UA 429).
// 접근 시험(scripts/access-probe.mjs)이 통과한 값과 같은 모양을 씁니다.
// 기본 Node User-Agent는 차단되는 소스가 있어 비워 두지 않습니다.
export const COLLECTOR_USER_AGENT = "Mozilla/5.0 (compatible; tapioca-collector)";

export const BARS_BY_MODE = Object.freeze({ backfill: 130, daily: 10 });

export async function httpGet(url, { headers = {}, timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { "user-agent": COLLECTOR_USER_AGENT, ...headers },
      signal: controller.signal,
    });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    throw new RetryableError(error.name === "AbortError" ? "timeout" : error.message);
  } finally {
    clearTimeout(timer);
  }
}

/** 상태 코드와 본문만 보고 «받은 게 데이터가 아니다»를 먼저 가려냅니다. */
export function classifyResponse({ status, body }) {
  if (status === 429 || status === 403) throw new BlockedError(`HTTP ${status}`);
  if (status === 404) throw new NotFoundError("HTTP 404");
  if (status >= 500) throw new RetryableError(`HTTP ${status}`);
  // 봇 차단 벽은 200과 함께 HTML을 돌려줍니다.
  if (body.trimStart().startsWith("<")) throw new BlockedError("HTML 응답(봇 차단 벽 의심)");
  if (status !== 200) throw new RetryableError(`HTTP ${status}`);
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    throw new RetryableError("JSON 파싱 실패");
  }
}

export function parseYahoo(body) {
  const json = parseJson(body);
  const result = json.chart?.result?.[0];
  if (!result) throw new NotFoundError(json.chart?.error?.description ?? "result 없음");
  const quote = result.indicators?.quote?.[0] ?? {};
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose;
  const bars = (result.timestamp ?? []).map((ts, i) => ({
    date: new Date(ts * 1000).toISOString().slice(0, 10),
    o: quote.open?.[i],
    h: quote.high?.[i],
    l: quote.low?.[i],
    c: quote.close?.[i],
    v: quote.volume?.[i],
    ...(adjusted ? { ac: adjusted[i] } : {}),
  }));
  return { bars, adjustment: "split(조회 시점 기준)" };
}

export function parseStooq(body) {
  const lines = body.trim().split("\n");
  if (/^no data/i.test(lines[0] ?? "")) throw new NotFoundError("No data");
  if (!/^date,open,high,low,close,volume/i.test(lines[0] ?? "")) {
    throw new RetryableError(`예상 밖 첫 줄: ${(lines[0] ?? "").slice(0, 40)}`);
  }
  const bars = lines.slice(1).map((line) => {
    const [date, o, h, l, c, v] = line.split(",");
    return { date, o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v) };
  });
  return { bars, adjustment: "unverified" };
}

export function parseTwelveData(body) {
  const json = parseJson(body);
  if (json.status === "error") {
    if (json.code === 429) throw new BlockedError("Twelve Data 429");
    if (json.code === 400 || json.code === 404) throw new NotFoundError(String(json.message).slice(0, 60));
    throw new RetryableError(`${json.code} ${json.message}`.slice(0, 80));
  }
  const bars = [...(json.values ?? [])].reverse().map((x) => ({
    date: x.datetime,
    o: Number(x.open),
    h: Number(x.high),
    l: Number(x.low),
    c: Number(x.close),
    v: Number(x.volume),
  }));
  return { bars, adjustment: "unverified" };
}

// 티커 표기 차이: Nasdaq 파일은 «BRK.B», Yahoo는 «BRK-B».
const yahooSymbol = (ticker) => ticker.replace(/\./g, "-");

export const SOURCES = Object.freeze({
  yahoo: {
    url: (ticker, mode) =>
      `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol(ticker)}?range=${mode === "backfill" ? "6mo" : "1mo"}&interval=1d`,
    parse: parseYahoo,
  },
  stooq: {
    url: (ticker) => `https://stooq.com/q/d/l/?s=${ticker.toLowerCase().replace(/\./g, "-")}.us&i=d`,
    parse: parseStooq,
  },
  twelvedata: {
    needsKey: "TWELVE_DATA_API_KEY",
    url: (ticker, mode, env) =>
      `https://api.twelvedata.com/time_series?symbol=${ticker}&interval=1day&outputsize=${BARS_BY_MODE[mode]}&apikey=${env.TWELVE_DATA_API_KEY}`,
    parse: parseTwelveData,
  },
});

/** 한 소스에서 한 종목의 최근 일봉을 받아 {bars, adjustment}로 돌려줍니다. */
export async function fetchBarsFrom(sourceName, ticker, { mode = "daily", env = process.env, fetchImpl } = {}) {
  const source = SOURCES[sourceName];
  if (!source) throw new Error(`알 수 없는 소스: ${sourceName}`);
  if (source.needsKey && !env[source.needsKey]) throw new Error(`${source.needsKey} 가 필요합니다`);
  const response = await httpGet(source.url(ticker, mode, env), { fetchImpl });
  classifyResponse(response);
  const parsed = source.parse(response.body);
  return { bars: parsed.bars.slice(-BARS_BY_MODE[mode]), adjustment: parsed.adjustment };
}

/**
 * 값이 비었거나 모순인 봉을 걸러 내고 날짜순·중복 없이 정렬합니다.
 * 고치지 않고 버리며 버린 개수를 돌려줍니다 — 결측을 추정해 채우지 않습니다.
 */
export function cleanBars(bars) {
  const valid = (bar) =>
    /^\d{4}-\d{2}-\d{2}/.test(bar.date ?? "") &&
    [bar.o, bar.h, bar.l, bar.c].every((x) => Number.isFinite(x) && x > 0) &&
    Number.isFinite(bar.v) && bar.v >= 0 &&
    bar.h >= bar.l && bar.h >= Math.max(bar.o, bar.c) && bar.l <= Math.min(bar.o, bar.c);
  const byDate = new Map();
  for (const bar of bars) {
    if (valid(bar)) byDate.set(bar.date.slice(0, 10), { ...bar, date: bar.date.slice(0, 10) });
  }
  const kept = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { bars: kept, dropped: bars.length - kept.length };
}
