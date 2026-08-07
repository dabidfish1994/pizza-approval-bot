import { config } from './config.js';
import { prepareOrder, submitApprovedOrder, type PreparedOrder } from './order.js';
import { answerCallbackQuery, getUpdates, sendApproval, sendStatus } from './telegram.js';

const pending = new Map<string, PreparedOrder>();

function summary(o: PreparedOrder) {
  return [
    '🍕 Pizza order ready for approval',
    `Restaurant: ${o.restaurant}`,
    `Items: ${o.items.join(', ')}`,
    `Delivery: ${o.addressSummary}`,
    `Subtotal: $${o.subtotal.toFixed(2)}`,
    `Taxes/fees: $${o.taxesFees.toFixed(2)}`,
    `Tip: $${o.tip.toFixed(2)}`,
    `TOTAL: $${o.total.toFixed(2)}`,
    '',
    `Approval expires in ${Math.round(config.approvalTtlSeconds / 60)} minutes.`
  ].join('\n');
}

async function main() {
  const order = await prepareOrder();
  pending.set(order.id, order);
  await sendApproval(order.id, summary(order));
  console.log(`Approval requested for order ${order.id}. No card data was read.`);

  let offset: number | undefined;
  while (true) {
    const updates = await getUpdates(offset);
    for (const u of updates) {
      offset = u.update_id + 1;
      const cb = u.callback_query;
      if (!cb?.data || String(cb.message?.chat?.id) !== String(config.telegramChatId)) continue;
      const [action, orderId] = cb.data.split(':');
      const p = pending.get(orderId);
      if (!p) { await answerCallbackQuery(cb.id, 'Order is no longer pending.'); continue; }
      if (action === 'cancel') {
        pending.delete(orderId); await p.browser.close();
        await answerCallbackQuery(cb.id, 'Canceled'); await sendStatus('❌ Pizza order canceled.'); return;
      }
      if (action === 'approve') {
        await answerCallbackQuery(cb.id, 'Approved — completing checkout');
        try {
          const result = await submitApprovedOrder(p);
          pending.delete(orderId); await p.browser.close();
          await sendStatus(`✅ Order completed. Confirmation: ${result.confirmation}`); return;
        } catch (e: any) {
          await sendStatus(`⚠️ Order not charged: ${e.message}`); await p.browser.close(); return;
        }
      }
    }
  }
}

main().catch(async e => { console.error(e); try { await sendStatus(`⚠️ Pizza bot error: ${e.message}`); } catch {} process.exit(1); });
