import { config } from './config.js';

const api = (method: string) => `https://api.telegram.org/bot${config.telegramToken}/${method}`;

async function post(method: string, body: unknown) {
  const r = await fetch(api(method), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Telegram ${method} failed: ${r.status} ${await r.text()}`);
  return r.json() as Promise<any>;
}

export async function sendApproval(orderId: string, summary: string) {
  return post('sendMessage', {
    chat_id: config.telegramChatId,
    text: summary,
    reply_markup: { inline_keyboard: [[
      { text: '✅ Approve', callback_data: `approve:${orderId}` },
      { text: '❌ Cancel', callback_data: `cancel:${orderId}` }
    ]] }
  });
}

export async function sendStatus(text: string) {
  return post('sendMessage', { chat_id: config.telegramChatId, text });
}

export async function answerCallbackQuery(id: string, text: string) {
  return post('answerCallbackQuery', { callback_query_id: id, text });
}

export async function getUpdates(offset?: number) {
  const r = await post('getUpdates', { timeout: 25, offset });
  return r.result as any[];
}
