# VecStructi

**VecStructi** ist eine Vektor-Zeichen- und Layout-Anwendung, entwickelt mit [Tauri](https://tauri.app) und [SvelteKit](https://kit.svelte.dev).

## Funktionen

- **Zeichen-Werkzeuge** — Bleistift, Pinsel (11 Pinselformen), Linie, Rechteck, abgerundetes Rechteck, Ellipse, Text, Radierer, Bildrahmen
- **SVG-Leinwand** — alle Objekte werden als SVG gespeichert, vollständig auflösungsunabhängig
- **Eigenschaften-Panel** — Position, Größe, Drehung, Scheren, Ebenen, Füllung, Kontur, Schatten, Eckenradien, Textformatierung
- **Pinsel-Engine** — druckempfindlicher Pinsel mit Formen: Kreis, Rechteck, Linie, Gepunktet, Fächer, Airbrush, Tinte, Kreide, Textur, Zickzack, Doppellinie
- **Ebenen** — mehrere benannte Ebenen mit Sichtbarkeit und Sperrung, per Drag-and-Drop sortierbar
- **Raster & Lineale** — konfigurierbares Raster mit Einrasten, Lineale in mm/cm/px/pt/in
- **Rückgängig / Wiederholen** — vollständige Änderungshistorie
- **PDF-Export** — Leinwand als PDF exportieren via jsPDF
- **Speichern/Laden** — native Dateidialoge via Tauri
- **Seiten-Setup** — einstellbare Leinwandgröße (A4, A3, benutzerdefiniert) mit Hoch-/Querformat
- **Zoom** — vergrößern/verkleinern, an Fenster anpassen, tatsächliche Größe

## Technologien

| Ebene | Technologie |
|---|---|
| Desktop-Hülle | Tauri v2 (Rust) |
| Frontend | SvelteKit + Svelte 5 (Runes) |
| Leinwand | SVG |
| Pfad-Operationen | paper.js |
| PDF | jsPDF |

## Release

**v1.0** — Mai 2026

## Build

```bash
npm install
npm run tauri build
```

Die fertige App und das DMG befinden sich unter `src-tauri/target/release/bundle/`.

## Entwicklung

```bash
npm install
npm run tauri dev
```
