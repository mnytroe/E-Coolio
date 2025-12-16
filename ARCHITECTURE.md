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
- Klipper bort 2024-data ved `"Resultater for 2024"`
- Parser tabeller og ekstraherer `Havet Arena`-verdier
- Returnerer JSON:

```json
{
  "weeks": {
    "50": { "raw": "78", "value": { "number": 78, "isEstimate": false } },
    ...
  },
  "lastUpdated": "2025-12-16T12:00:00.000Z"
}
```

**Fordeler med Worker**:
- Skjuler datakilden fra klienten
- Raskere (parsing på server)
- Ingen CORS-problemer
- Caching i Cloudflare edge

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
1. Cloudflare Worker (primær)
2. Havvarsel API direkte
3. Havvarsel API via CORS-proxy
4. Web scraping (siste utvei)

Bakteriedata:
1. Cloudflare Worker (primær)
2. Google Docs HTML-parsing (legacy fallback)
```

---

### Filstruktur

```
/
├── index.html      # HTML-struktur
├── styles.css      # All CSS (inkl. dark mode, responsive)
├── app.js          # All JavaScript
├── manifest.json   # PWA manifest
├── sw.js           # Service Worker for offline
├── ARCHITECTURE.md # Denne filen
└── README.md       # Kort beskrivelse
```

---

### Caching

**Klientside** (`localStorage`):
- Nøkkel: `havet_arena_data`
- Gyldighet: 1 time
- Versjonering: `CACHE_VERSION` for å invalidere ved strukturendringer

**Cloudflare Edge**:
- Workers cacher responser i 1 time (`Cache-Control: public, max-age=3600`)

---

### Viktige invariants

1. **Kun 2025-data**: Worker klipper bort alt etter "Resultater for 2024"
2. **Kun Havet Arena**: Verdier fra Strandveikaia ignoreres
3. **Fallback-regler**: Hvis uke N mangler, bruk uke N-1 (ikke eldre)
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
