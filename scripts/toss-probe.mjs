#!/usr/bin/env node
// 토스 Open API «읽기 전용» 확인 — NASDAQ 소형주를 실제로 어떻게 살 수 있는지 주문 없이 알아본다.
//
//   node scripts/toss-probe.mjs                 후보 종목 몇 개 + VTI(기준선)
//   node scripts/toss-probe.mjs --tickers SVA,IOSP
//
// 서버(Oracle)에서만 돌립니다 (토스가 허용한 공인 IP, .env 의 TOSS_CLIENT_ID/SECRET 필요).
//
// ── 무엇을 알아내려는가 ─────────────────────────────────────────────────────
//  1. 소수점(금액) 주문이 이 종목에서 되는가       → API 로는 알 수 없음(2026-10-31 확인: /stocks 에 필드 없음, 사전 조회 API 없음)
//  2. 매수 시 유의사항·거래 제한이 있는가          → /stocks/{symbol}/warnings
//  3. 수수료가 얼마인가 (모의의 환전·수수료 가정 대조) → /commissions (계좌 단위, 종목 무관)
//  4. 조건주문(가격에 닿으면 자동 주문)으로 장중 손절이 가능한가 → 목록 조회만 (등록은 절대 안 함)
//
// ── 안전 장치 ───────────────────────────────────────────────────────────────
//  · 토큰 발급(POST /oauth2/token)을 빼면 «GET 만» 보냅니다. get() 안에서 경로를 허용 목록으로 다시 검사합니다.
//  · 주문·정정·취소·조건주문 등록 경로는 코드에 아예 없습니다.
//  · 출력에서 토큰·계좌번호처럼 보이는 긴 숫자는 가립니다.
//
// ── 이 파일의 구성 ──────────────────────────────────────────────────────────
//  ALLOWED     호출해도 되는 GET 경로 (이 밖은 던진다)
//  get()       허용 목록 검사 → GET → 상태·본문을 돌려준다 (오류도 던지지 않고 결과로 돌려줘 끝까지 본다)
//  show()      한 호출의 결과를 보기 좋게 출력 (긴 본문은 자르고, 필드 이름 목록을 따로 보여 준다)
//  main        계좌 → 시장 일정 → 종목마다 5가지 조회 → 조건주문 목록

import process from "node:process";

import { createTossClientFromEnv } from "../src/toss/toss-client.js";

try { process.loadEnvFile(".env"); } catch { /* 환경변수로 이미 주어졌을 수 있다 */ }

const BASE = process.env.TOSS_API_BASE_URL || "https://openapi.tossinvest.com";
const ALLOWED = [
  /^\/api\/v1\/accounts$/,
  /^\/api\/v1\/stocks(\?|$)/,
  /^\/api\/v1\/stocks\/[A-Za-z0-9.\-]+\/warnings$/,
  /^\/api\/v1\/prices\?/,
  /^\/api\/v1\/buying-power(\?|$)/,
  /^\/api\/v1\/commissions(\?|$)/,
  /^\/api\/v1\/market-calendar\/US$/,
  /^\/api\/v1\/exchange-rate\?/,
  /^\/api\/v1\/conditional-orders(\?|$)/, // 목록 조회만. 등록은 POST 라서 get() 이 보내지 않는다
];

const client = createTossClientFromEnv();

const redact = (text) => text.replace(/\b\d{9,}\b/g, "<숫자가림>").replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<토큰가림>");

async function get(path, { account } = {}) {
  if (!ALLOWED.some((re) => re.test(path))) throw new Error(`허용 목록에 없는 경로입니다: ${path}`);
  await new Promise((resolve) => setTimeout(resolve, 700)); // 호출 한도(429) 방지 — 처음 실행에서 2건이 막혔다
  const headers = { accept: "application/json", authorization: `Bearer ${await client.getAccessToken()}` };
  if (account !== undefined) headers["X-Tossinvest-Account"] = String(account);
  try {
    const response = await fetch(`${BASE}${path}`, { method: "GET", headers, signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* JSON 이 아니면 글자 그대로 */ }
    return { status: response.status, ok: response.ok, body };
  } catch (error) {
    return { status: 0, ok: false, body: `연결 실패: ${error.message}` };
  }
}

/** 중첩 객체의 필드 경로를 모은다 — 응답에 어떤 항목이 있는지(예: 소수점 가능 여부) 한눈에 보려는 것 */
const fieldPaths = (value, prefix = "", out = new Set()) => {
  if (Array.isArray(value)) value.slice(0, 1).forEach((v) => fieldPaths(v, `${prefix}[]`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) fieldPaths(v, prefix ? `${prefix}.${k}` : k, out);
  else out.add(prefix);
  return out;
};

function show(title, result) {
  console.log(`\n▶ ${title}  → HTTP ${result.status}`);
  const text = redact(typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2));
  console.log(text.length > 1800 ? `${text.slice(0, 1800)}\n… (${text.length - 1800}자 생략)` : text);
  if (result.body && typeof result.body === "object") console.log(`  필드: ${[...fieldPaths(result.body)].join(", ")}`);
}

// ── 대상 종목: 인자 → 없으면 DB 의 후보 몇 개 → 그래도 없으면 VTI 만
function argTickers() {
  const i = process.argv.indexOf("--tickers");
  return i >= 0 ? process.argv[i + 1].split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : null;
}

async function pickTickers() {
  const given = argTickers();
  if (given) return given;
  try {
    const { openDb } = await import("../src/server/db.js");
    const db = openDb("data/4_db/tapioca.sqlite");
    const rows = db.prepare("SELECT DISTINCT ticker FROM candidates ORDER BY surge_date DESC LIMIT 5").all();
    db.close();
    return [...rows.map((r) => r.ticker), "VTI"];
  } catch {
    return ["VTI"];
  }
}

const accounts = await get("/api/v1/accounts");
show("계좌 목록", accounts);
const account = accounts.body?.result?.[0]?.accountSeq;
if (account === undefined) {
  console.error("\n계좌를 못 읽었습니다 — 위 오류(IP 허용·키)를 먼저 해결하세요.");
  process.exit(1);
}

show("미국 장 운영 정보", await get("/api/v1/market-calendar/US"));

// 계좌 단위 정보 — 최신 명세(v1.2.28)에서 /buying-power 는 currency 만, /commissions 는 쿼리 없이 «현재 계좌 기준»입니다.
// (처음 확인 때 symbol 을 붙였지만 무시되어 모든 종목이 같은 값이 나온 것이다. 종목별 적격성 증거가 아니다)
show("매수 가능 금액 (USD 현금만 — Open API 는 자동환전을 지원하지 않는다)", await get("/api/v1/buying-power?currency=USD", { account }));
show("수수료 (현재 계좌의 시장별 요율)", await get("/api/v1/commissions", { account }));

for (const ticker of await pickTickers()) {
  console.log(`\n${"═".repeat(60)}\n■ ${ticker}`);
  show(`종목 기본 정보`, await get(`/api/v1/stocks?symbols=${encodeURIComponent(ticker)}`));
  show(`매수 유의사항`, await get(`/api/v1/stocks/${encodeURIComponent(ticker)}/warnings`));
  show(`현재가`, await get(`/api/v1/prices?symbols=${encodeURIComponent(ticker)}`));
}

console.log(`\n${"═".repeat(60)}`);
show("조건주문 목록 (진행 중) — 조회만, 등록 안 함", await get("/api/v1/conditional-orders?status=OPEN", { account }));
console.log("\n■ 끝 — 주문 API 는 호출하지 않았습니다.");
