<script lang="ts">
  import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
  import { onMount } from 'svelte';

  let helpPage   = $state(0);
  let helpSearch = $state('');
  let scale      = $state(1);
  let pageAreaEl: HTMLElement;

  // A4 logical dimensions in px (96 dpi)
  const PAGE_W = 794;
  const PAGE_H = 1123;

  const HELP_PAGES = [
    {
      id: 'vorwort',
      title: 'Vorwort',
      content: `<h2>Vorwort</h2>
<p>Meine ersten richtigen Programmierversuche unternahm ich auf einem Atari ST – zu einer Zeit, als Bill Gates und Steve Jobs noch nicht die großen Namen der Branche waren. Schon 1987 bauten wir ein Zeichenprogramm – wir nannten es <strong>King-Paint</strong>, denn wir wollten ja nicht kleckern, sondern klotzen. Es hatte über 7.500 Zeilen Quellcode, und wir konnten es tatsächlich zweimal an einen Radio- und Fernsehhändler verkaufen. Wir sind vor Stolz fast geplatzt.</p>
<p>Ein herzliches Dankeschön geht an Wolfgang, der mir in über 30 Jahren Computerfreundschaft so vieles beigebracht hat – auch wenn man in letzter Zeit leider wenig von ihm hört. An Peter für die vielen „Klick-und-Klau"-Tipps und die zahlreichen gemeinsamen FileMaker-Projekte, die mir stets viel Freude bereitet haben. An Melchior und Hans, mit denen ich viele schöne Stunden am Computer verbringen durfte. Und an Alfred – den „Bullentöter“ und seinen Kollegen –, der immer der rettende Nagel in letzter Not war. Danke für die vielen schönen Gespräche und Kaffeestunden, die das alles erst so unvergesslich gemacht haben. Ein Dankeschön gilt auch allen anderen, die oft viel Rücksicht nehmen mussten, weil mein Computerhobby einen beträchtlichen Teil meiner Zeit in Anspruch nahm.</p>
<p>Ich durfte dabei sein und die Computerwelt von ihren Anfängen an miterleben – vom Commodore 64 über Apple und VisiCalc, Turbo Pascal und Borland, bis hin zum heutigen Mac mit M4 und künstlicher Intelligenz. Dafür bin ich unendlich dankbar. Es waren viele unvergessliche Momente, die ich in all diesen Jahren erleben durfte.</p>
<p>Inzwischen bin ich fast 72 Jahre alt – und es macht immer noch genauso viel Spaß wie am ersten Tag, am Mac neue Ideen zu entdecken und umzusetzen.</p>
<p style="margin-top:32px; text-align:right; font-style:italic; color:#444;">Nikolaus, im Mai 2026</p>`
    },
    {
      id: 'toc',
      title: 'Inhaltsverzeichnis',
      content: `<h2>Inhaltsverzeichnis</h2>
<ul class="help-toc-list">
  <li><a href="#" data-page="2">1. Programmübersicht</a></li>
  <li><a href="#" data-page="3">2. Benutzeroberfläche</a></li>
  <li><a href="#" data-page="4">3. Werkzeuge – Auswahl &amp; Grundformen</a></li>
  <li><a href="#" data-page="5">4. Textwerkzeug</a></li>
  <li><a href="#" data-page="6">5. Bildwerkzeug</a></li>
  <li><a href="#" data-page="7">6. Messwerkzeug</a></li>
  <li><a href="#" data-page="8">7. Ebenen</a></li>
  <li><a href="#" data-page="9">8. Eigenschaften &amp; Formatierung</a></li>
  <li><a href="#" data-page="10">9. Raster &amp; Fang</a></li>
  <li><a href="#" data-page="11">10. Dateioperationen &amp; Export</a></li>
  <li><a href="#" data-page="12">11. Tastaturkürzel</a></li>
</ul>`
    },
    {
      id: 'overview',
      title: '1. Programmübersicht',
      content: `<h2>1. Programmübersicht</h2>
<p>Vecstructi ist ein vektorbasiertes Zeichen- und Layoutprogramm, das für technische Zeichnungen, Grundrisse und strukturierte Grafiken optimiert ist. Es arbeitet intern mit Mikrometergenauigkeit und speichert Dokumente in einem SQLite-Format (<code>.vcs</code>).</p>
<h3>Hauptmerkmale</h3>
<ul>
  <li><strong>Vektorgrafik:</strong> Alle Objekte (Linien, Rechtecke, Kreise, Text, Bilder) werden verlustfrei skaliert.</li>
  <li><strong>SQLite-Dokument:</strong> Das Dateiformat <code>.vcs</code> ist eine SQLite-Datenbank. Alle Objekte, Ebenen und Einstellungen sind darin strukturiert gespeichert.</li>
  <li><strong>Mikrometergenauigkeit:</strong> Intern werden alle Maße in Mikrometern (µm) gespeichert, was präzise Ausgaben bis in den Sub-Millimeterbereich ermöglicht.</li>
  <li><strong>Ebenenstruktur:</strong> Objekte können auf benannten, ein- und ausblendbaren Ebenen organisiert werden.</li>
  <li><strong>Rich-Text:</strong> Textobjekte unterstützen Fett, Kursiv, Unterstrichen sowie individuelle Schriftgrößen und -farben innerhalb desselben Textkörpers.</li>
  <li><strong>PDF-Export:</strong> Das aktuelle Dokument kann als PDF in DIN-A-Formaten exportiert werden.</li>
  <li><strong>Undo/Redo:</strong> Alle Änderungen sind mehrfach rückgängig machbar.</li>
</ul>
<h3>Systemvoraussetzungen</h3>
<p>Vecstructi ist eine Desktop-Anwendung auf Basis von Tauri (Rust + WebView). Es läuft auf macOS, Windows und Linux. Eine Internetverbindung ist nicht erforderlich.</p>`
    },
    {
      id: 'ui',
      title: '2. Benutzeroberfläche',
      content: `<h2>2. Benutzeroberfläche</h2>
<p>Die Oberfläche gliedert sich in fünf Bereiche:</p>
<h3>2.1 Menüleiste (oben)</h3>
<p>Die Menüleiste enthält die Hauptmenüs: <strong>Vecstructi</strong> (Über, Beenden), <strong>Datei</strong> (Neu, Öffnen, Speichern, PDF-Export), <strong>Bearbeiten</strong> (Undo/Redo, Kopieren, Einfügen), <strong>Anordnen</strong> (Z-Reihenfolge, Ausrichten, Gruppieren), <strong>Ansicht</strong> (Zoom, Vollbild) und <strong>Hilfe</strong>.</p>
<h3>2.2 Werkzeugleiste (links)</h3>
<p>Die vertikale Werkzeugleiste links enthält alle Zeichenwerkzeuge. Das aktive Werkzeug ist blau hervorgehoben. Mit einem Klick auf ein Werkzeug aktivieren Sie es; einige Werkzeuge zeigen beim Klick einen Auswahl-Popup (z.&nbsp;B. Bild, Messen).</p>
<h3>2.3 Zeichenfläche (Mitte)</h3>
<p>Die weiße Fläche in der Mitte stellt das Dokument dar. Hier zeichnen, verschieben und bearbeiten Sie Objekte. Über der Zeichenfläche wird die aktuelle Mausposition in der gewählten Maßeinheit angezeigt.</p>
<h3>2.4 Eigenschaftenpanel (rechts)</h3>
<p>Das rechte Panel zeigt kontextsensitiv die Eigenschaften des aktuell ausgewählten Objekts: Position, Größe, Farbe, Linienstärke, Deckkraft, Schatten, Eckenradien u.&nbsp;v.&nbsp;m.</p>
<h3>2.5 Ebenen-Panel (rechts unten)</h3>
<p>Unterhalb des Eigenschaftenpanels befinden sich die Ebenen. Ebenen können sichtbar/unsichtbar geschaltet, gesperrt, umbenannt, hinzugefügt und gelöscht werden.</p>
<h3>2.6 Statuszeile</h3>
<p>Ganz unten werden Zoom-Faktor, Rasterinformationen und die Mausposition angezeigt.</p>`
    },
    {
      id: 'tools-basic',
      title: '3. Werkzeuge – Auswahl & Grundformen',
      content: `<h2>3. Werkzeuge – Auswahl &amp; Grundformen</h2>
<h3>3.1 Auswahlwerkzeug (Pfeil / V)</h3>
<p>Das Auswahlwerkzeug ist das Standardwerkzeug. Damit können Sie:</p>
<ul>
  <li>Objekte durch einfachen Klick auswählen.</li>
  <li>Mehrere Objekte durch Aufziehen einer Auswahlbox (Rubber-Band-Selektion) gleichzeitig auswählen.</li>
  <li>Ausgewählte Objekte durch Ziehen verschieben.</li>
  <li>Ausgewählte Objekte durch Ziehen der Eckpunkte (Handles) skalieren.</li>
  <li>Durch Klick auf freie Fläche die Auswahl aufheben.</li>
</ul>
<p><strong>Tastaturkürzel:</strong> <kbd>V</kbd> oder <kbd>Esc</kbd> aktiviert das Auswahlwerkzeug.</p>
<h3>3.2 Linie (L)</h3>
<p>Zeichnet eine gerade Linie. Klicken Sie auf den Startpunkt, halten Sie die Maustaste gedrückt und ziehen Sie zum Endpunkt. Mit gedrückter <kbd>Shift</kbd>-Taste wird die Linie auf 0°, 45° oder 90° eingeschränkt.</p>
<h3>3.3 Rechteck (R)</h3>
<p>Zeichnet ein Rechteck durch Aufziehen. Mit gedrückter <kbd>Shift</kbd>-Taste entsteht ein Quadrat. Eckenradien können nachträglich im Eigenschaftenpanel eingestellt werden.</p>
<h3>3.4 Kreis / Ellipse (E)</h3>
<p>Zeichnet eine Ellipse durch Aufziehen des umschließenden Rechtecks. Mit gedrückter <kbd>Shift</kbd>-Taste entsteht ein Kreis.</p>
<h3>3.5 Freie Form / Polygon</h3>
<p>Zeichnet ein Vieleck durch sukzessives Klicken der Eckpunkte. Ein Doppelklick schließt die Form. Die Form kann offen (Pfad) oder geschlossen (Fläche) sein.</p>
<h3>3.6 Zoom-Werkzeug (Z)</h3>
<p>Klicken auf die Zeichenfläche vergrößert die Ansicht um eine Stufe. Mit gedrückter <kbd>Alt</kbd>-Taste wird herausgezoomt. Alternativ zoomen Sie mit dem Mausrad oder über Menü → Ansicht.</p>`
    },
    {
      id: 'text',
      title: '4. Textwerkzeug',
      content: `<h2>4. Textwerkzeug</h2>
<h3>4.1 Text erstellen</h3>
<p>Aktivieren Sie das Textwerkzeug (<kbd>T</kbd>). Klicken und ziehen Sie auf der Zeichenfläche, um einen Textrahmen aufzuspannen. Nach dem Loslassen der Maustaste wird der Textrahmen aktiv und Sie können sofort mit der Eingabe beginnen.</p>
<h3>4.2 Text bearbeiten</h3>
<p>Doppelklicken Sie auf ein vorhandenes Textobjekt, um es zu bearbeiten. Der Rahmen wechselt in den Bearbeitungsmodus:</p>
<ul>
  <li>Der Text kann normal getippt und mit den Pfeiltasten navigiert werden.</li>
  <li>Mit <kbd>Strg+A</kbd> wird der gesamte Text ausgewählt.</li>
  <li>Zum Beenden der Bearbeitung klicken Sie außerhalb des Rahmens oder drücken <kbd>Esc</kbd>.</li>
</ul>
<h3>4.3 Rich-Text-Formatierung</h3>
<p>Im Bearbeitungsmodus kann Text formatiert werden. Markieren Sie den gewünschten Text-Abschnitt und wenden Sie folgende Formatierungen an:</p>
<ul>
  <li><strong>Fett</strong> (<kbd>Strg+B</kbd>)</li>
  <li><em>Kursiv</em> (<kbd>Strg+I</kbd>)</li>
  <li><u>Unterstrichen</u> (<kbd>Strg+U</kbd>)</li>
  <li>Schriftgröße: Eingabe im Feld „Schriftgröße" im Eigenschaftenpanel.</li>
  <li>Schriftfarbe: Farbwähler im Eigenschaftenpanel.</li>
</ul>
<h3>4.4 Textausrichtung</h3>
<p>Die horizontale Textausrichtung (links, zentriert, rechts, Blocksatz) wird im Eigenschaftenpanel eingestellt.</p>
<h3>4.5 Schriftschatten</h3>
<p>Im Eigenschaftenpanel kann ein Textschatten aktiviert werden. Einstellbar sind Farbe, Versatz (X/Y) und Unschärferadius.</p>
<h3>4.6 Zoom und Texte</h3>
<p>Texte werden als HTML-Overlay über der SVG-Zeichenfläche dargestellt. Die Schriftgrößen werden automatisch mit dem Zoom-Faktor skaliert, sodass die Darstellung beim Zoomen immer maßstabsgetreu bleibt.</p>`
    },
    {
      id: 'image',
      title: '5. Bildwerkzeug',
      content: `<h2>5. Bildwerkzeug</h2>
<h3>5.1 Bildrahmen erstellen</h3>
<p>Aktivieren Sie das Bildwerkzeug. Beim Klick auf das Werkzeugsymbol öffnet sich zunächst ein kleines Auswahl-Popup direkt neben dem Mauszeiger. Wählen Sie hier die gewünschte Rahmenform:</p>
<ul>
  <li><strong>Rechteck:</strong> Das Bild wird in einem rechteckigen Rahmen platziert.</li>
  <li><strong>Ellipse:</strong> Das Bild wird kreisförmig/elliptisch beschnitten.</li>
</ul>
<p>Nach der Auswahl ziehen Sie auf der Zeichenfläche einen Rahmen auf, der die spätere Bildgröße und -position definiert.</p>
<h3>5.2 Bild einfügen (Doppelklick)</h3>
<p>Ein leerer Bildrahmen zeigt einen Platzhalter. Um das eigentliche Bild einzufügen:</p>
<ol>
  <li>Doppelklicken Sie auf den Bildrahmen.</li>
  <li>Es öffnet sich der Datei-Browser des Betriebssystems.</li>
  <li>Wählen Sie eine Bilddatei aus (PNG, JPEG, GIF, WebP, SVG).</li>
  <li>Das Bild wird in das Dokument eingebettet und im Rahmen angezeigt.</li>
</ol>
<p><strong>Hinweis:</strong> Bilder werden als Base64-Daten in der <code>.vcs</code>-Datei gespeichert. Große Bilder können die Dateigröße erhöhen.</p>
<h3>5.3 Bild skalieren und positionieren</h3>
<p>Wählen Sie den Bildrahmen mit dem Auswahlwerkzeug. Die Handles an den Ecken und Seiten erlauben das Skalieren. Im Eigenschaftenpanel können Sie Position und Größe numerisch eingeben.</p>
<h3>5.4 Bild ersetzen</h3>
<p>Doppelklicken Sie erneut auf einen Bildrahmen mit Bild, um ein neues Bild auszuwählen und das vorhandene zu ersetzen.</p>
<h3>5.5 Bildanpassung</h3>
<p>Im Eigenschaftenpanel finden Sie die Option „Einpassen": Das Bild wird so skaliert, dass es den Rahmen optimal ausfüllt (Cover) oder vollständig sichtbar ist (Contain).</p>`
    },
    {
      id: 'measure',
      title: '6. Messwerkzeug',
      content: `<h2>6. Messwerkzeug</h2>
<h3>6.1 Werkzeug aktivieren</h3>
<p>Klicken Sie in der Werkzeugleiste auf das Messwerkzeug (Lineal-Symbol). Es öffnet sich ein kleines Popup direkt neben dem Mauszeiger, in dem Sie die Maßeinheit auswählen:</p>
<ul>
  <li><strong>mm</strong> – Millimeter (Standard)</li>
  <li><strong>cm</strong> – Zentimeter</li>
  <li><strong>px</strong> – Pixel</li>
</ul>
<p>Nach der Auswahl wird das Messwerkzeug aktiv und das Popup schließt sich.</p>
<h3>6.2 Messung durchführen</h3>
<ol>
  <li>Klicken Sie auf den Startpunkt der Messung auf der Zeichenfläche.</li>
  <li>Halten Sie die Maustaste gedrückt und ziehen Sie zum Endpunkt.</li>
  <li>Während des Ziehens wird eine rote Messlinie mit Pfeilspitzen an beiden Enden angezeigt.</li>
  <li>Der gemessene Abstand wird als Beschriftung in der Mitte der Linie eingeblendet.</li>
  <li>Lassen Sie die Maustaste los, um die Messung abzuschließen.</li>
</ol>
<h3>6.3 Raster-Fang beim Messen</h3>
<p>Wenn das Raster aktiv ist und „Am Raster ausrichten" eingeschaltet ist, fängt das Messwerkzeug die Punkte am nächsten Rasterpunkt.</p>
<h3>6.4 Messung in 45°-Schritten</h3>
<p>Halten Sie beim Ziehen die <kbd>Shift</kbd>-Taste gedrückt, um die Messlinie auf horizontal (0°) oder vertikal (90°) einzuschränken.</p>
<h3>6.5 Einheit wechseln</h3>
<p>Klicken Sie erneut auf das Messwerkzeug, um das Einheiten-Popup zu öffnen und die Einheit zu ändern. Die aktuelle Messung wird verworfen.</p>
<p><strong>Hinweis:</strong> Das Messwerkzeug speichert keine Objekte. Die Messung verschwindet, sobald ein anderes Werkzeug aktiviert wird.</p>`
    },
    {
      id: 'layers',
      title: '7. Ebenen',
      content: `<h2>7. Ebenen</h2>
<h3>7.1 Ebenenpanel</h3>
<p>Das Ebenenpanel befindet sich im rechten Bereich der Oberfläche. Es zeigt alle vorhandenen Ebenen des Dokuments von oben (vorderste Ebene) nach unten (hinterste Ebene).</p>
<h3>7.2 Ebene erstellen</h3>
<p>Klicken Sie auf das „+"-Symbol im Ebenenpanel, um eine neue Ebene hinzuzufügen. Die neue Ebene wird über der aktuell aktiven Ebene eingefügt und erhält automatisch einen Namen (z.&nbsp;B. „Ebene 2").</p>
<h3>7.3 Ebene umbenennen</h3>
<p>Doppelklicken Sie auf den Ebenennamen, um ihn zu bearbeiten. Bestätigen Sie mit <kbd>Enter</kbd> oder klicken Sie außerhalb des Feldes.</p>
<h3>7.4 Ebene ein-/ausblenden</h3>
<p>Das Augensymbol links neben dem Ebenennamen schaltet die Sichtbarkeit der Ebene um. Ausgeblendete Ebenen werden in der Zeichenfläche nicht angezeigt und können nicht ausgewählt werden.</p>
<h3>7.5 Ebene sperren</h3>
<p>Das Schloss-Symbol neben dem Augensymbol sperrt eine Ebene. Objekte auf gesperrten Ebenen können nicht ausgewählt, verschoben oder bearbeitet werden.</p>
<h3>7.6 Ebene löschen</h3>
<p>Klicken Sie auf das Papierkorb-Symbol neben dem Ebenennamen. <strong>Achtung:</strong> Alle Objekte auf der Ebene werden unwiderruflich gelöscht. Die letzte verbleibende Ebene kann nicht gelöscht werden.</p>
<h3>7.7 Ebenenreihenfolge ändern</h3>
<p>Ebenen können per Drag &amp; Drop in ihrer Reihenfolge verschoben werden. Die oberste Ebene im Panel entspricht der vordersten Zeichenebene.</p>
<h3>7.8 Aktive Ebene</h3>
<p>Neue Objekte werden immer auf der aktuell aktiven Ebene erstellt. Die aktive Ebene ist im Panel hervorgehoben. Klicken Sie auf eine Ebene, um sie zu aktivieren.</p>
<h3>7.9 Raster-Ebene</h3>
<p>Die „Raster"-Ebene ist eine spezielle Systemebene, die das Hintergrundraster enthält. Sie kann ein-/ausgeblendet, aber nicht manuell bearbeitet werden.</p>`
    },
    {
      id: 'properties',
      title: '8. Eigenschaften & Formatierung',
      content: `<h2>8. Eigenschaften &amp; Formatierung</h2>
<p>Das Eigenschaftenpanel rechts zeigt alle änderbaren Eigenschaften des ausgewählten Objekts.</p>
<h3>8.1 Position und Größe</h3>
<p>Die Felder X, Y, B (Breite) und H (Höhe) zeigen die Position und Größe des Objekts in der aktuellen Maßeinheit. Werte können direkt eingegeben werden. Der Ursprungspunkt (0,0) liegt standardmäßig oben links auf der Zeichenfläche.</p>
<h3>8.2 Füllfarbe</h3>
<p>Klicken Sie auf das Farbfeld, um den Farbwähler zu öffnen. Sie können eine Farbe visuell wählen oder einen Hex-Wert eingeben. Die Deckkraft der Füllung wird separat eingestellt.</p>
<h3>8.3 Linienfarbe und -stärke</h3>
<p>Für Linien, Rechtecke und andere Formen können Randfarbe und Randstärke (in Pixeln) eingestellt werden. Eine Randstärke von 0 erzeugt keinen sichtbaren Rand.</p>
<h3>8.4 Deckkraft</h3>
<p>Der Schieberegler „Deckkraft" steuert die Transparenz des gesamten Objekts (0% = unsichtbar, 100% = undurchsichtig).</p>
<h3>8.5 Eckenradius (Rechteck)</h3>
<p>Für Rechtecke können alle vier Eckenradien individuell oder gemeinsam eingestellt werden. Die Einheit ist Millimeter.</p>
<h3>8.6 Schatten</h3>
<p>Aktivieren Sie den Schatten über den Umschalter im Eigenschaftenpanel. Einstellbar sind:</p>
<ul>
  <li><strong>Farbe:</strong> Schattenfarbe (Standard: Schwarz).</li>
  <li><strong>X-Versatz / Y-Versatz:</strong> Horizontale und vertikale Verschiebung des Schattens in mm.</li>
  <li><strong>Unschärfe:</strong> Weichzeichnungsradius des Schattens.</li>
</ul>
<h3>8.7 Objektebene</h3>
<p>Im Eigenschaftenpanel wird die Ebene angezeigt, auf der sich das Objekt befindet. Über das Dropdown kann das Objekt auf eine andere Ebene verschoben werden.</p>
<h3>8.8 Anordnen</h3>
<p>Über das Menü „Anordnen" oder Tastaturkürzel können Sie Objekte in der Z-Reihenfolge verschieben: ganz nach vorne, eine Ebene vor, eine Ebene zurück, ganz nach hinten.</p>`
    },
    {
      id: 'grid',
      title: '9. Raster & Fang',
      content: `<h2>9. Raster &amp; Fang</h2>
<h3>9.1 Raster einschalten</h3>
<p>Das Raster wird über die Schaltfläche „Raster" in der Werkzeugleiste oder über Menü → Ansicht → Raster ein- und ausgeschaltet. Das Raster ist eine visuelle Hilfslinie und wird nicht in den Export übernommen.</p>
<h3>9.2 Rastereinstellungen</h3>
<p>Die Rastereinstellungen befinden sich im Setup-Dialog (Menü → Datei → Einstellungen oder beim Erstellen eines neuen Dokuments):</p>
<ul>
  <li><strong>Raster X-Abstand:</strong> Horizontaler Abstand zwischen den Hauptrasterlinien in mm.</li>
  <li><strong>Raster Y-Abstand:</strong> Vertikaler Abstand zwischen den Hauptrasterlinien in mm.</li>
  <li><strong>Unterteilungen:</strong> Anzahl der Unterabschnitte zwischen den Hauptrasterlinien.</li>
</ul>
<h3>9.3 Am Raster ausrichten (Fang)</h3>
<p>Wenn „Am Raster ausrichten" aktiv ist (Magnet-Symbol in der Werkzeugleiste), rasten alle Zeichenoperationen am nächsten Rasterpunkt ein. Dies gilt für neue Objekte zeichnen, verschieben, skalieren und Messpunkte beim Messwerkzeug.</p>
<h3>9.4 Raster und Maßstab</h3>
<p>Der Rasterabstand ist in Millimetern definiert und bleibt beim Zoomen relativ zur Zeichenfläche konstant. Bei sehr kleinen Zoom-Stufen können Rasterlinien zu dicht werden – das Raster blendet sich bei geringem Abstand automatisch aus.</p>
<h3>9.5 Koordinatenanzeige</h3>
<p>Die aktuelle Mausposition wird oben über der Zeichenfläche in der gewählten Einheit (mm, cm oder px) angezeigt. Die Position bezieht sich auf den Ursprungspunkt oben links der Zeichenfläche.</p>`
    },
    {
      id: 'file',
      title: '10. Dateioperationen & Export',
      content: `<h2>10. Dateioperationen &amp; Export</h2>
<h3>10.1 Neues Dokument (Strg+N)</h3>
<p>Erstellt ein neues, leeres Dokument. Es erscheint zunächst ein Setup-Dialog, in dem Sie Dokumentname, Papierformat, Rastereinstellungen und Genauigkeit festlegen.</p>
<h3>10.2 Öffnen (Strg+O)</h3>
<p>Öffnet den Datei-Browser, um eine vorhandene <code>.vcs</code>-Datei zu laden.</p>
<h3>10.3 Importieren</h3>
<p>Importiert Objekte aus einer anderen <code>.vcs</code>-Datei in das aktuelle Dokument. Die importierten Objekte werden auf der aktuell aktiven Ebene eingefügt.</p>
<h3>10.4 Speichern (Strg+S)</h3>
<p>Speichert das aktuelle Dokument in der zugehörigen <code>.vcs</code>-Datei. Falls das Dokument noch nicht gespeichert wurde, erscheint der „Speichern unter"-Dialog.</p>
<h3>10.5 Speichern unter (Strg+Umschalt+S)</h3>
<p>Öffnet den Datei-Browser, um das Dokument unter einem neuen Namen oder an einem neuen Ort zu speichern.</p>
<h3>10.6 PDF-Export</h3>
<p>Über Menü → Datei → PDF-Export öffnet sich der PDF-Export-Dialog mit Einstellungen für Papierformat (DIN A0–A5), Ränder und optionale Rasterdarstellung.</p>
<h3>10.7 Dateiformat .vcs</h3>
<p>Das Format <code>.vcs</code> ist eine SQLite-3-Datenbank. Es enthält alle Objekte, Ebenen, Metadaten und eingebettete Bilder. Die Datei kann mit jedem SQLite-Browser untersucht werden.</p>`
    },
    {
      id: 'shortcuts',
      title: '11. Tastaturkürzel',
      content: `<h2>11. Tastaturkürzel</h2>
<table class="help-shortcuts-table">
  <thead><tr><th>Kürzel</th><th>Aktion</th></tr></thead>
  <tbody>
    <tr><td><kbd>V</kbd> / <kbd>Esc</kbd></td><td>Auswahlwerkzeug aktivieren</td></tr>
    <tr><td><kbd>L</kbd></td><td>Linienwerkzeug</td></tr>
    <tr><td><kbd>R</kbd></td><td>Rechteckwerkzeug</td></tr>
    <tr><td><kbd>E</kbd></td><td>Ellipsenwerkzeug</td></tr>
    <tr><td><kbd>T</kbd></td><td>Textwerkzeug</td></tr>
    <tr><td><kbd>Z</kbd></td><td>Zoomwerkzeug</td></tr>
    <tr><td><kbd>Strg+Z</kbd></td><td>Rückgängig</td></tr>
    <tr><td><kbd>Strg+Y</kbd> / <kbd>Strg+Shift+Z</kbd></td><td>Wiederholen</td></tr>
    <tr><td><kbd>Strg+X</kbd></td><td>Ausschneiden</td></tr>
    <tr><td><kbd>Strg+C</kbd></td><td>Kopieren</td></tr>
    <tr><td><kbd>Strg+V</kbd></td><td>Einfügen</td></tr>
    <tr><td><kbd>Strg+A</kbd></td><td>Alles auswählen</td></tr>
    <tr><td><kbd>Entf</kbd> / <kbd>Backspace</kbd></td><td>Ausgewählte Objekte löschen</td></tr>
    <tr><td><kbd>Strg+N</kbd></td><td>Neues Dokument</td></tr>
    <tr><td><kbd>Strg+O</kbd></td><td>Dokument öffnen</td></tr>
    <tr><td><kbd>Strg+S</kbd></td><td>Speichern</td></tr>
    <tr><td><kbd>Strg+Shift+S</kbd></td><td>Speichern unter</td></tr>
    <tr><td><kbd>Strg+G</kbd></td><td>Gruppieren</td></tr>
    <tr><td><kbd>Strg+Shift+G</kbd></td><td>Gruppe auflösen</td></tr>
    <tr><td><kbd>Pfeiltasten</kbd></td><td>Ausgewähltes Objekt 1 Einheit verschieben</td></tr>
    <tr><td><kbd>Shift+Pfeiltasten</kbd></td><td>Ausgewähltes Objekt 10 Einheiten verschieben</td></tr>
    <tr><td><kbd>Mausrad</kbd></td><td>Zoomen</td></tr>
    <tr><td><kbd>Strg+B</kbd></td><td>Fett (im Texteditor)</td></tr>
    <tr><td><kbd>Strg+I</kbd></td><td>Kursiv (im Texteditor)</td></tr>
    <tr><td><kbd>Strg+U</kbd></td><td>Unterstrichen (im Texteditor)</td></tr>
    <tr><td><kbd>Shift</kbd> (beim Zeichnen)</td><td>Linie/Form auf 45°-Schritte einschränken</td></tr>
  </tbody>
</table>`
    }
  ];

  const helpFiltered = $derived(helpSearch.trim().length > 1
    ? HELP_PAGES.filter(p => p.title.toLowerCase().includes(helpSearch.toLowerCase()) || p.content.toLowerCase().includes(helpSearch.toLowerCase()))
    : HELP_PAGES);
  const helpCurrent = $derived(helpFiltered[helpPage] ?? helpFiltered[0]);
  const helpTotal   = $derived(helpFiltered.length);

  function close() { getCurrentWebviewWindow().close(); }

  onMount(() => {
    const win = getCurrentWebviewWindow();
    let unlisten: (() => void) | undefined;
    win.onCloseRequested(() => win.close()).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  });

  onMount(() => {
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const sw = (width  - 32) / PAGE_W;
      const sh = (height - 32) / PAGE_H;
      scale = Math.min(sw, sh);
    });
    ro.observe(pageAreaEl);
    return () => ro.disconnect();
  });
</script>

<svelte:head>
  <title>Vecstructi – Handbuch</title>
</svelte:head>

<div class="help-window">
  <!-- Kopfzeile -->
  <div class="help-header" data-tauri-drag-region>
    <div class="help-header-left">
      <span class="help-logo">V</span>
      <span class="help-title">Vecstructi – Handbuch</span>
    </div>
    <div class="help-header-center">
      <input class="help-search" type="text" placeholder="Suche …" bind:value={helpSearch} oninput={() => helpPage = 0} />
    </div>
    <div class="help-header-right">
      <button class="help-close-btn" onclick={close}>✕</button>
    </div>
  </div>

  <!-- Hauptbereich: Sidebar + Inhalt -->
  <div class="help-body">
    <nav class="help-nav">
      {#each helpFiltered as pg, i}
        <button class="help-nav-item" class:help-nav-active={i === helpPage} onclick={() => helpPage = i}>{pg.title}</button>
      {/each}
    </nav>

    <!-- rechte Spalte: Seitenbereich + Blätter-Buttons -->
    <div class="help-content-col">
      <!-- Seitenbereich – ResizeObserver läuft hier -->
      <div class="help-page-area" bind:this={pageAreaEl}>
        <!-- Platzhalter in skalierter Größe, zentriert den Inhalt -->
        <div class="help-page-outer" style="width:{PAGE_W * scale}px; height:{PAGE_H * scale}px;">
          <div class="help-page" style="transform: scale({scale}); transform-origin: top left;">
            <div class="help-page-content" onclick={(e) => {
              const a = (e.target as HTMLElement).closest('a[data-page]') as HTMLAnchorElement | null;
              if (a) { e.preventDefault(); const idx = parseInt(a.dataset.page ?? '0'); const target = helpFiltered.findIndex(p => p === HELP_PAGES[idx]); if (target >= 0) helpPage = target; }
            }}>
              {@html helpCurrent?.content ?? ''}
            </div>
            <div class="help-footer">
              <span>Vecstructi Handbuch</span>
              <span>Seite {helpPage + 1} / {helpTotal}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Blätter-Navigation -->
      <div class="help-nav-btns">
        <button class="help-nav-arrow" disabled={helpPage === 0} onclick={() => helpPage = Math.max(0, helpPage - 1)}>‹ Zurück</button>
        <span class="help-nav-info">{helpPage + 1} / {helpTotal}</span>
        <button class="help-nav-arrow" disabled={helpPage >= helpTotal - 1} onclick={() => helpPage = Math.min(helpTotal - 1, helpPage + 1)}>Weiter ›</button>
      </div>
    </div>
  </div>
</div>

<style>
  @font-face { font-family: "CMU Serif"; font-style: roman;  font-weight: 500; src: url("/fonts/cmu-serif-500-roman.woff2")  format("woff2"); }
  @font-face { font-family: "CMU Serif"; font-style: italic; font-weight: 500; src: url("/fonts/cmu-serif-500-italic.woff2") format("woff2"); }
  @font-face { font-family: "CMU Serif"; font-style: roman;  font-weight: 700; src: url("/fonts/cmu-serif-700-roman.woff2")  format("woff2"); }
  @font-face { font-family: "CMU Serif"; font-style: italic; font-weight: 700; src: url("/fonts/cmu-serif-700-italic.woff2") format("woff2"); }

  :global(*, *::before, *::after) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(html, body) { height: 100%; overflow: hidden; background: #1e2433; }

  .help-window {
    display: flex; flex-direction: column;
    height: 100vh; width: 100vw;
    background: #f5f5f0; color: #1a1a1a;
    font-family: "CMU Serif", "Computer Modern", Georgia, serif;
    overflow: hidden;
  }

  /* Header */
  .help-header {
    background: #1e2433; color: #ccd6e0;
    padding: 10px 16px;
    display: flex; align-items: center; gap: 12px;
    flex-shrink: 0; border-bottom: 1px solid #2d3a50;
    cursor: grab;
  }
  .help-header:active { cursor: grabbing; }
  .help-header-left  { display: flex; align-items: center; gap: 8px; flex: 1; }
  .help-logo { width: 28px; height: 28px; background: #3b82f6; border-radius: 5px; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 15px; color: #fff; flex-shrink: 0; }
  .help-title { font-size: 14px; font-weight: 600; color: #e0e8f0; letter-spacing: .3px; }
  .help-header-center { flex: 1; display: flex; justify-content: center; }
  .help-search { width: 220px; background: #151c2b; border: 1px solid #2d3a50; border-radius: 16px; color: #ccd6e0; font-size: 12px; padding: 5px 14px; outline: none; font-family: inherit; }
  .help-search:focus { border-color: #3b82f6; }
  .help-header-right  { flex: 1; display: flex; justify-content: flex-end; }
  .help-close-btn { background: none; border: none; color: #8899aa; font-size: 16px; cursor: pointer; padding: 4px 8px; border-radius: 4px; }
  .help-close-btn:hover { background: rgba(255,255,255,.1); color: #fff; }

  /* Body */
  .help-body { display: flex; flex: 1; overflow: hidden; }

  /* Sidebar */
  .help-nav { width: 200px; flex-shrink: 0; background: #e8e8e2; border-right: 1px solid #ccc; overflow-y: auto; padding: 8px 0; font-family: "CMU Serif", "Computer Modern", Georgia, serif; }
  .help-nav-item { display: block; width: 100%; text-align: left; background: none; border: none; border-left: 3px solid transparent; padding: 7px 14px; font-size: 12px; color: #333; cursor: pointer; line-height: 1.4; font-family: inherit; }
  .help-nav-item:hover { background: #d8d8d0; color: #000; }
  .help-nav-active { border-left-color: #3b82f6 !important; background: #dde8f8 !important; color: #1a4a90 !important; font-weight: 600; }

  /* Right column */
  .help-content-col { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: #ddd; }

  /* Page area – fills available space, centers the scaled page */
  .help-page-area {
    flex: 1; overflow: hidden;
    display: flex; align-items: center; justify-content: center;
  }

  /* Outer placeholder – sized to the SCALED page dimensions (set inline) */
  .help-page-outer { flex-shrink: 0; position: relative; }

  /* A4 page at fixed logical size – scaled via transform (set inline) */
  .help-page {
    width: 794px; height: 1123px;
    background: #fff; color: #1a1a1a;
    padding: 40px 50px 60px;
    position: relative;
    box-shadow: 0 4px 20px rgba(0,0,0,.35);
    box-sizing: border-box;
    font-family: "CMU Serif", "Computer Modern", Georgia, serif;
    overflow: hidden;
  }

  /* Content typography */
  :global(.help-page-content h2) { font-size: 21px; font-weight: 700; color: #1a3a6a; margin: 0 0 14px; border-bottom: 2px solid #3b82f6; padding-bottom: 6px; font-family: "CMU Serif", "Computer Modern", Georgia, serif; }
  :global(.help-page-content h3) { font-size: 15px; font-weight: 700; color: #1a3a6a; margin: 18px 0 6px; font-family: "CMU Serif", "Computer Modern", Georgia, serif; }
  :global(.help-page-content p)  { font-size: 14px; line-height: 1.7; margin: 0 0 10px; color: #111; font-family: "CMU Serif", "Computer Modern", Georgia, serif; }
  :global(.help-page-content ul), :global(.help-page-content ol) { font-size: 14px; line-height: 1.7; margin: 0 0 10px; padding-left: 22px; color: #111; font-family: "CMU Serif", "Computer Modern", Georgia, serif; }
  :global(.help-page-content li) { margin-bottom: 3px; }
  :global(.help-page-content code) { background: #f0f0ec; border: 1px solid #ddd; border-radius: 3px; padding: 1px 5px; font-size: 12px; font-family: "CMU Typewriter Text", "Courier New", monospace; color: #c0392b; }
  :global(.help-page-content kbd)  { background: #e8e8e0; border: 1px solid #aaa; border-radius: 3px; padding: 1px 5px; font-size: 11px; font-family: "CMU Typewriter Text", "Courier New", monospace; color: #333; box-shadow: 0 1px 0 #aaa; }
  :global(.help-page-content a)    { color: #2563eb; text-decoration: underline; cursor: pointer; }
  :global(.help-page-content a:hover) { color: #1a4aaa; }
  :global(.help-toc-list) { list-style: none; padding: 0; margin: 0; }
  :global(.help-toc-list li) { border-bottom: 1px solid #eee; }
  :global(.help-toc-list a)  { display: block; padding: 8px 4px; font-size: 14px; }
  :global(.help-shortcuts-table) { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  :global(.help-shortcuts-table th) { background: #1e3a6a; color: #fff; padding: 7px 12px; text-align: left; font-weight: 600; }
  :global(.help-shortcuts-table td) { padding: 6px 12px; border-bottom: 1px solid #eee; }
  :global(.help-shortcuts-table tr:nth-child(even) td) { background: #f5f5f0; }

  /* Footer inside A4 page */
  .help-footer {
    position: absolute; bottom: 0; left: 0; right: 0;
    padding: 10px 50px; border-top: 1px solid #ddd;
    display: flex; justify-content: space-between;
    font-size: 11px; color: #888; background: #fff;
    font-family: "CMU Serif", "Computer Modern", Georgia, serif;
  }

  /* Nav buttons below page */
  .help-nav-btns { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 10px; flex-shrink: 0; background: #ccc; border-top: 1px solid #bbb; }
  .help-nav-arrow { background: #1e2433; color: #ccd6e0; border: 1px solid #2d3a50; border-radius: 4px; padding: 6px 20px; font-size: 13px; cursor: pointer; font-family: inherit; }
  .help-nav-arrow:hover:not(:disabled) { background: #2a3448; border-color: #3b82f6; color: #6ab0ff; }
  .help-nav-arrow:disabled { opacity: .35; cursor: default; }
  .help-nav-info { font-size: 13px; color: #444; min-width: 60px; text-align: center; }
</style>
