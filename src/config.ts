import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export const config = {
  telegramToken: required('TELEGRAM_BOT_TOKEN'),
  telegramChatId: required('TELEGRAM_CHAT_ID'),
  pizzaSiteUrl: process.env.PIZZA_SITE_URL ?? 'https://www.dominos.com/',
  orderName: process.env.DEFAULT_ORDER_NAME ?? 'Large cheese pizza',
  tipPercent: Number(process.env.DEFAULT_TIP_PERCENT ?? '20'),
  maxApprovedTotal: Number(process.env.MAX_APPROVED_TOTAL_USD ?? '75'),
  approvalTtlSeconds: Number(process.env.APPROVAL_TTL_SECONDS ?? '600'),
  headless: (process.env.HEADLESS ?? 'false') === 'true',
  dryRun: (process.env.DRY_RUN ?? 'true') === 'true',
  refs: {
    address1: required('OP_ADDRESS1_REF'), city: required('OP_CITY_REF'),
    state: required('OP_STATE_REF'), zip: required('OP_ZIP_REF'), phone: required('OP_PHONE_REF'),
    cardNumber: required('OP_CARD_NUMBER_REF'), expMonth: required('OP_CARD_EXP_MONTH_REF'),
    expYear: required('OP_CARD_EXP_YEAR_REF'), cvv: required('OP_CARD_CVV_REF'), cardName: required('OP_CARD_NAME_REF')
  }
};
