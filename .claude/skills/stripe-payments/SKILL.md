---
name: stripe-payments
description: >-
  Stripe integration best practices for this game's monetization — premium
  currency, premium account, and quest/reward purchases. USE THIS SKILL WHENEVER
  you add or change anything payment-related: checkout, webhooks, granting
  premium entitlements, refunds, or storing customer/subscription state. The
  core rule mirrors the rest of the project: never grant value from a
  client-reported success — entitlements are granted only from verified,
  idempotent Stripe webhooks server-side. Lower priority than core gameplay;
  build it only when monetization is on the roadmap.
---

# Stripe Payments

Monetization (premium currency, premium account, cosmetic/quest rewards) comes
**after** the core game loop is fun (`[[project-conventions]]` mandate). When you
do build it, follow these rules — they are the payment-flavored version of the
project's "never trust the client" principle (`[[secure-coding]]`).

## Cardinal rules

1. **Grant entitlements only from verified webhooks, never from the client.** A
   browser redirect to a "success" page is **not** proof of payment. The client
   may *show* optimistic success, but premium currency/flags are written to the
   DB only when a **signature-verified** Stripe webhook
   (`checkout.session.completed`, `invoice.paid`) arrives.
2. **Verify webhook signatures** with the endpoint signing secret
   (`stripe.webhooks.constructEvent`) using the **raw request body** (mount the
   webhook route with a raw body parser, before JSON middleware).
3. **Idempotency everywhere.** Use Stripe idempotency keys on writes, and make
   webhook handling idempotent: persist processed `event.id`s and no-op on
   replays (Stripe redelivers). Granting must be exactly-once.
4. **Amounts and prices live in Stripe / server config**, never accepted from
   the client. The client picks a *product/price id*; the server maps it to the
   real amount and the entitlement granted.
5. **Secrets from env only.** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` from
   environment; never committed. Publishable key only on the client.

## Recommended flow

- **Checkout Sessions** (hosted) for one-off purchases (premium currency packs)
  and **Subscriptions** for premium accounts — least PCI burden, Stripe-hosted
  card entry.
- Store a `stripe_customer_id` per player; link sessions/subscriptions to the
  player via `client_reference_id`/metadata so the webhook knows whom to credit.
- On `checkout.session.completed` / `invoice.paid`: in one DB transaction,
  check the event isn't already processed, credit premium currency or set the
  premium flag/expiry, record a ledger row, mark the event processed. Push a
  Socket.io notification so the client refreshes.
- Handle `customer.subscription.updated/deleted` to expire premium access.
- Reconcile periodically against Stripe as a safety net for missed webhooks.

## Testing

- Use Stripe **test mode** + the Stripe CLI to forward/replay webhooks locally.
- Assert idempotency by replaying the same event and confirming a single grant.

## Current docs

Stripe's API evolves; when implementing, pull the current API version's docs via
**context7** rather than relying on memory, and pin the Stripe API version in
the SDK config.
