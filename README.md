# Pizza Approval Bot

Orders Domino's from the command line, driven by an AI agent, without letting the
agent do anything expensive. Built to run as an [OpenClaw](https://github.com/openclaw/openclaw)
skill so you can order pizza over Telegram.

```
$ npm run pizza -- propose "large pepperoni pizza"

🍕 Quote — nothing has been charged.
Store:    8278 (154 Country Club Gate, Pacific Grove, CA 93950)
Deliver:  1 Main St, Anytown, CA 90210

  1x Large (14") Hand Tossed Pizza with Pepperoni  $21.49

Food:     $21.49
Delivery: $5.99
Tax:      $2.40
Tip:      $0.00 (tipping disabled)
TOTAL:    $29.88

⚠ DRY_RUN is on — confirm will simulate, not charge.
Expires in 10 min.

To place it:  pizza confirm KRUE47MN
```

## The security model

The agent is **inside** the trust boundary, not outside it. OpenClaw's confirmation
is a chat message, and a model can be confused or prompt-injected into deciding
that a message meant yes. So the confirmation prompt is not treated as a security
control. Everything that bounds the damage lives in `src/policy.ts`, in code no
prompt can argue with:

| Gate | Default | Why |
|---|---|---|
| Max order total | $75 | Caps a single mistake |
| Orders per day | 1 | Caps a repeated mistake |
| Cooldown | 30 min | Stops rapid retries |
| Quote TTL | 10 min | A stale quote cannot be redeemed |
| Max items | 6 | Blocks a 40-pizza order |
| Store allowlist | off | Pin it once you know your store |
| Confirm token | required | Only `propose` mints one; single use |
| Re-price before charge | always | Catches a price change between quote and charge |
| Single-flight lock | always | Two agents cannot place at once |
| Crash detection | always | An interrupted placement halts everything until a human checks |

**Worst case for a fully compromised agent: one pizza, under $75, once per day, to
the address in your 1Password.** It cannot order to a different address, use a
different card, or escalate past the caps.

Card data is read from 1Password *only after* every gate has passed, is registered
with a redactor the moment it is read, and is cleared immediately after. It never
reaches a log, an error message, or the audit trail.

## Setup

Requires Node 20+, the 1Password CLI signed in, and a Domino's that delivers to you.

```bash
npm install
cp .env.example .env    # then edit it
npm test                # 64 tests, no network needed
```

Fill in `.env`:

- `CUSTOMER_EMAIL` — Domino's requires one on the order
- `OP_*_REF` — 1Password secret references, not values. Check each one:
  ```bash
  op read "op://Personal/Home Address/address1"
  ```
- Leave `DRY_RUN=true` until you have done a full dry run.

Verify the Domino's side works before wiring up secrets:

```bash
npx tsx scripts/verify-adapter.ts "1 Main St, Anytown, CA, 90210" "large pepperoni pizza"
```

That calls the real API, prices a real order, and charges nothing.

Then pin your store:

```bash
npm run pizza -- stores          # prints your store ID
# add ALLOWED_STORE_IDS=<id> to .env
```

## Going live

1. `npm run pizza -- propose "large pepperoni pizza"` — check the quote.
2. `npm run pizza -- confirm <token>` — with `DRY_RUN=true` this runs every check,
   including the re-price, and stops before charging.
3. Set `DRY_RUN=false` and place one real order.
4. **Check the exact charge on your statement**, then see the tip note below.

### The tip caveat

`DEFAULT_TIP_PERCENT` starts at `0` on purpose. The Domino's API takes `Amount`
and `TipAmount` as separate fields and does not document whether `Amount` is
tip-inclusive. This code sends `Amount = food + fees + tax + tip`, which is right
under either reading — unless Domino's adds `TipAmount` on top, which would tip
twice. One real order at 0% tells you which. The max-total cap bounds it either way.

## Installing into OpenClaw

`SKILL.md` is already in OpenClaw's skill format.

1. Copy this directory onto the machine running OpenClaw.
2. `npm install && npm run build`
3. Make sure the 1Password CLI is signed in **as the user OpenClaw runs as** —
   this is the most common failure. `op whoami` must work in that context.
4. Register the skill per OpenClaw's docs (drop it in the skills directory).
5. Message your bot: *"order me a large pepperoni pizza"*.

The agent quotes, shows you the total, waits for you to say yes, then confirms.

## Commands

```
pizza stores                    Show the store that would fulfil the order
pizza menu <terms>              Search the live store menu
pizza propose <item> [item...]  Price an order and mint a confirm token (no charge)
pizza confirm <token>           Place the pending order (the only irreversible command)
pizza status                    Pending order, daily budget, delivery tracking
pizza history                   Recent orders
pizza cancel                    Discard the pending order
pizza reset --i-have-verified   Clear a stuck in-flight placement
                                --json on any command for machine-readable output
```

## Notes on the Domino's API

Things that cost time to discover, encoded in the code and tests:

- **Product codes are store-specific.** `16SCREEN` prices fine at one store and
  returns `PickAlternateProduct` at the next. Nothing is hardcoded; every item is
  resolved against the live menu of the store being ordered from.
- **A cheese pizza is not called "cheese pizza."** It is `14SCREEN`, "Large (14")
  Hand Tossed Pizza", $18.99 — sauce and cheese are its default toppings. A name
  search for "cheese pizza" finds the *Wisconsin 6-Cheese* specialty at $25.49
  and quietly overcharges by $6.50. `src/resolve.ts` builds base pizzas plus
  explicit toppings, and picks a specialty only when you name one.
- **There is no plain pepperoni pizza.** Pepperoni is a topping. "Large pepperoni"
  is `14SCREEN` + `P`, $21.49, not "Ultimate Pepperoni" at $25.49.
- **The `Payment` class fails silently.** If its card regexes do not recognise your
  card it returns an object with an empty number and a zero amount, with no error.
  Its Mastercard pattern is `^5[1-5]`, which misses the 2-series BINs (2221–2720)
  issued since 2017. `placeOrder` validates the constructed payment and refuses to
  submit an empty one.
- **`amountsBreakdown` mixes types.** `foodAndBeverage` is the string `"25.49"`;
  `customer` is the number `34.23`. All money is parsed to integer cents through
  `src/money.ts`, which rejects anything ambiguous rather than coercing it.
- Domino's ToS does not sanction this API. It is your account, your card, and your
  pizza, but they could change it without notice.

## Layout

```
src/money.ts        Integer-cent money. Exact decimal parsing, no float rounding.
src/config.ts       Env config and policy limits.
src/log.ts          Logging with mandatory secret redaction.
src/onepassword.ts  Secret reads; card only after approval.
src/dominos.ts      Store lookup, menu load, pricing, placement.
src/resolve.ts      Natural language to orderable item.
src/policy.ts       The hard gates.
src/state.ts        Atomic persistence, history, placement lock.
src/cli.ts          The agent-facing interface.
```
