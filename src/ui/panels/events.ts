import { RESOURCE_IDS, EVENT_TTL, type ResourceId } from '../../engine/state'
import { formatNumber, formatInt, formatTime } from '../../engine/format'
import { WORLD_EVENTS_BY_ID } from '../../content/events'
import { watchtowerBuilt } from '../../systems/events'
import type { UiCtx, Panel } from '../types'
import { h, resourceIcon, eventIcon, emptyState, helpTip } from '../dom'

/**
 * Events panel — the „Wydarzenia" tab (M13): the time-limited world-event OFFERS that liven up
 * the idle loop. Gated by the manually-built Wieża strażnicza (watchtower); without one the
 * mechanic is dormant (the panel says so and offers nothing) — mirroring the engine's identity
 * gate (systems/events.advanceEvents early-returns with no watchtower).
 *
 * Owns three mutually-exclusive states, built ONCE and toggled by `hidden`:
 *  - GATE: no watchtower → an empty state pointing at the building to construct.
 *  - IDLE: a watchtower, no live offer → a calm „wieża wypatruje" line + the ETA to the next offer.
 *  - OFFER: a live offer → its icon / name / description, the windfall preview (per resource), the
 *    TTL countdown and an „Odbierz" button that claims the bounded windfall to the capital.
 * A lifetime „odebrane wydarzenia" counter sits above, always visible.
 *
 * Discipline (panel contract): the static chrome is built ONCE; {@link Panel.update} only pokes
 * textContent / attributes onto existing nodes. The offer's identity (defId + roll) gates the
 * rebuild of the icon/name/desc/preview so a steady tick (which only ticks the TTL down) does no
 * per-resource work — only the countdown text is re-poked each frame.
 *
 * Accessibility: „Odbierz" uses aria-disabled (not the hard `disabled` property) so it stays
 * focusable/hoverable and its reason reaches the user; an aria-live status announces a fresh offer
 * arriving and the claim result. The TTL urgency is carried in WORDS + a class, never colour alone.
 */

/** Seconds of TTL at/under which the offer is flagged as „wygasa wkrótce" (a fifth of the window). */
const TTL_URGENT = EVENT_TTL / 5

export function createEventsPanel(ctx: UiCtx): Panel {
  // No outer .panel frame: a column of sections directly on the page background, like the
  // other tabs (campaign/reports/army) for consistent framing.
  const el = h('div', 'events-panel')

  // ---- Intro + lifetime counter -------------------------------------------
  const intro = h(
    'p',
    'muted',
    'Wieża strażnicza wypatruje wydarzeń w świecie. Co jakiś czas pojawia się ograniczona w czasie oferta — odbierz ją, zanim wygaśnie, aby zgarnąć jednorazowy zastrzyk surowców do stolicy.',
  )
  intro.style.fontSize = 'var(--text-sm)'
  intro.appendChild(
    helpTip(
      'Oferty pojawiają się tylko, gdy masz Wieżę strażniczą. Windfall trafia do stolicy i jest ' +
        'przycinany do pojemności magazynu (nadmiar przepada), więc warto mieć miejsce w spichlerzu.',
      { label: 'Jak działają wydarzenia' },
    ),
  )
  el.appendChild(intro)

  const lifetimeLine = h('p', 'horde-line muted')
  lifetimeLine.appendChild(document.createTextNode('Odebrane wydarzenia: '))
  const lifetimeVal = h('span', 'num')
  lifetimeLine.appendChild(lifetimeVal)
  el.appendChild(lifetimeLine)

  // ---- Offer section (one heading, three toggled states) ------------------
  const sectionTitleId = 'events-offer-title'
  const section = h('section', 'event-offer')
  section.setAttribute('aria-labelledby', sectionTitleId)
  const head = h('h3', 'recruit-subtitle panel-sticky-head', 'Oferta wydarzenia')
  head.id = sectionTitleId
  section.appendChild(head)

  // (a) GATE — no watchtower. emptyState carries the message in real text; the build hint
  // points at the concrete next step (the Wieża strażnicza is autoBuildable:false → manual).
  const gateBox = emptyState(
    'Brak wieży strażniczej',
    'Zbuduj Wieżę strażniczą (zakładka Budynki), aby wypatrywać wydarzeń w świecie.',
    'div',
  )
  section.appendChild(gateBox)

  // (b) IDLE — a watchtower, no live offer. A calm „wypatruje" line + the ETA countdown.
  const idleBox = h('div', 'event-idle')
  idleBox.appendChild(
    h('p', 'muted', 'Wieża wypatruje horyzontu — żadna oferta nie czeka.'),
  )
  const etaLine = h('p', 'horde-line muted')
  etaLine.appendChild(document.createTextNode('Następna oferta za '))
  const etaVal = h('span', 'num')
  etaLine.appendChild(etaVal)
  idleBox.appendChild(etaLine)
  section.appendChild(idleBox)

  // (c) OFFER — a live offer. The card surface reuses the shared .target class (layout.css).
  const offerBox = h('div', 'event-offer-card target')

  const offerHead = h('div', 'target-head')
  // The icon is a PROCEDURAL SVG (eventIcon, never emoji → no tofu, M11.9 lesson);
  // decorative, the name beside it carries the accessible label.
  const offerIcon = h('span', 'event-icon')
  offerIcon.setAttribute('aria-hidden', 'true')
  const offerName = h('span', 'target-name')
  offerHead.appendChild(offerIcon)
  offerHead.appendChild(offerName)
  offerBox.appendChild(offerHead)

  const offerDesc = h('p', 'target-stats muted')
  offerBox.appendChild(offerDesc)

  // Windfall preview: one row per resource (icon + amount). Built once; pokeGrant fills it.
  offerBox.appendChild(h('p', 'muted', 'Nagroda (do limitu magazynu stolicy):'))
  const grantList = h('div', 'event-grant')
  const grantVals = {} as Record<ResourceId, HTMLElement>
  for (const id of RESOURCE_IDS) {
    const row = h('span', 'event-grant-row')
    const iconWrap = h('span', 'res-icon-wrap')
    iconWrap.appendChild(resourceIcon(id))
    const val = h('span', 'num')
    row.appendChild(iconWrap)
    row.appendChild(val)
    grantList.appendChild(row)
    grantVals[id] = val
  }
  offerBox.appendChild(grantList)

  // TTL countdown — urgency carried in WORDS + a class, never colour alone.
  const ttlLine = h('p', 'horde-line')
  ttlLine.appendChild(document.createTextNode('Oferta wygasa za '))
  const ttlVal = h('span', 'num')
  ttlLine.appendChild(ttlVal)
  // Non-colour urgency cue: a WORD shown only when the window is nearly up, so the
  // „wygasa wkrótce" signal is never carried by the red class alone (WCAG 1.4.1).
  const ttlUrgent = h('span', 'event-ttl-urgent')
  ttlLine.appendChild(ttlUrgent)
  offerBox.appendChild(ttlLine)

  const bottom = h('div', 'target-bottom')
  const claimBtn = h('button', 'btn btn-primary', 'Odbierz')
  claimBtn.type = 'button'
  bottom.appendChild(claimBtn)
  offerBox.appendChild(bottom)
  section.appendChild(offerBox)
  el.appendChild(section)

  // ---- Status (claim feedback + offer-arrival announcement) ----------------
  const status = h('p', 'recruit-msg muted')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  el.appendChild(status)

  // Claim handler: re-validates through the commit callback (ctx.onClaimEvent → claimEvent),
  // which no-ops/returns false when there is no live offer. Names the reward in the status.
  claimBtn.addEventListener('click', () => {
    const ev = ctx.store.state.events
    const active = ev.active
    if (!active) {
      status.textContent = 'Brak oferty do odebrania.'
      return
    }
    const def = WORLD_EVENTS_BY_ID[active.defId]
    const ok = ctx.onClaimEvent()
    status.textContent = ok
      ? 'Odebrano: ' + (def ? def.name : 'wydarzenie') + '. Surowce trafiły do stolicy.'
      : 'Nie udało się odebrać oferty.'
    update()
  })

  // ---- Reactivity ----------------------------------------------------------
  let lastLifetime = -1
  // Offer identity (defId + roll) gates the heavy rebuild of icon/name/desc/preview; a plain
  // tick (TTL counting down) only re-pokes the countdown text. '' = no live offer last frame.
  let lastOfferKey = ''
  // Whether an offer was on the table last frame, so a fresh arrival can be announced once
  // (and not re-announced every frame while it sits unclaimed).
  let hadOffer = false

  /** Fill the windfall preview from the offer's def + roll against the capital's storage cap. */
  const pokeGrant = (defId: string, roll: number): void => {
    const def = WORLD_EVENTS_BY_ID[defId]
    const gs = ctx.store.state
    const capital = gs.villages[gs.villageOrder[0]]
    offerIcon.replaceChildren(eventIcon(defId, def ? def.name : 'Wydarzenie'))
    offerName.textContent = def ? def.name : 'Wydarzenie'
    offerDesc.textContent = def ? def.desc : ''
    const grant = def ? def.grant(roll, capital.storageCap) : null
    for (const id of RESOURCE_IDS) {
      grantVals[id].textContent = grant ? formatNumber(grant[id]) : '—'
    }
  }

  const update = (): void => {
    const gs = ctx.store.state
    const ev = gs.events
    const built = watchtowerBuilt(gs)

    // Lifetime counter — change-gated so a steady tick writes nothing.
    if (gs.stats.eventsResolved !== lastLifetime) {
      lastLifetime = gs.stats.eventsResolved
      lifetimeVal.textContent = formatInt(gs.stats.eventsResolved)
    }

    const showOffer = built && ev.active !== null
    const showIdle = built && ev.active === null
    gateBox.hidden = built
    idleBox.hidden = !showIdle
    offerBox.hidden = !showOffer

    if (showOffer && ev.active) {
      const active = ev.active
      const key = active.defId + ':' + active.roll
      if (key !== lastOfferKey) {
        lastOfferKey = key
        pokeGrant(active.defId, active.roll)
      }
      // Announce a freshly arrived offer exactly once (not while it sits unclaimed).
      if (!hadOffer) {
        const def = WORLD_EVENTS_BY_ID[active.defId]
        status.textContent =
          'Nowe wydarzenie: ' + (def ? def.name : 'oferta') + ' — odbierz, zanim wygaśnie.'
      }
      // TTL countdown (re-poked every frame). Urgency in words + a class, never colour alone.
      ttlVal.textContent = formatTime(Math.max(0, active.ttl))
      const urgent = active.ttl <= TTL_URGENT
      ttlVal.classList.toggle('text-bad', urgent)
      ttlUrgent.textContent = urgent ? ' — wygasa wkrótce' : ''
      claimBtn.setAttribute('aria-disabled', 'false')
      claimBtn.title = ''
      hadOffer = true
    } else {
      lastOfferKey = ''
      hadOffer = false
      // ETA to the next offer (idle). With no watchtower the idleBox is hidden anyway.
      etaVal.textContent = formatTime(Math.max(0, ev.timer))
      claimBtn.setAttribute('aria-disabled', 'true')
      claimBtn.title = built ? 'Brak oferty do odebrania.' : 'Najpierw zbuduj Wieżę strażniczą.'
    }
  }

  return { el, update }
}
