# DESIGN.md — TW Incremental (projekt rozgrywki)

Dokument projektowy gry. Zasady operacyjne i twarde ograniczenia: `CLAUDE.md`. Kolejność prac: `ROADMAP.md`.

## 1. Wizja
Gra incremental/idle w świecie Tribal Wars. Gracz zaczyna od jednej wioski, automatyzuje produkcję surowców, buduje armię, **walczy z wioskami barbarzyńskimi i odpiera ich najazdy**, **zakłada nowe wioski i przejmuje wioski barbarzyńców** (szlachcic/lojalność), a docelowo **prestiżuje** — resetuje postęp w zamian za punkty prestiżu wydawane w osobnym drzewie trwałych bonusów.

Wzorzec głębi „na lata": *Evolve* (`https://pmotschmann.github.io/`) — wielowarstwowy prestiż i rozległa treść. Różnica: dopracowana warstwa wizualna, ale **wyłącznie środkami, które potrafi wytworzyć kod** (CSS/SVG/Canvas/typografia/unicode). Bez zewnętrznych grafik.

## 2. Architektura (fundament rozszerzalności)
Cel: ~90% przyszłej treści dodaje się jako **dane**, nie jako kod.

**Engine (stabilny rdzeń):** deterministyczny game loop (stały delta, render oddzielony od symulacji) · offline progress (z limitem i ewentualną efektywnością offline) · reactive store (jedno źródło prawdy) · save system (serializacja, wersja, migracje, eksport/import base64, autosave) · warstwa Decimal + formatowanie liczb w jednym miejscu · RNG z seedem · event bus (luźne sprzężenie systemów).

**Systemy (rozbudowywane, osobne moduły):** zasoby/produkcja · budynki · jednostki · walka PvE · wioski (zakładanie/przejmowanie/lojalność) · drzewo technologiczne · prestiż · osiągnięcia/statystyki.

**Treść (czysto dane):** definicje budynków, jednostek, perków, gałęzi, wydarzeń — deklaratywnie. Koszt = `costFn(level) -> Decimal`, efekt = `effectFn(level, ctx) -> modyfikator` (czyste funkcje).

**Złota zasada:** dodanie treści nie może wymagać zmiany w pliku silnika. Jeśli wymaga — najpierw uogólnij silnik.

## 3. Rdzeń rozgrywki (MVP)
Domknięta pętla: produkuj → buduj → rekrutuj → walcz z barbarzyńcami → rośnij → (zalążek prestiżu).

**Surowce (motyw TW):** drewno, glina, żelazo, zagroda (limit populacji), spichlerz (limit magazynu), monety (waluta gameplayowa, niepłatna).

**Budynki (poziom = krzywa kosztu i efektu):** ratusz (odblokowania, redukcja kosztów rozbudowy) · tartak · cegielnia · huta żelaza · zagroda · spichlerz · koszary · stajnia · warsztat · kuźnia (ulepszenia jednostek) · mur (obrona) · rynek (wymiana surowców) · dwór/pałac (szlachcic, przejmowanie) · punkt zborny (kolejka armii).

**Jednostki (motyw TW):** pikinier, miecznik, topornik, (łucznik opcj.), zwiadowca, lekka kawaleria, ciężka kawaleria, taran (kruszy mur), katapulta (niszczy budynki), szlachcic (obniża lojalność celu). Każda: koszt surowcowy, koszt populacji, czas rekrutacji, atak/obrona (vs piechota/kawaleria), ładowność (łup), prędkość.

**Walka PvE:**
- *Ofensywa* — atak na wioskę barbarzyńską (siła rośnie z odległością i progresją), rozstrzygnięcie wg modelu TW (typy obrony, mur, morale, szczęście), łup, możliwy upadek wioski.
- *Defensywa* — okresowe **najazdy barbarzyńców** skalowane do siły gracza; porażka = strata surowców/jednostek.
- Walka **deterministyczna przy danym seedzie**, w pełni opisana danymi (mnożniki w configu) → balansowalna i testowalna.

**Wioski:** zakładanie nowych (rosnący koszt, wymaga budynku/perka) · przejmowanie barbarzyńskich szlachcicem (lojalność < 0 po serii ataków) · widok globalny + per-wioska · automatyzacje (auto-build/recruit) odblokowywane progresją.

**Mapa świata:** proceduralna siatka/SVG; wioski (gracza, barbarzyńskie) jako węzły z koordynatami; odległość wpływa na czas marszu i siłę celu.

## 4. Drzewo technologiczne
Schemat węzła:
```ts
TechNode = {
  id, category, branch,
  prerequisites: NodeRef[],
  maxLevel: 1..10,                 // skończony, dobierany do siły perka
  costFn:   (level) => ResourceCost,   // krzywa kosztu (rosnąca z poziomem)
  effectFn: (level) => Effect,          // efekt na poziom (z malejącymi zwrotami)
  unlocks: NodeRef[]                    // co odsłania osiągnięcie poziomu progowego
}
```

**Dobór `maxLevel` (1–10) wg siły efektu:**
- odblokowanie/przełącznik mechaniki (binarne) → **1**
- silny mnożnik na poziom → **2–3**
- umiarkowany bonus → **4–6**
- marginalny/drobny bonus (np. +1% produkcji) → **7–10** (stackowanie wielu drobnych kroków)

**Rozmiar drzewa = szerokość, nie głębokość.** „Niemal nieskończona liczba gałęzi i liści" powstaje przez **iteracyjne dokładanie nowych węzłów, gałęzi i całych kategorii w trakcie rozwoju aplikacji** — nie przez nieskończone poziomy ani auto-generację tierów. Każda iteracja rozwoju może dorzucić nowe liście do istniejących gałęzi lub otworzyć nową gałąź.

**Kategorie (gałęzie główne):** ekonomia · militaria · logistyka/marsze · fortyfikacje · wywiad · ekspansja (wioski) · automatyzacja · nauka · dyplomacja (pakty z plemionami barbarzyńskimi) · rzemiosło. Każda rozgałęzia się na pod-gałęzie i liście.

**Węzły bramkowe (gateway):** rzadkie, drogie perki (zwykle `maxLevel: 1`), które odsłaniają zupełnie nową mechanikę lub kategorię (np. „Kartografia" → mapa dalekiego zasięgu → nowy typ celów PvE). To one napędzają poczucie odkrywania na przestrzeni miesięcy gry.

### Taksonomia węzłów (wzorzec: drzewo Path of Exile)
Wzorujemy strukturę i skalę na pasywnym drzewie PoE (radialna konstelacja, klastry-„wheels", duże keystone'y). Trzy archetypy stanowią słownik, z którego masowo autorujesz treść jako dane:
- **Drobne (minor)** — większość węzłów. Marginalny bonus → `maxLevel` 7–10 (sink na drobne kroki). To „wypełnienie" pierścieni klastrów.
- **Wyróżnione (notable)** — silniejszy, nazwany efekt → `maxLevel` 2–3. Środek każdego klastra.
- **Keystone / gateway** — przełomowa mechanika lub odblokowanie kategorii → `maxLevel` 1. Rzadkie, drogie, na rozjazdach ramion.

### Klaster = jednostka autorska
Nie dodajesz pojedynczych węzłów — dodajesz **klaster**: jeden notable + pierścień 3–8 drobnych węzłów + ścieżki łączące. To zarazem jednostka danych i wizualne „wheel" znane z PoE. Dzięki temu setki węzłów powstają jako kilkadziesiąt sensownych jednostek treści, balansowalnych całościami.

### Layout liczony, nie wpisywany
Topologię (które węzły, czyje prerequisites, przynależność do kategorii/klastra) podajesz w danych. Pozycje (x/y) wyznacza **algorytm radialnego layoutu**: centralny hub → ramiona per kategoria → klastry rozmieszczone wzdłuż ramienia → drobne węzły w pierścieniu wokół notable. Nigdy nie wpisujesz koordynatów ręcznie. To pozwala uzyskać konstelację w skali PoE bez ręcznego stawiania tysięcy punktów.

### Skala i punkt startowy
- **Pierwsza wersja drzewa (M3):** ~**180–260 węzłów** w ~30–40 klastrach, z 6–8 węzłami gateway — by od startu czytało się jak konstelacja, a nie zabawka, a jednocześnie dało się je zautorować i zbalansować w rozsądnej liczbie iteracji.
- **Średnioterminowo:** ~500–800 węzłów.
- **Docelowo (na lata):** ~**1000–1500+** węzłów — skala drzewa PoE — osiągana przez dokładanie kolejnych klastrów i ramion, nie przez auto-generację.
- Gracz w jednym biegu i tak nie wykupi całości — szerokość to **różnorodność buildów i ścieżek rozwoju**, nie checklista do ukończenia (tak jak w PoE).

**Prezentacja:** graf SVG/Canvas z zoom/pan, kolorowanie stanu (zablokowany/dostępny/wykupiony/maks.), wirtualizacja renderu (węzłów będą setki–tysiące).

## 5. Prestiż (i warstwy meta „na lata")
**Prestiż (Ascension):** reset postępu rozgrywkowego za **punkty prestiżu** (PP), liczone z osiągniętego progresu (np. funkcja sumy surowców, liczby wiosek, łącznej siły, najgłębiej odblokowanych gałęzi). PP wydaje się w **osobnym drzewie prestiżu** o tym samym modelu węzła co wyżej (skończony `maxLevel` 1–10, szerokość rosnąca w czasie rozwoju), dającym **trwałe** bonusy: globalne mnożniki, szybsze marsze, tańsze budynki, startowe wioski, automatyzacje od startu, nowe mechaniki.

**Warstwy meta:** prestiż jest **warstwowy**. Po wielu prestiżach odblokowuje się wyższa warstwa resetu (np. „Era / Dynastia") — resetuje część drzewa prestiżu za walutę meta i jeszcze rzadsze, potężniejsze bonusy oraz nowe systemy. Zaprojektuj minimum 3 warstwy z miejscem na kolejne.

**Zasady:** każdy prestiż musi być opłacalny i wyczuwalny (pierwszy osiągalny w rozsądnym czasie, kolejne coraz głębsze) i **nigdy nie może zablokować gracza** — zawsze istnieje jakaś ścieżka postępu.

## 6. Warstwa wizualna (dopracowana, wyłącznie kodem)
- **Design system:** zmienne CSS (paleta, skala typograficzna, odstępy, promienie, cienie, czasy animacji). Klimat średniowieczny/plemienny — ciemne tło, ciepłe akcenty (drewno/brąz/żelazo/zieleń), czytelne panele.
- **Ikonografia:** inline SVG rysowane proceduralnie (herby, tarcze, ikony surowców i jednostek) + unicode/emoji tam, gdzie pasuje. Spójny zestaw.
- **Komponenty:** paski produkcji, liczniki z animowanym przyrostem i formatowaniem dużych liczb, tooltipy ze statystykami, panele zwijane, modale, toasty zdarzeń (najazd, przejęcie wioski).
- **Mapa świata:** SVG/Canvas z węzłami-wioskami, liniami marszów, animacją armii.
- **Drzewa (tech/prestiż):** graf SVG z zoom/pan, kolorowaniem stanu, wirtualizacją.
- **Animacje:** subtelne, CSS-owe (hover, odblokowania, level-up).
- **Responsywność i dostępność:** desktop + mobile, kontrast, focus states, skróty klawiszowe.
- **Budżet wydajności:** płynny render i stabilny tick przy wielu wioskach i tysiącach węzłów drzewa.
