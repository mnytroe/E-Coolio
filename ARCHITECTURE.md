## Datakilde og arkitektur – Havet Arena badevann

### Tech stack & kontekst

- **Plattform**: Ren HTML/CSS/JS. Ingen bundler/rammeverk.
- **Hosting**: GitHub Pages (`https://havet.app`), bygges direkte fra `main`‑branch, rotmappe.
- **Backend**: Cloudflare Workers for datahenting (ingen egen server).
- **Mål**: Vise bakterieverdier (E. coli cfu/100 ml), badetemperatur og værtemperatur for **Havet Arena**, Nyhavna.

---

### Datakilder og Cloudflare Workers

#### 1. Bakteriedata (`bakterier.nytroe.workers.dev`)

**Kilde**: Google Docs-dokument `Resultater prøvetaking Nyhavnabassenget`

Cloudflare Worker henter og parser dokumentet server-side:
- Henter HTML fra Google Docs (`/export?format=html`)
- Strømmer HTML-en gjennom `HTMLRewriter` til årsmarkører
  (`"Resultater for 2025"`) og tabeller. Markøren står som første rad _inne i_
  årets første tabell, ikke som overskrift over den.
- Gir hver tabell årstallet til nærmeste markør, og beholder inneværende og
  forrige år (så uke 1–3 kan falle tilbake til uke 51/52 i fjor)
- Ekstraherer `Havet Arena`-raden fra hver tabell
- Returnerer JSON:

```json
{
  "series": [
    { "year": 2025, "week": 50, "raw": "78", "value": { "number": 78, "isEstimate": false } },
    ...
  ],
  "weeks": {
    "50": { "raw": "78", "value": { "number": 78, "isEstimate": false } },
    ...
  },
  "lastUpdated": "2025-12-16T12:00:00.000Z"
}
```

`series` er autoritativ: kronologisk sortert med eksplisitt årstall. `weeks`
inneholder bare nyeste år uten årstall og beholdes for eldre klienter.

Workeren har også to HTML-sider: `/docs` (API-dokumentasjon, grenseverdiene
hentes fra `THRESHOLDS`) og `/ukens` (bare siste råverdi).

**Fordeler med Worker**:
- Skjuler datakilden fra klienten
- Raskere (parsing på server)
- Ingen CORS-problemer
- Dokumentet caches i workeren, så Google Docs ikke treffes på hvert kall

#### 2. Badetemperatur (`bading.nytroe.workers.dev`)

**Kilde**: MET OceanForecast 2.0 API (`api.met.no/weatherapi/oceanforecast/2.0`)

Cloudflare Worker fungerer som proxy med CORS-støtte:
- Henter data fra MET for koordinater (63.44181, 10.42506)
- Returnerer forenklet JSON:

```json
{
  "updated_at": "2025-12-16T06:00:00Z",
  "now": {
    "sea_water_temperature": 5.9,
    "sea_surface_wave_height": 0,
    ...
  }
}
```

#### 3. Værtemperatur (direkte)

**Kilde**: Open-Meteo API (`api.open-meteo.com`)

Hentes direkte fra klienten (Open-Meteo har CORS-støtte):
- Koordinater: 63.44181, 10.42506
- Returnerer lufttemperatur i °C

---

### Fallback-strategi

Koden bruker **Strategy Pattern** for robust datahenting:

```
Badetemperatur:
1. Cloudflare Worker (bading.nytroe.workers.dev)
2. Havvarsel API direkte

Bakteriedata:
1. Cloudflare Worker (eneste kilde, med retry og timeout)
   Feiler den, vises en feilmelding. localStorage-cachen og Service
   Workerens API-cache (maks 1 døgn gammel) dekker korte avbrudd.
```

`bading`-workeren ligger ikke i dette repoet.

---

### Filstruktur

```
/
├── index.html      # HTML-struktur
├── styles.css      # All CSS (inkl. dark mode, responsive)
├── app.js          # DOM, nettverk og UI (ES-modul)
├── utils.js        # Ren logikk delt mellom app.js, worker.js og testene
├── worker.js       # Cloudflare Worker for bakteriedata
├── wrangler.toml   # Worker-deploy (npm run deploy:worker)
├── manifest.json   # PWA manifest
├── sw.js           # Service Worker for offline
├── tests/          # Vitest: rene funksjoner i Node, workeren i workerd (Miniflare)
├── ARCHITECTURE.md # Denne filen
└── README.md       # Kort beskrivelse
```

**`utils.js`** er eneste kilde for grenseverdier (`THRESHOLDS`), ukenummer-
logikk og parsing. Både frontend og workeren importerer derfra, slik at de ikke
kan komme i utakt. Modulen er DOM-uavhengig og kjører derfor like godt i
nettleseren, i Workers-runtime og i vitest.

**Deploy av workeren** skjer med `npm run deploy:worker` (wrangler). Den kan
ikke lenger limes inn som én fil i Cloudflare-dashboardet, siden den importerer
fra `utils.js`.

---

### Caching

**Klientside** (`localStorage`):
- Nøkkel: `havet_arena_data`
- Gyldighet: 1 time
- Versjonering: `CACHE_VERSION` for å invalidere ved strukturendringer

**Service Worker** (`sw.js`):
- Nett først for alt. Cachet versjon brukes kun offline.
- API-svar brukes offline bare hvis de er under 1 døgn gamle.

**Bakterie-workeren**:
- Google Docs-dokumentet caches i 1 time i minnet per isolate, og via
  `cf.cacheTtl` i edge der workeren kjører på en sone med cache.
  `?debug=true` henter alltid ferskt.
- Svaret sendes med `Cache-Control: public, max-age=3600`, som gjelder
  nettleseren. Cloudflare cacher ikke svar workeren lager selv.

---

### Viktige invariants

1. **Inneværende og forrige år**: Worker forkaster eldre årssegmenter
2. **Kun Havet Arena**: Verdier fra Strandveikaia ignoreres
3. **Fallback-regler**: Hvis uke N mangler, bruk nyeste måling før N (også over
   årsskiftet). Finnes ingen eldre, brukes nærmeste fremtidige. UI-et viser da
   hvilken uke som faktisk vises.
4. **Estimerte verdier**: `>N` vises med fotnote

---

### Koordinater

Alle API-kall bruker:
- **Latitude**: 63.44181
- **Longitude**: 10.42506

(Havet Arena, Nyhavna, Trondheim)

---

### Oppdatering av data

- **Bakterieverdier**: Oppdateres ukentlig i Google Docs av Trondheim kommune
- **Badetemperatur**: Oppdateres hver 6. time av MET
- **Værtemperatur**: Oppdateres hver time av Open-Meteo
