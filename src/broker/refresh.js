// 토스에서 수수료표·미국 장 일정을 «읽어서» DB(broker_rules)에 저장합니다. 주문 API 는 호출하지 않습니다.
//
// ── 이 파일의 구성 ──────────────────────────────────────────────────────────
//  refreshBrokerRules()   읽기 전용 조회 2번(수수료, 장 일정) → 저장. 실패하면 던진다(호출한 쪽이 경고만 하고 계속한다)
//  loadBrokerRule()       저장된 규칙 한 줄을 읽는다 (없으면 null)
//  createClientIfConfigured()   .env 에 토스 키가 있을 때만 클라이언트를 만든다 (없으면 null)

import { createTossClientFromEnv } from "../toss/toss-client.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createClientIfConfigured(env = process.env) {
  return env.TOSS_CLIENT_ID && env.TOSS_CLIENT_SECRET ? createTossClientFromEnv(env) : null;
}

export async function refreshBrokerRules(db, client, { now = new Date(), pauseMs = 700 } = {}) {
  const accounts = await client.getAccounts();
  const accountSeq = accounts[0]?.accountSeq;
  if (accountSeq === undefined) throw new Error("토스 계좌를 읽지 못했습니다");
  await sleep(pauseMs); // 호출 한도(429) 방지
  const commissions = await client.getCommissions(accountSeq);
  await sleep(pauseMs);
  const calendar = await client.getUsMarketCalendar();

  const put = db.prepare(`INSERT INTO broker_rules (kind, payload, fetched_at) VALUES (?,?,?)
    ON CONFLICT(kind) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`);
  put.run("commissions", JSON.stringify(commissions), now.toISOString());
  put.run("market_calendar_us", JSON.stringify(calendar), now.toISOString());
  return { commissions, calendar };
}

/** @returns {{payload:any, fetchedAt:string}|null} */
export function loadBrokerRule(db, kind) {
  const row = db.prepare("SELECT payload, fetched_at FROM broker_rules WHERE kind = ?").get(kind);
  return row ? { payload: JSON.parse(row.payload), fetchedAt: row.fetched_at } : null;
}
