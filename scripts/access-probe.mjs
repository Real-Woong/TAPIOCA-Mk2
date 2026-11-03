#!/usr/bin/env node

// NASDAQ 스크리너(TAPIOCA Ver2)의 1단계 «접근 시험»입니다. 읽기 전용이고 아무것도 저장소 밖으로 보내지 않습니다.
// 같은 스크립트를 Mac mini와 Oracle에서 각각 돌려 결과를 비교합니다 — 어느 기기가 어느 소스를 받을 수 있는지가 답입니다.
//
//   npm run probe
//   npm run probe --tickers AAPL,SOFI --delay 1500 --out probe.json
//
// 선택 환경변수: TWELVE_DATA_API_KEY (없으면 Twelve Data는 건너뜁니다)
//               SEC_USER_AGENT     (SEC는 «이름 이메일» 형태의 User-Agent를 요구합니다. 예: "TAPIoca me@example.com")

import { writeFileSync } from "node:fs";
import os from "node:os";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const TICKERS = (args.tickers ?? "AAPL,MSFT,NVDA,AMZN,GOOGL,TSLA,META,AVGO,COST,NFLX,AMD,INTC,PLTR,SOFI,RIOT,MARA,LCID,CHPT,UPST,AFRM").split(",");
const DELISTED = (args.delisted ?? "SIVB,BBBY").split(","); // 상장폐지된 NASDAQ 종목 — 과거 일봉이 아직 나오는지 본다
const DELAY_MS = Number(args.delay ?? 1000);
const TIMEOUT_MS = 15_000;
const MIN_BARS = 80; // 60일 평균 + 20일 창을 채우는 최소선
const STOP_AFTER_BLOCKS = 3; // 연속 차단이 이만큼이면 그 소스는 거기서 멈춘다 (IP를 더 괴롭히지 않는다)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(url, headers = {}) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; tapioca-probe)", ...headers },
      signal: ctl.signal,
    });
    const body = await res.text();
    return { status: res.status, body, ms: Date.now() - started };
  } catch (e) {
    return { status: 0, body: "", ms: Date.now() - started, error: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// ── 소스별 파서: 모두 [{date, o, h, l, c, v}] 와 «막혔는가» 판정을 돌려준다 ──

function blocked(r) {
  if (r.status === 429 || r.status === 403) return `HTTP ${r.status}`;
  if (r.body.trimStart().startsWith("<")) return "HTML 응답(봇 차단 벽 의심)";
  return null;
}

const SOURCES = {
  yahoo: {
    label: "Yahoo Finance (키 없음)",
    url: (t) => `https://query1.finance.yahoo.com/v8/finance/chart/${t}?range=6mo&interval=1d`,
    parse(body) {
      const j = JSON.parse(body);
      const r = j.chart?.result?.[0];
      if (!r) return { bars: [], note: j.chart?.error?.description ?? "result 없음" };
      const q = r.indicators.quote[0];
      const bars = (r.timestamp ?? []).map((ts, i) => ({
        date: new Date(ts * 1000).toISOString().slice(0, 10),
        o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i],
      }));
      return { bars, adjusted: Boolean(r.indicators.adjclose) };
    },
  },
  stooq: {
    label: "Stooq (키 없음)",
    url: (t) => `https://stooq.com/q/d/l/?s=${t.toLowerCase()}.us&i=d`,
    parse(body) {
      const lines = body.trim().split("\n");
      if (!/^date,open,high,low,close,volume/i.test(lines[0] ?? "")) return { bars: [], note: lines[0]?.slice(0, 60) };
      const bars = lines.slice(1).map((ln) => {
        const [date, o, h, l, c, v] = ln.split(",");
        return { date, o: +o, h: +h, l: +l, c: +c, v: +v };
      });
      return { bars: bars.slice(-130), adjusted: false };
    },
  },
  twelvedata: {
    label: "Twelve Data (키 필요)",
    needsKey: "TWELVE_DATA_API_KEY",
    url: (t) => `https://api.twelvedata.com/time_series?symbol=${t}&interval=1day&outputsize=130&apikey=${process.env.TWELVE_DATA_API_KEY}`,
    parse(body) {
      const j = JSON.parse(body);
      if (j.status === "error") return { bars: [], note: `${j.code} ${j.message}`.slice(0, 80), limited: j.code === 429 };
      const bars = (j.values ?? []).reverse().map((x) => ({ date: x.datetime, o: +x.open, h: +x.high, l: +x.low, c: +x.close, v: +x.volume }));
      return { bars, adjusted: false };
    },
  },
};

// ── 한 소스를 전 종목에 순서대로 돌린다 ──

async function probeSource(key, tickers, tag) {
  const src = SOURCES[key];
  if (src.needsKey && !process.env[src.needsKey]) {
    console.log(`  [${key}] 건너뜀 — ${src.needsKey} 없음`);
    return { skipped: true };
  }
  const rows = [];
  let consecutiveBlocks = 0;
  for (const t of tickers) {
    const r = await http(src.url(t));
    let row = { ticker: t, status: r.status, ms: r.ms };
    const why = r.error ?? blocked(r);
    if (why) {
      row.fail = why;
      consecutiveBlocks += 1;
    } else {
      try {
        const p = src.parse(r.body);
        row.bars = p.bars.length;
        row.last = p.bars.at(-1)?.date ?? null;
        row.adjusted = p.adjusted ?? null;
        row.nullBars = p.bars.filter((b) => [b.o, b.h, b.l, b.c, b.v].some((x) => x == null || Number.isNaN(x))).length;
        if (p.note) row.fail = p.note;
        consecutiveBlocks = p.limited ? consecutiveBlocks + 1 : 0;
        if (!p.bars.length && !p.note) row.fail = "빈 응답";
      } catch (e) {
        row.fail = `파싱 실패: ${e.message}`.slice(0, 80);
        consecutiveBlocks += 1;
      }
    }
    rows.push(row);
    process.stdout.write(row.fail ? "x" : ".");
    if (consecutiveBlocks >= STOP_AFTER_BLOCKS) {
      console.log(`\n  [${key}] 연속 ${STOP_AFTER_BLOCKS}회 차단 — ${tag} 중단 (${t}까지)`);
      break;
    }
    await sleep(DELAY_MS);
  }
  process.stdout.write("\n");
  return { rows };
}

function summarize(key, res) {
  if (res.skipped) return { key, verdict: "건너뜀" };
  const ok = res.rows.filter((r) => !r.fail);
  const enough = ok.filter((r) => r.bars >= MIN_BARS);
  const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
  const avgMs = lat.length ? Math.round(lat.reduce((s, x) => s + x, 0) / lat.length) : null;
  const codes = {};
  for (const r of res.rows) codes[r.status] = (codes[r.status] ?? 0) + 1;
  const firstFail = res.rows.findIndex((r) => r.fail);
  return {
    key,
    tried: res.rows.length,
    ok: ok.length,
    enoughBars: enough.length,
    codes,
    avgMs,
    lastDate: ok.map((r) => r.last).sort().at(-1) ?? null,
    nullBars: ok.reduce((s, r) => s + (r.nullBars ?? 0), 0),
    firstFailAt: firstFail === -1 ? null : firstFail + 1,
    // 3,500종목을 한 줄씩 받는 데 걸릴 시간(분) — 지연 포함
    est3500min: avgMs == null ? null : Math.round(((avgMs + DELAY_MS) * 3500) / 60000),
    verdict: !ok.length ? "막힘" : enough.length === res.rows.length ? "사용 가능" : "일부만",
  };
}

// ── 유니버스 파일과 공시 ──

async function probeUniverse() {
  const r = await http("https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt");
  const why = r.error ?? blocked(r);
  if (why) return { fail: why, status: r.status };
  const lines = r.body.trim().split("\n");
  const rows = lines.slice(1).filter((l) => !l.startsWith("File Creation Time")).map((l) => l.split("|"));
  const header = lines[0].split("|");
  const iTest = header.indexOf("Test Issue");
  const iEtf = header.indexOf("ETF");
  const common = rows.filter((x) => x[iTest] === "N" && x[iEtf] === "N");
  return { status: r.status, total: rows.length, afterEtfAndTestFilter: common.length, footer: lines.at(-1).slice(0, 60) };
}

async function probeEdgar() {
  const ua = process.env.SEC_USER_AGENT;
  if (!ua) return { skipped: "SEC_USER_AGENT 없음" };
  const r = await http("https://data.sec.gov/submissions/CIK0000320193.json", { "user-agent": ua });
  const why = r.error ?? blocked(r);
  if (why) return { fail: why, status: r.status };
  const j = JSON.parse(r.body);
  return { status: r.status, ms: r.ms, recentFilings: j.filings?.recent?.form?.length ?? 0 };
}

// ── 실행 ──

console.log(`\n■ 접근 시험 — ${os.hostname()} (${os.platform()} ${os.arch()}) · Node ${process.version}`);
const ip = await http("https://api.ipify.org");
console.log(`■ 바깥 IP: ${ip.status === 200 ? ip.body.trim() : `확인 실패(${ip.error ?? ip.status})`}`);
console.log(`■ 종목 ${TICKERS.length}개 · 간격 ${DELAY_MS}ms · 최소 봉 ${MIN_BARS}\n`);

const report = { host: os.hostname(), at: new Date().toISOString(), ip: ip.body.trim(), minBars: MIN_BARS, delayMs: DELAY_MS };

console.log("[1] 유니버스 (Nasdaq Trader 심볼 파일)");
report.universe = await probeUniverse();
console.log("   ", JSON.stringify(report.universe));

console.log("\n[2] 공시 (SEC EDGAR)");
report.edgar = await probeEdgar();
console.log("   ", JSON.stringify(report.edgar));

report.prices = {};
report.delisted = {};
let n = 3;
for (const key of Object.keys(SOURCES)) {
  console.log(`\n[${n++}] 일봉 — ${SOURCES[key].label}`);
  const res = await probeSource(key, TICKERS, "일반 종목");
  report.prices[key] = { ...summarize(key, res), rows: res.rows };
  if (res.skipped || !res.rows?.some((r) => !r.fail)) continue; // 막힌 소스는 상장폐지 시험도 건너뛴다
  process.stdout.write("    상장폐지 종목: ");
  const d = await probeSource(key, DELISTED, "상장폐지");
  report.delisted[key] = d.rows.map((r) => ({ ticker: r.ticker, bars: r.bars ?? 0, fail: r.fail ?? null }));
}

console.log("\n══ 요약 ══");
for (const s of Object.values(report.prices)) {
  if (s.verdict === "건너뜀") { console.log(`${s.key.padEnd(11)} 건너뜀`); continue; }
  console.log(
    `${s.key.padEnd(11)} ${s.verdict.padEnd(8)} 성공 ${s.ok}/${s.tried} · ${MIN_BARS}봉 이상 ${s.enoughBars} · ` +
      `평균 ${s.avgMs ?? "-"}ms · 최신 ${s.lastDate ?? "-"} · 결측봉 ${s.nullBars} · 첫 실패 ${s.firstFailAt ?? "없음"} · ` +
      `3,500종목 약 ${s.est3500min ?? "-"}분`,
  );
}
for (const [k, rows] of Object.entries(report.delisted)) {
  console.log(`상장폐지 ${k}: ${rows.map((r) => `${r.ticker} ${r.bars}봉`).join(" · ")}`);
}

const out = args.out ?? `probe-${os.hostname()}-${report.at.slice(0, 10)}.json`;
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\n결과 저장: ${out}  (Mac과 Oracle 결과 파일 둘을 나란히 보여 주세요)`);

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, "")] = argv[i + 1];
  return o;
}
