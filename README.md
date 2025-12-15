# Havet Arena – Badevannskvalitet

Statisk side som viser ukentlig badevannskvalitet for Havet Arena basert på et offentlig Google-dokument. Siden kombinerer tabeller på tvers av uker, velger automatisk riktig uke, og viser grønn/rød status for bading.

## Funksjoner
- Automatisk ukevalg: Finner gjeldende uke, faller tilbake til forrige uke hvis data mangler, og viser hvilken uke som faktisk brukes.
- Robust parsing: Slår sammen flere tabeller fra Google Docs og tåler små endringer i header/radnavn.
- Tydelig status: Grønn/rød indikator basert på bakterieverdi (E. coli).
- Feilhåndtering: Viser brukervennlige feilmeldinger og har en stub for ekstern feilvarsling.
- Ingen build-step: Ren HTML/CSS/JS som kan hostes rett på GitHub Pages.

## Krav
- Google-dokumentet må være offentlig tilgjengelig (“Anyone with the link can view”).
- URL/ID til dokumentet settes i `index.html` via `DOC_ID`.

## Lokal kjøring
```bash
python -m http.server 8000
```
Åpne `http://localhost:8000` i nettleseren.

## Deploy (GitHub Pages)
- Legg `index.html` i repo-roten.
- Slå på GitHub Pages i repo-innstillinger (Settings → Pages → source: main, folder: /root).
- Åpne den publiserte URL-en.

## Tilpasning
- Sett `DEBUG = false` i `index.html` for å slå av logging.
- Fyll inn din egen webhook i `logErrorToService` for varsler (Slack, Discord, Google Forms, etc.).
- Juster terskler/tekster i `updateUI` om du ønsker annen logikk for status.

