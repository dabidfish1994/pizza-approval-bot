# Pizza Approval Bot

A local human-in-the-loop pizza ordering worker:

1. Reads delivery address from 1Password.
2. Builds a pizza checkout in a Playwright browser session.
3. Sends the exact order summary + total to your Telegram bot.
4. Waits for **Approve** or **Cancel**.
5. Only after **Approve**, reads the payment card from 1Password.
6. Re-checks the maximum total / approval freshness and completes checkout.

## Security properties

- Card number/CVV are never sent to Telegram.
- Card secrets are not read until approval.
- Secrets are referenced with `op://...` references; `.env` contains references, not values.
- A hard maximum order total prevents unexpected charges.
- Approval expires after a configurable TTL.
- `DRY_RUN=true` by default.
- Never log payment objects or browser form values.

## Setup

Prerequisites: Node.js, 1Password CLI (`op`) signed in, and a Telegram bot token/chat ID.

```bash
cp .env.example .env
# edit secret references and Telegram values
npm install
npx playwright install chromium
npm run dev
```

## 1Password items

Create/use an Address item and Credit Card item. Set the `OP_*_REF` values in `.env` to the actual field secret references. You can inspect an item's fields with `op item get <item> --format json` and read individual fields with `op read op://vault/item/field`.

## Telegram

Create a bot with BotFather, put the bot token in `.env`, message the bot once, then use `getUpdates` to determine your numeric private-chat ID. The app rejects callbacks from any other chat ID.

## Pizza-site adapter

`src/order.ts` deliberately isolates the site-specific automation. The current version opens `PIZZA_SITE_URL` and sends a dry-run approval with estimated pricing. Before live use, implement these selectors/actions in `prepareOrder()`:

- choose Delivery
- fill address
- choose the desired store
- add the configured pizza
- proceed to checkout
- scrape the site's exact subtotal, fees/taxes, and total

Then implement `submitApprovedOrder()`:

- verify the checkout total still exactly matches the Telegram-approved total
- fill cardholder/card/expiration/CVV
- click the final Place Order button
- scrape the confirmation/order number

Keep `DRY_RUN=true` until you have tested the entire flow except the final click.

## Recommended next hardening

- Persist pending approvals in SQLite instead of memory.
- Hash/sign approval payloads and bind each approval to order ID + exact total.
- Add a one-order-at-a-time lock.
- Add a second max check against the live page immediately before final submit.
- Run locally on a Mac mini/home server rather than a public server if using the 1Password desktop/CLI session.
