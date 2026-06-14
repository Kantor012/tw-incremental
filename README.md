# TW Incremental

Osadnicza gra **incremental / idle** w świecie *Tribal Wars*. Zaczynasz od jednej
wioski, automatyzujesz produkcję surowców, budujesz armię, walczysz z barbarzyńcami,
zakładasz i przejmujesz wioski, rozwijasz rozległe drzewo technologiczne, a docelowo
**prestiżujesz** — resetujesz postęp za trwałe bonusy w osobnym drzewie.

**Gra na żywo:** https://Kantor012.github.io/tw-incremental/

## Zasady techniczne

- **Hosting statyczny** (GitHub Pages) — brak backendu, cały stan po stronie klienta
  (localStorage), zapis wersjonowany z migracjami.
- **Zero zewnętrznych assetów graficznych** — cała grafika rysowana kodem: CSS,
  inline SVG, Canvas 2D, unicode.
- **Wielkie liczby** na `break_infinity.js` (Decimal), nie `number`.
- **Data-driven** — budynki, jednostki, perki i gałęzie drzewa to dane, nie kod.
- **Deterministyczna symulacja** (RNG z seedem) → powtarzalne testy i samo-balansowanie.

## Stos

TypeScript (strict) · Vite · własny lekki reactive store (bez frameworka) ·
`break_infinity.js` · Vitest + headless harness symulacyjny · GitHub Actions → Pages.

## Rozwój

```bash
npm install      # instalacja zależności
npm run dev      # serwer deweloperski (http://localhost:5173)
npm run build    # typecheck + build statyczny do dist/
npm run preview  # podgląd builda produkcyjnego
npm test         # testy jednostkowe (Vitest)
npm run sim      # headless harness: inwarianty + metryki balansu
```

## Struktura

```
src/engine/   tick, reactive store, save + migracje, RNG, event bus, format liczb
src/systems/  zasoby, budynki, jednostki, walka, wioski, drzewo, prestiż
src/content/  DANE: definicje budynków/jednostek/perków/gałęzi (data-driven)
src/ui/       komponenty, design system (zmienne CSS), mapa, widok drzewa
sim/          headless harness symulacyjny (bot-gracz, inwarianty, metryki)
tests/        Vitest
```

## Status

Wczesny rozwój. Postęp prowadzony milestone'ami (fundament → MVP → ekspansja →
drzewo technologiczne → prestiż → warstwy meta).
