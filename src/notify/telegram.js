// 텔레그램 전송. 이 프로젝트 전용 봇(TELEGRAM_BOT_TOKEN)으로 보냅니다. ETF 시스템의 봇과 코드·토큰이 따로입니다.
//
// ── 이 파일의 구성 ──────────────────────────────────────────────────────────
//  loadEnv()         .env 를 읽어 환경변수에 넣는다 (파일이 없으면 조용히 넘어감)
//  telegramConfig()  토큰과 채팅 ID 를 꺼낸다. 없으면 null
//  splitMessage()    4096자 제한에 맞게 줄 단위로 나눈다
//  sendTelegram()    메시지를 보낸다. 실패해도 오류 문구에 토큰이 새지 않게 한다

import process from "node:process";

export const TELEGRAM_LIMIT = 4000; // 공식 제한은 4096자. 여유를 둔다

export function loadEnv(file = ".env") {
  try {
    process.loadEnvFile(file);
  } catch {
    // .env 가 없으면 이미 설정된 환경변수만 쓴다
  }
}

export function telegramConfig(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  return token && chatId ? { token, chatId } : null;
}

/** 줄 단위로 limit 자 이하 조각으로 나눈다. 한 줄이 limit 보다 길면 그 줄만 잘라서 넣는다. */
export function splitMessage(text, limit = TELEGRAM_LIMIT) {
  const chunks = [];
  let current = "";
  for (const rawLine of text.split("\n")) {
    const lines = rawLine.length > limit ? rawLine.match(new RegExp(`.{1,${limit}}`, "gs")) : [rawLine];
    for (const line of lines) {
      if (current && current.length + line.length + 1 > limit) {
        chunks.push(current);
        current = line;
      } else {
        current = current ? `${current}\n${line}` : line;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * @returns {Promise<{ok:true, parts:number}>}  실패하면 던진다 (메시지에 토큰은 없다)
 */
export async function sendTelegram(text, { token, chatId, fetchImpl = fetch } = {}) {
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 가 없습니다");
  const parts = splitMessage(text);
  for (const part of parts) {
    let response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: part, disable_web_page_preview: true }),
      });
    } catch (error) {
      // 네트워크 오류 메시지에 URL(=토큰)이 들어 있을 수 있어 원인 코드만 남긴다
      throw new Error(`텔레그램 연결 실패(${error.cause?.code ?? error.code ?? error.name})`);
    }
    if (!response.ok) {
      let description = "";
      try {
        description = (await response.json()).description ?? "";
      } catch {
        // 본문이 JSON 이 아니어도 상태 코드는 알려 준다
      }
      throw new Error(`텔레그램 전송 실패 HTTP ${response.status}${description ? ` — ${description}` : ""}`);
    }
  }
  return { ok: true, parts: parts.length };
}
