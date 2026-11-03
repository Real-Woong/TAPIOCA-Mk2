import { httpGet, classifyResponse } from "./sources.js";

// NASDAQ 상장 목록(Nasdaq Trader 심볼 디렉터리)에서 수집 대상을 정합니다.
// 열: Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares
export const NASDAQ_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt";

// «가능하면 보통주 중심, ADR·ETF 제외»(Ver2 §2)를 이름으로 근사합니다. 이름 규칙은 근사일 뿐이라
// 제외한 것은 이유와 함께 전부 남깁니다 — 잘못 뺀 종목을 나중에 찾을 수 있어야 합니다.
const NOT_COMMON_PATTERNS = [
  ["WARRANT", /\bwarrants?\b/i],
  ["RIGHTS", /\brights?\b/i],
  ["UNITS", /\bunits?\b/i],
  ["PREFERRED", /\bpreferred\b/i],
  ["DEPOSITARY(ADR)", /\bdepositary\b/i],
  ["NOTES", /\bnotes?\b/i],
  // 블랭크체크(SPAC)는 합병 전까지 $10 근처에서 거래량만 튀므로 «횡보 + 급증» 조건에 항상 걸립니다.
  ["SPAC", /\bacquisition\b/i],
];

export function parseNasdaqListed(text) {
  const lines = text.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  const header = lines[0]?.split("|") ?? [];
  const col = (name) => header.indexOf(name);
  const required = ["Symbol", "Security Name", "Test Issue", "Financial Status", "ETF"];
  const missing = required.filter((name) => col(name) === -1);
  if (missing.length) throw new Error(`심볼 파일 형식이 바뀌었습니다: ${missing.join(", ")} 열이 없습니다`);

  const footer = lines.find((line) => line.startsWith("File Creation Time")) ?? null;
  const rows = lines
    .slice(1)
    .filter((line) => !line.startsWith("File Creation Time"))
    .map((line) => {
      const cells = line.split("|");
      return {
        symbol: cells[col("Symbol")],
        name: cells[col("Security Name")],
        test: cells[col("Test Issue")],
        financialStatus: cells[col("Financial Status")],
        etf: cells[col("ETF")],
      };
    });
  return { rows, footer };
}

/** 제외 이유는 첫 번째로 걸린 하나만 남깁니다. */
export function filterUniverse(rows) {
  const included = [];
  const excluded = [];
  for (const row of rows) {
    const reason = excludeReason(row);
    if (reason) excluded.push({ symbol: row.symbol, name: row.name, reason });
    else included.push({ symbol: row.symbol, name: row.name });
  }
  included.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { included, excluded };
}

function excludeReason(row) {
  if (row.test === "Y") return "TEST_ISSUE";
  if (row.etf === "Y") return "ETF";
  // N이 정상입니다. D(결함)·E(지연 제출)·Q(파산) 등은 Ver2 §10의 «제외 또는 별도 표시» 대상입니다.
  if (row.financialStatus && row.financialStatus !== "N") return `FINANCIAL_STATUS_${row.financialStatus}`;
  for (const [reason, pattern] of NOT_COMMON_PATTERNS) {
    if (pattern.test(row.name)) return `NOT_COMMON_${reason}`;
  }
  return null;
}

export async function fetchUniverse({ fetchImpl } = {}) {
  const response = await httpGet(NASDAQ_LISTED_URL, { fetchImpl });
  classifyResponse(response);
  const { rows, footer } = parseNasdaqListed(response.body);
  return { ...filterUniverse(rows), listedCount: rows.length, sourceFooter: footer };
}
