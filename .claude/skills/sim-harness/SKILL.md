---
name: sim-harness
description: >
  Headless harness do samo-testowania i balansowania gry TW Incremental. Użyj ZAWSZE
  po zmianie logiki rozgrywki, ekonomii, walki, drzewa technologicznego lub prestiżu —
  ZANIM zrobisz commit. Uruchamia symulację bez UI (bot-gracz + przyspieszony czas),
  sprawdza twarde inwarianty (brak NaN, brak ujemnych surowców, round-trip save/load,
  brak softlocka, osiągalność kamieni milowych) oraz metryki balansu. Wyzwalacze:
  "przetestuj balans", "sprawdź progresję", "czy nie ma softlocka", "symulacja",
  "balans drzewa/prestiżu", a także każdy krok 4–5 pętli iteracji z CLAUDE.md.
---

# Skill: Harness symulacyjny (test-and-improve)

Główny mechanizm QA gry. Gra jest deterministyczna przy danym seedzie — to umożliwia powtarzalne testy.

## Kiedy uruchamiać
Po każdej zmianie dotykającej logiki gry (zasoby, budynki, jednostki, walka, drzewo, prestiż, save) i zawsze przed commitem. To krok 4–5 pętli iteracji z `CLAUDE.md`.

## Jak działa
1. **Bez UI.** Instancjonuj stan gry w Node, omijając warstwę renderu.
2. **Bot-gracz** prowadzony heurystyką: kupuj najtańszą opłacalną akcję (budynek/jednostka/perk wg stosunku efekt/koszt), atakuj osiągalne wioski barbarzyńskie, zakładaj/przejmuj wioski gdy opłacalne, prestiżuj gdy zysk PP przekracza próg.
3. **Przyspieszony czas (time-compression):** przewiń od tysięcy do milionów ticków, w wielu biegach z różnymi seedami.
4. **Asercje inwariantów** w trakcie i na końcu biegu.
5. **Zbierz metryki balansu**, porównaj z celami, wygeneruj raport.

## Twarde inwarianty (czerwone = blokada commitu)
- Brak `NaN`/`Infinity` w miejscach niedozwolonych (Decimal pozostaje skończony tam, gdzie powinien).
- Surowce nigdy ujemne; magazyn/populacja nie przekraczają limitów.
- **Round-trip save→load** daje stan identyczny (głębokie porównanie po serializacji).
- Migracja `vN → vN+1` działa na zapisach z poprzednich wersji (trzymaj fixture'y starych save'ów).
- **Brak softlocka:** w każdym kroku istnieje co najmniej jedna dostępna akcja postępu.
- **Osiągalność kamieni milowych** w budżecie ticków: 1. upadek wioski barbarzyńskiej, N-ta wioska, próg gałęzi drzewa, **pierwszy prestiż**, wejście w kolejną warstwę meta.
- Determinizm: ten sam seed → ten sam wynik.

## Metryki balansu (raportuj, porównuj z celami, oznaczaj regresje)
- czas (ticki/sym. godziny) do: 1. prestiżu, N-tej wioski, progu kategorii drzewa,
- krzywa wzrostu produkcji w czasie (czy nie ma plateau ani eksplozji),
- opłacalność każdej warstwy prestiżu (PP/godzinę),
- udział „martwych" perków (nigdy nie kupowanych przez bota — sygnał złego balansu),
- liczba przegranych obron przy najazdach (czy defensywa jest sensowna).

Cele balansu trzymaj w configu (`sim/targets.ts`) i wersjonuj — zmiana celu to świadoma decyzja projektowa opisana w `CHANGELOG.md` (sekcja Balance, wartości przed/po).

## Raport
Po biegu wypisz zwięzły raport: status inwariantów (PASS/FAIL z detalem), tabela metryk vs cele, lista martwych perków, najgłębszy osiągnięty postęp. Przy FAIL — nie commituj; napraw przyczynę (zwykle krzywa `costFn`/`effectFn` w danych, nie silnik).

## Struktura
```
sim/
  runner.ts     pętla symulacji, wiele biegów × seedy, budżet ticków
  bot.ts        heurystyka bot-gracza
  invariants.ts twarde asercje
  metrics.ts    zbieranie metryk balansu
  targets.ts    cele balansu (wersjonowane)
  fixtures/     stare save'y do testów migracji
```

## Zasada
Jeśli balans nie domyka się przez dane (krzywe kosztów/efektów, progi, `maxLevel` 1–10), a kusi zmiana silnika — najpierw sprawdź, czy problem nie leży w danych. Silnik zmieniaj tylko, gdy potrzebna jest nowa, ogólna zdolność.
