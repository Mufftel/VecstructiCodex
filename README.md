# VecStructi

**Version 0.834**

**VecStructi** ist eine native Desktop-Anwendung für technisches Zeichnen und Layout auf dem Mac. Sie richtet sich an Anwender die präzise Vektorgrafiken, Pläne, Schemata oder Konstruktionszeichnungen erstellen wollen — ohne die Komplexität professioneller CAD-Software.

Alle Zeichnungen werden als SVG gespeichert und sind damit vollständig auflösungsunabhängig und skalierbar.

---

## Was die App kann

- **Zeichenwerkzeuge** — Rechteck, Ellipse, Linie, Freihand-Bleistift, Pinsel (11 Formen), Text, Bildrahmen, Wand-Werkzeug, Polygon, Kurven, Rahmen
- **Präzises Arbeiten** — Raster mit Einrasten, Lineale in mm/cm/px/pt/in, exakte Koordinaten- und Größeneingabe
- **Eigenschaften** — Füllung, Kontur, Eckenradien, Schatten, Drehung, Scheren, Transparenz, Textformatierung
- **Ebenen** — mehrere benannte Ebenen, Sichtbarkeit, Sperrung, Drag-and-Drop-Sortierung
- **Formbibliothek** — vordefinierte Formen (Grundformen, technische Symbole u.v.m.) sowie eigene Formen speichern und wiederverwenden
- **SVG-Import** — externe SVG-Dateien als Objekte importieren
- **PDF-Export** — Leinwand als PDF ausgeben
- **Seiten-Setup** — A4, A3, A0 quer und benutzerdefinierte Formate, Hoch-/Querformat
- **Rückgängig/Wiederholen** — vollständige Änderungshistorie
- **Speichern/Laden** — eigenes Dateiformat `.vecstructi` (SQLite-Datenbank)

---

## Technologien

| Ebene | Technologie |
|---|---|
| Desktop-Hülle | Tauri v2 (Rust) |
| Frontend | SvelteKit + Svelte 5 (Runes) |
| Leinwand | SVG |
| Pfad-Operationen | paper.js |
| PDF | jsPDF |
| Datenbank | SQLite via Tauri SQL Plugin |

---

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

---

Siehe auch: [DISCLAIMER.md](DISCLAIMER.md) — Haftungsausschluss
