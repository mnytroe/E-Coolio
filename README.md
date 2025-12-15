# Havet Arena – Badevannskvalitet

Statisk side som viser ukentlig badevannskvalitet for Havet Arena basert på et offentlig Google-dokument. Siden kombinerer tabeller på tvers av uker, velger automatisk riktig uke, og viser grønn/rød status for bading.

Publisert: https://havet.app/

## Funksjoner
- Automatisk ukevalg: Finner gjeldende uke, faller tilbake til forrige uke hvis data mangler, og viser hvilken uke som faktisk brukes.
- Robust parsing: Slår sammen flere tabeller fra Google Docs og tåler små endringer i header/radnavn.
- Tydelig status: Grønn/rød indikator basert på bakterieverdi (E. coli).
- Feilhåndtering: Viser brukervennlige feilmeldinger og har en stub for ekstern feilvarsling.
- Ingen build-step: Ren HTML/CSS/JS som kan hostes rett på GitHub Pages.


