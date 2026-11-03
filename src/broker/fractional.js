// «이 종목을 금액주문(소수점)으로 살 수 있는가»의 기록과 조회.
//
// 토스 Open API 에는 사전 조회가 없습니다(2026-10-31 확인: /stocks 에 필드 없음, 거절 오류 코드도 문서에 없음).
// 그래서 신호가 난 종목을 앱에서 보고 사람이 적거나, 실제 주문의 결과로 알게 된 것을 남깁니다.
//
// ── 이 파일의 구성 ──────────────────────────────────────────────────────────
//  RESULTS               OK(가능) / NO(불가) 두 값만
//  recordFractional()    기록 한 줄 추가 (덮어쓰지 않는다)
//  latestFractional()    종목의 가장 새 판단 (없으면 null = 아직 모름)
//  fractionalSummary()   종목마다 가장 새 판단을 모아 가능/불가 개수 — 모의가 낙관적인 정도를 재는 숫자

export const RESULTS = Object.freeze(["OK", "NO"]);
const SOURCES = ["APP", "ORDER"];

/** 'ok|no|가능|불가' 같은 사람 입력을 OK/NO 로. 모르는 말은 null */
export function parseResult(text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (["ok", "yes", "y", "가능", "됨"].includes(t)) return "OK";
  if (["no", "n", "불가", "안됨", "안 됨"].includes(t)) return "NO";
  return null;
}

export function recordFractional(db, ticker, result, { source = "APP", note = null, now = new Date() } = {}) {
  if (!RESULTS.includes(result)) throw new Error(`결과는 OK 또는 NO 입니다: ${result}`);
  if (!SOURCES.includes(source)) throw new Error(`출처는 APP 또는 ORDER 입니다: ${source}`);
  const symbol = String(ticker ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,10}$/.test(symbol)) throw new Error(`종목 코드가 이상합니다: ${ticker}`);
  db.prepare("INSERT INTO fractional_checks (ticker, result, source, note, checked_at) VALUES (?,?,?,?,?)")
    .run(symbol, result, source, note, now.toISOString());
  return symbol;
}

/** @returns {{result:'OK'|'NO', source:string, note:string|null, checkedAt:string}|null} */
export function latestFractional(db, ticker) {
  const row = db.prepare("SELECT result, source, note, checked_at FROM fractional_checks WHERE ticker = ? ORDER BY id DESC LIMIT 1").get(ticker);
  return row ? { result: row.result, source: row.source, note: row.note, checkedAt: row.checked_at } : null;
}

/** @returns {{ok:number, no:number, tickers:number}} 종목마다 가장 새 판단만 센다 */
export function fractionalSummary(db) {
  const rows = db.prepare(`SELECT result FROM fractional_checks
    WHERE id IN (SELECT MAX(id) FROM fractional_checks GROUP BY ticker)`).all();
  const ok = rows.filter((r) => r.result === "OK").length;
  return { ok, no: rows.length - ok, tickers: rows.length };
}
