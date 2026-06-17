import { effect } from '../engine/store'
import type { GameState } from '../engine/state'
import type { UiCtx } from './types'
import { h, svg, svgIcon, shieldIcon, unitIcon, buildingIcon } from './dom'

/**
 * TW Incremental — TOASTY CELEBRACYJNE (M11.6)
 * --------------------------------------------------------------------------
 * Warstwa CZYSTO prezentacyjna: gdy w grze dzieje się coś WIELKIEGO (podbicie
 * wioski, ascensja, nowa era/dynastia, zburzona forteca, ukończone wyzwanie,
 * odparta horda) — wyświetlamy ulotną, gustowną kartkę-gratulację w rogu ekranu,
 * która sama gaśnie po kilku sekundach.
 *
 * KLUCZOWA ZASADA (jak puls „nowy raport" z M11.3, layout.ts:469-503): NIE
 * dodajemy żadnych zdarzeń do silnika ani stanu gry. Liczniki kamieni milowych
 * JUŻ żyją w stanie (`state.stats.*`, `state.prestige.ascensions`, …) i rosną
 * WYŁĄCZNIE deterministyczną ścieżką ticka/systemów. Watcher UI cache'uje każdy
 * licznik i — gdy URÓŚNIE — pokazuje pasujący toast. Wykrywanie jest READ-ONLY.
 *
 * Twarde ograniczenia, których pilnujemy tutaj:
 *  - #2 zero zewnętrznych assetów: glify to proceduralne inline-SVG (helpery z
 *    dom.ts: unitIcon/buildingIcon/shieldIcon + lokalne starGlyph/sunGlyph/
 *    crownGlyph/laurelGlyph rysowane przez svg()/svgIcon()). Reszta to CSS.
 *  - #3 nie psujemy zapisów: kolejka toastów to ULOTNA pamięć UI (zmienne
 *    modułu) — NIGDY nie trafia do stanu/serializacji.
 *  - #5 determinizm: brak Math.random/Date.now w logice gry; setTimeout steruje
 *    TYLKO czasem znikania toasta (to nie jest stan gry — dozwolone w UI).
 *  - #6 wydajność: per-klatkę robimy garść tanich porównań intów względem cache;
 *    DOM budujemy tylko na rzeczywisty wzrost licznika. Zero alokacji w spoczynku.
 *  - #7 dostępność: kontener to ARIA live region (role=status, aria-live=polite),
 *    treść niesie REALNY tekst (glif jest aria-hidden, czysta dekoracja), toasty
 *    nie łapią fokusu i nie blokują UI (pointer-events tylko na samej karcie),
 *    znikają same + mają przycisk „Zamknij", a animacje gasną w
 *    @media (prefers-reduced-motion: reduce) (CSS).
 */

/** Akcent tonalny karty toasta (klasa CSS `.toast--<tone>`). */
export type ToastTone = 'victory' | 'celebrate' | 'meta'

/** Opcje pojedynczego toasta. `glyph` to gotowy proceduralny SVG (dekoracja). */
export interface ToastOptions {
  /** Inline proceduralny SVG; manager nada mu aria-hidden=true (czysta dekoracja). */
  glyph: SVGElement
  /** Realny tekst nagłówka (czyta go aria-live). */
  title: string
  /** Realny tekst opisu. */
  message: string
  /** Akcent tonalny; domyślnie 'celebrate'. */
  tone?: ToastTone
}

// ---- Strojenie zachowania (UI-only, nie stan gry) --------------------------

/** Ile toastów naraz na stosie; najstarszy spada przy przekroczeniu (zasada #7). */
const STACK_CAP = 3
/** Czas życia toasta zanim sam zgaśnie (ms). Pauzowany na hover. */
const LIFETIME_MS = 4500
/** Czas trwania animacji wyjścia (ms) — po nim usuwamy węzeł z DOM. Zgrane z toast.css. */
const EXIT_MS = 340

// ---- Ulotny stan modułu (NIGDY nie serializowany) --------------------------

/** Uchwyt do żywego toasta — pozwala managerowi zrzucić najstarszy przy capie. */
interface ToastHandle {
  el: HTMLElement
  dismiss: () => void
}

/** Kontener live-region; tworzony leniwie (ensureRegion) i trzymany na czas sesji. */
let region: HTMLElement | null = null
/** Aktualnie widoczne toasty w kolejności wstawienia (index 0 = najstarszy). */
const live: ToastHandle[] = []

/**
 * Leniwie zapewnia istnienie kontenera live-region przyczepionego do <body>
 * (fixed-position róg, POZA przepływem zakładek #app, więc nie zasłania treści).
 * mountToasts woła to przy starcie; showToast również — gdyby wywołano je przed
 * montażem, region i tak powstanie.
 */
function ensureRegion(): HTMLElement {
  if (region && region.isConnected) return region
  const r = h('div', 'toast-region')
  // ARIA live region: nowy toast jest OGŁASZANY przez technologię asystującą.
  // role=status implikuje aria-live=polite, ale ustawiamy oba jawnie dla pewności.
  r.setAttribute('role', 'status')
  r.setAttribute('aria-live', 'polite')
  // Czytaj tylko świeżo dodaną kartę, nie cały (zmieniający się) stos.
  r.setAttribute('aria-atomic', 'false')
  document.body.appendChild(r)
  region = r
  return r
}

/**
 * Wrzuca toast do rogu ekranu: animacja wejścia, auto-dismiss ~4.5s (pauza na
 * hover), stos z capem {@link STACK_CAP} (najstarszy spada), przycisk „Zamknij".
 * Bez stanu gry — cała pamięć żyje w {@link live} (zmienna modułu).
 */
export function showToast(opts: ToastOptions): void {
  const root = ensureRegion()
  const tone: ToastTone = opts.tone ?? 'celebrate'

  // ---- Budowa karty (raz, na zdarzenie wzrostu licznika — nie per-klatkę) ----
  const card = h('div', 'toast toast--' + tone)

  // Glif: czysta DEKORACJA — wymuszamy aria-hidden, by AT go pominęła (treść
  // niosą realne teksty obok; ruch/obraz nigdy nie jest jedynym nośnikiem — #7).
  const glyphWrap = h('span', 'toast-glyph')
  glyphWrap.setAttribute('aria-hidden', 'true')
  opts.glyph.setAttribute('aria-hidden', 'true')
  glyphWrap.appendChild(opts.glyph)

  // Treść: realny nagłówek + opis (to JE czyta aria-live=polite).
  const body = h('div', 'toast-text')
  body.appendChild(h('p', 'toast-title', opts.title))
  body.appendChild(h('p', 'toast-message', opts.message))

  // Ręczne zamknięcie — afordancja dostępności (poza auto-dismiss i cap-drop).
  const close = h('button', 'toast-dismiss')
  close.type = 'button'
  close.setAttribute('aria-label', 'Zamknij')
  close.appendChild(closeGlyph())

  card.appendChild(glyphWrap)
  card.appendChild(body)
  card.appendChild(close)

  // ---- Cykl życia: timer auto-dismiss + pauza na hover + jednokrotne sprzątanie ----
  let timer: number | undefined
  let dismissed = false

  const dismiss = (): void => {
    if (dismissed) return // strażnik: cap-drop i auto-dismiss mogą zbiec się
    dismissed = true
    if (timer !== undefined) clearTimeout(timer)
    // Synchronicznie wyjmij z księgi żywych (cap liczy na natychmiastową długość).
    const idx = live.findIndex((t) => t.el === card)
    if (idx >= 0) live.splice(idx, 1)
    // Animacja wyjścia, potem usunięcie węzła. setTimeout (a nie animationend) jest
    // ODPORNE na reduced-motion: tam CSS zeruje animację, ale węzeł i tak zniknie.
    card.classList.add('toast--leaving')
    window.setTimeout(() => card.remove(), EXIT_MS)
  }

  const startTimer = (): void => {
    timer = window.setTimeout(dismiss, LIFETIME_MS)
  }

  close.addEventListener('click', dismiss)
  // Pauza na hover: zatrzymaj odliczanie, gdy gracz czyta; wznów po zjechaniu.
  card.addEventListener('mouseenter', () => {
    if (timer !== undefined) clearTimeout(timer)
  })
  card.addEventListener('mouseleave', startTimer)

  root.appendChild(card)
  live.push({ el: card, dismiss })
  startTimer()

  // Cap stosu: dopóki za dużo, zrzucaj NAJSTARSZY (index 0). dismiss() splice'uje
  // się synchronicznie, więc długość maleje co iterację — brak pętli w nieskończoność.
  while (live.length > STACK_CAP) {
    live[0].dismiss()
  }
}

/**
 * Tworzy kontener (role=status, aria-live=polite) i URUCHAMIA watcher stanu:
 * cache-and-compare liczników kamieni milowych przez `effect(store.rev)`.
 * Zwraca disposer effectu (dla symetrii — sesja go nie woła).
 *
 * Sedno braku „fałszywych" toastów po WCZYTANIU zapisu: cache jest zasiany z
 * BIEŻĄCEGO stanu PRZED utworzeniem effectu. effect() odpala fn raz synchronicznie
 * przy tworzeniu — wtedy cur === prev dla każdego licznika → NIC się nie pokazuje.
 * Toasty lecą dopiero przy realnym wzroście w trakcie gry. Spadek licznika (np.
 * import innego zapisu albo per-run reset) tylko CICHO re-bazuje cache (bez toasta).
 */
export function mountToasts(ctx: UiCtx): () => void {
  ensureRegion()

  // Deklaratywna lista kamieni milowych: każdy umie ODCZYTAĆ swój licznik ze stanu
  // (read) i ZBUDOWAĆ świeży toast (toast). Dodanie kolejnego kamienia = jeden wpis.
  const milestones: { read: (s: GameState) => number; toast: () => ToastOptions }[] = [
    {
      // Podbity barbarzyńca → korona Szlachcica = przejęcie władzy nad wioską.
      read: (s) => s.stats.villagesConquered,
      toast: () => ({
        glyph: unitIcon('noble'),
        title: 'Podbito wioskę!',
        message: 'Wioska barbarzyńców trafiła pod twoje sztandary.',
        tone: 'victory',
      }),
    },
    {
      // Nowa osada → Ratusz (hq) = nowa siedziba plemienia.
      read: (s) => s.stats.villagesFounded,
      toast: () => ({
        glyph: buildingIcon('hq'),
        title: 'Nowa wioska założona!',
        message: 'Twoje plemię rozrasta się o świeżą osadę.',
        tone: 'celebrate',
      }),
    },
    {
      // Forteca → Katapulta = oblężenie, mury legły w gruzach.
      read: (s) => s.stats.fortressesRazed,
      toast: () => ({
        glyph: unitIcon('catapult'),
        title: 'Forteca zburzona!',
        message: 'Mury fortecy legły w gruzach.',
        tone: 'victory',
      }),
    },
    {
      // Horda → Tarcza plemienna = obrona utrzymana.
      read: (s) => s.stats.hordesRepelled,
      toast: () => ({
        glyph: shieldIcon(),
        title: 'Horda odparta!',
        message: 'Stolica wytrzymała natarcie hordy.',
        tone: 'victory',
      }),
    },
    {
      // Ascensja → proceduralna gwiazda (meta-warstwa prestiżu).
      read: (s) => s.prestige.ascensions,
      toast: () => ({
        glyph: starGlyph(),
        title: 'Ascensja!',
        message: 'Nowy run zaczyna się z banku prestiżu.',
        tone: 'meta',
      }),
    },
    {
      // Era → proceduralny sunburst (wielki reset otwiera nową erę).
      read: (s) => s.era.eras,
      toast: () => ({
        glyph: sunGlyph(),
        title: 'Nowa Era!',
        message: 'Wielki reset otwiera kolejną erę.',
        tone: 'meta',
      }),
    },
    {
      // Dynastia → proceduralna korona (twój ród zakłada nową dynastię).
      read: (s) => s.dynasty.dynasties,
      toast: () => ({
        glyph: crownGlyph(),
        title: 'Nowa Dynastia!',
        message: 'Twój ród zakłada nową dynastię.',
        tone: 'meta',
      }),
    },
    {
      // Wyzwanie → proceduralny wieniec laurowy. Licznik to SUMA wartości
      // completed (Record<string,number>): rośnie przy każdym ukończeniu/powtórce.
      read: (s) => sumValues(s.challenge.completed),
      toast: () => ({
        glyph: laurelGlyph(),
        title: 'Wyzwanie ukończone!',
        message: 'Cel wyzwania osiągnięty — nagroda przyznana.',
        tone: 'meta',
      }),
    },
  ]

  // Zasiej cache z BIEŻĄCEGO stanu PRZED stworzeniem effectu (patrz docstring):
  // pierwszy przebieg effectu porówna równo → wczytany zapis nie odpala niczego.
  const cache = milestones.map((m) => m.read(ctx.store.state))

  const dispose = effect(() => {
    // Subskrypcja jak puls raportów (layout.ts:480): odczyt store.rev.value w
    // effekcie wiąże nas z każdą rewizją stanu (tick/commit).
    void ctx.store.rev.value
    const s = ctx.store.state
    for (let i = 0; i < milestones.length; i++) {
      const cur = milestones[i].read(s)
      const prev = cache[i]
      // Tani compare intów. Toast TYLKO na wzrost; spadek (re-baseline po imporcie/
      // resecie) jest cichy. Jeden wzrost = jeden toast (nie spamujemy N kart, gdy
      // licznik skoczył o więcej, np. po offline catch-upie) — spokojnie i gustownie.
      if (cur > prev) showToast(milestones[i].toast())
      cache[i] = cur // re-baseline zawsze (wzrost i spadek)
    }
  })

  return dispose
}

/** Suma wartości rzadkiej mapy licznika (np. challenge.completed). */
function sumValues(rec: Record<string, number>): number {
  let total = 0
  for (const k in rec) total += rec[k]
  return total
}

// ============================================================================
// Lokalne, proceduralne glify — rysowane wyłącznie kodem (twarda zasada #2).
// Wszystkie malują się w `currentColor`, więc toast.css barwi je akcentem tonu.
// Każdy dostaje aria-hidden dopiero w showToast (jednolicie z glifami z dom.ts).
// ============================================================================

/**
 * Gwiazda pięcioramienna (Ascensja) — pełny, wyrazisty kształt „awansu/rangi".
 * Wierzchołki policzone na okręgach R=9 / r=3.8 wokół (12,12), start u góry.
 */
function starGlyph(): SVGSVGElement {
  const star = svg('path', {
    d: 'M12 3 L14.23 8.93 L20.56 9.22 L15.61 13.17 L17.29 19.28 L12 15.8 L6.71 19.28 L8.39 13.17 L3.44 9.22 L9.77 8.93 Z',
    fill: 'currentColor',
  })
  return svgIcon('0 0 24 24', 'Ascensja', 'toast-glyph-svg', [star])
}

/**
 * Sunburst (Nowa Era) — tarcza słońca z ośmioma promieniami: „wschód nowej ery".
 * Promienie to obrys (stroke currentColor), środek to pełne koło.
 */
function sunGlyph(): SVGSVGElement {
  const core = svg('circle', { cx: '12', cy: '12', r: '4', fill: 'currentColor' })
  const ray = (x1: string, y1: string, x2: string, y2: string): SVGElement =>
    svg('line', {
      x1,
      y1,
      x2,
      y2,
      stroke: 'currentColor',
      'stroke-width': '1.8',
      'stroke-linecap': 'round',
    })
  return svgIcon('0 0 24 24', 'Nowa Era', 'toast-glyph-svg', [
    core,
    ray('21', '12', '18', '12'),
    ray('18.36', '18.36', '16.24', '16.24'),
    ray('12', '21', '12', '18'),
    ray('5.64', '18.36', '7.76', '16.24'),
    ray('3', '12', '6', '12'),
    ray('5.64', '5.64', '7.76', '7.76'),
    ray('12', '3', '12', '6'),
    ray('18.36', '5.64', '16.24', '7.76'),
  ])
}

/**
 * Korona o trzech wieżyczkach (Nowa Dynastia) — „ród zakłada dynastię". Pełny
 * korpus + przepaska u dołu (rowek przez nakładkę --bg) + zaokrąglone gałki na
 * szczytach wieżyczek (te same currentColor, wydłużają sylwetkę jak klejnoty).
 */
function crownGlyph(): SVGSVGElement {
  const bodyPath = svg('path', {
    d: 'M4 18 L4 9 L8.5 12.5 L12 6 L15.5 12.5 L20 9 L20 18 Z',
    fill: 'currentColor',
  })
  const band = svg('rect', { x: '4', y: '17.5', width: '16', height: '3', rx: '0.6', fill: 'currentColor' })
  // Rowek na przepasce — ciemna nakładka z tła (jak band w shieldIcon).
  const groove = svg('rect', { x: '4', y: '18.6', width: '16', height: '0.9', 'fill-opacity': '0.3' })
  groove.style.fill = 'var(--bg)'
  const finial = (cx: string, cy: string): SVGElement =>
    svg('circle', { cx, cy, r: '1.15', fill: 'currentColor' })
  return svgIcon('0 0 24 24', 'Nowa Dynastia', 'toast-glyph-svg', [
    bodyPath,
    band,
    groove,
    finial('4', '9'),
    finial('12', '6'),
    finial('20', '9'),
  ])
}

/**
 * Wieniec laurowy (Wyzwanie ukończone) — dwa symetryczne pędy obrysu + listki
 * (elipsy obrócone na zewnątrz) i kokarda u dołu. Klasyczny znak „nagrody/triumfu".
 */
function laurelGlyph(): SVGSVGElement {
  const stem = (d: string): SVGElement =>
    svg('path', {
      d,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.6',
      'stroke-linecap': 'round',
    })
  // Listek: mała elipsa obrócona wokół własnego środka, by „odchodziła" od pędu.
  const leaf = (cx: number, cy: number, deg: number): SVGElement =>
    svg('ellipse', {
      cx: String(cx),
      cy: String(cy),
      rx: '1.7',
      ry: '0.9',
      fill: 'currentColor',
      transform: 'rotate(' + deg + ' ' + cx + ' ' + cy + ')',
    })
  const tie = svg('circle', { cx: '12', cy: '20.5', r: '1.1', fill: 'currentColor' })
  return svgIcon('0 0 24 24', 'Wyzwanie ukończone', 'toast-glyph-svg', [
    // Lewy pęd: od kokardy u dołu, łukiem w górę-lewo.
    stem('M12 20 C5.5 18.5 4.5 11.5 7.5 5.5'),
    // Prawy pęd: lustrzane odbicie.
    stem('M12 20 C18.5 18.5 19.5 11.5 16.5 5.5'),
    leaf(6.6, 14.5, -50),
    leaf(5.6, 10.5, -35),
    leaf(6.4, 7, -20),
    leaf(17.4, 14.5, 50),
    leaf(18.4, 10.5, 35),
    leaf(17.6, 7, 20),
    tie,
  ])
}

/** Krzyżyk „zamknij" — czysta dekoracja (przycisk niesie aria-label „Zamknij"). */
function closeGlyph(): SVGSVGElement {
  const stroke = { stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' }
  const a = svg('line', { x1: '4', y1: '4', x2: '12', y2: '12', ...stroke })
  const b = svg('line', { x1: '12', y1: '4', x2: '4', y2: '12', ...stroke })
  const root = svgIcon('0 0 16 16', 'Zamknij', 'toast-close-svg', [a, b])
  root.setAttribute('aria-hidden', 'true')
  return root
}
