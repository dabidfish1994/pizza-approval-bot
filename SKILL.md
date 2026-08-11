---
name: pizza
description: Order Domino's pizza for the user, with a quote-then-confirm flow. Use when the user asks to order pizza, get a pizza price, check what a pizza would cost, or track a pizza order that was already placed.
---

# Pizza ordering

Orders Domino's to the user's saved address using their saved card. Runs as a CLI
in two steps: `propose` gets a real quote and charges nothing, `confirm` places
the order and charges the card.

**Always show the user the quote and get an explicit yes before running `confirm`.**

## Commands

Run from the install directory. Add `--json` to any command for structured output.

```bash
npm run pizza -- propose "large pepperoni pizza"     # quote, no charge
npm run pizza -- confirm ABCD2345                    # places the order, CHARGES the card
npm run pizza -- status                              # pending quote, daily budget, delivery tracking
npm run pizza -- menu "wings"                        # search the live store menu
npm run pizza -- history                             # recent orders
npm run pizza -- cancel                              # discard the pending quote
```

## The flow

1. Run `propose` with what the user asked for. Multiple items are separate
   arguments; quantities use a `2x` prefix:
   ```bash
   npm run pizza -- propose "large pepperoni pizza" "2x garlic bread" --json
   ```
2. Show the user the itemised quote **and the total**. If `alternatives` is
   non-empty and the match looks wrong, offer them.
3. Wait for the user to actually agree. Do not infer agreement.
4. Run `confirm <token>` with the token from the propose output.
5. Report the confirmation number. Use `status` for delivery tracking.

## Rules

- Never run `confirm` without the user agreeing to that specific quote in that
  conversation. A quote expires after 10 minutes; if it lapses, run `propose`
  again and show the new quote rather than reusing the old total.
- Never invent a confirm token. Only a `propose` can mint one.
- If a command fails, report the error verbatim. The `code` field in `--json`
  says what went wrong. Do not try to work around a refusal — the limits below
  are deliberate, and hitting one means the user should be told, not routed around.
- If the user asks for something not on the menu, say so instead of substituting.

## Error codes

| code | meaning | what to tell the user |
|---|---|---|
| `daily_limit` | already ordered today | when the next order is allowed |
| `cooldown` | ordered very recently | how many minutes to wait |
| `over_max_total` | quote exceeds the cap | the total and the cap; suggest a smaller order |
| `expired` | quote is stale | re-quote, show the new total |
| `price_changed` | store price moved since the quote | the old and new totals; re-quote |
| `order_changed` | items or store changed | re-quote |
| `no_match` | nothing on the menu matches | offer `menu` search results |
| `crashed_placement` | a previous order may or may not have gone through | **stop** — the user must check with Domino's before anything else |
| `locked` | another placement is running | wait and retry |

## What this cannot do

These are enforced in code, not by prompting, and cannot be overridden from
conversation: one order per day, a hard maximum total, a 30-minute cooldown, a
cap on item count, delivery only to the address in the user's 1Password, and
payment only with the card in their 1Password. If the user wants these changed,
they edit `.env` themselves.
