/**
 * Pins config for tests. Imported for its side effect BEFORE any module that
 * reads config, so the modules under test must be pulled in with dynamic
 * import (static imports hoist above this).
 *
 * dotenv does not override variables already present in process.env, so these
 * win even on a machine with a real .env.
 */
Object.assign(process.env, {
  CUSTOMER_EMAIL: 'test@example.com',
  CUSTOMER_FIRST_NAME: 'Test',
  CUSTOMER_LAST_NAME: 'User',
  OP_ADDRESS1_REF: 'op://t/a/address1',
  OP_CITY_REF: 'op://t/a/city',
  OP_STATE_REF: 'op://t/a/state',
  OP_ZIP_REF: 'op://t/a/zip',
  OP_PHONE_REF: 'op://t/a/phone',
  OP_CARD_NUMBER_REF: 'op://t/c/number',
  OP_CARD_EXP_MONTH_REF: 'op://t/c/exp_month',
  OP_CARD_EXP_YEAR_REF: 'op://t/c/exp_year',
  OP_CARD_CVV_REF: 'op://t/c/cvv',
  OP_CARD_NAME_REF: 'op://t/c/cardholder',
  SERVICE_METHOD: 'Delivery',
  DEFAULT_TIP_PERCENT: '0',
  MAX_ORDER_TOTAL_USD: '75',
  MAX_ORDERS_PER_DAY: '1',
  ORDER_COOLDOWN_MINUTES: '30',
  APPROVAL_TTL_SECONDS: '600',
  MAX_ITEMS_PER_ORDER: '6',
  DRY_RUN: 'true',
  PIZZA_STATE_DIR: '/tmp/pizza-bot-test'
});
