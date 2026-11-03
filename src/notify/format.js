// 보고 문구 만들기. 전부 «순수 함수»입니다 — 구조화된 데이터를 받아 글자를 돌려줍니다.
//
// ── 이 파일의 구성 ──────────────────────────────────────────────────────────
//  formatDailyReport()   매일 장 마감 뒤 보고 — 아침에 정신없이 봐도 읽히도록 «결론 한 줄 → 할 일 → 계좌 → 후보»
//  formatStartReport()   보고를 처음 시작할 때의 짧은 안내
//  formatWatchdog()      수집이 안 들어왔을 때의 경고
//  expectedAsOf()        지금 시점에 DB에 있어야 할 «가장 최근 거래일(대략)»  — 휴장일 달력은 모른다
//
// ── 문구를 정하는 원칙 ──────────────────────────────────────────────────────
//  · 첫 줄 아래 «결론 한 줄»이 오늘의 전부입니다. 나머지는 읽고 싶을 때만 읽으면 됩니다.
//  · 지표 숫자(RVOL·범위·DryUp·환율 분해)는 보고에서 뺐습니다. DB(candidate_events, paper_trades)에 그대로 있습니다.
//  · 해당 사건이 없는 칸은 줄 자체를 만들지 않습니다. 목록은 종목 이름만, 길면 줄입니다.
//  · 금액은 원화(₩), 주가·손절선은 달러($).

import { newYorkNow } from "../collect/session.js";

const krw = (x) => `${x < 0 ? "-" : ""}₩${Math.round(Math.abs(x)).toLocaleString("en-US")}`;
const signedKrw = (x) => `${x >= 0 ? "+" : "-"}₩${Math.round(Math.abs(x)).toLocaleString("en-US")}`;
const usd = (x) => `$${x.toFixed(2)}`;
const pct = (x, digits = 1) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(digits)}%`;
const monthDay = (date) => `${date.slice(5, 7)}/${date.slice(8, 10)}`;
const names = (items, max = 8) => (items.length <= max ? items.join(" ") : `${items.slice(0, max).join(" ")} 외 ${items.length - max}`);

/** 청산·건너뜀 사유를 사람 말로. 모르는 값은 그대로 보여 준다 */
const EXIT_LABEL = { STOP: "손절", TRAIL_STOP: "추적 손절", BELOW_BOX: "박스 이탈", TIME: "시간 초과" };
const SKIP_LABEL = {
  GAP: "시가가 너무 높음", MAX_POSITIONS: "보유 자리 없음", SIZE_ZERO: "살 금액이 너무 작음",
  NOT_ELIGIBLE: "앱에서 금액주문 불가로 기록됨", NO_CASH: "현금 부족", BAD_STOP: "손절선이 진입가 이상", NO_BAR_NEXT_DAY: "다음 날 거래 없음",
};
const exitLabel = (reason) => EXIT_LABEL[reason] ?? reason;
const skipLabel = (reason) => SKIP_LABEL[reason] ?? reason;

/**
 * @param {object} d  gatherReport() 의 결과
 */
export function formatDailyReport(d) {
  const b = d.batch;
  const breakouts = d.events.filter((e) => e.type === "BREAKOUT");
  const confirmed = d.events.filter((e) => e.type === "CONFIRMED");
  const found = d.events.filter((e) => e.type === "DISCOVERED");
  const ended = d.events.filter((e) => e.type === "INVALIDATED" || e.type === "EXPIRED");
  const p = d.paper;
  const out = [];

  // ── 머리와 결론 한 줄
  out.push(`TAPIoca 모의 · ${monthDay(b.as_of)} 마감분`);
  const todo = [];
  if (breakouts.length) todo.push(`🔔 매수 신호 ${breakouts.length}건`);
  if (p.exits.length) todo.push(`청산 ${p.exits.length}건`);
  if (p.fills.length) todo.push(`모의 매수 ${p.fills.length}건`);
  out.push(todo.length ? todo.join(" · ") : "오늘은 할 일 없음");

  // 수집이 의미 있게 비었을 때만 알린다(1건 정도 빠지는 건 늘 있는 일)
  if (b.requested > 0 && (b.requested - b.ok) / b.requested > 0.01) out.push(`⚠ 수집 누락 ${b.requested - b.ok}종목 (${b.ok}/${b.requested})`);

  // ── 오늘 일어난 일 (있는 것만)
  if (breakouts.length) {
    out.push("");
    out.push(d.nextOpen ? `🔔 매수 신호 — ${d.nextOpen} 정규장 개장에 모의 진입 (한국 시간)` : "🔔 매수 신호 — 내일 시가에 모의 진입");
    const frac = d.fractional ?? {};
    const fracLabel = (ticker) => (frac[ticker] === "OK" ? " · 금액주문 가능" : frac[ticker] === "NO" ? " · 금액주문 불가" : " · 금액주문 확인 필요");
    for (const e of breakouts) out.push(`  ${e.ticker}  종가 ${usd(e.detail.close)} (박스 ${usd(e.detail.boxTop)} 돌파)${fracLabel(e.ticker)}`);
    if (breakouts.some((e) => !frac[e.ticker])) out.push("  → 앱에서 «금액으로 사기»가 되는지 보고 기록: npm run fractional -- 종목 ok|no");
  }
  if (p.fills.length || p.exits.length || p.skips.length) {
    out.push("");
    for (const f of p.fills) out.push(`🟢 모의 매수 ${f.ticker}  ${krw(f.cost_krw)}어치 · 손절 ${usd(f.initial_stop)}`);
    for (const e of p.exits) out.push(`🔴 청산 ${e.ticker}  ${signedKrw(e.pnl_krw)} (${pct(e.return_krw)}) · ${exitLabel(e.exit_reason)}`);
    for (const s of p.skips) out.push(`⏭ 건너뜀 ${s.ticker}  ${skipLabel(s.reason)}`);
  }

  // ── 보유와 계좌
  if (p.open.length) {
    out.push("");
    out.push(`보유 ${p.open.length}종목`);
    for (const t of p.open.slice(0, 5)) {
      const unrealized = t.last_close && p.fx ? t.qty * t.last_close * p.fx - t.cost_krw : null;
      const gain = unrealized === null ? "" : `  ${signedKrw(unrealized)} (${pct(unrealized / t.cost_krw)})`;
      out.push(`  ${t.ticker}${gain}${t.pending_exit ? `  ⚠ 내일 시가 매도(${exitLabel(t.pending_exit)})` : ""}`);
    }
    if (p.open.length > 5) out.push(`  … 외 ${p.open.length - 5}종목`);
  }
  if (p.account) {
    out.push("");
    out.push(`계좌 ${krw(p.account.equity)} (${pct(p.account.equity / p.account.start - 1, 2)}) · 현금 ${krw(p.account.cash)}`);
    if (p.closedCount) out.push(`누적 청산 ${p.closedCount}건 · ${signedKrw(p.sumPnlKrw)} (표본이 적어 판단 보류)`);
  }

  // ── 후보 (참고용)
  const cand = [];
  if (found.length) cand.push(`새 후보 ${found.length}: ${names(found.map((e) => `${e.ticker}${e.marketWide ? "*" : ""}`))}`);
  if (confirmed.length) cand.push(`3일 확인 통과 ${confirmed.length}: ${names(confirmed.map((e) => e.ticker))}`);
  if (ended.length) cand.push(`종료 ${ended.length}건`);
  if (d.waiting.length) cand.push(`돌파 대기 ${d.waiting.length}: ${names(d.waiting.map((w) => w.ticker))}`);
  if (cand.length) {
    out.push("");
    out.push(...cand);
  }
  if (found.some((e) => e.marketWide) && d.breadth) {
    out.push(`* 시장 전체 거래량이 터진 날 (급증 종목 ${d.breadth.surge}개) — 참고만`);
  }
  return out.join("\n");
}

export function formatStartReport(d) {
  const c = d.counts;
  return [
    "TAPIoca 모의 · 보고를 시작합니다",
    `데이터 기준일 ${monthDay(d.batch.as_of)} · 후보 ${(c.CONFIRMING ?? 0) + (c.WAITING ?? 0)}개 진행 중`,
    d.paper.account ? `가상 계좌 ${krw(d.paper.account.equity)} (실제 돈 아님)` : "가상 계좌: 아직 시작 전",
    "",
    "장 마감분이 처리되면 아침에 한 통씩 보냅니다. 과거에 쌓인 후보는 보고하지 않습니다.",
  ].join("\n");
}

export function formatWatchdog({ latestAsOf, expected, lastBatch }) {
  return [
    "⚠ TAPIoca · 수집이 안 들어왔습니다",
    `서버 최신 ${latestAsOf ? monthDay(latestAsOf) : "없음"} · 있어야 할 날짜 ${monthDay(expected)}`,
    lastBatch ? `마지막 적재 ${lastBatch}` : "",
    "",
    "Mac mini 켜짐과 data/logs/daily-날짜.log 를 확인하세요. (미국 휴장일이면 정상)",
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
}

/** 지금 뉴욕 시각 기준으로 DB에 있어야 할 가장 최근 «평일» 봉 날짜. 휴장일은 모른다. */
export function expectedAsOf(now = new Date()) {
  const ny = newYorkNow(now);
  const day = new Date(`${ny.date}T00:00:00Z`);
  if (ny.minutes < 16 * 60 + 30) day.setUTCDate(day.getUTCDate() - 1); // 오늘 봉은 아직 확정 전
  while ([0, 6].includes(day.getUTCDay())) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}
