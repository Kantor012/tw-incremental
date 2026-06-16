import { svg, svgIcon } from './dom'

/**
 * Proceduralny herb wioski (heraldyczna tarcza) rysowany w całości w SVG.
 *
 * Cały herb jest CZYSTĄ, DETERMINISTYCZNĄ funkcją ziarna (`seed`): te same dane
 * wejściowe zawsze dają identyczny obrazek. Nie używamy tu `Date.now()` ani
 * `Math.random()` — losowość pochodzi wyłącznie z haszowania `seed` (patrz
 * {@link hashSeed}). Dzięki temu:
 *   - ta sama wioska (jej `Village.id`, typu `VillageId`, stabilny ciąg w stylu
 *     `'v0'`/`'v1'` z `src/engine/state.ts`) ma zawsze ten sam herb, również po
 *     przeładowaniu strony i wczytaniu zapisu,
 *   - testy są powtarzalne (brak źródeł niedeterminizmu).
 *
 * Herb nie dotyka stanu gry — to czysta warstwa prezentacji (zero migracji,
 * zero nowych pól w save). Korzysta jedynie z proceduralnego zestawu SVG z
 * `dom.ts` (`svg`/`svgIcon`), więc twarda zasada „zero zewnętrznych assetów"
 * obowiązuje tak samo jak dla ikon jednostek i surowców.
 */

/** Język kształtu tarczy współdzielony z {@link shieldIcon} (viewBox 0 0 48 48). */
const SHIELD_PATH = 'M24 3 7 9v13c0 11 8 17 17 21 9-4 17-10 17-21V9z'

/**
 * Średniowieczna paleta heraldycznych barw (tinktur) jako wpisany na sztywno hex.
 * Kolejność jest stabilna — indeksy wybierane z hasza muszą wskazywać zawsze ten
 * sam kolor, więc NIE wolno przestawiać ani usuwać wpisów bez świadomości, że
 * zmienia to wygląd wszystkich istniejących herbów. Trzy „metale" (or, argent)
 * i barwy (gules/azure/sable/vert) dają czytelny, klasyczny kontrast.
 */
const TINCTURES: readonly string[] = [
  '#9e2b2b', // gules  — czerwień
  '#2e5d8c', // azure  — błękit
  '#383028', // sable  — czerń (lekko podniesiona, by nie zlewała się z ciemną kartą)
  '#d9a441', // or     — złoto (metal)
  '#d9dde2', // argent — srebro (metal)
  '#3f7a4a', // vert   — zieleń
]

/**
 * Paleta barwy figury (charge). Metale (złoto, srebro) celowo stoją na początku:
 * gdy OBIE barwy pola są ciemnymi barwami (nie-metale), skan barwy figury startuje
 * właśnie od metali, więc figura jest gwarantowanie jasna na ciemnym polu
 * (heraldyczne „metal na barwie"). W pozostałych wypadkach skan rusza z przesunięcia
 * hasza, co daje większą różnorodność. Tak czy inaczej bierzemy pierwszą barwę różną
 * od obu barw pola — figura zawsze odcina się od tła. Kolejność jest stabilna: nie
 * wolno jej przestawiać bez świadomości, że zmienia wygląd istniejących herbów.
 */
const CHARGE_PALETTE: readonly string[] = [
  '#d9a441', // or     (metal)
  '#d9dde2', // argent (metal)
  '#383028', // sable
  '#9e2b2b', // gules
  '#2e5d8c', // azure
  '#3f7a4a', // vert
]

type Division = 'pale' | 'fess' | 'quarterly' | 'plain'
type Charge = 'sword' | 'tower' | 'star' | 'chevron' | 'boar'

const DIVISIONS: readonly Division[] = ['pale', 'fess', 'quarterly', 'plain']
const CHARGES: readonly Charge[] = ['sword', 'tower', 'star', 'chevron', 'boar']

/**
 * Czysty 32-bitowy hasz ciągu (wariant FNV-1a). Bierze `String(seed)`, miesza
 * znak po znaku i zwraca uint32. Brak `Date.now()`/`Math.random()` — wynik jest
 * w pełni zdeterminowany przez `seed`, więc każda decyzja wizualna (podział,
 * tinktury, figura) jest powtarzalna. `Math.imul` daje poprawne mnożenie modulo
 * 2^32, a `>>> 0` rzutuje na liczbę bez znaku.
 */
function hashSeed(seed: string | number): number {
  const str = String(seed)
  let h = 0x811c9dc5 // 2166136261 — offset FNV
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) // 16777619 — pryma FNV
  }
  return h >>> 0
}

/**
 * Maluje wypełnienia pola tarczy zgodnie z podziałem heraldycznym. Bazą jest
 * zawsze pełna sylwetka tarczy w barwie A; barwę B nakładamy tylko na te
 * obszary, których ścieżki podążają za faktyczną krawędzią tarczy (proste boki
 * y 9→22 oraz dolny łuk), więc nigdy nie wystaje poza sylwetkę — nie potrzeba
 * `clipPath` (a tym samym żadnych identyfikatorów, które kolidowałyby przy
 * wielu herbach na jednej stronie).
 */
function divisionFills(div: Division, hexA: string, hexB: string): SVGElement[] {
  // Pole podstawowe: cała tarcza w barwie A.
  const field = svg('path', { d: SHIELD_PATH, fill: hexA })

  switch (div) {
    case 'pale': {
      // Słupowo: prawa połowa w barwie B (lustro lewej połowy z shieldIcon).
      const right = svg('path', { d: 'M24 3 41 9v13c0 11 -8 17 -17 21V3z', fill: hexB })
      return [field, right]
    }
    case 'fess': {
      // W pas: dół (cała tarcza) w barwie B, na to górny pięciokąt w barwie A.
      const base = svg('path', { d: SHIELD_PATH, fill: hexB })
      const top = svg('path', { d: 'M7 9 24 3 41 9 41 22 7 22Z', fill: hexA })
      return [base, top]
    }
    case 'quarterly': {
      // W czwór: A jako baza, B na prawej-górnej i lewej-dolnej ćwiartce.
      const topRight = svg('path', { d: 'M24 3 41 9 41 22 24 22Z', fill: hexB })
      const bottomLeft = svg('path', { d: 'M24 22 7 22c0 11 8 17 17 21V22Z', fill: hexB })
      return [field, topRight, bottomLeft]
    }
    case 'plain':
      // Jednolite pole — tylko barwa A.
      return [field]
    default: {
      const _exhaustive: never = div
      throw new Error('Nieznany podział herbu: ' + String(_exhaustive))
    }
  }
}

/**
 * Rysuje pojedynczą figurę (charge) wyśrodkowaną na tarczy, w jednej kontrastowej
 * tinkturze (heraldyczne godła są jednobarwne). Wszystkie współrzędne są dobrane
 * pod viewBox 0 0 48 48 i środek tarczy ~(24, 23), tak by figura czytała się
 * wyraźnie już przy ~24-40 px.
 */
function chargeShapes(charge: Charge, hex: string): SVGElement[] {
  switch (charge) {
    case 'sword': {
      // Miecz ostrzem w górę: klinga, jelec, rękojeść, głowica.
      const blade = svg('path', { d: 'M24 12 26 16 26 28 22 28 22 16Z', fill: hex })
      const guard = svg('rect', { x: '17.5', y: '27.5', width: '13', height: '2', rx: '0.5', fill: hex })
      const grip = svg('rect', { x: '23', y: '29.5', width: '2', height: '5', fill: hex })
      const pommel = svg('circle', { cx: '24', cy: '35', r: '1.6', fill: hex })
      return [blade, guard, grip, pommel]
    }
    case 'tower': {
      // Wieża z blankami: korpus + trzy merlony u góry (sylwetka zamkowa).
      const body = svg('rect', { x: '18.5', y: '19', width: '11', height: '15', rx: '0.5', fill: hex })
      const m1 = svg('rect', { x: '18.5', y: '15.5', width: '3', height: '3.5', fill: hex })
      const m2 = svg('rect', { x: '22.5', y: '15.5', width: '3', height: '3.5', fill: hex })
      const m3 = svg('rect', { x: '26.5', y: '15.5', width: '3', height: '3.5', fill: hex })
      return [body, m1, m2, m3]
    }
    case 'star': {
      // Gwiazda pięcioramienna (mullet) — punkty policzone wokół (24,23), R=9.
      const star = svg('path', {
        d:
          'M24 14 26.12 20.09 32.56 20.22 27.42 24.11 29.29 30.28 ' +
          '24 26.6 18.71 30.28 20.58 24.11 15.44 20.22 21.88 20.09Z',
        fill: hex,
      })
      return [star]
    }
    case 'chevron': {
      // Krokiew (chevron) — pas w kształcie odwróconego „V".
      const chev = svg('path', { d: 'M12 30 24 16 36 30 31 30 24 23 17 30Z', fill: hex })
      return [chev]
    }
    case 'boar': {
      // Dzik kroczący w lewo — sylwetka z brył: korpus, łeb, ucho, kieł, nogi, ogon.
      const body = svg('ellipse', { cx: '25', cy: '24', rx: '7', ry: '4.2', fill: hex })
      const head = svg('path', { d: 'M18 24 12 25.5 13.5 22.5 17 20.5 20 22Z', fill: hex })
      const ear = svg('path', { d: 'M17.5 21 18.5 17 20.5 21Z', fill: hex })
      const tusk = svg('path', { d: 'M12 25.5 10.5 26.5 12.8 25Z', fill: hex })
      const legA = svg('rect', { x: '18', y: '27.5', width: '1.8', height: '4', fill: hex })
      const legB = svg('rect', { x: '22', y: '28', width: '1.8', height: '4', fill: hex })
      const legC = svg('rect', { x: '27', y: '28', width: '1.8', height: '4', fill: hex })
      const legD = svg('rect', { x: '30.5', y: '27.5', width: '1.8', height: '4', fill: hex })
      const tail = svg('path', { d: 'M31.8 22.5 34 20.5 33 23.5Z', fill: hex })
      return [body, head, ear, tusk, legA, legB, legC, legD, tail]
    }
    default: {
      const _exhaustive: never = charge
      throw new Error('Nieznana figura herbu: ' + String(_exhaustive))
    }
  }
}

/**
 * Buduje proceduralny herb wioski jako etykietowaną, bezpieczną dla a11y ikonę
 * SVG (role=img + aria-label „Herb wioski").
 *
 * Z hasza ziarna dekodujemy rozłączne wycinki bitów — każdy steruje innym
 * aspektem, więc decyzje są niezależne, a całość deterministyczna:
 *   - bity 0-1  → PODZIAŁ tarczy (pale | fess | quarterly | plain),
 *   - bity 2-4  → pierwsza TINKTURA (barwa A),
 *   - bity 5-7  → druga TINKTURA (barwa B), z gwarancją różności od A,
 *   - bity 10-12 → FIGURA (sword | tower | star | chevron | boar),
 *   - bity 13+  → barwa FIGURY (różna od A i B → kontrast; gdy obie barwy pola są
 *     ciemne, wymuszamy metal, więc figura jest jasna na ciemnym polu).
 *
 * Kolejność rysowania: jasny obrys zewnętrzny → wypełnienia pola → figura → ciemny
 * obrys wewnętrzny. Jasny rąbek odcina tarczę od ciemnej karty niezależnie od barwy
 * pola, a ciemny kontur domyka i definiuje krawędź wewnętrzną.
 */
export function villageCrest(seed: string | number): SVGSVGElement {
  const hash = hashSeed(seed)

  // (a) Podział tarczy — niskie 2 bity.
  const div = DIVISIONS[hash & 0b11]

  // (b) Dwie różne tinktury pola z osobnych wycinków hasza. Wybór B w przestrzeni
  //     o jeden mniejszej + przesunięcie „>= a" gwarantuje, że B nigdy nie równa A.
  const a = (hash >>> 2) % TINCTURES.length
  let b = (hash >>> 5) % (TINCTURES.length - 1)
  if (b >= a) b++
  const hexA = TINCTURES[a]
  const hexB = TINCTURES[b]

  // (c) Figura i jej barwa. Klasyfikujemy pola na metale (złoto/srebro) i barwy.
  //     Gdy OBIE barwy pola są ciemne (nie-metale), skan barwy figury zaczynamy od
  //     metali (indeks 0/1 palety) — pierwszy kandydat to wtedy zawsze metal różny
  //     od obu pól, więc figura jest jasna na ciemnym polu („metal na barwie").
  //     W innym wypadku startujemy z przesunięcia hasza dla różnorodności. W obu
  //     wypadkach bierzemy pierwszą barwę różną od A i B — figura odcina się od tła.
  const charge = CHARGES[(hash >>> 10) % CHARGES.length]
  const isMetal = (hex: string): boolean => hex === '#d9a441' || hex === '#d9dde2'
  const bothColours = !isMetal(hexA) && !isMetal(hexB)
  const chargeStart = bothColours
    ? (hash >>> 13) & 1 // tylko metale: or (0) lub argent (1)
    : (hash >>> 13) % CHARGE_PALETTE.length
  let chargeHex = CHARGE_PALETTE[chargeStart]
  for (let i = 0; i < CHARGE_PALETTE.length; i++) {
    const cand = CHARGE_PALETTE[(chargeStart + i) % CHARGE_PALETTE.length]
    if (cand !== hexA && cand !== hexB) {
      chargeHex = cand
      break
    }
  }

  // Obrys tarczy w dwóch warstwach. Jasny obrys zewnętrzny (argent) idzie na SPÓD —
  // jego zewnętrzna połowa wystaje poza sylwetkę cienkim, jasnym rąbkiem, więc tarcza
  // odcina się od ciemnej karty niezależnie od barwy pola (także przy polu sable).
  const outerOutline = svg('path', {
    d: SHIELD_PATH,
    fill: 'none',
    stroke: '#d9dde2',
    'stroke-width': '2.6',
    'stroke-linejoin': 'round',
  })
  // Ciemny obrys wewnętrzny — rysowany na końcu, domyka krawędź i daje definicję.
  const innerOutline = svg('path', {
    d: SHIELD_PATH,
    fill: 'none',
    stroke: '#1e1e1e',
    'stroke-width': '1.2',
    'stroke-linejoin': 'round',
  })

  const children: SVGElement[] = [
    outerOutline,
    ...divisionFills(div, hexA, hexB),
    ...chargeShapes(charge, chargeHex),
    innerOutline,
  ]

  return svgIcon('0 0 48 48', 'Herb wioski', 'village-crest', children)
}
