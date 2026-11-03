import test from "node:test";
import assert from "node:assert/strict";

import { sendTelegram, splitMessage, telegramConfig } from "../../src/notify/telegram.js";

const TOKEN = "123456:SECRET-TOKEN-VALUE";
const okFetch = (calls) => async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};

test("토큰과 채팅 ID 가 둘 다 있어야 설정으로 인정한다", () => {
  assert.deepEqual(telegramConfig({ TELEGRAM_BOT_TOKEN: " t ", TELEGRAM_CHAT_ID: "42" }), { token: "t", chatId: "42" });
  assert.equal(telegramConfig({ TELEGRAM_BOT_TOKEN: "t" }), null);
  assert.equal(telegramConfig({}), null);
});

test("짧은 글은 한 조각, 긴 글은 줄 단위로 나눈다", () => {
  assert.deepEqual(splitMessage("a\nb"), ["a\nb"]);
  const text = Array.from({ length: 10 }, (_, i) => `${"x".repeat(40)}${i}`).join("\n");
  const parts = splitMessage(text, 100);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 100));
  assert.equal(parts.join("\n"), text); // 줄이 중간에서 잘리지 않는다
});

test("한 줄이 제한보다 길면 그 줄만 자른다", () => {
  const parts = splitMessage("y".repeat(250), 100);
  assert.deepEqual(parts.map((p) => p.length), [100, 100, 50]);
});

test("전송: 주소에 토큰이 들어가고 본문에 채팅 ID 와 글이 들어간다", async () => {
  const calls = [];
  const result = await sendTelegram("안녕", { token: TOKEN, chatId: "42", fetchImpl: okFetch(calls) });
  assert.deepEqual(result, { ok: true, parts: 1 });
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(calls[0].body.chat_id, "42");
  assert.equal(calls[0].body.text, "안녕");
});

test("HTTP 오류는 상태 코드와 사유를 알려 주되 토큰은 문구에 넣지 않는다", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ description: "Unauthorized" }) });
  await assert.rejects(
    sendTelegram("x", { token: TOKEN, chatId: "1", fetchImpl }),
    (error) => /401/.test(error.message) && /Unauthorized/.test(error.message) && !error.message.includes("SECRET"),
  );
});

test("네트워크 오류 문구에 주소(토큰)가 새지 않는다", async () => {
  const fetchImpl = async () => {
    throw Object.assign(new TypeError(`fetch failed https://api.telegram.org/bot${TOKEN}/sendMessage`), { cause: { code: "ENOTFOUND" } });
  };
  await assert.rejects(
    sendTelegram("x", { token: TOKEN, chatId: "1", fetchImpl }),
    (error) => /ENOTFOUND/.test(error.message) && !error.message.includes("SECRET"),
  );
});

test("설정이 없으면 보내지 않고 오류", async () => {
  await assert.rejects(sendTelegram("x", {}), /TELEGRAM_BOT_TOKEN/);
});
