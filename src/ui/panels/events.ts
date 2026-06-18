import { RESOURCE_IDS, EVENT_TTL, type ResourceId, type TechModifiers } from '../../engine/state'
import { formatNumber, formatInt, formatTime } from '../../engine/format'
import { WORLD_EVENTS_BY_ID } from '../../content/events'
import { watchtowerBuilt } from '../../systems/events'
import type { UiCtx, Panel } from '../types'
import { h, resourceIcon, eventIcon, emptyState, helpTip, RESOURCE_NAMES } from '../dom'

/**
 * Events panel — the „Wydarzenia" tab (M13): the time-limited world-event OFFERS that liven up
 * the idle loop. Gated by the manually-built Wieża strażnicza (watchtower); without one the
 * mechanic is dormant (the panel says so and offers nothing) — mirroring the engine's identity
 * gate (systems/events.advanceEvents early-returns with no watchtower).
 *
 * Owns three mutually-exclusive offer states, built ONCE and toggled by `hidden`:
 *  - GATE: no watchtower → an empty state pointing at the building to construct.
 *  - IDLE: a watchtower, no live offer → a calm „wieża wypatruje" line + the ETA to the next offer.
 *  - OFFER: a live offer → its icon / name / description, a KIND-aware preview (windfall: the
 *    per-resource grant; buff (M14): what it boosts + its duration), the TTL countdown and an
 *    „Odbierz" button that claims it.
 * Above sits a lifetime „odebrane wydarzenia" counter (always visible) and — only while a timed
 * buff is in force — an ACTIVE-BUFF indicator (name + effect + a live „pozostało" countdown).
 *
 * Discipline (panel contract): the static chrome is built ONCE; {@link Panel.update} only pokes
 * textContent / attributes onto existing nodes. The offer's identity (defId + roll) gates the
 * rebuild of the icon/name/desc/preview so a steady tick (which only ticks the TTL down) does no
 * per-resource work — only the countdown text is re-poked each frame. The active buff's identity
 * (defId) likewise gates its icon/name/effect rebuild + the aria-live announcement, so a buff
 * merely burning down re-pokes only its „pozostało" countdown.
 *
 * Accessibility: „Odbierz" uses aria-disabled (not the hard `disabled` property) so it stays
 * focusable/hoverable and its reason reaches the user; an aria-live status announces a fresh offer
 * arriving, the claim result, and the buff turning ON/OFF — the latter through that same polite
 * status line because a hidden region cannot announce its own disappearance; the live buff
 * countdown stays OUT of the live region so it never spams the screen reader. The TTL urgency is
 * carried in WORDS + a class, never colour alone.
 *
 * Announcements fire only for transitions OBSERVED WHILE VISIBLE: update() does not run off-tab,
 * so the offer/buff transition closures (`hadOffer`, `lastBuffId`) go stale while another tab is
 * open. {@link Panel.onShow} marks a (re)entry and the first update() after it SILENTLY re-baselines
 * those closures to the current state — so a buff that expired (or an offer that changed) minutes
 * ago off-tab is never announced as if it just happened. A hidden aria-live region would not
 * announce anyway, so nothing real is lost; only the false „just now" is suppressed.
 */

/** Seconds of TTL at/under which the offer is flagged as „wygasa wkrótce" (a fifth of the window). */
const TTL_URGENT = EVENT_TTL / 5

/**
 * Human-readable PL summary of a buff's effect, built from the DATA (its Partial<TechModifiers>)
 * — so adding or rebalancing a buff in content/events.ts updates this text automatically, with no
 * per-buff strings to maintain here. The >= 1 MULTIPLIERS (attack/loot/defence/storage/pop/
 * production) read as a „+N%" bonus over 1; the [0, cap] FRACTIONS (march/recruit/cost) as a
 * „-N%" reduction. v1 buffs touch only the three in-flight axes (attack / loot / march); the other
 * branches are forward-compat for later buff content. Pure; rounds to whole percent for display.
 */
function describeBuffMods(mods: Partial<TechModifiers>): string {
  const parts: string[] = []
  // A multiplier (e.g. 1.6) as a percentage bonus over the neutral 1.
  const up = (mult: number, label: string): void => {
    parts.push('+' + String(Math.round((mult - 1) * 100)) + '% ' + label)
  }
  // A reduction fraction (e.g. 0.35) as a „-N%" cut.
  const down = (frac: number, label: string): void => {
    parts.push('-' + String(Math.round(frac * 100)) + '% ' + label)
  }
  if (mods.attackMult !== undefined) up(mods.attackMult, 'siły ataku')
  if (mods.lootMult !== undefined) up(mods.lootMult, 'łupu')
  if (mods.defenseMult !== undefined) up(mods.defenseMult, 'obrony')
  if (mods.storageMult !== undefined) up(mods.storageMult, 'pojemności magazynu')
  if (mods.popMult !== undefined) up(mods.popMult, 'populacji')
  if (mods.marchSpeedFrac !== undefined) down(mods.marchSpeedFrac, 'czasu marszu')
  if (mods.recruitSpeedFrac !== undefined) down(mods.recruitSpeedFrac, 'czasu rekrutacji')
  if (mods.costReduction !== undefined) down(mods.costReduction, 'kosztów budowy')
  if (mods.productionMult) {
    for (const id of RESOURCE_IDS) {
      const m = mods.productionMult[id]
      if (m !== undefined && m !== 1) up(m, 'produkcji (' + RESOURCE_NAMES[id].toLowerCase() + ')')
    }
  }
  return parts.length > 0 ? parts.join(', ') : 'brak efektu'
}

export function createEventsPanel(ctx: UiCtx): Panel {
  // No outer .panel frame: a column of sections directly on the page background, like the
  // other tabs (campaign/reports/army) for consistent framing.
  const el = h('div', 'events-panel')

  // ---- Intro + lifetime counter -------------------------------------------
  const intro = h(
    'p',
    'muted',
    'Wieża strażnicza wypatruje wydarzeń w świecie. Co jakiś czas pojawia się ograniczona w czasie ' +
      'oferta — odbierz ją, zanim wygaśnie. Część to jednorazowy zastrzyk surowców do stolicy, ' +
      'część to czasowy buff wzmacniający twoje wojska na krótki czas.',
  )
  intro.style.fontSize = 'var(--text-sm)'
  intro.appendChild(
    helpTip(
      'Oferty pojawiają się tylko, gdy masz Wieżę strażniczą. Windfall trafia do stolicy i jest ' +
        'przycinany do pojemności magazynu (nadmiar przepada), więc warto mieć miejsce w spichlerzu. ' +
        'Buff działa globalnie przez podany czas — nowy buff zastępuje poprzedni (jeden aktywny naraz).',
      { label: 'Jak działają wydarzenia' },
    ),
  )
  el.appendChild(intro)

  const lifetimeLine = h('p', 'horde-line muted')
  lifetimeLine.appendChild(document.createTextNode('Odebrane wydarzenia: '))
  const lifetimeVal = h('span', 'num')
  lifetimeLine.appendChild(lifetimeVal)
  el.appendChild(lifetimeLine)

  // ---- Active buff indicator (M14) ----------------------------------------
  // Shown ONLY while a timed buff is in force (state.events.buff != null). Holds the buff name,
  // what it boosts (derived from its mods) and a live „pozostało" countdown. Built ONCE and
  // toggled by `hidden`; only the countdown text is re-poked each frame. It carries NO aria-live
  // itself — its countdown would otherwise announce every second, and a hidden region cannot
  // announce its own disappearance; the buff turning on/off rides the always-present `status`
  // line below (change-gated by the buff identity), so the revert is announced once on expiry.
  const buffBox = h('div', 'event-active-buff target')
  const buffHead = h('div', 'target-head')
  // Decorative procedural SVG (eventIcon, never emoji); the name beside it carries the label.
  const buffIcon = h('span', 'event-icon')
  buffIcon.setAttribute('aria-hidden', 'true')
  const buffName = h('span', 'target-name')
  buffHead.appendChild(buffIcon)
  buffHead.appendChild(buffName)
  buffBox.appendChild(buffHead)
  const buffEffect = h('p', 'target-stats')
  buffBox.appendChild(buffEffect)
  const buffRemLine = h('p', 'horde-line')
  buffRemLine.appendChild(document.createTextNode('Pozostało: '))
  const buffRemVal = h('span', 'num')
  buffRemLine.appendChild(buffRemVal)
  buffBox.appendChild(buffRemLine)
  el.appendChild(buffBox)

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

  // Windfall preview: one row per resource (icon + amount). Built once; pokeOffer fills it.
  // The heading is a captured ref so the whole windfall block can be hidden for a buff offer.
  const grantHead = h('p', 'muted', 'Nagroda (do limitu magazynu stolicy):')
  offerBox.appendChild(grantHead)
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

  // Buff preview (M14): a `kind: 'buff'` offer grants a TIMED modifier, not a resource cache —
  // so the windfall block above is hidden and this one shows WHAT it boosts (derived from the
  // def's mods) and for HOW LONG. Built once; pokeOffer toggles the two blocks by kind.
  const buffPreview = h('div', 'event-buff-preview')
  buffPreview.appendChild(h('p', 'muted', 'Czasowy buff:'))
  const buffPreviewEffect = h('p', 'target-stats')
  buffPreview.appendChild(buffPreviewEffect)
  const buffPreviewDur = h('p', 'horde-line muted')
  buffPreviewDur.appendChild(document.createTextNode('Czas trwania: '))
  const buffPreviewDurVal = h('span', 'num')
  buffPreviewDur.appendChild(buffPreviewDurVal)
  buffPreview.appendChild(buffPreviewDur)
  offerBox.appendChild(buffPreview)

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
  // Focus target after a claim: claiming HIDES the offer (and its just-pressed button), which
  // would drop keyboard/SR focus to <body> (WCAG 2.4.3). tabIndex -1 lets us land focus on the
  // always-visible result line instead, so focus order survives the offer vanishing.
  status.tabIndex = -1
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
    if (!ok) {
      status.textContent = 'Nie udało się odebrać oferty.'
    } else if (def && def.kind === 'windfall') {
      status.textContent = 'Odebrano: ' + def.name + '. Surowce trafiły do stolicy.'
    }
    // A successful BUFF claim's announcement is owned by update() (the buff-identity transition),
    // so the message stays in sync with the active-buff indicator — nothing set here for a buff.
    update()
    // Keep focus inside the panel after the offer (and its button) is hidden by update().
    if (ok) status.focus()
  })

  // ---- Reactivity ----------------------------------------------------------
  let lastLifetime = -1
  // Offer identity (defId + roll) gates the heavy rebuild of icon/name/desc/preview; a plain
  // tick (TTL counting down) only re-pokes the countdown text. '' = no live offer last frame.
  let lastOfferKey = ''
  // Whether an offer was on the table last frame, so a fresh arrival can be announced once
  // (and not re-announced every frame while it sits unclaimed).
  let hadOffer = false
  // The active buff's defId last frame (null = none). Gates the buff indicator's heavy rebuild
  // (icon/name/effect) AND the single aria-live announcement on the buff turning on / off /
  // swapping — a buff merely burning down its „pozostało" countdown re-pokes only that text.
  let lastBuffId: string | null = null
  // Set by onShow on (re)entry: the NEXT update() re-baselines the transition closures above
  // (hadOffer/lastBuffId) WITHOUT announcing, so an off-tab change isn't read out as „just now".
  let justShown = false

  /**
   * Fill the offer preview from the offer's def + roll, BRANCHING by kind (M14): a windfall shows
   * its per-resource grant against the capital's storage cap; a buff shows what it boosts (derived
   * from its mods) + its duration. The OPPOSITE kind's block is hidden so the card never shows
   * stale rows. Called only when the offer identity changes (heavy work is identity-gated).
   */
  const pokeOffer = (defId: string, roll: number): void => {
    const def = WORLD_EVENTS_BY_ID[defId]
    const gs = ctx.store.state
    const capital = gs.villages[gs.villageOrder[0]]
    offerIcon.replaceChildren(eventIcon(defId, def ? def.name : 'Wydarzenie'))
    offerName.textContent = def ? def.name : 'Wydarzenie'
    offerDesc.textContent = def ? def.desc : ''
    const isBuff = def !== undefined && def.kind === 'buff'
    // Toggle the two mutually-exclusive previews by kind (windfall rows vs. buff effect+duration).
    grantHead.hidden = isBuff
    grantList.hidden = isBuff
    buffPreview.hidden = !isBuff
    if (def && def.kind === 'windfall') {
      const grant = def.grant(roll, capital.storageCap)
      for (const id of RESOURCE_IDS) grantVals[id].textContent = formatNumber(grant[id])
    } else if (def && def.kind === 'buff') {
      buffPreviewEffect.textContent = describeBuffMods(def.mods)
      buffPreviewDurVal.textContent = formatTime(def.duration)
    }
  }

  const update = (): void => {
    const gs = ctx.store.state
    const ev = gs.events
    const built = watchtowerBuilt(gs)

    // First update() after a (re)entry: re-baseline the transition closures below WITHOUT
    // announcing. update() does not run off-tab, so `hadOffer`/`lastBuffId` reflect the state
    // from when we LAST left this tab; on return we still do all the DOM poking (so the card +
    // indicator show the current state) but suppress the aria-live writes, which would otherwise
    // read out an off-tab change (e.g. a buff that expired minutes ago) as if it just happened.
    const silent = justShown
    justShown = false

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
        pokeOffer(active.defId, active.roll)
      }
      // Announce a freshly arrived offer exactly once (not while it sits unclaimed, and not on a
      // silent re-entry where the offer may have arrived off-tab — see `silent` above).
      if (!hadOffer && !silent) {
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

    // Active buff indicator (M14). Without a watchtower ev.buff is always null (the engine gate),
    // so this naturally stays hidden — no extra `built` check needed. The heavy rebuild + the
    // aria-live announcement fire only on a buff IDENTITY change (claim / swap); a buff merely
    // burning down re-pokes only the countdown. On expiry (buff → null) we announce the revert
    // once through the always-present `status` line, then mute (the indicator hides itself).
    const buff = ev.buff
    if (buff !== null) {
      if (buff.defId !== lastBuffId) {
        lastBuffId = buff.defId
        const bdef = WORLD_EVENTS_BY_ID[buff.defId]
        const bname = bdef ? bdef.name : 'Wzmocnienie'
        const effect = bdef && bdef.kind === 'buff' ? describeBuffMods(bdef.mods) : ''
        buffIcon.replaceChildren(eventIcon(buff.defId, bname))
        buffName.textContent = bname
        buffEffect.textContent = effect
        // DOM rebuild always runs (the indicator must show the current buff); the announcement is
        // suppressed on a silent re-entry — the buff may have started off-tab minutes ago.
        if (!silent) status.textContent = 'Buff aktywny: ' + bname + (effect ? ' — ' + effect : '') + '.'
      }
      // Live countdown (re-poked every frame; kept OUT of the aria-live region to avoid spam).
      buffRemVal.textContent = formatTime(Math.max(0, buff.remaining))
      buffBox.hidden = false
    } else {
      if (lastBuffId !== null) {
        lastBuffId = null
        // Suppress on a silent re-entry: the buff may have expired off-tab a long time ago, so
        // announcing „minęło" now would mis-report a stale transient as if it just lapsed.
        if (!silent) status.textContent = 'Buff wygasł — wzmocnienie minęło.'
      }
      buffBox.hidden = true
    }
  }

  // Mark a (re)entry so the next update() re-baselines the transition closures silently (see
  // `silent` in update()). The shell calls this right before the first update() after this tab
  // becomes active — not on the steady per-frame path — so it fires once per (re)entry.
  const onShow = (): void => {
    justShown = true
  }

  return { el, update, onShow }
}
