---
name: vue-development
description: >-
  Frontend conventions for this Tribal Wars / Travian-style game's Vue 3 +
  Vite client: Composition API with <script setup>, Pinia stores, the Socket.io
  live layer, and the game-specific views (world map, village/build queue,
  recruit panel, battle reports, alliance). USE THIS SKILL WHENEVER you build or
  change anything in /client — a component, view, store, route, API call, or
  real-time subscription. It enforces the server-authoritative display rule (the
  client renders and predicts, the server decides) and how to wire countdowns,
  resource bars, and the map without ever becoming a source of truth.
  Complements the generic frontend-design plugin with project-specific patterns.
---

# Vue Development (game client)

The client is a **renderer of server state and a sender of intents**. It may
compute values locally for snappy UX (ticking countdowns, resource bars filling)
but the server is the only authority — see `[[game-architecture]]` and
`[[project-conventions]]`. Never let a server action trust a client-computed
number.

## Stack & structure

- **Vue 3** Composition API, `<script setup>`, **Vite** dev/build.
- **Pinia** for state; **vue-router** for views; **Socket.io client** for live
  updates. Keep API access in `/client/src/api` (thin fetch wrappers returning
  typed data).
- Layout (see `[[project-conventions]]`): `src/components` (reusable),
  `src/views` (routed screens), `src/stores` (Pinia), `src/api` (HTTP),
  `src/realtime` (socket wiring).

## Core patterns

### Server-authoritative display
- Render whatever the server returns. For costs/timers, you may **mirror** the
  same balance formulas from `/shared` for instant feedback, but every action
  (`POST /api/...`) sends only the **intent** (e.g. "upgrade HQ"), never the
  computed cost/time. The server recomputes and is the writer.
- After an action, prefer the server's response (or the next socket push) over
  optimistic local state when they disagree — reconcile to the server.

### Resource bars & accrual (client-side prediction)
- The server sends `{ wood, clay, iron, last_updated, prod_per_hour, cap }`.
  The client predicts current amounts with the same lazy-accrual math used
  server-side (`[[game-architecture]]` §2): `amount + prod*elapsed/3600`,
  clamped to `cap`. Tick it with `requestAnimationFrame`/interval for a live
  bar. This is **display only** — re-sync from the server on focus and after
  every action.

### Countdowns (build/recruit/marches)
- The server provides absolute `due_at`/`arrives_at` (ISO/epoch). The client
  renders `due_at - serverNow` as a countdown. Track a **server-clock offset**
  (measured once at load from a server timestamp) so countdowns don't drift with
  client clock skew. When a countdown hits zero, **refetch** — don't assume
  completion locally.

### Real-time (Socket.io)
- Connect after auth; the client joins only its own rooms (server authorizes).
- Subscribe to `building:finished`, `recruit:finished`, `march:incoming`,
  `march:arrived`, `report:created`, resource milestones. On each, patch the
  relevant Pinia store and let reactive views update.
- Sockets are an optimization; every screen must also work via REST refetch.

### The world map
- Render from a fetched window of villages/coordinates (paginate by sector — do
  not fetch the whole world). Distances and travel times shown on the map are
  **fetched/recomputed from the server**, not trusted from client math when
  sending a march.

## Game views to expect

Village overview (buildings + queue), build/upgrade panel, recruit panel,
world map + send-troops dialog, incoming/outgoing movements, battle reports
list + detail, alliance screen, rankings. Each maps to a Pinia store slice and a
small set of REST endpoints + socket events.

## Quality

- Keep components small and prop-driven; lift shared state to Pinia, not props
  drilling. Use the **frontend-design** plugin skill for visual quality.
- Verify real player loops with **Playwright** (register → build → countdown →
  recruit → march → report), per the "is there something fun to do right now?"
  mandate in `[[project-conventions]]`. That loop is the acceptance test.
