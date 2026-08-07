import { chromium, type Browser, type Page } from 'playwright';
import { config } from './config.js';
import { getDeliveryAddress, getPaymentCard } from './onepassword.js';

export type PreparedOrder = {
  id: string;
  restaurant: string;
  items: string[];
  subtotal: number;
  taxesFees: number;
  tip: number;
  total: number;
  addressSummary: string;
  browser: Browser;
  page: Page;
  createdAt: number;
};

/**
 * This adapter intentionally stops before payment. Pizza sites change frequently,
 * so keep site-specific selectors isolated here. The included flow opens the configured
 * site and leaves a browser ready for selector customization.
 */
export async function prepareOrder(): Promise<PreparedOrder> {
  const address = await getDeliveryAddress();
  const browser = await chromium.launch({ headless: config.headless });
  const page = await browser.newPage();
  await page.goto(config.pizzaSiteUrl, { waitUntil: 'domcontentloaded' });

  // TODO: site adapter: choose delivery, enter address, select DEFAULT_ORDER_NAME,
  // proceed to checkout, and scrape exact subtotal/taxes/fees.
  // Until customized, use a safe estimate and DRY_RUN=true.
  const subtotal = 20;
  const taxesFees = 5;
  const tip = Math.round(subtotal * config.tipPercent) / 100;
  const total = Math.round((subtotal + taxesFees + tip) * 100) / 100;

  return {
    id: crypto.randomUUID(), restaurant: new URL(config.pizzaSiteUrl).hostname,
    items: [config.orderName], subtotal, taxesFees, tip, total,
    addressSummary: `${address.address1}, ${address.city}, ${address.state} ${address.zip}`,
    browser, page, createdAt: Date.now()
  };
}

export async function submitApprovedOrder(order: PreparedOrder) {
  if (order.total > config.maxApprovedTotal) throw new Error(`Order total $${order.total.toFixed(2)} exceeds MAX_APPROVED_TOTAL_USD`);
  if ((Date.now() - order.createdAt) / 1000 > config.approvalTtlSeconds) throw new Error('Approval expired; rebuild order before charging.');
  if (config.dryRun) return { confirmation: 'DRY-RUN-NO-CHARGE' };

  const card = await getPaymentCard(); // only now does card data enter process memory

  // TODO: site adapter: fill payment fields using `card`, verify displayed total still
  // equals order.total, then click the final Place Order button.
  // Never log `card`.
  void card;
  throw new Error('Live checkout adapter not configured. Keep DRY_RUN=true until selectors are implemented and tested.');
}
