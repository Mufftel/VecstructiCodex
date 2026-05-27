# Projektregeln

1. **Nur ausführen was angewiesen wurde** — nichts mehr, nichts weniger.
2. **Keinen funktionierenden Code ohne explizite Rückfrage ändern.**
3. **Keine langen Analysen** — direkt zur Lösung, minimale Werkzeugaufrufe.
4. **Nicht lamentieren** — keine Erklärungen oder Entschuldigungen, einfach machen.
5. **Abschnitte mit `grep -n "── "` finden** — beide Hauptdateien sind mit `// ──`-Markern versehen:
   - `src/routes/+page.svelte`: Haupt-State, Keyword-Dialog, applyKwProp, openKwDialogAt, kwDialogSubmit, detectKwDialog, pushToPreview, u.v.m.
   - `src/lib/parser.ts`: Interfaces, Parser, Serializer, renderElement (inkl. STEPPER/TOGGLE), generateHTML, Kommando-Interpreter, azContentToLines, u.v.m.

# DSL-Grundregeln (Editor & Parser)

5. **Hauptkommandos enden immer mit `ENDE`** — das gilt für: `FENSTER` (→ `FENSTERENDE`), `NAVIGATOR`, `TEXT`, `BUTTON`, `ZELLE`, `TEXTBOX`, `LIST`, `LINIE`, `RECHTECK`, `KREIS`, `RASTER`, `STEPPER`, `TOGGLE`.
6. **Sub-Elemente** innerhalb von Hauptkommandos dürfen eigene Ende-Bezeichner verwenden (z.B. `BUTTONENDE` für Buttons im NAVIGATOR).
