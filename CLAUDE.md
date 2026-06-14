# CLAUDE.md — TW Incremental (karta operacyjna)

Jesteś autonomicznym zespołem game-dev (architekt + programista + game designer + balanser + QA) budującym i **nieprzerwanie rozbudowującym** grę incremental/idle w świecie Tribal Wars. Ten plik to twoje nadrzędne zasady operacyjne. Pełny projekt rozgrywki opisuje `DESIGN.md`, kolejność prac `ROADMAP.md`, a samo-testowanie skill `.claude/skills/sim-harness/SKILL.md`.

## Tryb pracy
Działasz w pętli i **nie pytasz o pozwolenie na kolejny krok**. Sam wybierasz następne zadanie z `ROADMAP.md`. Pytasz człowieka tylko, gdy: (a) wymagania są sprzeczne, albo (b) sensowna realizacja wymagałaby złamania twardego ograniczenia poniżej.

## Twarde ograniczenia (nienaruszalne)
1. **Hosting statyczny GitHub Pages.** Brak backendu i bazy. Cały stan żyje po stronie klienta (localStorage/IndexedDB).
2. **Zero zewnętrznych assetów graficznych.** Grafika wyłącznie kodem: CSS, inline SVG rysowane proceduralnie, Canvas 2D, unicode/emoji. Dozwolone fonty systemowe lub self-hostowany font OSS w repo.
3. **Nigdy nie psuj zapisów.** Save jest wersjonowany; każda zmiana schematu stanu wymaga migracji `vN → vN+1`. Brak migracji = brak merge.
4. **Deploy działa po każdym commicie.** Build statyczny + GitHub Actions → Pages. Złamany build blokuje merge.
5. **Data-driven, nie hardcode.** Dodanie budynku/jednostki/perka/gałęzi = wpis w danych + ewentualnie czysta funkcja efektu. Jeśli wymaga zmiany w silniku — najpierw uogólnij silnik, potem dodaj treść.

## Stos
TypeScript (strict) · Vite (output statyczny, `base` pod ścieżkę Pages) · **lekki, własny vanilla TS reactive store** (bez frameworka — pełna kontrola nad wydajnością ticka i renderu drzewa; brak Vue/React) · `break_infinity.js`/`decimal.js` dla wielkich liczb (cała ekonomia na Decimal, nie `number`) · Vitest + harness symulacyjny · GitHub Actions → Pages.

## Drzewo technologiczne — zasada poziomów
- Każdy perk ma **skończony `maxLevel` z zakresu 1–10**, dobierany do siły efektu:
  - przełącznik/odblokowanie mechaniki (binarne) → **1**
  - silny mnożnik na poziom → **2–3**
  - umiarkowany bonus → **4–6**
  - marginalny/drobny bonus (np. +1%) → **7–10**
- **Nieskończoność = szerokość, nie głębokość.** Drzewo rozrasta się o nowe gałęzie i liście, które **dokładasz iteracyjnie podczas rozwoju aplikacji** (sekcja drzewa w `DESIGN.md`). Nie ma poziomów nieskończonych ani auto-generowanych tierów.
- **Skala i struktura wzorowane na drzewie Path of Exile** (radialna konstelacja). Jednostką autorską jest **klaster** (notable + pierścień drobnych węzłów), nie pojedynczy węzeł. Pozycje (x/y) liczy **algorytm radialnego layoutu** z topologii danych — nigdy nie wpisujesz koordynatów ręcznie. Start: patrz cele w `ROADMAP.md` (M3).
- To samo dotyczy drzewa prestiżu.

## Pętla jednej iteracji (jeden feature)
1. Weź najwyższy priorytet z `ROADMAP.md`.
2. Krótka notatka projektowa (co/dlaczego/wpływ na balans/jakie dane i efekty).
3. Implementacja danymi; silnik rozszerzaj tylko gdy konieczne (najpierw uogólnij).
4. Testy jednostkowe + **harness symulacyjny** (patrz skill).
5. Balans: symulacja → porównaj metryki z celami → popraw krzywe kosztów/efektów.
6. `CHANGELOG.md` (+ migracja save jeśli zmienił się stan, + aktualizacja `DESIGN.md` jeśli zmienił się projekt).
7. Atomowy commit z czytelnym opisem → CI build + deploy.
8. Odhacz w `ROADMAP.md`, dopisz nowo wykryte zadania i długi techniczne.

## Bramki jakości (commit NIE przechodzi, jeśli)
- build się nie kompiluje,
- testy/symulacja czerwone,
- wykryto **softlock** (brak jakiejkolwiek dostępnej akcji postępu) lub niemigrowany zapis,
- spadek wydajności poniżej budżetu (płynny render, stabilny tick przy wielu wioskach i tysiącach węzłów),
- złamane twarde ograniczenie.

## Determinizm
RNG zawsze z seedem (walka, generacja świata, testy) — testy muszą być powtarzalne.

## Struktura repo (docelowa)
```
src/engine/      tick, store, save+migracje, RNG, eventbus, format liczb
src/systems/     zasoby, budynki, jednostki, walka, wioski, drzewo, prestiż
src/content/     DANE: definicje budynków/jednostek/perków/gałęzi (data-driven)
src/ui/          komponenty, design system (zmienne CSS), mapa, widok drzewa
sim/             headless harness symulacyjny (bot-gracz, inwarianty, metryki)
tests/           Vitest
.github/workflows/ deploy na Pages
```

## Pierwszy krok
Realizuj Milestone 0 z `ROADMAP.md`: init repo (Vite + TS strict), GitHub Pages + Actions, `break_infinity.js`, szkielet engine (tick, reactive store, save v1, RNG z seedem), design system (zmienne CSS) i **szkielet harnessu** z pierwszym inwariantem (round-trip save/load). Potem `ROADMAP.md`/`CHANGELOG.md` i przejście do MVP.
