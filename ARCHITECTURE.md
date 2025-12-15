## Datakilde og arkitektur – Havet Arena badevann

### Tech stack & kontekst

- **Plattform**: Ren `index.html` med innebygd JavaScript og CSS. Ingen bundler/rammeverk.
- **Hosting**: GitHub Pages (`https://havet.app`), bygges direkte fra `main`‑branch, rotmappe.
- **Datakilde**: Offentlig Google Docs‑dokument (ikke regneark), eksporteres som HTML og parses i nettleseren.
- **Mål**: Vise _én_ verdi per uke for **Havet Arena** (E. coli cfu/100 ml) + en enkel historikkgraf, uten backend.

### 1. Datakilde

- **Kilde**: Google Docs‑dokument `Resultater prøvetaking Nyhavnabassenget`  
  - URL‑ID ligger i `CONFIG.DOC_ID` i `index.html`.
- Dokumentet inneholder:
  - Tekstlig forklaring øverst.
  - En seksjon **«Resultater for 2025»** med flere tabeller:
    - Hver tabell dekker et 10‑ukers intervall (1–10, 11–20, …, 41–50, 51–52).
    - Rad 0: `Prøvepunkt | Uke X | Uke Y | …`.
    - Rad 1: `Havet Arena` + verdier.
    - Rad 2: `Strandveikaia` + verdier.
  - En seksjon **«Resultater for 2024»** med tilsvarende struktur (som vi _ikke_ skal bruke).

### 2. Henting av data

- Vi henter dokumentet som **ren HTML**:
  - URL: `https://docs.google.com/document/d/${CONFIG.DOC_ID}/export?format=html`
  - Håndteres av `fetchDocumentHTML()` med retry/timeout.
- Hvis direkte kall feiler (CORS/annet) brukes en CORS‑proxy (`allorigins`) som fallback.

### 3. Filtrering av år (utelukk 2024)

For å unngå at 2024‑verdier blandes inn:

- Før parsing **klipper vi HTML‑strengen** ved første forekomst av `"Resultater for 2024"`:
  - Alt etter dette fjernes, slik at DOM bare inneholder 2025‑tabellene.
- Parsing og videre behandling skjer dermed kun på 2025‑delen.

### 4. Parsing av tabeller → CSV‑lignende struktur

Funksjon: `parseHTMLToCSV(html)`

- Bruker `DOMParser` for å lese HTML til et DOM‑tre.
- Leser **alle `<table>`** i den gjenværende 2025‑delen.
- For hver tabell:
  - Finn rad der første celle (`td`/`th`) inneholder `Prøvepunkt` → dette er **header‑raden**.
  - Finn rad der første celle inneholder både `havet` og `arena` → dette er **datakilden** vi bryr oss om.
  - Header‑radene for alle tabeller slås sammen til én lang header:  
    `Prøvepunkt, Uke 1, …, Uke 10, Uke 11, …, Uke 50, Uke 51, Uke 52`.
  - Dataverdiene for `Havet Arena` fra hver tabell legges i én lang rad i samme rekkefølge.
  - Rader for `Strandveikaia` **ignoreres eksplisitt**.
- Resultatet returneres som en CSV‑streng (header + én rad for Havet Arena).

### 5. Tolkning av CSV og uke‑logikk

Funksjoner: `parseCSV()`, `processSheetData(lines)`

- `parseCSV()` splitter CSV‑tekst til `lines: string[][]`, med støtte for:
  - Anførselstegn `"..."` med komma i celler.
  - `\r\n` og `\n` linjeskift.
- `processSheetData(lines)` gjør:
  - Finn header‑rad (den som inneholder både `Prøvepunkt` og minst én `Uke N`).
  - Bygg en mapping `uke → kolonneindeks` for alle `Uke N` i headeren.
  - Finn raden for `Havet Arena` og les ut verdien for aktuell uke.
  - **Spesielle verdier:**
    - `*`, `-`, tom streng, `**` ⇒ behandles som _ingen verdi_ (null).
    - `>N` ⇒ strip `>` og parse tallet; markeres som `isEstimate = true`.
  - Finn **gjeldende uke** (`getWeekNumber()`) og forsøk å bruke eksakt match.
  - Hvis uke mangler/tom ⇒ **fallback til forrige uke (currentWeek - 1)** hvis den har tall.
  - Returnerer et objekt `{ value, actualWeek, searchedWeek, isEstimate, rawValue, history }`.

### 6. Historikk og graf

- `history` bygges som en liste av `{ week, value }` for alle uker med gyldig tallverdi i 2025.
- De siste 5 ukene brukes til en enkel linjegraf (`createMiniChart`) som tegnes i et `<canvas>`.

### 7. Caching og feilhåndtering

- Klientside‑cache i `localStorage`:
  - Nøkkel: `CONFIG.CACHE_KEY` (`havet_arena_data`).
  - Data: `{ data, timestamp, version }`.
  - Gyldighet: `CONFIG.CACHE_DURATION` (1 time) + `CACHE_VERSION`‑match.
- Ved `CONFIG.DEBUG = false` logges kun alvorlige feil til konsoll.
- Ved feil i fetch/parsing:
  - Viser brukervennlig feilmelding på siden.
  - Potensiell hook (`logErrorToService`) for ekstern varsling (Slack, webhook osv.).

### 8. Viktige invariants (for å unngå regresjoner)

- **Kun 2025‑data**: All kode etter `cutoffMarker = 'Resultater for 2024'` skal ignorere 2024‑seksjonen fullstendig.
- **Kun `Havet Arena`**: Vi bruker aldri verdier fra `Strandveikaia` i logikken.
- **Header‑kombinasjon**: Alle tabeller med `Prøvepunkt` + `Uke N` for 2025 må bidra til én sammenhengende ukeheader (1–52).
- **Fallback‑regler**:
  - Hvis uke _N_ ikke har verdi, prøv **kun** uke _N‑1_ (ikke eldre).
  - Hvis heller ikke uke _N‑1_ har verdi, rapporter “ingen verdi for gjeldende uke” i UI.


