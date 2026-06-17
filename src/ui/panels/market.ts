import { RESOURCE_IDS, type ResourceId } from '../../engine/state'
import { D } from '../../engine/decimal'
import { formatInt, formatTime } from '../../engine/format'
import { BUILDINGS } from '../../content/buildings'
import {
  canTransport,
  availableCapacity,
  merchantCapacityInUse,
  shipmentTime,
  canExchange,
  exchangeRate,
} from '../../systems/market'
import type { UiCtx, Panel } from '../types'
import { h, resourceIcon, RESOURCE_NAMES, emptyState, segmented } from '../dom'

/**
 * Market panel — the „Rynek" screen (M9). The player-facing front end of the
 * merchant TRANSPORT action: it dispatches a {@link import('../../engine/state').Shipment}
 * carrying wood/clay/iron from the ACTIVE village (ctx.activeVillageId, the source)
 * to another OWNED village over a travel time derived from the map distance. The
 * cargo leaves the source immediately (debited + held in transit, occupying the
 * source's merchant capacity) and is delivered on arrival, clamped to the
 * destination's storage cap (overflow spilled) — all resolved by the engine; this
 * panel only composes and DISPATCHES the transport.
 *
 * Like the army/campaign panels it is a PLAYER-INITIATED screen: every cue
 * (capacity headroom, the per-resource amounts, the forecast and the „Wyślij"
 * verdict) is read straight from systems/market (canTransport / availableCapacity /
 * shipmentTime), so the visible state can never disagree with what a dispatch
 * actually does. Transport is benign/reversible (it CONSERVES resources — it never
 * creates any), so no window.confirm is needed.
 *
 * Gating (explicit PL reasons, never colour alone — WCAG 1.4.1):
 *  - < 2 villages → „Załóż lub podbij drugą wioskę, aby handlować." (no destination
 *    exists yet); the compose form is hidden.
 *  - the active village's market is at level 0 → „Zbuduj Rynek, aby wysyłać kupców.".
 * The in-flight list always shows (empty when gated, since a gated village can have
 * no shipments — you needed a market AND a destination to ever dispatch one).
 *
 * Below the transport screen the same panel hosts the WYMIANA (exchange) section (M9.2): an
 * at-village conversion of one resource type into another, INSTANT, paying a spread (the rate
 * is ALWAYS < 1, so you receive LESS than you put in — a convenience / surplus sink, never an
 * arbitrage exploit). It is INDEPENDENT of transport — it needs only a market (level >= 1),
 * NOT a second village — so even a lone-village player can rebalance a glut here; hence it
 * carries its OWN gate, separate from the transport one. Like transport it is player-initiated
 * (the cue is read straight from systems/market.canExchange, the rate from exchangeRate) and
 * benign (a strict-loss conversion), so no window.confirm is needed.
 *
 * Discipline (panel contract): the DOM is built ONCE here and cached; {@link Panel.update}
 * only pokes textContent / attributes onto existing nodes, with two bounded
 * exceptions that rebuild ONLY when their content signature changes — the destination
 * `<select>` options (when villageOrder / the active village changes) and the in-flight
 * shipment list (when its to/ETA/cargo signature changes). The composed cargo + the
 * picked destination do NOT bump the store revision, so their input/change events call
 * update() directly to refresh the forecast and the button verdict (mirrors campaign.ts).
 */

/** Cached handles for one per-resource cargo row. */
interface CargoRow {
  /** Amount input (the typed count drives the cargo total + the transport verdict). */
  input: HTMLInputElement
  /** „dostępne: N" — how much of this resource the SOURCE currently holds. */
  avail: HTMLElement
}

/**
 * Build the market panel. Reads {@link UiCtx} for the live store and the
 * `onTransport` commit; the validation is read straight from systems/market
 * (canTransport) so the disabled cue and the actual dispatch can never disagree.
 */
export function createMarketPanel(ctx: UiCtx): Panel {
  // No outer .panel frame: every tab is laid out directly on the page background
  // (matches buildings/army/campaign/save) for consistent framing.
  const el = h('div', 'market-panel')

  // ---- Status (market level + merchant capacity) ---------------------------
  // Always shown: the source's market level and its carry budget (used / available /
  // total), so the player can size a transport against the headroom.
  const status = h('p', 'recruit-status muted')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  el.appendChild(status)

  // ---- Segmented switch: send | exchange (M12.3 vertical density) -----------
  // The two market actions („Wyślij kupców" + „Wymień surowce") used to stack and
  // double the scroll. They now share ONE slot: a segmented control reveals exactly
  // one section at a time via the `hidden` attribute. Both sections stay in the DOM and
  // keep their per-frame forecast/capacity updates running inside the store.rev effect —
  // we only flip visibility, never destroy/rebuild — so switching reveals fresh state.
  const sendSection = h('div', 'market-section')
  const exchangeSection = h('div', 'market-section')
  const seg = segmented(
    [
      { id: 'send', label: 'Wyślij kupców' },
      { id: 'exchange', label: 'Wymień surowce' },
    ],
    'send',
    (id) => {
      sendSection.hidden = id !== 'send'
      exchangeSection.hidden = id !== 'exchange'
    },
  )
  // A11y: ARIA requires a radiogroup to carry an accessible NAME, otherwise a screen
  // reader announces an unnamed group and the two options have no stated purpose. The
  // segmented() primitive sets no name, so name the group here (the in-panel fix; the
  // primitive stays untouched).
  seg.root.setAttribute('aria-label', 'Akcja rynku')
  el.appendChild(seg.root)
  el.appendChild(sendSection)
  el.appendChild(exchangeSection)
  // Default „send" visible, „exchange" hidden (matches the segmented control's initialId).
  exchangeSection.hidden = true

  // Gate notice (the two explicit PL reasons). Renderowana jako blok PUSTEGO STANU
  // (spokojny glif + REALNY tekst powodu — nigdy sam kolor): ten <div> jest hostem
  // „live region" (role=status), w którym OSADZAMY emptyState (helper nie dokłada
  // własnego role/aria-live — to host go niesie). Ukryty, gdy żadna bramka nie
  // obowiązuje; gdy widoczny, formularz kompozycji jest schowany.
  const gate = h('div')
  gate.setAttribute('role', 'status')
  gate.setAttribute('aria-live', 'polite')
  gate.hidden = true
  sendSection.appendChild(gate)
  // Sentinel: wnętrze bramki przebudowujemy tylko przy zmianie powodu (nie co tick).
  let lastGateReason = ' '

  // ---- Compose + dispatch form --------------------------------------------
  const formTitleId = 'market-form-title'
  const form = h('section', 'market-form')
  form.setAttribute('aria-labelledby', formTitleId)

  const formHead = h('h3', 'recruit-subtitle', 'Wyślij kupców')
  formHead.id = formTitleId
  form.appendChild(formHead)

  // Destination selector (the OTHER own villages, from villageOrder). Reuses the
  // .army-pick column field; the <select> itself takes the shared .market-select form
  // styling (layout.css) so no inline styles are needed. Options are rebuilt only when
  // the village roster / active village changes.
  const destField = h('div', 'army-pick')
  destField.appendChild(h('span', 'army-pick-label', 'Wioska docelowa'))
  const destSelect = h('select', 'market-select num')
  destSelect.setAttribute('aria-label', 'Wioska docelowa transportu')
  destSelect.addEventListener('change', () => update())
  destField.appendChild(destSelect)
  form.appendChild(destField)
  // Sentinel so the first update() always builds the option list.
  let lastDestSig = '\x00'

  // Per-resource cargo inputs (wood/clay/iron), laid out in the shared army-picker grid.
  const picker = h('div', 'army-picker')
  const rows = {} as Record<ResourceId, CargoRow>
  for (const r of RESOURCE_IDS) {
    const pick = h('div', 'army-pick')

    const labelRow = h('span', 'army-pick-label')
    const iconWrap = h('span', 'res-icon-wrap')
    iconWrap.appendChild(resourceIcon(r))
    labelRow.appendChild(iconWrap)
    labelRow.appendChild(document.createTextNode(' ' + RESOURCE_NAMES[r]))

    const avail = h('span', 'army-pick-avail num muted')

    const input = h('input', 'recruit-count num')
    input.type = 'number'
    input.min = '0'
    input.step = '1'
    input.value = '0'
    input.inputMode = 'numeric'
    input.setAttribute('aria-label', 'Ilość do wysłania: ' + RESOURCE_NAMES[r])
    // The composed cargo does not bump the store revision — refresh the forecast +
    // verdict on direct input.
    input.addEventListener('input', () => update())

    pick.appendChild(labelRow)
    pick.appendChild(avail)
    pick.appendChild(input)
    picker.appendChild(pick)
    rows[r] = { input, avail }
  }
  form.appendChild(picker)

  // Live forecast: total cargo vs available capacity, the destination and the
  // estimated travel time. Over-capacity is stated in WORDS (never colour alone),
  // with .text-bad as a supplementary tint.
  const forecast = h('p', 'attack-summary muted')
  forecast.setAttribute('role', 'status')
  forecast.setAttribute('aria-live', 'polite')
  form.appendChild(forecast)

  // Actions: dispatch + clear. „Wyślij" uses aria-disabled (not the hard `disabled`
  // property) so it stays focusable/hoverable and its reason (canTransport) reaches
  // the user; the click handler is a guarded no-op when the transport is not sendable.
  const actions = h('div', 'recruit-controls')
  const sendBtn = h('button', 'btn btn-primary', 'Wyślij')
  sendBtn.type = 'button'
  sendBtn.setAttribute('aria-label', 'Wyślij kupców do wybranej wioski')
  sendBtn.addEventListener('click', () => {
    const fromId = ctx.activeVillageId.value
    const toId = destSelect.value
    const cargo = readCargo()
    const verdict = canTransport(ctx.store.state, fromId, toId, cargo)
    if (!verdict.ok) {
      msg.textContent = verdict.reason ?? 'Nie można wysłać kupców.'
      update()
      return
    }
    const ok = ctx.onTransport(fromId, toId, cargo)
    if (ok) {
      const toName = ctx.store.state.villages[toId]?.name ?? toId
      msg.textContent = 'Wysłano kupców do: ' + toName + '.'
      for (const r of RESOURCE_IDS) rows[r].input.value = '0'
    } else {
      msg.textContent = 'Nie udało się wysłać kupców.'
    }
    update()
  })
  const clearBtn = h('button', 'btn btn-ghost', 'Wyczyść')
  clearBtn.type = 'button'
  clearBtn.addEventListener('click', () => {
    for (const r of RESOURCE_IDS) rows[r].input.value = '0'
    update()
  })
  actions.appendChild(sendBtn)
  actions.appendChild(clearBtn)
  form.appendChild(actions)

  // Feedback for the last transport attempt (success or the canTransport reason).
  const msg = h('p', 'recruit-msg muted')
  msg.setAttribute('role', 'status')
  msg.setAttribute('aria-live', 'polite')
  form.appendChild(msg)

  sendSection.appendChild(form)

  // ---- Kupcy w drodze (in-flight shipments from the active village) ---------
  sendSection.appendChild(h('h3', 'recruit-subtitle', 'Kupcy w drodze'))
  const shipList = h('ul', 'march-list')
  sendSection.appendChild(shipList)
  // Sentinel so the first update() always builds the list (even the empty notice).
  let lastShipSig = '\x00'

  // ---- Wymiana surowców (M9.2) ---------------------------------------------
  // A SECOND market action, INDEPENDENT of transport: convert one resource type into another
  // AT the active village, instantly, paying a spread (the rate is ALWAYS < 1, so you receive
  // LESS than you put in — a convenience / surplus sink, never arbitrage). It needs only a
  // market (level >= 1), NOT a second village, so a lone-village player can rebalance a glut
  // here — hence its OWN gate, separate from the transport gate above. `.market-form` is a
  // semantic-only class (no CSS rule, like the transport section), so no styles are added.
  const exTitleId = 'market-exchange-title'
  const exForm = h('section', 'market-form')
  exForm.setAttribute('aria-labelledby', exTitleId)

  const exHead = h('h3', 'recruit-subtitle', 'Wymień surowce')
  exHead.id = exTitleId
  exForm.appendChild(exHead)

  // Exchange gate (only the market-level reason). Renderowana jako blok PUSTEGO STANU
  // (spokojny glif + REALNY tekst powodu — nigdy sam kolor): ten <div> jest hostem
  // „live region" (role=status), w którym OSADZAMY emptyState. Gdy widoczny, sterowanie
  // poniżej jest schowane.
  const exGate = h('div')
  exGate.setAttribute('role', 'status')
  exGate.setAttribute('aria-live', 'polite')
  exGate.hidden = true
  exForm.appendChild(exGate)
  // Sentinel: przebudowa wnętrza bramki wymiany tylko przy zmianie powodu.
  let lastExGateReason = ' '

  // Controls wrapper — hidden as a whole while gated (the gate notice stays visible). A plain
  // block container: needs no styling, so it carries only a semantic class.
  const exBody = h('div', 'market-exchange-body')

  // From / to resource selectors + amount, laid out in the shared army-picker grid. The
  // resource set (RESOURCE_IDS) is FIXED, so these options are built ONCE and never rebuilt.
  const exPicker = h('div', 'army-picker')

  // „Z surowca" (the resource you give away) + how much of it the village currently holds.
  const exFromField = h('div', 'army-pick')
  exFromField.appendChild(h('span', 'army-pick-label', 'Z surowca'))
  const exFromAvail = h('span', 'army-pick-avail num muted')
  exFromField.appendChild(exFromAvail)
  const exFromSelect = h('select', 'market-select')
  exFromSelect.setAttribute('aria-label', 'Surowiec do oddania')
  for (const r of RESOURCE_IDS) {
    const opt = h('option', undefined, RESOURCE_NAMES[r])
    opt.value = r
    exFromSelect.appendChild(opt)
  }
  exFromSelect.value = RESOURCE_IDS[0]
  // The picked resources do not bump the store revision — refresh the preview + verdict on change.
  exFromSelect.addEventListener('change', () => update())
  exFromField.appendChild(exFromSelect)
  exPicker.appendChild(exFromField)

  // „Na surowiec" (the resource you receive). Must DIFFER from the source — when they match,
  // canExchange rejects it and the „Wymień" button carries the „różne surowce" reason.
  const exToField = h('div', 'army-pick')
  exToField.appendChild(h('span', 'army-pick-label', 'Na surowiec'))
  const exToSelect = h('select', 'market-select')
  exToSelect.setAttribute('aria-label', 'Surowiec do otrzymania')
  for (const r of RESOURCE_IDS) {
    const opt = h('option', undefined, RESOURCE_NAMES[r])
    opt.value = r
    exToSelect.appendChild(opt)
  }
  // Default to a DIFFERENT resource than the source so the form is valid out of the box.
  exToSelect.value = RESOURCE_IDS[1]
  exToSelect.addEventListener('change', () => update())
  exToField.appendChild(exToSelect)
  exPicker.appendChild(exToField)

  // „Ilość" (the gross input traded away). Like the cargo inputs it does not bump the store
  // revision, so its input event refreshes the preview + verdict directly.
  const exAmountField = h('div', 'army-pick')
  exAmountField.appendChild(h('span', 'army-pick-label', 'Ilość'))
  const exAmountInput = h('input', 'recruit-count num')
  exAmountInput.type = 'number'
  exAmountInput.min = '0'
  exAmountInput.step = '1'
  exAmountInput.value = '0'
  exAmountInput.inputMode = 'numeric'
  exAmountInput.setAttribute('aria-label', 'Ilość surowca do wymiany')
  exAmountInput.addEventListener('input', () => update())
  exAmountField.appendChild(exAmountInput)
  exPicker.appendChild(exAmountField)

  exBody.appendChild(exPicker)

  // Live preview: the current rate (a %, improving with market level but ALWAYS < 100%), what
  // you give, what you RECEIVE (floor(amount × rate)) and the implied loss. The spread is
  // stated in WORDS, never colour alone.
  const exPreview = h('p', 'attack-summary muted')
  exPreview.setAttribute('role', 'status')
  exPreview.setAttribute('aria-live', 'polite')
  exBody.appendChild(exPreview)

  // Action: „Wymień". aria-disabled (not the hard `disabled` property) so it stays focusable
  // and its reason (canExchange) reaches the user; the click handler is a guarded no-op when
  // the exchange is not valid. A strict-loss surplus sink → benign, no confirm.
  const exActions = h('div', 'recruit-controls')
  const exSendBtn = h('button', 'btn btn-primary', 'Wymień')
  exSendBtn.type = 'button'
  exSendBtn.setAttribute('aria-label', 'Wymień surowce w tej wiosce')
  exSendBtn.addEventListener('click', () => {
    const villageId = ctx.activeVillageId.value
    const fromRes = exFromSelect.value as ResourceId
    const toRes = exToSelect.value as ResourceId
    const amount = readAmount()
    const verdict = canExchange(ctx.store.state, villageId, fromRes, toRes, amount)
    if (!verdict.ok) {
      exMsg.textContent = verdict.reason ?? 'Nie można wymienić surowców.'
      update()
      return
    }
    // Capture the ACTUAL credit BEFORE the exchange mutates the pool: floor(amount × rate)
    // clamped to the target's storage headroom (overflow spills, like the engine), so the
    // receipt matches what is really credited even into a near-full magazyn.
    const v = ctx.store.state.villages[villageId]
    const gross = D(amount).mul(exchangeRate(v?.buildings.market ?? 0)).floor()
    const headroom = v ? v.storageCap.sub(v.resources[toRes]) : gross
    let received = gross.gt(headroom) ? headroom : gross
    if (received.lt(0)) received = D(0)
    const ok = ctx.onExchange(villageId, fromRes, toRes, amount)
    if (ok) {
      exMsg.textContent =
        'Wymieniono ' +
        formatInt(amount) +
        ' ' +
        RESOURCE_NAMES[fromRes] +
        ' na ' +
        formatInt(received) +
        ' ' +
        RESOURCE_NAMES[toRes] +
        '.'
      exAmountInput.value = '0'
    } else {
      exMsg.textContent = 'Nie udało się wymienić surowców.'
    }
    update()
  })
  exActions.appendChild(exSendBtn)
  exBody.appendChild(exActions)

  // Feedback for the last exchange attempt (success receipt or the canExchange reason).
  const exMsg = h('p', 'recruit-msg muted')
  exMsg.setAttribute('role', 'status')
  exMsg.setAttribute('aria-live', 'polite')
  exBody.appendChild(exMsg)

  exForm.appendChild(exBody)
  exchangeSection.appendChild(exForm)

  /** Read the composed cargo from the inputs, each coerced to a non-negative integer. */
  const readCargo = (): Record<ResourceId, number> => {
    const cargo = {} as Record<ResourceId, number>
    for (const r of RESOURCE_IDS) {
      const parsed = Math.floor(Number(rows[r].input.value))
      cargo[r] = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
    }
    return cargo
  }

  /** Read the exchange amount from its input, coerced to a non-negative integer. */
  const readAmount = (): number => {
    const parsed = Math.floor(Number(exAmountInput.value))
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }

  /**
   * (Re)build the destination `<select>` from villageOrder minus the active source.
   * Keeps the current selection when it is still a valid destination, otherwise falls
   * back to the first other village. Called only when the roster / active village changes.
   */
  const rebuildDest = (fromId: string): void => {
    const state = ctx.store.state
    const others = state.villageOrder.filter((id) => id !== fromId)
    const prev = destSelect.value
    destSelect.textContent = ''
    for (const id of others) {
      const v = state.villages[id]
      const opt = h('option', undefined, v.name + ' (' + v.x + '|' + v.y + ')')
      opt.value = id
      destSelect.appendChild(opt)
    }
    if (others.includes(prev)) destSelect.value = prev
    else if (others.length > 0) destSelect.value = others[0]
  }

  // ---- Reactivity ----------------------------------------------------------
  const update = (): void => {
    const state = ctx.store.state
    const fromId = ctx.activeVillageId.value
    const from = state.villages[fromId]
    const order = state.villageOrder
    const marketLevel = from.buildings.market

    // Status: market level + the carry budget (used / available / total). Always shown.
    const cap = from.merchantCapacity
    const used = merchantCapacityInUse(from)
    const avail = availableCapacity(from)
    status.textContent =
      BUILDINGS.market.name +
      ': poziom ' +
      formatInt(marketLevel) +
      ' • ładowność kupców — używane: ' +
      formatInt(used) +
      ', dostępne: ' +
      formatInt(avail) +
      ', łącznie: ' +
      formatInt(cap) +
      '.'

    // Gating (most fundamental first): no destination village → then no market.
    let gateReason = ''
    if (order.length < 2) gateReason = 'Załóż lub podbij drugą wioskę, aby handlować.'
    else if (!(marketLevel >= 1)) gateReason = 'Zbuduj Rynek, aby wysyłać kupców.'
    // Wnętrze przebudowujemy tylko przy zmianie powodu (host role=status sam ogłasza nową
    // treść); poza tym jedynie przełączamy widoczność — zero pracy DOM na spokojnym ticku.
    if (gateReason !== lastGateReason) {
      lastGateReason = gateReason
      gate.textContent = ''
      if (gateReason !== '') gate.appendChild(emptyState(gateReason))
    }
    gate.hidden = gateReason === ''
    form.hidden = gateReason !== ''

    // In-flight shipments: rebuilt only when the to/ETA/cargo signature changes, so a
    // steady tick that merely counts down does the cheap signature compare and no DOM
    // work. Updated even while gated (it is simply empty then).
    const shipSig = from.shipments
      .map(
        (s) =>
          s.toVillageId +
          ':' +
          Math.ceil(s.remaining) +
          ':' +
          RESOURCE_IDS.map((r) => formatInt(s.cargo[r])).join(','),
      )
      .join('|')
    if (shipSig !== lastShipSig) {
      lastShipSig = shipSig
      shipList.textContent = ''
      if (from.shipments.length === 0) {
        // Pusty stan jako jedyny wiersz <ul class=march-list> (kolumna flex — bez gridColumn).
        shipList.appendChild(emptyState('Brak kupców w drodze.', undefined, 'li'))
      } else {
        for (const s of from.shipments) {
          const li = h('li', 'march-item is-outbound')
          const main = h('div', 'march-main')
          const fromName = state.villages[s.fromVillageId]?.name ?? s.fromVillageId
          const toName = state.villages[s.toVillageId]?.name ?? s.toVillageId
          main.appendChild(h('span', 'march-target', fromName + ' → ' + toName))
          // Phase is conveyed by an arrow glyph AND a word — never colour alone (a
          // shipment has only an outbound leg; there is no return).
          main.appendChild(h('span', 'march-phase', '→ w drodze'))
          li.appendChild(main)

          const parts: string[] = []
          for (const r of RESOURCE_IDS) {
            if (s.cargo[r].gt(0)) parts.push(RESOURCE_NAMES[r] + ' ×' + formatInt(s.cargo[r]))
          }
          const sub = h('div', 'march-sub muted')
          sub.appendChild(h('span', 'march-units', parts.join(', ') || '—'))
          sub.appendChild(h('span', 'march-eta num', formatTime(s.remaining)))
          li.appendChild(sub)
          shipList.appendChild(li)
        }
      }
    }

    // ---- Wymiana surowców (M9.2) -------------------------------------------
    // Computed BEFORE the transport early-return below, because exchange has its OWN gate: it
    // needs only a market (level >= 1), NOT a second village. So even when the transport form
    // is gated (a lone village, order.length < 2), a built market still lets the player
    // rebalance a surplus here. Carried in TEXT (never colour alone); the body hides while gated.
    const exGateReason = marketLevel >= 1 ? '' : 'Zbuduj Rynek, aby wymieniać surowce.'
    // Jak wyżej: przebudowa wnętrza tylko przy zmianie powodu, reszta to przełącznik widoczności.
    if (exGateReason !== lastExGateReason) {
      lastExGateReason = exGateReason
      exGate.textContent = ''
      if (exGateReason !== '') exGate.appendChild(emptyState(exGateReason))
    }
    exGate.hidden = exGateReason === ''
    exBody.hidden = exGateReason !== ''
    if (exGateReason === '') {
      const exFromRes = exFromSelect.value as ResourceId
      const exToRes = exToSelect.value as ResourceId
      const exAmount = readAmount()
      // The from-resource the village currently holds (the spendable pool for the exchange).
      exFromAvail.textContent = 'dostępne: ' + formatInt(from.resources[exFromRes])
      const rate = exchangeRate(marketLevel)
      if (exFromRes === exToRes) {
        // Invalid pairing (the button carries the same „różne surowce" reason) — never render a
        // contradictory same-resource forecast (e.g. „oddajesz 100 Glina → otrzymasz 52 Glina").
        exPreview.textContent = 'Wybierz dwa różne surowce, aby wymienić.'
      } else {
        // Rate (a %, improving with market level but ALWAYS < 100%), the received amount and the
        // implied loss. The credit is CLAMPED to the target's storage headroom (overflow spills,
        // like the engine), so the forecast never overstates what is actually credited into a
        // near-full magazyn.
        const gross = D(exAmount).mul(rate).floor()
        const headroom = from.storageCap.sub(from.resources[exToRes])
        let received = gross.gt(headroom) ? headroom : gross
        if (received.lt(0)) received = D(0)
        const loss = D(exAmount).sub(received)
        let line =
          'Kurs: ' +
          formatInt(Math.round(rate * 100)) +
          '% • oddajesz ' +
          formatInt(exAmount) +
          ' ' +
          RESOURCE_NAMES[exFromRes] +
          ' → otrzymasz ' +
          formatInt(received) +
          ' ' +
          RESOURCE_NAMES[exToRes] +
          ' (strata ' +
          formatInt(loss) +
          ')'
        if (received.lt(gross)) line += ' • magazyn pełny — część przepada'
        exPreview.textContent = line
      }
      // Button verdict for the SAME inputs the exchange will use; the reason becomes the
      // tooltip + aria cue. Disabled state is carried by aria-disabled + text, not colour.
      const exVerdict = canExchange(state, fromId, exFromRes, exToRes, exAmount)
      exSendBtn.setAttribute('aria-disabled', exVerdict.ok ? 'false' : 'true')
      exSendBtn.title = exVerdict.ok ? '' : (exVerdict.reason ?? '')
    }

    // Nothing more to compute while gated — the form (destination / inputs / forecast /
    // button) is hidden, so leave its stale fields untouched.
    if (gateReason !== '') return

    // Destination options: rebuilt only when the roster / active village changes.
    const destSig = fromId + ':' + order.join(',')
    if (destSig !== lastDestSig) {
      lastDestSig = destSig
      rebuildDest(fromId)
    }

    // Per-resource availability (the source's current holdings).
    for (const r of RESOURCE_IDS) {
      rows[r].avail.textContent = 'dostępne: ' + formatInt(from.resources[r])
    }

    // Forecast: total cargo vs available capacity, the destination and the travel time.
    const cargo = readCargo()
    let total = 0
    for (const r of RESOURCE_IDS) total += cargo[r]
    const toId = destSelect.value
    const to = state.villages[toId]
    const over = D(total).gt(avail)
    let fc =
      'Ładunek: ' + formatInt(total) + ' / ' + formatInt(avail) + ' dostępnej ładowności'
    if (over) fc += ' (przekracza ładowność)'
    if (to !== undefined) {
      fc += ' • cel: ' + to.name + ' • czas podróży: ' + formatTime(shipmentTime(from, to))
    }
    forecast.textContent = fc
    // Supplementary tint only — the „(przekracza ładowność)" text already carries the cue.
    forecast.classList.toggle('text-bad', over)

    // Button verdict for the SAME cargo + destination the dispatch will use; the reason
    // becomes the tooltip + aria cue.
    const verdict = canTransport(state, fromId, toId, cargo)
    sendBtn.setAttribute('aria-disabled', verdict.ok ? 'false' : 'true')
    sendBtn.title = verdict.ok ? '' : (verdict.reason ?? '')
  }

  return { el, update }
}
