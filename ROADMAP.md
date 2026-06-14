# ROADMAP.md — TW Incremental

Lista priorytetowa. Pracujesz od góry. Odhaczasz ukończone (`[x]`), dopisujesz nowo wykryte zadania i długi techniczne na dole właściwego milestone'a. Po wyczerpaniu listy generuj nowe funkcje zgodne z `DESIGN.md`, zawsze utrzymując balans i kompatybilność zapisów.

## Milestone 0 — Fundament
- [ ] Init repo: Vite + TypeScript (strict)
- [ ] GitHub Pages + Actions (deploy statyczny po commicie, `base` ustawione)
- [ ] `break_infinity.js`/`decimal.js` + warstwa formatowania liczb
- [ ] Engine: game loop (stały delta), reactive store, RNG z seedem, event bus
- [ ] Save system v1: serializacja + wersja + eksport/import base64 + autosave
- [ ] Design system: zmienne CSS (paleta, typografia, odstępy, cienie, animacje)
- [ ] Szkielet harnessu symulacyjnego + 1. inwariant: round-trip save→load
- [ ] `CHANGELOG.md`

## Milestone 1 — MVP grywalny
- [ ] Surowce + produkcja (drewno, glina, żelazo, zagroda, spichlerz, monety)
- [ ] Budynki podstawowe (ratusz, tartak, cegielnia, huta, zagroda, spichlerz, koszary)
- [ ] Jednostki podstawowe (pikinier, miecznik, topornik) + rekrutacja w czasie
- [ ] Walka PvE: atak na wioskę barbarzyńską (model + łup)
- [ ] Najazdy barbarzyńców na gracza (obrona)
- [ ] Jedna wioska, offline progress, formatowanie liczb w UI
- [ ] Inwarianty harnessu: brak NaN/ujemnych surowców, brak softlocka

## Milestone 2 — Ekspansja
- [ ] Zakładanie nowych wiosek (rosnący koszt)
- [ ] Szlachcic + lojalność → przejmowanie wiosek barbarzyńskich
- [ ] Mapa świata (SVG, koordynaty, odległość → czas marszu i siła celu)
- [ ] Widok wielu wiosek (globalny + per-wioska)
- [ ] Logistyka marszów i łup

## Milestone 3 — Drzewo technologiczne
- [ ] Silnik drzewa: węzły z `maxLevel` 1–10, prerequisites, unlocks, costFn/effectFn
- [ ] Archetypy węzłów: minor (7–10) / notable (2–3) / keystone-gateway (1)
- [ ] Jednostka autorska = **klaster** (notable + pierścień 3–8 drobnych + ścieżki)
- [ ] **Algorytm radialnego layoutu** (hub → ramiona per kategoria → klastry → pierścienie); zero ręcznych koordynatów
- [ ] Wizualizacja grafu (SVG, zoom/pan, stany, wirtualizacja) — konstelacja w stylu PoE
- [ ] Integracja efektów z ekonomią i walką
- [ ] **Cel skali v1: ~180–260 węzłów w ~30–40 klastrach + 6–8 gateway**
- [ ] Harness: brak osieroconych/niedostępnych węzłów, brak „martwych" perków, brak cykli w prerequisites
- [ ] (ciągłe) dokładanie klastrów/ramion → ~500–800 (średnio), docelowo ~1000–1500+ (skala PoE)

## Milestone 4 — Prestiż
- [ ] Mechanika resetu + wzór na punkty prestiżu (PP)
- [ ] Drzewo prestiżu (ten sam model węzła, trwałe bonusy)
- [ ] Integracja trwałych bonusów ze startem nowego biegu
- [ ] Balans: pierwszy prestiż osiągalny w rozsądnym czasie

## Milestone 5 — Głębia i automatyzacja
- [ ] Automatyzacje jako odblokowania (auto-build / auto-recruit / auto-attack)
- [ ] Wywiad/zwiadowcy, mur i oblężenie (taran, katapulta)
- [ ] Morale/szczęście w walce, wydarzenia losowe
- [ ] Osiągnięcia i statystyki

## Milestone 6 — Warstwy meta
- [ ] Druga i trzecia warstwa prestiżu (Era/Dynastia) + waluty meta
- [ ] Nowe mechaniki bramkowane wyższymi warstwami
- [ ] Kodeks/encyklopedia w grze

## Backlog ciągły (nieskończony, po M6)
Nowe tiery gałęzi drzew · nowe typy celów PvE (obozy, fortece, hordy) · pakty/dyplomacja z plemionami · sezonowe wydarzenia · wyzwania (challenge runs z modyfikatorami) · rynek/aukcje surowców · rzemiosło/craft · lokalny ranking offline · tryby trudności · lokalizacja PL/EN · dopieszczanie wizualne i animacje · optymalizacje wydajności.

> Drzewo rozrasta się **szerokością**: w każdej iteracji wolno dorzucić nowe liście/gałęzie do istniejących kategorii lub otworzyć nową kategorię — to główne źródło treści „na lata".
