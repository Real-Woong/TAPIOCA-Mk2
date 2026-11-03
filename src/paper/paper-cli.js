#!/usr/bin/env node

// 모의매매를 한 번 돌리고(밀린 날이 있으면 모두 처리) 현황을 보여 줍니다. receive → candidates 다음에 매일 실행.
//   npm run paper
//   npm run paper -- --data /path/to/data
//
// 가상 «원화» 계좌입니다. 실제 주문·실계좌와 아무 관계가 없습니다.
// 실행할 때마다 한국은행 ECOS 에서 최근 환율을 먼저 받습니다(.env 의 ECOS_API_KEY, 없으면 sample 키).
// 토스 키(.env 의 TOSS_CLIENT_ID/SECRET)가 있으면 수수료표와 미국 장 일정도 «읽어서» 저장합니다(주문 API 는 호출하지 않음).

import process from "node:process";

import { commissionBpsOn, nextRegularOpen } from "../broker/rules.js";
import { createClientIfConfigured, refreshBrokerRules } from "../broker/refresh.js";
import { refreshRates } from "../fx/fx.js";
import { loadEnv } from "../notify/telegram.js";
import { openDb } from "../server/db.js";
import { dataPaths } from "../server/paths.js";
import { runPaper } from "./engine.js";
import { PAPER_SETTINGS, PAPER_VERSION } from "./settings.js";

const idx = process.argv.indexOf("--data");
const paths = dataPaths(idx >= 0 ? process.argv[idx + 1] : "data");

const krw = (x) => `${x < 0 ? "-" : ""}₩${Math.round(Math.abs(x)).toLocaleString("en-US")}`;
const signedKrw = (x) => `${x >= 0 ? "+" : "-"}₩${Math.round(Math.abs(x)).toLocaleString("en-US")}`;
const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
const signedR = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`;

loadEnv();
const db = openDb(paths.dbFile);

try {
  try {
    const { saved, latest } = await refreshRates(db);
    console.log(`■ 환율 갱신: ${latest.date} 기준 ${latest.rate.toLocaleString("en-US")}원 (${saved}일치 저장)`);
  } catch (error) {
    console.error(`■ ⚠ 환율 갱신 실패: ${error.message} — 이미 저장된 환율로 계속합니다`);
  }

  const client = createClientIfConfigured();
  if (!client) {
    console.log(`■ 토스 키가 없어 수수료는 가정값(${PAPER_SETTINGS.commissionBps}bp)을 씁니다`);
  } else {
    try {
      const { commissions, calendar } = await refreshBrokerRules(db, client);
      const today = new Date().toISOString().slice(0, 10);
      const bps = commissionBpsOn(commissions, today);
      const usEnd = commissions.find((row) => row.marketCountry === "US")?.endDate;
      console.log(`■ 토스 수수료 갱신: 미국 ${bps === null ? `해당 요율 없음 → 가정값 ${PAPER_SETTINGS.commissionBps}bp` : `${bps}bp (한쪽)`}${usEnd && usEnd !== "9999-12-31" ? ` · 이 요율은 ${usEnd}까지` : ""}`);
      if (usEnd && usEnd !== "9999-12-31" && usEnd <= today) console.log("  ※ 요율 기간이 끝났습니다 — 토스 새 요율을 확인하세요");
      const open = nextRegularOpen(calendar);
      if (open) console.log(`■ 다음 미국 정규장 개장: ${open.label ?? open.iso} (한국 시간)`);
    } catch (error) {
      console.error(`■ ⚠ 토스 규칙 갱신 실패: ${error.message} — 저장된 값(없으면 가정값)으로 계속합니다`);
    }
  }

  const summary = runPaper(db);

  console.log(`\n■ 모의매매 ${PAPER_VERSION} (가상 원화 계좌) · 처리한 날짜 ${summary.processedDates.length ? summary.processedDates.join(", ") : "없음"}`);
  for (const o of summary.orders) console.log(`  주문 ${o.ticker.padEnd(6)} 신호 ${o.signalDate}  ${o.status}${o.reason ? ` (${o.reason})` : ""}`);
  for (const f of summary.fills) {
    console.log(`  ▶ 체결 ${f.ticker.padEnd(6)} ${f.date}  ${f.qty}주 @ $${f.price.toFixed(2)} · 환율 ${f.fx.toFixed(1)} · 매입 ${krw(f.costKrw)} · 손절 $${f.stop.toFixed(2)}`);
  }
  for (const k of summary.skips) console.log(`  ✖ 건너뜀 ${k.ticker.padEnd(6)} ${k.date}  ${k.reason}`);
  for (const e of summary.exits) {
    console.log(`  ◀ 청산 ${e.ticker.padEnd(6)} ${e.date}  ${e.reason}  ${signedKrw(e.pnlKrw)}  (원화 ${pct(e.returnKrw)} = 주가 ${pct(e.returnUsd)} · 환율 ${pct(e.fxEffect)})  ${signedR(e.rMultiple)}`);
  }

  const equity = db.prepare("SELECT * FROM paper_equity ORDER BY date DESC LIMIT 1").get();
  const open = db.prepare("SELECT * FROM paper_trades WHERE status = 'OPEN' ORDER BY entry_date").all();
  console.log(`\n■ 보유 ${open.length}종목 (최대 ${PAPER_SETTINGS.maxPositions})`);
  for (const t of open) {
    const unrealizedR = t.last_close ? (t.last_close - t.entry_price) / t.r : 0;
    const unrealizedKrw = t.last_close && equity ? t.qty * t.last_close * equity.fx - t.cost_krw : null;
    console.log(`   ${t.ticker.padEnd(6)} ${t.qty}주 @ $${t.entry_price.toFixed(2)}  손절 $${t.stop.toFixed(2)}  보유 ${t.bars_held}일  주가 ${signedR(unrealizedR)}${unrealizedKrw !== null ? `  평가손익 ${signedKrw(unrealizedKrw)}` : ""}${t.pending_exit ? `  ※ 내일 시가 청산 예정(${t.pending_exit})` : ""}`);
  }

  const state = db.prepare("SELECT * FROM paper_state WHERE id = 1").get();
  if (state) {
    const total = equity?.equity ?? state.cash;
    console.log(`\n■ 계좌: 현금 ${krw(state.cash)} · 평가액 ${krw(total)} (시작 ${krw(state.start_equity)}, ${pct(total / state.start_equity - 1)}) · 처리 완료일 ${state.last_date}${equity ? ` · 환율 ${equity.fx.toFixed(1)}` : ""}`);
  }

  const closed = db.prepare("SELECT * FROM paper_trades WHERE status = 'CLOSED'").all();
  if (closed.length) {
    const wins = closed.filter((t) => t.pnl_krw > 0).length;
    const sum = (key) => closed.reduce((a, t) => a + t[key], 0);
    console.log(`■ 청산 ${closed.length}건 · 원화 승률 ${((wins / closed.length) * 100).toFixed(0)}% · 원화 손익 합계 ${signedKrw(sum("pnl_krw"))}`);
    console.log(`  평균: 원화 ${pct(sum("return_krw") / closed.length)} = 주가 ${pct(sum("return_usd") / closed.length)} + 환율 ${pct(sum("fx_effect") / closed.length)} (환전비용 포함) · 주가 기준 ${signedR(sum("r_multiple") / closed.length)}`);
    console.log("  ※ 표본이 수십 건이 되기 전에는 승률·평균으로 전략을 판단하지 않습니다.");
  }
  const orderCounts = db.prepare("SELECT status, COUNT(*) AS n FROM paper_orders GROUP BY status").all();
  if (orderCounts.length) console.log(`■ 주문 현황: ${orderCounts.map((r) => `${r.status} ${r.n}`).join(" · ")}`);
  console.log("");
} catch (error) {
  console.error(`■ 모의매매 실패: ${error.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
