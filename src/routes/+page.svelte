<script lang="ts">
  import paper from 'paper';
  import { onMount, tick } from 'svelte';
  import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow';
  import { LogicalSize, LogicalPosition } from '@tauri-apps/api/dpi';
  import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
  import { message as dialogMessage, open as dialogOpen, save as dialogSave } from '@tauri-apps/plugin-dialog';
  import { exists, mkdir, readDir, readFile, remove, writeFile } from '@tauri-apps/plugin-fs';
  import { appLocalDataDir, basename, dirname, join } from '@tauri-apps/api/path';
  import { revealItemInDir } from '@tauri-apps/plugin-opener';
  import jsPDF from 'jspdf';
  import html2canvas from 'html2canvas';
  import { DB_PATH, DEFAULT_DOCUMENT_ID, assertDocumentDbEmpty, clearDocumentDb, closeDb, compactDb, deleteObjectsByUid, getDb, getDbPath, initDocumentDb, loadDocumentLayout, loadLayerObjects, loadLineObjects, loadPathObjects, loadRectObjects, loadTextObjects, queueDbWrite, saveDocumentLayout, setDbPath, upsertLineObject, upsertPathObject, upsertRectObject, upsertTextObject, type DocumentLayoutSettings } from '$lib/db';
  import { APP_INFO } from '$lib/appInfo';

  const RULER_PX = 20;
  const CANVAS_PAD = 24;

  // ── Werkzeug-State ────────────────────────────────────────────────────────
  let activeTool        = $state('select');
  let imagePickerOpen   = $state(false);
  let imagePickerX      = $state(0);
  let imagePickerY      = $state(0);
  let imageFrameShape   = $state<'rect'|'circle'>('rect');

  onMount(() => {
    let closing = false;
    let workingDbClearedOnClose = false;
    const win = getCurrentWebviewWindow();
    setDbPath(DB_PATH);
    void resetToEmptyWorkingDocument(false);
    void reloadSavedShapes();
    void (async () => {
      try {
        const appWin = getCurrentWindow();
        const monitor = await currentMonitor();
        if (monitor) {
          const sf = monitor.scaleFactor;
          const screenW = monitor.size.width / sf;
          const screenH = monitor.size.height / sf;
          const x = (screenW - 1230) / 2;
          const y = (screenH - 1000) / 2;
          await appWin.setPosition(new LogicalPosition(x, y));
        }
        await appWin.setSize(new LogicalSize(1230, 1000));
        await appWin.setMinSize(new LogicalSize(780, 800));
      } catch {}
      appVisible = true;
    })();
    const unlistenPromise = win.onCloseRequested(async (event) => {
      if (closing) return;
      event.preventDefault();
      closing = true;
      try {
        const canClose = await confirmCloseWithSave();
        if (!canClose) { closing = false; return; }
        await clearWorkingDb();
        workingDbClearedOnClose = true;
      } finally {
        if (closing) await win.destroy();
      }
    });
    return () => {
      void unlistenPromise.then(unlisten => unlisten());
      if (!workingDbClearedOnClose) void clearWorkingDb();
    };
  });

  // ── Eigenschaften-Panel ───────────────────────────────────────────────────
  let propTab    = $state<'geo'|'fill'|'text'|'align'|'page'|'ebenen'|'formen'>('geo');
  let propX      = $state(0);
  let propY      = $state(0);
  let propW      = $state(0);
  let propH      = $state(0);
  let propShearX = $state(0);
  let propShearY = $state(0);
  let propRot    = $state(0);
  let propPolygonSides = $state(6);
  let propFrameWidth = $state(8);
  let rotateStep = $state(90);
  let rotateDir  = $state<1|-1>(1);
  let propLock       = $state(false);
  let propImageScale = $state(1);
  let imgPanMode     = $state(false);

  // ── Ebenen ────────────────────────────────────────────────────────────────
  interface Ebene { name: string; sichtbar: boolean; gesperrt: boolean; opacity: number; }
  // Interne Reihenfolge = Anzeigereihenfolge: Index 0 = oben, Raster immer am Ende
  let ebenen = $state<Ebene[]>([
    { name: 'Ebene 1', sichtbar: true, gesperrt: false, opacity: 100 },
    { name: 'Raster',  sichtbar: true, gesperrt: false, opacity: 100 },
  ]);
  let aktiveEbene   = $state('Ebene 1');
  let editingEbene  = $state<string|null>(null);
  let dragSrc       = $state<Ebene|null>(null);
  let dragOverIdx   = $state<number|null>(null);
  let dragGhostY    = $state(0);
  let collapsedEbenen = $state<Set<string>>(new Set());

  function toggleEbeneSichtbar(e: Ebene) {
    e.sichtbar = !e.sichtbar;
    if (e.name === 'Raster') rasterEinblenden = e.sichtbar;
    updateRaster();
  }
  function toggleEbeneGesperrt(e: Ebene) { e.gesperrt = !e.gesperrt; }

  function addEbene() {
    const n = `Ebene ${ebenen.filter(e => e.name !== 'Raster').length + 1}`;
    const raster = ebenen.find(e => e.name === 'Raster');
    const other  = ebenen.filter(e => e.name !== 'Raster');
    ebenen = [{ name: n, sichtbar: true, gesperrt: false, opacity: 100 }, ...other, ...(raster ? [raster] : [])];
    aktiveEbene = n;
    updateRaster();
  }

  function deleteEbene(e: Ebene) {
    if (e.name === 'Raster') return;
    ebenen = ebenen.filter(x => x !== e);
    if (aktiveEbene === e.name) aktiveEbene = ebenen.find(x => x.name !== 'Raster')?.name ?? 'Ebene 1';
    updateRaster();
  }


  let ebListEl = $state<HTMLElement | null>(null);

  function onGripDown(ev: MouseEvent, e: Ebene) {
    ev.preventDefault();
    ev.stopPropagation();
    dragSrc = e;

    function calcIdx(y: number): number {
      if (!ebListEl) return 0;
      const rows = [...ebListEl.children].filter(
        el => el.classList.contains('eb-row') && !el.classList.contains('eb-row-raster')
      ) as HTMLElement[];
      if (!rows.length) return 0;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) return i;
      }
      return rows.length - 1;
    }

    function onMove(mv: MouseEvent) {
      dragOverIdx = calcIdx(mv.clientY);
    }

    function onUp(mv: MouseEvent) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const to = calcIdx(mv.clientY);
      if (dragSrc) {
        const raster = ebenen.find(x => x.name === 'Raster');
        const other  = ebenen.filter(x => x.name !== 'Raster');
        const from   = other.indexOf(dragSrc);
        if (from !== -1 && from !== to) {
          other.splice(from, 1);
          other.splice(to, 0, dragSrc);
          ebenen = [...other, ...(raster ? [raster] : [])];
          updateRaster();
        }
      }
      dragSrc = null;
      dragOverIdx = null;
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function renameEbene(e: Ebene, neu: string) {
    const n = neu.trim();
    if (n && n !== 'Raster') {
      if (aktiveEbene === e.name) aktiveEbene = n;
      e.name = n;
      updateRaster();
    }
    editingEbene = null;
  }

  // ── Objekte (gezeichnete Elemente) ──────────────────────────────────────
  interface DrawnRect {
    type: 'RECHTECK';
    x: number; y: number; w: number; h: number;
    fill: string; stroke: string; strokeW: number; strokeDash: string;
    isImageFrame?: boolean; imageShape?: 'rect'|'circle';
    imageUrl?: string; imageFile?: string; imageScale?: number; imageOffsetX?: number; imageOffsetY?: number; imageRenderW?: number; imageRenderH?: number;
    imageMaskD?: string;
    shadowEnabled?: boolean; shadowX?: number; shadowY?: number; shadowBlur?: number; shadowColor?: string;
    uid: string;
    shape?: 'rect' | 'ellipse' | 'polygon' | 'frame';
    polygonSides?: number;
    frameWidth?: number;
    radiusOL: number; radiusOR: number; radiusUL: number; radiusUR: number;
    cornerStyle?: 'round' | 'chamfer' | 'concave';
    shearX?: number; shearY?: number;
    groupId?: string;
    gesperrt?: boolean;
    libraryName?: string;
    rotation: number; ebene: string;
  }
  interface DrawnLine {
    type: 'LINIE';
    x1: number; y1: number; x2: number; y2: number;
    x: number; y: number; w: number; h: number; // Bounding Box (abgeleitet)
    stroke: string; strokeW: number; strokeDash: string;
    fill: string; // leer, für Kompatibilität
    arrowStart: 'none'|'arrow'|'dot'|'tick';
    arrowEnd:   'none'|'arrow'|'dot'|'tick';
    isMasslinie: boolean;
    massText?: string;
    massTextPos?: 'ueber'|'in';
    massFontSize?: number;
    massFontFamily?: string;
    massFontWeight?: 'normal'|'bold';
    massFontStyle?: 'normal'|'italic';
    cornerStyle?: 'round' | 'chamfer' | 'concave';
    shadowEnabled?: boolean; shadowX?: number; shadowY?: number; shadowBlur?: number; shadowColor?: string;
    imageScale?: number; isImageFrame?: boolean; imageUrl?: string;
    groupId?: string;
    gesperrt?: boolean;
    libraryName?: string;
    uid: string; ebene: string; rotation: number;
    radiusOL: number; radiusOR: number; radiusUL: number; radiusUR: number;
  }
  interface DrawnText {
    type: 'TEXT';
    x: number; y: number; w: number; h: number;
    richHtml: string;
    textAlign: 'left'|'center'|'right';
    fill: string;
    lineHeight: number;
    uid: string; ebene: string; rotation: number;
    stroke: string; strokeW: number; strokeDash: string;
    radiusOL: number; radiusOR: number; radiusUL: number; radiusUR: number;
    cornerStyle?: 'round' | 'chamfer' | 'concave';
    shearX?: number; shearY?: number;
    imageScale?: number; isImageFrame?: boolean; imageUrl?: string;
    shadowEnabled?: boolean; shadowX?: number; shadowY?: number; shadowBlur?: number; shadowColor?: string;
    groupId?: string;
    gesperrt?: boolean;
    libraryName?: string;
  }
  interface DrawnPath {
    type: 'PFAD';
    x: number; y: number; w: number; h: number;
    ox: number; oy: number;   // unveränderlicher Ursprung der d-Koordinaten
    isBrush?: boolean;
    isWall?: boolean;
    wallWidth?: number;
    wallHatchSpacing?: number;
    wallHatchType?: 'diagonal' | 'cross' | 'brick' | 'concrete' | 'insulation' | 'none';
    wallHatchColor?: string;
    brushForm?: 'kreis'|'rechteck'|'linie'|'gepunktet'|'faecher'|'airbrush'|'tinte'|'kreide'|'textur'|'zickzack'|'doppellinie';
    brushSize?: number;
    points: {x: number; y: number; t?: number}[];
    d: string;
    glaettung: number;
    isCurve?: boolean;
    curveClosed?: boolean;
    stroke: string; strokeW: number; strokeDash: string;
    fill: string;
    uid: string; ebene: string; rotation: number;
    radiusOL: number; radiusOR: number; radiusUL: number; radiusUR: number;
    cornerStyle?: 'round' | 'chamfer' | 'concave';
    shadowEnabled?: boolean; shadowX?: number; shadowY?: number; shadowBlur?: number; shadowColor?: string;
    shearX?: number; shearY?: number;
    imageScale?: number; isImageFrame?: boolean; imageUrl?: string; imageOffsetX?: number; imageOffsetY?: number; imageFile?: string; imageMaskD?: string;
    groupId?: string;
    gesperrt?: boolean;
    libraryName?: string;
  }
  type DrawnObject = DrawnRect | DrawnLine | DrawnText | DrawnPath;

  function isImageFrameObject(obj: DrawnObject | null | undefined): obj is DrawnRect {
    return !!obj && obj.type === 'RECHTECK' && !!obj.isImageFrame;
  }

  let objects     = $state<DrawnObject[]>([]);
  let selectedObj  = $state<DrawnObject | null>(null);
  let selectedObjs = $state<DrawnObject[]>([]);
  let selRect      = $state<{x1:number;y1:number;x2:number;y2:number}|null>(null);

  // Zeichen-State
  let drawingRect = $state<{x1:number;y1:number;x2:number;y2:number}|null>(null);
  let drawingLine = $state<{x1:number;y1:number;x2:number;y2:number}|null>(null);
  // Messwerkzeug
  let measureUnit        = $state<'px'|'mm'|'cm'>('mm');
  let measurePickerOpen  = $state(false);
  let measurePickerX     = $state(0);
  let measurePickerY     = $state(0);
  async function openHelpWindow() {
    const existing = await WebviewWindow.getByLabel('help');
    if (existing) { await existing.setFocus(); return; }
    new WebviewWindow('help', {
      url: '/help',
      title: 'Vecstructi – Handbuch',
      width: 1000,
      height: 1000,
      minWidth: 1000,
      minHeight: 1000,
      resizable: true,
    });
  }
  let measuringLine      = $state<{x1:number;y1:number;x2:number;y2:number}|null>(null);
  let measuringDragging  = $state(false);
  let drawingPath   = $state<{pts: {x:number;y:number}[]; d: string} | null>(null);
  let drawingCurve  = $state<{x1:number;y1:number;x2:number;y2:number;cx:number;cy:number;d:string} | null>(null);
  let drawingWall   = $state<{pts: {x:number;y:number}[]; preview?: {x:number;y:number}} | null>(null);
  let drawingEraser = $state<{pts: {x:number;y:number}[]; ebene: string} | null>(null);
  let eraserSize    = $state(20);
  interface BrushPt { x: number; y: number; t: number; }
  let drawingBrush  = $state<{pts: BrushPt[]} | null>(null);
  let propBrushSize = $state(10);
  let propWallWidth = $state(10);
  let propWallHatchSpacing = $state(5);
  let propWallHatchType = $state<'diagonal' | 'cross' | 'brick' | 'concrete' | 'insulation' | 'none'>('diagonal');
  let propWallHatchColor = $state('#444444');
  let propBrushForm = $state<'kreis'|'rechteck'|'linie'|'gepunktet'|'faecher'|'airbrush'|'tinte'|'kreide'|'textur'|'zickzack'|'doppellinie'>('kreis');
  let justPlaced  = false; // verhindert dass click nach mouseup selectedObj leert

  // paper.js einmalig initialisieren
  let _paperReady = false;
  function getPaper() {
    if (!_paperReady) {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      paper.setup(c);
      _paperReady = true;
    }
    return paper;
  }

  // paper.js smooth() für Bleistift-Pfade
  // factor 0 = Polylinie, 0.01–0.98 = Stärke der Glättung (Subsampling + smooth)
  function smoothPts(pts: {x:number;y:number}[], factor = 0.5): string {
    if (pts.length < 2) return '';
    // Subsampling: höherer factor = weniger Punkte = glattere Kurve
    const stride = factor <= 0.02 ? 1 : Math.max(1, Math.round(factor * factor * 80));
    const sampled: {x:number;y:number}[] = pts.filter((_, i) => i % stride === 0 || i === pts.length - 1);
    if (sampled.length < 2) return `M${pts[0].x} ${pts[0].y} L${pts[pts.length-1].x} ${pts[pts.length-1].y}`;
    if (factor <= 0.02) {
      return `M${sampled[0].x} ${sampled[0].y}` + sampled.slice(1).map(p => ` L${p.x} ${p.y}`).join('');
    }
    const p = getPaper();
    p.project.clear();
    const path = new p.Path();
    sampled.forEach(pt => path.add(new p.Point(pt.x, pt.y)));
    path.smooth({ type: 'catmull-rom', factor: 0.5 });
    const d = path.pathData;
    p.project.clear();
    return d;
  }

  function curvePathD(pts: {x:number;y:number}[], closed = false): string {
    if (pts.length < 3) return pts.length >= 2 ? `M${pts[0].x} ${pts[0].y} L${pts[1].x} ${pts[1].y}` : '';
    const d = `M${pts[0].x} ${pts[0].y} Q${pts[1].x} ${pts[1].y} ${pts[2].x} ${pts[2].y}`;
    return closed ? `${d} L${pts[2].x} ${pts[0].y} Z` : d;
  }

  function polygonPoints(x: number, y: number, w: number, h: number, sides = 6): string {
    const cx = x + w / 2, cy = y + h / 2;
    const rx = w / 2, ry = h / 2;
    return Array.from({ length: sides }, (_, i) => {
      const a = -Math.PI / 2 + i * Math.PI * 2 / sides;
      return `${cx + Math.cos(a) * rx},${cy + Math.sin(a) * ry}`;
    }).join(' ');
  }

  function framePath(x: number, y: number, w: number, h: number, frameWidth = 8): string {
    const fw = Math.max(1, Math.min(frameWidth, Math.max(1, Math.min(w, h) / 2)));
    const x2 = x + w, y2 = y + h;
    const ix = x + fw, iy = y + fw;
    const ix2 = x2 - fw, iy2 = y2 - fw;
    return `M${x} ${y}H${x2}V${y2}H${x}Z M${ix} ${iy}H${ix2}V${iy2}H${ix}Z`;
  }

  function buildBrushPath(pts: BrushPt[], maxW: number, form: 'kreis'|'rechteck'|'linie'|'gepunktet'|'faecher'|'airbrush'|'tinte'|'kreide'|'textur'|'zickzack'|'doppellinie' = 'kreis'): string {
    if (pts.length < 2) return '';
    if (form === 'gepunktet') return buildDottedBrush(pts, maxW);
    if (form === 'faecher') return buildFaecherBrush(pts, maxW);
    if (form === 'airbrush') return buildAirbrushBrush(pts, maxW);
    if (form === 'tinte') return buildTinteBrush(pts, maxW);
    if (form === 'kreide') return buildKreideBrush(pts, maxW);
    if (form === 'textur') return buildTexturBrush(pts, maxW);
    if (form === 'zickzack') return buildZickzackBrush(pts, maxW);
    if (form === 'doppellinie') return buildDoppellinieBrush(pts, maxW);
    // Breite an jedem Punkt: langsam = breit, schnell = schmal
    const widths = pts.map((p, i) => {
      if (i === 0 || i === pts.length - 1) return maxW * 0.25;
      const dt = Math.max(1, p.t - pts[i - 1].t);
      const dist = Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
      const speed = dist / dt;
      return Math.max(maxW * 0.15, Math.min(maxW, maxW / (1 + speed * 2.5)));
    });
    // Fester Normal-Vektor für 'linie' (45°-Feder), sonst bewegungsabhängig
    const nibNx = Math.cos(Math.PI / 4), nibNy = Math.sin(Math.PI / 4);
    const left: {x:number;y:number}[] = [];
    const right: {x:number;y:number}[] = [];
    for (let i = 0; i < pts.length; i++) {
      let nx: number, ny: number;
      if (form === 'linie') { nx = nibNx; ny = nibNy; }
      else {
        let dx: number, dy: number;
        if (i === 0) { dx = pts[1].x - pts[0].x; dy = pts[1].y - pts[0].y; }
        else if (i === pts.length - 1) { dx = pts[i].x - pts[i-1].x; dy = pts[i].y - pts[i-1].y; }
        else { dx = pts[i+1].x - pts[i-1].x; dy = pts[i+1].y - pts[i-1].y; }
        const len = Math.hypot(dx, dy) || 1;
        nx = -dy / len; ny = dx / len;
      }
      const hw = widths[i] / 2;
      left.push({ x: pts[i].x + nx * hw, y: pts[i].y + ny * hw });
      right.push({ x: pts[i].x - nx * hw, y: pts[i].y - ny * hw });
    }
    const outline = [...left, ...right.reverse()];
    const pp = getPaper();
    pp.project.clear();
    const path = new pp.Path(outline.map(p => new pp.Point(p.x, p.y)));
    path.closed = true;
    if (form === 'kreis') path.smooth({ type: 'catmull-rom', factor: 0.5 });
    // 'rechteck' und 'linie': keine Glättung → gerade Kanten
    const d = path.pathData;
    pp.project.clear();
    return d;
  }

  function smoothBrushPts(pts: BrushPt[], factor = 0.5): BrushPt[] {
    if (pts.length < 3 || factor <= 0.02) return pts;
    const stride = Math.max(1, Math.round(factor * factor * 40));
    return pts.filter((_, i) => i % stride === 0 || i === pts.length - 1);
  }

  function brushPtsForBuild(pts: {x:number;y:number;t?:number}[], factor = 0.5): BrushPt[] {
    return smoothBrushPts(pts.map((p, i) => ({ x: p.x, y: p.y, t: p.t ?? i })), factor);
  }

  function brushPathD(pts: {x:number;y:number;t?:number}[], size: number, form: DrawnPath['brushForm'], factor = 0.5): string {
    return buildBrushPath(brushPtsForBuild(pts, factor), size, form ?? 'kreis');
  }

  function wallRenderParts(pts: {x:number;y:number}[], width = 12, spacing = 16, hatchType: DrawnPath['wallHatchType'] = 'diagonal', closed = false): { lines: string; hatches: string } {
    if (pts.length < 2) return { lines: '', hatches: '' };
    const basePts = closed && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) > 0.01
      ? [...pts, pts[0]]
      : pts;
    const half = Math.max(1, width / 2);
    const segNormal = (a: {x:number;y:number}, b: {x:number;y:number}) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: -dy / len, y: dx / len, tx: dx / len, ty: dy / len, len };
    };
    const lineIntersection = (
      p1: {x:number;y:number}, d1: {x:number;y:number},
      p2: {x:number;y:number}, d2: {x:number;y:number}
    ) => {
      const cross = d1.x * d2.y - d1.y * d2.x;
      if (Math.abs(cross) < 0.0001) return null;
      const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / cross;
      return { x: p1.x + d1.x * t, y: p1.y + d1.y * t };
    };
    const offset = (side: 1 | -1) => basePts.map((p, i) => {
      if (!closed && i === 0) {
        const s = segNormal(basePts[0], basePts[1]);
        return { x: p.x + s.x * half * side, y: p.y + s.y * half * side };
      }
      if (!closed && i === basePts.length - 1) {
        const s = segNormal(basePts[i - 1], basePts[i]);
        return { x: p.x + s.x * half * side, y: p.y + s.y * half * side };
      }
      const prevPt = i === 0 ? basePts[basePts.length - 2] : basePts[i - 1];
      const nextPt = i === basePts.length - 1 ? basePts[1] : basePts[i + 1];
      const prev = segNormal(prevPt, p);
      const next = segNormal(p, nextPt);
      const a = { x: p.x + prev.x * half * side, y: p.y + prev.y * half * side };
      const b = { x: p.x + next.x * half * side, y: p.y + next.y * half * side };
      const hit = lineIntersection(a, { x: prev.tx, y: prev.ty }, b, { x: next.tx, y: next.ty });
      if (!hit || Math.hypot(hit.x - p.x, hit.y - p.y) > half * 8) {
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
      return hit;
    });
    const left = offset(1), right = offset(-1);
    const poly = (arr: {x:number;y:number}[]) => `M${arr.map(p => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' L')}`;
    const caps = closed ? '' : `M${left[0].x.toFixed(2)} ${left[0].y.toFixed(2)} L${right[0].x.toFixed(2)} ${right[0].y.toFixed(2)} M${left[left.length - 1].x.toFixed(2)} ${left[left.length - 1].y.toFixed(2)} L${right[right.length - 1].x.toFixed(2)} ${right[right.length - 1].y.toFixed(2)}`;
    let hatches = '';
    for (let i = 0; i < basePts.length - 1; i++) {
      const a = basePts[i], b = basePts[i + 1];
      const s = segNormal(a, b);
      if (hatchType === 'none') continue;
      for (let d = spacing; d < s.len; d += spacing) {
        const cx = a.x + s.tx * d, cy = a.y + s.ty * d;
        const skew = Math.min(half * 0.65, spacing * 0.35);
        const innerHalf = Math.max(1, half - 0.75);
        const addLine = (ax: number, ay: number, bx: number, by: number) => {
          hatches += `M${ax.toFixed(2)} ${ay.toFixed(2)} L${bx.toFixed(2)} ${by.toFixed(2)} `;
        };
        if (hatchType === 'brick') {
          addLine(cx + s.x * innerHalf, cy + s.y * innerHalf, cx - s.x * innerHalf, cy - s.y * innerHalf);
        } else if (hatchType === 'concrete') {
          addLine(cx - s.tx * spacing * .18, cy - s.ty * spacing * .18, cx + s.tx * spacing * .18, cy + s.ty * spacing * .18);
          addLine(cx + s.x * innerHalf * .45 - s.tx * 2, cy + s.y * innerHalf * .45 - s.ty * 2, cx + s.x * innerHalf * .45 + s.tx * 2, cy + s.y * innerHalf * .45 + s.ty * 2);
        } else if (hatchType === 'insulation') {
          addLine(cx + s.x * innerHalf, cy + s.y * innerHalf, cx, cy);
          addLine(cx, cy, cx - s.x * innerHalf, cy - s.y * innerHalf);
        } else {
          addLine(cx + s.x * innerHalf + s.tx * skew, cy + s.y * innerHalf + s.ty * skew, cx - s.x * innerHalf - s.tx * skew, cy - s.y * innerHalf - s.ty * skew);
          if (hatchType === 'cross') {
            addLine(cx + s.x * innerHalf - s.tx * skew, cy + s.y * innerHalf - s.ty * skew, cx - s.x * innerHalf + s.tx * skew, cy - s.y * innerHalf + s.ty * skew);
          }
        }
      }
    }
    return { lines: `${poly(left)} ${poly(right)} ${caps}`, hatches };
  }

  function wallPathD(pts: {x:number;y:number}[], width = 12, spacing = 16, hatchType: DrawnPath['wallHatchType'] = 'diagonal', closed = false): string {
    const p = wallRenderParts(pts, width, spacing, hatchType, closed);
    return `${p.lines} ${p.hatches}`.trim();
  }

  function updatePathBBoxFromD(obj: DrawnPath) {
    if (!obj.d) return;
    const p = getPaper();
    p.project.clear();
    try {
      const path = new p.CompoundPath(obj.d);
      const b = path.bounds;
      obj.x = Math.round(b.x);
      obj.y = Math.round(b.y);
      obj.w = Math.max(1, Math.round(b.width));
      obj.h = Math.max(1, Math.round(b.height));
    } catch {
      const xs = obj.points.map(pt => pt.x), ys = obj.points.map(pt => pt.y);
      if (xs.length && ys.length) {
        obj.x = Math.round(Math.min(...xs));
        obj.y = Math.round(Math.min(...ys));
        obj.w = Math.max(1, Math.round(Math.max(...xs) - obj.x));
        obj.h = Math.max(1, Math.round(Math.max(...ys) - obj.y));
      }
    } finally {
      p.project.clear();
    }
  }

  function rectMaskPath(obj: DrawnRect): string {
    if (obj.imageMaskD) return obj.imageMaskD;
    if (obj.imageShape === 'circle') {
      const p = getPaper();
      p.project.clear();
      const ellipse = new p.Path.Ellipse({
        center: new p.Point(obj.x + obj.w / 2, obj.y + obj.h / 2),
        radius: new p.Size(obj.w / 2, obj.h / 2),
      });
      const d = ellipse.pathData;
      p.project.clear();
      return d;
    }
    return roundRectPath(obj.x, obj.y, obj.w, obj.h, obj.radiusOL, obj.radiusOR, obj.radiusUL, obj.radiusUR, obj.cornerStyle ?? 'round');
  }

  function transformPathD(d: string, translateX: number, translateY: number, scaleX = 1, scaleY = 1, originX = 0, originY = 0): string {
    if (!d) return '';
    const p = getPaper();
    p.project.clear();
    try {
      const path = new p.CompoundPath(d);
      const matrix = new p.Matrix();
      matrix.translate(originX, originY);
      matrix.scale(scaleX, scaleY);
      matrix.translate(-originX, -originY);
      matrix.translate(translateX, translateY);
      path.transform(matrix);
      return path.pathData;
    } finally {
      p.project.clear();
    }
  }

  function rotatePathD(d: string, cx: number, cy: number, angleDeg: number): string {
    if (!d) return '';
    const p = getPaper();
    p.project.clear();
    try {
      const path = new p.CompoundPath(d);
      path.rotate(angleDeg, new p.Point(cx, cy));
      return path.pathData;
    } finally {
      p.project.clear();
    }
  }

  function normalizeBrushOrigin(obj: DrawnPath) {
    if (!obj.isBrush) return;
    updatePathBBoxFromD(obj);
    obj.ox = obj.x;
    obj.oy = obj.y;
  }

  function buildDottedBrush(pts: BrushPt[], maxW: number): string {
    const spacing = Math.max(maxW * 1.2, 4);
    const pp = getPaper();
    pp.project.clear();
    const dParts: string[] = [];
    const addDot = (x: number, y: number, r: number) => {
      const c = new pp.Path.Circle(new pp.Point(x, y), Math.max(0.5, r));
      dParts.push(c.pathData);
      c.remove();
    };
    addDot(pts[0].x, pts[0].y, maxW * 0.3);
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i-1].x, dy = pts[i].y - pts[i-1].y;
      const dist = Math.hypot(dx, dy); acc += dist;
      while (acc >= spacing) {
        acc -= spacing;
        const t = 1 - acc / dist;
        const x = pts[i-1].x + dx * t, y = pts[i-1].y + dy * t;
        const dt = Math.max(1, pts[i].t - pts[i-1].t);
        const speed = dist / dt;
        const r = Math.max(maxW * 0.1, Math.min(maxW * 0.5, maxW * 0.5 / (1 + speed * 2.5)));
        addDot(x, y, r);
      }
    }
    pp.project.clear();
    return dParts.join(' ');
  }

  function buildFaecherBrush(pts: BrushPt[], maxW: number): string {
    // 4 dünne parallele Striche wie ein Fächer
    const pp = getPaper();
    pp.project.clear();
    const dParts: string[] = [];
    const spreads = [-0.45, -0.15, 0.15, 0.45];
    const hw = maxW * 0.07;
    for (const spread of spreads) {
      const left: {x:number;y:number}[] = [];
      const right: {x:number;y:number}[] = [];
      for (let i = 0; i < pts.length; i++) {
        let dx: number, dy: number;
        if (i === 0) { dx = pts[1].x - pts[0].x; dy = pts[1].y - pts[0].y; }
        else if (i === pts.length - 1) { dx = pts[i].x - pts[i-1].x; dy = pts[i].y - pts[i-1].y; }
        else { dx = pts[i+1].x - pts[i-1].x; dy = pts[i+1].y - pts[i-1].y; }
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const cx = pts[i].x + nx * spread * maxW, cy = pts[i].y + ny * spread * maxW;
        left.push({ x: cx + nx * hw, y: cy + ny * hw });
        right.push({ x: cx - nx * hw, y: cy - ny * hw });
      }
      const outline = [...left, ...right.reverse()];
      const path = new pp.Path(outline.map(p => new pp.Point(p.x, p.y)));
      path.closed = true;
      path.smooth({ type: 'catmull-rom', factor: 0.5 });
      dParts.push(path.pathData);
    }
    pp.project.clear();
    return dParts.join(' ');
  }

  function buildAirbrushBrush(pts: BrushPt[], maxW: number): string {
    // Gesprühte Punkte um den Pfad herum (pseudo-zufällig)
    const pp = getPaper();
    pp.project.clear();
    const dParts: string[] = [];
    const radius = maxW * 0.6;
    const step = Math.max(1, Math.floor(pts.length / 50));
    for (let i = 0; i < pts.length; i += step) {
      const p = pts[i];
      for (let j = 0; j < 10; j++) {
        const angle = ((p.x * 7 + p.y * 13 + j * 37 + i * 19) % 628) / 100;
        const r2 = (((p.x * 3 + p.y * 11 + j * 17) % 100) / 100) * radius;
        const dotR = Math.max(0.4, maxW * 0.045 * (1 - r2 / radius * 0.4));
        const c = new pp.Path.Circle(new pp.Point(p.x + Math.cos(angle) * r2, p.y + Math.sin(angle) * r2), dotR);
        dParts.push(c.pathData);
        c.remove();
      }
    }
    pp.project.clear();
    return dParts.join(' ');
  }

  function buildTinteBrush(pts: BrushPt[], maxW: number): string {
    // Scharfer Tintenstrich – verjüngt an Anfang/Ende, keine Druckvariation
    const left: {x:number;y:number}[] = [];
    const right: {x:number;y:number}[] = [];
    for (let i = 0; i < pts.length; i++) {
      let dx: number, dy: number;
      if (i === 0) { dx = pts[1].x - pts[0].x; dy = pts[1].y - pts[0].y; }
      else if (i === pts.length - 1) { dx = pts[i].x - pts[i-1].x; dy = pts[i].y - pts[i-1].y; }
      else { dx = pts[i+1].x - pts[i-1].x; dy = pts[i+1].y - pts[i-1].y; }
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      const t = i / (pts.length - 1);
      const hw = (maxW * 0.06 + maxW * 0.44 * Math.sin(t * Math.PI)) / 2;
      left.push({ x: pts[i].x + nx * hw, y: pts[i].y + ny * hw });
      right.push({ x: pts[i].x - nx * hw, y: pts[i].y - ny * hw });
    }
    const outline = [...left, ...right.reverse()];
    const pp = getPaper();
    pp.project.clear();
    const path = new pp.Path(outline.map(p => new pp.Point(p.x, p.y)));
    path.closed = true;
    const d = path.pathData;
    pp.project.clear();
    return d;
  }

  function buildKreideBrush(pts: BrushPt[], maxW: number): string {
    // Kreide: unregelmäßige kurze Segmente mit variierender Breite
    const pp = getPaper();
    pp.project.clear();
    const dParts: string[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i], p1 = pts[i + 1];
      const dx = p1.x - p0.x, dy = p1.y - p0.y;
      const dist = Math.hypot(dx, dy);
      if (dist === 0) continue;
      const steps = Math.max(1, Math.ceil(dist / (maxW * 0.35)));
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps, t1 = (s + 0.65) / steps;
        const x0 = p0.x + dx * t0, y0 = p0.y + dy * t0;
        const x1 = p0.x + dx * t1, y1 = p0.y + dy * t1;
        const nx = -dy / dist, ny = dx / dist;
        const rnd = ((x0 * 7 + y0 * 13 + s * 31) % 100) / 100;
        const hw = maxW * (0.12 + rnd * 0.38) / 2;
        const rect = new pp.Path([
          new pp.Point(x0 + nx * hw, y0 + ny * hw),
          new pp.Point(x1 + nx * hw, y1 + ny * hw),
          new pp.Point(x1 - nx * hw, y1 - ny * hw),
          new pp.Point(x0 - nx * hw, y0 - ny * hw)
        ]);
        rect.closed = true;
        dParts.push(rect.pathData);
        rect.remove();
      }
    }
    pp.project.clear();
    return dParts.join(' ');
  }

  function buildTexturBrush(pts: BrushPt[], maxW: number): string {
    // Textur: kurze Querstriche senkrecht zur Bewegungsrichtung
    const pp = getPaper();
    pp.project.clear();
    const dParts: string[] = [];
    const spacing = maxW * 0.55;
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i-1].x, dy = pts[i].y - pts[i-1].y;
      const dist = Math.hypot(dx, dy);
      if (dist === 0) continue;
      acc += dist;
      while (acc >= spacing) {
        acc -= spacing;
        const t = 1 - acc / dist;
        const cx = pts[i-1].x + dx * t, cy = pts[i-1].y + dy * t;
        const tx = dx / dist, ty = dy / dist;
        const nx = -ty, ny = tx;
        const halfLen = maxW * 0.42, hw = maxW * 0.055;
        const rect = new pp.Path([
          new pp.Point(cx + nx * halfLen + tx * hw, cy + ny * halfLen + ty * hw),
          new pp.Point(cx - nx * halfLen + tx * hw, cy - ny * halfLen + ty * hw),
          new pp.Point(cx - nx * halfLen - tx * hw, cy - ny * halfLen - ty * hw),
          new pp.Point(cx + nx * halfLen - tx * hw, cy + ny * halfLen - ty * hw)
        ]);
        rect.closed = true;
        dParts.push(rect.pathData);
        rect.remove();
      }
    }
    pp.project.clear();
    return dParts.join(' ');
  }

  function buildZickzackBrush(pts: BrushPt[], maxW: number): string {
    // Zickzack: Pfad wechselt periodisch die Seite
    if (pts.length < 2) return '';
    const period = maxW * 1.8;
    const amplitude = maxW * 0.4;
    const hw = maxW * 0.055;
    const zigPts: {x:number;y:number}[] = [{ x: pts[0].x, y: pts[0].y }];
    let acc = 0, side = 1;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i-1].x, dy = pts[i].y - pts[i-1].y;
      const dist = Math.hypot(dx, dy);
      if (dist === 0) continue;
      acc += dist;
      while (acc >= period) {
        acc -= period;
        side = -side;
        const t = 1 - acc / dist;
        const cx = pts[i-1].x + dx * t, cy = pts[i-1].y + dy * t;
        const nx = -dy / dist, ny = dx / dist;
        zigPts.push({ x: cx + nx * amplitude * side, y: cy + ny * amplitude * side });
      }
    }
    zigPts.push({ x: pts[pts.length-1].x, y: pts[pts.length-1].y });
    const left: {x:number;y:number}[] = [];
    const right: {x:number;y:number}[] = [];
    for (let i = 0; i < zigPts.length; i++) {
      let ddx: number, ddy: number;
      if (i === 0) { ddx = zigPts[1].x - zigPts[0].x; ddy = zigPts[1].y - zigPts[0].y; }
      else if (i === zigPts.length - 1) { ddx = zigPts[i].x - zigPts[i-1].x; ddy = zigPts[i].y - zigPts[i-1].y; }
      else { ddx = zigPts[i+1].x - zigPts[i-1].x; ddy = zigPts[i+1].y - zigPts[i-1].y; }
      const len = Math.hypot(ddx, ddy) || 1;
      const nx = -ddy / len, ny = ddx / len;
      left.push({ x: zigPts[i].x + nx * hw, y: zigPts[i].y + ny * hw });
      right.push({ x: zigPts[i].x - nx * hw, y: zigPts[i].y - ny * hw });
    }
    const outline = [...left, ...right.reverse()];
    const pp = getPaper();
    pp.project.clear();
    const path = new pp.Path(outline.map(p => new pp.Point(p.x, p.y)));
    path.closed = true;
    const d = path.pathData;
    pp.project.clear();
    return d;
  }

  function buildDoppellinieBrush(pts: BrushPt[], maxW: number): string {
    // Zwei parallele Linien
    const pp = getPaper();
    pp.project.clear();
    const dParts: string[] = [];
    const gap = maxW * 0.28;
    const hw = maxW * 0.055;
    for (const offset of [-gap, gap]) {
      const left: {x:number;y:number}[] = [];
      const right: {x:number;y:number}[] = [];
      for (let i = 0; i < pts.length; i++) {
        let dx: number, dy: number;
        if (i === 0) { dx = pts[1].x - pts[0].x; dy = pts[1].y - pts[0].y; }
        else if (i === pts.length - 1) { dx = pts[i].x - pts[i-1].x; dy = pts[i].y - pts[i-1].y; }
        else { dx = pts[i+1].x - pts[i-1].x; dy = pts[i+1].y - pts[i-1].y; }
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const cx = pts[i].x + nx * offset, cy = pts[i].y + ny * offset;
        left.push({ x: cx + nx * hw, y: cy + ny * hw });
        right.push({ x: cx - nx * hw, y: cy - ny * hw });
      }
      const outline = [...left, ...right.reverse()];
      const path = new pp.Path(outline.map(p => new pp.Point(p.x, p.y)));
      path.closed = true;
      path.smooth({ type: 'catmull-rom', factor: 0.5 });
      dParts.push(path.pathData);
    }
    pp.project.clear();
    return dParts.join(' ');
  }

  // Linie / Maßlinie Eigenschaften
  // Text-Eigenschaften
  let propFontSize     = $state(12);
  let propFontFamily   = $state("'Helvetica Neue', Helvetica, Arial, sans-serif");
  let propFontBold     = $state(false);
  let propFontItalic   = $state(false);
  let propTextAlign    = $state<'left'|'center'|'right'>('left');
  let propLineHeight   = $state(1.4);
  let propGlaettung    = $state(0.5);
  let propCurveClosed  = $state(false);
  let textEditUid      = $state<string|null>(null); // UID des gerade bearbeiteten Textobjekts
  let pendingTextCaret = $state<{ x: number; y: number } | null>(null);
  let savedTextRange: Range | null = null;
  const DEFAULT_TEXT_FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
  const DEFAULT_TEXT_SIZE = 12;

  let propArrowStart   = $state<'none'|'arrow'|'dot'|'tick'>('none');
  let propArrowEnd     = $state<'none'|'arrow'|'dot'|'tick'>('none');
  let propIsMasslinie  = $state(false);
  let propMassText     = $state('');
  let propMassTextPos  = $state<'ueber'|'in'>('ueber');
  let propLineLength   = $state(0);
  let propLineLengthInput = $state<number|''>(0);
  let objFill     = $state('#ffffff');
  let fillMode    = $state<'solid'|'linear'|'radial'>('solid');
  let gradientAngle = $state(0);
  let gradientStart = $state('#ffffff');
  let gradientEnd   = $state('#000000');
  let objStroke   = $state('#000000');
  let objStrokeW    = $state<number|''>(1);
  let objStrokeDash = $state('');
  let objRadiusOL    = $state(0);
  let objRadiusOR    = $state(0);
  let objRadiusUL    = $state(0);
  let objRadiusUR    = $state(0);
  let objCornerStyle = $state<'round'|'chamfer'|'concave'>('round');
  let objShadow     = $state(false);
  let objShadowX    = $state(4);
  let objShadowY    = $state(4);
  let objShadowBlur = $state(6);
  let objShadowColor = $state('#000000');
  const strokeWidthOptions = [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16, 20];

  function strokeWidthLabel(value: number): string {
    return value.toString().replace('.', ',');
  }

  function gradientCss() {
    return fillMode === 'radial'
      ? `radial-gradient(circle, ${gradientStart}, ${gradientEnd})`
      : `linear-gradient(${gradientAngle}deg, ${gradientStart}, ${gradientEnd})`;
  }

  function gradientValue() {
    return `vec-gradient(${fillMode},${gradientAngle},${gradientStart},${gradientEnd})`;
  }

  function parseGradientValue(value?: string) {
    const m = value?.match(/^vec-gradient\((linear|radial),(-?\d+(?:\.\d+)?),(#[0-9a-fA-F]{6}),(#[0-9a-fA-F]{6})\)$/);
    if (!m) return null;
    return { mode: m[1] as 'linear' | 'radial', angle: Number(m[2]), start: m[3], end: m[4] };
  }

  function svgFillFor(obj: DrawnObject) {
    return parseGradientValue(obj.fill) ? `url(#fill-${obj.uid})` : (obj.fill || 'none');
  }

  function fillLabel(value: string) {
    return parseGradientValue(value) ? 'Verlauf' : value;
  }

  function cssFillForValue(value: string) {
    const grad = parseGradientValue(value);
    if (!grad) return value === 'none' ? '#ffffff' : value;
    return grad.mode === 'radial'
      ? `radial-gradient(circle, ${grad.start}, ${grad.end})`
      : `linear-gradient(${grad.angle}deg, ${grad.start}, ${grad.end})`;
  }

  function applyGradientFill() {
    objFill = gradientValue();
    syncObjFromProps();
  }

  function reverseGradientFill() {
    const tmp = gradientStart;
    gradientStart = gradientEnd;
    gradientEnd = tmp;
    if (fillMode !== 'solid') applyGradientFill();
  }

  const gradientPresets = [
    { name: 'Blau', mode: 'linear' as const, angle: 180, start: '#0ea5ff', end: '#16337f' },
    { name: 'Grün', mode: 'linear' as const, angle: 180, start: '#8ff0a0', end: '#3f694b' },
    { name: 'Orange', mode: 'radial' as const, angle: 0, start: '#ff8a24', end: '#e63600' },
    { name: 'Meer', mode: 'linear' as const, angle: 180, start: '#052a7c', end: '#0ea5ff' },
    { name: 'Licht', mode: 'linear' as const, angle: 180, start: '#ffffe4', end: '#ff9f1a' },
    { name: 'Feuer', mode: 'linear' as const, angle: 135, start: '#ffd166', end: '#4a0000' },
    { name: 'Violett', mode: 'linear' as const, angle: 135, start: '#c084fc', end: '#4c1d95' },
    { name: 'Stahl', mode: 'linear' as const, angle: 180, start: '#f8fafc', end: '#475569' },
    { name: 'Kupfer', mode: 'linear' as const, angle: 135, start: '#f6ad55', end: '#7c2d12' },
    { name: 'Nacht', mode: 'radial' as const, angle: 0, start: '#38bdf8', end: '#020617' },
    { name: 'Rose', mode: 'linear' as const, angle: 135, start: '#fecdd3', end: '#be123c' },
    { name: 'Moos', mode: 'radial' as const, angle: 0, start: '#bef264', end: '#365314' },
    { name: 'Graphit', mode: 'linear' as const, angle: 90, start: '#f3f4f6', end: '#111827' },
    { name: 'Aqua', mode: 'linear' as const, angle: 135, start: '#67e8f9', end: '#0f766e' },
    { name: 'Sonnenaufgang', mode: 'linear' as const, angle: 135, start: '#fff7ad', end: '#f97316' },
    { name: 'Lavendel', mode: 'radial' as const, angle: 0, start: '#f5d0fe', end: '#7e22ce' },
    { name: 'Sandstein', mode: 'linear' as const, angle: 180, start: '#f5e6c8', end: '#a16207' },
    { name: 'Petrol', mode: 'radial' as const, angle: 0, start: '#99f6e4', end: '#134e4a' },
    { name: 'Neonbruch', mode: 'linear' as const, angle: 45, start: '#00ff87', end: '#ff00d4' },
    { name: 'Glutkern', mode: 'radial' as const, angle: 0, start: '#fff200', end: '#050000' },
    { name: 'Polarlicht', mode: 'linear' as const, angle: 110, start: '#22d3ee', end: '#a3e635' },
    { name: 'Tiefraum', mode: 'radial' as const, angle: 0, start: '#f0abfc', end: '#00001f' },
    { name: 'Warnsignal', mode: 'linear' as const, angle: 135, start: '#faff00', end: '#ff003d' },
    { name: 'Eisblitz', mode: 'linear' as const, angle: 20, start: '#ffffff', end: '#0057ff' },
  ];

  function applyGradientPreset(preset: (typeof gradientPresets)[number]) {
    fillMode = preset.mode;
    gradientAngle = preset.angle;
    gradientStart = preset.start;
    gradientEnd = preset.end;
    applyGradientFill();
  }

  function canFillObject(obj: DrawnObject) {
    if (obj.type === 'RECHTECK') return !obj.isImageFrame && obj.shape !== 'frame';
    if (obj.type === 'PFAD') return (obj.isCurve && obj.curveClosed) || (!obj.isBrush && !obj.isWall && obj.points.length === 0);
    return false;
  }

  function applyFillToolToObject(obj: DrawnObject) {
    if (!canFillObject(obj)) return;
    pushUndo();
    obj.fill = objFill;
    persistDbObject(obj);
    objects = [...objects];
    unsaved = true;
  }

  type ShapeTemplate =
    | {
        id: string;
        label: string;
        kind: 'rect';
        w: number;
        h: number;
        fill: string;
        stroke: string;
        r?: number;
        shape?: DrawnRect['shape'];
        strokeW?: number;
      }
    | {
        id: string;
        label: string;
        kind: 'path';
        w: number;
        h: number;
        vbW?: number;
        vbH?: number;
        fill: string;
        stroke: string;
        strokeW?: number;
        d: string;
      };
  interface ShapeGroup { name: string; items: ShapeTemplate[]; }

  const shapeGroups: ShapeGroup[] = [
    {
      name: 'UI',
      items: [
        { id: 'btn-blue', label: 'Blauer Button', kind: 'rect', w: 120, h: 42, fill: '#1683ff', stroke: 'none', r: 8 },
        { id: 'btn-dark', label: 'Dunkler Button', kind: 'rect', w: 120, h: 42, fill: '#b8c8a8', stroke: 'none', r: 8 },
        { id: 'btn-light', label: 'Heller Button', kind: 'rect', w: 120, h: 42, fill: '#f5f5f5', stroke: 'none', r: 8 },
        { id: 'pill-green', label: 'Grüne Pill', kind: 'rect', w: 130, h: 32, fill: '#17a64a', stroke: 'none', r: 16 },
        { id: 'seg', label: 'Segment', kind: 'path', w: 150, h: 34, vbW: 150, vbH: 34, fill: '#b8c8a8', stroke: '#3b82f6', d: 'M6 0H144Q150 0 150 6V28Q150 34 144 34H6Q0 34 0 28V6Q0 0 6 0ZM75 0V34' },
      ],
    },
    {
      name: 'Geräte',
      items: [
        { id: 'phone-dark', label: 'Telefon dunkel', kind: 'path', w: 72, h: 140, vbW: 72, vbH: 140, fill: '#b8c8a8', stroke: '#777777', d: 'M14 0H58Q72 0 72 14V126Q72 140 58 140H14Q0 140 0 126V14Q0 0 14 0ZM8 18H64V116H8ZM31 126A5 5 0 1 0 41 126A5 5 0 1 0 31 126' },
        { id: 'phone-light', label: 'Telefon hell', kind: 'path', w: 72, h: 140, vbW: 72, vbH: 140, fill: '#f4f1ea', stroke: '#cccccc', d: 'M14 0H58Q72 0 72 14V126Q72 140 58 140H14Q0 140 0 126V14Q0 0 14 0ZM8 18H64V116H8ZM31 126A5 5 0 1 0 41 126A5 5 0 1 0 31 126' },
        { id: 'screen', label: 'Display', kind: 'rect', w: 160, h: 96, fill: '#b8c8a8', stroke: '#6ab0ff', r: 4 },
      ],
    },
    {
      name: 'Piktogramme',
      items: [
        { id: 'airplane', label: 'Flugzeug', kind: 'path', w: 90, h: 72, vbW: 90, vbH: 72, fill: '#b8c8a8', stroke: 'none', d: 'M44 0L51 0L51 27L88 48V58L51 46L51 63L65 72L65 78L45 72L25 78L25 72L39 63L39 46L2 58L2 48L39 27L39 0Z' },
        { id: 'bicycle', label: 'Fahrrad', kind: 'path', w: 100, h: 70, vbW: 100, vbH: 70, fill: 'none', stroke: '#b8c8a8', strokeW: 5, d: 'M25 52A17 17 0 1 0 25 18A17 17 0 1 0 25 52M75 52A17 17 0 1 0 75 18A17 17 0 1 0 75 52M25 35H43L55 18H67M43 35L58 35L49 20M55 18L75 35M49 9A5 5 0 1 0 49 0A5 5 0 1 0 49 9M49 10L42 22' },
        { id: 'bus', label: 'Bus', kind: 'path', w: 82, h: 92, vbW: 82, vbH: 92, fill: '#b8c8a8', stroke: 'none', d: 'M13 0H69Q82 0 82 13V68Q82 78 72 78V92H62V78H20V92H10V78Q0 78 0 68V13Q0 0 13 0ZM10 12V42H72V12ZM18 62A6 6 0 1 0 30 62A6 6 0 1 0 18 62ZM52 62A6 6 0 1 0 64 62A6 6 0 1 0 52 62Z' },
        { id: 'fuel', label: 'Tankstelle', kind: 'path', w: 74, h: 96, vbW: 74, vbH: 96, fill: 'none', stroke: '#b8c8a8', strokeW: 6, d: 'M8 93V6H47V93M2 93H53M17 16H38V36H17ZM47 16L63 32V78Q63 88 72 88M63 32H52M60 16L72 28V51' },
        { id: 'mail', label: 'Brief', kind: 'path', w: 96, h: 64, vbW: 96, vbH: 64, fill: 'none', stroke: '#b8c8a8', strokeW: 5, d: 'M3 3H93V61H3ZM3 3L48 38L93 3M3 61L36 31M93 61L60 31' },
        { id: 'recycle', label: 'Recycling', kind: 'path', w: 94, h: 86, vbW: 94, vbH: 86, fill: '#b8c8a8', stroke: 'none', d: 'M38 0L54 0L66 21L76 15L70 43L43 37L54 30ZM79 43L94 68L84 86H58V74H75L65 56ZM18 33L4 58L15 77H40V65H22L33 46ZM16 31L31 5L45 30L34 36L28 24L20 37Z' },
        { id: 'question', label: 'Frage', kind: 'path', w: 82, h: 82, vbW: 82, vbH: 82, fill: 'none', stroke: '#b8c8a8', strokeW: 6, d: 'M41 79A38 38 0 1 0 41 3A38 38 0 1 0 41 79M28 29Q29 18 41 18Q53 18 54 29Q55 37 45 42Q40 45 40 53M40 63L40 69' },
        { id: 'plus-med', label: 'Kreuz', kind: 'path', w: 80, h: 80, vbW: 80, vbH: 80, fill: '#b8c8a8', stroke: 'none', d: 'M30 0H50V30H80V50H50V80H30V50H0V30H30Z' },
        { id: 'cutlery', label: 'Restaurant', kind: 'path', w: 72, h: 90, vbW: 72, vbH: 90, fill: '#b8c8a8', stroke: 'none', d: 'M8 0H13V30H18V0H23V30H28V0H33V34Q33 45 23 49V90H14V49Q4 45 4 34V0ZM55 0Q68 0 68 24V90H59V55H50Q42 55 42 44V18Q42 5 55 0Z' },
        { id: 'bed', label: 'Bett', kind: 'path', w: 100, h: 62, vbW: 100, vbH: 62, fill: '#b8c8a8', stroke: 'none', d: 'M0 0H10V30H42V18Q42 8 52 8H82Q100 8 100 26V62H90V48H10V62H0ZM14 12A10 10 0 1 0 34 12A10 10 0 1 0 14 12Z' },
        { id: 'wheelchair', label: 'Rollstuhl', kind: 'path', w: 88, h: 92, vbW: 88, vbH: 92, fill: '#b8c8a8', stroke: 'none', d: 'M40 10A10 10 0 1 0 40 -10A10 10 0 1 0 40 10M32 16H44L48 42H70V54H53L60 72H76V84H52L42 54H28Q8 54 8 74Q8 86 20 86Q32 86 36 74H48Q43 92 20 92Q0 92 0 74Q0 42 34 42Z' },
        { id: 'anchor', label: 'Anker', kind: 'path', w: 82, h: 94, vbW: 82, vbH: 94, fill: '#b8c8a8', stroke: 'none', d: 'M35 20A10 10 0 1 1 47 20V34H62V44H47V76Q63 72 70 56L60 56L72 39L82 57L75 57Q68 88 41 94Q14 88 7 57L0 57L10 39L22 56L12 56Q19 72 35 76V44H20V34H35Z' },
      ],
    },
    {
      name: 'Freizeit',
      items: [
        { id: 'camp', label: 'Zelt', kind: 'path', w: 94, h: 82, vbW: 94, vbH: 82, fill: 'none', stroke: '#b8c8a8', strokeW: 6, d: 'M47 4L86 78H8ZM47 4L47 78M30 78L47 44L64 78M3 78H91' },
        { id: 'fire', label: 'Feuerstelle', kind: 'path', w: 86, h: 96, vbW: 86, vbH: 96, fill: '#b8c8a8', stroke: 'none', d: 'M43 0Q61 21 50 40Q66 33 70 16Q92 50 69 74Q58 86 43 86Q28 86 17 74Q-5 50 22 23Q20 43 34 48Q25 25 43 0ZM8 88H78V96H8Z' },
        { id: 'picnic', label: 'Picknick', kind: 'path', w: 96, h: 70, vbW: 96, vbH: 70, fill: 'none', stroke: '#b8c8a8', strokeW: 6, d: 'M15 10H81M24 34H72M31 10L18 66M65 10L78 66M5 66H91' },
        { id: 'swim', label: 'Schwimmen', kind: 'path', w: 100, h: 78, vbW: 100, vbH: 78, fill: 'none', stroke: '#b8c8a8', strokeW: 6, d: 'M20 24A10 10 0 1 0 20 4A10 10 0 1 0 20 24M32 28L52 38L72 20M6 54Q18 44 30 54Q42 64 54 54Q66 44 78 54Q88 62 96 54M6 70Q18 60 30 70Q42 80 54 70Q66 60 78 70Q88 78 96 70' },
        { id: 'sailboat', label: 'Segelboot', kind: 'path', w: 96, h: 96, vbW: 96, vbH: 96, fill: '#b8c8a8', stroke: 'none', d: 'M48 0V60H12ZM54 10V60H86ZM10 66H90L78 84H22ZM4 90Q16 82 28 90Q40 98 52 90Q64 82 76 90Q86 96 96 90V96H4Z' },
        { id: 'hiker', label: 'Wandern', kind: 'path', w: 82, h: 100, vbW: 82, vbH: 100, fill: 'none', stroke: '#b8c8a8', strokeW: 7, d: 'M42 14A8 8 0 1 0 42 -2A8 8 0 1 0 42 14M38 22L26 54L18 94M38 22L57 43M33 48L58 62L72 94M66 28V100' },
        { id: 'motorcycle', label: 'Motorrad', kind: 'path', w: 106, h: 72, vbW: 106, vbH: 72, fill: 'none', stroke: '#b8c8a8', strokeW: 6, d: 'M22 62A14 14 0 1 0 22 34A14 14 0 1 0 22 62M84 62A14 14 0 1 0 84 34A14 14 0 1 0 84 62M22 48H45L62 24H80L90 48M50 24H38M60 10A7 7 0 1 0 60 -4A7 7 0 1 0 60 10M60 12L50 24' },
        { id: 'rv', label: 'Wohnmobil', kind: 'path', w: 108, h: 70, vbW: 108, vbH: 70, fill: 'none', stroke: '#b8c8a8', strokeW: 6, d: 'M4 14H70L84 32H104V58H90M30 58H78M16 58H4V14M18 58A8 8 0 1 0 34 58A8 8 0 1 0 18 58M78 58A8 8 0 1 0 94 58A8 8 0 1 0 78 58M16 24H46V38H16M54 24H70' },
      ],
    },
    {
      name: 'Service',
      items: [
        { id: 'toilet', label: 'WC', kind: 'path', w: 90, h: 96, vbW: 90, vbH: 96, fill: '#b8c8a8', stroke: 'none', d: 'M22 18A8 8 0 1 0 22 2A8 8 0 1 0 22 18M14 24H30L36 58H28V96H16V58H8ZM66 18A8 8 0 1 0 66 2A8 8 0 1 0 66 18M58 24H74V96H62V58H54Z' },
        { id: 'trash', label: 'Abfall', kind: 'path', w: 80, h: 96, vbW: 80, vbH: 96, fill: 'none', stroke: '#b8c8a8', strokeW: 6, d: 'M16 24H64L58 92H22ZM10 24H70M30 24V10H50V24M30 42V76M50 42V76' },
        { id: 'info', label: 'Info', kind: 'path', w: 82, h: 82, vbW: 82, vbH: 82, fill: 'none', stroke: '#b8c8a8', strokeW: 6, d: 'M41 79A38 38 0 1 0 41 3A38 38 0 1 0 41 79M41 36V62M41 21V27' },
        { id: 'first-aid', label: 'Erste Hilfe', kind: 'path', w: 88, h: 88, vbW: 88, vbH: 88, fill: '#b8c8a8', stroke: 'none', d: 'M34 0H54V34H88V54H54V88H34V54H0V34H34Z' },
        { id: 'telephone', label: 'Telefon', kind: 'path', w: 70, h: 96, vbW: 70, vbH: 96, fill: '#b8c8a8', stroke: 'none', d: 'M12 0H34V32L22 38Q26 58 44 74L58 64L70 82Q58 96 44 96Q18 78 6 52Q-6 26 12 0Z' },
        { id: 'shop', label: 'Shop', kind: 'path', w: 96, h: 88, vbW: 96, vbH: 88, fill: 'none', stroke: '#b8c8a8', strokeW: 6, d: 'M8 36L16 8H80L88 36M8 36Q8 50 22 50Q34 50 34 36Q34 50 48 50Q62 50 62 36Q62 50 74 50Q88 50 88 36M16 50V84H80V50M34 84V62H62V84' },
        { id: 'parking', label: 'Parken', kind: 'path', w: 84, h: 84, vbW: 84, vbH: 84, fill: 'none', stroke: '#b8c8a8', strokeW: 8, d: 'M8 80V4H45Q70 4 70 28Q70 52 45 52H28V80M28 20H44Q52 20 52 28Q52 36 44 36H28' },
        { id: 'wifi', label: 'WLAN', kind: 'path', w: 100, h: 76, vbW: 100, vbH: 76, fill: 'none', stroke: '#b8c8a8', strokeW: 7, d: 'M5 26Q50 -12 95 26M22 44Q50 20 78 44M38 60Q50 50 62 60M50 72L50 73' },
      ],
    },
    {
      name: 'Tabler Verkehr',
      items: [
        { id: 'tabler-plane', label: 'Plane', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M16 10h4a2 2 0 0 1 0 4h-4l-4 7h-3l2 -7h-4l-2 2h-3l2 -4l-2 -4h3l2 2h4l-2 -7h3l4 7' },
        { id: 'tabler-bike', label: 'Bike', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M2 18a3 3 0 1 0 6 0a3 3 0 0 0 -6 0 M16 18a3 3 0 1 0 6 0a3 3 0 0 0 -6 0 M12 19v-4l-3 -3l5 -4l2 3h3 M13.007 5a2 2 0 1 0 4 0a2 2 0 1 0 -4 0' },
        { id: 'tabler-bus', label: 'Bus', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M4 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M16 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M4 17h-2v-11a1 1 0 0 1 1 -1h14a5 7 0 0 1 5 7v5h-2m-4 0h-8 M16 5l1.5 7l4.5 0 M2 10l15 0 M7 5l0 5 M12 5l0 5' },
        { id: 'tabler-car', label: 'Car', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M5 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M15 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M5 17h-2v-6l2 -5h9l4 5h1a2 2 0 0 1 2 2v4h-2m-4 0h-6m-6 -6h15m-6 0v-5' },
        { id: 'tabler-truck', label: 'Truck', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M5 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M15 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M5 17h-2v-11a1 1 0 0 1 1 -1h9v12m-4 0h6m4 0h2v-6h-8m0 -5h5l3 5' },
        { id: 'tabler-train', label: 'Train', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M21 13c0 -3.87 -3.37 -7 -10 -7h-8 M3 15h16a2 2 0 0 0 2 -2 M3 6v5h17.5 M3 11v4 M8 11v-5 M13 11v-4.5 M3 19h18' },
        { id: 'tabler-sailboat', label: 'Sailboat', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M2 20a2.4 2.4 0 0 0 2 1a2.4 2.4 0 0 0 2 -1a2.4 2.4 0 0 1 2 -1a2.4 2.4 0 0 1 2 1a2.4 2.4 0 0 0 2 1a2.4 2.4 0 0 0 2 -1a2.4 2.4 0 0 1 2 -1a2.4 2.4 0 0 1 2 1a2.4 2.4 0 0 0 2 1a2.4 2.4 0 0 0 2 -1 M4 18l-1 -3h18l-1 3 M11 12h7l-7 -9v9 M8 7l-2 5' },
        { id: 'tabler-motorbike', label: 'Motorbike', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M2 16a3 3 0 1 0 6 0a3 3 0 1 0 -6 0 M16 16a3 3 0 1 0 6 0a3 3 0 1 0 -6 0 M7.5 14h5l4 -4h-10.5m1.5 4l4 -4 M13 6h2l1.5 3l2 4' },
        { id: 'tabler-ambulance', label: 'Ambulance', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M5 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M15 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M5 17h-2v-11a1 1 0 0 1 1 -1h9v12m-4 0h6m4 0h2v-6h-8m0 -5h5l3 5 M6 10h4m-2 -2v4' },
        { id: 'tabler-gas-station', label: 'Gas Station', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M14 11h1a2 2 0 0 1 2 2v3a1.5 1.5 0 0 0 3 0v-7l-3 -3 M4 20v-14a2 2 0 0 1 2 -2h6a2 2 0 0 1 2 2v14 M3 20l12 0 M18 7v1a1 1 0 0 0 1 1h1 M4 11l10 0' },
        { id: 'tabler-parking', label: 'Parking', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14 M10 16v-8h2.667c.736 0 1.333 .895 1.333 2s-.597 2 -1.333 2h-2.667' },
        { id: 'tabler-traffic-lights', label: 'Traffic Lights', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M7 7a5 5 0 0 1 5 -5a5 5 0 0 1 5 5v10a5 5 0 0 1 -5 5a5 5 0 0 1 -5 -5l0 -10 M11 7a1 1 0 1 0 2 0a1 1 0 1 0 -2 0 M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0 M11 17a1 1 0 1 0 2 0a1 1 0 1 0 -2 0' },
      ],
    },
    {
      name: 'Tabler Orte',
      items: [
        { id: 'tabler-building', label: 'Building', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M3 21l18 0 M9 8l1 0 M9 12l1 0 M9 16l1 0 M14 8l1 0 M14 12l1 0 M14 16l1 0 M5 21v-16a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v16' },
        { id: 'tabler-home', label: 'Home', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M5 12l-2 0l9 -9l9 9l-2 0 M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7 M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6' },
        { id: 'tabler-tent', label: 'Tent', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M11 14l4 6h6l-9 -16l-9 16h6l4 -6' },
        { id: 'tabler-campfire', label: 'Campfire', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M4 21l16 -4 M20 21l-16 -4 M12 15a4 4 0 0 0 4 -4c0 -3 -2 -3 -2 -8c-4 2 -6 5 -6 8a4 4 0 0 0 4 4' },
        { id: 'tabler-tree', label: 'Tree', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M12 13l-2 -2 M12 12l2 -2 M12 21v-13 M9.824 16a3 3 0 0 1 -2.743 -3.69a3 3 0 0 1 .304 -4.833a3 3 0 0 1 4.615 -3.707a3 3 0 0 1 4.614 3.707a3 3 0 0 1 .305 4.833a3 3 0 0 1 -2.919 3.695h-4l-.176 -.005' },
        { id: 'tabler-trees', label: 'Trees', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M16 5l3 3l-2 1l4 4l-3 1l4 4h-9 M15 21l0 -3 M8 13l-2 -2 M8 12l2 -2 M8 21v-13 M5.824 16a3 3 0 0 1 -2.743 -3.69a3 3 0 0 1 .304 -4.833a3 3 0 0 1 4.615 -3.707a3 3 0 0 1 4.614 3.707a3 3 0 0 1 .305 4.833a3 3 0 0 1 -2.919 3.695h-4l-.176 -.005' },
        { id: 'tabler-mountain', label: 'Mountain', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M3 20h18l-6.921 -14.612a2.3 2.3 0 0 0 -4.158 0l-6.921 14.612 M7.5 11l2 2.5l2.5 -2.5l2 3l2.5 -2' },
        { id: 'tabler-beach', label: 'Beach', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M17.553 16.75a7.5 7.5 0 0 0 -10.606 0 M18 3.804a6 6 0 0 0 -8.196 2.196l10.392 6a6 6 0 0 0 -2.196 -8.196 M16.732 10c1.658 -2.87 2.225 -5.644 1.268 -6.196c-.957 -.552 -3.075 1.326 -4.732 4.196 M15 9l-3 5.196 M3 19.25a2.4 2.4 0 0 1 1 -.25a2.4 2.4 0 0 1 2 1a2.4 2.4 0 0 0 2 1a2.4 2.4 0 0 0 2 -1a2.4 2.4 0 0 1 2 -1a2.4 2.4 0 0 1 2 1a2.4 2.4 0 0 0 2 1a2.4 2.4 0 0 0 2 -1a2.4 2.4 0 0 1 2 -1a2.4 2.4 0 0 1 1 .25' },
        { id: 'tabler-map-pin', label: 'Map Pin', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M9 11a3 3 0 1 0 6 0a3 3 0 0 0 -6 0 M17.657 16.657l-4.243 4.243a2 2 0 0 1 -2.827 0l-4.244 -4.243a8 8 0 1 1 11.314 0' },
        { id: 'tabler-flag', label: 'Flag', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M5 5a5 5 0 0 1 7 0a5 5 0 0 0 7 0v9a5 5 0 0 1 -7 0a5 5 0 0 0 -7 0v-9 M5 21v-7' },
        { id: 'tabler-anchor', label: 'Anchor', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M12 9v12m-8 -8a8 8 0 0 0 16 0m1 0h-2m-14 0h-2 M9 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0' },
        { id: 'tabler-lifebuoy', label: 'Lifebuoy', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0 M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 M15 15l3.35 3.35 M9 15l-3.35 3.35 M5.65 5.65l3.35 3.35 M18.35 5.65l-3.35 3.35' },
      ],
    },
    {
      name: 'Tabler Service',
      items: [
        { id: 'tabler-mail', label: 'Mail', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10 M3 7l9 6l9 -6' },
        { id: 'tabler-phone', label: 'Phone', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M5 4h4l2 5l-2.5 1.5a11 11 0 0 0 5 5l1.5 -2.5l5 2v4a2 2 0 0 1 -2 2a16 16 0 0 1 -15 -15a2 2 0 0 1 2 -2' },
        { id: 'tabler-info-circle', label: 'Info Circle', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0 M12 9h.01 M11 12h1v4h1' },
        { id: 'tabler-question-mark', label: 'Question Mark', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M8 8a3.5 3 0 0 1 3.5 -3h1a3.5 3 0 0 1 3.5 3a3 3 0 0 1 -2 3a3 4 0 0 0 -2 4 M12 19l0 .01' },
        { id: 'tabler-recycle', label: 'Recycle', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M12 17l-2 2l2 2 M10 19h9a2 2 0 0 0 1.75 -2.75l-.55 -1 M8.536 11l-.732 -2.732l-2.732 .732 M7.804 8.268l-4.5 7.794a2 2 0 0 0 1.506 2.89l1.141 .024 M15.464 11l2.732 .732l.732 -2.732 M18.196 11.732l-4.5 -7.794a2 2 0 0 0 -3.256 -.14l-.591 .976' },
        { id: 'tabler-trash', label: 'Trash', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M4 7l16 0 M10 11l0 6 M14 11l0 6 M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12 M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3' },
        { id: 'tabler-tools-kitchen-2', label: 'Tools Kitchen 2', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M19 3v12h-5c-.023 -3.681 .184 -7.406 5 -12m0 12v6h-1v-3m-10 -14v17m-3 -17v3a3 3 0 1 0 6 0v-3' },
        { id: 'tabler-bed', label: 'Bed', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M5 9a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M22 17v-3h-20 M2 8v9 M12 14h10v-2a3 3 0 0 0 -3 -3h-7v5' },
        { id: 'tabler-wheelchair', label: 'Wheelchair', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M3 16a5 5 0 1 0 10 0a5 5 0 1 0 -10 0 M17 19a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M19 17a3 3 0 0 0 -3 -3h-3.4 M3 3h1a2 2 0 0 1 2 2v6 M6 8h11 M15 8v6' },
        { id: 'tabler-toilet-paper', label: 'Toilet Paper', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M3 10a3 7 0 1 0 6 0a3 7 0 1 0 -6 0 M21 10c0 -3.866 -1.343 -7 -3 -7 M6 3h12 M21 10v10l-3 -1l-3 2l-3 -3l-3 2v-10 M6 10h.01' },
        { id: 'tabler-first-aid-kit', label: 'First Aid Kit', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M8 8v-2a2 2 0 0 1 2 -2h4a2 2 0 0 1 2 2v2 M4 10a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -8 M10 14h4 M12 12v4' },
        { id: 'tabler-wifi', label: 'Wifi', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M12 18l.01 0 M9.172 15.172a4 4 0 0 1 5.656 0 M6.343 12.343a8 8 0 0 1 11.314 0 M3.515 9.515c4.686 -4.687 12.284 -4.687 17 0' },
      ],
    },
    {
      name: 'Tabler UI',
      items: [
        { id: 'tabler-bell', label: 'Bell', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6 M9 17v1a3 3 0 0 0 6 0v-1' },
        { id: 'tabler-calendar', label: 'Calendar', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M4 7a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12 M16 3v4 M8 3v4 M4 11h16 M11 15h1 M12 15v3' },
        { id: 'tabler-clock', label: 'Clock', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0 M12 7v5l3 3' },
        { id: 'tabler-camera', label: 'Camera', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M5 7h1a2 2 0 0 0 2 -2a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1a2 2 0 0 0 2 2h1a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2 M9 13a3 3 0 1 0 6 0a3 3 0 0 0 -6 0' },
        { id: 'tabler-printer', label: 'Printer', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M17 17h2a2 2 0 0 0 2 -2v-4a2 2 0 0 0 -2 -2h-14a2 2 0 0 0 -2 2v4a2 2 0 0 0 2 2h2 M17 9v-4a2 2 0 0 0 -2 -2h-6a2 2 0 0 0 -2 2v4 M7 15a2 2 0 0 1 2 -2h6a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-6a2 2 0 0 1 -2 -2l0 -4' },
        { id: 'tabler-download', label: 'Download', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2 M7 11l5 5l5 -5 M12 4l0 12' },
        { id: 'tabler-upload', label: 'Upload', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2 M7 9l5 -5l5 5 M12 4l0 12' },
        { id: 'tabler-search', label: 'Search', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0 M21 21l-6 -6' },
        { id: 'tabler-settings', label: 'Settings', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065 M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0' },
        { id: 'tabler-lock', label: 'Lock', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6 M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0 M8 11v-4a4 4 0 1 1 8 0v4' },
        { id: 'tabler-star', label: 'Star', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873l-6.158 -3.245' },
      ],
    },
    {
      name: 'Tabler Formen',
      items: [
        { id: 'tabler-circle', label: 'Circle', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0' },
        { id: 'tabler-square', label: 'Square', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14' },
        { id: 'tabler-triangle', label: 'Triangle', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0' },
        { id: 'tabler-hexagon', label: 'Hexagon', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M19.875 6.27a2.225 2.225 0 0 1 1.125 1.948v7.284c0 .809 -.443 1.555 -1.158 1.948l-6.75 4.27a2.269 2.269 0 0 1 -2.184 0l-6.75 -4.27a2.225 2.225 0 0 1 -1.158 -1.948v-7.285c0 -.809 .443 -1.554 1.158 -1.947l6.75 -3.98a2.33 2.33 0 0 1 2.25 0l6.75 3.98h-.033' },
        { id: 'tabler-pentagon', label: 'Pentagon', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M13.163 2.168l8.021 5.828c.694 .504 .984 1.397 .719 2.212l-3.064 9.43a1.978 1.978 0 0 1 -1.881 1.367h-9.916a1.978 1.978 0 0 1 -1.881 -1.367l-3.064 -9.43a1.978 1.978 0 0 1 .719 -2.212l8.021 -5.828a1.978 1.978 0 0 1 2.326 0' },
        { id: 'tabler-diamond', label: 'Diamond', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M6 5h12l3 5l-8.5 9.5a.7 .7 0 0 1 -1 0l-8.5 -9.5l3 -5 M10 12l-2 -2.2l.6 -1' },
        { id: 'tabler-heart', label: 'Heart', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572' },
        { id: 'tabler-bookmark', label: 'Bookmark', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M18 7v14l-6 -4l-6 4v-14a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4' },
        { id: 'tabler-tag', label: 'Tag', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M6.5 7.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0 M3 6v5.172a2 2 0 0 0 .586 1.414l7.71 7.71a2.41 2.41 0 0 0 3.408 0l5.592 -5.592a2.41 2.41 0 0 0 0 -3.408l-7.71 -7.71a2 2 0 0 0 -1.414 -.586h-5.172a3 3 0 0 0 -3 3' },
        { id: 'tabler-ticket', label: 'Ticket', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M15 5l0 2 M15 11l0 2 M15 17l0 2 M5 5h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-3a2 2 0 0 0 0 -4v-3a2 2 0 0 1 2 -2' },
        { id: 'tabler-shield', label: 'Shield', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3' },
        { id: 'tabler-certificate', label: 'Certificate', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M12 15a3 3 0 1 0 6 0a3 3 0 1 0 -6 0 M13 17.5v4.5l2 -1.5l2 1.5v-4.5 M10 19h-5a2 2 0 0 1 -2 -2v-10c0 -1.1 .9 -2 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -1 1.73 M6 9l12 0 M6 12l3 0 M6 15l2 0' },
      ],
    },
    {
      name: 'Tabler Pfeile',
      items: [
        { id: 'tabler-arrow-left', label: 'Arrow Left', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M5 12l14 0 M5 12l6 6 M5 12l6 -6' },
        { id: 'tabler-arrow-right', label: 'Arrow Right', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M5 12l14 0 M13 18l6 -6 M13 6l6 6' },
        { id: 'tabler-arrow-up', label: 'Arrow Up', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M12 5l0 14 M18 11l-6 -6 M6 11l6 -6' },
        { id: 'tabler-arrow-down', label: 'Arrow Down', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M12 5l0 14 M18 13l-6 6 M6 13l6 6' },
        { id: 'tabler-arrow-back-up', label: 'Arrow Back Up', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M9 14l-4 -4l4 -4 M5 10h11a4 4 0 1 1 0 8h-1' },
        { id: 'tabler-arrow-forward-up', label: 'Arrow Forward Up', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M15 14l4 -4l-4 -4 M19 10h-11a4 4 0 1 0 0 8h1' },
        { id: 'tabler-arrows-move', label: 'Arrows Move', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M18 9l3 3l-3 3 M15 12h6 M6 9l-3 3l3 3 M3 12h6 M9 18l3 3l3 -3 M12 15v6 M15 6l-3 -3l-3 3 M12 3v6' },
        { id: 'tabler-refresh', label: 'Refresh', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4 M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4' },
        { id: 'tabler-rotate', label: 'Rotate', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M19.95 11a8 8 0 1 0 -.5 4m.5 5v-5h-5' },
        { id: 'tabler-chevron-left', label: 'Chevron Left', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M15 6l-6 6l6 6' },
        { id: 'tabler-chevron-right', label: 'Chevron Right', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M9 6l6 6l-6 6' },
        { id: 'tabler-corner-up-right', label: 'Corner Up Right', kind: 'path', w: 72, h: 72, vbW: 24, vbH: 24, fill: 'none', stroke: '#b8c8a8', strokeW: 2.4, d: 'M6 18v-6a3 3 0 0 1 3 -3h10l-4 -4m0 8l4 -4' },
      ],
    },
    {
      name: 'BI Verkehr',
      items: [
        { id: 'bi-airplane-fill', label: 'Airplane', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M6.428 1.151C6.708.591 7.213 0 8 0s1.292.592 1.572 1.151C9.861 1.73 10 2.431 10 3v3.691l5.17 2.585a1.5 1.5 0 0 1 .83 1.342V12a.5.5 0 0 1-.582.493l-5.507-.918-.375 2.253 1.318 1.318A.5.5 0 0 1 10.5 16h-5a.5.5 0 0 1-.354-.854l1.319-1.318-.376-2.253-5.507.918A.5.5 0 0 1 0 12v-1.382a1.5 1.5 0 0 1 .83-1.342L6 6.691V3c0-.568.14-1.271.428-1.849' },
        { id: 'bi-bus-front-fill', label: 'Bus Front', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M16 7a1 1 0 0 1-1 1v3.5c0 .818-.393 1.544-1 2v2a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1-.5-.5V14H5v1.5a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1-.5-.5v-2a2.5 2.5 0 0 1-1-2V8a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1V2.64C1 1.452 1.845.408 3.064.268A44 44 0 0 1 8 0c2.1 0 3.792.136 4.936.268C14.155.408 15 1.452 15 2.64V4a1 1 0 0 1 1 1zM3.552 3.22A43 43 0 0 1 8 3c1.837 0 3.353.107 4.448.22a.5.5 0 0 0 .104-.994A44 44 0 0 0 8 2c-1.876 0-3.426.109-4.552.226a.5.5 0 1 0 .104.994M8 4c-1.876 0-3.426.109-4.552.226A.5.5 0 0 0 3 4.723v3.554a.5.5 0 0 0 .448.497C4.574 8.891 6.124 9 8 9s3.426-.109 4.552-.226A.5.5 0 0 0 13 8.277V4.723a.5.5 0 0 0-.448-.497A44 44 0 0 0 8 4m-3 7a1 1 0 1 0-2 0 1 1 0 0 0 2 0m8 0a1 1 0 1 0-2 0 1 1 0 0 0 2 0m-7 0a1 1 0 0 0 1 1h2a1 1 0 1 0 0-2H7a1 1 0 0 0-1 1' },
        { id: 'bi-car-front-fill', label: 'Car Front', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M2.52 3.515A2.5 2.5 0 0 1 4.82 2h6.362c1 0 1.904.596 2.298 1.515l.792 1.848c.075.175.21.319.38.404.5.25.855.715.965 1.262l.335 1.679q.05.242.049.49v.413c0 .814-.39 1.543-1 1.997V13.5a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1-.5-.5v-1.338c-1.292.048-2.745.088-4 .088s-2.708-.04-4-.088V13.5a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1-.5-.5v-1.892c-.61-.454-1-1.183-1-1.997v-.413a2.5 2.5 0 0 1 .049-.49l.335-1.68c.11-.546.465-1.012.964-1.261a.8.8 0 0 0 .381-.404l.792-1.848ZM3 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2m10 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2M6 8a1 1 0 0 0 0 2h4a1 1 0 1 0 0-2zM2.906 5.189a.51.51 0 0 0 .497.731c.91-.073 3.35-.17 4.597-.17s3.688.097 4.597.17a.51.51 0 0 0 .497-.731l-.956-1.913A.5.5 0 0 0 11.691 3H4.309a.5.5 0 0 0-.447.276L2.906 5.19Z' },
        { id: 'bi-taxi-front-fill', label: 'Taxi Front', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M6 1a1 1 0 0 0-1 1v1h-.181A2.5 2.5 0 0 0 2.52 4.515l-.792 1.848a.8.8 0 0 1-.38.404c-.5.25-.855.715-.965 1.262L.05 9.708a2.5 2.5 0 0 0-.049.49v.413c0 .814.39 1.543 1 1.997V14.5a.5.5 0 0 0 .5.5h2a.5.5 0 0 0 .5-.5v-1.338c1.292.048 2.745.088 4 .088s2.708-.04 4-.088V14.5a.5.5 0 0 0 .5.5h2a.5.5 0 0 0 .5-.5v-1.892c.61-.454 1-1.183 1-1.997v-.413q0-.248-.049-.49l-.335-1.68a1.8 1.8 0 0 0-.964-1.261.8.8 0 0 1-.381-.404l-.792-1.848A2.5 2.5 0 0 0 11.181 3H11V2a1 1 0 0 0-1-1zM4.309 4h7.382a.5.5 0 0 1 .447.276l.956 1.913a.51.51 0 0 1-.497.731c-.91-.073-3.35-.17-4.597-.17s-3.688.097-4.597.17a.51.51 0 0 1-.497-.731l.956-1.913A.5.5 0 0 1 4.309 4M4 10a1 1 0 1 1-2 0 1 1 0 0 1 2 0m10 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0m-9 0a1 1 0 0 1 1-1h4a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1' },
        { id: 'bi-train-front-fill', label: 'Train Front', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M10.621.515C8.647.02 7.353.02 5.38.515c-.924.23-1.982.766-2.78 1.22C1.566 2.322 1 3.432 1 4.582V13.5A2.5 2.5 0 0 0 3.5 16h9a2.5 2.5 0 0 0 2.5-2.5V4.583c0-1.15-.565-2.26-1.6-2.849-.797-.453-1.855-.988-2.779-1.22ZM6.5 2h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1 0-1m-2 2h7A1.5 1.5 0 0 1 13 5.5v2A1.5 1.5 0 0 1 11.5 9h-7A1.5 1.5 0 0 1 3 7.5v-2A1.5 1.5 0 0 1 4.5 4m.5 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0m0 0a1 1 0 1 1 2 0 1 1 0 0 1-2 0m8 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0m-3-1a1 1 0 1 1 0 2 1 1 0 0 1 0-2M4 5.5a.5.5 0 0 1 .5-.5h3v3h-3a.5.5 0 0 1-.5-.5zM8.5 8V5h3a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-.5.5z' },
        { id: 'bi-truck-front-fill', label: 'Truck Front', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M3.5 0A2.5 2.5 0 0 0 1 2.5v9c0 .818.393 1.544 1 2v2a.5.5 0 0 0 .5.5h2a.5.5 0 0 0 .5-.5V14h6v1.5a.5.5 0 0 0 .5.5h2a.5.5 0 0 0 .5-.5v-2c.607-.456 1-1.182 1-2v-9A2.5 2.5 0 0 0 12.5 0zM3 3a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v3.9c0 .625-.562 1.092-1.17.994C10.925 7.747 9.208 7.5 8 7.5s-2.925.247-3.83.394A1.008 1.008 0 0 1 3 6.9zm1 9a1 1 0 1 1 0-2 1 1 0 0 1 0 2m8 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2m-5-2h2a1 1 0 1 1 0 2H7a1 1 0 1 1 0-2' },
        { id: 'bi-sign-stop-fill', label: 'Sign Stop', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M10.371 8.277v-.553c0-.827-.422-1.234-.987-1.234-.572 0-.99.407-.99 1.234v.553c0 .83.418 1.237.99 1.237.565 0 .987-.408.987-1.237m2.586-.24c.463 0 .735-.272.735-.744s-.272-.741-.735-.741h-.774v1.485z M4.893 0a.5.5 0 0 0-.353.146L.146 4.54A.5.5 0 0 0 0 4.893v6.214a.5.5 0 0 0 .146.353l4.394 4.394a.5.5 0 0 0 .353.146h6.214a.5.5 0 0 0 .353-.146l4.394-4.394a.5.5 0 0 0 .146-.353V4.893a.5.5 0 0 0-.146-.353L11.46.146A.5.5 0 0 0 11.107 0zM3.16 10.08c-.931 0-1.447-.493-1.494-1.132h.653c.065.346.396.583.891.583.524 0 .83-.246.83-.62 0-.303-.203-.467-.637-.572l-.656-.164c-.61-.147-.978-.51-.978-1.078 0-.706.597-1.184 1.444-1.184.853 0 1.386.475 1.436 1.087h-.645c-.064-.32-.352-.542-.797-.542-.472 0-.77.246-.77.6 0 .261.196.437.553.522l.654.161c.673.164 1.06.487 1.06 1.11 0 .736-.574 1.228-1.544 1.228Zm3.427-3.51V10h-.665V6.57H4.753V6h3.006v.568H6.587Zm4.458 1.16v.544c0 1.131-.636 1.805-1.661 1.805-1.026 0-1.664-.674-1.664-1.805V7.73c0-1.136.638-1.807 1.664-1.807s1.66.674 1.66 1.807ZM11.52 6h1.535c.82 0 1.316.55 1.316 1.292 0 .747-.501 1.289-1.321 1.289h-.865V10h-.665V6.001Z' },
        { id: 'bi-sign-yield-fill', label: 'Sign Yield', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M10.48 5.323h-.28v1.353h.28c.372 0 .54-.222.54-.674 0-.45-.169-.68-.54-.68Z M7.022 14.434a1.131 1.131 0 0 0 1.96 0l6.857-11.667c.457-.778-.092-1.767-.98-1.767H1.144c-.889 0-1.437.99-.98 1.767zM5.506 6.232V7H5.11v-.76L4.44 5h.44l.424.849h.016L5.748 5h.428zM6.628 5v2h-.396V5zm.684 1.676h.895V7H6.919V5h1.288v.324h-.895v.513h.842v.303h-.842zm1.521-.013h.848V7H8.437V5h.396zm.97.337V5h.73c.608 0 .895.364.895.995 0 .636-.291 1.005-.895 1.005z' },
        { id: 'bi-sign-no-parking-fill', label: 'Sign No Parking', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M13.292 14A8 8 0 0 1 2 2.707l3.5 3.5V12h1.283V9.164h1.674zm.708-.708-4.37-4.37C10.5 8.524 11 7.662 11 6.587c0-1.482-.955-2.584-2.538-2.584H5.5v.79L2.708 2.002A8 8 0 0 1 14 13.293Z M6.777 7.485v.59h.59zm1.949.535L6.777 6.07v-.966H8.27c.893 0 1.419.539 1.419 1.482 0 .769-.35 1.273-.963 1.433Z' },
        { id: 'bi-sign-turn-left-fill', label: 'Sign Turn Left', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M9.05.435c-.58-.58-1.52-.58-2.1 0L.436 6.95c-.58.58-.58 1.519 0 2.098l6.516 6.516c.58.58 1.519.58 2.098 0l6.516-6.516c.58-.58.58-1.519 0-2.098zM7 8.466a.25.25 0 0 1-.41.192L4.23 6.692a.25.25 0 0 1 0-.384l2.36-1.966a.25.25 0 0 1 .41.192V6h1.5A2.5 2.5 0 0 1 11 8.5V11h-1V8.5A1.5 1.5 0 0 0 8.5 7H7z' },
        { id: 'bi-sign-turn-right-fill', label: 'Sign Turn Right', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M9.05.435c-.58-.58-1.52-.58-2.1 0L.436 6.95c-.58.58-.58 1.519 0 2.098l6.516 6.516c.58.58 1.519.58 2.098 0l6.516-6.516c.58-.58.58-1.519 0-2.098zM9 8.466V7H7.5A1.5 1.5 0 0 0 6 8.5V11H5V8.5A2.5 2.5 0 0 1 7.5 6H9V4.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L9.41 8.658A.25.25 0 0 1 9 8.466' },
        { id: 'bi-sign-merge-left-fill', label: 'Sign Merge Left', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M9.05.435c-.58-.58-1.52-.58-2.1 0L.436 6.95c-.58.58-.58 1.519 0 2.098l6.516 6.516c.58.58 1.519.58 2.098 0l6.516-6.516c.58-.58.58-1.519 0-2.098zM7.25 6H6.034a.25.25 0 0 1-.192-.41l1.966-2.36a.25.25 0 0 1 .384 0l1.966 2.36a.25.25 0 0 1-.192.41H8.75v6h-1.5V8.823c-.551.686-1.229 1.363-1.88 2.015l-.016.016-.708-.708c.757-.756 1.48-1.48 2.016-2.196q.377-.499.588-.95z' },
      ],
    },
    {
      name: 'BI Gebäude',
      items: [
        { id: 'bi-house-fill', label: 'House', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M8.707 1.5a1 1 0 0 0-1.414 0L.646 8.146a.5.5 0 0 0 .708.708L8 2.207l6.646 6.647a.5.5 0 0 0 .708-.708L13 5.793V2.5a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5v1.293z m8 3.293 6 6V13.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5V9.293z' },
        { id: 'bi-houses-fill', label: 'Houses', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M7.207 1a1 1 0 0 0-1.414 0L.146 6.646a.5.5 0 0 0 .708.708L1 7.207V12.5A1.5 1.5 0 0 0 2.5 14h.55a2.5 2.5 0 0 1-.05-.5V9.415a1.5 1.5 0 0 1-.56-2.475l5.353-5.354z M8.793 2a1 1 0 0 1 1.414 0L12 3.793V2.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v3.293l1.854 1.853a.5.5 0 0 1-.708.708L15 8.207V13.5a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 4 13.5V8.207l-.146.147a.5.5 0 1 1-.708-.708z' },
        { id: 'bi-building-fill', label: 'Building', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M3 0a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3v-3.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V16h3a1 1 0 0 0 1-1V1a1 1 0 0 0-1-1zm1 2.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3 0a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3.5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5M4 5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zM7.5 5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5m2.5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zM4.5 8h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5m2.5.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5zm3.5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5' },
        { id: 'bi-buildings-fill', label: 'Buildings', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M15 .5a.5.5 0 0 0-.724-.447l-8 4A.5.5 0 0 0 6 4.5v3.14L.342 9.526A.5.5 0 0 0 0 10v5.5a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V14h1v1.5a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5zM2 11h1v1H2zm2 0h1v1H4zm-1 2v1H2v-1zm1 0h1v1H4zm9-10v1h-1V3zM8 5h1v1H8zm1 2v1H8V7zM8 9h1v1H8zm2 0h1v1h-1zm-1 2v1H8v-1zm1 0h1v1h-1zm3-2v1h-1V9zm-1 2h1v1h-1zm-2-4h1v1h-1zm3 0v1h-1V7zm-2-2v1h-1V5zm1 0h1v1h-1z' },
        { id: 'bi-bank2', label: 'Bank2', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M8.277.084a.5.5 0 0 0-.554 0l-7.5 5A.5.5 0 0 0 .5 6h1.875v7H1.5a.5.5 0 0 0 0 1h13a.5.5 0 1 0 0-1h-.875V6H15.5a.5.5 0 0 0 .277-.916zM12.375 6v7h-1.25V6zm-2.5 0v7h-1.25V6zm-2.5 0v7h-1.25V6zm-2.5 0v7h-1.25V6zM8 4a1 1 0 1 1 0-2 1 1 0 0 1 0 2M.5 15a.5.5 0 0 0 0 1h15a.5.5 0 1 0 0-1z' },
        { id: 'bi-hospital-fill', label: 'Hospital', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M6 0a1 1 0 0 0-1 1v1a1 1 0 0 0-1 1v4H1a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h6v-2.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5V16h6a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-3V3a1 1 0 0 0-1-1V1a1 1 0 0 0-1-1zm2.5 5.034v1.1l.953-.55.5.867L9 7l.953.55-.5.866-.953-.55v1.1h-1v-1.1l-.953.55-.5-.866L7 7l-.953-.55.5-.866.953.55v-1.1zM2.25 9h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5A.25.25 0 0 1 2 9.75v-.5A.25.25 0 0 1 2.25 9m0 2h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25v-.5a.25.25 0 0 1 .25-.25M2 13.25a.25.25 0 0 1 .25-.25h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25zM13.25 9h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25v-.5a.25.25 0 0 1 .25-.25M13 11.25a.25.25 0 0 1 .25-.25h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25zm.25 1.75h.5a.25.25 0 0 1 .25.25v.5a.25.25 0 0 1-.25.25h-.5a.25.25 0 0 1-.25-.25v-.5a.25.25 0 0 1 .25-.25' },
        { id: 'bi-shop', label: 'Shop', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M2.97 1.35A1 1 0 0 1 3.73 1h8.54a1 1 0 0 1 .76.35l2.609 3.044A1.5 1.5 0 0 1 16 5.37v.255a2.375 2.375 0 0 1-4.25 1.458A2.37 2.37 0 0 1 9.875 8 2.37 2.37 0 0 1 8 7.083 2.37 2.37 0 0 1 6.125 8a2.37 2.37 0 0 1-1.875-.917A2.375 2.375 0 0 1 0 5.625V5.37a1.5 1.5 0 0 1 .361-.976zm1.78 4.275a1.375 1.375 0 0 0 2.75 0 .5.5 0 0 1 1 0 1.375 1.375 0 0 0 2.75 0 .5.5 0 0 1 1 0 1.375 1.375 0 1 0 2.75 0V5.37a.5.5 0 0 0-.12-.325L12.27 2H3.73L1.12 5.045A.5.5 0 0 0 1 5.37v.255a1.375 1.375 0 0 0 2.75 0 .5.5 0 0 1 1 0M1.5 8.5A.5.5 0 0 1 2 9v6h1v-5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v5h6V9a.5.5 0 0 1 1 0v6h.5a.5.5 0 0 1 0 1H.5a.5.5 0 0 1 0-1H1V9a.5.5 0 0 1 .5-.5M4 15h3v-5H4zm5-5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1zm3 0h-2v3h2z' },
        { id: 'bi-door-closed-fill', label: 'Door Closed', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M12 1a1 1 0 0 1 1 1v13h1.5a.5.5 0 0 1 0 1h-13a.5.5 0 0 1 0-1H3V2a1 1 0 0 1 1-1zm-2 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2' },
        { id: 'bi-door-open-fill', label: 'Door Open', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M1.5 15a.5.5 0 0 0 0 1h13a.5.5 0 0 0 0-1H13V2.5A1.5 1.5 0 0 0 11.5 1H11V.5a.5.5 0 0 0-.57-.495l-7 1A.5.5 0 0 0 3 1.5V15zM11 2h.5a.5.5 0 0 1 .5.5V15h-1zm-2.5 8c-.276 0-.5-.448-.5-1s.224-1 .5-1 .5.448.5 1-.224 1-.5 1' },
        { id: 'bi-signpost-fill', label: 'Signpost', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M7.293.707A1 1 0 0 0 7 1.414V4H2a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h5v6h2v-6h3.532a1 1 0 0 0 .768-.36l1.933-2.32a.5.5 0 0 0 0-.64L13.3 4.36a1 1 0 0 0-.768-.36H9V1.414A1 1 0 0 0 7.293.707' },
        { id: 'bi-tree-fill', label: 'Tree', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M8.416.223a.5.5 0 0 0-.832 0l-3 4.5A.5.5 0 0 0 5 5.5h.098L3.076 8.735A.5.5 0 0 0 3.5 9.5h.191l-1.638 3.276a.5.5 0 0 0 .447.724H7V16h2v-2.5h4.5a.5.5 0 0 0 .447-.724L12.31 9.5h.191a.5.5 0 0 0 .424-.765L10.902 5.5H11a.5.5 0 0 0 .416-.777z' },
      ],
    },
    {
      name: 'BI Service',
      items: [
        { id: 'bi-telephone-fill', label: 'Telephone', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M1.885.511a1.745 1.745 0 0 1 2.61.163L6.29 2.98c.329.423.445.974.315 1.494l-.547 2.19a.68.68 0 0 0 .178.643l2.457 2.457a.68.68 0 0 0 .644.178l2.189-.547a1.75 1.75 0 0 1 1.494.315l2.306 1.794c.829.645.905 1.87.163 2.611l-1.034 1.034c-.74.74-1.846 1.065-2.877.702a18.6 18.6 0 0 1-7.01-4.42 18.6 18.6 0 0 1-4.42-7.009c-.362-1.03-.037-2.137.703-2.877z' },
        { id: 'bi-envelope-fill', label: 'Envelope', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M.05 3.555A2 2 0 0 1 2 2h12a2 2 0 0 1 1.95 1.555L8 8.414zM0 4.697v7.104l5.803-3.558zM6.761 8.83l-6.57 4.027A2 2 0 0 0 2 14h12a2 2 0 0 0 1.808-1.144l-6.57-4.027L8 9.586zm3.436-.586L16 11.801V4.697z' },
        { id: 'bi-printer-fill', label: 'Printer', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M5 1a2 2 0 0 0-2 2v1h10V3a2 2 0 0 0-2-2zm6 8H5a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1 M0 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-1v-2a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2H2a2 2 0 0 1-2-2zm2.5 1a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1' },
        { id: 'bi-trash-fill', label: 'Trash', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M2.5 1a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1H3v9a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V4h.5a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H10a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1zm3 4a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 .5-.5M8 5a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7A.5.5 0 0 1 8 5m3 .5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 1 0' },
        { id: 'bi-recycle', label: 'Recycle', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M9.302 1.256a1.5 1.5 0 0 0-2.604 0l-1.704 2.98a.5.5 0 0 0 .869.497l1.703-2.981a.5.5 0 0 1 .868 0l2.54 4.444-1.256-.337a.5.5 0 1 0-.26.966l2.415.647a.5.5 0 0 0 .613-.353l.647-2.415a.5.5 0 1 0-.966-.259l-.333 1.242zM2.973 7.773l-1.255.337a.5.5 0 1 1-.26-.966l2.416-.647a.5.5 0 0 1 .612.353l.647 2.415a.5.5 0 0 1-.966.259l-.333-1.242-2.545 4.454a.5.5 0 0 0 .434.748H5a.5.5 0 0 1 0 1H1.723A1.5 1.5 0 0 1 .421 12.24zm10.89 1.463a.5.5 0 1 0-.868.496l1.716 3.004a.5.5 0 0 1-.434.748h-5.57l.647-.646a.5.5 0 1 0-.708-.707l-1.5 1.5a.5.5 0 0 0 0 .707l1.5 1.5a.5.5 0 1 0 .708-.707l-.647-.647h5.57a1.5 1.5 0 0 0 1.302-2.244z' },
        { id: 'bi-router-fill', label: 'Router', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M5.525 3.025a3.5 3.5 0 0 1 4.95 0 .5.5 0 1 0 .707-.707 4.5 4.5 0 0 0-6.364 0 .5.5 0 0 0 .707.707 M6.94 4.44a1.5 1.5 0 0 1 2.12 0 .5.5 0 0 0 .708-.708 2.5 2.5 0 0 0-3.536 0 .5.5 0 0 0 .707.707Z M2.974 2.342a.5.5 0 1 0-.948.316L3.806 8H1.5A1.5 1.5 0 0 0 0 9.5v2A1.5 1.5 0 0 0 1.5 13H2a.5.5 0 0 0 .5.5h2A.5.5 0 0 0 5 13h6a.5.5 0 0 0 .5.5h2a.5.5 0 0 0 .5-.5h.5a1.5 1.5 0 0 0 1.5-1.5v-2A1.5 1.5 0 0 0 14.5 8h-2.306l1.78-5.342a.5.5 0 1 0-.948-.316L11.14 8H4.86zM2.5 11a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1m4.5-.5a.5.5 0 1 1 1 0 .5.5 0 0 1-1 0m2.5.5a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1m1.5-.5a.5.5 0 1 1 1 0 .5.5 0 0 1-1 0m2 0a.5.5 0 1 1 1 0 .5.5 0 0 1-1 0 M8.5 5.5a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0' },
        { id: 'bi-plug-fill', label: 'Plug', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M6 0a.5.5 0 0 1 .5.5V3h3V.5a.5.5 0 0 1 1 0V3h1a.5.5 0 0 1 .5.5v3A3.5 3.5 0 0 1 8.5 10c-.002.434-.01.845-.04 1.22-.041.514-.126 1.003-.317 1.424a2.08 2.08 0 0 1-.97 1.028C6.725 13.9 6.169 14 5.5 14c-.998 0-1.61.33-1.974.718A1.92 1.92 0 0 0 3 16H2c0-.616.232-1.367.797-1.968C3.374 13.42 4.261 13 5.5 13c.581 0 .962-.088 1.218-.219.241-.123.4-.3.514-.55.121-.266.193-.621.23-1.09.027-.34.035-.718.037-1.141A3.5 3.5 0 0 1 4 6.5v-3a.5.5 0 0 1 .5-.5h1V.5A.5.5 0 0 1 6 0' },
        { id: 'bi-usb-drive-fill', label: 'Usb Drive', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M6 .5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v4H6zM7 1v1h1V1zm2 0v1h1V1zM5.5 5a.5.5 0 0 0-.5.5V15a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V5.5a.5.5 0 0 0-.5-.5z' },
        { id: 'bi-wrench-adjustable-circle-fill', label: 'Wrench Adjustable Circle', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M6.705 8.139a.25.25 0 0 0-.288-.376l-1.5.5.159.474.808-.27-.595.894a.25.25 0 0 0 .287.376l.808-.27-.595.894a.25.25 0 0 0 .287.376l1.5-.5-.159-.474-.808.27.596-.894a.25.25 0 0 0-.288-.376l-.808.27z M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16m-6.202-4.751 1.988-1.657a4.5 4.5 0 0 1 7.537-4.623L7.497 6.5l1 2.5 1.333 3.11c-.56.251-1.18.39-1.833.39a4.5 4.5 0 0 1-1.592-.29L4.747 14.2a7.03 7.03 0 0 1-2.949-2.951M12.496 8a4.5 4.5 0 0 1-1.703 3.526L9.497 8.5l2.959-1.11q.04.3.04.61' },
        { id: 'bi-gear-fill', label: 'Gear', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z' },
        { id: 'bi-tools', label: 'Tools', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M1 0 0 1l2.2 3.081a1 1 0 0 0 .815.419h.07a1 1 0 0 1 .708.293l2.675 2.675-2.617 2.654A3.003 3.003 0 0 0 0 13a3 3 0 1 0 5.878-.851l2.654-2.617.968.968-.305.914a1 1 0 0 0 .242 1.023l3.27 3.27a.997.997 0 0 0 1.414 0l1.586-1.586a.997.997 0 0 0 0-1.414l-3.27-3.27a1 1 0 0 0-1.023-.242L10.5 9.5l-.96-.96 2.68-2.643A3.005 3.005 0 0 0 16 3q0-.405-.102-.777l-2.14 2.141L12 4l-.364-1.757L13.777.102a3 3 0 0 0-3.675 3.68L7.462 6.46 4.793 3.793a1 1 0 0 1-.293-.707v-.071a1 1 0 0 0-.419-.814zm9.646 10.646a.5.5 0 0 1 .708 0l2.914 2.915a.5.5 0 0 1-.707.707l-2.915-2.914a.5.5 0 0 1 0-.708M3 11l.471.242.529.026.287.445.445.287.026.529L5 13l-.242.471-.026.529-.445.287-.287.445-.529.026L3 15l-.471-.242L2 14.732l-.287-.445L1.268 14l-.026-.529L1 13l.242-.471.026-.529.445-.287.287-.445.529-.026z' },
      ],
    },
    {
      name: 'BI UI',
      items: [
        { id: 'bi-check-circle-fill', label: 'Check Circle', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0m-3.97-3.03a.75.75 0 0 0-1.08.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-.01-1.05z' },
        { id: 'bi-x-circle-fill', label: 'X Circle', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0M5.354 4.646a.5.5 0 1 0-.708.708L7.293 8l-2.647 2.646a.5.5 0 0 0 .708.708L8 8.707l2.646 2.647a.5.5 0 0 0 .708-.708L8.707 8l2.647-2.646a.5.5 0 0 0-.708-.708L8 7.293z' },
        { id: 'bi-exclamation-triangle-fill', label: 'Exclamation Triangle', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5m.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2' },
        { id: 'bi-info-circle-fill', label: 'Info Circle', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16m.93-9.412-1 4.705c-.07.34.029.533.304.533.194 0 .487-.07.686-.246l-.088.416c-.287.346-.92.598-1.465.598-.703 0-1.002-.422-.808-1.319l.738-3.468c.064-.293.006-.399-.287-.47l-.451-.081.082-.381 2.29-.287zM8 5.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2' },
        { id: 'bi-question-circle-fill', label: 'Question Circle', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0M5.496 6.033h.825c.138 0 .248-.113.266-.25.09-.656.54-1.134 1.342-1.134.686 0 1.314.343 1.314 1.168 0 .635-.374.927-.965 1.371-.673.489-1.206 1.06-1.168 1.987l.003.217a.25.25 0 0 0 .25.246h.811a.25.25 0 0 0 .25-.25v-.105c0-.718.273-.927 1.01-1.486.609-.463 1.244-.977 1.244-2.056 0-1.511-1.276-2.241-2.673-2.241-1.267 0-2.655.59-2.75 2.286a.237.237 0 0 0 .241.247m2.325 6.443c.61 0 1.029-.394 1.029-.927 0-.552-.42-.94-1.029-.94-.584 0-1.009.388-1.009.94 0 .533.425.927 1.01.927z' },
        { id: 'bi-plus-circle-fill', label: 'Plus Circle', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0M8.5 4.5a.5.5 0 0 0-1 0v3h-3a.5.5 0 0 0 0 1h3v3a.5.5 0 0 0 1 0v-3h3a.5.5 0 0 0 0-1h-3z' },
        { id: 'bi-dash-circle-fill', label: 'Dash Circle', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0M4.5 7.5a.5.5 0 0 0 0 1h7a.5.5 0 0 0 0-1z' },
        { id: 'bi-play-fill', label: 'Play', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'm11.596 8.697-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393' },
        { id: 'bi-pause-fill', label: 'Pause', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M5.5 3.5A1.5 1.5 0 0 1 7 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5m5 0A1.5 1.5 0 0 1 12 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5' },
        { id: 'bi-stop-fill', label: 'Stop', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M5 3.5h6A1.5 1.5 0 0 1 12.5 5v6a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 11V5A1.5 1.5 0 0 1 5 3.5' },
        { id: 'bi-bell-fill', label: 'Bell', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M8 16a2 2 0 0 0 2-2H6a2 2 0 0 0 2 2m.995-14.901a1 1 0 1 0-1.99 0A5 5 0 0 0 3 6c0 1.098-.5 6-2 7h14c-1.5-1-2-5.902-2-7 0-2.42-1.72-4.44-4.005-4.901' },
        { id: 'bi-calendar-fill', label: 'Calendar', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M3.5 0a.5.5 0 0 1 .5.5V1h8V.5a.5.5 0 0 1 1 0V1h1a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V5h16V4H0V3a2 2 0 0 1 2-2h1V.5a.5.5 0 0 1 .5-.5' },
        { id: 'bi-clock-fill', label: 'Clock', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0M8 3.5a.5.5 0 0 0-1 0V9a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 0 0 .496-.868L8 8.71z' },
        { id: 'bi-bookmark-fill', label: 'Bookmark', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M2 2v13.5a.5.5 0 0 0 .74.439L8 13.069l5.26 2.87A.5.5 0 0 0 14 15.5V2a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2' },
      ],
    },
    {
      name: 'BI Objekte',
      items: [
        { id: 'bi-briefcase-fill', label: 'Briefcase', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M6.5 1A1.5 1.5 0 0 0 5 2.5V3H1.5A1.5 1.5 0 0 0 0 4.5v1.384l7.614 2.03a1.5 1.5 0 0 0 .772 0L16 5.884V4.5A1.5 1.5 0 0 0 14.5 3H11v-.5A1.5 1.5 0 0 0 9.5 1zm0 1h3a.5.5 0 0 1 .5.5V3H6v-.5a.5.5 0 0 1 .5-.5 M0 12.5A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V6.85L8.129 8.947a.5.5 0 0 1-.258 0L0 6.85z' },
        { id: 'bi-bag-fill', label: 'Bag', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M8 1a2.5 2.5 0 0 1 2.5 2.5V4h-5v-.5A2.5 2.5 0 0 1 8 1m3.5 3v-.5a3.5 3.5 0 1 0-7 0V4H1v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4z' },
        { id: 'bi-basket-fill', label: 'Basket', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M5.071 1.243a.5.5 0 0 1 .858.514L3.383 6h9.234L10.07 1.757a.5.5 0 1 1 .858-.514L13.783 6H15.5a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-.5.5H15v5a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V9H.5a.5.5 0 0 1-.5-.5v-2A.5.5 0 0 1 .5 6h1.717zM3.5 10.5a.5.5 0 1 0-1 0v3a.5.5 0 0 0 1 0zm2.5 0a.5.5 0 1 0-1 0v3a.5.5 0 0 0 1 0zm2.5 0a.5.5 0 1 0-1 0v3a.5.5 0 0 0 1 0zm2.5 0a.5.5 0 1 0-1 0v3a.5.5 0 0 0 1 0zm2.5 0a.5.5 0 1 0-1 0v3a.5.5 0 0 0 1 0z' },
        { id: 'bi-cart-fill', label: 'Cart', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M0 1.5A.5.5 0 0 1 .5 1H2a.5.5 0 0 1 .485.379L2.89 3H14.5a.5.5 0 0 1 .491.592l-1.5 8A.5.5 0 0 1 13 12H4a.5.5 0 0 1-.491-.408L2.01 3.607 1.61 2H.5a.5.5 0 0 1-.5-.5M5 12a2 2 0 1 0 0 4 2 2 0 0 0 0-4m7 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4m-7 1a1 1 0 1 1 0 2 1 1 0 0 1 0-2m7 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2' },
        { id: 'bi-box-fill', label: 'Box', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M15.528 2.973a.75.75 0 0 1 .472.696v8.662a.75.75 0 0 1-.472.696l-7.25 2.9a.75.75 0 0 1-.557 0l-7.25-2.9A.75.75 0 0 1 0 12.331V3.669a.75.75 0 0 1 .471-.696L7.443.184l.004-.001.274-.11a.75.75 0 0 1 .558 0l.274.11.004.001zm-1.374.527L8 5.962 1.846 3.5 1 3.839v.4l6.5 2.6v7.922l.5.2.5-.2V6.84l6.5-2.6v-.4l-.846-.339Z' },
        { id: 'bi-archive-fill', label: 'Archive', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M12.643 15C13.979 15 15 13.845 15 12.5V5H1v7.5C1 13.845 2.021 15 3.357 15zM5.5 7h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1M.8 1a.8.8 0 0 0-.8.8V3a.8.8 0 0 0 .8.8h14.4A.8.8 0 0 0 16 3V1.8a.8.8 0 0 0-.8-.8z' },
        { id: 'bi-safe-fill', label: 'Safe', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M9.778 9.414A2 2 0 1 1 6.95 6.586a2 2 0 0 1 2.828 2.828 M2.5 0A1.5 1.5 0 0 0 1 1.5V3H.5a.5.5 0 0 0 0 1H1v3.5H.5a.5.5 0 0 0 0 1H1V12H.5a.5.5 0 0 0 0 1H1v1.5A1.5 1.5 0 0 0 2.5 16h12a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 14.5 0zm3.036 4.464 1.09 1.09a3 3 0 0 1 3.476 0l1.09-1.09a.5.5 0 1 1 .707.708l-1.09 1.09c.74 1.037.74 2.44 0 3.476l1.09 1.09a.5.5 0 1 1-.707.708l-1.09-1.09a3 3 0 0 1-3.476 0l-1.09 1.09a.5.5 0 1 1-.708-.708l1.09-1.09a3 3 0 0 1 0-3.476l-1.09-1.09a.5.5 0 1 1 .708-.708M14 6.5v3a.5.5 0 0 1-1 0v-3a.5.5 0 0 1 1 0' },
        { id: 'bi-wallet-fill', label: 'Wallet', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M1.5 2A1.5 1.5 0 0 0 0 3.5v2h6a.5.5 0 0 1 .5.5c0 .253.08.644.306.958.207.288.557.542 1.194.542s.987-.254 1.194-.542C9.42 6.644 9.5 6.253 9.5 6a.5.5 0 0 1 .5-.5h6v-2A1.5 1.5 0 0 0 14.5 2z M16 6.5h-5.551a2.7 2.7 0 0 1-.443 1.042C9.613 8.088 8.963 8.5 8 8.5s-1.613-.412-2.006-.958A2.7 2.7 0 0 1 5.551 6.5H0v6A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5z' },
        { id: 'bi-credit-card-fill', label: 'Credit Card', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M0 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1H0zm0 3v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7zm3 2h1a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1' },
        { id: 'bi-gift-fill', label: 'Gift', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M3 2.5a2.5 2.5 0 0 1 5 0 2.5 2.5 0 0 1 5 0v.006c0 .07 0 .27-.038.494H15a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h2.038A3 3 0 0 1 3 2.506zm1.068.5H7v-.5a1.5 1.5 0 1 0-3 0c0 .085.002.274.045.43zM9 3h2.932l.023-.07c.043-.156.045-.345.045-.43a1.5 1.5 0 0 0-3 0zm6 4v7.5a1.5 1.5 0 0 1-1.5 1.5H9V7zM2.5 16A1.5 1.5 0 0 1 1 14.5V7h6v9z' },
        { id: 'bi-ticket-fill', label: 'Ticket', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M1.5 3A1.5 1.5 0 0 0 0 4.5V6a.5.5 0 0 0 .5.5 1.5 1.5 0 1 1 0 3 .5.5 0 0 0-.5.5v1.5A1.5 1.5 0 0 0 1.5 13h13a1.5 1.5 0 0 0 1.5-1.5V10a.5.5 0 0 0-.5-.5 1.5 1.5 0 0 1 0-3A.5.5 0 0 0 16 6V4.5A1.5 1.5 0 0 0 14.5 3z' },
        { id: 'bi-camera-fill', label: 'Camera', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M10.5 8.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0 M2 4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-1.172a2 2 0 0 1-1.414-.586l-.828-.828A2 2 0 0 0 9.172 2H6.828a2 2 0 0 0-1.414.586l-.828.828A2 2 0 0 1 3.172 4zm.5 2a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1m9 2.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0' },
        { id: 'bi-image-fill', label: 'Image', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M.002 3a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-12a2 2 0 0 1-2-2zm1 9v1a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5l-3.777-1.947a.5.5 0 0 0-.577.093l-3.71 3.71-2.66-1.772a.5.5 0 0 0-.63.062zm5-6.5a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0' },
        { id: 'bi-palette-fill', label: 'Palette', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M12.433 10.07C14.133 10.585 16 11.15 16 8a8 8 0 1 0-8 8c1.996 0 1.826-1.504 1.649-3.08-.124-1.101-.252-2.237.351-2.92.465-.527 1.42-.237 2.433.07M8 5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m4.5 3a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3M5 6.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0m.5 6.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3' },
        { id: 'bi-brush-fill', label: 'Brush', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M15.825.12a.5.5 0 0 1 .132.584c-1.53 3.43-4.743 8.17-7.095 10.64a6.1 6.1 0 0 1-2.373 1.534c-.018.227-.06.538-.16.868-.201.659-.667 1.479-1.708 1.74a8.1 8.1 0 0 1-3.078.132 4 4 0 0 1-.562-.135 1.4 1.4 0 0 1-.466-.247.7.7 0 0 1-.204-.288.62.62 0 0 1 .004-.443c.095-.245.316-.38.461-.452.394-.197.625-.453.867-.826.095-.144.184-.297.287-.472l.117-.198c.151-.255.326-.54.546-.848.528-.739 1.201-.925 1.746-.896q.19.012.348.048c.062-.172.142-.38.238-.608.261-.619.658-1.419 1.187-2.069 2.176-2.67 6.18-6.206 9.117-8.104a.5.5 0 0 1 .596.04' },
        { id: 'bi-bucket-fill', label: 'Bucket', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M2.522 5H2a.5.5 0 0 0-.494.574l1.372 9.149A1.5 1.5 0 0 0 4.36 16h7.278a1.5 1.5 0 0 0 1.483-1.277l1.373-9.149A.5.5 0 0 0 14 5h-.522A5.5 5.5 0 0 0 2.522 5m1.005 0a4.5 4.5 0 0 1 8.945 0z' },
      ],
    },
    {
      name: 'BI Freizeit',
      items: [
        { id: 'bi-cup-hot-fill', label: 'Cup Hot', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M.5 6a.5.5 0 0 0-.488.608l1.652 7.434A2.5 2.5 0 0 0 4.104 16h5.792a2.5 2.5 0 0 0 2.44-1.958l.131-.59a3 3 0 0 0 1.3-5.854l.221-.99A.5.5 0 0 0 13.5 6zM13 12.5a2 2 0 0 1-.316-.025l.867-3.898A2.001 2.001 0 0 1 13 12.5 m4.4.8-.003.004-.014.019a4 4 0 0 0-.204.31 2 2 0 0 0-.141.267c-.026.06-.034.092-.037.103v.004a.6.6 0 0 0 .091.248c.075.133.178.272.308.445l.01.012c.118.158.26.347.37.543.112.2.22.455.22.745 0 .188-.065.368-.119.494a3 3 0 0 1-.202.388 5 5 0 0 1-.253.382l-.018.025-.005.008-.002.002A.5.5 0 0 1 3.6 4.2l.003-.004.014-.019a4 4 0 0 0 .204-.31 2 2 0 0 0 .141-.267c.026-.06.034-.092.037-.103a.6.6 0 0 0-.09-.252A4 4 0 0 0 3.6 2.8l-.01-.012a5 5 0 0 1-.37-.543A1.53 1.53 0 0 1 3 1.5c0-.188.065-.368.119-.494.059-.138.134-.274.202-.388a6 6 0 0 1 .253-.382l.025-.035A.5.5 0 0 1 4.4.8m3 0-.003.004-.014.019a4 4 0 0 0-.204.31 2 2 0 0 0-.141.267c-.026.06-.034.092-.037.103v.004a.6.6 0 0 0 .091.248c.075.133.178.272.308.445l.01.012c.118.158.26.347.37.543.112.2.22.455.22.745 0 .188-.065.368-.119.494a3 3 0 0 1-.202.388 5 5 0 0 1-.253.382l-.018.025-.005.008-.002.002A.5.5 0 0 1 6.6 4.2l.003-.004.014-.019a4 4 0 0 0 .204-.31 2 2 0 0 0 .141-.267c.026-.06.034-.092.037-.103a.6.6 0 0 0-.09-.252A4 4 0 0 0 6.6 2.8l-.01-.012a5 5 0 0 1-.37-.543A1.53 1.53 0 0 1 6 1.5c0-.188.065-.368.119-.494.059-.138.134-.274.202-.388a6 6 0 0 1 .253-.382l.025-.035A.5.5 0 0 1 7.4.8m3 0-.003.004-.014.019a4 4 0 0 0-.204.31 2 2 0 0 0-.141.267c-.026.06-.034.092-.037.103v.004a.6.6 0 0 0 .091.248c.075.133.178.272.308.445l.01.012c.118.158.26.347.37.543.112.2.22.455.22.745 0 .188-.065.368-.119.494a3 3 0 0 1-.202.388 5 5 0 0 1-.252.382l-.019.025-.005.008-.002.002A.5.5 0 0 1 9.6 4.2l.003-.004.014-.019a4 4 0 0 0 .204-.31 2 2 0 0 0 .141-.267c.026-.06.034-.092.037-.103a.6.6 0 0 0-.09-.252A4 4 0 0 0 9.6 2.8l-.01-.012a5 5 0 0 1-.37-.543A1.53 1.53 0 0 1 9 1.5c0-.188.065-.368.119-.494.059-.138.134-.274.202-.388a6 6 0 0 1 .253-.382l.025-.035A.5.5 0 0 1 10.4.8' },
        { id: 'bi-cup-straw', label: 'Cup Straw', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M13.902.334a.5.5 0 0 1-.28.65l-2.254.902-.4 1.927c.376.095.715.215.972.367.228.135.56.396.56.82q0 .069-.011.132l-.962 9.068a1.28 1.28 0 0 1-.524.93c-.488.34-1.494.87-3.01.87s-2.522-.53-3.01-.87a1.28 1.28 0 0 1-.524-.93L3.51 5.132A1 1 0 0 1 3.5 5c0-.424.332-.685.56-.82.262-.154.607-.276.99-.372C5.824 3.614 6.867 3.5 8 3.5c.712 0 1.389.045 1.985.127l.464-2.215a.5.5 0 0 1 .303-.356l2.5-1a.5.5 0 0 1 .65.278M9.768 4.607A14 14 0 0 0 8 4.5c-1.076 0-2.033.11-2.707.278A3.3 3.3 0 0 0 4.645 5c.146.073.362.15.648.222C5.967 5.39 6.924 5.5 8 5.5c.571 0 1.109-.03 1.588-.085zm.292 1.756C9.445 6.45 8.742 6.5 8 6.5c-1.133 0-2.176-.114-2.95-.308a6 6 0 0 1-.435-.127l.838 8.03c.013.121.06.186.102.215.357.249 1.168.69 2.438.69s2.081-.441 2.438-.69c.042-.029.09-.094.102-.215l.852-8.03a6 6 0 0 1-.435.127 9 9 0 0 1-.89.17zM4.467 4.884s.003.002.005.006zm7.066 0-.005.006zM11.354 5a3 3 0 0 0-.604-.21l-.099.445.055-.013c.286-.072.502-.149.648-.222' },
        { id: 'bi-cake-fill', label: 'Cake', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'm7.399.804.595-.792.598.79A.747.747 0 0 1 8.5 1.806V4H11a2 2 0 0 1 2 2v3h1a2 2 0 0 1 2 2v4a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1v-4a2 2 0 0 1 2-2h1V6a2 2 0 0 1 2-2h2.5V1.813a.747.747 0 0 1-.101-1.01ZM12 6.414a.9.9 0 0 1-.646-.268 1.914 1.914 0 0 0-2.708 0 .914.914 0 0 1-1.292 0 1.914 1.914 0 0 0-2.708 0A.9.9 0 0 1 4 6.414v1c.49 0 .98-.187 1.354-.56a.914.914 0 0 1 1.292 0c.748.747 1.96.747 2.708 0a.914.914 0 0 1 1.292 0c.374.373.864.56 1.354.56zm2.646 5.732a.914.914 0 0 1-1.293 0 1.914 1.914 0 0 0-2.707 0 .914.914 0 0 1-1.292 0 1.914 1.914 0 0 0-2.708 0 .914.914 0 0 1-1.292 0 1.914 1.914 0 0 0-2.708 0 .914.914 0 0 1-1.292 0L1 11.793v1.34c.737.452 1.715.36 2.354-.28a.914.914 0 0 1 1.292 0c.748.748 1.96.748 2.708 0a.914.914 0 0 1 1.292 0c.748.748 1.96.748 2.707 0a.914.914 0 0 1 1.293 0 1.915 1.915 0 0 0 2.354.28v-1.34z' },
        { id: 'bi-balloon-fill', label: 'Balloon', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M8.48 10.901C11.211 10.227 13 7.837 13 5A5 5 0 0 0 3 5c0 2.837 1.789 5.227 4.52 5.901l-.244.487a.25.25 0 1 0 .448.224l.04-.08c.009.17.024.315.051.45.068.344.208.622.448 1.102l.013.028c.212.422.182.85.05 1.246-.135.402-.366.751-.534 1.003a.25.25 0 0 0 .416.278l.004-.007c.166-.248.431-.646.588-1.115.16-.479.212-1.051-.076-1.629-.258-.515-.365-.732-.419-1.004a2 2 0 0 1-.037-.289l.008.017a.25.25 0 1 0 .448-.224zM4.352 3.356a4 4 0 0 1 3.15-2.325C7.774.997 8 1.224 8 1.5s-.226.496-.498.542c-.95.162-1.749.78-2.173 1.617a.6.6 0 0 1-.52.341c-.346 0-.599-.329-.457-.644' },
        { id: 'bi-suit-heart-fill', label: 'Suit Heart', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M4 1c2.21 0 4 1.755 4 3.92C8 2.755 9.79 1 12 1s4 1.755 4 3.92c0 3.263-3.234 4.414-7.608 9.608a.513.513 0 0 1-.784 0C3.234 9.334 0 8.183 0 4.92 0 2.755 1.79 1 4 1' },
        { id: 'bi-star-fill', label: 'Star', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z' },
        { id: 'bi-trophy-fill', label: 'Trophy', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M2.5.5A.5.5 0 0 1 3 0h10a.5.5 0 0 1 .5.5q0 .807-.034 1.536a3 3 0 1 1-1.133 5.89c-.79 1.865-1.878 2.777-2.833 3.011v2.173l1.425.356c.194.048.377.135.537.255L13.3 15.1a.5.5 0 0 1-.3.9H3a.5.5 0 0 1-.3-.9l1.838-1.379c.16-.12.343-.207.537-.255L6.5 13.11v-2.173c-.955-.234-2.043-1.146-2.833-3.012a3 3 0 1 1-1.132-5.89A33 33 0 0 1 2.5.5m.099 2.54a2 2 0 0 0 .72 3.935c-.333-1.05-.588-2.346-.72-3.935m10.083 3.935a2 2 0 0 0 .72-3.935c-.133 1.59-.388 2.885-.72 3.935' },
        { id: 'bi-umbrella-fill', label: 'Umbrella', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M8 0a.5.5 0 0 1 .5.5v.514C12.625 1.238 16 4.22 16 8c0 0 0 .5-.5.5-.149 0-.352-.145-.352-.145l-.004-.004-.025-.023a3.5 3.5 0 0 0-.555-.394A3.17 3.17 0 0 0 13 7.5c-.638 0-1.178.213-1.564.434a3.5 3.5 0 0 0-.555.394l-.025.023-.003.003s-.204.146-.353.146-.352-.145-.352-.145l-.004-.004-.025-.023a3.5 3.5 0 0 0-.555-.394 3.3 3.3 0 0 0-1.064-.39V13.5H8h.5v.039l-.005.083a3 3 0 0 1-.298 1.102 2.26 2.26 0 0 1-.763.88C7.06 15.851 6.587 16 6 16s-1.061-.148-1.434-.396a2.26 2.26 0 0 1-.763-.88 3 3 0 0 1-.302-1.185v-.025l-.001-.009v-.003s0-.002.5-.002h-.5V13a.5.5 0 0 1 1 0v.506l.003.044a2 2 0 0 0 .195.726c.095.191.23.367.423.495.19.127.466.229.879.229s.689-.102.879-.229c.193-.128.328-.304.424-.495a2 2 0 0 0 .197-.77V7.544a3.3 3.3 0 0 0-1.064.39 3.5 3.5 0 0 0-.58.417l-.004.004S5.65 8.5 5.5 8.5s-.352-.145-.352-.145l-.004-.004a3.5 3.5 0 0 0-.58-.417A3.17 3.17 0 0 0 3 7.5c-.638 0-1.177.213-1.564.434a3.5 3.5 0 0 0-.58.417l-.004.004S.65 8.5.5 8.5C0 8.5 0 8 0 8c0-3.78 3.375-6.762 7.5-6.986V.5A.5.5 0 0 1 8 0' },
        { id: 'bi-sun-fill', label: 'Sun', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M8 0a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 0m0 13a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 13m8-5a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2a.5.5 0 0 1 .5.5M3 8a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2A.5.5 0 0 1 3 8m10.657-5.657a.5.5 0 0 1 0 .707l-1.414 1.415a.5.5 0 1 1-.707-.708l1.414-1.414a.5.5 0 0 1 .707 0m-9.193 9.193a.5.5 0 0 1 0 .707L3.05 13.657a.5.5 0 0 1-.707-.707l1.414-1.414a.5.5 0 0 1 .707 0m9.193 2.121a.5.5 0 0 1-.707 0l-1.414-1.414a.5.5 0 0 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .707M4.464 4.465a.5.5 0 0 1-.707 0L2.343 3.05a.5.5 0 1 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .708' },
        { id: 'bi-moon-fill', label: 'Moon', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M6 .278a.77.77 0 0 1 .08.858 7.2 7.2 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277q.792-.001 1.533-.16a.79.79 0 0 1 .81.316.73.73 0 0 1-.031.893A8.35 8.35 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.75.75 0 0 1 6 .278' },
        { id: 'bi-cloud-fill', label: 'Cloud', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M4.406 3.342A5.53 5.53 0 0 1 8 2c2.69 0 4.923 2 5.166 4.579C14.758 6.804 16 8.137 16 9.773 16 11.569 14.502 13 12.687 13H3.781C1.708 13 0 11.366 0 9.318c0-1.763 1.266-3.223 2.942-3.593.143-.863.698-1.723 1.464-2.383' },
        { id: 'bi-cloud-rain-fill', label: 'Cloud Rain', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M4.158 12.025a.5.5 0 0 1 .316.633l-.5 1.5a.5.5 0 1 1-.948-.316l.5-1.5a.5.5 0 0 1 .632-.317m3 0a.5.5 0 0 1 .316.633l-1 3a.5.5 0 1 1-.948-.316l1-3a.5.5 0 0 1 .632-.317m3 0a.5.5 0 0 1 .316.633l-.5 1.5a.5.5 0 1 1-.948-.316l.5-1.5a.5.5 0 0 1 .632-.317m3 0a.5.5 0 0 1 .316.633l-1 3a.5.5 0 1 1-.948-.316l1-3a.5.5 0 0 1 .632-.317m.247-6.998a5.001 5.001 0 0 0-9.499-1.004A3.5 3.5 0 1 0 3.5 11H13a3 3 0 0 0 .405-5.973' },
        { id: 'bi-snow', label: 'Snow', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M8 16a.5.5 0 0 1-.5-.5v-1.293l-.646.647a.5.5 0 0 1-.707-.708L7.5 12.793V8.866l-3.4 1.963-.496 1.85a.5.5 0 1 1-.966-.26l.237-.882-1.12.646a.5.5 0 0 1-.5-.866l1.12-.646-.884-.237a.5.5 0 1 1 .26-.966l1.848.495L7 8 3.6 6.037l-1.85.495a.5.5 0 0 1-.258-.966l.883-.237-1.12-.646a.5.5 0 1 1 .5-.866l1.12.646-.237-.883a.5.5 0 1 1 .966-.258l.495 1.849L7.5 7.134V3.207L6.147 1.854a.5.5 0 1 1 .707-.708l.646.647V.5a.5.5 0 1 1 1 0v1.293l.647-.647a.5.5 0 1 1 .707.708L8.5 3.207v3.927l3.4-1.963.496-1.85a.5.5 0 1 1 .966.26l-.236.882 1.12-.646a.5.5 0 0 1 .5.866l-1.12.646.883.237a.5.5 0 1 1-.26.966l-1.848-.495L9 8l3.4 1.963 1.849-.495a.5.5 0 0 1 .259.966l-.883.237 1.12.646a.5.5 0 0 1-.5.866l-1.12-.646.236.883a.5.5 0 1 1-.966.258l-.495-1.849-3.4-1.963v3.927l1.353 1.353a.5.5 0 0 1-.707.708l-.647-.647V15.5a.5.5 0 0 1-.5.5z' },
        { id: 'bi-fire', label: 'Fire', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M8 16c3.314 0 6-2 6-5.5 0-1.5-.5-4-2.5-6 .25 1.5-1.25 2-1.25 2C11 4 9 .5 6 0c.357 2 .5 4-2 6-1.25 1-2 2.729-2 4.5C2 14 4.686 16 8 16m0-1c-1.657 0-3-1-3-2.75 0-.75.25-2 1.25-3C6.125 10 7 10.5 7 10.5c-.375-1.25.5-3.25 2-3.5-.179 1-.25 2 1 3 .625.5 1 1.364 1 2.25C11 14 9.657 15 8 15' },
        { id: 'bi-flag-fill', label: 'Flag', kind: 'path', w: 72, h: 72, vbW: 16, vbH: 16, fill: '#b8c8a8', stroke: 'none', d: 'M14.778.085A.5.5 0 0 1 15 .5V8a.5.5 0 0 1-.314.464L14.5 8l.186.464-.003.001-.006.003-.023.009a12 12 0 0 1-.397.15c-.264.095-.631.223-1.047.35-.816.252-1.879.523-2.71.523-.847 0-1.548-.28-2.158-.525l-.028-.01C7.68 8.71 7.14 8.5 6.5 8.5c-.7 0-1.638.23-2.437.477A20 20 0 0 0 3 9.342V15.5a.5.5 0 0 1-1 0V.5a.5.5 0 0 1 1 0v.282c.226-.079.496-.17.79-.26C4.606.272 5.67 0 6.5 0c.84 0 1.524.277 2.121.519l.043.018C9.286.788 9.828 1 10.5 1c.7 0 1.638-.23 2.437-.477a20 20 0 0 0 1.349-.476l.019-.007.004-.002h.001' },
      ],
    },
    {
      name: 'Pfeile',
      items: [
        { id: 'back-blue', label: 'Zurück blau', kind: 'path', w: 80, h: 60, vbW: 80, vbH: 60, fill: '#1683ff', stroke: 'none', d: 'M30 6L0 30L30 54V38H80V22H30Z' },
        { id: 'arrow-red', label: 'Pfeil rot', kind: 'path', w: 100, h: 50, vbW: 100, vbH: 50, fill: '#ef4444', stroke: 'none', d: 'M70 0L100 25L70 50V34H0V16H70Z' },
        { id: 'chevron', label: 'Chevron', kind: 'path', w: 48, h: 72, vbW: 48, vbH: 72, fill: 'none', stroke: '#a3a3a3', strokeW: 8, d: 'M40 8L8 36L40 64' },
      ],
    },
    {
      name: 'Grundformen',
      items: [
        { id: 'basic-rect', label: 'Rechteck', kind: 'rect', w: 96, h: 64, fill: '#ffffff', stroke: '#b8c8a8', r: 0 },
        { id: 'basic-rounded-rect', label: 'Abgerundetes Rechteck', kind: 'rect', w: 96, h: 64, fill: '#ffffff', stroke: '#b8c8a8', r: 12 },
        { id: 'basic-triangle', label: 'Dreieck', kind: 'path', w: 86, h: 78, vbW: 86, vbH: 78, fill: '#ffffff', stroke: '#b8c8a8', d: 'M43 2L84 76H2Z' },
        { id: 'diamond', label: 'Raute', kind: 'path', w: 80, h: 80, vbW: 80, vbH: 80, fill: '#ffffff', stroke: '#b8c8a8', d: 'M40 0L80 40L40 80L0 40Z' },
        { id: 'basic-trapezoid', label: 'Trapez', kind: 'path', w: 94, h: 64, vbW: 94, vbH: 64, fill: '#ffffff', stroke: '#b8c8a8', d: 'M22 4H72L92 60H2Z' },
        { id: 'basic-polygon', label: 'Polygon', kind: 'path', w: 88, h: 84, vbW: 88, vbH: 84, fill: '#ffffff', stroke: '#b8c8a8', d: 'M44 2L82 24L74 66L44 82L14 66L6 24Z' },
        { id: 'star5', label: 'Stern', kind: 'path', w: 90, h: 86, vbW: 90, vbH: 86, fill: '#facc15', stroke: '#b8c8a8', d: 'M45 0L56 31H89L62 50L73 82L45 63L17 82L28 50L1 31H34Z' },
        { id: 'basic-double-star', label: 'Doppelstern', kind: 'path', w: 92, h: 92, vbW: 92, vbH: 92, fill: '#ffffff', stroke: '#b8c8a8', d: 'M46 2L53 20L69 9L68 29L88 24L75 39L92 50L72 55L82 73L63 66L58 88L46 70L34 88L29 66L10 73L20 55L0 50L17 39L4 24L24 29L23 9L39 20Z' },
        { id: 'basic-square-star', label: 'Quadratischer Stern', kind: 'path', w: 88, h: 88, vbW: 88, vbH: 88, fill: '#ffffff', stroke: '#b8c8a8', d: 'M34 2H54L58 26L82 30V50L58 54L54 86H34L30 54L6 50V30L30 26Z' },
        { id: 'basic-double-arrow', label: 'Pfeil', kind: 'path', w: 100, h: 46, vbW: 100, vbH: 46, fill: '#ffffff', stroke: '#b8c8a8', d: 'M20 1L0 23L20 45V32H80V45L100 23L80 1V14H20Z' },
        { id: 'basic-ring', label: 'Ring', kind: 'path', w: 88, h: 88, vbW: 88, vbH: 88, fill: '#ffffff', stroke: '#b8c8a8', d: 'M44 0A44 44 0 1 1 44 88A44 44 0 1 1 44 0M44 18A26 26 0 1 0 44 70A26 26 0 1 0 44 18' },
        { id: 'basic-pie', label: 'Torte', kind: 'path', w: 88, h: 88, vbW: 88, vbH: 88, fill: '#ffffff', stroke: '#b8c8a8', d: 'M44 44V0A44 44 0 1 1 0 44Z' },
        { id: 'basic-segment', label: 'Segment', kind: 'path', w: 90, h: 54, vbW: 90, vbH: 54, fill: '#ffffff', stroke: '#b8c8a8', d: 'M2 52A43 43 0 0 1 88 52Z' },
        { id: 'basic-crescent', label: 'Sichel', kind: 'path', w: 72, h: 90, vbW: 72, vbH: 90, fill: '#ffffff', stroke: '#b8c8a8', d: 'M54 2A43 43 0 1 0 54 88A35 43 0 1 1 54 2Z' },
        { id: 'basic-gear', label: 'Zahnrad', kind: 'path', w: 90, h: 90, vbW: 90, vbH: 90, fill: '#ffffff', stroke: '#b8c8a8', d: 'M40 0H50L54 12L63 16L74 10L81 17L75 28L79 37L90 41V51L78 55L74 64L80 75L73 82L62 76L53 80L49 90H39L35 78L26 74L15 80L8 73L14 62L10 53L0 49V39L12 35L16 26L10 15L17 8L28 14L37 10ZM45 30A15 15 0 1 0 45 60A15 15 0 1 0 45 30' },
        { id: 'basic-cloud', label: 'Wolke', kind: 'path', w: 100, h: 66, vbW: 100, vbH: 66, fill: '#ffffff', stroke: '#b8c8a8', d: 'M28 64Q12 64 12 50Q12 38 24 36Q27 20 43 20Q54 20 61 29Q66 26 74 26Q91 26 91 43Q100 46 100 55Q100 64 88 64Z' },
        { id: 'bubble', label: 'Rechteckige Sprechblase', kind: 'path', w: 120, h: 80, vbW: 120, vbH: 80, fill: '#ffffff', stroke: '#b8c8a8', d: 'M10 0H110Q120 0 120 10V52Q120 62 110 62H48L30 80V62H10Q0 62 0 52V10Q0 0 10 0Z' },
        { id: 'basic-ellipse-bubble', label: 'Elliptische Sprechblase', kind: 'path', w: 110, h: 82, vbW: 110, vbH: 82, fill: '#ffffff', stroke: '#b8c8a8', d: 'M55 0A55 34 0 1 1 54 68L32 82L40 64A55 34 0 0 1 55 0Z' },
        { id: 'basic-tear', label: 'Träne', kind: 'path', w: 70, h: 90, vbW: 70, vbH: 90, fill: '#ffffff', stroke: '#b8c8a8', d: 'M35 0Q68 42 68 62A33 28 0 1 1 2 62Q2 42 35 0Z' },
        { id: 'basic-heart', label: 'Herz', kind: 'path', w: 90, h: 82, vbW: 90, vbH: 82, fill: '#ffffff', stroke: '#b8c8a8', d: 'M45 78L10 43Q-3 29 5 13Q14 -4 32 6Q40 11 45 20Q50 11 58 6Q76 -4 85 13Q93 29 80 43Z' },
        { id: 'basic-spiral', label: 'Spirale', kind: 'path', w: 92, h: 92, vbW: 92, vbH: 92, fill: '#ffffff', stroke: '#b8c8a8', d: 'M47.2 47.1L47.3 47.7L47.4 47.9L47.3 48.3L47.2 48.7L47 49.1L46.6 49.6L46 49.9L45.4 50.3L44.6 50.4L43.7 50.5L42.8 50.3L41.9 50L40.9 49.4L40.1 48.6L39.3 47.6L38.8 46.5L38.4 45.1L38.4 43.7L38.6 42.2L39.1 40.7L39.9 39.2L41 37.9L42.5 36.8L44.1 35.9L46 35.3L48 35.2L50.1 35.3L52.2 35.9L54.2 37L56 38.4L57.6 40.2L58.8 42.3L59.6 44.7L60 47.2L59.9 49.9L59.3 52.6L58.2 55.1L56.6 57.5L54.5 59.6L51.9 61.3L49.1 62.5L46 63.2L42.8 63.2L39.5 62.7L36.3 61.5L33.3 59.8L30.7 57.4L28.5 54.6L26.9 51.3L25.8 47.7L25.5 43.9L25.9 40L27 36.2L28.8 32.6L31.3 29.4L34.5 26.7L38.1 24.5L42.2 23L46.5 22.3L50.9 22.5L55.4 23.4L59.6 25.2L63.5 27.8L66.8 31.1L69.6 35.1L71.6 39.6L72.7 44.4L72.9 49.4L72.2 54.5L70.5 59.3L67.9 63.9L64.5 67.9L60.3 71.3L55.5 73.9L50.2 75.5L44.6 76.2L39 75.8L33.4 74.3L28.2 71.8L23.4 68.3L19.4 64L16.1 58.9L13.9 53.2L12.7 47.1L12.7 40.9L13.9 34.7L16.2 28.7L19.6 23.3L24.1 18.5L29.4 14.5L35.4 11.6L41.9 9.9L48.7 9.4L55.5 10.1L62.2 12.2L68.6 15.6L71.6 10.1L64.6 6.4L56.8 4L48.8 3.1L40.8 3.7L33.2 5.7L26.1 9.1L19.8 13.7L14.6 19.4L10.5 25.9L7.7 32.9L6.3 40.3L6.3 47.7L7.7 55L10.3 61.8L14.2 67.9L19.1 73.2L24.8 77.4L31.1 80.5L37.9 82.3L44.8 82.8L51.5 82L58 80L63.9 76.9L69.1 72.7L73.4 67.8L76.6 62.1L78.7 56.1L79.7 49.8L79.4 43.5L78 37.4L75.5 31.8L72.1 26.8L67.8 22.5L62.9 19.2L57.5 16.9L51.8 15.6L46 15.4L40.4 16.3L35.2 18.2L30.4 21L26.3 24.6L22.9 28.9L20.5 33.6L19 38.7L18.4 43.8L18.9 49L20.3 53.8L22.5 58.3L25.5 62.3L29.1 65.5L33.2 68L37.6 69.6L42.2 70.4L46.8 70.3L51.3 69.4L55.4 67.7L59 65.3L62.1 62.2L64.6 58.7L66.3 54.9L67.2 50.9L67.4 46.9L66.8 42.9L65.5 39.2L63.6 35.9L61.1 33L58.2 30.7L55 29L51.5 28L48 27.6L44.6 27.9L41.3 28.9L38.4 30.4L35.8 32.4L33.7 34.8L32.1 37.5L31.1 40.3L30.7 43.3L30.8 46.2L31.5 49L32.7 51.5L34.3 53.7L36.2 55.6L38.4 56.9L40.8 57.9L43.2 58.3L45.6 58.2L47.9 57.7L50 56.8L51.8 55.5L53.2 53.9L54.3 52.1L55 50.2L55.3 48.3L55.2 46.3L54.8 44.9Z' },
      ],
    },
  ];
  const libraryShapeGroups = shapeGroups
    .map(group => ({
      ...group,
      items: group.items.filter(item => item.kind !== 'path' || item.fill !== 'none'),
    }))
    .filter(group => group.items.length > 0);
  let collapsedShapeGroups = $state<Set<string>>(new Set(libraryShapeGroups.slice(1).map(group => group.name)));

  // ── Eigene Formen (Formbibliothek gespeichert) ────────────────────────────
  type SavedShape = { id: number; name: string; gruppe: string; objects_json: string; preview_svg: string };
  let savedShapes = $state<SavedShape[]>([]);

  async function shapesFilePath(): Promise<string> {
    return join(await appLocalDataDir(), 'vecstructi_shapes.json');
  }
  async function loadShapesFromFile(): Promise<SavedShape[]> {
    try {
      const path = await shapesFilePath();
      const bytes = await readFile(path);
      return JSON.parse(new TextDecoder().decode(bytes)) as SavedShape[];
    } catch { return []; }
  }
  async function saveShapesToFile(shapes: SavedShape[]): Promise<void> {
    const path = await shapesFilePath();
    await writeFile(path, new TextEncoder().encode(JSON.stringify(shapes)));
  }

  async function exportShapes() {
    try {
      const savePath = await dialogSave({
        title: 'Eigene Formen exportieren',
        defaultPath: 'vecstructi_shapes.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (!savePath) return;
      const shapes = await loadShapesFromFile();
      await writeFile(savePath as string, new TextEncoder().encode(JSON.stringify(shapes, null, 2)));
      formenSetupStatus = `✓ ${shapes.length} Formen exportiert`;
    } catch (e) {
      formenSetupStatus = '✗ Export fehlgeschlagen';
    }
  }

  async function importShapes() {
    try {
      const selected = await dialogOpen({
        title: 'Eigene Formen importieren',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        multiple: false
      });
      if (!selected) return;
      const bytes = await readFile(selected as string);
      const imported: SavedShape[] = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(imported)) throw new Error('Ungültiges Format');
      const existing = await loadShapesFromFile();
      const existingIds = new Set(existing.map(s => s.id));
      const neu = imported.filter(s => !existingIds.has(s.id));
      const merged = [...existing, ...neu];
      await saveShapesToFile(merged);
      savedShapes = merged;
      formenSetupStatus = `✓ ${neu.length} neue Formen importiert (${imported.length - neu.length} bereits vorhanden)`;
    } catch (e) {
      formenSetupStatus = '✗ Import fehlgeschlagen';
    }
  }

  let shapeSaveDialogOpen = $state(false);
  let shapeSaveName = $state('');
  let shapeSaveGruppe = $state('');
  let collapsedSavedGroups = $state<Set<string>>(new Set());

  function shapeStrokeW(template: ShapeTemplate) {
    if (template.stroke === 'none') return 0;
    const raw = template.strokeW ?? 1;
    return Math.min(raw, template.kind === 'path' ? 1.8 : 1.2);
  }

  function normalizedShapePathD(template: ShapeTemplate, x: number, y: number) {
    if (template.kind !== 'path') return '';
    const p = getPaper();
    p.project.clear();
    try {
      const path = new p.CompoundPath(template.d);
      const b = path.bounds;
      const pad = Math.max(2, shapeStrokeW(template));
      const sx = b.width > 0 ? (template.w - pad * 2) / b.width : 1;
      const sy = b.height > 0 ? (template.h - pad * 2) / b.height : 1;
      path.translate(new p.Point(-b.x, -b.y));
      path.scale(sx, sy, new p.Point(0, 0));
      path.translate(new p.Point(Math.round(x - template.w / 2) + pad, Math.round(y - template.h / 2) + pad));
      return path.pathData;
    } finally {
      p.project.clear();
    }
  }

  function addShapeFromTemplate(template: ShapeTemplate, x: number, y: number) {
    pushUndo();
    const uid = Math.random().toString(36).slice(2, 9);
    const w = template.w, h = template.h;
    if (template.kind === 'rect') {
      const r = template.r ?? 0;
      const obj: DrawnRect = {
        type: 'RECHTECK', x: Math.round(x - w / 2), y: Math.round(y - h / 2), w, h,
        fill: template.fill, stroke: template.stroke, strokeW: shapeStrokeW(template), strokeDash: '',
        shape: template.shape as DrawnRect['shape'] ?? 'rect',
        radiusOL: r, radiusOR: r, radiusUL: r, radiusUR: r,
        uid, ebene: aktiveEbene, rotation: 0,
        libraryName: 'Formbibliothek',
      };
      objects = [...objects, obj];
    } else {
      const ox = Math.round(x - w / 2), oy = Math.round(y - h / 2);
      const obj: DrawnPath = {
        type: 'PFAD', x: ox, y: oy, w, h, ox, oy, points: [],
        d: normalizedShapePathD(template, x, y),
        glaettung: 0, fill: template.fill, stroke: template.stroke, strokeW: shapeStrokeW(template), strokeDash: '',
        uid, ebene: aktiveEbene, rotation: 0,
        libraryName: 'Formbibliothek',
        radiusOL: 0, radiusOR: 0, radiusUL: 0, radiusUR: 0,
      };
      objects = [...objects, obj];
    }
    selectOne(objects[objects.length - 1]);
    persistDbObject(objects[objects.length - 1]);
    propTab = 'geo';
    requestAnimationFrame(() => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      (document.querySelector('.canvas-frame') as SVGElement | null)?.focus?.();
    });
    unsaved = true;
  }

  function selectOne(obj: DrawnObject) {
    if (!canOperateOn(obj)) return;
    selectedObj  = obj;
    selectedObjs = [obj];
    propX = pxToUnit(obj.x); propY = pxToUnit(obj.y);
    propW = pxToUnit(obj.w); propH = pxToUnit(obj.h); propRot = obj.rotation;
    propShearX = (obj as DrawnRect).shearX ?? 0; propShearY = (obj as DrawnRect).shearY ?? 0;
    propPolygonSides = obj.type === 'RECHTECK' ? (obj.polygonSides ?? 6) : 6;
    propFrameWidth = obj.type === 'RECHTECK' ? pxToUnit(obj.frameWidth ?? 8) : pxToUnit(8);
    if (obj.type === 'TEXT') {
      propTextAlign   = obj.textAlign;
      propLineHeight  = obj.lineHeight;
      propFontSize    = fontSizeFromRichHtml(obj.richHtml) ?? obj.massFontSize ?? 12;
      propFontFamily  = obj.massFontFamily ?? "'Helvetica Neue', Helvetica, Arial, sans-serif";
    }
    if (obj.type === 'LINIE') {
      propRot        = lineAngleDeg(obj);
      propArrowStart  = obj.arrowStart;
      propArrowEnd    = obj.arrowEnd;
      propIsMasslinie = obj.isMasslinie;
      propMassText    = obj.massText ?? '';
      propMassTextPos = obj.massTextPos ?? 'ueber';
      propFontSize    = obj.massFontSize ?? 11;
      propFontFamily  = obj.massFontFamily ?? "'Helvetica Neue', Helvetica, Arial, sans-serif";
      propFontBold    = obj.massFontWeight === 'bold';
      propFontItalic  = obj.massFontStyle === 'italic';
      propLineLength  = pxToUnit(lineLengthRaw(obj));
      propLineLengthInput = propLineLength;
    }
    if (obj.type === 'PFAD') {
      propGlaettung = obj.glaettung ?? 0.4;
      propCurveClosed = obj.curveClosed ?? false;
      propWallWidth = parseFloat(((obj.wallWidth ?? mmToPx(10)) / MM_TO_PX).toFixed(2));
      propWallHatchSpacing = parseFloat(((obj.wallHatchSpacing ?? mmToPx(5)) / MM_TO_PX).toFixed(2));
      propWallHatchType = obj.wallHatchType ?? 'diagonal';
      propWallHatchColor = obj.wallHatchColor ?? '#444444';
      if (obj.isBrush) {
        propBrushSize = obj.brushSize ?? 10;
        propBrushForm = obj.brushForm ?? 'kreis';
      }
    }
    objFill = obj.fill; objStroke = obj.stroke; objStrokeW = obj.strokeW; objStrokeDash = obj.strokeDash ?? '';
    const gf = parseGradientValue(obj.fill);
    if (gf) {
      fillMode = gf.mode;
      gradientAngle = gf.angle;
      gradientStart = gf.start;
      gradientEnd = gf.end;
    } else {
      fillMode = 'solid';
      if (obj.fill && obj.fill !== 'none') gradientStart = obj.fill;
    }
    objRadiusOL = obj.radiusOL; objRadiusOR = obj.radiusOR;
    objRadiusUL = obj.radiusUL; objRadiusUR = obj.radiusUR;
    objCornerStyle = obj.cornerStyle ?? 'round';
    objShadow = obj.shadowEnabled ?? false;
    objShadowX = obj.shadowX ?? 4; objShadowY = obj.shadowY ?? 4;
    objShadowBlur = obj.shadowBlur ?? 6; objShadowColor = obj.shadowColor ?? '#000000';
    propImageScale = obj.imageScale ?? 1;
    if (!obj.isImageFrame) imgPanMode = false;
    propTab = 'geo';
  }

  function objectLayerName(obj: DrawnObject, index: number): string {
    if ((obj.type === 'RECHTECK' || obj.type === 'PFAD') && obj.libraryName) return obj.libraryName;
    if (obj.type === 'RECHTECK' && obj.isImageFrame) return `Bild ${index + 1}`;
    if (obj.type === 'RECHTECK' && obj.shape === 'ellipse') return `Ellipse ${index + 1}`;
    if (obj.type === 'RECHTECK' && obj.shape === 'polygon') return `Polygon ${index + 1}`;
    if (obj.type === 'RECHTECK' && obj.shape === 'frame') return `Rahmen ${index + 1}`;
    if (obj.type === 'RECHTECK') return `Rechteck ${index + 1}`;
    if (obj.type === 'LINIE') return `Linie ${index + 1}`;
    if (obj.type === 'TEXT') return `Text ${index + 1}`;
    if (obj.type === 'PFAD' && obj.isBrush) return `Pinsel ${index + 1}`;
    if (obj.type === 'PFAD' && obj.isWall) return `Wand ${index + 1}`;
    if (obj.type === 'PFAD' && obj.isCurve) return `Kurve ${index + 1}`;
    return `Bleistift ${index + 1}`;
  }

  function clearSelection() {
    selectedObj = null;
    selectedObjs = [];
  }

  function activeLayerObjects(objs: DrawnObject[]): DrawnObject[] {
    return objs.filter(canOperateOn);
  }

  function canOperateOn(obj: DrawnObject): boolean {
    const layer = ebenen.find(e => e.name === obj.ebene);
    return obj.ebene === aktiveEbene && !(obj as any).gesperrt && !layer?.gesperrt;
  }

  function persistRect(obj: DrawnObject) {
    if (obj.type !== 'RECHTECK') return;
    const idx = objects.findIndex(o => o.uid === obj.uid);
    void queueDbWrite(() => upsertRectObject(obj, idx)).catch(err => console.error('SQLite rect save failed', err));
  }

  function persistLine(obj: DrawnObject) {
    if (obj.type !== 'LINIE') return;
    const idx = objects.findIndex(o => o.uid === obj.uid);
    void queueDbWrite(() => upsertLineObject(obj, idx)).catch(err => console.error('SQLite line save failed', err));
  }

  function persistText(obj: DrawnObject) {
    if (obj.type !== 'TEXT') return;
    const idx = objects.findIndex(o => o.uid === obj.uid);
    void queueDbWrite(() => upsertTextObject(obj, idx)).catch(err => console.error('SQLite text save failed', err));
  }

  function persistPath(obj: DrawnObject) {
    if (obj.type !== 'PFAD') return;
    const idx = objects.findIndex(o => o.uid === obj.uid);
    void queueDbWrite(() => upsertPathObject(obj, idx)).catch(err => console.error('SQLite path save failed', err));
  }

  function persistDbObject(obj: DrawnObject) {
    persistRect(obj);
    persistLine(obj);
    persistText(obj);
    persistPath(obj);
  }

  function persistDbObjects(objs: DrawnObject[]) {
    objs.forEach(persistDbObject);
  }

  async function persistCurrentLayers() {
    const db = await getDb();
    for (let i = 0; i < ebenen.length; i++) {
      const e = ebenen[i];
      await db.execute(
        `INSERT INTO layers
          (document_id, name, position, visible, locked, opacity)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [DEFAULT_DOCUMENT_ID, e.name, i, e.sichtbar ? 1 : 0, e.gesperrt ? 1 : 0, e.opacity ?? 100],
      );
    }
  }

  async function persistCurrentObjects() {
    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];
      if (obj.type === 'RECHTECK') await upsertRectObject(obj, i);
      else if (obj.type === 'LINIE') await upsertLineObject(obj, i);
      else if (obj.type === 'TEXT') await upsertTextObject(obj, i);
      else if (obj.type === 'PFAD') await upsertPathObject(obj, i);
    }
  }

  async function syncCurrentDocumentToDb() {
    if (saveLayoutTimer) {
      clearTimeout(saveLayoutTimer);
      saveLayoutTimer = null;
    }
    await queueDbWrite(async () => {
    await clearDocumentDb();
    await saveDocumentLayout(collectDocumentLayout());
    await persistCurrentLayers();
    await persistCurrentObjects();
    await packImageAssetsIntoDb();
    const db = await getDb();
    const rows = await db.select<Array<{ count: number }>>(
      'SELECT COUNT(*) AS count FROM objects WHERE document_id = $1',
      [DEFAULT_DOCUMENT_ID],
    );
    if ((rows[0]?.count ?? 0) !== objects.length) {
      throw new Error(`SQLite sync mismatch: ${rows[0]?.count ?? 0} DB-Objekte, ${objects.length} App-Objekte`);
    }
    });
  }

  function cloneObjectSnapshot(obj: DrawnObject): DrawnObject {
    return {
      ...obj,
      points: obj.type === 'PFAD' ? obj.points.map(p => ({ ...p })) : (obj as any).points,
    } as DrawnObject;
  }

  function cloneObjectsSnapshot(objs: DrawnObject[]): DrawnObject[] {
    return objs.map(cloneObjectSnapshot);
  }

  function syncDbToObjects(nextObjects: DrawnObject[], previousObjects: DrawnObject[]) {
    const nextUids = new Set(nextObjects.map(o => o.uid));
    const removed = previousObjects.filter(o => !nextUids.has(o.uid));
    deletePersistedObjects(removed);
    persistDbObjects(nextObjects);
  }

  function replaceObject(obj: DrawnObject) {
    objects = objects.map(o => o.uid === obj.uid ? obj : o);
    selectedObj = obj;
    selectedObjs = [obj];
  }

  function deletePersistedObjects(objs: DrawnObject[]) {
    const uids = objs.filter(o => o.type === 'RECHTECK' || o.type === 'LINIE' || o.type === 'TEXT' || o.type === 'PFAD').map(o => o.uid);
    if (uids.length) void queueDbWrite(() => deleteObjectsByUid(uids)).catch(err => console.error('SQLite object delete failed', err));
  }

  function nudgeSelected(key: string, steps: number) {
    const targets = activeLayerObjects(selectedObjs);
    if (!targets.length) return;
    const d = unitToPx(unitStep) * steps;
    const dx = key === 'ArrowLeft' ? -d : key === 'ArrowRight' ? d : 0;
    const dy = key === 'ArrowUp'   ? -d : key === 'ArrowDown'  ? d : 0;
    targets.forEach(o => {
      if (o.type === 'LINIE') {
        o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy;
        updateLineBBox(o);
      } else if (o.type === 'PFAD') {
        o.x += dx; o.y += dy; o.ox = o.x; o.oy = o.y;
        if (o.points?.length) o.points = o.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }));
      } else {
        o.x += dx; o.y += dy;
      }
    });
    if (targets.length === 1) { propX = pxToUnit(targets[0].x); propY = pxToUnit(targets[0].y); }
    persistDbObjects(targets);
    unsaved = true;
  }

  function deleteSelectedObjects() {
    selectedObjs = activeLayerObjects(selectedObjs);
    if (!selectedObjs.length) return;
    const deleted = [...selectedObjs];
    pushUndo();
    objects = objects.filter(o => !selectedObjs.includes(o));
    deletePersistedObjects(deleted);
    clearSelection();
    unsaved = true;
  }

  function onObjMouseDown(ev: MouseEvent, obj: DrawnObject) {
    ev.stopPropagation();
    if (!canOperateOn(obj)) return;
    if (activeTool === 'fill-tool') return;
    if (obj.type === 'TEXT' && activeTool === 'text') {
      return;
    }
    ev.preventDefault();
    if (!selectedObjs.includes(obj)) {
      if (obj.groupId) {
        selectedObjs = objects.filter(o => o.groupId === obj.groupId && canOperateOn(o));
        selectedObj = null;
        justPlaced = true;
      } else {
        selectOne(obj);
      }
    }
    if (imgPanMode && isImageFrameObject(obj) && obj.imageUrl) startImagePan(ev, obj);
    else startMove(ev, obj);
  }

  let _lastSyncUid = '';
  let _lastSyncSerial = '';
  function syncObjFromProps() {
    if (!selectedObj) return;
    if (!canOperateOn(selectedObj)) return;
    // Undo-Snapshot einmal pro Objekt-Änderungsserie speichern
    const serial = `${propX},${propY},${propW},${propH},${propRot},${propShearX},${propShearY},${propPolygonSides},${propFrameWidth},${propGlaettung},${propCurveClosed},${propArrowStart},${propArrowEnd},${propIsMasslinie},${propMassText},${propMassTextPos},${propFontSize},${propFontFamily},${propFontBold},${propFontItalic}`;
    if (selectedObj.uid !== _lastSyncUid || serial !== _lastSyncSerial) {
      pushUndo();
      _lastSyncUid = selectedObj.uid;
      _lastSyncSerial = serial;
    }
    if (selectedObj.type === 'LINIE') {
      const oldLen = lineLengthRaw(selectedObj);
      const oldX = selectedObj.x, oldY = selectedObj.y;
      const oldW = selectedObj.w || 1, oldH = selectedObj.h || 1;
      const newX = Math.round(unitToPx(propX));
      const newY = Math.round(unitToPx(propY));
      const newW = Math.max(1, Math.round(unitToPx(propW)));
      const newH = Math.max(1, Math.round(unitToPx(propH)));
      const geomChanged = newX !== oldX || newY !== oldY || newW !== oldW || newH !== oldH;
      if (geomChanged) {
        const sx = newW / oldW, sy = newH / oldH;
        selectedObj.x1 = snapX(Math.round(newX + (selectedObj.x1 - oldX) * sx));
        selectedObj.y1 = snapY(Math.round(newY + (selectedObj.y1 - oldY) * sy));
        selectedObj.x2 = snapX(Math.round(newX + (selectedObj.x2 - oldX) * sx));
        selectedObj.y2 = snapY(Math.round(newY + (selectedObj.y2 - oldY) * sy));
        updateLineBBox(selectedObj);
        const newLen = lineLengthRaw(selectedObj);
        propLineLength = pxToUnit(newLen);
        propLineLengthInput = propLineLength;
        if (selectedObj.isMasslinie && (!propMassText || propMassText === lineMassText(oldLen))) {
          propMassText = lineMassText(newLen);
        }
      }
      const targetAngle = normalizeAngle(propRot);
      if (Math.abs(normalizeAngle(lineAngleDeg(selectedObj) - targetAngle)) > 0.05) {
        const len = lineLengthRaw(selectedObj);
        const cx = (selectedObj.x1 + selectedObj.x2) / 2;
        const cy = (selectedObj.y1 + selectedObj.y2) / 2;
        const rad = targetAngle * Math.PI / 180;
        const dx = Math.cos(rad) * len / 2;
        const dy = Math.sin(rad) * len / 2;
        selectedObj.x1 = Math.round(cx - dx);
        selectedObj.y1 = Math.round(cy - dy);
        selectedObj.x2 = Math.round(cx + dx);
        selectedObj.y2 = Math.round(cy + dy);
        updateLineBBox(selectedObj);
      }
    } else {
      const oldX = selectedObj.x, oldY = selectedObj.y;
      const oldW = selectedObj.w || 1, oldH = selectedObj.h || 1;
      selectedObj.x = Math.round(unitToPx(propX));
      selectedObj.y = Math.round(unitToPx(propY));
      selectedObj.w = Math.max(1, Math.round(unitToPx(propW)));
      selectedObj.h = Math.max(1, Math.round(unitToPx(propH)));
      if (selectedObj.type === 'RECHTECK' && selectedObj.imageMaskD) {
        selectedObj.imageMaskD = transformPathD(
          selectedObj.imageMaskD,
          selectedObj.x - oldX,
          selectedObj.y - oldY,
          selectedObj.w / oldW,
          selectedObj.h / oldH,
          oldX,
          oldY
        );
      }
    }
    selectedObj.rotation = selectedObj.type === 'LINIE' ? 0 : propRot;
    if (selectedObj.type === 'RECHTECK') {
      selectedObj.shearX = propShearX;
      selectedObj.shearY = propShearY;
      selectedObj.polygonSides = Math.max(3, Math.min(24, Math.round(propPolygonSides)));
      selectedObj.frameWidth = Math.max(1, Math.round(unitToPx(propFrameWidth)));
    }
    if (selectedObj.type === 'TEXT') {
      selectedObj.textAlign  = propTextAlign;
      selectedObj.lineHeight = propLineHeight;
      selectedObj.fill       = objFill;
    }
    if (selectedObj.type === 'LINIE') {
      selectedObj.arrowStart    = propArrowStart;
      selectedObj.arrowEnd      = propArrowEnd;
      selectedObj.isMasslinie   = propIsMasslinie;
      if (selectedObj.isMasslinie && !propMassText) propMassText = lineMassText(lineLengthRaw(selectedObj));
      selectedObj.massText    = propMassText;
      selectedObj.massTextPos = propMassTextPos;
      selectedObj.massFontSize = propFontSize;
      selectedObj.massFontFamily = propFontFamily;
      selectedObj.massFontWeight = propFontBold ? 'bold' : 'normal';
      selectedObj.massFontStyle = propFontItalic ? 'italic' : 'normal';
    }
    if (selectedObj.type === 'PFAD') {
      if ((selectedObj as DrawnPath).isCurve) {
        (selectedObj as DrawnPath).curveClosed = propCurveClosed;
        (selectedObj as DrawnPath).d = curvePathD((selectedObj as DrawnPath).points, propCurveClosed);
      } else if ((selectedObj as DrawnPath).isWall) {
        (selectedObj as DrawnPath).wallWidth = mmToPx(propWallWidth);
        (selectedObj as DrawnPath).wallHatchSpacing = mmToPx(propWallHatchSpacing);
        (selectedObj as DrawnPath).wallHatchType = propWallHatchType;
        (selectedObj as DrawnPath).wallHatchColor = propWallHatchColor;
        selectedObj.d = wallPathD(selectedObj.points, mmToPx(propWallWidth), mmToPx(propWallHatchSpacing), propWallHatchType, selectedObj.curveClosed);
      } else if (!(selectedObj as DrawnPath).isBrush) {
        selectedObj.glaettung = propGlaettung;
        if (selectedObj.points.length >= 2) {
          selectedObj.d = smoothPts(selectedObj.points, propGlaettung);
        }
        // Eraser-Pfade (points leer) behalten ihr d unverändert
      }
    }
    selectedObj.fill     = objFill;
    selectedObj.stroke   = objStroke;
    selectedObj.strokeW    = typeof objStrokeW === 'number' ? objStrokeW : 1;
    selectedObj.strokeDash = objStrokeDash;
    selectedObj.radiusOL = objRadiusOL; selectedObj.radiusOR = objRadiusOR;
    selectedObj.radiusUL = objRadiusUL; selectedObj.radiusUR = objRadiusUR;
    selectedObj.cornerStyle = objCornerStyle;
    selectedObj.shadowEnabled = objShadow;
    selectedObj.shadowX     = objShadowX;
    selectedObj.shadowY     = objShadowY;
    selectedObj.shadowBlur  = objShadowBlur;
    selectedObj.shadowColor = objShadowColor;
    if (selectedObj.type === 'LINIE') replaceObject(selectedObj);
    persistDbObject(selectedObj);
    unsaved = true;
  }

  function onDrawMouseDown(ev: MouseEvent) {
    if (activeTool === 'measure') {
      ev.preventDefault();
      const p = canvasPoint(ev);
      const sx = snapX(p.x), sy = snapY(p.y);
      measuringLine = { x1: sx, y1: sy, x2: sx, y2: sy };
      measuringDragging = true;
      return;
    }
    if (activeTool === 'zoom') {
      zoomAt(ev, ev.altKey ? -1 : 1);
      return;
    }
    if (activeTool === 'hand') {
      startHandPan(ev);
      return;
    }
    if (activeTool === 'select') {
      if (ev.target !== ev.currentTarget) return;
      ev.preventDefault();
      const p = canvasPoint(ev);
      const sx = p.x;
      const sy = p.y;
      selRect = { x1: sx, y1: sy, x2: sx, y2: sy };
      return;
    }
    if (activeTool === 'text') {
      ev.preventDefault();
      const p = canvasPoint(ev);
      const sx = snapX(p.x), sy = snapY(p.y);
      drawingRect = { x1: sx, y1: sy, x2: sx, y2: sy };
      return;
    }
    if (activeTool === 'line') {
      ev.preventDefault();
      const p = canvasPoint(ev);
      const sx = snapX(p.x), sy = snapY(p.y);
      drawingLine = { x1: sx, y1: sy, x2: sx, y2: sy };
      return;
    }
    if (activeTool === 'arc') {
      ev.preventDefault();
      const p = canvasPoint(ev);
      const sx = snapX(p.x), sy = snapY(p.y);
      drawingCurve = { x1: sx, y1: sy, x2: sx, y2: sy, cx: sx, cy: sy, d: '' };
      return;
    }
    if (activeTool === 'wall') {
      ev.preventDefault();
      const cp = canvasPoint(ev);
      const p = { x: snapX(cp.x), y: snapY(cp.y) };
      drawingWall = drawingWall ? { ...drawingWall, pts: [...drawingWall.pts, p], preview: p } : { pts: [p], preview: p };
      return;
    }
    if (activeTool === 'pencil') {
      ev.preventDefault();
      const p = canvasPoint(ev);
      drawingPath = { pts: [{ x: p.x, y: p.y }], d: '' };
      return;
    }
    if (activeTool === 'brush') {
      ev.preventDefault();
      const p = canvasPoint(ev);
      drawingBrush = { pts: [{ x: p.x, y: p.y, t: Date.now() }] };
      return;
    }
    if (activeTool === 'eraser') {
      ev.preventDefault();
      const p = canvasPoint(ev);
      drawingEraser = { pts: [{ x: p.x, y: p.y }], ebene: aktiveEbene };
      return;
    }
    if (activeTool !== 'rect' && activeTool !== 'roundrect' && activeTool !== 'ellipse' && activeTool !== 'polygon' && activeTool !== 'frame' && activeTool !== 'image') return;
    ev.preventDefault();
    const p = canvasPoint(ev);
    const sx = snapX(p.x), sy = snapY(p.y);
    drawingRect = { x1: sx, y1: sy, x2: sx, y2: sy };
    propX = pxToUnit(sx); propY = pxToUnit(sy);
    propW = 0; propH = 0;
    propTab = 'geo';
  }
  function onDrawMouseMove(ev: MouseEvent) {
    const p = canvasPoint(ev);
    if (measuringDragging && measuringLine) {
      let sx = snapX(p.x), sy = snapY(p.y);
      if (ev.shiftKey) {
        const dx = Math.abs(sx - measuringLine.x1), dy = Math.abs(sy - measuringLine.y1);
        if (dx > dy) sy = measuringLine.y1; else sx = measuringLine.x1;
      }
      measuringLine = { ...measuringLine, x2: sx, y2: sy };
      return;
    }
    if (drawingEraser) {
      const last = drawingEraser.pts[drawingEraser.pts.length - 1];
      const dx = p.x - last.x, dy = p.y - last.y;
      if (dx * dx + dy * dy < 16) return;
      drawingEraser = { ...drawingEraser, pts: [...drawingEraser.pts, { x: p.x, y: p.y }] };
      return;
    }
    if (drawingPath) {
      const last = drawingPath.pts[drawingPath.pts.length - 1];
      const dx = p.x - last.x, dy = p.y - last.y;
      if (dx * dx + dy * dy < 25) return; // min 5px Abstand
      const pts = [...drawingPath.pts, { x: p.x, y: p.y }];
      const rawD = 'M ' + pts.map(p => `${p.x} ${p.y}`).join(' L ');
      drawingPath = { pts, d: rawD };
      return;
    }
    if (drawingBrush) {
      const last = drawingBrush.pts[drawingBrush.pts.length - 1];
      const dx = p.x - last.x, dy = p.y - last.y;
      if (dx * dx + dy * dy < 9) return;
      drawingBrush = { pts: [...drawingBrush.pts, { x: p.x, y: p.y, t: Date.now() }] };
      return;
    }
    if (selRect) {
      selRect = { ...selRect, x2: p.x, y2: p.y };
      return;
    }
    if (drawingLine) {
      let sx = snapX(p.x), sy = snapY(p.y);
      if (ev.shiftKey) {
        const dx = Math.abs(sx - drawingLine.x1), dy = Math.abs(sy - drawingLine.y1);
        if (dx > dy) sy = drawingLine.y1; else sx = drawingLine.x1;
      }
      drawingLine = { ...drawingLine, x2: sx, y2: sy };
      return;
    }
    if (drawingCurve) {
      const x2 = snapX(p.x), y2 = snapY(p.y);
      const midX = (drawingCurve.x1 + x2) / 2;
      const midY = (drawingCurve.y1 + y2) / 2;
      const dx = x2 - drawingCurve.x1;
      const dy = y2 - drawingCurve.y1;
      const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const bend = Math.min(160, Math.max(24, len * 0.28));
      const cx = midX - dy / len * bend;
      const cy = midY + dx / len * bend;
      const d = curvePathD([{ x: drawingCurve.x1, y: drawingCurve.y1 }, { x: cx, y: cy }, { x: x2, y: y2 }], propCurveClosed);
      drawingCurve = { ...drawingCurve, x2, y2, cx, cy, d };
      return;
    }
    if (drawingWall) {
      drawingWall = { ...drawingWall, preview: { x: snapX(p.x), y: snapY(p.y) } };
      return;
    }
    if (!drawingRect) return;
    const sx = snapX(p.x), sy = snapY(p.y);
    drawingRect = { ...drawingRect, x2: sx, y2: sy };
    propX = pxToUnit(Math.round(Math.min(drawingRect.x1, sx)));
    propY = pxToUnit(Math.round(Math.min(drawingRect.y1, sy)));
    propW = pxToUnit(Math.round(Math.abs(sx - drawingRect.x1)));
    propH = pxToUnit(Math.round(Math.abs(sy - drawingRect.y1)));
  }
  function onDrawMouseUp(ev: MouseEvent) {
    const p = canvasPoint(ev);
    if (measuringDragging) {
      measuringDragging = false;
      return;
    }
    if (drawingEraser) {
      const pts = drawingEraser.pts;
      const eraserEbene = drawingEraser.ebene;
      drawingEraser = null;
      applyEraser(pts, eraserEbene);
      return;
    }
    if (drawingPath) {
      const dp = drawingPath;
      drawingPath = null;
      if (dp.pts.length < 2) return;
      const xs = dp.pts.map(p => p.x), ys = dp.pts.map(p => p.y);
      const x = Math.round(Math.min(...xs)), y = Math.round(Math.min(...ys));
      const w = Math.max(1, Math.round(Math.max(...xs) - x));
      const h = Math.max(1, Math.round(Math.max(...ys) - y));
      const uid = Math.random().toString(36).slice(2, 9);
      const obj: DrawnPath = {
        type: 'PFAD', x, y, w, h, ox: x, oy: y,
        points: dp.pts, d: smoothPts(dp.pts, propGlaettung), glaettung: propGlaettung ?? 0.5,
        stroke: objStroke || '#000000',
        strokeW: typeof objStrokeW === 'number' ? objStrokeW : 1,
        strokeDash: objStrokeDash,
        fill: 'none',
        uid, ebene: aktiveEbene, rotation: 0,
        radiusOL: 0, radiusOR: 0, radiusUL: 0, radiusUR: 0,
      };
      pushUndo();
      objects = [...objects, obj];
      selectOne(objects[objects.length - 1]);
      persistDbObject(objects[objects.length - 1]);
      unsaved = true; justPlaced = true;
      return;
    }
    if (drawingBrush) {
      const db = drawingBrush;
      drawingBrush = null;
      if (db.pts.length < 2) return;
      const d = brushPathD(db.pts, propBrushSize, propBrushForm, propGlaettung);
      if (!d) return;
      const allX = db.pts.map(p => p.x), allY = db.pts.map(p => p.y);
      const x = Math.round(Math.min(...allX) - propBrushSize);
      const y = Math.round(Math.min(...allY) - propBrushSize);
      const w = Math.max(1, Math.round(Math.max(...allX) - Math.min(...allX) + propBrushSize * 2));
      const h = Math.max(1, Math.round(Math.max(...allY) - Math.min(...allY) + propBrushSize * 2));
      const uid = Math.random().toString(36).slice(2, 9);
      const obj: DrawnPath = {
        type: 'PFAD', x, y, w, h, ox: x, oy: y,
        isBrush: true, brushForm: propBrushForm, brushSize: propBrushSize,
        points: db.pts.map(p => ({ x: p.x, y: p.y, t: p.t })), d,
        glaettung: propGlaettung ?? 0.5,
        stroke: 'none', strokeW: 0, strokeDash: '',
        fill: objFill || '#000000',
        uid, ebene: aktiveEbene, rotation: 0,
        radiusOL: 0, radiusOR: 0, radiusUL: 0, radiusUR: 0,
      };
      pushUndo();
      objects = [...objects, obj];
      selectOne(objects[objects.length - 1]);
      persistDbObject(objects[objects.length - 1]);
      unsaved = true; justPlaced = true;
      activeTool = 'brush';
      return;
    }
    if (selRect) {
      const rx1 = Math.min(selRect.x1, selRect.x2), rx2 = Math.max(selRect.x1, selRect.x2);
      const ry1 = Math.min(selRect.y1, selRect.y2), ry2 = Math.max(selRect.y1, selRect.y2);
      selRect = null;
      if (rx2 - rx1 < 4 && ry2 - ry1 < 4) return;
      const hit = objects.filter(o =>
        canOperateOn(o) &&
        o.x < rx2 && o.x + o.w > rx1 && o.y < ry2 && o.y + o.h > ry1
      );
      if (hit.length === 1) { selectOne(hit[0]); }
      else if (hit.length > 1) { selectedObjs = hit; selectedObj = null; }
      justPlaced = true;
      return;
    }
    if (drawingLine) {
      let ex = snapX(p.x), ey = snapY(p.y);
      if (ev.shiftKey) {
        const dx = Math.abs(ex - drawingLine.x1), dy = Math.abs(ey - drawingLine.y1);
        if (dx > dy) ey = drawingLine.y1; else ex = drawingLine.x1;
      }
      const dl = drawingLine;
      drawingLine = null;
      const len = Math.sqrt((ex-dl.x1)**2+(ey-dl.y1)**2);
      if (len < 2) return;
      const bb = lineBBox(dl.x1, dl.y1, ex, ey);
      // Länge exakt berechnen: bei aktivem Snap Raster-Schritte × Raster-mm
      let defMass: string;
      if (rasterAusrichten && snapStepX > 0 && snapStepY > 0) {
        const snapMmX = rasterXAbstand !== '' ? (rasterXAbstand as number) / ((rasterUnterteilung as number) || 1) : 0;
        const snapMmY = rasterYAbstand !== '' ? (rasterYAbstand as number) / ((rasterUnterteilung as number) || 1) : 0;
        const stepsX = Math.round((ex - dl.x1) / snapStepX);
        const stepsY = Math.round((ey - dl.y1) / snapStepY);
        const lenMm = Math.sqrt((stepsX * snapMmX) ** 2 + (stepsY * snapMmY) ** 2);
        defMass = parseFloat(lenMm.toFixed(genauigkeit as number)).toString();
      } else {
        defMass = pxToUnit(len).toString();
      }
      const obj: DrawnLine = {
        type: 'LINIE', x1: dl.x1, y1: dl.y1, x2: ex, y2: ey,
        ...bb, fill: '', stroke: objStroke, strokeW: typeof objStrokeW === 'number' ? objStrokeW : 1,
        strokeDash: objStrokeDash, arrowStart: propArrowStart, arrowEnd: propArrowEnd,
        isMasslinie: propIsMasslinie, massText: defMass, massTextPos: propMassTextPos,
        massFontSize: propFontSize, massFontFamily: propFontFamily,
        massFontWeight: propFontBold ? 'bold' : 'normal',
        massFontStyle: propFontItalic ? 'italic' : 'normal',
        uid: Math.random().toString(36).slice(2, 9), ebene: aktiveEbene, rotation: 0,
        radiusOL: 0, radiusOR: 0, radiusUL: 0, radiusUR: 0,
      };
      pushUndo();
      objects = [...objects, obj];
      selectOne(objects[objects.length - 1]);
      unsaved = true; justPlaced = true;
      activeTool = 'select';
      return;
    }
    if (drawingCurve) {
      const dc = drawingCurve;
      drawingCurve = null;
      const len = Math.sqrt((dc.x2 - dc.x1) ** 2 + (dc.y2 - dc.y1) ** 2);
      if (len < 2 || !dc.d) return;
      const pts = [{ x: dc.x1, y: dc.y1 }, { x: dc.cx, y: dc.cy }, { x: dc.x2, y: dc.y2 }];
      const bboxPts = propCurveClosed ? [...pts, { x: dc.x2, y: dc.y1 }] : pts;
      const xs = bboxPts.map(p => p.x), ys = bboxPts.map(p => p.y);
      const x = Math.round(Math.min(...xs)), y = Math.round(Math.min(...ys));
      const w = Math.max(1, Math.round(Math.max(...xs) - x));
      const h = Math.max(1, Math.round(Math.max(...ys) - y));
      const obj: DrawnPath = {
        type: 'PFAD', x, y, w, h, ox: x, oy: y,
        isCurve: true,
        points: pts, d: curvePathD(pts, propCurveClosed), glaettung: 0,
        curveClosed: propCurveClosed,
        stroke: objStroke || '#000000',
        strokeW: typeof objStrokeW === 'number' ? objStrokeW : 1,
        strokeDash: objStrokeDash,
        fill: propCurveClosed ? objFill : 'none',
        uid: Math.random().toString(36).slice(2, 9), ebene: aktiveEbene, rotation: 0,
        radiusOL: 0, radiusOR: 0, radiusUL: 0, radiusUR: 0,
      };
      pushUndo();
      objects = [...objects, obj];
      selectOne(objects[objects.length - 1]);
      persistDbObject(objects[objects.length - 1]);
      unsaved = true; justPlaced = true;
      activeTool = 'select';
      return;
    }
    if (!drawingRect) return;
    const sx = snapX(p.x), sy = snapY(p.y);
    const x = Math.round(Math.min(drawingRect.x1, sx));
    const y = Math.round(Math.min(drawingRect.y1, sy));
    const w = Math.round(Math.abs(sx - drawingRect.x1));
    const h = Math.round(Math.abs(sy - drawingRect.y1));
    drawingRect = null;
    if (w < 2 || h < 2) return;
    if (activeTool === 'text') {
      const uid = Math.random().toString(36).slice(2, 9);
      const tobj: DrawnText = {
        type: 'TEXT', x, y, w, h,
        richHtml: '',
        textAlign: propTextAlign, lineHeight: propLineHeight,
        fill: '#000000',
        uid, ebene: aktiveEbene, rotation: 0,
        stroke: '', strokeW: 0, strokeDash: '',
        radiusOL: 0, radiusOR: 0, radiusUL: 0, radiusUR: 0,
      };
      pushUndo();
      objects = [...objects, tobj];
      selectOne(objects[objects.length - 1]);
      persistDbObject(objects[objects.length - 1]);
      textEditUid = uid;
      unsaved = true; justPlaced = true;
      activeTool = 'select';
      return;
    }
    const isImg  = activeTool === 'image';
    const isFrame = activeTool === 'frame';
    const isRnd  = activeTool === 'roundrect';
    const isEllipse = activeTool === 'ellipse';
    const isPolygon = activeTool === 'polygon';
    const defR   = isRnd ? 8 : 0;
    const obj: DrawnObject = {
      type: 'RECHTECK', x, y, w, h,
      fill: isImg || isFrame ? 'none' : objFill,
      stroke: isImg ? '#6b7280' : objStroke,
      strokeW: typeof objStrokeW === 'number' ? objStrokeW : 1,
      strokeDash: isImg ? '6 3' : objStrokeDash,
      shape: isFrame ? 'frame' : isEllipse ? 'ellipse' : isPolygon ? 'polygon' : 'rect',
      polygonSides: isPolygon ? propPolygonSides : undefined,
      frameWidth: isFrame ? Math.max(1, Math.round(unitToPx(propFrameWidth))) : undefined,
      radiusOL: defR, radiusOR: defR, radiusUL: defR, radiusUR: defR,
      rotation: 0, ebene: aktiveEbene,
      isImageFrame: isImg || undefined,
      imageShape: isImg ? imageFrameShape : undefined,
      imageScale: isImg ? 1 : undefined,
      uid: Math.random().toString(36).slice(2, 9),
    };
    pushUndo();
    objects = [...objects, obj];
    selectedObj = objects[objects.length - 1]; // proxied version für Reaktivität
    persistDbObject(selectedObj);
    propX = pxToUnit(x); propY = pxToUnit(y); propW = pxToUnit(w); propH = pxToUnit(h); propRot = 0;
    objRadiusOL = obj.radiusOL; objRadiusOR = obj.radiusOR;
    objRadiusUL = obj.radiusUL; objRadiusUR = obj.radiusUR;
    objCornerStyle = obj.cornerStyle ?? 'round';
    propTab = 'geo';
    unsaved = true;
    justPlaced = true;
    activeTool = 'select';
  }

  function finishWall() {
    if (!drawingWall || drawingWall.pts.length < 2) return;
    let pts = drawingWall.pts.filter((p, i, arr) => i === 0 || Math.hypot(p.x - arr[i - 1].x, p.y - arr[i - 1].y) > 2);
    drawingWall = null;
    if (pts.length < 2) return;
    const closedWall = pts.length > 2 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= mmToPx(propWallWidth) * 0.7;
    if (closedWall) pts = pts.slice(0, -1);
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const wallWidthPx = mmToPx(propWallWidth);
    const wallHatchPx = mmToPx(propWallHatchSpacing);
    const pad = wallWidthPx;
    const x = Math.round(Math.min(...xs) - pad), y = Math.round(Math.min(...ys) - pad);
    const w = Math.max(1, Math.round(Math.max(...xs) - Math.min(...xs) + pad * 2));
    const h = Math.max(1, Math.round(Math.max(...ys) - Math.min(...ys) + pad * 2));
    const obj: DrawnPath = {
      type: 'PFAD', x, y, w, h, ox: x, oy: y,
      isWall: true, wallWidth: wallWidthPx, wallHatchSpacing: wallHatchPx, wallHatchType: propWallHatchType, wallHatchColor: propWallHatchColor,
      points: pts, d: wallPathD(pts, wallWidthPx, wallHatchPx, propWallHatchType, closedWall), glaettung: 0,
      curveClosed: closedWall,
      stroke: objStroke || '#222222', strokeW: typeof objStrokeW === 'number' ? objStrokeW : 1,
      strokeDash: '', fill: 'none',
      uid: Math.random().toString(36).slice(2, 9), ebene: aktiveEbene, rotation: 0,
      radiusOL: 0, radiusOR: 0, radiusUL: 0, radiusUR: 0,
    };
    pushUndo();
    objects = [...objects, obj];
    selectOne(objects[objects.length - 1]);
    persistDbObject(objects[objects.length - 1]);
    unsaved = true; justPlaced = true;
    activeTool = 'select';
  }

  // ── Objekt verschieben ───────────────────────────────────────────────────
  function startMove(ev: MouseEvent, obj: DrawnObject) {
    ev.preventDefault();
    ev.stopPropagation();
    if (!canOperateOn(obj)) return;
    pushUndo();
    const startMX = ev.clientX, startMY = ev.clientY;
    const targets = selectedObjs.length > 1
      ? activeLayerObjects(selectedObjs)
      : obj.groupId
      ? objects.filter(o => o.groupId === obj.groupId && canOperateOn(o))
      : [obj];
    if (!targets.length) return;
    if (obj.groupId && selectedObjs.length !== targets.length) {
      selectedObjs = targets;
      selectedObj = null;
    }
    const starts  = targets.map(o => o.type === 'LINIE'
      ? { x: o.x, y: o.y, x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, ox: 0, oy: 0, d: '', imageMaskD: '', points: [] as {x:number;y:number;t?:number}[] }
      : o.type === 'PFAD'
        ? { x: o.x, y: o.y, x1: 0, y1: 0, x2: 0, y2: 0, ox: o.ox, oy: o.oy, d: o.d, imageMaskD: '', points: o.points.map(p => ({ ...p })) }
        : { x: o.x, y: o.y, x1: 0, y1: 0, x2: 0, y2: 0, ox: 0, oy: 0, d: '', imageMaskD: o.type === 'RECHTECK' ? o.imageMaskD ?? '' : '', points: [] as {x:number;y:number;t?:number}[] });
    function onMove(mv: MouseEvent) {
      const dx = (mv.clientX - startMX) / zoomFactor;
      const dy = (mv.clientY - startMY) / zoomFactor;
      targets.forEach((o, i) => {
        if (o.type === 'LINIE') {
          const s = starts[i];
          const nx1 = snapX(Math.round(s.x1 + dx));
          const ny1 = snapY(Math.round(s.y1 + dy));
          const offX = nx1 - s.x1, offY = ny1 - s.y1;
          o.x1 = nx1; o.y1 = ny1;
          o.x2 = Math.round(s.x2 + offX); o.y2 = Math.round(s.y2 + offY);
          updateLineBBox(o);
        } else if (o.type === 'PFAD') {
          const s = starts[i];
          const nx = snapX(Math.round(s.x + dx));
          const ny = snapY(Math.round(s.y + dy));
          const offX = nx - s.x, offY = ny - s.y;
          if (s.points.length >= 2) {
            o.points = s.points.map(p => ({ ...p, x: p.x + offX, y: p.y + offY }));
            o.ox = Math.round(s.ox + offX);
            o.oy = Math.round(s.oy + offY);
            o.d = o.isBrush
              ? brushPathD(o.points, o.brushSize ?? propBrushSize, o.brushForm ?? propBrushForm, o.glaettung)
              : o.isCurve
              ? curvePathD(o.points, o.curveClosed)
              : smoothPts(o.points, o.glaettung);
            if (o.isBrush) normalizeBrushOrigin(o);
            else { o.x = nx; o.y = ny; }
          } else {
            o.d = transformPathD(s.d, offX, offY);
            updatePathBBoxFromD(o);
            o.ox = o.x;
            o.oy = o.y;
          }
        } else {
          const s = starts[i];
          const nx = snapX(Math.round(s.x + dx));
          const ny = snapY(Math.round(s.y + dy));
          const offX = nx - s.x, offY = ny - s.y;
          o.x = nx;
          o.y = ny;
          if (o.type === 'RECHTECK' && o.imageMaskD) {
            o.imageMaskD = transformPathD(s.imageMaskD || o.imageMaskD, offX, offY);
          }
        }
      });
      if (targets.length === 1) { propX = pxToUnit(obj.x); propY = pxToUnit(obj.y); }
      unsaved = true;
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      persistDbObjects(targets);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ── Objekt skalieren ─────────────────────────────────────────────────────
  function rotateObjectAround(obj: DrawnObject, cx: number, cy: number, deltaDeg: number) {
    const rad = deltaDeg * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const rotPt = (x: number, y: number) => ({
      x: cx + (x - cx) * cos - (y - cy) * sin,
      y: cy + (x - cx) * sin + (y - cy) * cos,
    });
    if (obj.type === 'LINIE') {
      const p1 = rotPt(obj.x1, obj.y1);
      const p2 = rotPt(obj.x2, obj.y2);
      obj.x1 = Math.round(p1.x); obj.y1 = Math.round(p1.y);
      obj.x2 = Math.round(p2.x); obj.y2 = Math.round(p2.y);
      obj.rotation = 0;
      updateLineBBox(obj);
      return;
    }
    const center = rotPt(obj.x + obj.w / 2, obj.y + obj.h / 2);
    obj.x = Math.round(center.x - obj.w / 2);
    obj.y = Math.round(center.y - obj.h / 2);
    obj.rotation = ((obj.rotation ?? 0) + deltaDeg) % 360;
    if (obj.type === 'PFAD') {
      obj.points = obj.points.map(p => ({ ...p, ...rotPt(p.x, p.y) }));
      obj.ox = obj.x;
      obj.oy = obj.y;
      obj.d = obj.isBrush
        ? brushPathD(obj.points, obj.brushSize ?? propBrushSize, obj.brushForm ?? propBrushForm, obj.glaettung)
        : obj.isWall
        ? wallPathD(obj.points, obj.wallWidth ?? mmToPx(propWallWidth), obj.wallHatchSpacing ?? mmToPx(propWallHatchSpacing), obj.wallHatchType ?? propWallHatchType, obj.curveClosed)
        : obj.isCurve
        ? curvePathD(obj.points, obj.curveClosed)
        : obj.points.length >= 2 ? smoothPts(obj.points, obj.glaettung) : rotatePathD(obj.d, cx, cy, deltaDeg);
      if (obj.isBrush) normalizeBrushOrigin(obj);
    }
  }

  function startRotate(ev: MouseEvent, obj: DrawnObject) {
    ev.preventDefault();
    ev.stopPropagation();
    if (!canOperateOn(obj)) return;
    pushUndo();
    if (obj.type === 'LINIE') {
      const line = obj;
      const wrap = (ev.currentTarget as HTMLElement).closest('.canvas-scroll') as HTMLElement | null;
      const wr = wrap?.getBoundingClientRect();
      const toCanvas = (clientX: number, clientY: number) => ({
        x: wr ? (clientX - wr.left) / zoomFactor : clientX,
        y: wr ? (clientY - wr.top) / zoomFactor : clientY,
      });
      const cx = (line.x1 + line.x2) / 2;
      const cy = (line.y1 + line.y2) / 2;
      const len = lineLengthRaw(line);
      const startMouse = toCanvas(ev.clientX, ev.clientY);
      const startMouseAngle = Math.atan2(startMouse.y - cy, startMouse.x - cx);
      const startLineAngle = Math.atan2(line.y2 - line.y1, line.x2 - line.x1);
      function onMoveLine(mv: MouseEvent) {
        const mouse = toCanvas(mv.clientX, mv.clientY);
        const angle = startLineAngle + (Math.atan2(mouse.y - cy, mouse.x - cx) - startMouseAngle);
        const dx = Math.cos(angle) * len / 2;
        const dy = Math.sin(angle) * len / 2;
        line.x1 = Math.round(cx - dx);
        line.y1 = Math.round(cy - dy);
        line.x2 = Math.round(cx + dx);
        line.y2 = Math.round(cy + dy);
        line.rotation = 0;
        updateLineBBox(line);
        propRot = parseFloat(lineAngleDeg(line).toFixed(1));
        propX = pxToUnit(line.x); propY = pxToUnit(line.y);
        propW = pxToUnit(line.w); propH = pxToUnit(line.h);
        propLineLength = pxToUnit(lineLengthRaw(line));
        propLineLengthInput = propLineLength;
        replaceObject(line);
        unsaved = true;
      }
      function onUpLine() {
        document.removeEventListener('mousemove', onMoveLine);
        document.removeEventListener('mouseup', onUpLine);
        persistDbObject(line);
      }
      document.addEventListener('mousemove', onMoveLine);
      document.addEventListener('mouseup', onUpLine);
      return;
    }
    const rect = (ev.currentTarget as HTMLElement).closest('.obj-hit')?.getBoundingClientRect();
    if (!rect) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const startAngle = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI;
    const startRot = obj.rotation ?? 0;
    function onMove(mv: MouseEvent) {
      const a = Math.atan2(mv.clientY - cy, mv.clientX - cx) * 180 / Math.PI;
      const nextRot = ((startRot + a - startAngle) % 360 + 360) % 360;
      obj.rotation = nextRot;
      propRot = parseFloat(obj.rotation.toFixed(1));
      unsaved = true;
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      persistDbObject(obj);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function startRotateSelection(ev: MouseEvent) {
    ev.preventDefault();
    ev.stopPropagation();
    selectedObjs = activeLayerObjects(selectedObjs);
    if (selectedObjs.length < 2) return;
    pushUndo();
    const mbx1 = Math.min(...selectedObjs.map(o => o.x));
    const mby1 = Math.min(...selectedObjs.map(o => o.y));
    const mbx2 = Math.max(...selectedObjs.map(o => o.x + o.w));
    const mby2 = Math.max(...selectedObjs.map(o => o.y + o.h));
    const cx = (mbx1 + mbx2) / 2;
    const cy = (mby1 + mby2) / 2;
    const wrap = (ev.currentTarget as HTMLElement).closest('.canvas-scroll') as HTMLElement | null;
    const r = wrap?.getBoundingClientRect();
    const sx = r ? (ev.clientX - r.left) / zoomFactor : ev.clientX;
    const sy = r ? (ev.clientY - r.top) / zoomFactor : ev.clientY;
    const startAngle = Math.atan2(sy - cy, sx - cx) * 180 / Math.PI;
    const starts = selectedObjs.map(cloneObjectSnapshot);
    function onMove(mv: MouseEvent) {
      const mx = r ? (mv.clientX - r.left) / zoomFactor : mv.clientX;
      const my = r ? (mv.clientY - r.top) / zoomFactor : mv.clientY;
      const a = Math.atan2(my - cy, mx - cx) * 180 / Math.PI;
      const delta = a - startAngle;
      selectedObjs.forEach((o, i) => {
        Object.assign(o, cloneObjectSnapshot(starts[i]));
        rotateObjectAround(o, cx, cy, delta);
      });
      unsaved = true;
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      persistDbObjects(selectedObjs);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function rotateSelectedBy(deltaDeg: number) {
    const targets = activeLayerObjects(selectedObjs.length ? selectedObjs : selectedObj ? [selectedObj] : []);
    if (!targets.length) return;
    pushUndo();
    if (targets.length === 1) {
      const obj = targets[0];
      if (obj.type === 'LINIE') {
        rotateObjectAround(obj, (obj.x1 + obj.x2) / 2, (obj.y1 + obj.y2) / 2, deltaDeg);
        propRot = parseFloat(lineAngleDeg(obj).toFixed(1));
        propLineLength = pxToUnit(lineLengthRaw(obj));
        propLineLengthInput = propLineLength;
      } else {
        obj.rotation = (((obj.rotation ?? 0) + deltaDeg) % 360 + 360) % 360;
        propRot = parseFloat(obj.rotation.toFixed(1));
      }
      propX = pxToUnit(obj.x); propY = pxToUnit(obj.y);
      propW = pxToUnit(obj.w); propH = pxToUnit(obj.h);
    } else {
      const x1 = Math.min(...targets.map(o => o.x));
      const y1 = Math.min(...targets.map(o => o.y));
      const x2 = Math.max(...targets.map(o => o.x + o.w));
      const y2 = Math.max(...targets.map(o => o.y + o.h));
      targets.forEach(o => rotateObjectAround(o, (x1 + x2) / 2, (y1 + y2) / 2, deltaDeg));
    }
    persistDbObjects(targets);
    objects = [...objects];
    unsaved = true;
  }

  function startResize(ev: MouseEvent, obj: DrawnObject, handle: string) {
    ev.preventDefault();
    ev.stopPropagation();
    if (!canOperateOn(obj)) return;
    if (obj.type === 'LINIE' && handle === 'tc') {
      startRotate(ev, obj);
      return;
    }
    pushUndo();
    const startMX = ev.clientX, startMY = ev.clientY;
    if (obj.type === 'LINIE') {
      const line = obj;
      const start = { x1: line.x1, y1: line.y1, x2: line.x2, y2: line.y2 };
      const chooseStart =
        handle.includes('l') ? start.x1 <= start.x2 :
        handle.includes('r') ? start.x1 > start.x2 :
        handle.includes('t') ? start.y1 <= start.y2 :
        handle.includes('b') ? start.y1 > start.y2 :
        false;
      function onMoveLine(mv: MouseEvent) {
        let nx = (chooseStart ? start.x1 : start.x2) + (mv.clientX - startMX) / zoomFactor;
        let ny = (chooseStart ? start.y1 : start.y2) + (mv.clientY - startMY) / zoomFactor;
        if (mv.shiftKey) {
          const ax = chooseStart ? start.x2 : start.x1;
          const ay = chooseStart ? start.y2 : start.y1;
          const dx = Math.abs(nx - ax), dy = Math.abs(ny - ay);
          if (dx > dy) ny = ay; else nx = ax;
        }
        if (chooseStart) {
          line.x1 = snapX(Math.round(nx));
          line.y1 = snapY(Math.round(ny));
          line.x2 = start.x2;
          line.y2 = start.y2;
        } else {
          line.x1 = start.x1;
          line.y1 = start.y1;
          line.x2 = snapX(Math.round(nx));
          line.y2 = snapY(Math.round(ny));
        }
        updateLineBBox(line);
        propX = pxToUnit(line.x); propY = pxToUnit(line.y);
        propW = pxToUnit(line.w); propH = pxToUnit(line.h);
        propLineLength = pxToUnit(lineLengthRaw(line));
        propLineLengthInput = propLineLength;
        if (line.isMasslinie) {
          propMassText = lineMassText(lineLengthRaw(line));
          line.massText = propMassText;
        }
        replaceObject(line);
        unsaved = true;
      }
      function onUpLine() {
        document.removeEventListener('mousemove', onMoveLine);
        document.removeEventListener('mouseup', onUpLine);
        persistDbObject(line);
      }
      document.addEventListener('mousemove', onMoveLine);
      document.addEventListener('mouseup', onUpLine);
      return;
    }
    const sx = obj.x, sy = obj.y, sw = obj.w, sh = obj.h;
    const startPathPoints = obj.type === 'PFAD' ? obj.points.map(p => ({ ...p })) : [];
    const startPathD = obj.type === 'PFAD' ? obj.d : '';
    const startImageMaskD = obj.type === 'RECHTECK' ? obj.imageMaskD ?? '' : '';
    function onMove(mv: MouseEvent) {
      const dx = (mv.clientX - startMX) / zoomFactor;
      const dy = (mv.clientY - startMY) / zoomFactor;
      let nx = sx, ny = sy, nw = sw, nh = sh;
      if (handle === 'tl') { nx = sx+dx; ny = sy+dy; nw = sw-dx; nh = sh-dy; }
      if (handle === 'tc') {              ny = sy+dy;              nh = sh-dy; }
      if (handle === 'tr') {              ny = sy+dy; nw = sw+dx; nh = sh-dy; }
      if (handle === 'ml') { nx = sx+dx;              nw = sw-dx;             }
      if (handle === 'mr') {                           nw = sw+dx;             }
      if (handle === 'bl') { nx = sx+dx;              nw = sw-dx; nh = sh+dy; }
      if (handle === 'bc') {                                        nh = sh+dy; }
      if (handle === 'br') {                           nw = sw+dx; nh = sh+dy; }
      obj.x = snapX(Math.round(nx)); obj.y = snapY(Math.round(ny));
      obj.w = snapX(Math.round(Math.max(4, nw))); obj.h = snapY(Math.round(Math.max(4, nh)));
      if (obj.type === 'PFAD' && sw > 0 && sh > 0) {
        const scaleX = obj.w / sw;
        const scaleY = obj.h / sh;
        if (startPathPoints.length >= 2) {
          obj.points = startPathPoints.map(p => ({
            ...p,
            x: obj.x + (p.x - sx) * scaleX,
            y: obj.y + (p.y - sy) * scaleY,
          }));
          obj.ox = obj.x;
          obj.oy = obj.y;
          obj.d = obj.isBrush
            ? brushPathD(obj.points, obj.brushSize ?? propBrushSize, obj.brushForm ?? propBrushForm, obj.glaettung)
            : obj.isWall
            ? wallPathD(obj.points, obj.wallWidth ?? mmToPx(propWallWidth), obj.wallHatchSpacing ?? mmToPx(propWallHatchSpacing), obj.wallHatchType ?? propWallHatchType, obj.curveClosed)
            : obj.isCurve
            ? curvePathD(obj.points, obj.curveClosed)
            : smoothPts(obj.points, obj.glaettung);
          if (obj.isBrush) normalizeBrushOrigin(obj);
        } else {
          obj.d = transformPathD(startPathD, obj.x - sx, obj.y - sy, scaleX, scaleY, sx, sy);
          updatePathBBoxFromD(obj);
          obj.ox = obj.x;
          obj.oy = obj.y;
        }
      }
      if (obj.type === 'RECHTECK' && startImageMaskD && sw > 0 && sh > 0) {
        obj.imageMaskD = transformPathD(startImageMaskD, obj.x - sx, obj.y - sy, obj.w / sw, obj.h / sh, sx, sy);
      }
      propX = pxToUnit(obj.x); propY = pxToUnit(obj.y);
      propW = pxToUnit(obj.w); propH = pxToUnit(obj.h);
      unsaved = true;
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      persistDbObject(obj);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function startResizeSelection(ev: MouseEvent, handle: string) {
    ev.preventDefault();
    ev.stopPropagation();
    selectedObjs = activeLayerObjects(selectedObjs);
    if (selectedObjs.length < 2) return;
    pushUndo();
    const startMX = ev.clientX, startMY = ev.clientY;
    const sx = Math.min(...selectedObjs.map(o => o.x));
    const sy = Math.min(...selectedObjs.map(o => o.y));
    const sx2 = Math.max(...selectedObjs.map(o => o.x + o.w));
    const sy2 = Math.max(...selectedObjs.map(o => o.y + o.h));
    const sw = Math.max(1, sx2 - sx);
    const sh = Math.max(1, sy2 - sy);
    const starts = selectedObjs.map(cloneObjectSnapshot);
    function applyScale(o: DrawnObject, start: DrawnObject, nx: number, ny: number, nw: number, nh: number) {
      const scaleX = nw / sw;
      const scaleY = nh / sh;
      const mapX = (x: number) => nx + (x - sx) * scaleX;
      const mapY = (y: number) => ny + (y - sy) * scaleY;
      if (o.type === 'LINIE' && start.type === 'LINIE') {
        o.x1 = Math.round(mapX(start.x1)); o.y1 = Math.round(mapY(start.y1));
        o.x2 = Math.round(mapX(start.x2)); o.y2 = Math.round(mapY(start.y2));
        updateLineBBox(o);
      } else if (o.type === 'PFAD' && start.type === 'PFAD') {
        o.points = start.points.map(p => ({ ...p, x: mapX(p.x), y: mapY(p.y) }));
        o.x = Math.round(mapX(start.x)); o.y = Math.round(mapY(start.y));
        o.w = Math.max(1, Math.round(start.w * scaleX)); o.h = Math.max(1, Math.round(start.h * scaleY));
        o.ox = o.x; o.oy = o.y;
        o.d = o.isBrush
          ? brushPathD(o.points, o.brushSize ?? propBrushSize, o.brushForm ?? propBrushForm, o.glaettung)
          : o.isWall
          ? wallPathD(o.points, o.wallWidth ?? mmToPx(propWallWidth), o.wallHatchSpacing ?? mmToPx(propWallHatchSpacing), o.wallHatchType ?? propWallHatchType, o.curveClosed)
          : o.isCurve
          ? curvePathD(o.points, o.curveClosed)
          : smoothPts(o.points, o.glaettung);
        if (o.isBrush) normalizeBrushOrigin(o);
      } else {
        o.x = Math.round(mapX(start.x)); o.y = Math.round(mapY(start.y));
        o.w = Math.max(1, Math.round(start.w * scaleX)); o.h = Math.max(1, Math.round(start.h * scaleY));
        if (o.type === 'RECHTECK' && start.type === 'RECHTECK' && start.imageMaskD) {
          o.imageMaskD = transformPathD(start.imageMaskD, o.x - start.x, o.y - start.y, o.w / start.w, o.h / start.h, start.x, start.y);
        }
      }
    }
    function onMove(mv: MouseEvent) {
      const dx = (mv.clientX - startMX) / zoomFactor;
      const dy = (mv.clientY - startMY) / zoomFactor;
      let nx = sx, ny = sy, nw = sw, nh = sh;
      if (handle === 'tl') { nx = sx+dx; ny = sy+dy; nw = sw-dx; nh = sh-dy; }
      if (handle === 'tc') {              ny = sy+dy;              nh = sh-dy; }
      if (handle === 'tr') {              ny = sy+dy; nw = sw+dx; nh = sh-dy; }
      if (handle === 'ml') { nx = sx+dx;              nw = sw-dx;             }
      if (handle === 'mr') {                           nw = sw+dx;             }
      if (handle === 'bl') { nx = sx+dx;              nw = sw-dx; nh = sh+dy; }
      if (handle === 'bc') {                                        nh = sh+dy; }
      if (handle === 'br') {                           nw = sw+dx; nh = sh+dy; }
      nw = Math.max(4, nw); nh = Math.max(4, nh);
      selectedObjs.forEach((o, i) => {
        Object.assign(o, cloneObjectSnapshot(starts[i]));
        applyScale(o, starts[i], nx, ny, nw, nh);
      });
      unsaved = true;
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      persistDbObjects(selectedObjs);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function startImagePan(ev: MouseEvent, obj: DrawnRect) {
    ev.preventDefault(); ev.stopPropagation();
    const startMX = ev.clientX, startMY = ev.clientY;
    const startOX = obj.imageOffsetX ?? 0, startOY = obj.imageOffsetY ?? 0;
    function onMove(mv: MouseEvent) {
      obj.imageOffsetX = Math.round(startOX + (mv.clientX - startMX) / zoomFactor);
      obj.imageOffsetY = Math.round(startOY + (mv.clientY - startMY) / zoomFactor);
      unsaved = true;
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      persistDbObject(obj);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function applyLock(changed: 'W' | 'H') {
    if (!propLock || !selectedObj || selectedObj.w === 0 || selectedObj.h === 0) return;
    const ratio = selectedObj.w / selectedObj.h;
    if (changed === 'W') propH = parseFloat((propW / ratio).toFixed(genauigkeit));
    else                 propW = parseFloat((propH * ratio).toFixed(genauigkeit));
  }

  function stepNum(key: 'propX'|'propY'|'propW'|'propH'|'propShearX'|'propShearY'|'propRot', delta: number) {
    if (key === 'propX')      propX      = propX      + delta;
    if (key === 'propY')      propY      = propY      + delta;
    if (key === 'propW')    { propW      = Math.max(0, propW + delta); applyLock('W'); }
    if (key === 'propH')    { propH      = Math.max(0, propH + delta); applyLock('H'); }
    if (key === 'propShearX') propShearX = propShearX + delta;
    if (key === 'propShearY') propShearY = propShearY + delta;
    if (key === 'propRot')    propRot    = ((propRot + delta) % 360 + 360) % 360;
    if (selectedObj) syncObjFromProps();
  }

  function onPropWChange() { applyLock('W'); syncObjFromProps(); }
  function onPropHChange() { applyLock('H'); syncObjFromProps(); }

  function applyLineLength() {
    if (!selectedObj || selectedObj.type !== 'LINIE') return;
    if (propLineLengthInput === '') return;
    propLineLength = propLineLengthInput;
    const len = lineLengthRaw(selectedObj);
    const newLen = Math.max(1, unitToPx(propLineLength));
    if (len <= 0) return;
    pushUndo();
    const scale = newLen / len;
    selectedObj.x2 = snapX(Math.round(selectedObj.x1 + (selectedObj.x2 - selectedObj.x1) * scale));
    selectedObj.y2 = snapY(Math.round(selectedObj.y1 + (selectedObj.y2 - selectedObj.y1) * scale));
    updateLineBBox(selectedObj);
    const current = selectedObj;
    replaceObject(current);
    propX = pxToUnit(selectedObj.x); propY = pxToUnit(selectedObj.y);
    propW = pxToUnit(selectedObj.w); propH = pxToUnit(selectedObj.h);
    propLineLength = pxToUnit(lineLengthRaw(selectedObj));
    propLineLengthInput = propLineLength;
    if (selectedObj.isMasslinie) {
      propMassText = lineMassText(lineLengthRaw(selectedObj));
      selectedObj.massText = propMassText;
    }
    persistDbObject(selectedObj);
    unsaved = true;
  }

  function imageMimeFromName(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase() ?? 'png';
    return ext === 'svg' ? 'image/svg+xml'
      : ext === 'gif' ? 'image/gif'
      : ext === 'webp' ? 'image/webp'
      : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : 'image/png';
  }

  function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return `data:${mime};base64,${btoa(binary)}`;
  }

  function bytesToHex(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  async function currentAssetDir(): Promise<string> {
    return join(await appLocalDataDir(), 'vecstructi_assets');
  }

  async function clearCurrentAssetDir() {
    const dir = await currentAssetDir();
    try {
      if (await exists(dir)) await remove(dir, { recursive: true });
    } catch (err) {
      console.error('Interner Asset-Ordner konnte nicht geleert werden', err);
    }
    await mkdir(dir, { recursive: true });
  }

  async function assetDirForDocument(filePath: string): Promise<string> {
    const dir = await dirname(filePath);
    const name = await basename(filePath, '.vecstructi');
    return join(dir, `${name}_assets`);
  }

  async function syncAssetsToDocumentDir(docPath: string): Promise<void> {
    const srcDir = await currentAssetDir();
    const dstDir = await assetDirForDocument(docPath);
    await mkdir(dstDir, { recursive: true });
    try {
      const entries = await readDir(srcDir);
      await Promise.all(entries.map(async entry => {
        if (!entry.isFile) return;
        const bytes = await readFile(await join(srcDir, entry.name));
        await writeFile(await join(dstDir, entry.name), bytes);
      }));
    } catch { /* asset dir leer oder nicht vorhanden */ }
  }

  async function loadAssetsFromDocumentDir(docPath: string): Promise<void> {
    const srcDir = await assetDirForDocument(docPath);
    if (!(await exists(srcDir))) return;
    const dstDir = await currentAssetDir();
    await mkdir(dstDir, { recursive: true });
    try {
      const entries = await readDir(srcDir);
      await Promise.all(entries.map(async entry => {
        if (!entry.isFile) return;
        const bytes = await readFile(await join(srcDir, entry.name));
        await writeFile(await join(dstDir, entry.name), bytes);
      }));
    } catch (err) {
      console.error('Assets konnten nicht geladen werden', err);
    }
  }

  async function currentDbFilePath(): Promise<string> {
    const path = getDbPath();
    if (path === DB_PATH) return join(await appLocalDataDir(), 'vecstructi.db');
    return path.replace(/^sqlite:/, '');
  }

  async function assetPathFor(fileName: string): Promise<string> {
    return join(await currentAssetDir(), fileName);
  }

  function safeAssetFileName(sourcePath: string, uid: string): string {
    const raw = sourcePath.split('/').pop()?.split('\\').pop() ?? `bild-${uid}.png`;
    const dot = raw.lastIndexOf('.');
    const ext = dot >= 0 ? raw.slice(dot).toLowerCase() : '.png';
    const base = dot >= 0 ? raw.slice(0, dot) : raw;
    const safeBase = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'bild';
    return `${safeBase}-${uid}${ext}`;
  }

  async function importImageAsset(sourcePath: string, uid: string): Promise<{ fileName: string; url: string }> {
    const fileName = safeAssetFileName(sourcePath, uid);
    const dir = await currentAssetDir();
    await mkdir(dir, { recursive: true });
    const bytes = await readFile(sourcePath);
    const target = await join(dir, fileName);
    await writeFile(target, bytes);
    return { fileName, url: bytesToDataUrl(bytes, imageMimeFromName(fileName)) };
  }

  async function loadImageAsset(fileName: string): Promise<string | undefined> {
    try {
      const bytes = await readFile(await assetPathFor(fileName));
      return bytesToDataUrl(bytes, imageMimeFromName(fileName));
    } catch (err) {
      console.error('Bild-Asset konnte nicht geladen werden', fileName, err);
      return undefined;
    }
  }

  async function resolveImageAssets() {
    const imageObjects = objects.filter((o): o is DrawnRect => o.type === 'RECHTECK' && !!o.isImageFrame && !!o.imageFile);
    await Promise.all(imageObjects.map(async obj => {
      const url = await loadImageAsset(obj.imageFile!);
      if (url) obj.imageUrl = url;
    }));
    if (imageObjects.length) objects = [...objects];
  }

  function blobToBytes(data: unknown): Uint8Array {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (Array.isArray(data)) return new Uint8Array(data);
    if (data && typeof data === 'object' && Array.isArray((data as { data?: unknown }).data)) {
      return new Uint8Array((data as { data: number[] }).data);
    }
    if (typeof data === 'string') {
      try {
        const trimmed = data.trim();
        if (trimmed.startsWith('[')) return new Uint8Array(JSON.parse(trimmed));
        const binary = atob(data.includes(',') ? data.split(',').pop() ?? '' : data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      } catch {
        return new Uint8Array();
      }
    }
    return new Uint8Array();
  }

  async function packImageAssetsIntoDb() {
    const imageObjects = objects.filter((o): o is DrawnRect => o.type === 'RECHTECK' && !!o.isImageFrame && !!o.imageFile);
    if (!imageObjects.length) return;
    const db = await getDb();
    const seen = new Set<string>();
    for (const obj of imageObjects) {
      const fileName = obj.imageFile!;
      if (seen.has(fileName)) continue;
      seen.add(fileName);
      const bytes = await readFile(await assetPathFor(fileName));
      const dataHex = bytesToHex(bytes);
      await db.execute(
        `INSERT INTO image_assets (document_id, file_name, mime, data, updated_at)
         VALUES ($1, $2, $3, x'${dataHex}', CURRENT_TIMESTAMP)
         ON CONFLICT(document_id, file_name) DO UPDATE SET
           mime = excluded.mime,
           data = excluded.data,
           updated_at = CURRENT_TIMESTAMP`,
        [DEFAULT_DOCUMENT_ID, fileName, imageMimeFromName(fileName)],
      );
    }
  }

  async function extractImageAssetsFromDb() {
    const db = await getDb();
    const rows = await db.select<Array<{ file_name: string; data: unknown }>>(
      `SELECT file_name, data
         FROM image_assets
        WHERE document_id = $1`,
      [DEFAULT_DOCUMENT_ID],
    );
    if (!rows.length) return;
    const dir = await currentAssetDir();
    await mkdir(dir, { recursive: true });
    await Promise.all(rows.map(async row => {
      try {
        const bytes = blobToBytes(row.data);
        if (!bytes.length) {
          console.error('Bild-Asset aus DB ist leer', row.file_name);
          return;
        }
        await writeFile(await join(dir, row.file_name), bytes);
      } catch (err) {
        console.error('Bild-Asset konnte nicht extrahiert werden', row.file_name, err);
      }
    }));
  }

  async function loadCurrentDbIntoApp() {
    await initDocumentDb();
    await extractImageAssetsFromDb();
    const layout = await loadDocumentLayout();
    applyDocumentLayoutFromDb(layout);
    const [rects, lines, texts, paths] = await Promise.all([loadRectObjects(), loadLineObjects(), loadTextObjects(), loadPathObjects()]);
    const loadedPaths = paths.map(path => ({
      ...path,
      d: path.d
        ? path.d
        : path.isWall
        ? wallPathD(path.points, path.wallWidth ?? mmToPx(10), path.wallHatchSpacing ?? mmToPx(5), path.wallHatchType ?? 'diagonal', path.curveClosed)
        : path.isBrush
        ? brushPathD(path.points, path.brushSize ?? 10, path.brushForm ?? 'kreis', path.glaettung)
        : path.isCurve
        ? curvePathD(path.points, path.curveClosed)
        : smoothPts(path.points, path.glaettung)
    }));
    const loaded = [...rects, ...lines, ...texts, ...loadedPaths].sort((a, b) => ((a as any).dbZIndex ?? 0) - ((b as any).dbZIndex ?? 0));
    const raster = ebenen.find(e => e.name === 'Raster') ?? { name: 'Raster', sichtbar: true, gesperrt: false, opacity: 100 };
    const layerRows = await loadLayerObjects();
    let loadedLayers: Ebene[] = layerRows.map(r => ({ name: r.name, sichtbar: r.visible, gesperrt: r.locked, opacity: r.opacity }));
    if (!loadedLayers.length) loadedLayers = [{ name: 'Ebene 1', sichtbar: true, gesperrt: false, opacity: 100 }];
    ebenen = [...loadedLayers, raster];
    aktiveEbene = loadedLayers[0].name;
    objects = loaded;
    selectedObj = null;
    selectedObjs = [];
    await resolveImageAssets();
    await tick();
    requestAnimationFrame(() => void fitDocumentWindowToPage(false));
  }

  async function onObjDblClick(obj: DrawnObject) {
    if (obj.type === 'TEXT') {
      selectOne(obj);
      propTab = 'geo';
      if (activeTool === 'text') textEditUid = obj.uid;
      return;
    }
    if (!isImageFrameObject(obj)) return;
    const selected = await dialogOpen({
      filters: [{ name: 'Bild', extensions: ['png','jpg','jpeg','gif','webp','svg'] }],
      multiple: false,
    });
    if (!selected) return;
    const path = typeof selected === 'string' ? selected : selected[0];
    const imported = await importImageAsset(path, obj.uid);
    obj.imageFile = imported.fileName;
    obj.imageUrl = imported.url;
    obj.imageScale = 1;
    propImageScale = 1;
    persistDbObject(obj);
    objects = [...objects];
    unsaved = true;
  }

  const TOOLS = [
    { id: 'select',      title: 'Auswählen (V)',          icon: 'select'      },
    { id: 'direct',      title: 'Direkt auswählen (A)',   icon: 'direct'      },
    { id: 'brush',       title: 'Pinsel (B)',             icon: 'brush'       },
    { id: 'pencil',      title: 'Bleistift (N)',          icon: 'pencil'      },
    { id: 'eraser',      title: 'Radierer (E)',           icon: 'eraser'      },
    { id: 'text',        title: 'Text (T)',               icon: 'text'        },
    { id: 'line',        title: 'Linie (\\)',             icon: 'line'        },
    { id: 'arc',         title: 'Kurve',                  icon: 'arc'         },
    { id: 'rect',        title: 'Rechteck (R)',           icon: 'rect'        },
    { id: 'roundrect',   title: 'Abgerundetes Rechteck',  icon: 'roundrect'   },
    { id: 'ellipse',     title: 'Ellipse (O)',            icon: 'ellipse'     },
    { id: 'polygon',     title: 'Polygon',                icon: 'polygon'     },
    { id: 'image',       title: 'Bild',                   icon: 'star'        },
    { id: 'rotate',      title: 'Drehen',                 icon: 'rotate'      },
    { id: 'frame',       title: 'Rahmen',                 icon: 'frame'       },
    { id: 'wall',        title: 'Wand',                   icon: 'wall'        },
    { id: 'hand',        title: 'Hand (H)',               icon: 'hand'        },
    { id: 'gradient',    title: 'Farbverlauf',            icon: 'gradient'    },
    { id: 'fill-tool',   title: 'Füllen',                 icon: 'fill'        },
    { id: 'measure',     title: 'Messen',                 icon: 'measure'     },
    { id: 'zoom',        title: 'Zoom (Z)',               icon: 'zoom'        },
  ];

  const MM_TO_PX = 96 / 25.4;
  function mmToPx(mm: number): number { return Math.round(mm * MM_TO_PX); }
  function focusOnMount(el: HTMLElement) { requestAnimationFrame(() => { el.focus(); (el as HTMLTextAreaElement).select?.(); }); }

  function sanitizeRichHtml(html: string): string {
    if (typeof document === 'undefined') return html;
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    tpl.content.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach(n => n.remove());
    tpl.content.querySelectorAll('*').forEach(node => {
      for (const attr of Array.from(node.attributes)) {
        if (attr.name.startsWith('on')) node.removeAttribute(attr.name);
      }
    });
    return tpl.innerHTML;
  }

  function textEditorEl(): HTMLElement | null {
    if (!textEditUid) return null;
    return document.querySelector(`[data-text-editor="${textEditUid}"]`) as HTMLElement | null;
  }

  function rememberTextSelection() {
    const el = textEditorEl();
    const sel = window.getSelection();
    if (!el || !sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return;
    savedTextRange = range.cloneRange();

    // Live-Props aus Inline-Style des nächsten Vorfahren-Spans lesen
    // (computedStyle normalisiert Font-Namen → passt nicht zur Select-Option)
    let node: Node | null = range.startContainer;
    if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
    let cur: Element | null = node as Element | null;
    let foundFf = false;
    let foundFs = false;
    while (cur && cur !== el) {
      const s = (cur as HTMLElement).style;
      if (s) {
        if (!foundFf && s.fontFamily) { propFontFamily = s.fontFamily.replace(/"/g, "'"); foundFf = true; }
        if (!foundFs && s.fontSize)   { const px = parseFloat(s.fontSize); if (px > 0) { propFontSize = Math.round(px / zoomFactor); foundFs = true; } }
      }
      cur = cur.parentElement;
    }
    // Schriftstil weiterhin aus computed (bold/italic sind zuverlässig)
    if (node && el.contains(node)) {
      const cs = window.getComputedStyle(node as Element);
      propFontBold   = cs.fontWeight === 'bold' || Number(cs.fontWeight) >= 700;
      propFontItalic = cs.fontStyle === 'italic' || cs.fontStyle === 'oblique';
    }
  }

  function restoreTextSelection() {
    const el = textEditorEl();
    const sel = window.getSelection();
    if (!el || !sel || !savedTextRange) return;
    el.focus({ preventScroll: true });
    sel.removeAllRanges();
    sel.addRange(savedTextRange);
  }

  function applyRichText(command: string, value?: string) {
    const el = textEditorEl();
    if (!el) {
      if (selectedObj?.type === 'TEXT') textEditUid = selectedObj.uid;
      return;
    }
    restoreTextSelection();
    document.execCommand(command, false, value);
    rememberTextSelection();
    const obj = objects.find(o => o.uid === textEditUid);
    if (obj?.type === 'TEXT') {
      obj.richHtml = sanitizeRichHtml(unscaleRichHtmlFonts(el.innerHTML, zoomFactor));
      persistDbObject(obj);
      unsaved = true;
    }
  }

  function applyTextFontFamily() {
    wrapSelectionStyle(`font-family:${propFontFamily}`);
    const obj = objects.find(o => o.uid === textEditUid);
    if (obj) { obj.massFontFamily = propFontFamily; persistDbObject(obj); }
  }
  function applyTextFontSize() {
    wrapSelectionStyle(`font-size:${propFontSize * zoomFactor}px`);
    const obj = objects.find(o => o.uid === textEditUid);
    if (obj) { obj.massFontSize = propFontSize; persistDbObject(obj); }
  }
  function applyTextColor() { applyRichText('foreColor', objFill); }

  function resetFillStrokeDefaults() {
    objFill = 'none';
    objStroke = '#000000';
    objStrokeW = 1;
    objStrokeDash = '';
    syncObjFromProps();
  }

  function wrapSelectionStyle(style: string) {
    const el = textEditorEl();
    restoreTextSelection();
    const sel = window.getSelection();
    if (!el || !sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return;
    try {
      if (range.collapsed) {
        // Kein Text ausgewählt → Anker-Span mit ZWS, Cursor hinein
        const span = document.createElement('span');
        span.setAttribute('style', style);
        const anchor = document.createTextNode('​');
        span.appendChild(anchor);
        range.insertNode(span);
        range.setStart(anchor, 1);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        // Jeden Textknoten im Range einzeln einwickeln —
        // verhindert dass <div>-Grenzen einen einzelnen Span aufbrechen
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const nodes: Text[] = [];
        let n = walker.nextNode();
        while (n) { if (range.intersectsNode(n)) nodes.push(n as Text); n = walker.nextNode(); }
        for (const tn of nodes) {
          const nr = document.createRange();
          nr.selectNodeContents(tn);
          if (tn === range.startContainer) nr.setStart(tn, range.startOffset);
          if (tn === range.endContainer)   nr.setEnd(tn, range.endOffset);
          if (nr.collapsed) continue;
          const sp = document.createElement('span');
          sp.setAttribute('style', style);
          nr.surroundContents(sp);
        }
      }
      rememberTextSelection();
      const obj = objects.find(o => o.uid === textEditUid);
      if (obj?.type === 'TEXT') {
        obj.richHtml = sanitizeRichHtml(unscaleRichHtmlFonts(el.innerHTML, zoomFactor));
        persistDbObject(obj);
        unsaved = true;
      }
    } catch (err) {
      console.error('wrapSelectionStyle', err);
    }
  }

  function setupTextEdit(el: HTMLElement, obj: DrawnText) {
    el.innerHTML = sanitizeRichHtml(scaleRichHtmlFonts(obj.richHtml, zoomFactor));
    requestAnimationFrame(() => {
      el.focus({ preventScroll: true });
      let range: Range | null = null;
      if (pendingTextCaret) {
        const docWithCaret = document as Document & {
          caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
          caretRangeFromPoint?: (x: number, y: number) => Range | null;
        };
        const pos = docWithCaret.caretPositionFromPoint?.(pendingTextCaret.x, pendingTextCaret.y);
        if (pos && el.contains(pos.offsetNode)) {
          range = document.createRange();
          range.setStart(pos.offsetNode, pos.offset);
          range.collapse(true);
        } else {
          const hitRange = docWithCaret.caretRangeFromPoint?.(pendingTextCaret.x, pendingTextCaret.y);
          if (hitRange && el.contains(hitRange.commonAncestorContainer)) range = hitRange;
        }
        pendingTextCaret = null;
      }
      if (!range) {
        range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
      }
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      rememberTextSelection();
    });
    const onInput = () => {
      obj.richHtml = sanitizeRichHtml(unscaleRichHtmlFonts(el.innerHTML, zoomFactor));
      rememberTextSelection();
      persistDbObject(obj);
      unsaved = true;
    };
    const onBlur = (e: FocusEvent) => {
      obj.richHtml = sanitizeRichHtml(unscaleRichHtmlFonts(el.innerHTML, zoomFactor));
      persistDbObject(obj);
      const relatedTarget = e.relatedTarget as Element | null;
      const propsBar = document.querySelector('.props-bar');
      if (relatedTarget && propsBar?.contains(relatedTarget)) return;
      if (!el.innerText.trim()) {
        pushUndo();
        objects = objects.filter(o => o.uid !== obj.uid);
        deletePersistedObjects([obj]);
        clearSelection();
        textEditUid = null;
      }
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { el.blur(); return; }
      const m = e.metaKey || e.ctrlKey;
      if (m && e.key === 'b') { e.preventDefault(); applyRichText('bold'); return; }
      if (m && e.key === 'i') { e.preventDefault(); applyRichText('italic'); return; }
      if (m && e.key === 'u') { e.preventDefault(); applyRichText('underline'); return; }
      e.stopPropagation();
    };
    const onSelection = () => rememberTextSelection();
    el.addEventListener('input', onInput);
    el.addEventListener('blur', onBlur);
    el.addEventListener('keydown', onKeydown);
    el.addEventListener('keyup', onSelection);
    el.addEventListener('mouseup', onSelection);
    document.addEventListener('selectionchange', onSelection);
    return { destroy() {
      el.removeEventListener('input', onInput);
      el.removeEventListener('blur', onBlur);
      el.removeEventListener('keydown', onKeydown);
      el.removeEventListener('keyup', onSelection);
      el.removeEventListener('mouseup', onSelection);
      document.removeEventListener('selectionchange', onSelection);
    }};
  }
  function lineLengthRaw(o: DrawnLine): number { return Math.sqrt((o.x2-o.x1)**2+(o.y2-o.y1)**2); }
  function lineLength(o: DrawnLine): number { return Math.round(lineLengthRaw(o)); }
  function normalizeAngle(deg: number): number { return ((deg % 360) + 360) % 360; }
  function lineAngleDeg(o: DrawnLine): number {
    return normalizeAngle(Math.atan2(o.y2 - o.y1, o.x2 - o.x1) * 180 / Math.PI);
  }
  function lineMassText(lenPx: number): string { return pxToUnit(lenPx).toString(); }
  function lineBBox(x1:number,y1:number,x2:number,y2:number) {
    return { x: Math.min(x1,x2), y: Math.min(y1,y2), w: Math.max(1,Math.abs(x2-x1)), h: Math.max(1,Math.abs(y2-y1)) };
  }
  function arrowLen(strokeW: number): number { return Math.max(10, strokeW * 3.2); }
  function arrowHalf(strokeW: number): number { return Math.max(4, strokeW * 1.15); }
  function arrowInset(strokeW: number): number {
    const sw = Math.max(1, strokeW || 1);
    return Math.max(sw * 1.25, arrowLen(sw) * 0.36);
  }
  function arrowPolygon(tipX: number, tipY: number, tailX: number, tailY: number, strokeW: number): string {
    const dx = tipX - tailX, dy = tipY - tailY;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const px = -uy, py = ux;
    const al = arrowLen(strokeW);
    const ah = arrowHalf(strokeW);
    const bx = tipX - ux * al, by = tipY - uy * al;
    const nx = tipX - ux * (al * 0.62), ny = tipY - uy * (al * 0.62);
    return `${tipX},${tipY} ${bx + px * ah},${by + py * ah} ${nx},${ny} ${bx - px * ah},${by - py * ah}`;
  }
  function updateLineBBox(o: DrawnLine) {
    const bb = lineBBox(o.x1, o.y1, o.x2, o.y2);
    o.x = bb.x;
    o.y = bb.y;
    o.w = bb.w;
    o.h = bb.h;
  }
  function hitBoxStyle(obj: DrawnObject): string {
    const z = zoomFactor;
    if (obj.type === 'LINIE') {
      const len = Math.max(1, lineLengthRaw(obj));
      const pad = Math.max(14, (obj.strokeW || 1) * 4);
      const cx = (obj.x1 + obj.x2) / 2;
      const cy = (obj.y1 + obj.y2) / 2;
      return `left:${(cx - len / 2 - pad) * z}px;top:${(cy - pad) * z}px;width:${(len + pad * 2) * z}px;height:${pad * 2 * z}px;transform:rotate(${lineAngleDeg(obj)}deg);`;
    }
    return `left:${obj.x * z}px;top:${obj.y * z}px;width:${obj.w * z}px;height:${obj.h * z}px;transform:rotate(${obj.rotation}deg) skewX(${(obj as DrawnRect).shearX??0}deg) skewY(${(obj as DrawnRect).shearY??0}deg);`;
  }

  function roundRectPath(x: number, y: number, w: number, h: number,
    ol: number, or_: number, ul: number, ur: number,
    style: 'round' | 'chamfer' | 'concave' = 'round'): string {
    const maxR = Math.min(w, h) / 2;
    const tl = Math.min(ol, maxR), tr = Math.min(or_, maxR);
    const bl = Math.min(ul, maxR), br = Math.min(ur, maxR);
    function corner(ax: number, ay: number, cx: number, cy: number, bx: number, by: number): string {
      if (style === 'chamfer') return `L ${bx} ${by}`;
      if (style === 'concave') return `Q ${ax + (bx - cx)} ${ay + (by - cy)} ${bx} ${by}`;
      return `Q ${cx} ${cy} ${bx} ${by}`;
    }
    return `M ${x+tl} ${y} H ${x+w-tr} ` +
      corner(x+w-tr, y,   x+w,   y,   x+w,   y+tr) + ` V ${y+h-br} ` +
      corner(x+w, y+h-br, x+w,   y+h, x+w-br, y+h) + ` H ${x+bl} ` +
      corner(x+bl, y+h,   x,     y+h, x,     y+h-bl) + ` V ${y+tl} ` +
      corner(x, y+tl,     x,     y,   x+tl,   y) + ` Z`;
  }
  function pxLabel(mm: number | ''): string {
    if (mm === '' || mm === 0) return '';
    return `${mmToPx(mm as number)} px`;
  }

  // ── Page Setup Dialog ─────────────────────────────────────────────────────
  let pageSetupOpen  = $state(false);
  let pdfDialogOpen  = $state(false);
  let pdfSvgString   = $state('');
  let pdfPreviewUrl  = $state('');

  // Mehrfach einfügen
  let multiPasteOpen   = $state(false);
  let multiPasteSource = $state<DrawnObject[]>([]);
  let multiPasteCount  = $state(3);
  let multiPasteMode   = $state<'versatz'|'abstand'>('abstand');
  let multiPasteX      = $state(10);
  let multiPasteY      = $state(0);
  let pdfExporting   = $state(false);
  let pdfDpi         = $state(150);

  let setupBreite       = $state<number | ''>(297); // A4 Quer
  let setupHoehe        = $state<number | ''>(210);
  let setupZellBreite   = $state<number | ''>(10);
  let setupZellHoehe    = $state<number | ''>(10);
  let setupDicke            = $state<number | ''>(0.75);
  let setupFarbe            = $state('#cccccc');
  let setupTransparenz      = $state<number | ''>(50);
  let setupHintergrund      = $state('#ffffff');
  let setupHintergrundTransp = $state(false);
  let setupEinheit          = $state<'px'|'mm'|'cm'>('px');
  let setupGenauigkeit      = $state<1|2|3>(1);
  let setupSizeUnit         = $state<'mm'|'cm'|'px'>('cm');
  let setupTemplate         = $state('blank');
  let pageTemplate          = $state('blank');

  let setupBreitePx = $derived(setupBreite    !== '' ? mmToPx(setupBreite    as number) : 0);
  let setupHoehePx  = $derived(setupHoehe     !== '' ? mmToPx(setupHoehe     as number) : 0);
  let setupZellBPx  = $derived(setupZellBreite !== '' ? mmToPx(setupZellBreite as number) : 0);
  let setupZellHPx  = $derived(setupZellHoehe  !== '' ? mmToPx(setupZellHoehe  as number) : 0);
  let layoutLoaded = false;
  let saveLayoutTimer: ReturnType<typeof setTimeout> | null = null;

  // Preset formats
  const FORMATS = [
    { label: 'A2 Hoch',      w: 420, h: 594 },
    { label: 'A2 Quer',      w: 594, h: 420 },
    { label: 'A3 Hoch',      w: 297, h: 420 },
    { label: 'A3 Quer',      w: 420, h: 297 },
    { label: 'A4 Hoch',      w: 210, h: 297 },
    { label: 'A4 Quer',      w: 297, h: 210 },
    { label: 'A5 Hoch',      w: 148, h: 210 },
    { label: 'A5 Quer',      w: 210, h: 148 },
    { label: 'Visitenkarte', w: 85,  h: 55  },
    { label: 'Web 1440',     w: 1440, h: 900, px: true },
  ];

  const NEW_DOC_TEMPLATES = [
    { id: 'blank', label: 'Leer', title: 'Leer', cls: 'tpl-blank' },
    { id: 'gradient', label: 'Verlauf', title: 'Verlauf', cls: 'tpl-gradient' },
    { id: 'grid', label: 'Raster', title: 'Raster', cls: 'tpl-grid' },
    { id: 'graph', label: 'Millimeterpapier', title: 'Millimeter', cls: 'tpl-graph' },
    { id: 'notepad', label: 'Notizblock', title: 'Notizblock', cls: 'tpl-notepad' },
    { id: 'looseleaf', label: 'Loseblatt', title: 'Loseblatt', cls: 'tpl-looseleaf' },
    { id: 'lined', label: 'Linienpapier', title: 'Linien', cls: 'tpl-lined' },
    { id: 'blueprint', label: 'Blaupause', title: 'Blaupause', cls: 'tpl-blueprint' },
  ];

  function setupSizeDisplay(value: number | ''): number | '' {
    if (value === '') return '';
    if (setupSizeUnit === 'cm') return parseFloat(((value as number) / 10).toFixed(2));
    if (setupSizeUnit === 'px') return Math.round(mmToPx(value as number));
    return value as number;
  }

  function setSetupSize(which: 'w' | 'h', raw: string) {
    if (raw === '') {
      if (which === 'w') setupBreite = '';
      else setupHoehe = '';
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const mm = setupSizeUnit === 'cm' ? n * 10 : setupSizeUnit === 'px' ? n / MM_TO_PX : n;
    if (which === 'w') setupBreite = parseFloat(mm.toFixed(3));
    else setupHoehe = parseFloat(mm.toFixed(3));
  }

  const PAPER_TEMPLATES = new Set(['notepad', 'looseleaf', 'lined', 'graph', 'blueprint']);

  function chooseNewDocTemplate(id: string) {
    setupTemplate = id;
    setupHintergrundTransp = false;
    rasterEinblenden = !PAPER_TEMPLATES.has(id) && id !== 'blank' && id !== 'gradient';
    const mmTemplates = new Set(['blank', 'blueprint', 'grid', 'graph', 'lined']);
    setupSizeUnit = mmTemplates.has(id) ? 'mm' : 'cm';
    setupEinheit  = setupSizeUnit;
    if (id === 'blueprint') {
      setupHintergrund = '#0878b8';
      setupFarbe = '#35a9df';
      setupTransparenz = 45;
      setupZellBreite = 5;
      setupZellHoehe  = 5;
      rasterAusrichten = true;
    } else if (id === 'grid') {
      setupHintergrund = '#ffffff';
      setupFarbe = '#cccccc';
      setupTransparenz = 50;
      setupZellBreite = 5;
      setupZellHoehe  = 5;
      rasterAusrichten = true;
    } else if (id === 'gradient') {
      setupHintergrund = '#22242b';
      setupFarbe = '#73748e';
      setupHintergrundTransp = false;
    } else if (id === 'graph') {
      setupHintergrund = '#f1ffe8';
      setupFarbe = '#b8e6aa';
      setupTransparenz = 55;
      setupZellBreite = 1;
      setupZellHoehe  = 1;
      rasterAusrichten = true;
    } else if (id === 'notepad') {
      setupHintergrund = '#fffbb8';
      setupFarbe = '#8cc8dd';
      setupTransparenz = 70;
    } else {
      setupHintergrund = '#ffffff';
      setupFarbe = '#cccccc';
      setupTransparenz = 50;
    }
  }

  let vecstructiMenuOffen = $state(false);
  let appVisible             = $state(false);
  let canvasReady            = $state(false);
  let aboutDialogOpen        = $state(false);
  let formenSetupOpen        = $state(false);
  let formenSetupPfad        = $state('');
  let formenSetupStatus      = $state('');
  let dateiMenuOffen     = $state(false);
  let bearbeitenMenuOffen = $state(false);
  let anordnenMenuOffen  = $state(false);
  let ansichtMenuOffen   = $state(false);
  let hilfeMenuOffen     = $state(false);

  function closeAllMenus() { vecstructiMenuOffen = false; dateiMenuOffen = false; bearbeitenMenuOffen = false; anordnenMenuOffen = false; ansichtMenuOffen = false; hilfeMenuOffen = false; }

  // ── Werkzeug-Startwerte ───────────────────────────────────────────────────
  function setToolDefaults(id: string) {
    // gemeinsam für alle
    objShadow      = false;
    objShadowX     = 4; objShadowY = 4; objShadowBlur = 6; objShadowColor = '#000000';
    propShearX     = 0; propShearY = 0;
    objStrokeDash  = '';

    if (id === 'rect' || id === 'roundrect' || id === 'ellipse' || id === 'polygon' || id === 'frame' || id === 'circle' || id === 'image') {
      objFill        = 'none';
      objStroke      = '#000000';
      objStrokeW     = 1;
      propPolygonSides = 6;
      propFrameWidth = pxToUnit(8);
      objRadiusOL    = 0; objRadiusOR = 0; objRadiusUL = 0; objRadiusUR = 0;
      objCornerStyle = 'round';
    } else if (id === 'wall') {
      objFill        = 'none';
      objStroke      = '#222222';
      objStrokeW     = 2;
      propWallWidth  = 10;
      propWallHatchSpacing = 5;
      drawingWall = null;
    } else if (id === 'pencil' || id === 'arc') {
      objFill        = 'none';
      objStroke      = '#000000';
      objStrokeW     = 2;
      propGlaettung  = 0.5;
      propCurveClosed = false;
    } else if (id === 'brush') {
      objFill        = '#000000';
      propBrushSize  = 10;
      propBrushForm  = 'kreis';
    } else if (id === 'line') {
      objStroke      = '#000000';
      objStrokeW     = 1;
      objFill        = 'none';
      propArrowStart = 'none';
      propArrowEnd   = 'none';
      propIsMasslinie = false;
      propMassText   = '';
    } else if (id === 'text') {
      objFill        = '#000000';
      propFontFamily = "'Helvetica Neue', Helvetica, Arial, sans-serif";
      propFontSize   = 12;
      propFontBold   = false;
      propFontItalic = false;
      propTextAlign  = 'left';
      propLineHeight = 1.4;
    }
  }

  function applyEraser(eraserPts: {x:number;y:number}[], eraserEbene: string) {
    if (eraserPts.length < 2) return;
    // paper.js Setup (headless)
    const canvas = document.createElement('canvas');
    paper.setup(canvas);

    // Radierer-Form: Kreise an jedem Punkt + gedrehte Rechtecke zwischen Segmenten
    const halfW = eraserSize / 2;
    let eraserFill: paper.PathItem = new paper.Path.Circle(new paper.Point(eraserPts[0].x, eraserPts[0].y), halfW);
    for (let i = 1; i < eraserPts.length; i++) {
      const a = eraserPts[i - 1], b = eraserPts[i];
      // Kreis am Endpunkt
      const seg = new paper.Path.Circle(new paper.Point(b.x, b.y), halfW);
      // Gedrehtes Rechteck entlang des Segments (Senkrecht-Offset)
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len * halfW, ny = dx / len * halfW;
      const segRect = new paper.Path([
        new paper.Point(a.x + nx, a.y + ny),
        new paper.Point(b.x + nx, b.y + ny),
        new paper.Point(b.x - nx, b.y - ny),
        new paper.Point(a.x - nx, a.y - ny)
      ]);
      segRect.closed = true;
      eraserFill = eraserFill.unite(seg) as paper.PathItem;
      eraserFill = eraserFill.unite(segRect) as paper.PathItem;
    }

    pushUndo();
    const newObjects: DrawnObject[] = [];
    const removedObjects: DrawnObject[] = [];
    const createdObjects: DrawnObject[] = [];
    let changed = false;
    for (const obj of objects) {
      if (obj.ebene !== eraserEbene || !canOperateOn(obj)) {
        newObjects.push(obj);
        continue;
      }
      if (obj.type === 'PFAD' && obj.isWall) {
        newObjects.push(obj);
        continue;
      }
      // Objekt-SVG-Pfad erstellen
      let objPathStr = '';
      if (obj.type === 'RECHTECK') {
        objPathStr = obj.isImageFrame
          ? rectMaskPath(obj)
          : `M${obj.x},${obj.y} L${obj.x+obj.w},${obj.y} L${obj.x+obj.w},${obj.y+obj.h} L${obj.x},${obj.y+obj.h} Z`;
      } else if (obj.type === 'PFAD') {
        objPathStr = obj.d;
      } else {
        newObjects.push(obj); continue;
      }
      const objPaper = new paper.Path(objPathStr);
      if (!objPaper.bounds.intersects(eraserFill.bounds)) {
        newObjects.push(obj); continue;
      }
      // Subtraktion
      const result = objPaper.subtract(eraserFill);
      if (!result || !result.pathData) { newObjects.push(obj); continue; }
      // Jedes zusammenhängende Teilstück als eigenes DrawnPath-Objekt
      const isCompound = (result as any).children && (result as any).className === 'CompoundPath';
      const pieces: paper.PathItem[] = isCompound
        ? ((result as paper.CompoundPath).children as paper.Path[]).filter(p => (p as paper.Path).segments?.length >= 2 && Math.abs((p as paper.Path).area) > 4)
        : [result as paper.Path];
      if (pieces.length === 0) { newObjects.push(obj); continue; }
      changed = true;
      removedObjects.push(obj);
      if (obj.type === 'RECHTECK' && obj.isImageFrame) {
        for (const p of pieces) {
          const svgD = p.pathData;
          if (!svgD || svgD.length < 3) continue;
          const b = p.bounds;
          const x = Math.round(b.x), y = Math.round(b.y);
          const w = Math.max(1, Math.round(b.width)), h = Math.max(1, Math.round(b.height));
          const sc = obj.imageScale ?? 1;
          const oldIw = obj.imageRenderW ?? obj.w * sc;
          const oldIh = obj.imageRenderH ?? obj.h * sc;
          const oldIx = obj.x + obj.w / 2 - oldIw / 2 + (obj.imageOffsetX ?? 0);
          const oldIy = obj.y + obj.h / 2 - oldIh / 2 + (obj.imageOffsetY ?? 0);
          const newOffsetX = oldIx - (x + w / 2 - oldIw / 2);
          const newOffsetY = oldIy - (y + h / 2 - oldIh / 2);
          const piece: DrawnRect = {
            ...obj,
            uid: Math.random().toString(36).slice(2, 9),
            x, y, w, h,
            stroke: 'none',
            strokeW: 0,
            strokeDash: '',
            shadowEnabled: false,
            imageScale: sc,
            imageRenderW: oldIw,
            imageRenderH: oldIh,
            imageOffsetX: newOffsetX,
            imageOffsetY: newOffsetY,
            imageMaskD: svgD,
          };
          newObjects.push(piece);
          createdObjects.push(piece);
        }
        continue;
      }
      for (const p of pieces) {
        const svgD = p.pathData;
        if (!svgD || svgD.length < 3) continue;
        const b = p.bounds;
        const x = Math.round(b.x), y = Math.round(b.y);
        const w = Math.max(1, Math.round(b.width)), h = Math.max(1, Math.round(b.height));
        const piece: DrawnPath = {
          type: 'PFAD', x, y, w, h, ox: x, oy: y,
          points: [], d: svgD,
          glaettung: 0,
          stroke: (obj as any).stroke || '#000000',
          strokeW: (obj as any).strokeW || 1,
          strokeDash: (obj as any).strokeDash || '',
          fill: obj.fill || 'none',
          uid: Math.random().toString(36).slice(2, 9),
          ebene: obj.ebene, rotation: 0,
          radiusOL: 0, radiusOR: 0, radiusUL: 0, radiusUR: 0,
          groupId: obj.groupId,
        };
        newObjects.push(piece);
        createdObjects.push(piece);
      }
    }
    if (changed) {
      deletePersistedObjects(removedObjects);
      objects = newObjects;
      persistDbObjects(createdObjects);
      clearSelection();
      unsaved = true;
    }
  }

  function arrangeStep(dir: 1|-1) {
    selectedObjs = activeLayerObjects(selectedObjs);
    if (!selectedObjs.length) return;
    pushUndo();
    const arr = [...objects];
    const idxs = selectedObjs.map(o => arr.indexOf(o)).filter(i => i >= 0).sort((a,b) => dir > 0 ? b-a : a-b);
    for (const i of idxs) {
      const j = i + dir;
      if (j < 0 || j >= arr.length) continue;
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    objects = arr; unsaved = true;
    persistDbObjects(objects);
  }
  function arrangeToFront() {
    selectedObjs = activeLayerObjects(selectedObjs);
    if (!selectedObjs.length) return;
    pushUndo();
    const sel = new Set(selectedObjs);
    objects = [...objects.filter(o => !sel.has(o)), ...objects.filter(o => sel.has(o))];
    unsaved = true;
    persistDbObjects(objects);
  }
  function arrangeToBack() {
    selectedObjs = activeLayerObjects(selectedObjs);
    if (!selectedObjs.length) return;
    pushUndo();
    const sel = new Set(selectedObjs);
    objects = [...objects.filter(o => sel.has(o)), ...objects.filter(o => !sel.has(o))];
    unsaved = true;
    persistDbObjects(objects);
  }
  function arrangeGroup() {
    selectedObjs = activeLayerObjects(selectedObjs);
    if (selectedObjs.length < 2) return;
    pushUndo();
    const gid = `grp_${Math.random().toString(36).slice(2, 9)}`;
    selectedObjs.forEach(o => o.groupId = gid);
    persistDbObjects(selectedObjs);
    unsaved = true;
  }
  function arrangeUngroup() {
    selectedObjs = activeLayerObjects(selectedObjs);
    if (!selectedObjs.length) return;
    pushUndo();
    selectedObjs.forEach(o => delete o.groupId);
    persistDbObjects(selectedObjs);
    unsaved = true;
  }
  function alignSelected(mode: 'left'|'center'|'right'|'top'|'middle'|'bottom') {
    selectedObjs = activeLayerObjects(selectedObjs);
    if (selectedObjs.length < 2) return;
    pushUndo();
    const left = Math.min(...selectedObjs.map(o => o.x));
    const top = Math.min(...selectedObjs.map(o => o.y));
    const right = Math.max(...selectedObjs.map(o => o.x + o.w));
    const bottom = Math.max(...selectedObjs.map(o => o.y + o.h));
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    selectedObjs.forEach(o => {
      if (mode === 'left') o.x = left;
      else if (mode === 'center') o.x = Math.round(cx - o.w / 2);
      else if (mode === 'right') o.x = right - o.w;
      else if (mode === 'top') o.y = top;
      else if (mode === 'middle') o.y = Math.round(cy - o.h / 2);
      else if (mode === 'bottom') o.y = bottom - o.h;
    });
    objects = [...objects];
    persistDbObjects(selectedObjs);
    unsaved = true;
  }
  function distributeSelected(axis: 'x'|'y') {
    selectedObjs = activeLayerObjects(selectedObjs);
    if (selectedObjs.length < 3) return;
    pushUndo();
    const sorted = [...selectedObjs].sort((a, b) => axis === 'x' ? a.x - b.x : a.y - b.y);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const start = axis === 'x' ? first.x : first.y;
    const end = axis === 'x' ? last.x : last.y;
    const step = (end - start) / (sorted.length - 1);
    sorted.forEach((o, i) => {
      if (axis === 'x') o.x = Math.round(start + step * i);
      else o.y = Math.round(start + step * i);
    });
    objects = [...objects];
    persistDbObjects(selectedObjs);
    unsaved = true;
  }
  function arrangeProtect() {
    selectedObjs = activeLayerObjects(selectedObjs);
    if (!selectedObjs.length) return;
    pushUndo();
    selectedObjs.forEach(o => o.gesperrt = true);
    persistDbObjects(selectedObjs);
    unsaved = true;
  }
  function arrangeUnprotect() {
    selectedObjs = activeLayerObjects(selectedObjs);
    if (!selectedObjs.length) return;
    pushUndo();
    selectedObjs.forEach(o => o.gesperrt = false);
    persistDbObjects(selectedObjs);
    unsaved = true;
  }

  function toggleObjectProtected(obj: DrawnObject) {
    if (obj.ebene !== aktiveEbene) return;
    const layer = ebenen.find(e => e.name === obj.ebene);
    if (layer?.gesperrt) return;
    pushUndo();
    obj.gesperrt = !obj.gesperrt;
    objects = [...objects];
    persistDbObject(obj);
    unsaved = true;
  }

  // ── Undo / Redo ──────────────────────────────────────────────────────────
  let undoStack = $state<DrawnObject[][]>([]);
  let redoStack = $state<DrawnObject[][]>([]);

  function pushUndo() {
    undoStack.push(cloneObjectsSnapshot(objects));
    if (undoStack.length > 50) undoStack.shift();
    redoStack = [];
  }
  function undo() {
    if (!undoStack.length) return;
    const current = cloneObjectsSnapshot(objects);
    redoStack.push(current);
    const restored = undoStack.pop()!;
    syncDbToObjects(restored, current);
    objects = cloneObjectsSnapshot(restored);
    clearSelection(); unsaved = true;
  }
  function redo() {
    if (!redoStack.length) return;
    const current = cloneObjectsSnapshot(objects);
    undoStack.push(current);
    const restored = redoStack.pop()!;
    syncDbToObjects(restored, current);
    objects = cloneObjectsSnapshot(restored);
    clearSelection(); unsaved = true;
  }

  // ── Clipboard ────────────────────────────────────────────────────────────
  let clipboard = $state<DrawnObject[]>([]);

  function copyForClipboard(obj: DrawnObject): DrawnObject {
    return cloneObjectSnapshot(obj);
  }

  function cloneObjectWithOffset(obj: DrawnObject, dx: number, dy: number, groupMap: Map<string, string>): DrawnObject {
    const clone = copyForClipboard(obj);
    clone.uid = Math.random().toString(36).slice(2, 9);
    clone.x = Math.round(obj.x + dx);
    clone.y = Math.round(obj.y + dy);
    if (obj.groupId) {
      if (!groupMap.has(obj.groupId)) groupMap.set(obj.groupId, `grp_${Math.random().toString(36).slice(2, 9)}`);
      clone.groupId = groupMap.get(obj.groupId);
    } else {
      delete clone.groupId;
    }
    if (clone.type === 'LINIE') {
      const source = obj as DrawnLine;
      clone.x1 = Math.round(source.x1 + dx);
      clone.y1 = Math.round(source.y1 + dy);
      clone.x2 = Math.round(source.x2 + dx);
      clone.y2 = Math.round(source.y2 + dy);
      updateLineBBox(clone);
    }
    if (clone.type === 'PFAD') {
      const source = obj as DrawnPath;
      clone.points = source.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }));
      clone.ox = Math.round(source.ox + dx);
      clone.oy = Math.round(source.oy + dy);
      clone.d = clone.isBrush
        ? brushPathD(clone.points, clone.brushSize ?? propBrushSize, clone.brushForm ?? propBrushForm, clone.glaettung)
        : clone.isWall
        ? wallPathD(clone.points, clone.wallWidth ?? mmToPx(propWallWidth), clone.wallHatchSpacing ?? mmToPx(propWallHatchSpacing), clone.wallHatchType ?? propWallHatchType, clone.curveClosed)
        : clone.isCurve
        ? curvePathD(clone.points, clone.curveClosed)
        : smoothPts(clone.points, clone.glaettung);
      if (clone.isBrush) normalizeBrushOrigin(clone);
    }
    if (clone.type === 'RECHTECK' && (obj as DrawnRect).imageMaskD) {
      clone.imageMaskD = transformPathD((obj as DrawnRect).imageMaskD!, dx, dy);
    }
    return clone;
  }

  function editCut() {
    selectedObjs = activeLayerObjects(selectedObjs);
    if (!selectedObjs.length) return;
    clipboard = selectedObjs.map(copyForClipboard);
    pushUndo();
    deletePersistedObjects(selectedObjs);
    objects = objects.filter(o => !selectedObjs.includes(o));
    clearSelection(); unsaved = true;
  }
  function editCopy() {
    selectedObjs = activeLayerObjects(selectedObjs);
    if (!selectedObjs.length) return;
    clipboard = selectedObjs.map(copyForClipboard);
  }
  function editPaste() {
    if (!clipboard.length) return;
    pushUndo();
    const groupMap = new Map<string, string>();
    const newObjs = clipboard.map(o => {
      const clone = cloneObjectWithOffset(o, 20, 20, groupMap);
      clone.ebene = aktiveEbene;
      return clone;
    });
    objects = [...objects, ...newObjs];
    persistDbObjects(newObjs);
    selectedObjs = objects.slice(-newObjs.length);
    selectedObj = newObjs.length === 1 ? selectedObjs[0] : null;
    unsaved = true;
  }
  function openMultiPaste() {
    selectedObjs = activeLayerObjects(selectedObjs);
    if (!selectedObjs.length) return;
    multiPasteSource = selectedObjs.map(copyForClipboard);
    multiPasteOpen = true;
  }
  function doMultiPaste() {
    if (!multiPasteSource.length) return;
    const srcs = multiPasteSource;
    // Bounding Box der Gruppe
    const gx1 = Math.min(...srcs.map(o => o.x));
    const gy1 = Math.min(...srcs.map(o => o.y));
    const gx2 = Math.max(...srcs.map(o => o.x + o.w));
    const gy2 = Math.max(...srcs.map(o => o.y + o.h));
    const gw = gx2 - gx1, gh = gy2 - gy1;
    pushUndo();
    const newObjs: DrawnObject[] = [];
    for (let i = 1; i <= multiPasteCount; i++) {
      let dx: number, dy: number;
      if (multiPasteMode === 'versatz') {
        dx = i * multiPasteX;
        dy = i * multiPasteY;
      } else {
        dx = multiPasteX === 0 ? 0 : i * (gw + multiPasteX);
        dy = multiPasteY === 0 ? 0 : i * (gh + multiPasteY);
      }
      // Prüfen ob Gruppe noch auf der Seite liegt
      if (gx1 + dx < 0 || gy1 + dy < 0 || gx2 + dx > canvasW || gy2 + dy > canvasH) break;
      const groupMap = new Map<string, string>();
      for (const src of srcs) {
        const clone = cloneObjectWithOffset(src, dx, dy, groupMap);
        clone.ebene = aktiveEbene;
        newObjs.push(clone);
      }
    }
    objects = [...objects, ...newObjs];
    persistDbObjects(newObjs);
    selectedObjs = objects.slice(-newObjs.length);
    selectedObj = null;
    unsaved = true;
    multiPasteOpen = false;
  }

  function selectAll() {
    if (!objects.length) return;
    selectedObjs = activeLayerObjects(objects);
    selectedObj  = null; // kein Einzelobjekt → kein Eigenschaftenpanel
  }

  // ── App State ─────────────────────────────────────────────────────────────
  // A4 Quer: 297 × 210 mm bei 96 dpi
  let canvasW       = $state(Math.round(297 * 96 / 25.4)); // 1123 px
  let canvasH       = $state(Math.round(210 * 96 / 25.4)); //  794 px
  let currentFile   = $state<string | null>(null);
  let unsaved       = $state(false);

  // ── Datei öffnen / speichern ──────────────────────────────────────────────
  async function clearWorkingDb() {
    const keepFile = currentFile;
    setDbPath(DB_PATH);
    await clearDocumentDb();
    await assertDocumentDbEmpty();
    await closeDb();
    await clearCurrentAssetDir();
    currentFile = keepFile;
  }

  async function resetToEmptyWorkingDocument(showSetupDialog: boolean) {
    await clearWorkingDb().catch(err => console.error('SQLite clear failed', err));
    objects     = [];
    selectedObj = null;
    selectedObjs = [];
    textEditUid = null;
    currentFile = null;
    unsaved     = false;
    canvasW     = 0;
    canvasH     = 0;
    ebenen = [
      { name: 'Ebene 1', sichtbar: true, gesperrt: false, opacity: 100 },
      { name: 'Raster',  sichtbar: true, gesperrt: false, opacity: 100 },
    ];
    aktiveEbene = 'Ebene 1';
    setupBreite       = 297;
    setupHoehe        = 210;
    setupZellBreite   = 10;
    setupZellHoehe    = 10;
    setupDicke        = 0.75;
    rasterDicke       = 0.75;
    setupFarbe        = '#cccccc';
    setupTransparenz  = 50;
    setupHintergrund  = '#ffffff';
    setupHintergrundTransp = false;
    setupEinheit      = 'px';
    setupGenauigkeit  = 1;
    if (showSetupDialog) pageSetupOpen = true;
  }

  async function confirmCloseWithSave(): Promise<boolean> {
    if (!objects.length && !unsaved) return true;
    const result = await dialogMessage(
      'Das interne Arbeitsdokument enthält noch Objekte. Vor dem Beenden speichern?',
      {
        title: 'Vecstructi beenden',
        kind: 'warning',
        buttons: {
          yes: 'Speichern',
          no: 'Ignorieren und beenden',
          cancel: 'Abbrechen',
        },
      },
    );
    if (result === 'Abbrechen' || result === 'Cancel') return false;
    if (result === 'Speichern' || result === 'Yes') {
      const before = currentFile;
      await fileSave();
      if (!before && !currentFile) return false;
    }
    return true;
  }

  async function fileNew() {
    await resetToEmptyWorkingDocument(true);
    persistDocumentLayoutSoon();
    canvasReady = true;
  }

  async function fileClose() {
    await resetToEmptyWorkingDocument(false);
    canvasReady = false;
  }

  function addImportedObjects(imported: DrawnObject[]) {
    if (!imported.length) return;
    pushUndo();
    objects = [...objects, ...imported];
    // Proxied Referenzen aus objects nehmen, nicht die originalen aus imported
    const proxied = objects.slice(objects.length - imported.length);
    selectedObjs = proxied;
    selectedObj = imported.length === 1 ? proxied[0] : null;
    persistDbObjects(imported);
    unsaved = true;
  }

  async function reloadSavedShapes() {
    savedShapes = await loadShapesFromFile();
  }

  async function doSaveShape() {
    try {
      const name = shapeSaveName.trim();
      if (!name) return;
      const toSave = selectedObjs.length > 0 ? [...selectedObjs] : [...objects];
      if (!toSave.length) return;

      const xs = toSave.map(o => o.x);
      const ys = toSave.map(o => o.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const maxX = Math.max(...toSave.map(o => o.x + o.w));
      const maxY = Math.max(...toSave.map(o => o.y + o.h));
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const bbW = maxX - minX;
      const bbH = maxY - minY;

      // Plain-Objekte erzeugen (Svelte-Proxy entfernen)
      const normalized = toSave.map(o => ({ ...(o as object), x: (o.x - cx), y: (o.y - cy) }));

      // SVG-Preview generieren
      let previewSvg = '';
      try {
        const pvW = 48, pvH = 24, pad = 2;
        const scaleP = Math.min((pvW - pad * 2) / Math.max(bbW, 1), (pvH - pad * 2) / Math.max(bbH, 1));
        const tpX = (x: number) => (x - minX) * scaleP + pad + ((pvW - pad * 2) - bbW * scaleP) / 2;
        const tpY = (y: number) => (y - minY) * scaleP + pad + ((pvH - pad * 2) - bbH * scaleP) / 2;
        let parts = '';
        for (const o of toSave) {
          const r = o as any;
          const fill = r.fill || 'none';
          const stroke = r.stroke || '#888';
          const sw = Math.max(0.5, (r.strokeW ?? 1) * scaleP * 0.4);
          const a = `fill="${fill}" stroke="${stroke}" stroke-width="${sw}"`;
          const x = tpX(o.x), y = tpY(o.y), w = o.w * scaleP, h = o.h * scaleP;
          if (o.type === 'RECHTECK') {
            if (r.isImageFrame && r.imageUrl) {
              parts += `<image href="${r.imageUrl}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"/>`;
            } else if (r.shape === 'ellipse') {
              parts += `<ellipse cx="${x+w/2}" cy="${y+h/2}" rx="${w/2}" ry="${h/2}" ${a}/>`;
            } else {
              const rx = Math.min((r.radiusOL ?? 0) * scaleP, w/2, h/2);
              parts += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" ${a}/>`;
            }
          } else if (o.type === 'PFAD') {
            parts += `<g transform="translate(${tpX(r.ox ?? o.x)},${tpY(r.oy ?? o.y)}) scale(${scaleP})"><path d="${r.d}" ${a} stroke-linejoin="round" stroke-linecap="round"/></g>`;
          } else if (o.type === 'LINIE') {
            parts += `<line x1="${tpX(r.x1)}" y1="${tpY(r.y1)}" x2="${tpX(r.x2)}" y2="${tpY(r.y2)}" stroke="${stroke}" stroke-width="${sw}"/>`;
          } else if (o.type === 'TEXT') {
            parts += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#334" stroke="#556" stroke-width="0.5"/>`;
          }
        }
        previewSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pvW} ${pvH}" width="${pvW}" height="${pvH}">${parts}</svg>`;
      } catch { /* Preview-Fehler ignorieren */ }

      const newShape: SavedShape = {
        id: Date.now(),
        name,
        gruppe: shapeSaveGruppe.trim(),
        objects_json: JSON.stringify(normalized),
        preview_svg: previewSvg,
      };
      await saveShapesToFile([...savedShapes, newShape]);
      await reloadSavedShapes();
      shapeSaveDialogOpen = false;
      shapeSaveName = '';
      shapeSaveGruppe = '';
    } catch (e) {
      console.error('doSaveShape Fehler:', e);
    }
  }

  function insertSavedShape(shape: { id: number; name: string; gruppe: string; objects_json: string }) {
    let parsed: DrawnObject[];
    try {
      parsed = JSON.parse(shape.objects_json) as DrawnObject[];
    } catch {
      return;
    }
    if (!parsed.length) return;

    // Zentriert auf Leinwandmitte einsetzen
    const targetX = canvasW / 2;
    const targetY = canvasH / 2;

    // Bei mehreren Objekten immer eine neue Gruppe erzwingen
    const newGroupId = parsed.length > 1 ? Math.random().toString(36).slice(2, 9) : undefined;
    const inserted = parsed.map(o => ({
      ...o,
      uid: Math.random().toString(36).slice(2, 9),
      x: Math.round(o.x + targetX),
      y: Math.round(o.y + targetY),
      ebene: aktiveEbene,
      groupId: newGroupId,
    })) as DrawnObject[];

    addImportedObjects(inserted);
  }

  async function doDeleteShape(id: number) {
    await saveShapesToFile(savedShapes.filter(s => s.id !== id));
    await reloadSavedShapes();
  }

  function savedShapeGroups(): Array<{ name: string; items: typeof savedShapes }> {
    const map = new Map<string, typeof savedShapes>();
    for (const s of savedShapes) {
      const g = s.gruppe || '–';
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(s);
    }
    return Array.from(map.entries()).map(([name, items]) => ({ name, items }));
  }

  function pathObjectFromD(d: string, bounds: { x: number; y: number; width: number; height: number }, fill = 'none', stroke = '#000000', strokeW = 1): DrawnPath {
    const x = Math.round(bounds.x);
    const y = Math.round(bounds.y);
    const w = Math.max(1, Math.round(bounds.width));
    const h = Math.max(1, Math.round(bounds.height));
    return {
      type: 'PFAD',
      x, y, w, h,
      ox: x,
      oy: y,
      points: [],
      d,
      glaettung: 0,
      fill,
      stroke,
      strokeW,
      strokeDash: '',
      uid: Math.random().toString(36).slice(2, 9),
      ebene: aktiveEbene,
      rotation: 0,
      radiusOL: 0,
      radiusOR: 0,
      radiusUL: 0,
      radiusUR: 0,
      libraryName: 'SVG-Import',
    };
  }

  function svgCssColor(color: any, fallback: string): string {
    return color ? color.toCSS(true) : fallback;
  }

  function svgViewBox(svgText: string): { x: number; y: number; w: number; h: number } | null {
    const m = svgText.match(/viewBox\s*=\s*["']\s*([-\d.]+)[,\s]+([-\d.]+)[,\s]+([-\d.]+)[,\s]+([-\d.]+)\s*["']/i);
    if (!m) return null;
    const [, x, y, w, h] = m.map(Number);
    return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { x, y, w, h } : null;
  }

  function svgBoundsVisible(b: { x: number; y: number; width: number; height: number }): boolean {
    return b.x + b.width >= -1 && b.y + b.height >= -1 && b.x <= canvasW + 1 && b.y <= canvasH + 1;
  }

  function svgTextRichHtml(item: any, fontSize: number, fill: string): string {
    const family = String(item.fontFamily || DEFAULT_TEXT_FONT).replace(/"/g, '&quot;');
    const weight = item.fontWeight ? `font-weight:${String(item.fontWeight)};` : '';
    const style = item.fontStyle ? `font-style:${String(item.fontStyle)};` : '';
    return `<span style="font-family:${family};font-size:${fontSize}px;color:${fill};${weight}${style}">${escXml(String(item.content))}</span>`;
  }

  function importSvgAsVectors(svgText: string): DrawnObject[] {
    const p = getPaper();
    p.project.clear();
    try {
      const root = p.project.importSVG(svgText, { expandShapes: true, insert: false } as any) as any;
      if (!root) return [];
      const vb = svgViewBox(svgText);
      const rootBounds = vb
        ? { x: vb.x, y: vb.y, width: vb.w, height: vb.h }
        : root.bounds;
      if (!rootBounds || rootBounds.width <= 0 || rootBounds.height <= 0) return [];
      const margin = 0;
      const targetW = Math.max(1, canvasW - margin * 2);
      const targetH = Math.max(1, canvasH - margin * 2);
      const scale = Math.min(targetW / rootBounds.width, targetH / rootBounds.height);
      const offsetX = margin + (targetW - rootBounds.width * scale) / 2;
      const offsetY = margin + (targetH - rootBounds.height * scale) / 2;
      root.translate(new p.Point(-rootBounds.x, -rootBounds.y));
      root.scale(scale, new p.Point(0, 0));
      root.translate(new p.Point(offsetX, offsetY));
      const out: DrawnObject[] = [];
      const walk = (item: any) => {
        if (!item) return;
        if (item.children?.length) {
          item.children.forEach(walk);
          return;
        }
        if (item.className === 'PointText' && item.content) {
          const b = item.bounds;
          const fontSize = Math.max(1, Number(item.fontSize ?? DEFAULT_TEXT_SIZE) * scale);
          const fill = svgCssColor(item.fillColor, '#000000');
          out.push({
            type: 'TEXT',
            x: Math.round(b?.x ?? 40),
            y: Math.round(b?.y ?? 40),
            w: Math.max(40, Math.round(b?.width ?? String(item.content).length * fontSize * 0.6)),
            h: Math.max(fontSize * 1.25, Math.round(b?.height ?? fontSize * 1.25)),
            richHtml: svgTextRichHtml(item, fontSize, fill),
            textAlign: 'left',
            fill,
            lineHeight: 1,
            uid: Math.random().toString(36).slice(2, 9),
            ebene: aktiveEbene,
            rotation: 0,
            stroke: '',
            strokeW: 0,
            strokeDash: '',
            radiusOL: 0,
            radiusOR: 0,
            radiusUL: 0,
            radiusUR: 0,
            libraryName: 'SVG-Import',
          });
          return;
        }
        const d = item.pathData;
        const b = item.bounds;
        if (!d || !b || (b.width <= 0 && b.height <= 0)) return;
        if (!svgBoundsVisible(b)) return;
        const strokeWidth = Number(item.strokeWidth ?? 1);
        out.push(pathObjectFromD(
          d,
          { x: b.x, y: b.y, width: b.width, height: b.height },
          'none',
          svgCssColor(item.strokeColor, 'none'),
          Math.max(0.25, strokeWidth * scale),
        ));
      };
      walk(root);
      return out;
    } finally {
      p.project.clear();
    }
  }

  async function importSvgFile(path: string) {
    const svgText = new TextDecoder('utf-8').decode(await readFile(path));
    const uid = Math.random().toString(36).slice(2, 9);
    const vb = svgViewBox(svgText);
    const svgW = vb?.w ?? canvasW;
    const svgH = vb?.h ?? canvasH;
    const scale = Math.min(canvasW / svgW, canvasH / svgH);
    const w = Math.max(1, Math.round(svgW * scale));
    const h = Math.max(1, Math.round(svgH * scale));
    const imported = await importImageAsset(path, uid);
    addImportedObjects([{
      type: 'RECHTECK',
      x: Math.round((canvasW - w) / 2),
      y: Math.round((canvasH - h) / 2),
      w,
      h,
      fill: 'none',
      stroke: 'none',
      strokeW: 0,
      strokeDash: '',
      radiusOL: 0,
      radiusOR: 0,
      radiusUL: 0,
      radiusUR: 0,
      rotation: 0,
      ebene: aktiveEbene,
      uid,
      isImageFrame: true,
      imageShape: 'rect',
      imageFile: imported.fileName,
      imageUrl: imported.url,
      imageScale: 1,
      imageOffsetX: 0,
      imageOffsetY: 0,
      libraryName: 'SVG-Import',
    }]);
  }

  async function importTxtFile(path: string) {
    const text = new TextDecoder('utf-8').decode(await readFile(path));
    const lines = text.split(/\r?\n/);
    const maxLen = Math.max(20, ...lines.map(line => line.length));
    const obj: DrawnText = {
      type: 'TEXT',
      x: 40,
      y: 40,
      w: Math.min(520, Math.max(220, maxLen * 7)),
      h: Math.min(520, Math.max(80, lines.length * DEFAULT_TEXT_SIZE * 1.5 + 24)),
      richHtml: escXml(text).replace(/\r?\n/g, '<br>'),
      textAlign: 'left',
      fill: objFill || '#000000',
      lineHeight: 1.4,
      uid: Math.random().toString(36).slice(2, 9),
      ebene: aktiveEbene,
      rotation: 0,
      stroke: '',
      strokeW: 0,
      strokeDash: '',
      radiusOL: 0,
      radiusOR: 0,
      radiusUL: 0,
      radiusUR: 0,
      libraryName: 'TXT-Import',
    };
    addImportedObjects([obj]);
  }

  async function fileImport() {
    if (canvasW <= 0 || canvasH <= 0) return;
    const path = await dialogOpen({
      title: 'Importieren',
      filters: [
        { name: 'SVG oder Text', extensions: ['svg', 'txt'] },
        { name: 'SVG', extensions: ['svg'] },
        { name: 'Text', extensions: ['txt'] },
      ],
      multiple: false,
    });
    if (!path || typeof path !== 'string') return;
    try {
      const ext = path.split('.').pop()?.toLowerCase();
      if (ext === 'svg') await importSvgFile(path);
      else if (ext === 'txt') await importTxtFile(path);
      else throw new Error('Dieses Format kann hier nicht importiert werden.');
    } catch (e) {
      console.error(e);
      await dialogMessage(`Datei konnte nicht importiert werden:\n${e instanceof Error ? e.message : String(e)}`, {
        title: 'Importieren',
        kind: 'error',
      });
    }
  }

  function renderTextSvg(obj: DrawnText, indent: string): string[] {
    const i = indent;
    const rot = obj.rotation ? ` transform="rotate(${obj.rotation} ${obj.x+obj.w/2} ${obj.y+obj.h/2})"` : '';
    const html = sanitizeRichHtml(obj.richHtml);
    const shadow = obj.shadowEnabled ? `text-shadow:${obj.shadowX ?? 4}px ${obj.shadowY ?? 4}px ${obj.shadowBlur ?? 6}px ${obj.shadowColor ?? '#000000'};` : '';
    const style = `font-family:${DEFAULT_TEXT_FONT};font-size:${DEFAULT_TEXT_SIZE}px;text-align:${obj.textAlign};line-height:${obj.lineHeight};color:${obj.fill||'#000000'};${shadow}width:100%;height:100%;overflow:hidden;white-space:pre-wrap;word-wrap:break-word;box-sizing:border-box;margin:0;padding:0;`;
    return [
      `${i}<foreignObject x="${obj.x}" y="${obj.y}" width="${obj.w}" height="${obj.h}"${rot} data-type="TEXT" data-uid="${obj.uid}" data-textx="${obj.x}" data-texty="${obj.y}" data-textw="${obj.w}" data-texth="${obj.h}" data-textalign="${obj.textAlign}" data-lineheight="${obj.lineHeight}" data-fill="${obj.fill||'#000000'}">`,
      `${i}  <div xmlns="http://www.w3.org/1999/xhtml" style="${style}">${html}</div>`,
      `${i}</foreignObject>`,
    ];
  }

  function fontSizeFromRichHtml(html: string): number {
    if (!html) return DEFAULT_TEXT_SIZE;
    const m = html.match(/font-size\s*:\s*([0-9.]+)px/i);
    return m ? parseFloat(m[1]) : DEFAULT_TEXT_SIZE;
  }

function scaleRichHtmlFonts(html: string, factor: number): string {
    if (!html || factor === 1) return html;
    return html.replace(/font-size\s*:\s*([0-9.]+)px/gi, (_, n) => `font-size:${parseFloat(n) * factor}px`);
  }

  function unscaleRichHtmlFonts(html: string, factor: number): string {
    if (!html || factor === 1) return html;
    return html.replace(/font-size\s*:\s*([0-9.]+)px/gi, (_, n) => `font-size:${Math.round(parseFloat(n) / factor * 100) / 100}px`);
  }

  function textPlainFromHtml(html: string): string {
    const div = document.createElement('div');
    div.innerHTML = sanitizeRichHtml(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/div>|<\/p>/gi, '\n');
    return div.textContent ?? '';
  }

  function escXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function parseRichHtmlLines(html: string, baseColor: string): Array<Array<{text: string; color: string}>> {
    const div = document.createElement('div');
    div.innerHTML = sanitizeRichHtml(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/div>|<\/p>/gi, '\n');
    const segs: Array<{text: string; color: string}> = [];
    function walk(node: Node, color: string) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent ?? '';
        if (t) segs.push({ text: t, color });
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        const c = el.style.color || color;
        for (const child of Array.from(el.childNodes)) walk(child, c);
      }
    }
    walk(div, baseColor);
    const lines: Array<Array<{text: string; color: string}>> = [[]];
    for (const seg of segs) {
      const parts = seg.text.split('\n');
      lines[lines.length - 1].push({ text: parts[0], color: seg.color });
      for (let k = 1; k < parts.length; k++) lines.push([{ text: parts[k], color: seg.color }]);
    }
    return lines;
  }

  function safeTextColor(fill: string | undefined): string {
    if (!fill || fill === 'none' || fill === 'transparent' || parseGradientValue(fill)) return '#000000';
    return fill;
  }

  function wrapPdfTextLine(segs: Array<{text: string; color: string}>, maxWidth: number, fontSize: number): Array<Array<{text: string; color: string}>> {
    const charW = fontSize * 0.55;
    const maxChars = Math.max(1, Math.floor(maxWidth / charW));
    // Flatten to word tokens
    type Token = { word: string; color: string };
    const tokens: Token[] = [];
    for (const seg of segs) {
      const parts = seg.text.split(' ');
      parts.forEach((w, i) => {
        if (i > 0) tokens.push({ word: ' ', color: seg.color });
        if (w) tokens.push({ word: w, color: seg.color });
      });
    }
    const lines: Array<Array<{text: string; color: string}>> = [[]];
    let len = 0;
    for (const { word, color } of tokens) {
      if (word === ' ') {
        if (len > 0) { const l = lines[lines.length-1]; if (l.length && l[l.length-1].color === color) l[l.length-1].text += ' '; else l.push({ text: ' ', color }); len++; }
        continue;
      }
      if (len + word.length > maxChars && len > 0) { lines.push([]); len = 0; }
      const l = lines[lines.length-1];
      if (l.length && l[l.length-1].color === color) l[l.length-1].text += word; else l.push({ text: word, color });
      len += word.length;
    }
    return lines;
  }

  function renderPdfTextSvg(obj: DrawnText, indent: string): string[] {
    const i = indent;
    const o = obj as any;
    const fontSize = o.massFontSize ?? fontSizeFromRichHtml(obj.richHtml) ?? DEFAULT_TEXT_SIZE;
    const fontFamily = o.massFontFamily ?? DEFAULT_TEXT_FONT;
    const fontWeight = o.massFontWeight ?? 'normal';
    const fontStyle  = o.massFontStyle  ?? 'normal';
    const lineHeightPx = fontSize * (obj.lineHeight || 1.4);
    const anchor = obj.textAlign === 'center' ? 'middle' : obj.textAlign === 'right' ? 'end' : 'start';
    const tx = obj.textAlign === 'center' ? obj.x + obj.w / 2 : obj.textAlign === 'right' ? obj.x + obj.w : obj.x;
    const rot = obj.rotation ? ` transform="rotate(${obj.rotation} ${obj.x+obj.w/2} ${obj.y+obj.h/2})"` : '';
    const baseColor = safeTextColor(obj.fill);
    const rawLines = parseRichHtmlLines(obj.richHtml, baseColor);
    // Word-wrap every raw line to fit obj.w
    const htmlLines: Array<Array<{text: string; color: string}>> = [];
    for (const segs of rawLines) htmlLines.push(...wrapPdfTextLine(segs, obj.w, fontSize));
    const weightAttr = fontWeight === 'bold' ? ' font-weight="bold"' : '';
    const styleAttr  = fontStyle  === 'italic' ? ' font-style="italic"' : '';
    const out = [`${i}<text x="${tx}" y="${obj.y + fontSize}" font-family="${escXml(fontFamily)}" font-size="${fontSize}" fill="${baseColor}" text-anchor="${anchor}"${weightAttr}${styleAttr}${rot}>`];
    htmlLines.forEach((segs, idx) => {
      if (idx * lineHeightPx > obj.h) return;
      const dy = idx === 0 ? 0 : lineHeightPx;
      if (segs.every(s => s.color === baseColor)) {
        out.push(`${i}  <tspan x="${tx}" dy="${dy}">${escXml(segs.map(s => s.text).join(''))}</tspan>`);
      } else {
        out.push(`${i}  <tspan x="${tx}" dy="${dy}">${segs.map(s => s.color === baseColor ? escXml(s.text) : `<tspan fill="${s.color}">${escXml(s.text)}</tspan>`).join('')}</tspan>`);
      }
    });
    out.push(`${i}</text>`);
    return out;
  }

  function renderLineSvg(obj: DrawnLine, indent: string): string[] {
    const out: string[] = [];
    const i = indent;
    const da = obj.strokeDash ? ` stroke-dasharray="${obj.strokeDash}"` : '';
    const len = Math.sqrt((obj.x2-obj.x1)**2+(obj.y2-obj.y1)**2);
    const ux = len > 0 ? (obj.x2-obj.x1)/len : 1;
    const uy = len > 0 ? (obj.y2-obj.y1)/len : 0;
    const mText = obj.massText ?? '';
    const textPos = obj.massTextPos ?? 'ueber';
    const massFontSize = obj.massFontSize ?? 11;
    const massFontFamily = obj.massFontFamily ?? "'Helvetica Neue', Helvetica, Arial, sans-serif";
    const massFontWeight = obj.massFontWeight ?? 'normal';
    const massFontStyle = obj.massFontStyle ?? 'normal';
    const textGap = mText ? mText.length * 7 + 12 : 0;
    const mx = (obj.x1+obj.x2)/2, my = (obj.y1+obj.y2)/2;
    const ang = Math.atan2(obj.y2-obj.y1, obj.x2-obj.x1) * 180 / Math.PI;
    const sc = obj.stroke || '#000';
    const inset = arrowInset(obj.strokeW || 1);
    const lx1 = obj.arrowStart === 'arrow' ? obj.x1 + ux * inset : obj.x1;
    const ly1 = obj.arrowStart === 'arrow' ? obj.y1 + uy * inset : obj.y1;
    const lx2 = obj.arrowEnd === 'arrow' ? obj.x2 - ux * inset : obj.x2;
    const ly2 = obj.arrowEnd === 'arrow' ? obj.y2 - uy * inset : obj.y2;
    // Marker defs
    if (obj.arrowStart === 'dot' || obj.arrowEnd === 'dot')
      out.push(`${i}<defs><marker id="dot-${obj.uid}" markerWidth="8" markerHeight="8" refX="3" refY="3" orient="auto"><circle cx="3" cy="3" r="2.5" fill="${sc}"/></marker></defs>`);
    if (obj.arrowStart === 'tick' || obj.arrowEnd === 'tick')
      out.push(`${i}<defs><marker id="tick-${obj.uid}" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto"><line x1="3" y1="9" x2="7" y2="1" stroke="${sc}" stroke-width="1.5"/></marker></defs>`);
    const ms = obj.arrowStart==='dot'?` marker-start="url(#dot-${obj.uid})"`:obj.arrowStart==='tick'?` marker-start="url(#tick-${obj.uid})"`:''
    const me = obj.arrowEnd  ==='dot'?` marker-end="url(#dot-${obj.uid})"`:obj.arrowEnd==='tick'?` marker-end="url(#tick-${obj.uid})"`:''
    // Linie(n)
    if (obj.isMasslinie && textPos === 'in' && mText && textGap < len) {
      const bx1 = mx - ux*textGap/2, by1 = my - uy*textGap/2;
      const bx2 = mx + ux*textGap/2, by2 = my + uy*textGap/2;
      out.push(`${i}<line x1="${lx1}" y1="${ly1}" x2="${bx1.toFixed(2)}" y2="${by1.toFixed(2)}" stroke="${sc}" stroke-width="${obj.strokeW}"${da}${ms} data-type="LINIE" data-uid="${obj.uid}" data-arrowstart="${obj.arrowStart}" data-arrowend="${obj.arrowEnd}" data-masslinie="${obj.isMasslinie}" data-masstext="${mText}" data-masstextpos="${textPos}" data-mass-fontsize="${massFontSize}" data-mass-fontfamily="${massFontFamily}" data-mass-fontweight="${massFontWeight}" data-mass-fontstyle="${massFontStyle}"/>`);
      out.push(`${i}<line x1="${bx2.toFixed(2)}" y1="${by2.toFixed(2)}" x2="${lx2}" y2="${ly2}" stroke="${sc}" stroke-width="${obj.strokeW}"${da}${me}/>`);
    } else {
      out.push(`${i}<line x1="${lx1}" y1="${ly1}" x2="${lx2}" y2="${ly2}" stroke="${sc}" stroke-width="${obj.strokeW}"${da}${ms}${me} data-type="LINIE" data-uid="${obj.uid}" data-arrowstart="${obj.arrowStart}" data-arrowend="${obj.arrowEnd}" data-masslinie="${obj.isMasslinie}" data-masstext="${mText}" data-masstextpos="${textPos}" data-mass-fontsize="${massFontSize}" data-mass-fontfamily="${massFontFamily}" data-mass-fontweight="${massFontWeight}" data-mass-fontstyle="${massFontStyle}"/>`);
    }
    if (obj.arrowStart === 'arrow') out.push(`${i}<polygon points="${arrowPolygon(obj.x1, obj.y1, obj.x2, obj.y2, obj.strokeW || 1)}" fill="${sc}"/>`);
    if (obj.arrowEnd === 'arrow') out.push(`${i}<polygon points="${arrowPolygon(obj.x2, obj.y2, obj.x1, obj.y1, obj.strokeW || 1)}" fill="${sc}"/>`);
    if (obj.isMasslinie) {
      const perpX = len > 0 ? -(obj.y2-obj.y1)/len*10 : 0;
      const perpY = len > 0 ?  (obj.x2-obj.x1)/len*10 : 0;
      out.push(`${i}<line x1="${obj.x1}" y1="${obj.y1}" x2="${(obj.x1+perpX*1.5).toFixed(2)}" y2="${(obj.y1+perpY*1.5).toFixed(2)}" stroke="${sc}" stroke-width="1" opacity=".6"/>`);
      out.push(`${i}<line x1="${obj.x2}" y1="${obj.y2}" x2="${(obj.x2+perpX*1.5).toFixed(2)}" y2="${(obj.y2+perpY*1.5).toFixed(2)}" stroke="${sc}" stroke-width="1" opacity=".6"/>`);
      if (mText) {
        if (textPos === 'in')
          out.push(`${i}<text x="${mx}" y="${my}" text-anchor="middle" dominant-baseline="middle" font-family="${massFontFamily}" font-size="${massFontSize}" font-weight="${massFontWeight}" font-style="${massFontStyle}" fill="${sc}" transform="rotate(${ang.toFixed(2)},${mx},${my})">${mText}</text>`);
        else
          out.push(`${i}<text x="${mx}" y="${my}" text-anchor="middle" dominant-baseline="auto" font-family="${massFontFamily}" font-size="${massFontSize}" font-weight="${massFontWeight}" font-style="${massFontStyle}" fill="${sc}" transform="rotate(${ang.toFixed(2)},${mx},${my}) translate(0,-6)">${mText}</text>`);
      }
    }
    return out;
  }

  function buildSVG(): string {
    const unt  = rasterUnterteilung !== '' && (rasterUnterteilung as number) > 0 ? rasterUnterteilung as number : 1;
    const rXPx = rasterXAbstand !== '' ? mmToPx((rasterXAbstand as number) / unt) : 0;
    const rYPx = rasterYAbstand !== '' ? mmToPx((rasterYAbstand as number) / unt) : 0;
    const rOpacity = rasterTransparenz / 100;
    const thick = clampRasterDicke(rasterDicke);
    const bg = setupHintergrundTransp ? 'none' : setupHintergrund;

    const lines: string[] = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}"`,
      `  data-setup-breite="${setupBreite}" data-setup-hoehe="${setupHoehe}"`,
      `  data-einheit="${einheit}" data-genauigkeit="${genauigkeit}"`,
      `  data-raster-x="${rasterXAbstand}" data-raster-y="${rasterYAbstand}"`,
      `  data-raster-unt="${rasterUnterteilung}" data-raster-farbe="${rasterFarbe}"`,
      `  data-raster-transp="${rasterTransparenz}" data-raster-dicke="${thick}"`,
      `  data-hg="${setupHintergrund}" data-hg-transp="${setupHintergrundTransp}">`,
    ];

    const randLPx = rasterRandL !== '' ? mmToPx(rasterRandL as number) : 0;
    const randRPx = rasterRandR !== '' ? mmToPx(rasterRandR as number) : 0;
    const randOPx = rasterRandO !== '' ? mmToPx(rasterRandO as number) : 0;
    const randUPx = rasterRandU !== '' ? mmToPx(rasterRandU as number) : 0;

    if (rXPx > 0 && rYPx > 0) {
      const px = rasterRandVersatz ? ` x="${randLPx}" y="${randOPx}"` : '';
      lines.push(
        `  <defs>`,
        `    <pattern id="grid" width="${rXPx}" height="${rYPx}" patternUnits="userSpaceOnUse"${px}>`,
        `      <path d="M ${rXPx} 0 L 0 0 0 ${rYPx}" fill="none" stroke="${rasterFarbe}" stroke-width="${thick}" opacity="${rOpacity}"/>`,
        `    </pattern>`,
        `  </defs>`,
      );
    }

    lines.push(`  <rect width="${canvasW}" height="${canvasH}" fill="${bg}"/>`);
    const tplSvg = templateBgSvg(pageTemplate, canvasW, canvasH);
    if (tplSvg) lines.push(`  ${tplSvg}`);
    if (rXPx > 0 && rYPx > 0 && rasterEinblenden) {
      if (rasterUeberRand) {
        lines.push(`  <rect width="${canvasW}" height="${canvasH}" fill="url(#grid)" data-layer="Raster"/>`);
      } else {
        const gw = Math.max(0, canvasW - randLPx - randRPx);
        const gh = Math.max(0, canvasH - randOPx - randUPx);
        lines.push(`  <rect x="${randLPx}" y="${randOPx}" width="${gw}" height="${gh}" fill="url(#grid)" data-layer="Raster"/>`);
      }
    }

    for (const e of ebenen.filter(eb => eb.name !== 'Raster')) {
      const opVal = e.opacity ?? 100;
      lines.push(`  <g data-layer="${e.name}" data-opacity="${opVal}"${!e.sichtbar ? ' visibility="hidden"' : ''}${opVal < 100 ? ` opacity="${opVal / 100}"` : ''}>`);
      for (const obj of objects.filter(o => o.ebene === e.name)) {
        if (obj.type === 'RECHTECK') {
          const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
          const hasTf = obj.rotation || obj.shearX || obj.shearY;
          const rot = hasTf ? ` transform="translate(${cx},${cy}) rotate(${obj.rotation ?? 0}) skewX(${obj.shearX ?? 0}) skewY(${obj.shearY ?? 0}) translate(${-cx},${-cy})"` : '';
          const da  = obj.strokeDash ? ` stroke-dasharray="${obj.strokeDash}"` : '';
          const imgAttrs = obj.isImageFrame
            ? ` data-imageframe="true" data-imageshape="${obj.imageShape ?? 'rect'}" data-imagescale="${obj.imageScale ?? 1}" data-imageoffsetx="${obj.imageOffsetX ?? 0}" data-imageoffsety="${obj.imageOffsetY ?? 0}" data-uid="${obj.uid}"${obj.imageFile ? ` data-imagefile="${obj.imageFile}"` : ''}`
            : ` data-uid="${obj.uid}"`;
          const shAttrs = obj.shadowEnabled
            ? ` data-shadow="true" data-shadow-x="${obj.shadowX ?? 4}" data-shadow-y="${obj.shadowY ?? 4}" data-shadow-blur="${obj.shadowBlur ?? 6}" data-shadow-color="${obj.shadowColor ?? '#000000'}"`
            : '';
          const shapeAttr = obj.shape && obj.shape !== 'rect' ? ` data-shape="${obj.shape}"` : '';
          const frameAttr = obj.shape === 'frame' ? ` data-frame-width="${obj.frameWidth ?? 8}"` : '';
          const radAttrs = ` data-rol="${obj.radiusOL}" data-ror="${obj.radiusOR}" data-rul="${obj.radiusUL}" data-rur="${obj.radiusUR}"${shapeAttr}${frameAttr}${obj.cornerStyle && obj.cornerStyle !== 'round' ? ` data-corner="${obj.cornerStyle}"` : ''}${obj.shearX ? ` data-shearx="${obj.shearX}"` : ''}${obj.shearY ? ` data-sheary="${obj.shearY}"` : ''}`;
          const allSame = obj.radiusOL === obj.radiusOR && obj.radiusOL === obj.radiusUL && obj.radiusOL === obj.radiusUR;
          const hasR = obj.radiusOL || obj.radiusOR || obj.radiusUL || obj.radiusUR;
          if (!obj.isImageFrame && obj.shape === 'frame') {
            lines.push(`    <path d="${framePath(obj.x, obj.y, obj.w, obj.h, obj.frameWidth ?? 8)}" fill="none" stroke="${obj.stroke || '#000000'}" stroke-width="${obj.strokeW || 1}"${da}${rot}${radAttrs}${shAttrs}/>`);
          } else if (!obj.isImageFrame && obj.shape === 'ellipse') {
            lines.push(`    <ellipse cx="${obj.x + obj.w / 2}" cy="${obj.y + obj.h / 2}" rx="${obj.w / 2}" ry="${obj.h / 2}" fill="${obj.fill || 'none'}" stroke="${obj.stroke || 'none'}" stroke-width="${obj.strokeW}"${da}${rot}${radAttrs}${shAttrs}/>`);
          } else if (!obj.isImageFrame && obj.shape === 'polygon') {
            lines.push(`    <polygon points="${polygonPoints(obj.x, obj.y, obj.w, obj.h, obj.polygonSides ?? 6)}" fill="${obj.fill || 'none'}" stroke="${obj.stroke || 'none'}" stroke-width="${obj.strokeW}"${da}${rot}${radAttrs}${shAttrs}/>`);
          } else if (!obj.isImageFrame && hasR && !allSame) {
            const d = roundRectPath(obj.x, obj.y, obj.w, obj.h, obj.radiusOL, obj.radiusOR, obj.radiusUL, obj.radiusUR);
            lines.push(`    <path d="${d}" fill="${obj.fill || 'none'}" stroke="${obj.stroke || 'none'}" stroke-width="${obj.strokeW}"${da}${rot}${radAttrs}${shAttrs}/>`);
          } else {
            const rx = obj.radiusOL ? ` rx="${obj.radiusOL}"` : '';
            lines.push(`    <rect x="${obj.x}" y="${obj.y}" width="${obj.w}" height="${obj.h}" fill="${obj.fill || 'none'}" stroke="${obj.stroke || 'none'}" stroke-width="${obj.strokeW}"${da}${rx}${rot}${imgAttrs}${radAttrs}${shAttrs}/>`);
          }
        } else if (obj.type === 'LINIE') {
          lines.push(...renderLineSvg(obj, '    '));
        } else if (obj.type === 'TEXT') {
          lines.push(...renderTextSvg(obj, '    '));
        } else if (obj.type === 'PFAD') {
          const da  = obj.strokeDash ? ` stroke-dasharray="${obj.strokeDash}"` : '';
          const rot = obj.rotation ? ` transform="rotate(${obj.rotation} ${obj.x+obj.w/2} ${obj.y+obj.h/2})"` : '';
          const sh  = obj.shadowEnabled ? ` data-shadow="true" data-shadow-x="${obj.shadowX??4}" data-shadow-y="${obj.shadowY??4}" data-shadow-blur="${obj.shadowBlur??6}" data-shadow-color="${obj.shadowColor??'#000000'}"` : '';
          const ptsJson = JSON.stringify(obj.points).replace(/"/g, '&quot;');
          if (obj.isWall) {
            const wp = wallRenderParts(obj.points, obj.wallWidth ?? mmToPx(10), obj.wallHatchSpacing ?? mmToPx(5), obj.wallHatchType ?? 'diagonal', obj.curveClosed);
            const attrs = ` data-type="PFAD" data-uid="${obj.uid}" data-glaettung="${obj.glaettung??0.4}" data-ox="${obj.ox??obj.x}" data-oy="${obj.oy??obj.y}" data-wall="true" data-wall-width="${obj.wallWidth??mmToPx(10)}" data-wall-hatch="${obj.wallHatchSpacing??mmToPx(5)}" data-wall-hatch-type="${obj.wallHatchType??'diagonal'}" data-wall-hatch-color="${obj.wallHatchColor??'#444444'}"${sh} data-pts="${ptsJson}"`;
            lines.push(`    <path d="${wp.lines}" fill="none" stroke="${obj.stroke||'#222222'}" stroke-width="${obj.strokeW||1}" stroke-linecap="square" stroke-linejoin="miter"${rot}${attrs}/>`);
            if (wp.hatches) lines.push(`    <path d="${wp.hatches}" fill="none" stroke="${obj.wallHatchColor||'#444444'}" stroke-width="1" stroke-linecap="butt"${rot}/>`);
          } else {
            lines.push(`    <path d="${obj.d}" fill="${obj.fill||'none'}" stroke="${obj.stroke||'#000000'}" stroke-width="${obj.strokeW||1}"${da} stroke-linecap="round" stroke-linejoin="round"${rot} data-type="PFAD" data-uid="${obj.uid}" data-glaettung="${obj.glaettung??0.4}" data-ox="${obj.ox??obj.x}" data-oy="${obj.oy??obj.y}"${obj.isCurve ? ' data-curve="true"' : ''}${obj.curveClosed ? ' data-curve-closed="true"' : ''}${sh} data-pts="${ptsJson}"/>`);
          }
        }
      }
      lines.push(`  </g>`);
    }

    lines.push(`</svg>`);
    return lines.join('\n');
  }

  function loadFromSVG(svgText: string) {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svgEl = doc.querySelector('svg');
    if (!svgEl) return;

    // Dimensionen: px-Wert direkt, sonst aus viewBox lesen
    const rawW = svgEl.getAttribute('width') ?? '';
    const rawH = svgEl.getAttribute('height') ?? '';
    const vb   = (svgEl.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    canvasW = /^[\d.]+$/.test(rawW) ? parseInt(rawW) : (vb[2] ?? 0);
    canvasH = /^[\d.]+$/.test(rawH) ? parseInt(rawH) : (vb[3] ?? 0);

    // Kein VecStructUI-Format → als unveränderliches SVG-Bild einbetten
    const isNativeFormat = svgEl.hasAttribute('data-setup-breite') || doc.querySelector('g[data-layer]');
    if (!isNativeFormat && canvasW > 0 && canvasH > 0) {
      const b64 = btoa(unescape(encodeURIComponent(svgText)));
      const dataUrl = `data:image/svg+xml;base64,${b64}`;
      const uid = Math.random().toString(36).slice(2, 9);
      setupBreite = Math.round(canvasW / MM_TO_PX);
      setupHoehe  = Math.round(canvasH / MM_TO_PX);
      einheit = 'px'; genauigkeit = 1;
      setupHintergrund = '#ffffff'; setupHintergrundTransp = false;
      ebenen = [
        { name: 'Ebene 1', sichtbar: true, gesperrt: false, opacity: 100 },
        { name: 'Raster',  sichtbar: true, gesperrt: false, opacity: 100 },
      ];
      aktiveEbene = 'Ebene 1';
      objects = [{
        type: 'RECHTECK', x: 0, y: 0, w: canvasW, h: canvasH,
        fill: 'none', stroke: 'none', strokeW: 0, strokeDash: '',
        radiusOL: 0, radiusOR: 0, radiusUL: 0, radiusUR: 0,
        rotation: 0, ebene: 'Ebene 1',
        isImageFrame: true, imageShape: 'rect',
        imageUrl: dataUrl, imageScale: 1, imageOffsetX: 0, imageOffsetY: 0,
        uid,
      }];
      selectedObj = null;
      unsaved = false;
      return;
    }

    const sb      = parseFloat(svgEl.getAttribute('data-setup-breite') ?? '0');
    const sh      = parseFloat(svgEl.getAttribute('data-setup-hoehe')  ?? '0');
    setupBreite   = sb || Math.round(canvasW / MM_TO_PX);
    setupHoehe    = sh || Math.round(canvasH / MM_TO_PX);
    einheit       = (svgEl.getAttribute('data-einheit')     as 'px'|'mm'|'cm') ?? 'px';
    genauigkeit   = (parseInt(svgEl.getAttribute('data-genauigkeit') ?? '1') as 1|2|3);
    rasterXAbstand    = parseFloat(svgEl.getAttribute('data-raster-x')     ?? '10');
    rasterYAbstand    = parseFloat(svgEl.getAttribute('data-raster-y')     ?? '10');
    rasterUnterteilung = parseFloat(svgEl.getAttribute('data-raster-unt')  ?? '1');
    rasterFarbe       = svgEl.getAttribute('data-raster-farbe')   ?? '#cccccc';
    rasterTransparenz = parseFloat(svgEl.getAttribute('data-raster-transp') ?? '50');
    rasterDicke       = clampRasterDicke(parseFloat(svgEl.getAttribute('data-raster-dicke') ?? '0.75'));
    setupDicke        = rasterDicke;
    setupHintergrund  = svgEl.getAttribute('data-hg')              ?? '#ffffff';
    setupHintergrundTransp = svgEl.getAttribute('data-hg-transp') === 'true';

    const groups = doc.querySelectorAll('g[data-layer]');
    const newEbenen: Ebene[] = [];
    const newObjects: DrawnObject[] = [];

    groups.forEach(g => {
      const name   = g.getAttribute('data-layer') ?? 'Ebene 1';
      const hidden = g.getAttribute('visibility') === 'hidden';
      const opAttr = g.getAttribute('data-opacity');
      newEbenen.push({ name, sichtbar: !hidden, gesperrt: false, opacity: opAttr ? parseFloat(opAttr) : 100 });
      g.querySelectorAll('rect').forEach(r => {
        newObjects.push({
          type: 'RECHTECK',
          x: parseFloat(r.getAttribute('x') ?? '0'),
          y: parseFloat(r.getAttribute('y') ?? '0'),
          w: parseFloat(r.getAttribute('width') ?? '0'),
          h: parseFloat(r.getAttribute('height') ?? '0'),
          fill:    r.getAttribute('fill')         ?? '#ffffff',
          stroke:  r.getAttribute('stroke')       ?? '',
          strokeW:    parseFloat(r.getAttribute('stroke-width') ?? '1'),
          strokeDash: r.getAttribute('stroke-dasharray') ?? '',
          cornerStyle: (r.getAttribute('data-corner') as 'round'|'chamfer'|'concave') || 'round',
          radiusOL: parseFloat(r.getAttribute('data-rol') ?? r.getAttribute('rx') ?? '0'),
          radiusOR: parseFloat(r.getAttribute('data-ror') ?? r.getAttribute('rx') ?? '0'),
          radiusUL: parseFloat(r.getAttribute('data-rul') ?? r.getAttribute('rx') ?? '0'),
          radiusUR: parseFloat(r.getAttribute('data-rur') ?? r.getAttribute('rx') ?? '0'),
          shearX: parseFloat(r.getAttribute('data-shearx') ?? '0') || undefined,
          shearY: parseFloat(r.getAttribute('data-sheary') ?? '0') || undefined,
          rotation: 0,
          ebene: name,
          uid: r.getAttribute('data-uid') ?? Math.random().toString(36).slice(2, 9),
          isImageFrame: r.getAttribute('data-imageframe') === 'true' || undefined,
          imageShape: (r.getAttribute('data-imageshape') as 'rect'|'circle') || undefined,
          imageFile:   r.getAttribute('data-imagefile') || undefined,
          imageUrl:    r.getAttribute('data-imageurl') || undefined,
          imageScale:  parseFloat(r.getAttribute('data-imagescale') ?? '1'),
          imageOffsetX: parseFloat(r.getAttribute('data-imageoffsetx') ?? '0'),
          imageOffsetY: parseFloat(r.getAttribute('data-imageoffsety') ?? '0'),
          shadowEnabled: r.getAttribute('data-shadow') === 'true' || undefined,
          shadowX:    parseFloat(r.getAttribute('data-shadow-x')    ?? '4'),
          shadowY:    parseFloat(r.getAttribute('data-shadow-y')    ?? '4'),
          shadowBlur: parseFloat(r.getAttribute('data-shadow-blur') ?? '6'),
          shadowColor: r.getAttribute('data-shadow-color') ?? '#000000',
        });
      });
      g.querySelectorAll('foreignObject[data-type="TEXT"]').forEach(t => {
        const div = t.querySelector('div');
        newObjects.push({
          type: 'TEXT',
          x: parseFloat(t.getAttribute('data-textx') ?? '0'),
          y: parseFloat(t.getAttribute('data-texty') ?? '0'),
          w: parseFloat(t.getAttribute('data-textw') ?? '200'),
          h: parseFloat(t.getAttribute('data-texth') ?? '30'),
          richHtml: div?.innerHTML ?? '',
          textAlign:  (t.getAttribute('data-textalign')  as 'left'|'center'|'right') || 'left',
          lineHeight: parseFloat(t.getAttribute('data-lineheight') ?? '1.4'),
          fill: t.getAttribute('data-fill') ?? '#000000',
          uid: t.getAttribute('data-uid') ?? Math.random().toString(36).slice(2, 9),
          ebene: name, rotation: 0,
          stroke: '', strokeW: 0, strokeDash: '',
          radiusOL: 0, radiusOR: 0, radiusUL: 0, radiusUR: 0,
        });
      });
      g.querySelectorAll('path[data-type="PFAD"]').forEach(p => {
        const d = p.getAttribute('d') ?? '';
        let pts: {x:number;y:number}[] = [];
        try { pts = JSON.parse(p.getAttribute('data-pts')?.replace(/&quot;/g, '"') ?? '[]'); } catch {}
        const xs = pts.map(q => q.x), ys = pts.map(q => q.y);
        const x = xs.length ? Math.round(Math.min(...xs)) : 0;
        const y = ys.length ? Math.round(Math.min(...ys)) : 0;
        const w = xs.length ? Math.max(1, Math.round(Math.max(...xs) - x)) : 1;
        const h = ys.length ? Math.max(1, Math.round(Math.max(...ys) - y)) : 1;
        const pShadow = p.getAttribute('data-shadow') === 'true';
        newObjects.push({
          type: 'PFAD', x, y, w, h,
          ox: parseFloat(p.getAttribute('data-ox') ?? String(x)),
          oy: parseFloat(p.getAttribute('data-oy') ?? String(y)),
          points: pts, d,
          glaettung: parseFloat(p.getAttribute('data-glaettung') ?? '0.5'),
          isWall: p.getAttribute('data-wall') === 'true' || undefined,
          wallWidth: parseFloat(p.getAttribute('data-wall-width') ?? '12'),
          wallHatchSpacing: parseFloat(p.getAttribute('data-wall-hatch') ?? '16'),
          wallHatchType: (p.getAttribute('data-wall-hatch-type') as DrawnPath['wallHatchType']) || undefined,
          wallHatchColor: p.getAttribute('data-wall-hatch-color') || undefined,
          isCurve: p.getAttribute('data-curve') === 'true' || undefined,
          curveClosed: p.getAttribute('data-curve-closed') === 'true' || undefined,
          stroke: p.getAttribute('stroke') ?? '#000000',
          strokeW: parseFloat(p.getAttribute('stroke-width') ?? '1'),
          strokeDash: p.getAttribute('stroke-dasharray') ?? '',
          fill: p.getAttribute('fill') ?? 'none',
          uid: p.getAttribute('data-uid') ?? Math.random().toString(36).slice(2, 9),
          ebene: name, rotation: 0,
          radiusOL: 0, radiusOR: 0, radiusUL: 0, radiusUR: 0,
          shadowEnabled: pShadow || undefined,
          shadowX: pShadow ? parseFloat(p.getAttribute('data-shadow-x') ?? '4') : undefined,
          shadowY: pShadow ? parseFloat(p.getAttribute('data-shadow-y') ?? '4') : undefined,
          shadowBlur: pShadow ? parseFloat(p.getAttribute('data-shadow-blur') ?? '6') : undefined,
          shadowColor: pShadow ? (p.getAttribute('data-shadow-color') ?? '#000000') : undefined,
        });
      });
      g.querySelectorAll('line[data-type="LINIE"]').forEach(l => {
        const x1 = parseFloat(l.getAttribute('x1') ?? '0');
        const y1 = parseFloat(l.getAttribute('y1') ?? '0');
        const x2 = parseFloat(l.getAttribute('x2') ?? '0');
        const y2 = parseFloat(l.getAttribute('y2') ?? '0');
        const bb = lineBBox(x1, y1, x2, y2);
        newObjects.push({
          type: 'LINIE', x1, y1, x2, y2, ...bb, fill: '',
          stroke: l.getAttribute('stroke') ?? '#000000',
          strokeW: parseFloat(l.getAttribute('stroke-width') ?? '1'),
          strokeDash: l.getAttribute('stroke-dasharray') ?? '',
          arrowStart: (l.getAttribute('data-arrowstart') as 'none'|'arrow'|'dot') || 'none',
          arrowEnd:   (l.getAttribute('data-arrowend')   as 'none'|'arrow'|'dot') || 'none',
          isMasslinie: l.getAttribute('data-masslinie') === 'true',
          massText:    l.getAttribute('data-masstext') || undefined,
          massTextPos: (l.getAttribute('data-masstextpos') as 'ueber'|'in') || 'ueber',
          massFontSize: parseFloat(l.getAttribute('data-mass-fontsize') ?? '11'),
          massFontFamily: l.getAttribute('data-mass-fontfamily') ?? "'Helvetica Neue', Helvetica, Arial, sans-serif",
          massFontWeight: (l.getAttribute('data-mass-fontweight') as 'normal'|'bold') || 'normal',
          massFontStyle: (l.getAttribute('data-mass-fontstyle') as 'normal'|'italic') || 'normal',
          uid: l.getAttribute('data-uid') ?? Math.random().toString(36).slice(2, 9),
          ebene: name, rotation: 0,
          radiusOL: 0, radiusOR: 0, radiusUL: 0, radiusUR: 0,
        });
      });
    });

    if (newEbenen.length === 0) newEbenen.push({ name: 'Ebene 1', sichtbar: true, gesperrt: false, opacity: 100 });
    const rasterEb = ebenen.find(e => e.name === 'Raster') ?? { name: 'Raster', sichtbar: true, gesperrt: false, opacity: 100 };
    ebenen = [...newEbenen, rasterEb];
    aktiveEbene = newEbenen[0].name;
    objects = newObjects;
    void resolveImageAssets();
    void fitDocumentWindowToPage();
  }

  async function fileOpen() {
    const path = await dialogOpen({
      title: 'Vecstructi öffnen',
      filters: [{ name: 'Vecstructi', extensions: ['vecstructi'] }],
      multiple: false,
    });
    if (!path || typeof path !== 'string') return;
    try {
      layoutLoaded = false;
      objects = [];
      selectedObj = null;
      selectedObjs = [];
      canvasW = 0;
      canvasH = 0;
      await tick();
      await closeDb();
      const dbPath = await currentDbFilePath();
      for (const suffix of ['', '-wal', '-shm']) {
        try { await remove(dbPath + suffix); } catch { /* existiert nicht */ }
      }
      await clearCurrentAssetDir();
      await writeFile(dbPath, await readFile(path));
      setDbPath(DB_PATH);
      currentFile = path;
      await loadCurrentDbIntoApp();
      unsaved = false;
      canvasReady = true;
    } catch (e) {
      console.error(e);
      await dialogMessage(`Datei konnte nicht geöffnet werden:\n${e instanceof Error ? e.message : String(e)}`, {
        title: 'Vecstructi öffnen',
        kind: 'error',
      });
    }
  }

  async function fileSave() {
    try {
      await syncCurrentDocumentToDb();
      if (!currentFile) return fileSaveAs(false);
      await closeDb();
      await writeFile(currentFile, await readFile(await currentDbFilePath()));
      unsaved = false;
    } catch (err) {
      console.error('Speichern fehlgeschlagen', err);
      await dialogMessage(`Speichern fehlgeschlagen:\n${err instanceof Error ? err.message : String(err)}`, { title: 'Fehler', kind: 'error' });
    }
  }

  async function fileSaveAs(resync = true) {
    const path = await dialogSave({
      title: 'Speichern unter',
      defaultPath: currentFile ?? 'MeinProjekt.vecstructi',
      filters: [{ name: 'Vecstructi', extensions: ['vecstructi'] }],
    });
    if (!path || typeof path !== 'string') return;
    const target = path.toLowerCase().endsWith('.vecstructi') ? path : `${path}.vecstructi`;
    try {
      if (resync) await syncCurrentDocumentToDb();
      await closeDb();
      await writeFile(target, await readFile(await currentDbFilePath()));
      currentFile = target;
      await resolveImageAssets();
      unsaved = false;
    } catch (err) {
      console.error('Speichern fehlgeschlagen', err);
      await dialogMessage(`Speichern fehlgeschlagen:\n${err instanceof Error ? err.message : String(err)}`, { title: 'Fehler', kind: 'error' });
    }
  }

  // ── PDF Export ───────────────────────────────────────────────────────────
  function pdfFillFor(obj: DrawnObject) {
    return parseGradientValue(obj.fill) ? `url(#fill-${obj.uid})` : (obj.fill || 'none');
  }
  function pdfGradientDefs(): string[] {
    const lines: string[] = [];
    const gradObjs = objects.filter(o => parseGradientValue(o.fill));
    if (!gradObjs.length) return lines;
    lines.push(`  <defs>`);
    for (const obj of gradObjs) {
      const grad = parseGradientValue(obj.fill);
      if (!grad) continue;
      if (grad.mode === 'radial') {
        lines.push(`    <radialGradient id="fill-${obj.uid}" cx="50%" cy="50%" r="70%"><stop offset="0%" stop-color="${grad.start}"/><stop offset="100%" stop-color="${grad.end}"/></radialGradient>`);
      } else {
        lines.push(`    <linearGradient id="fill-${obj.uid}" x1="0%" y1="0%" x2="100%" y2="0%" gradientTransform="rotate(${grad.angle} .5 .5)"><stop offset="0%" stop-color="${grad.start}"/><stop offset="100%" stop-color="${grad.end}"/></linearGradient>`);
      }
    }
    lines.push(`  </defs>`);
    return lines;
  }

  function buildPdfSvg(imageHrefByUid = new Map<string, string>()): string {
    // wie buildSVG(), aber nur sichtbare Ebenen, keine Selektion-Artefakte
    const lines: string[] = [];
    lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}" viewBox="0 0 ${canvasW} ${canvasH}">`);

    // Hintergrund
    const bg = setupHintergrundTransp ? 'white' : (setupHintergrund || '#ffffff');
    lines.push(`  <rect width="${canvasW}" height="${canvasH}" fill="${bg}"/>`);
    const tplSvgPdf = templateBgSvg(pageTemplate, canvasW, canvasH);
    if (tplSvgPdf) lines.push(`  ${tplSvgPdf}`);
    lines.push(...pdfGradientDefs());

    // Schatten-Filter-Defs
    const shadowObjs = objects.filter(o => o.shadowEnabled);
    if (shadowObjs.length) {
      lines.push(`  <defs>`);
      for (const obj of shadowObjs) {
        lines.push(`    <filter id="sh-${obj.uid}" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${obj.shadowX ?? 4}" dy="${obj.shadowY ?? 4}" stdDeviation="${obj.shadowBlur ?? 6}" flood-color="${obj.shadowColor ?? '#000000'}" flood-opacity="0.5"/></filter>`);
      }
      lines.push(`  </defs>`);
    }

    // Objekte — nur sichtbare Ebenen
    for (const e of ebenen.filter(eb => eb.name !== 'Raster' && eb.sichtbar)) {
      const opVal = e.opacity ?? 100;
      lines.push(`  <g${opVal < 100 ? ` opacity="${opVal / 100}"` : ''}>`);
      for (const obj of objects.filter(o => o.ebene === e.name)) {
        if (obj.type === 'RECHTECK') {
          const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
          const hasTf2 = obj.rotation || obj.shearX || obj.shearY;
          const rot = hasTf2 ? ` transform="translate(${cx},${cy}) rotate(${obj.rotation ?? 0}) skewX(${obj.shearX ?? 0}) skewY(${obj.shearY ?? 0}) translate(${-cx},${-cy})"` : '';
          const rx  = obj.radiusOL ? ` rx="${obj.radiusOL}"` : '';
          const da  = obj.strokeDash ? ` stroke-dasharray="${obj.strokeDash}"` : '';
          const sh  = obj.shadowEnabled ? ` filter="url(#sh-${obj.uid})"` : '';
          if (obj.isImageFrame && (obj.imageUrl || imageHrefByUid.has(obj.uid))) {
            const imgHref = imageHrefByUid.get(obj.uid) ?? obj.imageUrl;
            const sc = obj.imageScale ?? 1;
            const iw = obj.imageRenderW ?? obj.w * sc, ih = obj.imageRenderH ?? obj.h * sc;
            const ix = obj.x + obj.w/2 - iw/2 + (obj.imageOffsetX ?? 0);
            const iy = obj.y + obj.h/2 - ih/2 + (obj.imageOffsetY ?? 0);
            const d = rectMaskPath(obj);
            lines.push(`  <defs><clipPath id="cp-${obj.uid}"><path d="${d}"/></clipPath></defs>`);
            lines.push(`  <g${sh}><image href="${imgHref}" x="${ix}" y="${iy}" width="${iw}" height="${ih}" clip-path="url(#cp-${obj.uid})" preserveAspectRatio="xMidYMid meet"/></g>`);
          } else if (!obj.isImageFrame) {
            if (obj.shape === 'frame') {
              lines.push(`    <path d="${framePath(obj.x, obj.y, obj.w, obj.h, obj.frameWidth ?? 8)}" fill="none" stroke="${obj.stroke || '#000000'}" stroke-width="${obj.strokeW || 1}"${da}${rot}${sh}/>`);
            } else if (obj.shape === 'ellipse') {
              lines.push(`    <ellipse cx="${obj.x + obj.w / 2}" cy="${obj.y + obj.h / 2}" rx="${obj.w / 2}" ry="${obj.h / 2}" fill="${pdfFillFor(obj)}" stroke="${obj.stroke || 'none'}" stroke-width="${obj.strokeW}"${da}${rot}${sh}/>`);
            } else if (obj.shape === 'polygon') {
              lines.push(`    <polygon points="${polygonPoints(obj.x, obj.y, obj.w, obj.h, obj.polygonSides ?? 6)}" fill="${pdfFillFor(obj)}" stroke="${obj.stroke || 'none'}" stroke-width="${obj.strokeW}"${da}${rot}${sh}/>`);
            } else {
              lines.push(`    <rect x="${obj.x}" y="${obj.y}" width="${obj.w}" height="${obj.h}" fill="${pdfFillFor(obj)}" stroke="${obj.stroke || 'none'}" stroke-width="${obj.strokeW}"${da}${rx}${rot}${sh}/>`);
            }
          }
        } else if (obj.type === 'LINIE') {
          lines.push(...renderLineSvg(obj, '  '));
        } else if (obj.type === 'TEXT') {
          lines.push(...renderPdfTextSvg(obj, '  '));
        } else if (obj.type === 'PFAD') {
          const da  = obj.strokeDash ? ` stroke-dasharray="${obj.strokeDash}"` : '';
          const rot = obj.rotation ? ` transform="rotate(${obj.rotation} ${obj.x+obj.w/2} ${obj.y+obj.h/2})"` : '';
          const sh  = obj.shadowEnabled ? ` filter="url(#sh-${obj.uid})"` : '';
          if (obj.isWall) {
            const wp = wallRenderParts(obj.points, obj.wallWidth ?? mmToPx(10), obj.wallHatchSpacing ?? mmToPx(5), obj.wallHatchType ?? 'diagonal', obj.curveClosed);
            lines.push(`    <path d="${wp.lines}" fill="none" stroke="${obj.stroke||'#222222'}" stroke-width="${obj.strokeW||1}" stroke-linecap="square" stroke-linejoin="miter"${rot}${sh}/>`);
            if (wp.hatches) lines.push(`    <path d="${wp.hatches}" fill="none" stroke="${obj.wallHatchColor||'#444444'}" stroke-width="1" stroke-linecap="butt"${rot}${sh}/>`);
          } else {
            lines.push(`    <path d="${obj.d}" fill="${pdfFillFor(obj)}" stroke="${obj.stroke||'#000000'}" stroke-width="${obj.strokeW||1}"${da} stroke-linecap="round" stroke-linejoin="round"${rot}${sh}/>`);
          }
        }
      }
      lines.push(`  </g>`);
    }
    lines.push(`</svg>`);
    return lines.join('\n');
  }

  async function loadFontAsBase64(url: string): Promise<string> {
    try {
      const buf = await fetch(url).then(r => r.arrayBuffer());
      const bytes = new Uint8Array(buf);
      let b64 = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        b64 += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      return btoa(b64);
    } catch { return ''; }
  }

  async function buildEmbeddedFontStyle(): Promise<string> {
    const defs = [
      { weight: 500, style: 'normal',  file: '/fonts/cmu-serif-500-roman.woff2'  },
      { weight: 500, style: 'italic',  file: '/fonts/cmu-serif-500-italic.woff2' },
      { weight: 700, style: 'normal',  file: '/fonts/cmu-serif-700-roman.woff2'  },
      { weight: 700, style: 'italic',  file: '/fonts/cmu-serif-700-italic.woff2' },
    ];
    const faces: string[] = [];
    for (const d of defs) {
      const b64 = await loadFontAsBase64(d.file);
      if (b64) faces.push(`@font-face{font-family:"CMU Serif";font-weight:${d.weight};font-style:${d.style};src:url("data:font/woff2;base64,${b64}") format("woff2");}`);
    }
    const o=String.fromCharCode(60,115,116,121,108,101,62),c=String.fromCharCode(60,47,115,116,121,108,101,62);
    return faces.length ? o+faces.join('')+c : '';
  }

  async function buildPdfSvgForExport(): Promise<string> {
    const imageHrefByUid = new Map<string, string>();
    const imageObjects = objects.filter((o): o is DrawnRect => o.type === 'RECHTECK' && !!o.isImageFrame && !!o.imageFile);
    for (const obj of imageObjects) {
      try {
        const bytes = await readFile(await assetPathFor(obj.imageFile!));
        imageHrefByUid.set(obj.uid, bytesToDataUrl(bytes, imageMimeFromName(obj.imageFile!)));
      } catch (err) {
        console.error('PDF image asset embed failed', obj.imageFile, err);
      }
    }
    const svg = buildPdfSvg(imageHrefByUid);
    const fontStyle = await buildEmbeddedFontStyle();
    return fontStyle ? svg.replace(/(<svg[^>]*>)/, '$1\n  ' + fontStyle) : svg;
  }

  async function openPdfDialog() {
    pdfDialogOpen = true;
    pdfPreviewUrl = '';
    await tick();
    const canvasEl = canvasScrollAreaEl?.querySelector('.canvas-scroll') as HTMLElement | null;
    if (!canvasEl) return;
    const uiEls = canvasEl.querySelectorAll<HTMLElement>('.sel-handle,.sel-rotate-handle,.sel-rotate-line,.sel-multi-box,.sel-rubber');
    uiEls.forEach(el => { el.style.visibility = 'hidden'; });
    const previewScale = Math.min(1, 600 / canvasW) / zoomFactor;
    const shot = await html2canvas(canvasEl, {
      scale: previewScale,
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#ffffff',
      width: canvasW * zoomFactor,
      height: canvasH * zoomFactor,
      x: 0, y: 0,
      logging: false,
    });
    uiEls.forEach(el => { el.style.visibility = ''; });
    if (pdfPreviewUrl) URL.revokeObjectURL(pdfPreviewUrl);
    shot.toBlob(blob => { if (blob) pdfPreviewUrl = URL.createObjectURL(blob); }, 'image/png');
  }

  function pdfDefaultPath(): string {
    if (!currentFile) return 'export.pdf';
    const replaced = currentFile.replace(/\.[^./\\]+$/i, '.pdf');
    return replaced === currentFile ? `${currentFile}.pdf` : replaced;
  }

  async function doExportPdf() {
    const savePath = await dialogSave({
      title: 'PDF exportieren',
      defaultPath: pdfDefaultPath(),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (!savePath) return;
    pdfExporting = true;
    try {
      const canvasEl = canvasScrollAreaEl?.querySelector('.canvas-scroll') as HTMLElement | null;
      if (!canvasEl) throw new Error('Canvas-Element nicht gefunden');

      // Aktuell angezeigte Selektionsrahmen kurz ausblenden
      const uiEls = canvasEl.querySelectorAll<HTMLElement>('.sel-handle,.sel-rotate-handle,.sel-rotate-line,.sel-multi-box,.sel-rubber');
      uiEls.forEach(el => { el.style.visibility = 'hidden'; });

      const captureScale = pdfDpi / 96 / zoomFactor;
      const shot = await html2canvas(canvasEl, {
        scale: captureScale,
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#ffffff',
        width:  canvasW * zoomFactor,
        height: canvasH * zoomFactor,
        x: 0,
        y: 0,
        logging: false,
      });

      uiEls.forEach(el => { el.style.visibility = ''; });

      const jpegQuality = pdfDpi >= 300 ? 0.92 : 0.95;
      const imgData = shot.toDataURL('image/jpeg', jpegQuality);
      const wMm = canvasW / (96 / 25.4);
      const hMm = canvasH / (96 / 25.4);
      const doc = new jsPDF({
        orientation: wMm >= hMm ? 'landscape' : 'portrait',
        unit: 'mm',
        format: [wMm, hMm],
        compress: true,
      });
      doc.addImage(imgData, 'JPEG', 0, 0, wMm, hMm);
      const pdfBytes = doc.output('arraybuffer');
      const target = savePath.toLowerCase().endsWith('.pdf') ? savePath : `${savePath}.pdf`;
      await writeFile(target, new Uint8Array(pdfBytes));
      pdfDialogOpen = false;
      if (pdfPreviewUrl) { URL.revokeObjectURL(pdfPreviewUrl); pdfPreviewUrl = ''; }
    } catch (err) {
      console.error('PDF export failed', err);
      await dialogMessage(`PDF konnte nicht exportiert werden:\n${err instanceof Error ? err.message : String(err)}`, {
        title: 'PDF exportieren',
        kind: 'error',
      });
    } finally {
      pdfExporting = false;
    }
  }

  // ── Zoom ──────────────────────────────────────────────────────────────────
  let zoomPercent  = $state(100);
  let zoomFactor   = $derived(zoomPercent / 100);
  let linealSichtbar = $state(true);
  let rulerPx = $derived(linealSichtbar ? RULER_PX : 0);
  let canvasAreaEl: HTMLElement | null = null;
  let canvasScrollAreaEl: HTMLElement | null = null;
  let scrollX = $state(0);
  let scrollY = $state(0);
  const zoomStops = [25, 50, 100, 125, 150, 200, 300, 400];
  let zoomHoldStop: number | null = null;
  let zoomHoldUntil = 0;

  function fitToWindow() {
    if (!canvasW || !canvasH || !canvasAreaEl) return;
    const areaW = canvasAreaEl.clientWidth  - rulerPx;
    const areaH = canvasAreaEl.clientHeight - rulerPx - 32;
    const scaleW = areaW / canvasW;
    const scaleH = areaH / canvasH;
    zoomPercent = Math.max(10, Math.min(400, Math.floor(Math.min(scaleW, scaleH) * 100)));
  }

  function zoomIn()  { zoomPercent = Math.min(400, zoomPercent + 25); }
  function zoomOut() { zoomPercent = Math.max(10,  zoomPercent - 25); }

  function nearestZoomStop(value: number) {
    return zoomStops.reduce((best, stop) =>
      Math.abs(stop - value) < Math.abs(best - value) ? stop : best
    , zoomStops[0]);
  }

  function snapZoomIfClose() {
    const near = nearestZoomStop(zoomPercent);
    if (Math.abs(near - zoomPercent) <= 4) zoomPercent = near;
    zoomHoldStop = null;
    zoomHoldUntil = 0;
  }

  function handleZoomSliderInput(value: number | string) {
    const raw = Number(value);
    const near = nearestZoomStop(raw);
    const now = Date.now();
    if (Math.abs(near - raw) <= 5) {
      if (zoomHoldStop !== near) {
        zoomHoldStop = near;
        zoomHoldUntil = now + 500;
      }
      if (now < zoomHoldUntil) {
        zoomPercent = near;
        return;
      }
    } else {
      zoomHoldStop = null;
      zoomHoldUntil = 0;
    }
    zoomPercent = raw;
  }

  function zoomAt(ev: MouseEvent, direction: 1 | -1) {
    if (!canvasScrollAreaEl) {
      direction > 0 ? zoomIn() : zoomOut();
      return;
    }
    ev.preventDefault();
    const before = zoomFactor;
    const sx = canvasScrollAreaEl.scrollLeft;
    const sy = canvasScrollAreaEl.scrollTop;
    const mx = ev.clientX - canvasScrollAreaEl.getBoundingClientRect().left + sx;
    const my = ev.clientY - canvasScrollAreaEl.getBoundingClientRect().top + sy;
    direction > 0 ? zoomIn() : zoomOut();
    tick().then(() => {
      const ratio = zoomFactor / before;
      canvasScrollAreaEl!.scrollLeft = mx * ratio - (ev.clientX - canvasScrollAreaEl!.getBoundingClientRect().left);
      canvasScrollAreaEl!.scrollTop = my * ratio - (ev.clientY - canvasScrollAreaEl!.getBoundingClientRect().top);
    });
  }

  function startHandPan(ev: MouseEvent) {
    if (!canvasScrollAreaEl) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const startLeft = canvasScrollAreaEl.scrollLeft;
    const startTop = canvasScrollAreaEl.scrollTop;
    canvasScrollAreaEl.classList.add('canvas-panning');
    function onMove(mv: MouseEvent) {
      canvasScrollAreaEl!.scrollLeft = startLeft - (mv.clientX - startX);
      canvasScrollAreaEl!.scrollTop = startTop - (mv.clientY - startY);
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      canvasScrollAreaEl?.classList.remove('canvas-panning');
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  async function toggleVollbild() {
    try {
      const win = getCurrentWebviewWindow();
      const full = await win.isFullscreen();
      await win.setFullscreen(!full);
    } catch (err) {
      console.error('Appfenster konnte nicht an das Dokument angepasst werden', err);
    }
  }
  let vollbild = $state(false);
  $effect(() => {
    (async () => {
      try { vollbild = await getCurrentWebviewWindow().isFullscreen(); } catch {}
    })();
  });

  // ── Einheit & Genauigkeit ─────────────────────────────────────────────────
  let einheit     = $state<'px'|'mm'|'cm'>('px');
  let genauigkeit = $state<1|2|3>(1);

  // Rundet einen mm-Wert auf den nächsten Rasterschritt (in mm)
  function snapMm(mm: number): number {
    if (!rasterAusrichten) return mm;
    const unt = rasterUnterteilung !== '' && (rasterUnterteilung as number) > 0 ? rasterUnterteilung as number : 1;
    const stepX = rasterXAbstand !== '' ? (rasterXAbstand as number) / unt : 0;
    if (stepX <= 0) return mm;
    return Math.round(mm / stepX) * stepX;
  }

  function pxToUnit(px: number): number {
    if (einheit === 'mm') {
      const mm = px / MM_TO_PX;
      const snapped = snapMm(mm);
      return parseFloat(snapped.toFixed(genauigkeit));
    }
    if (einheit === 'cm') {
      const cm = px / MM_TO_PX / 10;
      const snappedCm = snapMm(cm * 10) / 10;
      return parseFloat(snappedCm.toFixed(genauigkeit));
    }
    return Math.round(px);
  }
  function unitToPx(val: number): number {
    if (einheit === 'mm') return snapMm(val) * MM_TO_PX;
    if (einheit === 'cm') return snapMm(val * 10) / 10 * MM_TO_PX * 10;
    return val;
  }
  let unitStep = $derived(einheit === 'px' ? 1 : parseFloat((Math.pow(10, -(genauigkeit as number))).toFixed(genauigkeit)));

  // ── Raster-Snap ───────────────────────────────────────────────────────────
  let snapStepX = $derived.by(() => {
    const unt = rasterUnterteilung !== '' && (rasterUnterteilung as number) > 0 ? rasterUnterteilung as number : 1;
    return rasterAusrichten && rasterXAbstand !== '' ? mmToPx((rasterXAbstand as number) / unt) : 0;
  });
  let snapStepY = $derived.by(() => {
    const unt = rasterUnterteilung !== '' && (rasterUnterteilung as number) > 0 ? rasterUnterteilung as number : 1;
    return rasterAusrichten && rasterYAbstand !== '' ? mmToPx((rasterYAbstand as number) / unt) : 0;
  });
  function snapX(px: number): number { return snapStepX > 0 ? Math.round(px / snapStepX) * snapStepX : px; }
  function snapY(px: number): number { return snapStepY > 0 ? Math.round(px / snapStepY) * snapStepY : px; }
  function canvasPoint(ev: MouseEvent): { x: number; y: number } {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: (ev.clientX - r.left) / zoomFactor, y: (ev.clientY - r.top) / zoomFactor };
  }

  // ── Raster-Eigenschaften ──────────────────────────────────────────────────
  let rasterEinblenden   = $state(true);
  let rasterAusrichten   = $state(false);
  let rasterXAbstand     = $state<number|''>(10);
  let rasterYAbstand     = $state<number|''>(10);
  let rasterUnterteilung = $state<number|''>(1);
  let rasterRandL        = $state<number|''>(0);
  let rasterRandR        = $state<number|''>(0);
  let rasterRandO        = $state<number|''>(0);
  let rasterRandU        = $state<number|''>(0);
  let rasterUeberRand    = $state(false);
  let rasterRandVersatz  = $state(false);
  let rasterFarbe        = $state('#cccccc');
  let rasterDicke        = $state<number>(0.75);
  let rasterTransparenz  = $state<number>(50);

  function clampRasterDicke(value: number | ''): number {
    const n = value === '' ? 0.75 : Number(value);
    return Math.min(2, Math.max(0.5, Number.isFinite(n) ? n : 0.75));
  }

  function updateRasterDicke() {
    rasterDicke = clampRasterDicke(rasterDicke);
    updateRaster();
  }

  function stepRaster(key: 'rasterXAbstand'|'rasterYAbstand'|'rasterUnterteilung'|'rasterRandL'|'rasterRandR'|'rasterRandO'|'rasterRandU', delta: number) {
    const get = () => {
      if (key === 'rasterXAbstand')     return rasterXAbstand     !== '' ? rasterXAbstand     as number : 0;
      if (key === 'rasterYAbstand')     return rasterYAbstand     !== '' ? rasterYAbstand     as number : 0;
      if (key === 'rasterUnterteilung') return rasterUnterteilung !== '' ? rasterUnterteilung as number : 1;
      if (key === 'rasterRandL')        return rasterRandL        !== '' ? rasterRandL        as number : 0;
      if (key === 'rasterRandR')        return rasterRandR        !== '' ? rasterRandR        as number : 0;
      if (key === 'rasterRandO')        return rasterRandO        !== '' ? rasterRandO        as number : 0;
      return rasterRandU !== '' ? rasterRandU as number : 0;
    };
    const val = Math.max(key === 'rasterUnterteilung' ? 1 : 0, get() + delta);
    if (key === 'rasterXAbstand')          rasterXAbstand     = val;
    else if (key === 'rasterYAbstand')     rasterYAbstand     = val;
    else if (key === 'rasterUnterteilung') rasterUnterteilung = val;
    else if (key === 'rasterRandL')        rasterRandL        = val;
    else if (key === 'rasterRandR')        rasterRandR        = val;
    else if (key === 'rasterRandO')        rasterRandO        = val;
    else                                   rasterRandU        = val;
    updateRaster();
  }

  function collectDocumentLayout(): DocumentLayoutSettings {
    return {
      widthMm: setupBreite !== '' ? setupBreite as number : 297,
      heightMm: setupHoehe !== '' ? setupHoehe as number : 210,
      unit: einheit,
      precision: genauigkeit,
      background: setupHintergrund,
      backgroundTransparent: setupHintergrundTransp,
      gridXmm: rasterXAbstand !== '' ? rasterXAbstand as number : 10,
      gridYmm: rasterYAbstand !== '' ? rasterYAbstand as number : 10,
      gridSubdivision: rasterUnterteilung !== '' ? rasterUnterteilung as number : 1,
      gridLineWidth: clampRasterDicke(rasterDicke),
      gridColor: rasterFarbe,
      gridOpacity: rasterTransparenz,
      gridVisible: rasterEinblenden,
      gridSnap: rasterAusrichten,
      gridMarginLeftMm: rasterRandL !== '' ? rasterRandL as number : 0,
      gridMarginRightMm: rasterRandR !== '' ? rasterRandR as number : 0,
      gridMarginTopMm: rasterRandO !== '' ? rasterRandO as number : 0,
      gridMarginBottomMm: rasterRandU !== '' ? rasterRandU as number : 0,
      gridBeyondMargins: rasterUeberRand,
      gridOffsetFromMargins: rasterRandVersatz,
      rulerVisible: linealSichtbar,
      pageTemplate,
      zoomPercent,
    };
  }

  function applyDocumentLayoutFromDb(layout: DocumentLayoutSettings) {
    setupBreite = layout.widthMm;
    setupHoehe = layout.heightMm;
    canvasW = mmToPx(layout.widthMm);
    canvasH = mmToPx(layout.heightMm);
    einheit = layout.unit;
    genauigkeit = layout.precision;
    setupEinheit = layout.unit;
    setupGenauigkeit = layout.precision;
    setupHintergrund = layout.background;
    setupHintergrundTransp = layout.backgroundTransparent;
    rasterXAbstand = layout.gridXmm;
    rasterYAbstand = layout.gridYmm;
    setupZellBreite = layout.gridXmm;
    setupZellHoehe = layout.gridYmm;
    rasterUnterteilung = layout.gridSubdivision;
    rasterDicke = clampRasterDicke(layout.gridLineWidth);
    setupDicke = rasterDicke;
    rasterFarbe = layout.gridColor;
    setupFarbe = layout.gridColor;
    rasterTransparenz = layout.gridOpacity;
    setupTransparenz = layout.gridOpacity;
    rasterEinblenden = layout.gridVisible;
    rasterAusrichten = layout.gridSnap;
    rasterRandL = layout.gridMarginLeftMm;
    rasterRandR = layout.gridMarginRightMm;
    rasterRandO = layout.gridMarginTopMm;
    rasterRandU = layout.gridMarginBottomMm;
    rasterUeberRand = layout.gridBeyondMargins;
    rasterRandVersatz = layout.gridOffsetFromMargins;
    linealSichtbar = layout.rulerVisible;
    pageTemplate = layout.pageTemplate ?? 'blank';
    zoomPercent = layout.zoomPercent ?? 100;
    const rasterEbene = ebenen.find(e => e.name === 'Raster');
    if (rasterEbene) rasterEbene.sichtbar = rasterEinblenden;
    layoutLoaded = true;
  }

  function persistDocumentLayoutSoon() {
    if (!layoutLoaded) return;
    if (saveLayoutTimer) clearTimeout(saveLayoutTimer);
    saveLayoutTimer = setTimeout(() => {
      saveLayoutTimer = null;
      void queueDbWrite(() => saveDocumentLayout(collectDocumentLayout())).catch(err => console.error('SQLite layout save failed', err));
    }, 200);
  }

  // ── Lineal ────────────────────────────────────────────────────────────────
  // Tick-Abstand in px — bei sehr kleinen Zellen mehrere zusammenfassen
  let tickStepPx = $derived.by(() => {
    const cellW = setupZellBPx || mmToPx(10);
    const cellH = setupZellHPx || mmToPx(10);
    // mindestens ~28px zwischen Ticks damit Labels nicht überlappen
    const minPx = 28;
    const stepsW = Math.ceil(minPx / cellW);
    const stepsH = Math.ceil(minPx / cellH);
    return { h: cellW * stepsW, v: cellH * stepsH,
             labelMmH: (setupZellBreite !== '' ? (setupZellBreite as number) : 10) * stepsW,
             labelMmV: (setupZellHoehe  !== '' ? (setupZellHoehe  as number) : 10) * stepsH };
  });

  function formatRulerLabel(mm: number): string {
    if (einheit === 'px') return `${Math.round(mmToPx(mm))}`;
    if (einheit === 'cm') return `${parseFloat((mm / 10).toFixed(genauigkeit))}`;
    return `${parseFloat(mm.toFixed(genauigkeit))}`;
  }

  let rulerTicksH = $derived.by(() => {
    if (!canvasW) return [] as { x: number; label: string }[];
    const step = tickStepPx.h;
    const n = Math.floor(canvasW / step);
    return Array.from({ length: n + 1 }, (_, i) => ({
      x: i * step,
      label: i === 0 ? '' : formatRulerLabel(i * tickStepPx.labelMmH)
    }));
  });

  let rulerTicksV = $derived.by(() => {
    if (!canvasH) return [] as { y: number; label: string }[];
    const step = tickStepPx.v;
    const n = Math.floor(canvasH / step);
    return Array.from({ length: n + 1 }, (_, i) => ({
      y: i * step,
      label: i === 0 ? '' : formatRulerLabel(i * tickStepPx.labelMmV)
    }));
  });


  // ── Apply Setup ───────────────────────────────────────────────────────────
  function updatePageSettings() {
    if (!setupBreite || !setupHoehe) return;
    canvasW = mmToPx(setupBreite as number);
    canvasH = mmToPx(setupHoehe as number);
    einheit = setupEinheit;
    genauigkeit = setupGenauigkeit;
    persistDocumentLayoutSoon();
    unsaved = true;
  }

  function updateRulerVisible() {
    persistDocumentLayoutSoon();
    unsaved = true;
  }

  function applySetup() {
    if (!setupBreite || !setupHoehe) return;
    pageSetupOpen = false;
    pageTemplate = setupTemplate;
    canvasW = setupBreitePx;
    canvasH = setupHoehePx;
    rasterXAbstand    = setupZellBreite  !== '' ? setupZellBreite  as number : 10;
    rasterYAbstand    = setupZellHoehe   !== '' ? setupZellHoehe   as number : 10;
    rasterFarbe       = setupFarbe;
    rasterDicke       = clampRasterDicke(setupDicke);
    rasterTransparenz = setupTransparenz !== '' ? setupTransparenz as number : 50;
    einheit     = setupSizeUnit;
    setupEinheit = setupSizeUnit;
    genauigkeit = setupGenauigkeit;
    persistDocumentLayoutSoon();
    void fitDocumentWindowToPage();
  }

  function updateRaster() {
    if (!canvasW) return;
    setupZellBreite = rasterXAbstand;
    setupZellHoehe = rasterYAbstand;
    setupFarbe = rasterFarbe;
    setupDicke = rasterDicke;
    setupTransparenz = rasterTransparenz;
    persistDocumentLayoutSoon();
    unsaved = true;
  }

  // ── SVG-Raster (reaktiv für Template) ────────────────────────────────────
  let svgRXPx = $derived.by(() => {
    const unt = rasterUnterteilung !== '' && (rasterUnterteilung as number) > 0 ? rasterUnterteilung as number : 1;
    return rasterXAbstand !== '' ? mmToPx((rasterXAbstand as number) / unt) : 0;
  });
  let svgRYPx = $derived.by(() => {
    const unt = rasterUnterteilung !== '' && (rasterUnterteilung as number) > 0 ? rasterUnterteilung as number : 1;
    return rasterYAbstand !== '' ? mmToPx((rasterYAbstand as number) / unt) : 0;
  });
  let svgROpacity = $derived(rasterTransparenz / 100);
  let svgRandL    = $derived(rasterRandL !== '' ? mmToPx(rasterRandL as number) : 0);
  let svgRandR    = $derived(rasterRandR !== '' ? mmToPx(rasterRandR as number) : 0);
  let svgRandO    = $derived(rasterRandO !== '' ? mmToPx(rasterRandO as number) : 0);
  let svgRandU    = $derived(rasterRandU !== '' ? mmToPx(rasterRandU as number) : 0);

  // ── Dokumentvorlage-Hintergrund ──────────────────────────────────────────
  const NOTEPAD_LINE_SPACING_MM  = 7;
  const NOTEPAD_MARGIN_LEFT_MM   = 25;
  const NOTEPAD_TOP_OFFSET_MM    = 8;
  const LOOSELEAF_TOP_OFFSET_MM  = 5;
  const LOOSELEAF_HOLE_RADIUS_MM = 3;
  let notepadLineH   = $derived(mmToPx(NOTEPAD_LINE_SPACING_MM));
  let notepadMarginX = $derived(mmToPx(NOTEPAD_MARGIN_LEFT_MM));
  let notepadTopOff  = $derived(mmToPx(NOTEPAD_TOP_OFFSET_MM));

  // Millimeterpapier: Snap = 1mm-Schritte → Linien müssen Vielfache von mmToPx(1) sein
  const MM1_PX  = Math.round(MM_TO_PX);      // mmToPx(1) = 4px
  const MM5_PX  = MM1_PX * 5;               // 5 snap-Schritte = 20px
  const MM10_PX = MM1_PX * 10;              // 10 snap-Schritte = 40px

  // Blaupause: Snap = 5mm-Schritte → Linien müssen mmToPx(5) und mmToPx(10) entsprechen
  const BP5_PX  = Math.round(5  * MM_TO_PX); // mmToPx(5)  = 19px
  const BP10_PX = Math.round(10 * MM_TO_PX); // mmToPx(10) = 38px = 2 × 19px ✓

  function templateBgSvg(tpl: string, w: number, h: number): string {
    if (tpl === 'notepad') {
      const lineH = mmToPx(NOTEPAD_LINE_SPACING_MM);
      const marginX = mmToPx(NOTEPAD_MARGIN_LEFT_MM);
      const topOff = mmToPx(NOTEPAD_TOP_OFFSET_MM);
      return [
        `<defs><pattern id="np-lines" x="0" y="${topOff}" width="${w}" height="${lineH}" patternUnits="userSpaceOnUse">`,
        `<line x1="0" y1="${lineH}" x2="${w}" y2="${lineH}" stroke="rgba(80,170,220,0.55)" stroke-width="1"/>`,
        `</pattern></defs>`,
        `<rect width="${w}" height="${h}" fill="url(#np-lines)" pointer-events="none"/>`,
        `<line x1="${marginX}" y1="0" x2="${marginX}" y2="${h}" stroke="rgba(255,70,70,0.65)" stroke-width="1" pointer-events="none"/>`,
      ].join('');
    }
    if (tpl === 'looseleaf') {
      const lineH   = mmToPx(NOTEPAD_LINE_SPACING_MM);
      const marginX = mmToPx(NOTEPAD_MARGIN_LEFT_MM);
      const topOff  = mmToPx(LOOSELEAF_TOP_OFFSET_MM);
      const holeR   = mmToPx(LOOSELEAF_HOLE_RADIUS_MM);
      const hole1Y  = Math.round(h * 0.25);
      const hole2Y  = Math.round(h * 0.50);
      const hole3Y  = Math.round(h * 0.75);
      const holeCX  = Math.round(marginX / 2);
      return [
        `<defs><pattern id="ll-lines" x="0" y="${topOff}" width="${w}" height="${lineH}" patternUnits="userSpaceOnUse">`,
        `<line x1="0" y1="${lineH}" x2="${w}" y2="${lineH}" stroke="rgba(80,170,220,0.36)" stroke-width="1"/>`,
        `</pattern></defs>`,
        `<rect width="${w}" height="${h}" fill="url(#ll-lines)" pointer-events="none"/>`,
        `<line x1="${marginX}" y1="0" x2="${marginX}" y2="${h}" stroke="rgba(255,70,70,0.65)" stroke-width="1" pointer-events="none"/>`,
        `<circle cx="${holeCX}" cy="${hole1Y}" r="${holeR}" fill="none" stroke="rgba(0,0,0,0.18)" stroke-width="1" pointer-events="none"/>`,
        `<circle cx="${holeCX}" cy="${hole2Y}" r="${holeR}" fill="none" stroke="rgba(0,0,0,0.18)" stroke-width="1" pointer-events="none"/>`,
        `<circle cx="${holeCX}" cy="${hole3Y}" r="${holeR}" fill="none" stroke="rgba(0,0,0,0.18)" stroke-width="1" pointer-events="none"/>`,
      ].join('');
    }
    if (tpl === 'blueprint') {
      return [
        `<defs>`,
        `<pattern id="bp-5"  width="${BP5_PX}"  height="${BP5_PX}"  patternUnits="userSpaceOnUse">`,
        `<path d="M ${BP5_PX} 0 L 0 0 0 ${BP5_PX}"   fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="0.5"/>`,
        `</pattern>`,
        `<pattern id="bp-10" width="${BP10_PX}" height="${BP10_PX}" patternUnits="userSpaceOnUse">`,
        `<path d="M ${BP10_PX} 0 L 0 0 0 ${BP10_PX}" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="1"/>`,
        `</pattern>`,
        `</defs>`,
        `<rect width="${w}" height="${h}" fill="url(#bp-5)"  pointer-events="none"/>`,
        `<rect width="${w}" height="${h}" fill="url(#bp-10)" pointer-events="none"/>`,
      ].join('');
    }
    if (tpl === 'gradient') {
      return [
        `<defs><linearGradient id="tpl-grad" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">`,
        `<stop offset="0" stop-color="${setupHintergrund}"/>`,
        `<stop offset="1" stop-color="${setupFarbe}"/>`,
        `</linearGradient></defs>`,
        `<rect width="${w}" height="${h}" fill="url(#tpl-grad)" pointer-events="none"/>`,
      ].join('');
    }
    if (tpl === 'grid') {
      return [
        `<defs>`,
        `<pattern id="gr-5"  width="${BP5_PX}"  height="${BP5_PX}"  patternUnits="userSpaceOnUse">`,
        `<path d="M ${BP5_PX} 0 L 0 0 0 ${BP5_PX}" fill="none" stroke="rgba(0,0,0,0.12)" stroke-width="0.5"/>`,
        `</pattern>`,
        `<pattern id="gr-10" width="${BP10_PX}" height="${BP10_PX}" patternUnits="userSpaceOnUse">`,
        `<path d="M ${BP10_PX} 0 L 0 0 0 ${BP10_PX}" fill="none" stroke="rgba(0,0,0,0.28)" stroke-width="1"/>`,
        `</pattern>`,
        `</defs>`,
        `<rect width="${w}" height="${h}" fill="url(#gr-5)"  pointer-events="none"/>`,
        `<rect width="${w}" height="${h}" fill="url(#gr-10)" pointer-events="none"/>`,
      ].join('');
    }
    if (tpl === 'lined') {
      const lineH  = mmToPx(NOTEPAD_LINE_SPACING_MM);
      const topOff = mmToPx(NOTEPAD_TOP_OFFSET_MM);
      return [
        `<defs><pattern id="li-lines" x="0" y="${topOff}" width="${w}" height="${lineH}" patternUnits="userSpaceOnUse">`,
        `<line x1="0" y1="${lineH}" x2="${w}" y2="${lineH}" stroke="rgba(100,149,220,0.50)" stroke-width="1"/>`,
        `</pattern></defs>`,
        `<rect width="${w}" height="${h}" fill="url(#li-lines)" pointer-events="none"/>`,
      ].join('');
    }
    if (tpl === 'graph') {
      return [
        `<defs>`,
        `<pattern id="mm-1"  width="${MM1_PX}"  height="${MM1_PX}"  patternUnits="userSpaceOnUse">`,
        `<path d="M ${MM1_PX} 0 L 0 0 0 ${MM1_PX}"   fill="none" stroke="rgba(86,190,88,0.20)" stroke-width="0.4"/>`,
        `</pattern>`,
        `<pattern id="mm-5"  width="${MM5_PX}"  height="${MM5_PX}"  patternUnits="userSpaceOnUse">`,
        `<path d="M ${MM5_PX} 0 L 0 0 0 ${MM5_PX}"   fill="none" stroke="rgba(86,190,88,0.40)" stroke-width="0.5"/>`,
        `</pattern>`,
        `<pattern id="mm-10" width="${MM10_PX}" height="${MM10_PX}" patternUnits="userSpaceOnUse">`,
        `<path d="M ${MM10_PX} 0 L 0 0 0 ${MM10_PX}" fill="none" stroke="rgba(86,190,88,0.70)" stroke-width="1"/>`,
        `</pattern>`,
        `</defs>`,
        `<rect width="${w}" height="${h}" fill="url(#mm-1)"  pointer-events="none"/>`,
        `<rect width="${w}" height="${h}" fill="url(#mm-5)"  pointer-events="none"/>`,
        `<rect width="${w}" height="${h}" fill="url(#mm-10)" pointer-events="none"/>`,
      ].join('');
    }
    return '';
  }

  async function centerWindow(winW: number, winH: number) {
    const win = getCurrentWebviewWindow();
    const monitor = await currentMonitor();
    if (!monitor) return;
    const sf = monitor.scaleFactor;
    const screenW = monitor.size.width / sf;
    const screenH = monitor.size.height / sf;
    const screenX = monitor.position.x / sf;
    const screenY = monitor.position.y / sf;
    const x = Math.round(screenX + screenW / 2 - winW / 2);
    const y = Math.round(screenY + screenH / 2 - winH / 2);
    await win.setPosition(new LogicalPosition(x, y));
  }

  async function fitDocumentWindowToPage(forceInitialZoom100 = true) {
    if (!canvasW || !canvasH || !canvasScrollAreaEl) return;
    try {
      const win = getCurrentWebviewWindow();
      const monitor = await currentMonitor();
      if (!monitor) return;
      const sf = monitor.scaleFactor;
      const screenW = monitor.size.width / sf;
      const screenH = monitor.size.height / sf;

      // Chrome aus aktuellem Fenster und Canvas-Bereich messen
      const currentInner = await win.innerSize();
      const currentWinW = currentInner.width / sf;
      const currentWinH = currentInner.height / sf;
      const areaW = canvasScrollAreaEl.clientWidth;
      const areaH = canvasScrollAreaEl.clientHeight;
      const chromeW = currentWinW - areaW;
      const chromeH = currentWinH - areaH;

      let targetZoom = forceInitialZoom100 ? 100 : zoomPercent;

      // Zoom reduzieren bis Fenster auf Bildschirm passt
      while (targetZoom > 10) {
        const winW = canvasW * (targetZoom / 100) + chromeW;
        const winH = canvasH * (targetZoom / 100) + chromeH;
        if (winW <= screenW && winH <= screenH) break;
        targetZoom = Math.max(10, targetZoom - 25);
      }

      zoomPercent = targetZoom;
      await tick();

      const winW = Math.ceil(canvasW * (targetZoom / 100) + chromeW);
      const winH = Math.ceil(canvasH * (targetZoom / 100) + chromeH);
      await win.unmaximize();
      await win.setSize(new LogicalSize(winW, winH));
      await centerWindow(winW, winH);
    } catch (err) {
      console.error('Appfenster konnte nicht an das Dokument angepasst werden', err);
    }
  }

</script>

<svelte:window onkeydown={(ev) => {
  const t = ev.target as HTMLElement;
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
  const mod = ev.metaKey || ev.ctrlKey;
  if (mod && ev.key === 'z' && !ev.shiftKey) { ev.preventDefault(); undo(); }
  if (mod && (ev.key === 'y' || (ev.key === 'z' && ev.shiftKey))) { ev.preventDefault(); redo(); }
  if (mod && ev.key === 'x') { ev.preventDefault(); editCut(); }
  if (mod && ev.key === 'c') { ev.preventDefault(); editCopy(); }
  if (mod && ev.key === 'v') { ev.preventDefault(); editPaste(); }
  if (mod && ev.key === 'a') { ev.preventDefault(); selectAll(); }
  if (mod && ev.key === ']' && !ev.shiftKey) { ev.preventDefault(); arrangeStep(1); }
  if (mod && ev.key === '[' && !ev.shiftKey) { ev.preventDefault(); arrangeStep(-1); }
  if (mod && ev.key === ']' && ev.shiftKey)  { ev.preventDefault(); arrangeToFront(); }
  if (mod && ev.key === '[' && ev.shiftKey)  { ev.preventDefault(); arrangeToBack(); }
  if (mod && ev.key === 'g' && !ev.shiftKey) { ev.preventDefault(); arrangeGroup(); }
  if (mod && ev.key === 'g' && ev.shiftKey)  { ev.preventDefault(); arrangeUngroup(); }
  if (mod && (ev.key === '+' || ev.key === '=')) { ev.preventDefault(); zoomIn(); }
  if (mod && ev.key === '-') { ev.preventDefault(); zoomOut(); }
  if (mod && ev.key === '0') { ev.preventDefault(); zoomPercent = 100; }
  if (ev.key === 'Escape') {
    ev.preventDefault();
    if (activeTool === 'wall' && drawingWall) finishWall();
    else clearSelection();
  }
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && selectedObjs.length) {
    ev.preventDefault();
    deleteSelectedObjects();
  }
  // Werkzeug-Shortcuts
  if (!mod) {
    const toolKey: Record<string, string> = { v: 'select', l: 'line', r: 'rect', e: 'ellipse', t: 'text', z: 'zoom' };
    if (toolKey[ev.key]) {
      ev.preventDefault();
      activeTool = toolKey[ev.key];
      textEditUid = null; selectedObj = null; selectedObjs = []; measuringLine = null;
      setToolDefaults(toolKey[ev.key]);
    }
  }
  // Datei-Shortcuts
  if (mod && ev.key === 'n') { ev.preventDefault(); fileNew(); }
  if (mod && ev.key === 'o') { ev.preventDefault(); fileOpen(); }
  if (mod && ev.key === 's' && !ev.shiftKey) { ev.preventDefault(); fileSave(); }
  if (mod && ev.key === 's' &&  ev.shiftKey) { ev.preventDefault(); fileSaveAs(); }
  // Pfeiltasten-Nudge
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(ev.key) && selectedObjs.length) {
    ev.preventDefault();
    nudgeSelected(ev.key, ev.shiftKey ? 10 : 1);
  }
}}
onwheel={(ev) => {
  if (activeTool !== 'zoom') return;
  ev.preventDefault();
  const step = ev.deltaY < 0 ? 5 : -5;
  zoomPercent = Math.max(10, Math.min(400, zoomPercent + step));
}}
/>


{#if aboutDialogOpen}
<div class="setup-backdrop" onclick={() => aboutDialogOpen = false}>
  <div class="about-dialog" onclick={(e) => e.stopPropagation()}>
    <div class="about-dialog-header">
      <span class="about-dialog-title">Über Vecstructi</span>
      <button class="about-dialog-close" onclick={() => aboutDialogOpen = false}>✕</button>
    </div>
    <div class="about-body">
      <div class="about-head">
        <div class="about-logo">V</div>
        <div>
          <div class="about-title">Vecstructi</div>
          <div class="about-version">Version {APP_INFO.version}</div>
        </div>
      </div>
      <p class="about-text">
        Vecstructi ist ein vektorbasiertes Zeichen- und Layoutprogramm mit SQLite-Dokumentstruktur,
        mikrometergenauer interner Verwaltung, Formenbibliothek, Rich-Text, Bildobjekten, Ebenen,
        Gruppen, Undo/Redo und PDF-Export.
      </p>
      <div class="about-grid">
        <span>Programmautor</span><strong>{APP_INFO.author}</strong>
        <span>Ideengeber</span><strong>{APP_INFO.idea}</strong>
        <span>Code</span><strong>{APP_INFO.code}</strong>
        <span>App-Größe</span><strong>{APP_INFO.appSize}</strong>
        <span>Entwicklungsbeginn</span><strong>{APP_INFO.developmentStart}</strong>
      </div>
      <div class="about-tools">
        <div class="about-section-title">Verwendete Entwicklungswerkzeuge</div>
        <div class="about-tool-list">
          {#each APP_INFO.tools as tool}
            <span>{tool}</span>
          {/each}
        </div>
      </div>
    </div>
    <div class="setup-footer">
      <button class="btn-primary" onclick={() => aboutDialogOpen = false}>OK</button>
    </div>
  </div>
</div>
{/if}


<!-- ── Formbibliothek Setup Dialog ───────────────────────────────────────── -->
{#if formenSetupOpen}
<div class="setup-backdrop" onclick={() => formenSetupOpen = false}>
  <div class="formen-setup-dialog" onclick={(e) => e.stopPropagation()}>
    <div class="setup-header">
      <span>Setup</span>
      <button class="setup-close" onclick={() => formenSetupOpen = false}>✕</button>
    </div>
    <div class="formen-setup-body">
      <div class="formen-setup-section">
        <div class="formen-setup-label">Speicherort der eigenen Formen</div>
        <div class="formen-setup-path">{formenSetupPfad}</div>
      </div>
      <div class="formen-setup-section">
        <div class="formen-setup-label">Anzahl gespeicherter Formen</div>
        <div class="formen-setup-count">{savedShapes.length}</div>
      </div>
      <div class="formen-setup-actions">
        <button class="btn-secondary" onclick={exportShapes}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Exportieren…
        </button>
        <button class="btn-secondary" onclick={importShapes}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Importieren…
        </button>
        <button class="btn-secondary" onclick={() => revealItemInDir(formenSetupPfad)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          Im Finder zeigen
        </button>
      </div>
      {#if formenSetupStatus}
        <div class="formen-setup-status">{formenSetupStatus}</div>
      {/if}
    </div>
    <div class="setup-footer">
      <button class="btn-primary" onclick={() => formenSetupOpen = false}>Schließen</button>
    </div>
  </div>
</div>
{/if}


<!-- ── PDF Vorschau Dialog ────────────────────────────────────────────────── -->
{#if multiPasteOpen}
<div class="setup-backdrop" onclick={(e) => e.stopPropagation()}>
  <div class="multi-paste-dialog">
    <div class="setup-header">
      <span>Mehrfach einfügen</span>
      <button class="setup-close" onclick={() => multiPasteOpen = false}>✕</button>
    </div>
    <div class="multi-paste-body">
      <label class="mp-label">
        Anzahl
        <input type="number" class="mp-input" min="1" max="100" bind:value={multiPasteCount} />
      </label>
      <div class="mp-mode-row">
        <label class="mp-radio"><input type="radio" bind:group={multiPasteMode} value="abstand" /> Abstand</label>
        <label class="mp-radio"><input type="radio" bind:group={multiPasteMode} value="versatz" /> Versatz</label>
      </div>
      <div class="mp-xy-row">
        <label class="mp-label">
          {multiPasteMode === 'abstand' ? 'Abstand X' : 'Versatz X'}
          <input type="number" class="mp-input" bind:value={multiPasteX} />
        </label>
        <label class="mp-label">
          {multiPasteMode === 'abstand' ? 'Abstand Y' : 'Versatz Y'}
          <input type="number" class="mp-input" bind:value={multiPasteY} />
        </label>
      </div>
      {#if multiPasteSource.length}
        <p class="mp-hint">
          {#if multiPasteMode === 'abstand'}
            Objekte werden mit {multiPasteX} px Lücke in X und {multiPasteY} px Lücke in Y wiederholt.
          {:else}
            Jedes Objekt wird um {multiPasteX} px in X und {multiPasteY} px in Y versetzt.
          {/if}
        </p>
      {/if}
    </div>
    <div class="setup-footer">
      <button class="btn-cancel" onclick={() => multiPasteOpen = false}>Abbrechen</button>
      <button class="btn-primary" onclick={doMultiPaste}>Einfügen</button>
    </div>
  </div>
</div>
{/if}

{#if shapeSaveDialogOpen}
<div class="setup-backdrop" onclick={() => shapeSaveDialogOpen = false}>
  <div class="multi-paste-dialog" onclick={(e) => e.stopPropagation()}>
    <div class="setup-header">
      <span>Form speichern</span>
      <button class="setup-close" onclick={() => shapeSaveDialogOpen = false}>✕</button>
    </div>
    <div class="multi-paste-body">
      <label class="mp-label">
        Name
        <input type="text" class="mp-input" placeholder="z.B. Titelblock" bind:value={shapeSaveName} onkeydown={(e) => { if (e.key === 'Enter') doSaveShape(); }} />
      </label>
      <label class="mp-label">
        Gruppe
        <input type="text" class="mp-input" placeholder="z.B. Grundrisse" list="saved-shape-groups-list" bind:value={shapeSaveGruppe} />
        <datalist id="saved-shape-groups-list">
          {#each [...new Set(savedShapes.map(s => s.gruppe).filter(g => g))] as g}
            <option value={g}></option>
          {/each}
        </datalist>
      </label>
      <p class="mp-hint">{selectedObjs.length > 0 ? `${selectedObjs.length} ausgewählte Objekte werden gespeichert.` : `Alle ${objects.length} Objekte auf der Leinwand werden gespeichert.`}</p>
    </div>
    <div class="setup-footer">
      <button class="btn-cancel" onclick={() => shapeSaveDialogOpen = false}>Abbrechen</button>
      <button class="btn-primary" onclick={doSaveShape} disabled={!shapeSaveName.trim()}>Speichern</button>
    </div>
  </div>
</div>
{/if}

{#if pdfDialogOpen}
<div class="setup-backdrop" onclick={() => pdfDialogOpen = false}>
  <div class="pdf-dialog" onclick={(e) => e.stopPropagation()}>
    <div class="setup-header">
      <span>PDF exportieren</span>
      <button class="setup-close" onclick={() => pdfDialogOpen = false}>✕</button>
    </div>
    <div class="pdf-main">
      <div class="pdf-preview-area">
        {#if pdfPreviewUrl}
          <img src={pdfPreviewUrl} alt="Vorschau" style="width:100%;height:100%;object-fit:contain;display:block;">
        {:else}
          <div style="display:flex;align-items:center;justify-content:center;height:100%;color:#556070;font-size:13px;">Vorschau wird erstellt…</div>
        {/if}
      </div>
      <div class="pdf-sidebar">
        <div class="pdf-sidebar-section">
          <div class="pdf-sidebar-label">Seite</div>
          <div class="pdf-sidebar-row">
            <span>Breite</span><span>{setupBreite} mm</span>
          </div>
          <div class="pdf-sidebar-row">
            <span>Höhe</span><span>{setupHoehe} mm</span>
          </div>
          <div class="pdf-sidebar-row">
            <span>Einheit</span><span>{setupEinheit}</span>
          </div>
          <div class="pdf-sidebar-row">
            <span>Hintergrund</span>
            <span class="pdf-color-dot" style="background:{setupHintergrundTransp ? 'transparent' : setupHintergrund};border:1px solid #3a4a5c;"></span>
          </div>
        </div>
        <div class="pdf-sidebar-section">
          <div class="pdf-sidebar-label">Ebenen</div>
          {#each ebenen.filter(e => e.name !== 'Raster') as e}
            <div class="pdf-sidebar-row" class:pdf-layer-hidden={!e.sichtbar}>
              <span>{e.name}</span>
              <span>{e.sichtbar ? 'sichtbar' : 'ausgeblendet'}</span>
            </div>
          {/each}
        </div>
        <div class="pdf-sidebar-section">
          <div class="pdf-sidebar-label">Auflösung</div>
          <div class="pdf-dpi-picker">
            {#each [72, 96, 150, 300, 600] as dpi}
              <button class="pdf-dpi-btn" class:pdf-dpi-active={pdfDpi === dpi}
                onclick={() => pdfDpi = dpi}>{dpi}</button>
            {/each}
          </div>
          <div class="pdf-sidebar-row" style="margin-top:4px;">
            <span>DPI</span><span>{pdfDpi}</span>
          </div>
        </div>
        <div class="pdf-sidebar-section">
          <div class="pdf-sidebar-label">Objekte</div>
          <div class="pdf-sidebar-row">
            <span>Gesamt</span><span>{objects.length}</span>
          </div>
          <div class="pdf-sidebar-row">
            <span>Exportiert</span>
            <span>{objects.filter(o => ebenen.find(e => e.name === o.ebene)?.sichtbar).length}</span>
          </div>
        </div>
      </div>
    </div>
    <div class="setup-footer" style="gap:10px;">
      <button class="btn-cancel" onclick={() => pdfDialogOpen = false}>Abbrechen</button>
      <button class="btn-ok" disabled={pdfExporting} onclick={doExportPdf}>
        {pdfExporting ? 'Exportiert…' : 'PDF exportieren'}
      </button>
    </div>
  </div>
</div>
{/if}

<!-- ── Page Setup Dialog ──────────────────────────────────────────────────── -->
{#if pageSetupOpen}
<div class="setup-backdrop">
  <div class="setup-dialog">
    <div class="setup-header">
      <button class="setup-close-round" onclick={() => pageSetupOpen = false} title="Schließen">×</button>
      <span class="setup-title">Neues Dokument</span>
    </div>

    <div class="setup-body">
      <div class="template-grid">
        {#each NEW_DOC_TEMPLATES as tpl}
          <button class="template-card" class:template-active={setupTemplate === tpl.id} onclick={() => chooseNewDocTemplate(tpl.id)}>
            <span class="template-preview {tpl.cls}">
              <span>{tpl.title}</span>
            </span>
            <span class="template-label">{tpl.label}</span>
          </button>
        {/each}
      </div>
    </div>

    <div class="setup-options">
      <div class="setup-options-left">
        <div class="setup-line">
          <label>Voreinstellung:</label>
          <select class="setup-select" onchange={(ev) => {
            const f = FORMATS[(ev.currentTarget as HTMLSelectElement).selectedIndex];
            if (f) { setupBreite = f.w; setupHoehe = f.h; }
          }}>
            {#each FORMATS as f}
              <option selected={!f.px && setupBreite === f.w && setupHoehe === f.h}>{f.label}</option>
            {/each}
          </select>
        </div>
        <div class="setup-line">
          <label>Farbmodus:</label>
          <select class="setup-select setup-color-mode">
            <option>RGB</option>
          </select>
          <input id="s-hg" type="color" class="setup-color" bind:value={setupHintergrund} disabled={setupHintergrundTransp} />
          <input id="s-farbe" type="color" class="setup-color" bind:value={setupFarbe} />
        </div>
      </div>

      <div class="setup-options-right">
        <div class="setup-line">
          <label>Breite:</label>
          <input class="setup-number-bright" type="number" min="0.1" max="9999" step="0.1"
            value={setupSizeDisplay(setupBreite)}
            oninput={(ev) => setSetupSize('w', (ev.currentTarget as HTMLInputElement).value)} />
          <select class="setup-unit-select" bind:value={setupSizeUnit}>
            <option value="cm">cm</option>
            <option value="mm">mm</option>
            <option value="px">px</option>
          </select>
        </div>
        <div class="setup-line">
          <label>Höhe:</label>
          <input class="setup-number-bright" type="number" min="0.1" max="9999" step="0.1"
            value={setupSizeDisplay(setupHoehe)}
            oninput={(ev) => setSetupSize('h', (ev.currentTarget as HTMLInputElement).value)} />
          <select class="setup-unit-select" bind:value={setupSizeUnit}>
            <option value="cm">cm</option>
            <option value="mm">mm</option>
            <option value="px">px</option>
          </select>
        </div>
      </div>
    </div>

    <div class="setup-footer">
      <button class="btn-open-existing" onclick={() => { pageSetupOpen = false; void fileOpen(); }}>
        Existierende Datei öffnen ...
      </button>
      <span class="setup-footer-spacer"></span>
      <button class="btn-cancel" onclick={() => pageSetupOpen = false}>Abbrechen</button>
      <button
        class="btn-ok"
        onclick={applySetup}
        disabled={!setupBreite || !setupHoehe}
      >
        Auswählen
      </button>
    </div>
  </div>
</div>
{/if}

<!-- ── Main App ────────────────────────────────────────────────────────────── -->
<div class="startup-screen" class:startup-hidden={appVisible}>
  <div class="startup-logo">V</div>
  <div class="startup-name">Vecstructi</div>
  <div class="startup-version">Version {APP_INFO.version}</div>
</div>

<div class="app" class:app-fadein={appVisible}>

  <!-- Header -->
  <header class="app-header">
    <!-- Menüleiste -->
    <nav class="menubar">

      <!-- Vecstructi-Menü -->
      <div class="menu-item" class:menu-item-open={vecstructiMenuOffen}>
        <button class="menu-trigger" onclick={() => { const wasOpen = vecstructiMenuOffen; closeAllMenus(); vecstructiMenuOffen = !wasOpen; }}>
          Vecstructi
        </button>
        {#if vecstructiMenuOffen}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="menu-backdrop" onclick={() => vecstructiMenuOffen = false}></div>
          <ul class="menu-dropdown">
            <li>
              <button class="menu-cmd" onclick={() => { closeAllMenus(); aboutDialogOpen = true; }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 10v7"/><path d="M12 7h.01"/></svg>
                Über
              </button>
            </li>
            <li>
              <button class="menu-cmd" onclick={async () => { closeAllMenus(); formenSetupPfad = await shapesFilePath(); formenSetupStatus = ''; formenSetupOpen = true; }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                Setup…
              </button>
            </li>
            <li class="menu-sep"></li>
            <li>
              <button class="menu-cmd" onclick={() => { closeAllMenus(); getCurrentWebviewWindow().close(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                Beenden
                <span class="menu-shortcut">⌘Q</span>
              </button>
            </li>
          </ul>
        {/if}
      </div>

      <!-- Datei-Menü -->
      <div class="menu-item" class:menu-item-open={dateiMenuOffen}>
        <button class="menu-trigger" onclick={() => { const wasOpen = dateiMenuOffen; closeAllMenus(); dateiMenuOffen = !wasOpen; }}>
          Datei
        </button>
        {#if dateiMenuOffen}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="menu-backdrop" onclick={() => dateiMenuOffen = false}></div>
          <ul class="menu-dropdown">
            <li>
              <button class="menu-cmd" onclick={() => { dateiMenuOffen = false; fileNew(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                Neu
                <span class="menu-shortcut">⌘N</span>
              </button>
            </li>
            <li>
              <button class="menu-cmd" onclick={() => { dateiMenuOffen = false; fileOpen(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                Öffnen…
                <span class="menu-shortcut">⌘O</span>
              </button>
            </li>
            <li>
              <button class="menu-cmd" disabled={canvasW <= 0 || canvasH <= 0} onclick={() => { dateiMenuOffen = false; fileImport(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>
                Importieren…
              </button>
            </li>
            <li class="menu-sep"></li>
            <li>
              <button class="menu-cmd" class:menu-cmd-unsaved={unsaved} onclick={() => { dateiMenuOffen = false; fileSave(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                Speichern{unsaved ? ' ●' : ''}
                <span class="menu-shortcut">⌘S</span>
              </button>
            </li>
            <li>
              <button class="menu-cmd" onclick={() => { dateiMenuOffen = false; fileSaveAs(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                Speichern unter…
                <span class="menu-shortcut">⇧⌘S</span>
              </button>
            </li>
            <li class="menu-sep"></li>
            <li>
              <button class="menu-cmd" onclick={() => { dateiMenuOffen = false; openPdfDialog(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><text x="6" y="19" font-size="6" fill="currentColor" stroke="none" font-family="sans-serif">PDF</text></svg>
                PDF exportieren…
              </button>
            </li>
            <li class="menu-sep"></li>
            <li>
              <button class="menu-cmd" onclick={() => { dateiMenuOffen = false; fileClose(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 6L6 18M6 6l12 12"/></svg>
                Schließen
                <span class="menu-shortcut">⌘W</span>
              </button>
            </li>
          </ul>
        {/if}
      </div>

      <!-- Bearbeiten-Menü -->
      <div class="menu-item" class:menu-item-open={bearbeitenMenuOffen}>
        <button class="menu-trigger" onclick={() => { const wasOpen = bearbeitenMenuOffen; closeAllMenus(); bearbeitenMenuOffen = !wasOpen; }}>
          Bearbeiten
        </button>
        {#if bearbeitenMenuOffen}
          <div class="menu-backdrop" onclick={() => bearbeitenMenuOffen = false}></div>
          <ul class="menu-dropdown">
            <li>
              <button class="menu-cmd" disabled={!undoStack.length} onclick={() => { bearbeitenMenuOffen = false; undo(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
                Rückgängig
                <span class="menu-shortcut">⌘Z</span>
              </button>
            </li>
            <li>
              <button class="menu-cmd" disabled={!redoStack.length} onclick={() => { bearbeitenMenuOffen = false; redo(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>
                Wiederholen
                <span class="menu-shortcut">⌘Y</span>
              </button>
            </li>
            <li class="menu-sep"></li>
            <li>
              <button class="menu-cmd" disabled={!selectedObjs.length} onclick={() => { bearbeitenMenuOffen = false; editCut(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="6" cy="20" r="2"/><circle cx="6" cy="4" r="2"/><line x1="6" y1="6" x2="6" y2="18"/><line x1="6" y1="12" x2="20" y2="4"/><line x1="6" y1="12" x2="20" y2="20"/></svg>
                Ausschneiden
                <span class="menu-shortcut">⌘X</span>
              </button>
            </li>
            <li>
              <button class="menu-cmd" disabled={!selectedObjs.length} onclick={() => { bearbeitenMenuOffen = false; editCopy(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                Kopieren
                <span class="menu-shortcut">⌘C</span>
              </button>
            </li>
            <li>
              <button class="menu-cmd" disabled={!clipboard.length} onclick={() => { bearbeitenMenuOffen = false; editPaste(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
                Einfügen
                <span class="menu-shortcut">⌘V</span>
              </button>
            </li>
            <li>
              <button class="menu-cmd" disabled={!selectedObjs.length} onclick={() => { bearbeitenMenuOffen = false; openMultiPaste(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
                Mehrfach einfügen…
                <span class="menu-shortcut">⌘⌥V</span>
              </button>
            </li>
            <li class="menu-sep"></li>
            <li>
              <button class="menu-cmd" disabled={!objects.length} onclick={() => { bearbeitenMenuOffen = false; selectAll(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 2"/></svg>
                Alles auswählen
                <span class="menu-shortcut">⌘A</span>
              </button>
            </li>
            <li>
              <button class="menu-cmd" disabled={!selectedObj} onclick={() => { bearbeitenMenuOffen = false; selectedObj = null; }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>
                Alles abwählen
                <span class="menu-shortcut">Esc</span>
              </button>
            </li>
          </ul>
        {/if}
      </div>

      <!-- Anordnen-Menü -->
      <div class="menu-item" class:menu-item-open={anordnenMenuOffen}>
        <button class="menu-trigger" onclick={() => { const wasOpen = anordnenMenuOffen; closeAllMenus(); anordnenMenuOffen = !wasOpen; }}>
          Anordnen
        </button>
        {#if anordnenMenuOffen}
          <div class="menu-backdrop" onclick={() => anordnenMenuOffen = false}></div>
          <ul class="menu-dropdown">
            <li>
              <button class="menu-cmd" disabled={!selectedObjs.length} onclick={() => { closeAllMenus(); arrangeStep(1); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="8" width="13" height="13" rx="1"/><rect x="8" y="3" width="13" height="13" rx="1" opacity=".4"/><path d="M12 14v-4M10 12l2-2 2 2"/></svg>
                Schrittweise nach vorn
                <span class="menu-shortcut">⌘]</span>
              </button>
            </li>
            <li>
              <button class="menu-cmd" disabled={!selectedObjs.length} onclick={() => { closeAllMenus(); arrangeStep(-1); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="8" y="3" width="13" height="13" rx="1"/><rect x="3" y="8" width="13" height="13" rx="1" opacity=".4"/><path d="M12 10v4M10 12l2 2 2-2"/></svg>
                Schrittweise nach hinten
                <span class="menu-shortcut">⌘[</span>
              </button>
            </li>
            <li>
              <button class="menu-cmd" disabled={!selectedObjs.length} onclick={() => { closeAllMenus(); arrangeToFront(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="8" width="13" height="13" rx="1"/><rect x="8" y="3" width="13" height="13" rx="1" opacity=".3"/><path d="M12 17V9M9 12l3-3 3 3"/></svg>
                Ganz nach vorne
                <span class="menu-shortcut">⌘⇧]</span>
              </button>
            </li>
            <li>
              <button class="menu-cmd" disabled={!selectedObjs.length} onclick={() => { closeAllMenus(); arrangeToBack(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="8" y="3" width="13" height="13" rx="1"/><rect x="3" y="8" width="13" height="13" rx="1" opacity=".3"/><path d="M12 7v8M9 12l3 3 3-3"/></svg>
                Ganz nach hinten
                <span class="menu-shortcut">⌘⇧[</span>
              </button>
            </li>
            <li class="menu-sep"></li>
            <li>
              <button class="menu-cmd" disabled={selectedObjs.length < 2} onclick={() => { closeAllMenus(); arrangeGroup(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="2" width="8" height="8" rx="1"/><rect x="2" y="14" width="8" height="8" rx="1"/><rect x="14" y="14" width="8" height="8" rx="1"/><rect x="5" y="5" width="14" height="14" rx="1" stroke-dasharray="3 2"/></svg>
                Gruppieren
                <span class="menu-shortcut">⌘G</span>
              </button>
            </li>
            <li>
              <button class="menu-cmd" disabled={!selectedObjs.some(o => o.groupId)} onclick={() => { closeAllMenus(); arrangeUngroup(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="2" width="8" height="8" rx="1"/><rect x="2" y="14" width="8" height="8" rx="1"/><rect x="14" y="14" width="8" height="8" rx="1"/></svg>
                Gruppierung aufheben
                <span class="menu-shortcut">⌘⇧G</span>
              </button>
            </li>
            <li class="menu-sep"></li>
            <li>
              <button class="menu-cmd" disabled={!selectedObjs.length} onclick={() => { closeAllMenus(); arrangeProtect(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                Schützen
              </button>
            </li>
            <li>
              <button class="menu-cmd" disabled={!selectedObjs.some(o => (o as any).gesperrt)} onclick={() => { closeAllMenus(); arrangeUnprotect(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="8" y1="12" x2="16" y2="12" stroke-dasharray="2 1"/></svg>
                Schutz aufheben
              </button>
            </li>
          </ul>
        {/if}
      </div>

      <!-- Ansicht-Menü -->
      <div class="menu-item" class:menu-item-open={ansichtMenuOffen}>
        <button class="menu-trigger" onclick={() => { const wasOpen = ansichtMenuOffen; closeAllMenus(); ansichtMenuOffen = !wasOpen; }}>
          Ansicht
        </button>
        {#if ansichtMenuOffen}
          <div class="menu-backdrop" onclick={() => ansichtMenuOffen = false}></div>
          <ul class="menu-dropdown">
            <li>
              <button class="menu-cmd" onclick={() => { closeAllMenus(); zoomIn(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>
                Vergrößern
                <span class="menu-shortcut">⌘+</span>
              </button>
            </li>
            <li>
              <button class="menu-cmd" onclick={() => { closeAllMenus(); zoomOut(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><line x1="8" y1="11" x2="14" y2="11"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>
                Verkleinern
                <span class="menu-shortcut">⌘-</span>
              </button>
            </li>
            <li>
              <button class="menu-cmd" onclick={() => { closeAllMenus(); fitToWindow(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M8 3v3H3M16 3v3h5M8 21v-3H3M16 21v-3h5"/></svg>
                Größe an Fenster anpassen
              </button>
            </li>
            <li>
              <button class="menu-cmd" disabled={canvasW <= 0 || canvasH <= 0} onclick={() => { closeAllMenus(); void fitDocumentWindowToPage(true); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="5" width="16" height="14" rx="1"/><path d="M8 9h8v6H8z"/><path d="M4 9H2M4 15H2M20 9h2M20 15h2"/></svg>
                Appfenster an Dokument anpassen
              </button>
            </li>
            <li>
              <button class="menu-cmd" onclick={() => { closeAllMenus(); zoomPercent = 100; }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/><text x="8" y="14.5" font-size="7" fill="currentColor" stroke="none" font-family="system-ui">1:1</text></svg>
                Auf tatsächliche Größe zoomen
                <span class="menu-shortcut">⌘0</span>
              </button>
            </li>
            <li class="menu-sep"></li>
            <li>
              <button class="menu-cmd" onclick={() => { closeAllMenus(); linealSichtbar = !linealSichtbar; updateRulerVisible(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="7" width="20" height="10" rx="1"/><line x1="6" y1="7" x2="6" y2="12"/><line x1="10" y1="7" x2="10" y2="10"/><line x1="14" y1="7" x2="14" y2="10"/><line x1="18" y1="7" x2="18" y2="12"/></svg>
                Lineale ausblenden
                {#if !linealSichtbar}<svg class="menu-check" viewBox="0 0 16 16" fill="currentColor"><path d="M2 8l4 4 8-8" stroke="currentColor" stroke-width="2" fill="none"/></svg>{/if}
              </button>
            </li>
            <li>
              <button class="menu-cmd" onclick={() => { closeAllMenus(); rasterEinblenden = !rasterEinblenden; const re = ebenen.find(e => e.name === 'Raster'); if (re) re.sichtbar = rasterEinblenden; updateRaster(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="1"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg>
                Raster ausblenden
                {#if !rasterEinblenden}<svg class="menu-check" viewBox="0 0 16 16" fill="currentColor"><path d="M2 8l4 4 8-8" stroke="currentColor" stroke-width="2" fill="none"/></svg>{/if}
              </button>
            </li>
            <li>
              <button class="menu-cmd" onclick={() => { closeAllMenus(); rasterAusrichten = !rasterAusrichten; updateRaster(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="1" stroke-dasharray="3 2"/><circle cx="9" cy="9" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.5" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.5" fill="currentColor" stroke="none"/></svg>
                Am Raster ausrichten
                {#if rasterAusrichten}<svg class="menu-check" viewBox="0 0 16 16" fill="currentColor"><path d="M2 8l4 4 8-8" stroke="currentColor" stroke-width="2" fill="none"/></svg>{/if}
              </button>
            </li>
            <li class="menu-sep"></li>
            <li>
              <button class="menu-cmd" onclick={() => { closeAllMenus(); toggleVollbild(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
                Vollbildmodus
                {#if vollbild}<svg class="menu-check" viewBox="0 0 16 16" fill="currentColor"><path d="M2 8l4 4 8-8" stroke="currentColor" stroke-width="2" fill="none"/></svg>{/if}
              </button>
            </li>
          </ul>
        {/if}
      </div>

      <!-- Hilfe-Menü -->
      <div class="menu-item" class:menu-item-open={hilfeMenuOffen}>
        <button class="menu-trigger" onclick={() => { const wasOpen = hilfeMenuOffen; closeAllMenus(); hilfeMenuOffen = !wasOpen; }}>
          Hilfe
        </button>
        {#if hilfeMenuOffen}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="menu-backdrop" onclick={() => hilfeMenuOffen = false}></div>
          <ul class="menu-dropdown">
            <li>
              <button class="menu-cmd" onclick={() => { closeAllMenus(); openHelpWindow(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 10v7"/><path d="M12 7h.01"/></svg>
                Hilfe anzeigen
              </button>
            </li>
          </ul>
        {/if}
      </div>

    </nav>

    <!-- Dateiname & Unsaved-Punkt -->
    <div class="header-right">
      {#if currentFile}
        <span class="header-filename">
          {currentFile.split('/').pop()?.split('\\').pop()}{unsaved ? ' ●' : ''}
        </span>
      {/if}
    </div>
  </header>

  <!-- Workspace -->
  <div class="workspace">

    <!-- Left: Object Toolbar -->
    <aside class="obj-bar" aria-label="Objekte">
      <div class="tool-grid">
        {#each TOOLS as tool}
          <div class="tool-btn-wrap" style="position:relative;">
          <button
            class="tool-btn"
            class:tool-active={activeTool === tool.id || (tool.id === 'image' && imagePickerOpen) || (tool.id === 'measure' && measurePickerOpen)}
            title={tool.title}
            onclick={(ev) => {
              if (tool.id === 'image') {
                imagePickerOpen = !imagePickerOpen;
                imagePickerX = ev.clientX;
                imagePickerY = ev.clientY;
              } else if (tool.id === 'rotate') {
                activeTool = 'rotate';
                imagePickerOpen = false;
                textEditUid = null;
                propTab = 'geo';
                rotateSelectedBy(rotateStep * rotateDir);
              } else if (tool.id === 'gradient') {
                activeTool = 'select';
                imagePickerOpen = false;
                textEditUid = null;
                propTab = 'fill';
              } else if (tool.id === 'fill-tool') {
                activeTool = 'fill-tool';
                imagePickerOpen = false;
                textEditUid = null;
                propTab = 'fill';
              } else if (tool.id === 'measure') {
                measurePickerOpen = !measurePickerOpen;
                measurePickerX = ev.clientX;
                measurePickerY = ev.clientY;
                imagePickerOpen = false;
                textEditUid = null;
              } else {
                activeTool = tool.id;
                imagePickerOpen = false;
                if (tool.id !== 'text') textEditUid = null;
                selectedObj = null;
                selectedObjs = [];
                measuringLine = null;
                propTab = 'geo';
                setToolDefaults(tool.id);
              }
            }}
          >
            {#if tool.icon === 'select'}
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 2l16 9.5-7.5 1.5-4 7z"/></svg>
            {:else if tool.icon === 'direct'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 2l16 9.5-7.5 1.5-4 7z"/></svg>
            {:else if tool.icon === 'brush'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <!-- Griff -->
                <line x1="20" y1="3" x2="10" y2="13"/>
                <!-- Zwinge -->
                <rect x="7.5" y="12.5" width="4" height="3" rx="0.5" transform="rotate(-45 9.5 14)"/>
                <!-- Borsten (Spitze) -->
                <path d="M5 15 C2 16 2 20 4 22 C6 21 9 19 10 16 Z"/>
              </svg>
            {:else if tool.icon === 'pencil'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
            {:else if tool.icon === 'eraser'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 17 L9 5 L19 11 L12 23 Z"/>
                <line x1="5.5" y1="11" x2="15.5" y2="17"/>
                <line x1="2" y1="23" x2="22" y2="23"/>
              </svg>
            {:else if tool.icon === 'text'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="4" y1="6" x2="20" y2="6"/><line x1="12" y1="6" x2="12" y2="20"/></svg>
            {:else if tool.icon === 'line'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="4" y1="20" x2="20" y2="4"/></svg>
            {:else if tool.icon === 'arc'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20 Q20 4 20 20" fill="none"/></svg>
            {:else if tool.icon === 'rect'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14"/></svg>
            {:else if tool.icon === 'roundrect'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="4"/></svg>
            {:else if tool.icon === 'ellipse'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="12" rx="9" ry="7"/></svg>
            {:else if tool.icon === 'polygon'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="12,3 21,8.5 21,15.5 12,21 3,15.5 3,8.5"/></svg>
            {:else if tool.icon === 'star'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21,15 16,10 5,21"/></svg>
            {:else if tool.icon === 'rotate'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 .49-5.34"/></svg>
            {:else if tool.icon === 'frame'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18"/><rect x="7" y="7" width="10" height="10"/></svg>
            {:else if tool.icon === 'wall'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
                <path d="M3 7H17V17H21"/>
                <path d="M3 11H13V21H21"/>
                <path d="M6 7l-2 4M10 7l-2 4M14 7l-2 4M16 11l-3 5M17 15l-4 6"/>
              </svg>
            {:else if tool.icon === 'hand'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 11V8a2 2 0 0 0-4 0v3"/><path d="M14 10V6a2 2 0 0 0-4 0v4"/><path d="M10 10V5a2 2 0 0 0-4 0v9l-1-1a2 2 0 0 0-2.73.73L3 14l4 4a6 6 0 0 0 6 0v-3a2 2 0 0 0-2-2h-1"/></svg>
            {:else if tool.icon === 'gradient'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                <defs>
                  <linearGradient id="toolbar-gradient-icon" x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
                    <stop offset="0" stop-color="currentColor" stop-opacity=".15"/>
                    <stop offset="1" stop-color="currentColor"/>
                  </linearGradient>
                </defs>
                <rect x="4" y="4" width="16" height="16" rx="2" fill="url(#toolbar-gradient-icon)"/>
                <path d="M5 19L19 5"/>
              </svg>
            {:else if tool.icon === 'fill'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round">
                <path d="M5 12l7-7 7 7-7 7z"/>
                <path d="M8 12h8"/>
                <path d="M19 16c1.4 1.5 2 2.6 2 3.5a2 2 0 0 1-4 0c0-.9.6-2 2-3.5z" fill="currentColor" stroke="none"/>
              </svg>
            {:else if tool.icon === 'measure'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <line x1="3" y1="12" x2="21" y2="12"/>
                <polyline points="6,8 3,12 6,16"/>
                <polyline points="18,8 21,12 18,16"/>
                <line x1="8" y1="9" x2="8" y2="15" stroke-width="1.2"/>
                <line x1="12" y1="9" x2="12" y2="15" stroke-width="1.2"/>
                <line x1="16" y1="9" x2="16" y2="15" stroke-width="1.2"/>
              </svg>
            {:else if tool.icon === 'zoom'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            {/if}
          </button>
          </div><!-- tool-btn-wrap -->
        {/each}
      </div>

      <!-- Farb-Swatches -->
      <div class="color-swatches">
        <button class="swatch-fill" title="Füllfarbe"
          style="background:{cssFillForValue(objFill)};"
          onclick={() => propTab = 'fill'}>
          {#if objFill === 'none'}
            <span class="swatch-none"></span>
          {/if}
          <input type="color" class="swatch-color-input" value={parseGradientValue(objFill) || objFill === 'none' ? gradientStart : objFill}
            onchange={(e) => { objFill = (e.target as HTMLInputElement).value; syncObjFromProps(); }}/>
        </button>
        <button class="swatch-stroke" title="Konturfarbe"
          style="border-color:{objStroke === 'none' || objStroke === '' ? '#000000' : objStroke};"
          onclick={() => propTab = 'fill'}>
          {#if objStroke === 'none' || objStroke === ''}
            <span class="swatch-none"></span>
          {/if}
          <input type="color" class="swatch-color-input" value={objStroke === 'none' || objStroke === '' ? '#000000' : objStroke}
            onchange={(e) => { objStroke = (e.target as HTMLInputElement).value; syncObjFromProps(); }}/>
        </button>
        <button class="swatch-reset" title="Standard zurücksetzen" onclick={resetFillStrokeDefaults}>↺</button>
      </div>

      {#if selectedObjs.length}
        <button class="delete-btn" title="Markierte Objekte löschen" onclick={deleteSelectedObjects}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
          </svg>
        </button>
      {/if}
    </aside>

    <!-- Center: Canvas -->
    <main class="canvas-area" bind:this={canvasAreaEl}>

      <!-- Transform-Bar -->
      <div class="tbar">
        <!-- Objekt-Icon -->
        <svg class="tbar-icon" viewBox="0 0 16 16" fill="currentColor">
          <rect x="1" y="1" width="5" height="5" rx="1" opacity=".5"/>
          <rect x="10" y="1" width="5" height="5" rx="1" opacity=".5"/>
          <rect x="1" y="10" width="5" height="5" rx="1" opacity=".5"/>
          <rect x="10" y="10" width="5" height="5" rx="1"/>
        </svg>

        <span class="tbar-label">X:</span>
        <div class="tbar-spinner">
          <button class="tbar-arr" onclick={() => stepNum('propX', unitStep)}>▲</button>
          <input type="number" step={unitStep} class="tbar-input" bind:value={propX} onchange={syncObjFromProps}/>
          <span class="tbar-unit">{einheit}</span>
          <button class="tbar-arr" onclick={() => stepNum('propX', -unitStep)}>▼</button>
        </div>

        <span class="tbar-label">Y:</span>
        <div class="tbar-spinner">
          <button class="tbar-arr" onclick={() => stepNum('propY', unitStep)}>▲</button>
          <input type="number" step={unitStep} class="tbar-input" bind:value={propY} onchange={syncObjFromProps}/>
          <span class="tbar-unit">{einheit}</span>
          <button class="tbar-arr" onclick={() => stepNum('propY', -unitStep)}>▼</button>
        </div>

        <div class="tbar-sep"></div>

        <!-- Breite-Icon -->
        <svg class="tbar-dim-icon" viewBox="0 0 16 10" fill="none" stroke="currentColor" stroke-width="1.4">
          <line x1="0" y1="5" x2="16" y2="5"/>
          <line x1="0" y1="2" x2="0" y2="8"/>
          <line x1="16" y1="2" x2="16" y2="8"/>
        </svg>
        <div class="tbar-spinner">
          <button class="tbar-arr" onclick={() => stepNum('propW', unitStep)}>▲</button>
          <input type="number" step={unitStep} class="tbar-input" bind:value={propW} onchange={onPropWChange}/>
          <span class="tbar-unit">{einheit}</span>
          <button class="tbar-arr" onclick={() => stepNum('propW', -unitStep)}>▼</button>
        </div>

        <!-- Lock -->
        <button class="tbar-lock" class:tbar-lock-on={propLock} onclick={() => propLock = !propLock} title="Seitenverhältnis sperren">
          {#if propLock}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
          {:else}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.29-1.29"/></svg>
          {/if}
        </button>

        <!-- Höhe-Icon -->
        <svg class="tbar-dim-icon tbar-dim-icon-v" viewBox="0 0 10 16" fill="none" stroke="currentColor" stroke-width="1.4">
          <line x1="5" y1="0" x2="5" y2="16"/>
          <line x1="2" y1="0" x2="8" y2="0"/>
          <line x1="2" y1="16" x2="8" y2="16"/>
        </svg>
        <div class="tbar-spinner">
          <button class="tbar-arr" onclick={() => stepNum('propH', unitStep)}>▲</button>
          <input type="number" step={unitStep} class="tbar-input" bind:value={propH} onchange={onPropHChange}/>
          <span class="tbar-unit">{einheit}</span>
          <button class="tbar-arr" onclick={() => stepNum('propH', -unitStep)}>▼</button>
        </div>
      </div>

      <div class="canvas-body" style="--ruler:{rulerPx}px">

        <!-- Ecke oben-links -->
        {#if linealSichtbar}<div class="ruler-corner">{einheit}</div>{/if}

        <!-- Horizontales Lineal -->
        {#if linealSichtbar}
        <div class="ruler-h-wrap">
          <svg class="ruler-svg" width={canvasW * zoomFactor} height={RULER_PX} style="display:block">
            <g transform="translate({-scrollX}, 0)">
              <rect width={canvasW * zoomFactor} height={RULER_PX} fill="#222"/>
              {#each rulerTicksH as t}
                <line x1={t.x * zoomFactor} y1={RULER_PX - 10} x2={t.x * zoomFactor} y2={RULER_PX} stroke="#777" stroke-width="1"/>
                {#if t.x + tickStepPx.h / 2 <= canvasW}
                  <line x1={(t.x + tickStepPx.h / 2) * zoomFactor} y1={RULER_PX - 5} x2={(t.x + tickStepPx.h / 2) * zoomFactor} y2={RULER_PX} stroke="#5c5c5c" stroke-width="1"/>
                {/if}
                {#if t.label}
                  <text x={t.x * zoomFactor + 2} y={RULER_PX - 10} font-size="9" fill="#a8a8a8" font-family="system-ui,sans-serif">{t.label}</text>
                {/if}
              {/each}
              <line x1="0" y1={RULER_PX - 1} x2={canvasW * zoomFactor} y2={RULER_PX - 1} stroke="#333" stroke-width="1"/>
            </g>
          </svg>
        </div>
        {/if}

        <!-- Vertikales Lineal -->
        {#if linealSichtbar}
        <div class="ruler-v-wrap">
          <svg class="ruler-svg" width={RULER_PX} height={canvasH * zoomFactor} style="display:block">
            <g transform="translate(0, {-scrollY})">
              <rect width={RULER_PX} height={canvasH * zoomFactor} fill="#222"/>
              {#each rulerTicksV as t}
                <line x1={RULER_PX - 10} y1={t.y * zoomFactor} x2={RULER_PX} y2={t.y * zoomFactor} stroke="#777" stroke-width="1"/>
                {#if t.y + tickStepPx.v / 2 <= canvasH}
                  <line x1={RULER_PX - 5} y1={(t.y + tickStepPx.v / 2) * zoomFactor} x2={RULER_PX} y2={(t.y + tickStepPx.v / 2) * zoomFactor} stroke="#5c5c5c" stroke-width="1"/>
                {/if}
                {#if t.label}
                  <text x={-(t.y * zoomFactor + 2)} y={RULER_PX - 11} font-size="9" fill="#a8a8a8" font-family="system-ui,sans-serif" transform="rotate(-90)">{t.label}</text>
                {/if}
              {/each}
              <line x1={RULER_PX - 1} y1="0" x2={RULER_PX - 1} y2={canvasH * zoomFactor} stroke="#333" stroke-width="1"/>
            </g>
          </svg>
        </div>
        {/if}

        <!-- Scroll-Bereich -->
        <div class="canvas-scroll-area" bind:this={canvasScrollAreaEl}
          onscroll={(e) => { const el = e.currentTarget as HTMLElement; scrollX = el.scrollLeft; scrollY = el.scrollTop; }}>
        {#if canvasW && canvasH}
          <div class="canvas-zoom-outer" style="width:{canvasW * zoomFactor}px; height:{canvasH * zoomFactor}px;">
            <!-- Zeichenfläche -->
            <div class="canvas-scroll" style="position:relative;width:{canvasW * zoomFactor}px;height:{canvasH * zoomFactor}px;">
            <svg
              class="canvas-frame"
              tabindex="-1"
              width={canvasW * zoomFactor}
              height={canvasH * zoomFactor}
              viewBox="0 0 {canvasW} {canvasH}"
              style="display:block;"
            >
              {#if svgRXPx > 0 && svgRYPx > 0}
                <defs>
                  <pattern id="raster-grid" width={svgRXPx} height={svgRYPx}
                    patternUnits="userSpaceOnUse"
                    x={rasterRandVersatz ? svgRandL : 0}
                    y={rasterRandVersatz ? svgRandO : 0}>
                    <path d={`M ${svgRXPx} 0 L 0 0 0 ${svgRYPx}`} fill="none" stroke={rasterFarbe} stroke-width={rasterDicke} opacity={svgROpacity}/>
                  </pattern>
                </defs>
              {/if}
              <defs>
                {#each objects as gradObj}
                  {@const grad = parseGradientValue(gradObj.fill)}
                  {#if grad}
                    {#if grad.mode === 'radial'}
                      <radialGradient id={`fill-${gradObj.uid}`} cx="50%" cy="50%" r="70%">
                        <stop offset="0%" stop-color={grad.start}/>
                        <stop offset="100%" stop-color={grad.end}/>
                      </radialGradient>
                    {:else}
                      <linearGradient id={`fill-${gradObj.uid}`} x1="0%" y1="0%" x2="100%" y2="0%" gradientTransform={`rotate(${grad.angle} .5 .5)`}>
                        <stop offset="0%" stop-color={grad.start}/>
                        <stop offset="100%" stop-color={grad.end}/>
                      </linearGradient>
                    {/if}
                  {/if}
                {/each}
              </defs>
              <!-- Hintergrund -->
              <rect width={canvasW} height={canvasH} fill={setupHintergrundTransp ? 'none' : setupHintergrund}/>
              <!-- Dokumentvorlage-Hintergrund -->
              {#if pageTemplate === 'notepad'}
                <defs>
                  <pattern id="np-lines" x="0" y={notepadTopOff} width={canvasW} height={notepadLineH} patternUnits="userSpaceOnUse">
                    <line x1="0" y1={notepadLineH} x2={canvasW} y2={notepadLineH} stroke="rgba(80,170,220,0.55)" stroke-width="1"/>
                  </pattern>
                </defs>
                <rect width={canvasW} height={canvasH} fill="url(#np-lines)" pointer-events="none"/>
                <line x1={notepadMarginX} y1="0" x2={notepadMarginX} y2={canvasH} stroke="rgba(255,70,70,0.65)" stroke-width="1" pointer-events="none"/>
              {:else if pageTemplate === 'looseleaf'}
                {@const llTopOff  = mmToPx(LOOSELEAF_TOP_OFFSET_MM)}
                {@const llHoleR   = mmToPx(LOOSELEAF_HOLE_RADIUS_MM)}
                {@const llHole1Y  = Math.round(canvasH * 0.25)}
                {@const llHole2Y  = Math.round(canvasH * 0.50)}
                {@const llHole3Y  = Math.round(canvasH * 0.75)}
                {@const llHoleCX  = Math.round(notepadMarginX / 2)}
                <defs>
                  <pattern id="ll-lines" x="0" y={llTopOff} width={canvasW} height={notepadLineH} patternUnits="userSpaceOnUse">
                    <line x1="0" y1={notepadLineH} x2={canvasW} y2={notepadLineH} stroke="rgba(80,170,220,0.36)" stroke-width="1"/>
                  </pattern>
                </defs>
                <rect width={canvasW} height={canvasH} fill="url(#ll-lines)" pointer-events="none"/>
                <line x1={notepadMarginX} y1="0" x2={notepadMarginX} y2={canvasH} stroke="rgba(255,70,70,0.65)" stroke-width="1" pointer-events="none"/>
                <circle cx={llHoleCX} cy={llHole1Y} r={llHoleR} fill="none" stroke="rgba(0,0,0,0.18)" stroke-width="1" pointer-events="none"/>
                <circle cx={llHoleCX} cy={llHole2Y} r={llHoleR} fill="none" stroke="rgba(0,0,0,0.18)" stroke-width="1" pointer-events="none"/>
                <circle cx={llHoleCX} cy={llHole3Y} r={llHoleR} fill="none" stroke="rgba(0,0,0,0.18)" stroke-width="1" pointer-events="none"/>
              {:else if pageTemplate === 'blueprint'}
                <defs>
                  <pattern id="bp-5"  width={BP5_PX}  height={BP5_PX}  patternUnits="userSpaceOnUse">
                    <path d={`M ${BP5_PX} 0 L 0 0 0 ${BP5_PX}`}   fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="0.5"/>
                  </pattern>
                  <pattern id="bp-10" width={BP10_PX} height={BP10_PX} patternUnits="userSpaceOnUse">
                    <path d={`M ${BP10_PX} 0 L 0 0 0 ${BP10_PX}`} fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="1"/>
                  </pattern>
                </defs>
                <rect width={canvasW} height={canvasH} fill="url(#bp-5)"  pointer-events="none"/>
                <rect width={canvasW} height={canvasH} fill="url(#bp-10)" pointer-events="none"/>
              {:else if pageTemplate === 'graph'}
                <defs>
                  <pattern id="mm-1"  width={MM1_PX}  height={MM1_PX}  patternUnits="userSpaceOnUse">
                    <path d={`M ${MM1_PX} 0 L 0 0 0 ${MM1_PX}`}  fill="none" stroke="rgba(86,190,88,0.20)" stroke-width="0.4"/>
                  </pattern>
                  <pattern id="mm-5"  width={MM5_PX}  height={MM5_PX}  patternUnits="userSpaceOnUse">
                    <path d={`M ${MM5_PX} 0 L 0 0 0 ${MM5_PX}`}  fill="none" stroke="rgba(86,190,88,0.40)" stroke-width="0.5"/>
                  </pattern>
                  <pattern id="mm-10" width={MM10_PX} height={MM10_PX} patternUnits="userSpaceOnUse">
                    <path d={`M ${MM10_PX} 0 L 0 0 0 ${MM10_PX}`} fill="none" stroke="rgba(86,190,88,0.70)" stroke-width="1"/>
                  </pattern>
                </defs>
                <rect width={canvasW} height={canvasH} fill="url(#mm-1)"  pointer-events="none"/>
                <rect width={canvasW} height={canvasH} fill="url(#mm-5)"  pointer-events="none"/>
                <rect width={canvasW} height={canvasH} fill="url(#mm-10)" pointer-events="none"/>
              {:else if pageTemplate === 'gradient'}
                <defs>
                  <linearGradient id="tpl-grad" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">
                    <stop offset="0" stop-color={setupHintergrund}/>
                    <stop offset="1" stop-color={setupFarbe}/>
                  </linearGradient>
                </defs>
                <rect width={canvasW} height={canvasH} fill="url(#tpl-grad)" pointer-events="none"/>
              {:else if pageTemplate === 'grid'}
                <defs>
                  <pattern id="gr-5"  width={BP5_PX}  height={BP5_PX}  patternUnits="userSpaceOnUse">
                    <path d={`M ${BP5_PX} 0 L 0 0 0 ${BP5_PX}`} fill="none" stroke="rgba(0,0,0,0.12)" stroke-width="0.5"/>
                  </pattern>
                  <pattern id="gr-10" width={BP10_PX} height={BP10_PX} patternUnits="userSpaceOnUse">
                    <path d={`M ${BP10_PX} 0 L 0 0 0 ${BP10_PX}`} fill="none" stroke="rgba(0,0,0,0.28)" stroke-width="1"/>
                  </pattern>
                </defs>
                <rect width={canvasW} height={canvasH} fill="url(#gr-5)"  pointer-events="none"/>
                <rect width={canvasW} height={canvasH} fill="url(#gr-10)" pointer-events="none"/>
              {:else if pageTemplate === 'lined'}
                <defs>
                  <pattern id="li-lines" x="0" y={notepadTopOff} width={canvasW} height={notepadLineH} patternUnits="userSpaceOnUse">
                    <line x1="0" y1={notepadLineH} x2={canvasW} y2={notepadLineH} stroke="rgba(100,149,220,0.50)" stroke-width="1"/>
                  </pattern>
                </defs>
                <rect width={canvasW} height={canvasH} fill="url(#li-lines)" pointer-events="none"/>
              {/if}
              <!-- Raster -->
              {#if svgRXPx > 0 && svgRYPx > 0 && rasterEinblenden}
                {#if rasterUeberRand}
                  <rect width={canvasW} height={canvasH} fill="url(#raster-grid)"/>
                {:else}
                  <rect
                    x={svgRandL} y={svgRandO}
                    width={Math.max(0, canvasW - svgRandL - svgRandR)}
                    height={Math.max(0, canvasH - svgRandO - svgRandU)}
                    fill="url(#raster-grid)"
                  />
                {/if}
              {/if}
              <!-- Objekte -->
              {#each ebenen.filter(e => e.name !== 'Raster') as e}
                {#if e.sichtbar}
                  <g opacity={(e.opacity ?? 100) / 100}>
                    {#each objects.filter(o => o.ebene === e.name) as obj}
                      {#if obj.type === 'RECHTECK'}
                        {@const cx = obj.x + obj.w/2}
                        {@const cy = obj.y + obj.h/2}
                        {@const tf = (obj.rotation || obj.shearX || obj.shearY) ? `translate(${cx},${cy}) rotate(${obj.rotation ?? 0}) skewX(${obj.shearX ?? 0}) skewY(${obj.shearY ?? 0}) translate(${-cx},${-cy})` : undefined}
                        {@const shFilter = obj.shadowEnabled ? `url(#sh-${obj.uid})` : undefined}
                        {#if obj.shadowEnabled}
                          <defs>
                            <filter id="sh-{obj.uid}" x="-50%" y="-50%" width="200%" height="200%">
                              <feDropShadow dx={obj.shadowX ?? 4} dy={obj.shadowY ?? 4} stdDeviation={obj.shadowBlur ?? 6} flood-color={obj.shadowColor ?? '#000000'} flood-opacity="0.5"/>
                            </filter>
                          </defs>
                        {/if}
                        {#if obj.isImageFrame}
                          <!-- Bildrahmen -->
                          {#if obj.imageUrl}
                            <!-- Bild mit Clip -->
                            <defs>
                              {#if obj.imageShape === 'circle'}
                                <clipPath id="cp-{obj.uid}">
                                  <path d={rectMaskPath(obj)}/>
                                </clipPath>
                              {:else}
                                <clipPath id="cp-{obj.uid}">
                                  <path d={rectMaskPath(obj)}/>
                                </clipPath>
                              {/if}
                            </defs>
                            {#if obj.imageShape === 'circle'}
                              {@const sc = obj.imageScale ?? 1}
                              {@const iw = obj.imageRenderW ?? obj.w * sc}
                              {@const ih = obj.imageRenderH ?? obj.h * sc}
                              {@const ix = obj.x + obj.w/2 - iw/2 + (obj.imageOffsetX ?? 0)}
                              {@const iy = obj.y + obj.h/2 - ih/2 + (obj.imageOffsetY ?? 0)}
                              <g transform={tf} filter={shFilter}>
                                <image href={obj.imageUrl} x={ix} y={iy} width={iw} height={ih}
                                  clip-path="url(#cp-{obj.uid})" preserveAspectRatio="xMidYMid meet"/>
                                <path d={rectMaskPath(obj)}
                                  fill="none" stroke={obj.stroke || '#6b7280'} stroke-width={obj.strokeW}
                                  stroke-dasharray={obj.strokeDash || undefined}/>
                              </g>
                            {:else}
                              {@const sc = obj.imageScale ?? 1}
                              {@const iw = obj.imageRenderW ?? obj.w * sc}
                              {@const ih = obj.imageRenderH ?? obj.h * sc}
                              {@const ix = obj.x + obj.w/2 - iw/2 + (obj.imageOffsetX ?? 0)}
                              {@const iy = obj.y + obj.h/2 - ih/2 + (obj.imageOffsetY ?? 0)}
                              <g transform={tf} filter={shFilter}>
                                <image href={obj.imageUrl} x={ix} y={iy} width={iw} height={ih}
                                  clip-path="url(#cp-{obj.uid})" preserveAspectRatio="xMidYMid meet"/>
                                <path d={rectMaskPath(obj)}
                                  fill="none" stroke={obj.stroke || '#6b7280'} stroke-width={obj.strokeW}
                                  stroke-dasharray={obj.strokeDash || undefined}/>
                              </g>
                            {/if}
                          {:else}
                          <!-- Placeholder: gestrichelter Rahmen + Kreuz + Berg-Icon -->
                          <g transform={tf} filter={shFilter}>
                            {#if obj.imageShape === 'circle'}
                              <ellipse cx={obj.x + obj.w/2} cy={obj.y + obj.h/2} rx={obj.w/2} ry={obj.h/2}
                                fill="none" stroke={obj.stroke || '#6b7280'} stroke-width={obj.strokeW} stroke-dasharray={obj.strokeDash || '6 3'}/>
                              <line x1={obj.x} y1={obj.y} x2={obj.x+obj.w} y2={obj.y+obj.h} stroke={obj.stroke || '#6b7280'} stroke-width="1" opacity=".4"/>
                              <line x1={obj.x+obj.w} y1={obj.y} x2={obj.x} y2={obj.y+obj.h} stroke={obj.stroke || '#6b7280'} stroke-width="1" opacity=".4"/>
                            {:else}
                              <path d={roundRectPath(obj.x, obj.y, obj.w, obj.h, obj.radiusOL, obj.radiusOR, obj.radiusUL, obj.radiusUR, obj.cornerStyle ?? 'round')}
                                fill="none" stroke={obj.stroke || '#6b7280'} stroke-width={obj.strokeW} stroke-dasharray={obj.strokeDash || '6 3'}
                                />
                              <line x1={obj.x} y1={obj.y} x2={obj.x+obj.w} y2={obj.y+obj.h} stroke={obj.stroke || '#6b7280'} stroke-width="1" opacity=".4"/>
                              <line x1={obj.x+obj.w} y1={obj.y} x2={obj.x} y2={obj.y+obj.h} stroke={obj.stroke || '#6b7280'} stroke-width="1" opacity=".4"/>
                            {/if}
                            <!-- Berg-Icon in der Mitte -->
                            <polyline
                              points="{obj.x+obj.w/2-9},{obj.y+obj.h/2+9} {obj.x+obj.w/2-9+7},{obj.y+obj.h/2} {obj.x+obj.w/2-9+11},{obj.y+obj.h/2+4} {obj.x+obj.w/2-9+14},{obj.y+obj.h/2} {obj.x+obj.w/2+9},{obj.y+obj.h/2+9}"
                              fill="none" stroke={obj.stroke || '#6b7280'} stroke-width="1.2" opacity=".6"/>
                            <circle cx={obj.x+obj.w/2-3} cy={obj.y+obj.h/2-2} r="2.5" fill={obj.stroke || '#6b7280'} opacity=".5"/>
                          </g>
                          {/if}
                        {:else}
                          {#if obj.shape === 'frame'}
                            <path
                              d={framePath(obj.x, obj.y, obj.w, obj.h, obj.frameWidth ?? 8)}
                              fill="none" stroke={obj.stroke || '#000000'} stroke-width={obj.strokeW || 1}
                              stroke-dasharray={obj.strokeDash || undefined}
                              transform={tf} filter={shFilter}
                            />
                          {:else if obj.shape === 'ellipse'}
                            <ellipse
                              cx={obj.x + obj.w / 2} cy={obj.y + obj.h / 2}
                              rx={obj.w / 2} ry={obj.h / 2}
                              fill={svgFillFor(obj)} stroke={obj.stroke || 'none'}
                              stroke-width={obj.strokeW} stroke-dasharray={obj.strokeDash || undefined}
                              transform={tf} filter={shFilter}
                            />
                          {:else if obj.shape === 'polygon'}
                            <polygon
                              points={polygonPoints(obj.x, obj.y, obj.w, obj.h, obj.polygonSides ?? 6)}
                              fill={svgFillFor(obj)} stroke={obj.stroke || 'none'}
                              stroke-width={obj.strokeW} stroke-dasharray={obj.strokeDash || undefined}
                              transform={tf} filter={shFilter}
                            />
                          {:else if obj.radiusOL || obj.radiusOR || obj.radiusUL || obj.radiusUR}
                            {@const useRect = !obj.cornerStyle || obj.cornerStyle === 'round'}
                            {@const allSame = obj.radiusOL === obj.radiusOR && obj.radiusOL === obj.radiusUL && obj.radiusOL === obj.radiusUR}
                            {#if useRect && allSame}
                              <rect
                                x={obj.x} y={obj.y} width={obj.w} height={obj.h}
                                fill={svgFillFor(obj)} stroke={obj.stroke || 'none'}
                                stroke-width={obj.strokeW} stroke-dasharray={obj.strokeDash || undefined}
                                rx={obj.radiusOL} transform={tf} filter={shFilter}
                              />
                            {:else}
                              <path
                                d={roundRectPath(obj.x, obj.y, obj.w, obj.h, obj.radiusOL, obj.radiusOR, obj.radiusUL, obj.radiusUR, obj.cornerStyle)}
                                fill={svgFillFor(obj)} stroke={obj.stroke || 'none'}
                                stroke-width={obj.strokeW} stroke-dasharray={obj.strokeDash || undefined}
                                transform={tf} filter={shFilter}
                              />
                            {/if}
                          {:else}
                            <rect
                              x={obj.x} y={obj.y}
                              width={obj.w} height={obj.h}
                              fill={svgFillFor(obj)}
                              stroke={obj.stroke || 'none'}
                              stroke-width={obj.strokeW}
                              stroke-dasharray={obj.strokeDash || undefined}
                              transform={tf}
                              filter={shFilter}
                            />
                          {/if}
                        {/if}
                      {:else if obj.type === 'LINIE'}
                        {@const mid = { x: (obj.x1+obj.x2)/2, y: (obj.y1+obj.y2)/2 }}
                        {@const ang = Math.atan2(obj.y2-obj.y1, obj.x2-obj.x1) * 180 / Math.PI}
                        {@const len = Math.sqrt((obj.x2-obj.x1)**2+(obj.y2-obj.y1)**2)}
                        {@const mText = obj.massText ?? ''}
                        {@const textPos = obj.massTextPos ?? 'ueber'}
                        {@const massFontSize = obj.massFontSize ?? 11}
                        {@const massFontFamily = obj.massFontFamily ?? "'Helvetica Neue', Helvetica, Arial, sans-serif"}
                        {@const massFontWeight = obj.massFontWeight ?? 'normal'}
                        {@const massFontStyle = obj.massFontStyle ?? 'normal'}
                        {@const textGap = mText ? mText.length * 7 + 12 : 0}
                        {@const ux = len > 0 ? (obj.x2-obj.x1)/len : 1}
                        {@const uy = len > 0 ? (obj.y2-obj.y1)/len : 0}
                        {@const arrInset = arrowInset(obj.strokeW || 1)}
                        {@const lx1 = obj.arrowStart === 'arrow' ? obj.x1 + ux * arrInset : obj.x1}
                        {@const ly1 = obj.arrowStart === 'arrow' ? obj.y1 + uy * arrInset : obj.y1}
                        {@const lx2 = obj.arrowEnd === 'arrow' ? obj.x2 - ux * arrInset : obj.x2}
                        {@const ly2 = obj.arrowEnd === 'arrow' ? obj.y2 - uy * arrInset : obj.y2}
                        {@const hasArrow = obj.arrowStart === 'arrow' || obj.arrowEnd === 'arrow'}
                        {@const hasDot   = obj.arrowStart === 'dot'   || obj.arrowEnd === 'dot'}
                        {@const hasTick  = obj.arrowStart === 'tick'  || obj.arrowEnd === 'tick'}
                        <defs>
                          {#if hasDot}
                            <marker id="dot-{obj.uid}" markerWidth="8" markerHeight="8" refX="3" refY="3" orient="auto">
                              <circle cx="3" cy="3" r="2.5" fill={obj.stroke || '#000'}/>
                            </marker>
                          {/if}
                          {#if hasTick}
                            <marker id="tick-{obj.uid}" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto">
                              <line x1="3" y1="9" x2="7" y2="1" stroke={obj.stroke || '#000'} stroke-width="1.5"/>
                            </marker>
                          {/if}
                        </defs>
                        {#if obj.isMasslinie && textPos === 'in' && mText && textGap < len}
                          <!-- Linie mit Unterbrechung -->
                          {@const bx1 = mid.x - ux * textGap/2}
                          {@const by1 = mid.y - uy * textGap/2}
                          {@const bx2 = mid.x + ux * textGap/2}
                          {@const by2 = mid.y + uy * textGap/2}
                          <line x1={lx1} y1={ly1} x2={bx1} y2={by1}
                            stroke={obj.stroke||'#000'} stroke-width={obj.strokeW}
                            stroke-dasharray={obj.strokeDash||undefined}
                            marker-start={obj.arrowStart==='dot'?`url(#dot-${obj.uid})`:obj.arrowStart==='tick'?`url(#tick-${obj.uid})`:undefined}
                          />
                          <line x1={bx2} y1={by2} x2={lx2} y2={ly2}
                            stroke={obj.stroke||'#000'} stroke-width={obj.strokeW}
                            stroke-dasharray={obj.strokeDash||undefined}
                            marker-end={obj.arrowEnd==='dot'?`url(#dot-${obj.uid})`:obj.arrowEnd==='tick'?`url(#tick-${obj.uid})`:undefined}
                          />
                        {:else}
                          <line x1={lx1} y1={ly1} x2={lx2} y2={ly2}
                            stroke={obj.stroke||'#000'} stroke-width={obj.strokeW}
                            stroke-dasharray={obj.strokeDash||undefined}
                            marker-start={obj.arrowStart==='dot'?`url(#dot-${obj.uid})`:obj.arrowStart==='tick'?`url(#tick-${obj.uid})`:undefined}
                            marker-end={obj.arrowEnd==='dot'?`url(#dot-${obj.uid})`:obj.arrowEnd==='tick'?`url(#tick-${obj.uid})`:undefined}
                          />
                        {/if}
                        {#if obj.arrowStart === 'arrow'}
                          <polygon points={arrowPolygon(obj.x1, obj.y1, obj.x2, obj.y2, obj.strokeW || 1)} fill={obj.stroke || '#000'}/>
                        {/if}
                        {#if obj.arrowEnd === 'arrow'}
                          <polygon points={arrowPolygon(obj.x2, obj.y2, obj.x1, obj.y1, obj.strokeW || 1)} fill={obj.stroke || '#000'}/>
                        {/if}
                        {#if obj.isMasslinie}
                          {@const perpX = len > 0 ? -(obj.y2-obj.y1)/len * 10 : 0}
                          {@const perpY = len > 0 ?  (obj.x2-obj.x1)/len * 10 : 0}
                          <line x1={obj.x1} y1={obj.y1} x2={obj.x1+perpX*1.5} y2={obj.y1+perpY*1.5} stroke={obj.stroke||'#000'} stroke-width="1" opacity=".6"/>
                          <line x1={obj.x2} y1={obj.y2} x2={obj.x2+perpX*1.5} y2={obj.y2+perpY*1.5} stroke={obj.stroke||'#000'} stroke-width="1" opacity=".6"/>
                          {#if mText}
                            {#if textPos === 'in'}
                              <text x={mid.x} y={mid.y} text-anchor="middle" dominant-baseline="middle"
                                font-family={massFontFamily} font-size={massFontSize} font-weight={massFontWeight} font-style={massFontStyle} fill={obj.stroke||'#000'}
                                transform="rotate({ang},{mid.x},{mid.y})">{mText}</text>
                            {:else}
                              <text x={mid.x} y={mid.y} text-anchor="middle" dominant-baseline="auto"
                                font-family={massFontFamily} font-size={massFontSize} font-weight={massFontWeight} font-style={massFontStyle} fill={obj.stroke||'#000'}
                                transform="rotate({ang},{mid.x},{mid.y}) translate(0,-6)">{mText}</text>
                            {/if}
                          {/if}
                        {/if}
                      {:else if obj.type === 'PFAD'}
                        {#if obj.shadowEnabled}
                          <defs>
                            <filter id="sh-{obj.uid}" x="-50%" y="-50%" width="200%" height="200%">
                              <feDropShadow dx={obj.shadowX??4} dy={obj.shadowY??4} stdDeviation={obj.shadowBlur??6} flood-color={obj.shadowColor??'#000000'} flood-opacity="0.5"/>
                            </filter>
                          </defs>
                        {/if}
                        {@const pdx = obj.x - (obj.ox ?? obj.x)}
                        {@const pdy = obj.y - (obj.oy ?? obj.y)}
                        {@const pcx = (obj.ox ?? obj.x) + obj.w/2 + pdx}
                        {@const pcy = (obj.oy ?? obj.y) + obj.h/2 + pdy}
                        {@const ptfm = [pdx||pdy ? `translate(${pdx} ${pdy})` : '', obj.rotation ? `rotate(${obj.rotation} ${pcx} ${pcy})` : ''].filter(Boolean).join(' ')}
                        {#if obj.isWall}
                          {@const wallParts = wallRenderParts(obj.points, obj.wallWidth ?? mmToPx(10), obj.wallHatchSpacing ?? mmToPx(5), obj.wallHatchType ?? 'diagonal', obj.curveClosed)}
                          <path d={wallParts.lines} fill="none"
                            stroke={obj.stroke||'#222222'} stroke-width={obj.strokeW||1}
                            stroke-linecap="square" stroke-linejoin="miter"
                            filter={obj.shadowEnabled ? `url(#sh-${obj.uid})` : undefined}
                            transform={ptfm || undefined}/>
                          <path d={wallParts.hatches} fill="none"
                            stroke={obj.wallHatchColor || '#444444'} stroke-width="1"
                            stroke-linecap="butt" opacity=".85"
                            filter={obj.shadowEnabled ? `url(#sh-${obj.uid})` : undefined}
                            transform={ptfm || undefined}/>
                        {:else}
                        <path d={obj.d} fill={svgFillFor(obj)}
                          fill-rule="evenodd"
                          stroke={obj.stroke||'#000000'}
                          stroke-width={obj.strokeW||1}
                          stroke-dasharray={obj.strokeDash||undefined}
                          stroke-linecap="round" stroke-linejoin="round"
                          filter={obj.shadowEnabled ? `url(#sh-${obj.uid})` : undefined}
                          transform={ptfm || undefined}/>
                        {/if}
                      {/if}
                    {/each}
                  </g>
                {/if}
              {/each}
            </svg>

            <!-- Text-Display-Overlay (HTML, damit font-size mit zoomFactor skaliert) -->
            <div style="position:absolute;top:0;left:0;width:{canvasW * zoomFactor}px;height:{canvasH * zoomFactor}px;pointer-events:none;overflow:hidden;">
              {#each ebenen.filter(e => e.name !== 'Raster') as e}
                {#if e.sichtbar}
                  {#each objects.filter(o => o.ebene === e.name && o.type === 'TEXT') as obj}
                    {#if obj.uid !== textEditUid}
                      {@const tobj = obj as DrawnText}
                      {@const textShadow = tobj.shadowEnabled ? `text-shadow:${tobj.shadowX ?? 4}px ${tobj.shadowY ?? 4}px ${tobj.shadowBlur ?? 6}px ${tobj.shadowColor ?? '#000000'};` : ''}
                      {@const tdStyle = `position:absolute;${hitBoxStyle(obj)}font-family:${tobj.massFontFamily ?? DEFAULT_TEXT_FONT};font-size:${(tobj.massFontSize ?? DEFAULT_TEXT_SIZE) * zoomFactor}px;text-align:${tobj.textAlign};line-height:${tobj.lineHeight};color:${obj.fill||'#000000'};${textShadow}overflow:hidden;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;box-sizing:border-box;margin:0;padding:0;opacity:${(e.opacity ?? 100) / 100};`}
                      <div style={tdStyle}>{@html sanitizeRichHtml(scaleRichHtmlFonts(tobj.richHtml, zoomFactor))}</div>
                    {/if}
                  {/each}
                {/if}
              {/each}
            </div>

            <!-- Interaktions-Overlay (select + rect) -->
            {#if activeTool === 'select' || activeTool === 'rotate' || activeTool === 'fill-tool' || activeTool === 'hand' || activeTool === 'zoom' || activeTool === 'measure' || activeTool === 'rect' || activeTool === 'roundrect' || activeTool === 'ellipse' || activeTool === 'polygon' || activeTool === 'frame' || activeTool === 'image' || activeTool === 'line' || activeTool === 'arc' || activeTool === 'wall' || activeTool === 'text' || activeTool === 'pencil' || activeTool === 'eraser' || activeTool === 'brush' || drawingRect || drawingLine || drawingCurve || drawingWall || drawingPath || drawingEraser || drawingBrush}
              <div
                class="draw-overlay"
                style="width:{canvasW * zoomFactor}px;height:{canvasH * zoomFactor}px;"
                class:draw-overlay-crosshair={activeTool === 'measure' || activeTool === 'rect' || activeTool === 'roundrect' || activeTool === 'ellipse' || activeTool === 'polygon' || activeTool === 'frame' || activeTool === 'image' || activeTool === 'line' || activeTool === 'arc' || activeTool === 'wall'}
                class:draw-overlay-text={activeTool === 'text'}
                class:draw-overlay-pencil={activeTool === 'pencil'}
                class:draw-overlay-brush={activeTool === 'brush'}
                class:draw-overlay-eraser={activeTool === 'eraser'}
                class:draw-overlay-hand={activeTool === 'hand'}
                class:draw-overlay-zoom={activeTool === 'zoom'}
                class:draw-overlay-fill={activeTool === 'fill-tool'}
                onmousedown={onDrawMouseDown}
                onmousemove={onDrawMouseMove}
                onmouseup={onDrawMouseUp}
                ondblclick={(ev) => { if (activeTool === 'wall') { ev.preventDefault(); ev.stopPropagation(); finishWall(); } }}
                onclick={(ev) => { if (justPlaced) { justPlaced = false; return; } if (textEditUid) { textEditUid = null; return; } if (activeTool === 'select' && ev.target === ev.currentTarget) { clearSelection(); } }}
              >
                <!-- Text-Editor und Klick-Flächen -->
                {#if activeTool === 'select' || textEditUid}
                  {#if textEditUid}
                    {@const editObj = objects.find(o => o.uid === textEditUid)}
                    {#if editObj?.type === 'TEXT'}
                      {@const editShadow = editObj.shadowEnabled ? `text-shadow:${editObj.shadowX ?? 4}px ${editObj.shadowY ?? 4}px ${editObj.shadowBlur ?? 6}px ${editObj.shadowColor ?? '#000000'};` : ''}
                      {@const editStyle = `${hitBoxStyle(editObj)}font-family:${editObj.massFontFamily ?? DEFAULT_TEXT_FONT};font-size:${(editObj.massFontSize ?? DEFAULT_TEXT_SIZE) * zoomFactor}px;text-align:${editObj.textAlign};line-height:${editObj.lineHeight};color:${editObj.fill||'#000000'};${editShadow}overflow:hidden;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;box-sizing:border-box;margin:0;padding:0;outline:none;background:transparent;cursor:text;z-index:30;`}
                      <div
                        class="text-edit-overlay"
                        class:obj-selected={selectedObj === editObj}
                        style={editStyle}
                        contenteditable="true"
                        data-text-editor={editObj.uid}
                        use:setupTextEdit={editObj}
                        onclick={(ev) => ev.stopPropagation()}
                        onmousedown={(ev) => ev.stopPropagation()}
                        onmousemove={(ev) => ev.stopPropagation()}
                        onmouseup={(ev) => { ev.stopPropagation(); rememberTextSelection(); }}
                        onkeyup={rememberTextSelection}
                      ></div>
                    {/if}
                  {/if}
                {/if}
                {#if activeTool === 'select' || activeTool === 'rotate' || activeTool === 'fill-tool' || activeTool === 'text'}
                  {#each objects.filter(o => canOperateOn(o) && (activeTool === 'select' || activeTool === 'rotate' || activeTool === 'fill-tool' || o.type === 'TEXT')) as obj}
                    <div
                      class="obj-hit"
                      class:obj-selected={selectedObjs.includes(obj)}
                      class:obj-locked={(obj as any).gesperrt}
                      style="{hitBoxStyle(obj)}--sel-inv:{1 / zoomFactor};cursor:{(obj as any).gesperrt?'not-allowed':activeTool==='fill-tool'?(canFillObject(obj)?'copy':'not-allowed'):activeTool==='rotate'?'grab':selectedObjs.includes(obj)?(imgPanMode&&isImageFrameObject(obj)&&obj.imageUrl?'grab':'move'):'default'};pointer-events:{obj.uid===textEditUid || (obj.groupId && selectedObjs.length > 1 && selectedObjs.some(o => o.groupId === obj.groupId))?'none':'auto'};"
                      onclick={(ev) => {
                        ev.stopPropagation();
                        if ((obj as any).gesperrt) return;
                        if (justPlaced) { justPlaced = false; return; }
                        if (activeTool === 'fill-tool') {
                          applyFillToolToObject(obj);
                          return;
                        }
                        if (obj.type === 'TEXT') {
                          selectOne(obj);
                          propTab = 'geo';
                          if (activeTool === 'text') {
                            pendingTextCaret = { x: ev.clientX, y: ev.clientY };
                            textEditUid = obj.uid;
                          } else {
                            textEditUid = null;
                          }
                          return;
                        }
                        // Gruppe: alle Objekte der Gruppe zusammen selektieren
                        const gid = obj.groupId;
                        const groupMembers = gid ? objects.filter(o => o.groupId === gid && canOperateOn(o)) : [obj];
                        if (ev.shiftKey) {
                          if (selectedObjs.includes(obj)) {
                            selectedObjs = selectedObjs.filter(o => !groupMembers.includes(o));
                            if (selectedObj && groupMembers.includes(selectedObj)) selectedObj = selectedObjs[0] ?? null;
                          } else {
                            selectedObjs = [...new Set([...selectedObjs, ...groupMembers])];
                            selectOne(groupMembers[0]);
                          }
                        } else {
                          if (groupMembers.length > 1) {
                            selectedObjs = groupMembers;
                            selectedObj = null;
                          } else {
                            selectOne(obj);
                          }
                        }
                      }}
                      onmousedown={(ev) => onObjMouseDown(ev, obj)}
                      ondblclick={(ev) => { ev.stopPropagation(); onObjDblClick(obj); }}
                    >
                      <!-- Selektions-Handles (nur bei Einzelselektion) -->
                      {#if selectedObj === obj && selectedObjs.length === 1}
                        <div class="sel-rotate-line"></div>
                        <div class="sel-rotate-handle" title="Drehen" onmousedown={(ev) => { ev.stopPropagation(); startRotate(ev, obj); }} onclick={(ev) => ev.stopPropagation()}></div>
                        <div class="sel-handle sel-h-tl" onmousedown={(ev) => startResize(ev, obj, 'tl')}></div>
                        <div class="sel-handle sel-h-tc" onmousedown={(ev) => startResize(ev, obj, 'tc')}></div>
                        <div class="sel-handle sel-h-tr" onmousedown={(ev) => startResize(ev, obj, 'tr')}></div>
                        <div class="sel-handle sel-h-ml" onmousedown={(ev) => startResize(ev, obj, 'ml')}></div>
                        <div class="sel-handle sel-h-mr" onmousedown={(ev) => startResize(ev, obj, 'mr')}></div>
                        <div class="sel-handle sel-h-bl" onmousedown={(ev) => startResize(ev, obj, 'bl')}></div>
                        <div class="sel-handle sel-h-bc" onmousedown={(ev) => startResize(ev, obj, 'bc')}></div>
                        <div class="sel-handle sel-h-br" onmousedown={(ev) => startResize(ev, obj, 'br')}></div>
                      {/if}
                    </div>
                  {/each}
                {/if}

                <!-- Multi-Selektion Bounding Box -->
                {#if selectedObjs.length > 1}
                  {@const mbx1 = Math.min(...selectedObjs.map(o => o.x))}
                  {@const mby1 = Math.min(...selectedObjs.map(o => o.y))}
                  {@const mbx2 = Math.max(...selectedObjs.map(o => o.x + o.w))}
                  {@const mby2 = Math.max(...selectedObjs.map(o => o.y + o.h))}
                  <div class="sel-multi-box" style="left:{(mbx1-4)*zoomFactor}px;top:{(mby1-4)*zoomFactor}px;width:{(mbx2-mbx1+8)*zoomFactor}px;height:{(mby2-mby1+8)*zoomFactor}px;--sel-inv:{1/zoomFactor};"
                    onmousedown={(ev) => {
                      ev.stopPropagation();
                      ev.preventDefault();
                      startMove(ev, selectedObjs[0]);
                    }}
                    onclick={(ev) => ev.stopPropagation()}>
                    <div class="sel-rotate-line"></div>
                    <div class="sel-rotate-handle" title="Gruppe drehen" onmousedown={startRotateSelection}></div>
                    <div class="sel-handle sel-h-tl" onmousedown={(ev) => startResizeSelection(ev, 'tl')}></div>
                    <div class="sel-handle sel-h-tc" onmousedown={(ev) => startResizeSelection(ev, 'tc')}></div>
                    <div class="sel-handle sel-h-tr" onmousedown={(ev) => startResizeSelection(ev, 'tr')}></div>
                    <div class="sel-handle sel-h-ml" onmousedown={(ev) => startResizeSelection(ev, 'ml')}></div>
                    <div class="sel-handle sel-h-mr" onmousedown={(ev) => startResizeSelection(ev, 'mr')}></div>
                    <div class="sel-handle sel-h-bl" onmousedown={(ev) => startResizeSelection(ev, 'bl')}></div>
                    <div class="sel-handle sel-h-bc" onmousedown={(ev) => startResizeSelection(ev, 'bc')}></div>
                    <div class="sel-handle sel-h-br" onmousedown={(ev) => startResizeSelection(ev, 'br')}></div>
                  </div>
                {/if}

                <!-- Rubber-Band-Selektion -->
                {#if selRect}
                  {@const rx = Math.min(selRect.x1, selRect.x2)}
                  {@const ry = Math.min(selRect.y1, selRect.y2)}
                  {@const rw = Math.abs(selRect.x2 - selRect.x1)}
                  {@const rh = Math.abs(selRect.y2 - selRect.y1)}
                  <div class="sel-rubber" style="left:{rx * zoomFactor}px;top:{ry * zoomFactor}px;width:{rw * zoomFactor}px;height:{rh * zoomFactor}px;"></div>
                {/if}

                <!-- Zeichenvorschau (eraser-Tool) -->
                {#if drawingEraser && drawingEraser.pts.length > 1}
                  {@const ep = drawingEraser.pts}
                  <svg viewBox="0 0 {canvasW} {canvasH}" style="position:absolute;left:0;top:0;width:{canvasW * zoomFactor}px;height:{canvasH * zoomFactor}px;pointer-events:none;overflow:visible;">
                    <path d={smoothPts(ep)} fill="none" stroke="rgba(255,100,100,0.28)"
                      stroke-width={eraserSize} stroke-linecap="round" stroke-linejoin="round"
                      stroke-dasharray="none"/>
                  </svg>
                {/if}

                <!-- Zeichenvorschau (pencil-Tool) -->
                {#if drawingPath && drawingPath.d}
                  <svg viewBox="0 0 {canvasW} {canvasH}" style="position:absolute;left:0;top:0;width:{canvasW * zoomFactor}px;height:{canvasH * zoomFactor}px;pointer-events:none;overflow:visible;">
                    <path d={drawingPath.d} fill="none"
                      stroke={objStroke || '#000000'}
                      stroke-width={typeof objStrokeW === 'number' ? objStrokeW : 1}
                      stroke-linecap="round" stroke-linejoin="round" opacity=".8"/>
                  </svg>
                {/if}
                {#if drawingCurve && drawingCurve.d}
                  <svg viewBox="0 0 {canvasW} {canvasH}" style="position:absolute;left:0;top:0;width:{canvasW * zoomFactor}px;height:{canvasH * zoomFactor}px;pointer-events:none;overflow:visible;">
                    <path d={drawingCurve.d} fill={propCurveClosed ? objFill : 'none'}
                      stroke={objStroke || '#000000'}
                      stroke-width={typeof objStrokeW === 'number' ? objStrokeW : 1}
                      stroke-linecap="round" stroke-linejoin="round" opacity=".8"/>
                  </svg>
                {/if}
                {#if drawingWall && drawingWall.pts.length >= 1}
                  {@const wallPts = drawingWall.pts.length === 1 ? [...drawingWall.pts, ...(drawingWall.preview ? [drawingWall.preview] : [])] : drawingWall.pts}
                  {@const wallParts = wallRenderParts(wallPts, mmToPx(propWallWidth), mmToPx(propWallHatchSpacing), propWallHatchType)}
                  <svg viewBox="0 0 {canvasW} {canvasH}" style="position:absolute;left:0;top:0;width:{canvasW * zoomFactor}px;height:{canvasH * zoomFactor}px;pointer-events:none;overflow:visible;">
                    <path d={wallParts.lines} fill="none" stroke={objStroke || '#222222'} stroke-width={typeof objStrokeW === 'number' ? objStrokeW : 1} opacity=".85"/>
                    <path d={wallParts.hatches} fill="none" stroke={propWallHatchColor || '#444444'} stroke-width="1" opacity=".65"/>
                    {#if drawingWall.pts.length > 1 && drawingWall.preview}
                      <line x1={drawingWall.pts[drawingWall.pts.length - 1].x} y1={drawingWall.pts[drawingWall.pts.length - 1].y} x2={drawingWall.preview.x} y2={drawingWall.preview.y}
                        stroke={objStroke || '#222222'} stroke-width="1" stroke-dasharray="5 4" opacity=".55"/>
                    {/if}
                  </svg>
                {/if}

                <!-- Zeichenvorschau (brush-Tool) -->
                {#if drawingBrush && drawingBrush.pts.length >= 2}
                  {@const prevD = brushPathD(drawingBrush.pts, propBrushSize, propBrushForm, propGlaettung)}
                  {#if prevD}
                  <svg viewBox="0 0 {canvasW} {canvasH}" style="position:absolute;left:0;top:0;width:{canvasW * zoomFactor}px;height:{canvasH * zoomFactor}px;pointer-events:none;overflow:visible;">
                    <path d={prevD} fill={objFill || '#000000'} fill-rule="evenodd" opacity=".75"/>
                  </svg>
                  {/if}
                {/if}

                <!-- Zeichenvorschau (line-Tool) -->
                {#if drawingLine}
                  <svg viewBox="0 0 {canvasW} {canvasH}" style="position:absolute;left:0;top:0;width:{canvasW * zoomFactor}px;height:{canvasH * zoomFactor}px;pointer-events:none;overflow:visible;">
                    <line x1={drawingLine.x1} y1={drawingLine.y1} x2={drawingLine.x2} y2={drawingLine.y2}
                      stroke={objStroke} stroke-width={typeof objStrokeW === 'number' ? objStrokeW : 1} opacity=".7"/>
                  </svg>
                {/if}

                <!-- Mess-Vorschau -->
                {#if measuringLine}
                  {@const mdx = measuringLine.x2 - measuringLine.x1}
                  {@const mdy = measuringLine.y2 - measuringLine.y1}
                  {@const mlen = Math.sqrt(mdx*mdx + mdy*mdy)}
                  {@const mnx = mlen > 0 ? -mdy/mlen : 0}
                  {@const mny = mlen > 0 ?  mdx/mlen : 0}
                  {@const mmid = { x: (measuringLine.x1+measuringLine.x2)/2, y: (measuringLine.y1+measuringLine.y2)/2 }}
                  {@const mlabelX = mmid.x + mnx * 12}
                  {@const mlabelY = mmid.y + mny * 12}
                  {@const _unt = rasterUnterteilung !== '' && (rasterUnterteilung as number) > 0 ? rasterUnterteilung as number : 1}
                  {@const _mmStepX = snapStepX > 0 ? (rasterXAbstand as number) / _unt : 0}
                  {@const _mmStepY = snapStepY > 0 ? (rasterYAbstand as number) / _unt : 0}
                  {@const _stepsX = snapStepX > 0 ? Math.round(mdx / snapStepX) : 0}
                  {@const _stepsY = snapStepY > 0 ? Math.round(mdy / snapStepY) : 0}
                  {@const mlenMm = (snapStepX > 0 && snapStepY > 0)
                    ? Math.sqrt((_stepsX * _mmStepX) ** 2 + (_stepsY * _mmStepY) ** 2)
                    : mlen / MM_TO_PX}
                  {@const mDisplay = measureUnit === 'mm' ? `${mlenMm.toFixed(genauigkeit)} mm` : measureUnit === 'cm' ? `${(mlenMm/10).toFixed(genauigkeit)} cm` : `${Math.round(mlen)} px`}
                  <svg viewBox="0 0 {canvasW} {canvasH}" style="position:absolute;left:0;top:0;width:{canvasW * zoomFactor}px;height:{canvasH * zoomFactor}px;pointer-events:none;overflow:visible;">
                    <defs>
                      <marker id="ma-s" markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
                        <polygon points="0,0 6,3 0,6" fill="#dd0000"/>
                      </marker>
                      <marker id="ma-e" markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto" markerUnits="userSpaceOnUse">
                        <polygon points="0,0 6,3 0,6" fill="#dd0000"/>
                      </marker>
                    </defs>
                    <!-- Maßlinie mit Pfeilen -->
                    <line x1={measuringLine.x1} y1={measuringLine.y1}
                          x2={measuringLine.x2} y2={measuringLine.y2}
                          stroke="#dd0000" stroke-width="1"
                          marker-start="url(#ma-s)" marker-end="url(#ma-e)"/>
                    <!-- Label (Hintergrund) -->
                    <text x={mlabelX} y={mlabelY} text-anchor="middle" dominant-baseline="middle"
                      font-family="system-ui,sans-serif" font-size="11" font-weight="600"
                      stroke="white" stroke-width="3" paint-order="stroke">{mDisplay}</text>
                    <!-- Label (Vordergrund) -->
                    <text x={mlabelX} y={mlabelY} text-anchor="middle" dominant-baseline="middle"
                      font-family="system-ui,sans-serif" font-size="11" font-weight="600"
                      fill="#dd0000">{mDisplay}</text>
                  </svg>
                {/if}

                <!-- Zeichenvorschau (rect-Tool) -->
                {#if drawingRect}
                  {@const rx = Math.min(drawingRect.x1, drawingRect.x2)}
                  {@const ry = Math.min(drawingRect.y1, drawingRect.y2)}
                  {@const rw = Math.abs(drawingRect.x2 - drawingRect.x1)}
                  {@const rh = Math.abs(drawingRect.y2 - drawingRect.y1)}
                  {#if activeTool === 'polygon'}
                    <svg viewBox="0 0 {canvasW} {canvasH}" style="position:absolute;left:0;top:0;width:{canvasW * zoomFactor}px;height:{canvasH * zoomFactor}px;pointer-events:none;overflow:visible;">
                      <polygon points={polygonPoints(rx, ry, rw, rh, propPolygonSides)}
                        fill={objFill || 'none'} stroke={objStroke || '#000000'} stroke-width={typeof objStrokeW === 'number' ? objStrokeW : 1}
                        opacity=".75"/>
                    </svg>
                  {:else if activeTool === 'frame'}
                    <svg viewBox="0 0 {canvasW} {canvasH}" style="position:absolute;left:0;top:0;width:{canvasW * zoomFactor}px;height:{canvasH * zoomFactor}px;pointer-events:none;overflow:visible;">
                      <path d={framePath(rx, ry, rw, rh, Math.max(1, Math.round(unitToPx(propFrameWidth))))}
                        fill="none" stroke={objStroke || '#000000'} stroke-width={typeof objStrokeW === 'number' ? objStrokeW : 1}
                        opacity=".75"/>
                    </svg>
                  {:else}
                    <div class="draw-preview-rect" class:draw-preview-ellipse={activeTool === 'ellipse'} style="left:{rx * zoomFactor}px;top:{ry * zoomFactor}px;width:{rw * zoomFactor}px;height:{rh * zoomFactor}px;background:{cssFillForValue(objFill)};border:1px solid {objStroke};"></div>
                  {/if}
                {/if}
              </div>
            {/if}
          </div>

          </div><!-- canvas-zoom-outer -->
        {:else if !pageSetupOpen}
          <div class="canvas-hint">Zeichenfläche leer</div>
        {/if}
        </div><!-- canvas-scroll-area -->
      </div><!-- canvas-body -->
    </main>

    <!-- Right: Properties 250 px -->
    <!-- Right: Properties Panel 250px -->
    <aside class="props-bar" aria-label="Eigenschaften" class:props-bar-locked={!canvasReady}>
      {#if !canvasReady}
        <div class="props-bar-lock-overlay">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="22" height="22"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>
          <span>Kein Dokument geöffnet</span>
        </div>
      {/if}

      <!-- Panel-Header -->
        <div class="pb-header">
        <div class="pb-grip">
          <span></span><span></span><span></span>
        </div>
        <span class="pb-title">Eigenschaften:&nbsp;
          {#if propTab === 'geo'}Geometrie{:else if propTab === 'fill'}Füllung{:else if propTab === 'text'}Raster{:else if propTab === 'align'}Ausrichtung{:else if propTab === 'ebenen'}Ebenen{:else if propTab === 'formen'}Formen{:else}Seite{/if}
        </span>
      </div>

      <!-- Tab-Leiste -->
      <div class="pb-tabs">
        <!-- Transformieren -->
        <button class="pb-tab" class:pb-tab-active={propTab==='geo'} onclick={() => propTab='geo'} title="Geometrie">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7h18M3 12h12M3 17h8"/><rect x="14" y="9" width="7" height="7" rx="1"/></svg>
        </button>
        <!-- Füllung -->
        {#if selectedObj?.type !== 'TEXT'}
        <button class="pb-tab" class:pb-tab-active={propTab==='fill'} onclick={() => propTab='fill'} title="Füllung">
          <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8" opacity=".9"/></svg>
        </button>
        {/if}
        <!-- Raster -->
        <button class="pb-tab" class:pb-tab-active={propTab==='text'} onclick={() => propTab='text'} title="Text">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>
        </button>
        <!-- Ausrichtung -->
        <button class="pb-tab" class:pb-tab-active={propTab==='align'} onclick={() => propTab='align'} title="Ausrichtung">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 4v16"/><rect x="8" y="6" width="9" height="4" rx="1"/><rect x="8" y="14" width="12" height="4" rx="1"/></svg>
        </button>
        <!-- Seite -->
        <button class="pb-tab" class:pb-tab-active={propTab==='page'} onclick={() => propTab='page'} title="Seite">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        </button>
        <!-- Ebenen -->
        <button class="pb-tab" class:pb-tab-active={propTab==='ebenen'} onclick={() => propTab='ebenen'} title="Ebenen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="12,2 2,7 12,12 22,7"/><polyline points="2,12 12,17 22,12"/><polyline points="2,17 12,22 22,17"/></svg>
        </button>
        <!-- Formen -->
        <button class="pb-tab" class:pb-tab-active={propTab==='formen'} onclick={() => propTab='formen'} title="Formen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="7" height="7" rx="1"/><circle cx="17" cy="8" r="4"/><path d="M4 20l4-7 4 7z"/><path d="M15 15h6v6h-6z"/></svg>
        </button>
      </div>

      <!-- ── Geometrie-Tab ─────────────────────────────────────────────── -->
      {#if propTab === 'geo'}
      <div class="pb-body">

        <!-- Position & Größe -->
        <div class="pb-group-row">
          <div class="pb-group">
            <div class="pb-group-label pb-label-fixed">Position</div>
            <div class="pb-field-row">
              <span class="pb-axis">X:</span>
              <div class="pb-spinner">
                <button class="sp-arr" onclick={() => stepNum('propX', unitStep)}>▲</button>
                <input type="number" step={unitStep} class="sp-input" bind:value={propX} onchange={syncObjFromProps} />
                <span class="sp-unit">{einheit}</span>
                <button class="sp-arr" onclick={() => stepNum('propX', -unitStep)}>▼</button>
              </div>
            </div>
            <div class="pb-field-row">
              <span class="pb-axis">Y:</span>
              <div class="pb-spinner">
                <button class="sp-arr" onclick={() => stepNum('propY', unitStep)}>▲</button>
                <input type="number" step={unitStep} class="sp-input" bind:value={propY} onchange={syncObjFromProps} />
                <span class="sp-unit">{einheit}</span>
                <button class="sp-arr" onclick={() => stepNum('propY', -unitStep)}>▼</button>
              </div>
            </div>
          </div>
          <div class="pb-group">
            <div class="pb-group-label pb-label-fixed">
              Größe
              <button class="pb-lock" class:pb-lock-on={propLock} onclick={() => propLock = !propLock} title="Seitenverhältnis sperren">
                {#if propLock}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
                {:else}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.29-1.29"/></svg>
                {/if}
              </button>
            </div>
            <div class="pb-field-row">
              <span class="pb-axis">B:</span>
              <div class="pb-spinner">
                <button class="sp-arr" onclick={() => stepNum('propW', unitStep)}>▲</button>
                <input type="number" step={unitStep} class="sp-input" bind:value={propW} onchange={onPropWChange} />
                <span class="sp-unit">{einheit}</span>
                <button class="sp-arr" onclick={() => stepNum('propW', -unitStep)}>▼</button>
              </div>
            </div>
            <div class="pb-field-row">
              <span class="pb-axis">H:</span>
              <div class="pb-spinner">
                <button class="sp-arr" onclick={() => stepNum('propH', unitStep)}>▲</button>
                <input type="number" step={unitStep} class="sp-input" bind:value={propH} onchange={onPropHChange} />
                <span class="sp-unit">{einheit}</span>
                <button class="sp-arr" onclick={() => stepNum('propH', -unitStep)}>▼</button>
              </div>
            </div>
          </div>
        </div>

        {#if (selectedObj?.type === 'RECHTECK' && selectedObj.shape === 'polygon') || (activeTool === 'polygon' && !selectedObj)}
          <div class="pb-group">
            <div class="pb-field-row polygon-sides-row">
              <svg viewBox="0 0 24 24" class="polygon-sides-icon" fill="currentColor" aria-hidden="true">
                <polygon points="12,2 21,7.5 21,16.5 12,22 3,16.5 3,7.5"/>
              </svg>
              <span class="pb-group-label polygon-sides-label">Seiten:</span>
              <input type="range" min="3" max="24" step="1" bind:value={propPolygonSides} oninput={syncObjFromProps} class="polygon-sides-slider"/>
              <select class="mp-input polygon-sides-select"
                value={propPolygonSides}
                onchange={(e) => { propPolygonSides = Number((e.target as HTMLSelectElement).value); syncObjFromProps(); }}>
                {#each Array.from({ length: 22 }, (_, i) => i + 3) as s}
                  <option value={s}>{s}</option>
                {/each}
              </select>
            </div>
          </div>
          <div class="pb-divider"></div>
        {/if}

        {#if (selectedObj?.type === 'RECHTECK' && selectedObj.shape === 'frame') || (activeTool === 'frame' && !selectedObj)}
          <div class="pb-group">
            <div class="pb-field-row">
              <span class="pb-group-label" style="min-width:88px;">Rahmenbreite:</span>
              <div class="pb-spinner" style="flex:1;">
                <button class="sp-arr" onclick={() => { propFrameWidth = Number((propFrameWidth + unitStep).toFixed(3)); syncObjFromProps(); }}>▲</button>
                <input type="number" step={unitStep} min={unitStep} class="sp-input" bind:value={propFrameWidth} onchange={syncObjFromProps} />
                <span class="sp-unit">{einheit}</span>
                <button class="sp-arr" onclick={() => { propFrameWidth = Math.max(unitStep, Number((propFrameWidth - unitStep).toFixed(3))); syncObjFromProps(); }}>▼</button>
              </div>
            </div>
          </div>
          <div class="pb-divider"></div>
        {/if}

        <!-- Drehung (alle Objekte) -->
        <div class="pb-group-row" style="margin-top:4px;">
          <div class="pb-group">
            <div class="pb-group-label">Drehung</div>
            <div class="pb-field-row">
              <span class="pb-axis-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 .49-5.34"/></svg>
              </span>
              <div class="pb-spinner">
                <button class="sp-arr" onclick={() => stepNum('propRot', 1)}>▲</button>
                <input type="number" class="sp-input" bind:value={propRot} onchange={syncObjFromProps} />
                <span class="sp-unit">°</span>
                <button class="sp-arr" onclick={() => stepNum('propRot', -1)}>▼</button>
              </div>
            </div>
          </div>
        </div>
        <div class="pb-group">
          <div class="pb-field-row" style="gap:6px;">
            <button class="text-fmt-btn" title="Links drehen" onclick={() => { rotateDir = -1; rotateSelectedBy(-rotateStep); }}>↶</button>
            <select class="mp-input" style="flex:1;" bind:value={rotateStep}>
              {#each [1, 5, 10, 15, 30, 45, 90, 180] as step}
                <option value={step}>{step}°</option>
              {/each}
            </select>
            <button class="text-fmt-btn" title="Rechts drehen" onclick={() => { rotateDir = 1; rotateSelectedBy(rotateStep); }}>↷</button>
          </div>
        </div>

        <div class="pb-divider"></div>

        <!-- 3. Scheren (bei selektiertem Objekt, nicht für TEXT) -->
        {#if selectedObj && selectedObj.type !== 'TEXT'}
        <div class="pb-group-row">
          <div class="pb-group">
            <div class="pb-group-label">Scheren</div>
            <div class="pb-field-row">
              <span class="pb-axis-icon pb-shear-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="7,19 17,19 21,5 11,5"/></svg>
              </span>
              <div class="pb-spinner">
                <button class="sp-arr" onclick={() => stepNum('propShearX', 1)}>▲</button>
                <input type="number" class="sp-input" bind:value={propShearX} onchange={syncObjFromProps}/>
                <span class="sp-unit">°</span>
                <button class="sp-arr" onclick={() => stepNum('propShearX', -1)}>▼</button>
              </div>
            </div>
            <div class="pb-field-row">
              <span class="pb-axis-icon pb-shear-icon pb-shear-v">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="5,7 5,17 19,21 19,11"/></svg>
              </span>
              <div class="pb-spinner">
                <button class="sp-arr" onclick={() => stepNum('propShearY', 1)}>▲</button>
                <input type="number" class="sp-input" bind:value={propShearY} onchange={syncObjFromProps}/>
                <span class="sp-unit">°</span>
                <button class="sp-arr" onclick={() => stepNum('propShearY', -1)}>▼</button>
              </div>
            </div>
          </div>
        </div>
        <div class="pb-divider"></div>
        {/if}

        <!-- 4. Ebene -->
        {#if selectedObj || drawingRect || (activeTool !== 'select' && activeTool !== 'image')}
          <div class="pb-group">
            <div class="pb-group-label">Ebene</div>
            <select class="obj-ebene-select"
              value={selectedObj ? selectedObj.ebene : aktiveEbene}
              onchange={(ev) => {
                const val = (ev.target as HTMLSelectElement).value;
                if (selectedObj) { selectedObj.ebene = val; persistDbObject(selectedObj); unsaved = true; }
                else { aktiveEbene = val; }
              }}>
              {#each ebenen.filter(e => e.name !== 'Raster') as e}
                <option value={e.name}>{e.name}</option>
              {/each}
            </select>
          </div>
          <div class="pb-divider"></div>
        {/if}

        <!-- 5. Werkzeug-/Objekt-spezifische Eigenschaften -->

        {#if activeTool === 'wall' || (selectedObj?.type === 'PFAD' && (selectedObj as DrawnPath).isWall)}
          <div class="pb-group">
            <div class="pb-group-label">Wand</div>
            <div class="pb-field-row" style="gap:8px;align-items:center;margin-bottom:6px;">
              <span style="font-size:10px;color:#8a9ab5;width:70px;flex-shrink:0;">Farbe</span>
              <input type="color" class="obj-color-pick"
                value={objStroke || '#222222'}
                oninput={(e) => { objStroke = (e.target as HTMLInputElement).value; syncObjFromProps(); }}/>
              <span class="obj-color-hex">{objStroke || '#222222'}</span>
            </div>
            <div class="pb-field-row" style="gap:6px;align-items:center;margin-bottom:6px;">
              <span style="font-size:10px;color:#8a9ab5;width:70px;flex-shrink:0;">Dicke</span>
              <input type="number" class="mp-input" style="width:70px;" min="1" step="1" bind:value={propWallWidth} onchange={syncObjFromProps}/>
              <span class="stroke-val">mm</span>
            </div>
            <div class="pb-field-row" style="gap:6px;align-items:center;">
              <span style="font-size:10px;color:#8a9ab5;width:70px;flex-shrink:0;">Schraffur</span>
              <input type="number" class="mp-input" style="width:70px;" min="1" step="1" bind:value={propWallHatchSpacing} onchange={syncObjFromProps}/>
              <span class="stroke-val">mm</span>
            </div>
            <div class="pb-field-row" style="gap:6px;align-items:center;margin-top:6px;">
              <span style="font-size:10px;color:#8a9ab5;width:70px;flex-shrink:0;">Muster</span>
              <select class="mp-input" style="flex:1;" bind:value={propWallHatchType} onchange={syncObjFromProps}>
                <option value="diagonal">45° Linien</option>
                <option value="cross">Kreuzschraffur</option>
                <option value="brick">Mauerwerk</option>
                <option value="concrete">Beton</option>
                <option value="insulation">Dämmung</option>
                <option value="none">Keine</option>
              </select>
            </div>
            <div class="pb-field-row" style="gap:8px;align-items:center;margin-top:6px;">
              <span style="font-size:10px;color:#8a9ab5;width:70px;flex-shrink:0;">Schraffurfarbe</span>
              <input type="color" class="obj-color-pick" value={propWallHatchColor}
                oninput={(e) => { propWallHatchColor = (e.target as HTMLInputElement).value; syncObjFromProps(); }}/>
              <span class="obj-color-hex">{propWallHatchColor}</span>
            </div>
          </div>
          <div class="pb-divider"></div>
        {/if}

        <!-- Pinsel (Brush-Tool aktiv oder Brush-Pfad selektiert) -->
        {#if activeTool === 'brush' || (selectedObj?.type === 'PFAD' && (selectedObj as DrawnPath).isBrush)}
          <div class="pb-group">
            <div class="pb-group-label">Pinsel</div>
            <div class="pb-field-row" style="gap:8px;align-items:center;margin-bottom:6px;">
              <span style="font-size:10px;color:#8a9ab5;width:52px;flex-shrink:0;">Farbe</span>
              <input type="color" class="obj-color-pick"
                value={selectedObj?.type === 'PFAD' && selectedObj.isBrush ? (selectedObj.fill || '#000000') : (objFill || '#000000')}
                oninput={(e) => {
                  const v = (e.target as HTMLInputElement).value;
                  objFill = v;
                  if (selectedObj?.type === 'PFAD' && selectedObj.isBrush) {
                    selectedObj.fill = v;
                    persistDbObject(selectedObj);
                    unsaved = true;
                  }
                }}/>
              <span class="obj-color-hex">{selectedObj?.type === 'PFAD' && selectedObj.isBrush ? (selectedObj.fill || '#000000') : (objFill || '#000000')}</span>
            </div>
            <div class="pb-field-row" style="gap:6px;align-items:center;margin-bottom:6px;">
              <span style="font-size:10px;color:#8a9ab5;width:52px;flex-shrink:0;">Größe</span>
              <input type="range" class="stroke-slider" min="2" max="80" step="1"
                bind:value={propBrushSize}
                oninput={() => {
                  if ((selectedObj as DrawnPath)?.isBrush) {
                    (selectedObj as DrawnPath).brushSize = propBrushSize;
                    (selectedObj as DrawnPath).d = brushPathD(
                      (selectedObj as DrawnPath).points,
                      propBrushSize,
                      (selectedObj as DrawnPath).brushForm ?? propBrushForm,
                      (selectedObj as DrawnPath).glaettung ?? propGlaettung
                    );
                    persistDbObject(selectedObj!);
                    unsaved = true;
                  }
                }}
                style="flex:1;"/>
              <span class="stroke-val">{propBrushSize}px</span>
            </div>
            <div style="display:flex;align-items:flex-start;gap:4px;">
              <span style="font-size:10px;color:#8a9ab5;width:52px;flex-shrink:0;padding-top:3px;">Form</span>
              <div style="display:flex;flex-wrap:wrap;gap:3px;">
              {#each ([['kreis','○'],['rechteck','□'],['linie','╱'],['gepunktet','⋯'],['faecher','彡'],['airbrush','∴'],['tinte','ι'],['kreide','≈'],['textur','▤'],['zickzack','∧'],['doppellinie','║']] as [string,string][]) as [f, icon]}
                <button class="text-fmt-btn" class:text-fmt-active={propBrushForm === (f as typeof propBrushForm)}
                  title={f} onclick={() => {
                    propBrushForm = (f as typeof propBrushForm);
                    if ((selectedObj as DrawnPath)?.isBrush) {
                      (selectedObj as DrawnPath).brushForm = (f as typeof propBrushForm);
                      (selectedObj as DrawnPath).d = brushPathD((selectedObj as DrawnPath).points, propBrushSize, (f as typeof propBrushForm), (selectedObj as DrawnPath).glaettung ?? propGlaettung);
                      persistDbObject(selectedObj!);
                      unsaved = true;
                    }
                  }}>{icon}</button>
              {/each}
              </div>
            </div>
            <div class="pb-field-row" style="gap:6px;align-items:center;margin-top:6px;">
              <span style="font-size:10px;color:#8a9ab5;width:52px;flex-shrink:0;">Glätten</span>
              <input type="range" class="stroke-slider" min="0" max="0.98" step="0.01"
                bind:value={propGlaettung}
                oninput={() => {
                  if ((selectedObj as DrawnPath)?.isBrush) {
                    (selectedObj as DrawnPath).glaettung = propGlaettung;
                    (selectedObj as DrawnPath).d = brushPathD((selectedObj as DrawnPath).points, propBrushSize, (selectedObj as DrawnPath).brushForm ?? propBrushForm, propGlaettung);
                    persistDbObject(selectedObj!);
                    unsaved = true;
                  }
                }}
                style="flex:1;"/>
              <span class="stroke-val">{Math.round(propGlaettung*100)}%</span>
            </div>
          </div>
          <div class="pb-divider"></div>
        {/if}

        <!-- Radierer -->
        {#if activeTool === 'eraser' && !selectedObj}
          <div class="pb-group">
            <div class="pb-group-label">Radierer</div>
            <div class="pb-field-row" style="gap:6px;align-items:center;">
              <span style="font-size:10px;color:#8a9ab5;width:52px;flex-shrink:0;">Größe</span>
              <input type="range" class="stroke-slider" min="4" max="100" step="1"
                bind:value={eraserSize} style="flex:1;"/>
              <span class="stroke-val">{eraserSize}px</span>
            </div>
          </div>
          <div class="pb-divider"></div>
        {/if}

        <!-- Bleistift / Kurve / Freihand-Pfad (nicht Brush) -->
        {#if (selectedObj?.type === 'PFAD' && !(selectedObj as DrawnPath).isBrush) || ((activeTool === 'pencil' || activeTool === 'arc') && !selectedObj)}
          <div class="pb-group">
            <div class="pb-group-label">Liniendicke</div>
            <div class="pb-field-row" style="gap:6px;align-items:center;">
              <input type="color" class="obj-color-pick" value={objStroke}
                oninput={(e)=>{ objStroke=(e.target as HTMLInputElement).value; syncObjFromProps(); }}/>
              <span class="obj-color-hex">{objStroke}</span>
              <select class="mp-input stroke-width-select"
                value={typeof objStrokeW === 'number' ? objStrokeW : 1}
                onchange={(e) => { objStrokeW = Number((e.target as HTMLSelectElement).value); syncObjFromProps(); }}>
                {#if typeof objStrokeW === 'number' && !strokeWidthOptions.includes(objStrokeW)}
                  <option value={objStrokeW}>{strokeWidthLabel(objStrokeW)}</option>
                {/if}
                {#each strokeWidthOptions as w}
                  <option value={w}>{strokeWidthLabel(w)}</option>
                {/each}
              </select>
            </div>
            {#if (selectedObj?.type === 'PFAD' && (selectedObj as DrawnPath).isCurve) || (activeTool === 'arc' && !selectedObj)}
              <div class="pb-field-row" style="gap:6px;align-items:center;margin-top:4px;">
                <label class="mp-radio">
                  <input type="checkbox" bind:checked={propCurveClosed} onchange={syncObjFromProps}/>
                  Geschlossener Bogen
                </label>
              </div>
            {/if}
            {#if (selectedObj?.type === 'PFAD' && !(selectedObj as DrawnPath).isCurve && (selectedObj as DrawnPath).points.length >= 2) || (activeTool === 'pencil' && !selectedObj)}
            <div class="pb-field-row" style="gap:6px;align-items:center;margin-top:4px;">
              <span style="font-size:10px;color:#8a9ab5;width:52px;flex-shrink:0;">Glätten</span>
              <input type="range" class="stroke-slider" min="0" max="0.98" step="0.01"
                bind:value={propGlaettung} oninput={syncObjFromProps} style="flex:1;"/>
              <span class="stroke-val">{Math.round(propGlaettung*100)}%</span>
            </div>
            {/if}
          </div>
          <div class="pb-divider"></div>
        {/if}

        <!-- Text-Eigenschaften -->
        {#if selectedObj?.type === 'TEXT' || (activeTool === 'text' && !selectedObj)}
          <div class="pb-group">
            <div class="pb-group-label">Textfarbe</div>
            <div class="pb-field-row" style="gap:6px;align-items:center;">
              <input type="color" class="obj-color-pick"
                value={objFill}
                oninput={(e) => { objFill = (e.target as HTMLInputElement).value; selectedObj?.type === 'TEXT' ? applyTextColor() : syncObjFromProps(); }}/>
              <span class="obj-color-hex">{objFill}</span>
            </div>
          </div>
          <div class="pb-divider"></div>
          <div class="pb-group">
            <div class="pb-group-label">Schrift</div>
            <div class="pb-field-row" style="gap:6px;flex-wrap:wrap;">
              <select class="mp-input" style="flex:2;min-width:120px;" bind:value={propFontFamily} onchange={() => selectedObj?.type === 'TEXT' ? applyTextFontFamily() : syncObjFromProps()}>
                <optgroup label="Sans-Serif">
                  <option value="'Helvetica Neue', Helvetica, Arial, sans-serif">Helvetica Neue</option>
                  <option value="Arial, sans-serif">Arial</option>
                  <option value="'Arial Narrow', Arial, sans-serif">Arial Narrow</option>
                  <option value="Verdana, sans-serif">Verdana</option>
                  <option value="Tahoma, sans-serif">Tahoma</option>
                  <option value="'Trebuchet MS', sans-serif">Trebuchet MS</option>
                  <option value="Calibri, sans-serif">Calibri</option>
                  <option value="Futura, 'Trebuchet MS', sans-serif">Futura</option>
                  <option value="Optima, Segoe, sans-serif">Optima</option>
                  <option value="Gill Sans, 'Gill Sans MT', sans-serif">Gill Sans</option>
                  <option value="'Lucida Sans', 'Lucida Grande', sans-serif">Lucida Sans</option>
                  <option value="'Segoe UI', system-ui, sans-serif">Segoe UI</option>
                  <option value="-apple-system, BlinkMacSystemFont, sans-serif">System (SF Pro)</option>
                </optgroup>
                <optgroup label="Serif">
                  <option value="'Times New Roman', Times, serif">Times New Roman</option>
                  <option value="Georgia, serif">Georgia</option>
                  <option value="Garamond, 'EB Garamond', serif">Garamond</option>
                  <option value="Palatino, 'Palatino Linotype', serif">Palatino</option>
                  <option value="'Book Antiqua', Palatino, serif">Book Antiqua</option>
                  <option value="Baskerville, 'Baskerville Old Face', serif">Baskerville</option>
                  <option value="Didot, 'Bodoni MT', serif">Didot</option>
                  <option value="'CMU Serif', 'Computer Modern', Georgia, serif">CMU Serif (LaTeX)</option>
                </optgroup>
                <optgroup label="Monospace">
                  <option value="'Courier New', Courier, monospace">Courier New</option>
                  <option value="'Lucida Console', Monaco, monospace">Lucida Console</option>
                  <option value="Monaco, 'Courier New', monospace">Monaco</option>
                  <option value="Menlo, 'Courier New', monospace">Menlo</option>
                  <option value="'SF Mono', Menlo, monospace">SF Mono</option>
                </optgroup>
                <optgroup label="Sonstige">
                  <option value="Impact, Charcoal, sans-serif">Impact</option>
                  <option value="'Arial Black', Gadget, sans-serif">Arial Black</option>
                  <option value="'Comic Sans MS', cursive">Comic Sans</option>
                  <option value="Papyrus, fantasy">Papyrus</option>
                </optgroup>
              </select>
              <select class="mp-input" style="width:70px;"
                value={propFontSize}
                onchange={(e) => { propFontSize = Number((e.target as HTMLSelectElement).value); selectedObj?.type === 'TEXT' ? applyTextFontSize() : syncObjFromProps(); }}>
                {#if ![6,7,8,9,10,11,12,14,16,18,20,24,28,32,36,42,48,56,64,72,96,120,144].includes(propFontSize)}
                  <option value={propFontSize}>{propFontSize}</option>
                {/if}
                {#each [6,7,8,9,10,11,12,14,16,18,20,24,28,32,36,42,48,56,64,72,96,120,144] as s}
                  <option value={s}>{s}</option>
                {/each}
              </select>
            </div>
            <div class="pb-field-row" style="gap:6px;margin-top:6px;">
              <button class="text-fmt-btn" class:text-fmt-active={propFontBold}
                onmousedown={(e) => e.preventDefault()}
                onclick={() => { propFontBold = !propFontBold; selectedObj?.type === 'TEXT' ? applyRichText('bold') : syncObjFromProps(); }}>
                <b>B</b>
              </button>
              <button class="text-fmt-btn" class:text-fmt-active={propFontItalic}
                onmousedown={(e) => e.preventDefault()}
                onclick={() => { propFontItalic = !propFontItalic; selectedObj?.type === 'TEXT' ? applyRichText('italic') : syncObjFromProps(); }}>
                <i>I</i>
              </button>
              <div style="width:1px;background:#2d3a50;margin:0 2px;"></div>
              <button class="text-fmt-btn" class:text-fmt-active={propTextAlign==='left'}    onmousedown={(e) => e.preventDefault()} onclick={() => { propTextAlign='left'; if (selectedObj?.type === 'TEXT') { selectedObj.textAlign = 'left'; persistDbObject(selectedObj); objects = [...objects]; } else syncObjFromProps(); }}>
                <svg viewBox="0 0 14 14" width="14" height="14"><line x1="1" y1="3" x2="13" y2="3" stroke="currentColor"/><line x1="1" y1="7" x2="9"  y2="7" stroke="currentColor"/><line x1="1" y1="11" x2="11" y2="11" stroke="currentColor"/></svg>
              </button>
              <button class="text-fmt-btn" class:text-fmt-active={propTextAlign==='center'}  onmousedown={(e) => e.preventDefault()} onclick={() => { propTextAlign='center'; if (selectedObj?.type === 'TEXT') { selectedObj.textAlign = 'center'; persistDbObject(selectedObj); objects = [...objects]; } else syncObjFromProps(); }}>
                <svg viewBox="0 0 14 14" width="14" height="14"><line x1="1" y1="3" x2="13" y2="3" stroke="currentColor"/><line x1="3" y1="7" x2="11" y2="7" stroke="currentColor"/><line x1="2" y1="11" x2="12" y2="11" stroke="currentColor"/></svg>
              </button>
              <button class="text-fmt-btn" class:text-fmt-active={propTextAlign==='right'}   onmousedown={(e) => e.preventDefault()} onclick={() => { propTextAlign='right'; if (selectedObj?.type === 'TEXT') { selectedObj.textAlign = 'right'; persistDbObject(selectedObj); objects = [...objects]; } else syncObjFromProps(); }}>
                <svg viewBox="0 0 14 14" width="14" height="14"><line x1="1" y1="3" x2="13" y2="3" stroke="currentColor"/><line x1="5" y1="7" x2="13" y2="7" stroke="currentColor"/><line x1="3" y1="11" x2="13" y2="11" stroke="currentColor"/></svg>
              </button>
              <div style="width:1px;background:#2d3a50;margin:0 2px;"></div>
              <button class="text-fmt-btn" title="Bearbeiten" disabled={!selectedObj}
                onmousedown={(e) => e.preventDefault()}
                onclick={() => { if(selectedObj) textEditUid = selectedObj.uid; }}>
                <svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor"><path d="M2 10 L9 3 L11 5 L4 12 Z"/><line x1="7" y1="5" x2="9" y2="7"/></svg>
              </button>
            </div>
            <div class="pb-field-row" style="margin-top:6px;gap:6px;">
              <span style="font-size:11px;color:#8a9ab5;">Zeilenabst.</span>
              <input type="number" class="mp-input" style="width:56px;" min="0.8" max="4" step="0.1" bind:value={propLineHeight} oninput={syncObjFromProps}/>
            </div>
          </div>
          <div class="pb-divider"></div>
        {/if}

        <!-- Linie / Maßlinie -->
        {#if selectedObj?.type === 'LINIE' || (activeTool === 'line' && !selectedObj)}
          {#if selectedObj?.type === 'LINIE'}
            <div class="pb-group">
              <div class="pb-group-label">Linie</div>
              <div class="pb-field-row">
                <span class="pb-axis-icon" style="font-size:10px;color:#8a9ab5;">L</span>
                <div class="pb-spinner">
                  <input
                    type="number"
                    step={unitStep}
                    min={unitStep}
                    class="sp-input"
                    bind:value={propLineLengthInput}
                    onchange={applyLineLength}
                    onkeydown={(ev) => { if (ev.key === 'Enter') applyLineLength(); }}
                  />
                  <span class="sp-unit">{einheit}</span>
                </div>
              </div>
            </div>
            <div class="pb-divider"></div>
          {/if}
          <div class="pb-group">
            <div class="pb-group-label">Pfeilenden</div>
            <div class="pb-field-row" style="gap:6px;">
              <span class="pb-axis-icon" style="font-size:10px;color:#8a9ab5;">Start</span>
              <select class="mp-input" style="flex:1;" bind:value={propArrowStart} onchange={syncObjFromProps}>
                <option value="none">Keiner</option>
                <option value="arrow">Pfeil</option>
                <option value="dot">Punkt</option>
                <option value="tick">Schrägstrich</option>
              </select>
              <span class="pb-axis-icon" style="font-size:10px;color:#8a9ab5;">Ende</span>
              <select class="mp-input" style="flex:1;" bind:value={propArrowEnd} onchange={syncObjFromProps}>
                <option value="none">Keiner</option>
                <option value="arrow">Pfeil</option>
                <option value="dot">Punkt</option>
                <option value="tick">Schrägstrich</option>
              </select>
            </div>
          </div>
          <div class="pb-group" style="margin-top:6px;">
            <div class="pb-group-label" style="display:flex;align-items:center;justify-content:space-between;">
              Maßlinie
              <label class="pb-toggle-label">
                <input type="checkbox" bind:checked={propIsMasslinie} onchange={syncObjFromProps}/>
                <span class="pb-toggle-track"></span>
              </label>
            </div>
            {#if propIsMasslinie}
              <div class="pb-field-row pb-field-stack">
                <div class="mp-mode-row">
                  <label class="mp-radio">
                    <input type="radio" bind:group={propMassTextPos} value="ueber" onchange={syncObjFromProps}/>
                    Über Linie
                  </label>
                  <label class="mp-radio">
                    <input type="radio" bind:group={propMassTextPos} value="in" onchange={syncObjFromProps}/>
                    In Linie
                  </label>
                </div>
                <label class="mp-label">Maßtext
                  <input class="mp-input" type="text" bind:value={propMassText} oninput={syncObjFromProps}/>
                </label>
                <div class="pb-field-row" style="gap:6px;">
                  <select class="mp-input" style="flex:1;min-width:0;" bind:value={propFontFamily} onchange={syncObjFromProps} title="Font">
                    <option value="'Helvetica Neue', Helvetica, Arial, sans-serif">Helvetica</option>
                    <option value="Arial, sans-serif">Arial</option>
                    <option value="Georgia, serif">Georgia</option>
                    <option value="'CMU Serif', 'Computer Modern', Georgia, serif">CMU Serif</option>
                    <option value="'Courier New', monospace">Courier</option>
                    <option value="system-ui, sans-serif">System</option>
                  </select>
                  <select class="mp-input" style="width:58px;"
                    value={propFontSize}
                    onchange={(e) => { propFontSize = Number((e.target as HTMLSelectElement).value); syncObjFromProps(); }}
                    title="Fontgröße">
                    {#if ![6,7,8,9,10,11,12,14,16,18,20,24,28,32,36,42,48,56,64,72,96].includes(propFontSize)}
                      <option value={propFontSize}>{propFontSize}</option>
                    {/if}
                    {#each [6,7,8,9,10,11,12,14,16,18,20,24,28,32,36,42,48,56,64,72,96] as s}
                      <option value={s}>{s}</option>
                    {/each}
                  </select>
                  <button class="text-fmt-btn" class:text-fmt-active={propFontBold} title="Fett"
                    onclick={() => { propFontBold = !propFontBold; syncObjFromProps(); }}>B</button>
                  <button class="text-fmt-btn" class:text-fmt-active={propFontItalic} title="Kursiv"
                    onclick={() => { propFontItalic = !propFontItalic; syncObjFromProps(); }}><i>I</i></button>
                </div>
              </div>
            {/if}
          </div>
          <div class="pb-divider"></div>
        {/if}

        <!-- Eckenradien (nur Rechteckformen) -->
        {#if selectedObj && selectedObj.type === 'RECHTECK' && selectedObj.shape !== 'ellipse' && selectedObj.shape !== 'polygon' && selectedObj.shape !== 'frame'}
          <div class="pb-group">
            <div class="pb-group-label" style="display:flex;align-items:center;justify-content:space-between;">
              Eckenradius
              <button class="radius-all-btn" title="Alle gleich setzen"
                onclick={() => { objRadiusOR = objRadiusUL = objRadiusUR = objRadiusOL; syncObjFromProps(); }}>
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5">
                  <rect x="2" y="2" width="12" height="12" rx="3"/>
                </svg>
              </button>
            </div>
            <div class="corner-style-picker">
              {#each [
                { id: 'round',   label: 'Rund',
                  svg: '<path d="M4 12 V6 Q6 4 8 4 H12" fill="none" stroke="currentColor" stroke-width="1.6"/>' },
                { id: 'chamfer', label: 'Fase',
                  svg: '<path d="M4 12 V8 L8 4 H12" fill="none" stroke="currentColor" stroke-width="1.6"/>' },
                { id: 'concave', label: 'Konkav',
                  svg: '<path d="M4 12 V6 Q4 4 8 4 H12" fill="none" stroke="currentColor" stroke-width="1.6"/>' },
              ] as s}
                <button class="corner-style-btn" class:corner-style-active={objCornerStyle === s.id}
                  title={s.label}
                  onclick={() => { objCornerStyle = s.id as 'round'|'chamfer'|'concave'; syncObjFromProps(); }}>
                  <svg viewBox="0 0 16 16" width="28" height="28" fill="none">{@html s.svg}</svg>
                </button>
              {/each}
            </div>
            <div class="radius-grid">
              <div class="radius-cell">
                <span class="radius-label">OL</span>
                <input type="number" class="radius-input" min="0" max="999" bind:value={objRadiusOL} onchange={syncObjFromProps}/>
              </div>
              <div class="radius-cell">
                <span class="radius-label">OR</span>
                <input type="number" class="radius-input" min="0" max="999" bind:value={objRadiusOR} onchange={syncObjFromProps}/>
              </div>
              <div class="radius-cell">
                <span class="radius-label">UL</span>
                <input type="number" class="radius-input" min="0" max="999" bind:value={objRadiusUL} onchange={syncObjFromProps}/>
              </div>
              <div class="radius-cell">
                <span class="radius-label">UR</span>
                <input type="number" class="radius-input" min="0" max="999" bind:value={objRadiusUR} onchange={syncObjFromProps}/>
              </div>
            </div>
          </div>
          <div class="pb-divider"></div>
        {/if}

        <!-- Kontur -->
        {#if selectedObj && selectedObj.type !== 'TEXT' && (selectedObj.type !== 'PFAD' || ((selectedObj as DrawnPath).isCurve && (selectedObj as DrawnPath).curveClosed) || (!(selectedObj as DrawnPath).isBrush && (selectedObj as DrawnPath).points.length === 0))}
          <div class="pb-group-row">
            <div class="pb-group">
              <div class="pb-group-label">{selectedObj.type === 'LINIE' ? 'Liniendicke' : 'Kontur'}</div>
              <div class="pb-field-row">
                <button class="none-btn" class:none-btn-active={objStroke === 'none' || objStroke === ''}
                  title="Ohne Kontur"
                  onclick={() => { objStroke = (objStroke === 'none' || objStroke === '') ? '#000000' : 'none'; syncObjFromProps(); }}>
                  <svg viewBox="0 0 14 14" width="14" height="14"><line x1="1" y1="13" x2="13" y2="1" stroke="currentColor" stroke-width="1.5"/><rect x="1" y="1" width="12" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
                </button>
                <input type="color" class="obj-color-pick"
                  value={objStroke === 'none' || objStroke === '' ? '#000000' : objStroke}
                  disabled={objStroke === 'none' || objStroke === ''}
                  oninput={(ev) => { objStroke = (ev.target as HTMLInputElement).value; syncObjFromProps(); }} />
                <span class="obj-color-hex">{objStroke || 'none'}</span>
              </div>
              <div class="pb-field-row" style="gap:6px;align-items:center;">
                <select class="mp-input stroke-width-select"
                  value={typeof objStrokeW === 'number' ? objStrokeW : 1}
                  onchange={(e) => { objStrokeW = Number((e.target as HTMLSelectElement).value); syncObjFromProps(); }}>
                  {#if typeof objStrokeW === 'number' && !strokeWidthOptions.includes(objStrokeW)}
                    <option value={objStrokeW}>{strokeWidthLabel(objStrokeW)}</option>
                  {/if}
                  {#each strokeWidthOptions as w}
                    <option value={w}>{strokeWidthLabel(w)}</option>
                  {/each}
                </select>
              </div>
            </div>
          </div>
          <div class="pb-divider"></div>
          <div class="pb-group">
            <div class="pb-group-label">Linienart</div>
            <div class="dash-picker">
              {#each [
                { label: 'Durchgezogen',     dash: ''          },
                { label: 'Gestrichelt',       dash: '6 3'       },
                { label: 'Gepunktet',         dash: '1.5 3'     },
                { label: 'Strich-Punkt',      dash: '8 3 1.5 3' },
                { label: 'Lang gestrichelt',  dash: '12 4'      },
              ] as d}
                <button
                  class="dash-btn"
                  class:dash-btn-active={objStrokeDash === d.dash}
                  title={d.label}
                  onclick={() => { objStrokeDash = d.dash; syncObjFromProps(); }}
                >
                  <svg viewBox="0 0 24 16" width="36" height="16">
                    <path d="M2 8 H22" stroke={objStroke || '#888'} stroke-width="2"
                      stroke-dasharray={d.dash || undefined} fill="none"/>
                  </svg>
                </button>
              {/each}
            </div>
          </div>
          <div class="pb-divider"></div>
        {/if}

        <!-- Bild -->
        {#if isImageFrameObject(selectedObj)}
          <div class="pb-group">
            <div class="pb-group-label">Bild</div>
            <div class="pb-field-row" style="gap:6px;">
              <button class="einpassen-btn" onclick={() => {
                if (isImageFrameObject(selectedObj)) { selectedObj.imageScale = 1; selectedObj.imageRenderW = undefined; selectedObj.imageRenderH = undefined; selectedObj.imageOffsetX = 0; selectedObj.imageOffsetY = 0; propImageScale = 1; persistDbObject(selectedObj); unsaved = true; }
              }}>Einpassen</button>
              <button class="einpassen-btn" class:einpassen-btn-active={imgPanMode}
                title="Bild innerhalb des Rahmens verschieben"
                onclick={() => { imgPanMode = !imgPanMode; }}>
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M8 2v12M2 8h12M5 5l-3 3 3 3M11 5l3 3-3 3"/>
                </svg>
              </button>
            </div>
            <div class="pb-field-row" style="gap:6px;align-items:center;margin-top:4px;">
              <input type="range" class="stroke-slider" min="0.5" max="3" step="0.05"
                value={isImageFrameObject(selectedObj) ? (selectedObj.imageScale ?? 1) : 1}
                oninput={(ev) => {
                  if (isImageFrameObject(selectedObj)) {
                    selectedObj.imageScale = parseFloat((ev.target as HTMLInputElement).value);
                    selectedObj.imageRenderW = undefined;
                    selectedObj.imageRenderH = undefined;
                    propImageScale = selectedObj.imageScale;
                    persistDbObject(selectedObj);
                    unsaved = true;
                  }
                }} />
              <span class="stroke-val">{Math.round((isImageFrameObject(selectedObj) ? (selectedObj.imageScale ?? 1) : 1) * 100)} %</span>
            </div>
          </div>
          <div class="pb-divider"></div>
        {/if}

        <!-- 6. Schatten (nur bei selektiertem Objekt) -->
        {#if selectedObj}
          <div class="pb-group">
            <div class="pb-group-label" style="display:flex;align-items:center;justify-content:space-between;">
              Schatten
              <label class="shadow-toggle">
                <input type="checkbox" bind:checked={objShadow} onchange={syncObjFromProps}/>
                <span class="shadow-toggle-track"></span>
              </label>
            </div>
            {#if objShadow}
              <div class="pb-field-row" style="gap:6px;align-items:center;margin-top:4px;">
                <span class="pb-axis" style="width:28px;flex-shrink:0;">X</span>
                <input type="range" class="stroke-slider" min="-30" max="30" step="1" bind:value={objShadowX} oninput={syncObjFromProps}/>
                <span class="stroke-val">{objShadowX}px</span>
              </div>
              <div class="pb-field-row" style="gap:6px;align-items:center;">
                <span class="pb-axis" style="width:28px;flex-shrink:0;">Y</span>
                <input type="range" class="stroke-slider" min="-30" max="30" step="1" bind:value={objShadowY} oninput={syncObjFromProps}/>
                <span class="stroke-val">{objShadowY}px</span>
              </div>
              <div class="pb-field-row" style="gap:6px;align-items:center;">
                <span class="pb-axis" style="width:28px;flex-shrink:0;font-size:9px;">Unsch.</span>
                <input type="range" class="stroke-slider" min="0" max="30" step="1" bind:value={objShadowBlur} oninput={syncObjFromProps}/>
                <span class="stroke-val">{objShadowBlur}px</span>
              </div>
              <div class="pb-field-row" style="gap:6px;align-items:center;margin-top:2px;">
                <span class="pb-axis" style="width:28px;flex-shrink:0;font-size:9px;">Farbe</span>
                <input type="color" class="obj-color-pick" bind:value={objShadowColor} oninput={syncObjFromProps}/>
                <span class="obj-color-hex">{objShadowColor}</span>
              </div>
            {/if}
          </div>
        {/if}

      </div>
      {/if}

      <!-- ── Füllung-Tab ──────────────────────────────────────────────── -->
      {#if propTab === 'fill'}
      <div class="pb-body">
        {#if selectedObj && selectedObj.type !== 'TEXT' && (selectedObj.type !== 'PFAD' || ((selectedObj as DrawnPath).isCurve && (selectedObj as DrawnPath).curveClosed) || (!(selectedObj as DrawnPath).isBrush && (selectedObj as DrawnPath).points.length === 0))}
          <div class="pb-group">
            <div class="pb-group-label">Füllen</div>
            <select class="gradient-type-select" bind:value={fillMode} onchange={() => { if (fillMode === 'solid') { objFill = gradientStart; syncObjFromProps(); } else applyGradientFill(); }}>
              <option value="solid">Farbe</option>
              <option value="linear">Linearer Verlauf</option>
              <option value="radial">Radialer Verlauf</option>
            </select>
            {#if fillMode !== 'solid'}
              <div class="gradient-editor">
                <div class="gradient-top-row">
                  <div class="gradient-preview" style="background:{gradientCss()};"></div>
                  <div class="gradient-angle">
                    <span>Winkel:</span>
                    <div class="gradient-angle-input">
                      <select bind:value={gradientAngle} onchange={applyGradientFill}>
                        {#each [0, 15, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330] as angle}
                          <option value={angle}>{angle}°</option>
                        {/each}
                      </select>
                    </div>
                  </div>
                  <button class="gradient-reverse-btn" title="Verlauf umkehren" onclick={reverseGradientFill}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M7 7h10a4 4 0 0 1 0 8H9"/>
                      <path d="M11 11l-4 4 4 4"/>
                      <path d="M17 4l4 4-4 4"/>
                    </svg>
                  </button>
                </div>
                <div class="gradient-ramp" style="background:{gradientCss()};">
                  <label class="gradient-stop gradient-stop-left" title="Startfarbe">
                    <input type="color" bind:value={gradientStart} oninput={applyGradientFill}/>
                  </label>
                  <label class="gradient-stop gradient-stop-right" title="Endfarbe">
                    <input type="color" bind:value={gradientEnd} oninput={applyGradientFill}/>
                  </label>
                </div>
              </div>
            {/if}
            <div class="gradient-presets">
              {#each gradientPresets as preset}
                {@const presetBg = preset.mode === 'radial' ? `radial-gradient(circle, ${preset.start}, ${preset.end})` : `linear-gradient(${preset.angle}deg, ${preset.start}, ${preset.end})`}
                <button
                  class="gradient-preset-btn"
                  class:gradient-preset-active={fillMode === preset.mode && gradientAngle === preset.angle && gradientStart === preset.start && gradientEnd === preset.end}
                  title={preset.name}
                  style="background:{presetBg};"
                  onclick={() => applyGradientPreset(preset)}
                ></button>
              {/each}
            </div>
            <div class="pb-field-row">
              <button class="none-btn" class:none-btn-active={objFill === 'none'}
                title="Ohne Füllung"
                onclick={() => { fillMode = 'solid'; objFill = objFill === 'none' ? gradientStart : 'none'; syncObjFromProps(); }}>
                <svg viewBox="0 0 14 14" width="14" height="14"><line x1="1" y1="13" x2="13" y2="1" stroke="currentColor" stroke-width="1.5"/><rect x="1" y="1" width="12" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
              </button>
              <input type="color" class="obj-color-pick" value={parseGradientValue(objFill) || objFill === 'none' ? gradientStart : objFill}
                disabled={objFill === 'none'}
                oninput={(ev) => { fillMode = 'solid'; gradientStart = (ev.target as HTMLInputElement).value; objFill = gradientStart; syncObjFromProps(); }} />
              <span class="obj-color-hex">{fillLabel(objFill)}</span>
            </div>
          </div>
        {:else}
          <div class="pb-empty">Für dieses Objekt gibt es keine Füllung.</div>
        {/if}
      </div>
      {/if}

      <!-- ── Raster-Tab ───────────────────────────────────────────────── -->
      {#if propTab === 'text'}
      <div class="pb-body">

        <!-- Checkboxen -->
        <div class="raster-checks">
          <label class="raster-check-label">
            <input type="checkbox" bind:checked={rasterEinblenden} onchange={() => {
              const re = ebenen.find(e => e.name === 'Raster');
              if (re) re.sichtbar = rasterEinblenden;
              updateRaster();
            }} />
            Gitter einblenden
          </label>
          <label class="raster-check-label">
            <input type="checkbox" bind:checked={rasterAusrichten} onchange={updateRaster} />
            Am Raster ausrichten
          </label>
        </div>

        <div class="pb-divider"></div>

        <!-- X/Y Abstand -->
        <div class="raster-row">
          <span class="raster-label">X Abstand:</span>
          <div class="pb-spinner raster-spinner">
            <button class="sp-arr" onclick={() => stepRaster('rasterXAbstand', 1)}>▲</button>
            <input type="number" class="sp-input" bind:value={rasterXAbstand} oninput={updateRaster} />
            <span class="sp-unit">mm</span>
            <button class="sp-arr" onclick={() => stepRaster('rasterXAbstand', -1)}>▼</button>
          </div>
        </div>
        <div class="raster-row">
          <span class="raster-label">Y Abstand:</span>
          <div class="pb-spinner raster-spinner">
            <button class="sp-arr" onclick={() => stepRaster('rasterYAbstand', 1)}>▲</button>
            <input type="number" class="sp-input" bind:value={rasterYAbstand} oninput={updateRaster} />
            <span class="sp-unit">mm</span>
            <button class="sp-arr" onclick={() => stepRaster('rasterYAbstand', -1)}>▼</button>
          </div>
        </div>
        <div class="raster-row">
          <span class="raster-label">Unterteilungen:</span>
          <div class="pb-spinner raster-spinner">
            <button class="sp-arr" onclick={() => stepRaster('rasterUnterteilung', 1)}>▲</button>
            <input type="number" class="sp-input" bind:value={rasterUnterteilung} oninput={updateRaster} />
            <span class="sp-unit"></span>
            <button class="sp-arr" onclick={() => stepRaster('rasterUnterteilung', -1)}>▼</button>
          </div>
        </div>

        <!-- Hilfslinien -->
        <div class="raster-row">
          <span class="raster-label">Hilfslinie:</span>
          <input type="color" class="raster-color" bind:value={rasterFarbe} oninput={updateRaster} />
          <span class="raster-color-hex">{rasterFarbe}</span>
        </div>
        <div class="raster-row raster-row-slider">
          <span class="raster-label">Dicke:</span>
          <input type="range" class="raster-slider" min="0.5" max="2" step="0.25"
            bind:value={rasterDicke} oninput={updateRasterDicke} />
          <input type="number" class="raster-width-input" min="0.5" max="2" step="0.25"
            bind:value={rasterDicke} oninput={updateRasterDicke} />
          <span class="raster-color-hex">px</span>
        </div>
        <div class="raster-row raster-row-slider">
          <span class="raster-label">Transparenz:</span>
          <input type="range" class="raster-slider" min="0" max="100" step="1"
            bind:value={rasterTransparenz} oninput={updateRaster} />
          <span class="raster-color-hex">{rasterTransparenz}%</span>
        </div>

        <div class="pb-divider"></div>

        <!-- Ränder -->
        <div class="raster-row">
          <span class="raster-label">Linker Rand:</span>
          <div class="pb-spinner raster-spinner">
            <button class="sp-arr" onclick={() => stepRaster('rasterRandL', 1)}>▲</button>
            <input type="number" class="sp-input" bind:value={rasterRandL} oninput={updateRaster} />
            <span class="sp-unit">mm</span>
            <button class="sp-arr" onclick={() => stepRaster('rasterRandL', -1)}>▼</button>
          </div>
        </div>
        <div class="raster-row">
          <span class="raster-label">Rechter Rand:</span>
          <div class="pb-spinner raster-spinner">
            <button class="sp-arr" onclick={() => stepRaster('rasterRandR', 1)}>▲</button>
            <input type="number" class="sp-input" bind:value={rasterRandR} oninput={updateRaster} />
            <span class="sp-unit">mm</span>
            <button class="sp-arr" onclick={() => stepRaster('rasterRandR', -1)}>▼</button>
          </div>
        </div>
        <div class="raster-row">
          <span class="raster-label">Oberer Rand:</span>
          <div class="pb-spinner raster-spinner">
            <button class="sp-arr" onclick={() => stepRaster('rasterRandO', 1)}>▲</button>
            <input type="number" class="sp-input" bind:value={rasterRandO} oninput={updateRaster} />
            <span class="sp-unit">mm</span>
            <button class="sp-arr" onclick={() => stepRaster('rasterRandO', -1)}>▼</button>
          </div>
        </div>
        <div class="raster-row">
          <span class="raster-label">Unterer Rand:</span>
          <div class="pb-spinner raster-spinner">
            <button class="sp-arr" onclick={() => stepRaster('rasterRandU', 1)}>▲</button>
            <input type="number" class="sp-input" bind:value={rasterRandU} oninput={updateRaster} />
            <span class="sp-unit">mm</span>
            <button class="sp-arr" onclick={() => stepRaster('rasterRandU', -1)}>▼</button>
          </div>
        </div>

        <div class="pb-divider"></div>

        <!-- Weitere Optionen -->
        <div class="raster-checks">
          <label class="raster-check-label">
            <input type="checkbox" bind:checked={rasterUeberRand} onchange={updateRaster} />
            Rasterlinie über Ränder hinausstr.
          </label>
          <label class="raster-check-label">
            <input type="checkbox" bind:checked={rasterRandVersatz} onchange={updateRaster} />
            Randversetzung Ursprung
          </label>
        </div>

      </div>
      {/if}

      <!-- ── Ausrichtung-Tab ───────────────────────────────────────────── -->
      {#if propTab === 'align'}
      <div class="pb-body align-body">
        <div class="align-row">
          <div class="align-label">Anordnen</div>
          <div class="align-buttons">
            <button class="align-btn" disabled={!selectedObjs.length} title="Ganz nach hinten" onclick={arrangeToBack}>
              <svg viewBox="0 0 24 24"><rect x="4" y="4" width="11" height="11"/><rect x="9" y="9" width="11" height="11"/></svg>
            </button>
            <button class="align-btn" disabled={!selectedObjs.length} title="Nach hinten" onclick={() => arrangeStep(-1)}>
              <svg viewBox="0 0 24 24"><rect x="5" y="5" width="12" height="12"/><rect x="9" y="9" width="10" height="10"/></svg>
            </button>
            <button class="align-btn" disabled={!selectedObjs.length} title="Nach vorne" onclick={() => arrangeStep(1)}>
              <svg viewBox="0 0 24 24"><rect x="7" y="7" width="12" height="12"/><rect x="3" y="3" width="10" height="10"/></svg>
            </button>
            <button class="align-btn" disabled={!selectedObjs.length} title="Ganz nach vorne" onclick={arrangeToFront}>
              <svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11"/><rect x="4" y="4" width="11" height="11"/></svg>
            </button>
          </div>
        </div>

        <div class="align-row">
          <div class="align-label">Gruppieren</div>
          <div class="align-buttons">
            <button class="align-btn" disabled={selectedObjs.length < 2} title="Gruppieren" onclick={arrangeGroup}>
              <svg viewBox="0 0 24 24"><rect x="5" y="7" width="12" height="10"/><path d="M3 5h4M17 5h4M3 19h4M17 19h4M3 5v4M21 5v4M3 15v4M21 15v4"/></svg>
            </button>
            <button class="align-btn" disabled={!selectedObjs.some(o => o.groupId)} title="Gruppierung aufheben" onclick={arrangeUngroup}>
              <svg viewBox="0 0 24 24"><rect x="5" y="7" width="5" height="5"/><rect x="14" y="12" width="5" height="5"/><path d="M3 5h5M16 5h5M3 19h5M16 19h5"/></svg>
            </button>
          </div>
        </div>

        <div class="align-row">
          <div class="align-label">Ausrichten</div>
          <div class="align-buttons align-grid">
            <button class="align-btn" disabled={selectedObjs.length < 2} title="Links ausrichten" onclick={() => alignSelected('left')}>
              <svg viewBox="0 0 24 24"><path d="M5 4v16"/><rect x="8" y="6" width="10" height="4"/><rect x="8" y="14" width="6" height="4"/></svg>
            </button>
            <button class="align-btn" disabled={selectedObjs.length < 2} title="Horizontal zentrieren" onclick={() => alignSelected('center')}>
              <svg viewBox="0 0 24 24"><path d="M12 4v16"/><rect x="7" y="6" width="10" height="4"/><rect x="9" y="14" width="6" height="4"/></svg>
            </button>
            <button class="align-btn" disabled={selectedObjs.length < 2} title="Oben ausrichten" onclick={() => alignSelected('top')}>
              <svg viewBox="0 0 24 24"><path d="M4 5h16"/><rect x="6" y="8" width="4" height="10"/><rect x="14" y="8" width="4" height="6"/></svg>
            </button>
            <button class="align-btn" disabled={selectedObjs.length < 2} title="Rechts ausrichten" onclick={() => alignSelected('right')}>
              <svg viewBox="0 0 24 24"><path d="M19 4v16"/><rect x="6" y="6" width="10" height="4"/><rect x="10" y="14" width="6" height="4"/></svg>
            </button>
            <button class="align-btn" disabled={selectedObjs.length < 2} title="Unten ausrichten" onclick={() => alignSelected('bottom')}>
              <svg viewBox="0 0 24 24"><path d="M4 19h16"/><rect x="6" y="6" width="4" height="10"/><rect x="14" y="10" width="4" height="6"/></svg>
            </button>
            <button class="align-btn" disabled={selectedObjs.length < 2} title="Vertikal zentrieren" onclick={() => alignSelected('middle')}>
              <svg viewBox="0 0 24 24"><path d="M4 12h16"/><rect x="6" y="7" width="4" height="10"/><rect x="14" y="9" width="4" height="6"/></svg>
            </button>
            <button class="align-btn" disabled={selectedObjs.length < 3} title="Horizontal verteilen" onclick={() => distributeSelected('x')}>
              <svg viewBox="0 0 24 24"><path d="M5 6v12M19 6v12"/><path d="M9 12h6"/><path d="M10 8l-3 4 3 4M14 8l3 4-3 4"/></svg>
            </button>
            <button class="align-btn" disabled={selectedObjs.length < 3} title="Vertikal verteilen" onclick={() => distributeSelected('y')}>
              <svg viewBox="0 0 24 24"><path d="M6 5h12M6 19h12"/><path d="M12 9v6"/><path d="M8 10l4-3 4 3M8 14l4 3 4-3"/></svg>
            </button>
          </div>
        </div>
      </div>
      {/if}

      <!-- ── Seite-Tab ──────────────────────────────────────────────────── -->
      {#if propTab === 'page'}
      <div class="pb-body">
        <div class="pb-group">
          <div class="pb-group-label">Seitengröße</div>
          <div class="raster-row">
            <span class="raster-label">Breite:</span>
            <div class="pb-spinner raster-spinner">
              <input type="number" class="sp-input" min="1" max="9999" bind:value={setupBreite} oninput={updatePageSettings}/>
              <span class="sp-unit">mm</span>
            </div>
          </div>
          <div class="raster-row">
            <span class="raster-label">Höhe:</span>
            <div class="pb-spinner raster-spinner">
              <input type="number" class="sp-input" min="1" max="9999" bind:value={setupHoehe} oninput={updatePageSettings}/>
              <span class="sp-unit">mm</span>
            </div>
          </div>
          <div class="pb-field-row" style="justify-content:flex-end;gap:8px;">
            <span class="setup-conv">{pxLabel(setupBreite)}</span>
            <span class="setup-conv">{pxLabel(setupHoehe)}</span>
          </div>
        </div>

        <div class="pb-divider"></div>

        <div class="pb-group">
          <div class="pb-group-label">Format</div>
          <div class="format-presets page-presets">
            {#each FORMATS as f}
              <button
                class="preset-btn"
                class:preset-active={!f.px && setupBreite === f.w && setupHoehe === f.h}
                onclick={() => { setupBreite = f.w; setupHoehe = f.h; updatePageSettings(); }}
              >
                <span>{f.label}</span>
                <span>{f.w} × {f.h}</span>
              </button>
            {/each}
          </div>
        </div>

        <div class="pb-divider"></div>

        <div class="pb-group">
          <div class="pb-group-label">Hintergrund</div>
          <div class="pb-field-row" style="gap:6px;align-items:center;">
            <input
              type="color"
              class="obj-color-pick"
              bind:value={setupHintergrund}
              disabled={setupHintergrundTransp}
              oninput={updatePageSettings}
            />
            <span class="obj-color-hex">{setupHintergrundTransp ? 'transparent' : setupHintergrund}</span>
          </div>
          <label class="raster-check-label">
            <input type="checkbox" bind:checked={setupHintergrundTransp} onchange={updatePageSettings}/>
            Transparent
          </label>
        </div>

        <div class="pb-divider"></div>

        <div class="pb-group">
          <div class="pb-group-label">Ansicht</div>
          <label class="raster-check-label">
            <input type="checkbox" bind:checked={linealSichtbar} onchange={updateRulerVisible}/>
            Lineale anzeigen
          </label>
        </div>

        <div class="pb-divider"></div>

        <div class="pb-group">
          <div class="pb-group-label">Einheit</div>
          <div class="seg">
            <button class="seg-btn" class:seg-active={setupEinheit==='px'} onclick={() => { setupEinheit='px'; updatePageSettings(); }}>px</button>
            <button class="seg-btn" class:seg-active={setupEinheit==='mm'} onclick={() => { setupEinheit='mm'; updatePageSettings(); }}>mm</button>
            <button class="seg-btn" class:seg-active={setupEinheit==='cm'} onclick={() => { setupEinheit='cm'; updatePageSettings(); }}>cm</button>
          </div>
        </div>

        <div class="pb-group">
          <div class="pb-group-label">Genauigkeit</div>
          <div class="seg">
            <button class="seg-btn" class:seg-active={setupGenauigkeit===1} onclick={() => { setupGenauigkeit=1; updatePageSettings(); }}>0.0</button>
            <button class="seg-btn" class:seg-active={setupGenauigkeit===2} onclick={() => { setupGenauigkeit=2; updatePageSettings(); }}>0.00</button>
            <button class="seg-btn" class:seg-active={setupGenauigkeit===3} onclick={() => { setupGenauigkeit=3; updatePageSettings(); }}>0.000</button>
          </div>
        </div>
      </div>
      {/if}

      <!-- ── Ebenen-Tab ────────────────────────────────────────────────── -->
      {#if propTab === 'ebenen'}
      <div class="eb-panel">

        <!-- Ebenen-Liste (oben = vorderste, scrollbar) -->
        <div class="eb-scroll">
        <div class="eb-list" bind:this={ebListEl}>
          {#each ebenen as e, i}
            {@const isRaster = e.name === 'Raster'}
            {@const collapsed = collapsedEbenen.has(e.name)}
            {@const layerObjs = objects.filter(o => o.ebene === e.name)}
            <div
              class="eb-row"
              class:eb-row-active={aktiveEbene === e.name}
              class:eb-row-raster={isRaster}
              class:eb-row-dragover={dragOverIdx === i && !isRaster}
              class:eb-row-dragging={dragSrc === e}
              ondragstart={(ev) => ev.preventDefault()}
              onclick={() => { if (!isRaster) aktiveEbene = e.name; }}
            >
              <!-- Aufklapp-Pfeil -->
              <button class="eb-collapse-btn" onclick={(ev) => {
                ev.stopPropagation();
                const s = new Set(collapsedEbenen);
                s.has(e.name) ? s.delete(e.name) : s.add(e.name);
                collapsedEbenen = s;
              }}>
                <svg viewBox="0 0 10 10" width="10" height="10" fill="currentColor"
                  style="transform:rotate({collapsed ? -90 : 0}deg);transition:transform .15s;">
                  <polygon points="2,3 8,3 5,7"/>
                </svg>
              </button>
              <!-- Grip -->
              {#if !isRaster}
                <span class="eb-grip" onmousedown={(ev) => onGripDown(ev, e)}>
                  <svg viewBox="0 0 10 16" width="10" height="16" fill="currentColor">
                    <circle cx="3" cy="3" r="1.2"/><circle cx="7" cy="3" r="1.2"/>
                    <circle cx="3" cy="8" r="1.2"/><circle cx="7" cy="8" r="1.2"/>
                    <circle cx="3" cy="13" r="1.2"/><circle cx="7" cy="13" r="1.2"/>
                  </svg>
                </span>
              {:else}
                <span class="eb-grip-placeholder"></span>
              {/if}
              <!-- Sichtbarkeit -->
              <button class="eb-icon-btn" title="Sichtbarkeit" onclick={(ev) => { ev.stopPropagation(); toggleEbeneSichtbar(e); }}>
                {#if e.sichtbar}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                {:else}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                {/if}
              </button>
              <!-- Sperren -->
              <button class="eb-icon-btn" title="Sperren" onclick={(ev) => { ev.stopPropagation(); toggleEbeneGesperrt(e); }}>
                {#if e.gesperrt}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
                {:else}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.29-1.29"/></svg>
                {/if}
              </button>
              <!-- Name (editierbar per Doppelklick) -->
              {#if editingEbene === e.name}
                <input
                  class="eb-name-input"
                  value={e.name}
                  onclick={(ev) => ev.stopPropagation()}
                  onblur={(ev) => renameEbene(e, ev.currentTarget.value)}
                  onkeydown={(ev) => {
                    if (ev.key === 'Enter') renameEbene(e, ev.currentTarget.value);
                    if (ev.key === 'Escape') editingEbene = null;
                  }}
                />
              {:else}
                <span class="eb-name" ondblclick={(ev) => { ev.stopPropagation(); if (!isRaster) editingEbene = e.name; }}>
                  {e.name}
                  {#if aktiveEbene === e.name && !isRaster}
                    <span class="eb-active-pill">aktiv</span>
                  {/if}
                </span>
              {/if}
              <!-- Löschen (nicht bei Raster) -->
              {#if !isRaster}
                <button class="eb-icon-btn eb-del" title="Ebene löschen"
                  onclick={(ev) => { ev.stopPropagation(); deleteEbene(e); }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              {/if}
            </div>
            <!-- Transparenz-Zeile (ausgeklappt) -->
            {#if !collapsed}
              <div class="eb-opacity-row" onclick={(ev) => ev.stopPropagation()}>
                <span class="eb-opacity-label">Transparenz</span>
                <input type="range" class="eb-opacity-slider" min="0" max="100" step="1"
                  bind:value={e.opacity}
                  oninput={() => unsaved = true}
                />
                <span class="eb-opacity-val">{e.opacity ?? 100}%</span>
              </div>
            {/if}

            <!-- Objekte dieser Ebene (ausgeklappt) -->
            {#if !collapsed}
              {#each layerObjs as obj, oi}
                <div
                  class="eb-obj-row"
                  class:eb-obj-selected={selectedObj === obj || selectedObjs.includes(obj)}
                  onclick={(ev) => {
                    ev.stopPropagation();
                    const currentTab = propTab;
                    selectOne(obj);
                    propTab = currentTab;
                    aktiveEbene = obj.ebene;
                  }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12" style="flex-shrink:0;color:#666;">
                    <rect x="3" y="5" width="18" height="14"/>
                  </svg>
                  <span class="eb-obj-name">{objectLayerName(obj, oi)}</span>
                  <button
                    class="eb-icon-btn eb-obj-lock"
                    class:eb-obj-lock-on={obj.gesperrt}
                    title={obj.gesperrt ? 'Objekt entsperren' : 'Objekt schützen'}
                    onclick={(ev) => {
                      ev.stopPropagation();
                      toggleObjectProtected(obj);
                    }}
                  >
                    {#if obj.gesperrt}
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="5" y="11" width="14" height="10" rx="2"/>
                        <path d="M8 11V8a4 4 0 0 1 8 0v3"/>
                      </svg>
                    {:else}
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="5" y="11" width="14" height="10" rx="2"/>
                        <path d="M8 11V8a4 4 0 0 1 7.4-2.1"/>
                      </svg>
                    {/if}
                  </button>
                  <button
                    class="eb-icon-btn eb-obj-delete"
                    title="Objekt löschen"
                    onclick={(ev) => {
                      ev.stopPropagation();
                      if (obj.gesperrt) return;
                      pushUndo();
                      deletePersistedObjects([obj]);
                      objects = objects.filter(o => o !== obj);
                      if (selectedObj === obj) clearSelection();
                      else selectedObjs = selectedObjs.filter(o => o !== obj);
                      unsaved = true;
                    }}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
                    </svg>
                  </button>
                </div>
              {/each}
            {/if}
          {/each}
        </div>
        </div><!-- eb-scroll -->

        <!-- Neue Ebene — fest am unteren Rand -->
        <div class="eb-footer">
          <button class="eb-add-btn" onclick={addEbene}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Neue Ebene
          </button>
        </div>

      </div><!-- eb-panel -->
      {/if}

      <!-- ── Formen-Tab ───────────────────────────────────────────────── -->
      {#if propTab === 'formen'}
      <div class="shapes-panel">
        <!-- Eigene gespeicherte Formen -->
        <div class="saved-shapes-section">
          <div class="saved-shapes-header">
            <span class="saved-shapes-title">Eigene Formen</span>
            <button class="saved-shapes-save-btn" title="Auswahl (oder alle) als Form speichern" onclick={() => { shapeSaveName = ''; shapeSaveGruppe = ''; shapeSaveDialogOpen = true; }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Speichern
            </button>
          </div>
          {#if savedShapes.length === 0}
            <div class="saved-shapes-empty">Noch keine eigenen Formen gespeichert.</div>
          {:else}
            {#each savedShapeGroups() as grp}
              {@const grpCollapsed = collapsedSavedGroups.has(grp.name)}
              <div class="shape-group">
                <button class="shape-group-head" onclick={() => {
                  const s = new Set(collapsedSavedGroups);
                  s.has(grp.name) ? s.delete(grp.name) : s.add(grp.name);
                  collapsedSavedGroups = s;
                }}>
                  <svg viewBox="0 0 10 10" width="10" height="10" fill="currentColor"
                    style="transform:rotate({grpCollapsed ? -90 : 0}deg);transition:transform .15s;">
                    <polygon points="2,3 8,3 5,7"/>
                  </svg>
                  <span>{grp.name}</span>
                </button>
                {#if !grpCollapsed}
                  <div class="shape-tree">
                    {#each grp.items as s}
                      <div class="saved-shape-item">
                        <button class="saved-shape-insert" title="Form einfügen" onclick={() => insertSavedShape(s)}>
                          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" width="18" height="18"><rect x="2" y="2" width="16" height="16" rx="2"/><path d="M10 6v8M6 10h8" stroke-width="2"/></svg>
                          {#if s.preview_svg}
                            <span class="shape-lib-preview" style="flex-shrink:0;">{@html s.preview_svg}</span>
                          {/if}
                          <span>{s.name}</span>
                        </button>
                        <button class="saved-shape-del" title="Form löschen" onclick={() => doDeleteShape(s.id)}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        </button>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          {/if}
        </div>

        <div class="shapes-hint" style="padding-top:10px;">Klick auf eine Vorlage fügt sie auf der Zeichenfläche ein.</div>
        <div class="shapes-scroll">
          {#each libraryShapeGroups as group}
            {@const collapsed = collapsedShapeGroups.has(group.name)}
            <div class="shape-group">
              <button class="shape-group-head" onclick={() => {
                const s = new Set(collapsedShapeGroups);
                s.has(group.name) ? s.delete(group.name) : s.add(group.name);
                collapsedShapeGroups = s;
              }}>
                <svg viewBox="0 0 10 10" width="10" height="10" fill="currentColor"
                  style="transform:rotate({collapsed ? -90 : 0}deg);transition:transform .15s;">
                  <polygon points="2,3 8,3 5,7"/>
                </svg>
                <span>{group.name}</span>
              </button>
              {#if !collapsed}
                <div class="shape-tree">
                  {#each group.items as item}
                    <div class="saved-shape-item">
                      <button class="saved-shape-insert" title={item.label} onclick={() => addShapeFromTemplate(item, canvasW / 2, canvasH / 2)}>
                        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" width="18" height="18"><rect x="2" y="2" width="16" height="16" rx="2"/><path d="M10 6v8M6 10h8" stroke-width="2"/></svg>
                        <svg class="shape-lib-preview" viewBox="0 0 {item.kind === 'path' ? (item.vbW ?? item.w) : item.w} {item.kind === 'path' ? (item.vbH ?? item.h) : item.h}" preserveAspectRatio="xMidYMid meet" width="22" height="22">
                          {#if item.kind === 'rect'}
                            {#if item.shape === 'ellipse'}
                              <ellipse cx={item.w/2} cy={item.h/2} rx={item.w/2-2} ry={item.h/2-2} fill={item.fill} stroke={item.stroke} stroke-width={shapeStrokeW(item)}/>
                            {:else}
                              <rect x="1" y="1" width={item.w-2} height={item.h-2} rx={item.r??0} fill={item.fill} stroke={item.stroke} stroke-width={shapeStrokeW(item)}/>
                            {/if}
                          {:else}
                            <path d={item.d} fill={item.fill} stroke={item.stroke} stroke-width={shapeStrokeW(item)} stroke-linejoin="round" stroke-linecap="round"/>
                          {/if}
                        </svg>
                        <span>{item.label}</span>
                      </button>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
      {/if}

    </aside>

  </div><!-- workspace -->


  <!-- Footer -->
  <footer class="app-footer">
    <div class="zoom-area">
      <span class="zoom-label">Zoom</span>
      <div class="zoom-separator"></div>
      <div class="zoom-value-box">
        {Math.round(zoomPercent)} %
      </div>
      <select class="zoom-select" bind:value={zoomPercent} title="Zoom-Rastwert wählen">
        {#each zoomStops as stop}
          <option value={stop}>{stop} %</option>
        {/each}
      </select>
      <div class="zoom-slider-wrap">
        <input
          class="zoom-slider"
          type="range"
          min="25" max="400" step="1"
          value={zoomPercent}
          oninput={(ev) => handleZoomSliderInput((ev.currentTarget as HTMLInputElement).value)}
          onpointerup={snapZoomIfClose}
          onkeyup={snapZoomIfClose}
        />
      </div>
      <button class="fit-btn" onclick={fitToWindow} title="An Fenster anpassen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="13" height="13">
          <path d="M3 7V3h4M17 3h4v4M21 17v4h-4M7 21H3v-4"/>
          <rect x="7" y="7" width="10" height="10" rx="1"/>
        </svg>
        Anpassen
      </button>
    </div>
  </footer>

</div>

{#if imagePickerOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div style="position:fixed;inset:0;z-index:299;" onclick={() => imagePickerOpen = false}></div>
  <div style="position:fixed;left:{imagePickerX + 50}px;top:{imagePickerY}px;z-index:300;background:#1e2433;border:1px solid #2d3a50;border-radius:8px;padding:8px;box-shadow:0 8px 24px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:4px;min-width:130px;">
    <div class="img-picker-title">Rahmenform</div>
    <button class="img-picker-btn" class:img-picker-active={imageFrameShape==='rect'}
      onclick={() => { imageFrameShape = 'rect'; activeTool = 'image'; imagePickerOpen = false; selectedObj = null; selectedObjs = []; propTab = 'geo'; setToolDefaults('image'); }}>
      <svg viewBox="0 0 24 20" fill="none" stroke="currentColor" stroke-width="1.6" width="28" height="22"><rect x="2" y="2" width="20" height="16"/></svg>
      Rechteck
    </button>
    <button class="img-picker-btn" class:img-picker-active={imageFrameShape==='circle'}
      onclick={() => { imageFrameShape = 'circle'; activeTool = 'image'; imagePickerOpen = false; selectedObj = null; selectedObjs = []; propTab = 'geo'; setToolDefaults('image'); }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="24" height="24"><ellipse cx="12" cy="12" rx="10" ry="8"/></svg>
      Ellipse
    </button>
  </div>
{/if}

{#if measurePickerOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div style="position:fixed;inset:0;z-index:299;" onclick={() => measurePickerOpen = false}></div>
  <div style="position:fixed;left:{measurePickerX + 50}px;top:{measurePickerY}px;z-index:300;background:#1e2433;border:1px solid #2d3a50;border-radius:8px;padding:8px;box-shadow:0 8px 24px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:4px;min-width:130px;">
    <div class="img-picker-title">Einheit</div>
    {#each [{id:'mm',label:'Millimeter'},{id:'cm',label:'Zentimeter'},{id:'px',label:'Pixel'}] as u}
      <label class="measure-radio-row" class:measure-radio-active={measureUnit === u.id}>
        <input type="radio" name="measure-unit" value={u.id} checked={measureUnit === u.id}
          onclick={() => { measureUnit = u.id as 'px'|'mm'|'cm'; measurePickerOpen = false; activeTool = 'measure'; measuringLine = null; }} />
        <span class="measure-radio-key">{u.id}</span>
        <span>{u.label}</span>
      </label>
    {/each}
  </div>
{/if}

<style>
  @font-face { font-family: "CMU Serif"; font-style: roman;  font-weight: 500; src: url("/fonts/cmu-serif-500-roman.woff2")  format("woff2"); }
  @font-face { font-family: "CMU Serif"; font-style: italic; font-weight: 500; src: url("/fonts/cmu-serif-500-italic.woff2") format("woff2"); }
  @font-face { font-family: "CMU Serif"; font-style: roman;  font-weight: 700; src: url("/fonts/cmu-serif-700-roman.woff2")  format("woff2"); }
  @font-face { font-family: "CMU Serif"; font-style: italic; font-weight: 700; src: url("/fonts/cmu-serif-700-italic.woff2") format("woff2"); }
  :global(html, body) {
    margin: 0; padding: 0;
    width: 100%; height: 100%;
    overflow: hidden;
    background: #111827;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: #d1d5db;
    font-size: 13px;
  }

  /* ── Setup Dialog ─────────────────────────────────────────────────────── */
  .setup-backdrop {
    position: fixed; inset: 0;
    background: rgba(0,0,0,.72);
    display: flex; align-items: center; justify-content: center;
    z-index: 500;
  }
  .multi-paste-dialog {
    background: #1e2433; border: 1px solid #2d3a50; border-radius: 10px;
    width: 340px; display: flex; flex-direction: column; overflow: hidden;
  }
  .about-dialog {
    background: #1e2433; border: 1px solid #2d3a50; border-radius: 10px;
    width: 460px; display: flex; flex-direction: column; overflow: hidden;
  }
  .about-dialog-header {
    position: relative;
    display: flex; align-items: center; justify-content: center;
    padding: 10px 40px;
    border-bottom: 1px solid #2d3a50;
    background: linear-gradient(#303338, #25282d);
    min-height: 38px;
  }
  .about-dialog-title {
    font-size: 14px; font-weight: 650; color: #e8e8e8;
  }
  .about-dialog-close {
    position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
    background: none; border: none; color: #8899aa;
    font-size: 14px; cursor: pointer; padding: 4px 6px; border-radius: 4px;
    line-height: 1;
  }
  .about-dialog-close:hover { color: #fff; background: rgba(255,255,255,.1); }
  .about-body {
    padding: 18px 22px;
    display: flex; flex-direction: column; gap: 14px;
  }
  .about-head {
    display: flex; align-items: center; gap: 14px;
  }
  .about-logo {
    width: 48px; height: 48px; border-radius: 9px;
    display: grid; place-items: center;
    background: #172238; border: 1px solid #31527d;
    color: #7db7f0; font-size: 24px; font-weight: 700;
  }
  .about-title { color: #e5eef8; font-size: 19px; font-weight: 650; }
  .about-version { color: #7e8fa8; font-size: 12px; margin-top: 4px; }
  .about-text {
    margin: 0;
    color: #c8d6ef;
    font-size: 12px;
    line-height: 1.45;
  }
  .about-grid {
    display: grid;
    grid-template-columns: 135px 1fr;
    gap: 5px 12px;
    font-size: 12px;
  }
  .about-grid span { color: #7e8fa8; }
  .about-grid strong { color: #dbe7f4; font-weight: 600; }
  .about-section-title {
    color: #8a9ab5;
    font-size: 11px;
    font-weight: 700;
    margin-bottom: 7px;
  }
  .about-tools {
    width: 100%;
    border-top: 1px solid #2d3a50;
    padding-top: 11px;
  }
  .about-tool-list {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .about-tool-list span {
    background: #141926;
    border: 1px solid #2d3a50;
    border-radius: 4px;
    color: #b8c8d8;
    font-size: 11px;
    padding: 3px 6px;
  }
  .multi-paste-body { padding: 16px 20px; display: flex; flex-direction: column; gap: 14px; }
  .mp-label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: #8a9ab5; }
  .mp-input {
    background: #141926; border: 1px solid #2d3a50; border-radius: 5px;
    color: #c8d6ef; font-size: 13px; padding: 4px 7px; width: 100%; box-sizing: border-box;
  }
  .mp-input:focus { outline: none; border-color: #3b82f6; }
  .mp-mode-row { display: flex; gap: 20px; }
  .mp-radio { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #c8d6ef; cursor: pointer; }
  .mp-xy-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .mp-hint { font-size: 11px; color: #5c6e8a; margin: 0; line-height: 1.5; }
  .pdf-dialog {
    background: #1e2433; border: 1px solid #2d3a50; border-radius: 10px;
    width: min(820px, 94vw); height: 88vh;
    display: flex; flex-direction: column; overflow: hidden;
  }
  .pdf-main {
    flex: 1; display: flex; overflow: hidden;
  }
  .pdf-preview-area {
    flex: 1; overflow: auto; background: #111827;
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  .pdf-preview-area :global(svg) {
    max-width: 100%; max-height: 100%;
    width: auto; height: auto;
    box-shadow: 0 4px 24px rgba(0,0,0,.5);
    display: block; flex-shrink: 0;
  }
  .pdf-sidebar {
    width: 180px; flex-shrink: 0;
    background: #1a2230; border-left: 1px solid #2d3a50;
    overflow-y: auto; padding: 12px 0;
  }
  .pdf-sidebar-section {
    padding: 0 14px 12px; margin-bottom: 4px;
    border-bottom: 1px solid #253040;
  }
  .pdf-sidebar-section:last-child { border-bottom: none; }
  .pdf-sidebar-label {
    font-size: 10px; font-weight: 600; color: #4a6080;
    text-transform: uppercase; letter-spacing: .06em;
    margin-bottom: 6px; padding-top: 4px;
  }
  .pdf-sidebar-row {
    display: flex; justify-content: space-between; align-items: center;
    font-size: 11px; color: #8899aa; padding: 2px 0; gap: 6px;
  }
  .pdf-sidebar-row span:last-child { color: #ccd6e0; text-align: right; }
  .pdf-color-dot {
    width: 14px; height: 14px; border-radius: 3px; flex-shrink: 0;
  }
  .pdf-dpi-picker { display: flex; gap: 4px; margin-top: 4px; }
  .pdf-dpi-btn {
    flex: 1; font-size: 10px; padding: 3px 0;
    background: #1e2b3c; border: 1px solid #2a3a50; color: #8899aa;
    border-radius: 4px; cursor: pointer; transition: border-color .15s;
  }
  .pdf-dpi-btn:hover { border-color: #4a6080; color: #ccd6e0; }
  .pdf-dpi-active { border-color: #3b82f6 !important; background: #1a2a40 !important; color: #60a5fa !important; }
  .pdf-layer-hidden { opacity: .45; }
  .pdf-layer-hidden span:last-child { text-decoration: line-through; }
  .setup-dialog {
    background: #1b1d22;
    border: 1px solid #4a4d52;
    border-radius: 8px;
    width: min(720px, 92vw);
    max-height: 92vh;
    display: flex; flex-direction: column;
    box-shadow: 0 24px 64px rgba(0,0,0,.65);
    overflow: hidden;
  }
  .setup-dialog .setup-header {
    position: relative;
    min-height: 36px;
    padding: 0 36px;
    border-bottom: 1px solid #34373c;
    background: linear-gradient(#303338, #25282d);
    display: flex; align-items: center; justify-content: center;
  }
  .setup-title {
    font-size: 15px; font-weight: 650; color: #e8e8e8;
  }
  .setup-close-round {
    position: absolute; left: 10px; top: 8px;
    width: 20px; height: 20px; border-radius: 50%;
    border: none; background: #c7c7c7; color: #5d6065;
    font-size: 18px; line-height: 18px; font-weight: 800;
    cursor: pointer; display: grid; place-items: center;
  }
  .setup-body {
    padding: 28px 44px 18px;
    overflow: hidden; flex: 1;
    display: block;
    background: linear-gradient(#181a1f, #202328);
  }
  .template-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(110px, 1fr));
    gap: 16px 18px;
  }
  .template-card {
    position: relative;
    border: none;
    background: transparent;
    padding: 0 0 22px;
    color: #f0f0f0;
    cursor: pointer;
    min-width: 0;
  }
  .template-preview {
    position: relative;
    height: 80px;
    display: grid; place-items: center;
    border: 1px solid #b7b7b7;
    box-shadow: 0 2px 6px rgba(0,0,0,.55);
    font-size: 15px;
    color: #111;
    overflow: hidden;
  }
  .template-preview::after {
    content: '';
    position: absolute; left: 0; right: 0; top: calc(100% + 5px);
    height: 34px;
    background: inherit;
    transform: scaleY(-1);
    opacity: .28;
    mask-image: linear-gradient(to bottom, rgba(0,0,0,.8), transparent);
  }
  .template-preview span { position: relative; z-index: 1; }
  .template-label {
    position: absolute; left: 0; right: 0; top: 92px;
    text-align: center;
    color: #f5f5f5;
    font-size: 13px;
    font-weight: 600;
    text-shadow: 0 1px 2px rgba(0,0,0,.75);
  }
  .template-active .template-preview {
    outline: 4px solid #0a98ff;
    outline-offset: 3px;
  }
  .tpl-blank { background: #fff; }
  .tpl-gradient { background: linear-gradient(#22242b, #73748e); color: #fff; }
  .tpl-grid {
    background-color: #fbfbfb;
    background-image:
      linear-gradient(rgba(0,0,0,.22) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0,0,0,.22) 1px, transparent 1px),
      linear-gradient(rgba(0,0,0,.08) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0,0,0,.08) 1px, transparent 1px);
    background-size: 30px 30px, 30px 30px, 10px 10px, 10px 10px;
  }
  .tpl-graph {
    background-color: #f0ffe7;
    background-image:
      linear-gradient(rgba(86,190,88,.22) 1px, transparent 1px),
      linear-gradient(90deg, rgba(86,190,88,.22) 1px, transparent 1px);
    background-size: 10px 10px;
  }
  .tpl-notepad {
    background-color: #fffcb9;
    background-image:
      linear-gradient(90deg, transparent 30px, rgba(255,70,70,.65) 31px, transparent 32px),
      linear-gradient(rgba(92,170,210,.55) 1px, transparent 1px);
    background-size: 100% 100%, 100% 21px;
  }
  .tpl-looseleaf {
    background-color: #fff;
    background-image:
      linear-gradient(90deg, transparent 30px, rgba(255,70,70,.65) 31px, transparent 32px),
      linear-gradient(rgba(80,170,220,.36) 1px, transparent 1px);
    background-size: 100% 100%, 100% 21px;
  }
  .tpl-lined {
    background-color: #f8f8f8;
    background-image: linear-gradient(rgba(0,0,0,.25) 1px, transparent 1px);
    background-size: 100% 17px;
  }
  .tpl-blueprint {
    background-color: #0678b8;
    background-image:
      linear-gradient(rgba(255,255,255,.17) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.17) 1px, transparent 1px),
      radial-gradient(circle at 50% 50%, rgba(255,255,255,.08), transparent 55%);
    background-size: 12px 12px, 12px 12px, 100% 100%;
    color: #fff;
  }
  .setup-options {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 22px;
    padding: 12px 32px;
    background: #303236;
    border-top: 1px solid #484b50;
  }
  .setup-options-left,
  .setup-options-right {
    display: flex; flex-direction: column; gap: 8px;
  }
  .setup-line {
    display: flex; align-items: center; gap: 8px;
  }
  .setup-line label {
    width: 96px;
    text-align: right;
    color: #f1f1f1;
    font-size: 13px;
    font-weight: 400;
  }
  .setup-options-right .setup-line label { width: 68px; }
  .setup-select,
  .setup-unit-select {
    height: 26px;
    background: linear-gradient(#3d4046, #24272c);
    border: 1px solid #0f1114;
    border-radius: 5px;
    color: #f0f0f0;
    font-size: 13px;
    font-weight: 400;
    padding: 0 8px;
  }
  .setup-select { width: 188px; }
  .setup-color-mode { width: 105px; }
  .setup-unit-select { width: 113px; }
  .setup-number-bright {
    width: 82px; height: 26px;
    border: 1px solid #111;
    border-radius: 4px;
    background: #fbffe4;
    color: #0b0b0b;
    font-size: 13px;
    font-weight: 400;
    text-align: right;
    padding: 0 6px;
    box-sizing: border-box;
  }

  .setup-section {
    display: flex; flex-direction: column; gap: 10px;
  }
  .setup-section-title {
    font-size: 10px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 1px;
    color: #556070;
    padding-bottom: 6px;
    border-bottom: 1px solid #262f3f;
  }

  .setup-row {
    display: flex; align-items: center; gap: 10px;
  }
  .setup-row label {
    width: 90px; font-size: 12px; color: #8899aa;
    flex-shrink: 0;
  }
  .setup-field {
    display: flex; align-items: center; gap: 6px;
    background: #141c2a; border: 1px solid #2a3650;
    border-radius: 6px; padding: 5px 10px;
    width: 110px; box-sizing: border-box;
  }
  .setup-field input {
    width: 64px; background: none; border: none;
    outline: none; color: #d0dce8; font-size: 13px;
    min-width: 0;
  }
  /* remove number spinners */
  .setup-field input::-webkit-inner-spin-button,
  .setup-field input::-webkit-outer-spin-button { -webkit-appearance: none; }
  .setup-unit { font-size: 11px; color: #44566a; white-space: nowrap; }
  .setup-conv { font-size: 11px; color: #4a7a9a; min-width: 56px; }

  .setup-color {
    width: 38px; height: 28px;
    border: 1px solid #2a3650; border-radius: 5px;
    padding: 2px; background: #141c2a;
    cursor: pointer;
  }
  .setup-color:disabled { opacity: .3; cursor: not-allowed; }
  .setup-check-label {
    display: flex; align-items: center; gap: 6px;
    font-size: 12px; color: #8899aa; cursor: pointer;
    user-select: none;
  }
  .setup-check-label input[type="checkbox"] {
    accent-color: #3b82f6; cursor: pointer;
  }

  .format-presets {
    display: flex; gap: 6px; flex-wrap: wrap;
    margin-top: 2px;
  }
  .preset-btn {
    background: #151e2e; border: 1px solid #263040;
    color: #6899bb; font-size: 11px;
    padding: 4px 10px; border-radius: 5px;
    cursor: pointer; transition: background .15s, border-color .15s;
  }
  .preset-btn:hover { background: #1a2a40; border-color: #3a5070; }
  .preset-active {
    background: #1a3050; border-color: #3a6090; color: #90c0f0;
  }
  .page-presets {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 5px;
    margin-top: 0;
  }
  .page-presets .preset-btn {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    min-width: 0;
    padding: 4px 6px;
    font-size: 10px;
  }



  .formen-setup-dialog {
    background: #1e2128;
    border: 1px solid #3a3f4a;
    border-radius: 10px;
    width: 420px;
    color: #ccc;
    font-size: 13px;
    box-shadow: 0 8px 32px rgba(0,0,0,.6);
    display: flex; flex-direction: column;
  }
  .formen-setup-body {
    padding: 20px 22px;
    display: flex; flex-direction: column; gap: 14px;
  }
  .formen-setup-section {
    display: flex; flex-direction: column; gap: 4px;
  }
  .formen-setup-label {
    font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: .04em;
  }
  .formen-setup-path {
    font-size: 11px; color: #aaa; word-break: break-all;
    background: #14171d; border: 1px solid #2a2f3a; border-radius: 5px;
    padding: 6px 10px; font-family: monospace;
  }
  .formen-setup-count {
    font-size: 15px; color: #e0e0e0; font-weight: 600;
  }
  .formen-setup-actions {
    display: flex; gap: 10px;
  }
  .formen-setup-status {
    font-size: 12px; color: #7ec8a0; padding: 4px 0;
  }
  .setup-footer {
    padding: 12px 22px;
    border-top: 1px solid #262f3f;
    display: flex; justify-content: flex-end;
  }
  .setup-dialog .setup-footer {
    padding: 12px 16px;
    border-top: 1px solid #484b50;
    display: flex; align-items: center; gap: 10px;
    background: linear-gradient(#33363a, #282b2f);
  }
  .setup-dialog .setup-footer-spacer { flex: 1; }
  .setup-dialog .btn-open-existing {
    background: linear-gradient(#4b4f56, #25282d);
    border: 1px solid #090a0c;
    border-radius: 6px;
    color: #ededed;
    padding: 6px 14px;
    font-size: 13px;
    font-weight: 400;
    cursor: pointer;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.18);
  }
  .btn-cancel {
    background: none; color: #8899aa;
    border: none; border-radius: 6px;
    padding: 8px 18px; font-size: 13px;
    cursor: pointer; transition: color .15s;
  }
  .setup-dialog .btn-cancel {
    background: linear-gradient(#4b4f56, #25282d);
    color: #ededed;
    border: 1px solid #090a0c; border-radius: 6px;
    padding: 6px 14px; font-size: 13px; font-weight: 400;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.18);
  }
  .btn-cancel:hover { color: #ccd6e0; }
  .btn-ok {
    background: #2563eb; color: #fff;
    border: none; border-radius: 6px;
    padding: 8px 30px; font-size: 13px; font-weight: 600;
    cursor: pointer; transition: background .15s;
  }
  .setup-dialog .btn-ok {
    background: linear-gradient(#4b4f56, #25282d); color: #fff;
    border: 1px solid #090a0c; border-radius: 6px;
    padding: 6px 14px; font-size: 13px; font-weight: 400;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.18);
  }
  .btn-ok:hover:not(:disabled) { background: #3b7bff; }
  .setup-dialog .btn-ok:hover:not(:disabled),
  .setup-dialog .btn-open-existing:hover,
  .setup-dialog .btn-cancel:hover { filter: brightness(1.12); background: linear-gradient(#4b4f56, #25282d); }
  .btn-ok:disabled { opacity: .35; cursor: not-allowed; }

  /* Segmented Control (Einheit / Genauigkeit) */
  .setup-seg {
    display: flex; gap: 0;
    border: 1px solid #2a3a50; border-radius: 6px; overflow: hidden;
  }
  .seg-btn {
    flex: 1; padding: 5px 10px;
    background: #111827; border: none;
    color: #5a7a9a; font-size: 12px; font-weight: 600;
    cursor: pointer; transition: background .12s, color .12s;
    border-right: 1px solid #2a3a50;
  }
  .seg-btn:last-child { border-right: none; }
  .seg-btn:hover { background: #1a2535; color: #8ab0d8; }
  .seg-active { background: #1d4ed8 !important; color: #fff !important; }

  /* ── App Layout ───────────────────────────────────────────────────────── */
  .app {
    display: flex; flex-direction: column;
    width: 100%; height: 100vh;
    opacity: 0;
    transition: opacity 180ms ease;
  }
  .app-fadein { opacity: 1; }

  .startup-screen {
    position: fixed; inset: 0; z-index: 99999;
    background: #0f172a;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px; pointer-events: none;
    transition: opacity 180ms ease;
  }
  .startup-hidden { opacity: 0; pointer-events: none; }
  .startup-logo {
    width: 48px; height: 48px; border-radius: 11px;
    background: linear-gradient(135deg, #3b82f6, #6366f1);
    display: flex; align-items: center; justify-content: center;
    font-size: 26px; font-weight: 700; color: #fff;
  }
  .startup-name {
    font-size: 18px; font-weight: 600; color: #e2e8f0; letter-spacing: .02em;
  }
  .startup-version {
    font-size: 11px; color: #64748b;
  }

  .app-header {
    height: 42px; flex-shrink: 0;
    background: #0f172a;
    border-bottom: 1px solid #1e2d40;
    display: flex; align-items: center;
    padding: 0 4px;
  }
  .header-actions { display: flex; gap: 6px; margin-left: auto; }

  .hbtn {
    display: flex; align-items: center; gap: 5px;
    background: #1a2535; border: 1px solid #263040;
    color: #7a9ab8; font-size: 12px;
    padding: 4px 12px; border-radius: 5px;
    cursor: pointer; transition: background .15s;
  }
  .hbtn:hover { background: #1e3050; }

  /* ── Menüleiste ───────────────────────────────────────────────────────── */
  .menubar {
    display: flex; align-items: stretch;
    margin-left: 0;
    gap: 0;
  }
  .menu-item {
    position: relative;
  }
  .menu-trigger {
    height: 100%;
    background: none; border: none;
    color: #9ab8d8; font-size: 13px;
    padding: 0 12px; cursor: pointer;
    transition: background .12s, color .12s;
  }
  .menu-trigger:hover, .menu-item-open .menu-trigger {
    background: rgba(255,255,255,.08);
    color: #e0e8f0;
  }
  .menu-backdrop {
    position: fixed; inset: 0; z-index: 99;
  }
  .menu-dropdown {
    position: absolute; top: 100%; left: 0;
    min-width: 210px;
    background: #1a2030;
    border: 1px solid #2a3a50;
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0,0,0,.5);
    padding: 4px 0;
    list-style: none; margin: 0;
    z-index: 100;
  }
  .menu-cmd {
    width: 100%;
    display: flex; align-items: center; gap: 8px;
    background: none; border: none;
    color: #c0d0e0; font-size: 13px;
    padding: 7px 14px;
    cursor: pointer; text-align: left;
    transition: background .1s;
  }
  .menu-cmd svg { width: 14px; height: 14px; flex-shrink: 0; color: #5a8ab0; }
  .menu-cmd:hover { background: rgba(59,130,246,.18); color: #fff; }
  .menu-cmd-unsaved { color: #f59e0b !important; }
  .menu-sep {
    height: 1px; background: #2a3a50; margin: 4px 0;
  }
  .menu-shortcut {
    margin-left: auto; font-size: 11px; color: #4a6a8a;
  }
  .menu-check {
    margin-left: auto; width: 13px !important; height: 13px !important;
    color: #5abf80 !important; flex-shrink: 0;
  }
  .header-right {
    margin-left: auto;
    display: flex; align-items: center;
  }
  .header-filename {
    font-size: 11px; color: #4a6a8a;
    max-width: 200px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }

  .workspace {
    flex: 1 1 0; min-height: 0; display: flex; overflow: hidden;
  }

  /* Left toolbar */
  .obj-bar {
    width: 80px; flex-shrink: 0;
    background: #2a2a2a;
    border-right: 1px solid #1a1a1a;
    display: flex; flex-direction: column;
    padding: 6px 4px 8px;
    gap: 0;
  }
  .delete-btn {
    margin-top: auto; width: 44px; height: 44px; align-self: center;
    background: rgba(239,68,68,.12); border: 1px solid rgba(239,68,68,.3); border-radius: 8px;
    color: #ef4444; cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: background .15s, border-color .15s;
  }
  .delete-btn:hover { background: rgba(239,68,68,.25); border-color: rgba(239,68,68,.6); }
  .delete-btn svg { width: 20px; height: 20px; }

  .tool-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-auto-rows: 36px;
    gap: 2px;
    align-content: start;
  }

  .tool-btn-wrap { display: contents; }

  .img-picker-backdrop {
    position: fixed; inset: 0; z-index: 199;
  }
  .img-picker {
    position: absolute; left: 44px; top: 0; z-index: 200;
    background: #1e2433; border: 1px solid #2d3a50;
    border-radius: 8px; padding: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,.5);
    display: flex; flex-direction: column; gap: 4px; min-width: 120px;
  }
  .img-picker-title {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 1px; color: #556070; padding: 2px 4px 6px;
    border-bottom: 1px solid #262f3f; margin-bottom: 2px;
  }
  .img-picker-btn {
    display: flex; align-items: center; gap: 8px;
    background: none; border: 1px solid transparent;
    border-radius: 5px; padding: 6px 8px;
    color: #aabbcc; font-size: 12px; cursor: pointer;
    transition: background .12s;
  }
  .img-picker-btn:hover { background: rgba(255,255,255,.07); }
  .img-picker-active { border-color: #3b82f6 !important; color: #6ab0ff !important; }

  .tool-btn {
    width: 36px; height: 36px;
    display: flex; align-items: center; justify-content: center;
    background: none; border: none;
    border-radius: 5px;
    color: #aaaaaa;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
    padding: 0;
  }
  .tool-btn svg {
    width: 18px; height: 18px;
    flex-shrink: 0;
    filter: drop-shadow(0 1px 1px rgba(0,0,0,.5));
  }
  .tool-btn:hover {
    background: rgba(255,255,255,.1);
    color: #e0e0e0;
  }
  .tool-active {
    background: rgba(80,140,220,.25) !important;
    color: #6ab0ff !important;
  }

  /* Farb-Swatches am unteren Rand */
  .color-swatches {
    position: relative;
    height: 42px;
    margin-top: 6px;
    padding: 0 6px;
  }
  .swatch-fill {
    position: absolute; left: 10px; bottom: 8px;
    width: 22px; height: 22px;
    border: 1.5px solid #888;
    border-radius: 2px;
    background: #fff;
    cursor: pointer;
    padding: 0;
  }
  .swatch-stroke {
    position: absolute; left: 22px; bottom: 2px;
    width: 22px; height: 22px;
    border: 2px solid #000;
    border-radius: 2px;
    background: transparent;
    cursor: pointer;
    padding: 0;
  }
  .swatch-reset {
    position: absolute; right: 6px; bottom: 16px;
    background: none; border: none;
    font-size: 11px; color: #888;
    cursor: pointer; user-select: none;
  }
  .swatch-reset:hover { color: #ccc; }
  .swatch-color-input {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    opacity: 0; cursor: pointer;
  }
  .swatch-none {
    position: absolute; inset: 2px;
    pointer-events: none;
  }
  .swatch-none::after {
    content: '';
    position: absolute; left: -2px; top: 50%;
    width: calc(100% + 4px); height: 2px;
    background: #d22;
    transform: rotate(-45deg);
  }

  /* Center canvas */
  .canvas-area {
    flex: 1; overflow: hidden;
    background: #1a1f2e;
    display: flex; flex-direction: column;
    box-sizing: border-box;
  }
  .canvas-panning { cursor: grabbing; }

  /* canvas-body: festes Grid — Ecke | h-Lineal / v-Lineal | Scroll-Bereich */
  .canvas-body {
    flex: 1;
    display: grid;
    grid-template-columns: var(--ruler, 0px) 1fr;
    grid-template-rows: var(--ruler, 0px) 1fr;
    overflow: hidden;
  }
  .ruler-corner {
    grid-column: 1; grid-row: 1;
    z-index: 6;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #1c1c1c;
    border-right: 1px solid #333;
    border-bottom: 1px solid #333;
    color: #a8a8a8;
    font-size: 9px;
    font-family: system-ui, sans-serif;
  }
  .ruler-h-wrap {
    grid-column: 2; grid-row: 1;
    overflow: hidden;
    border-bottom: 1px solid #333;
  }
  .ruler-v-wrap {
    grid-column: 1; grid-row: 2;
    overflow: hidden;
    border-right: 1px solid #333;
  }
  .canvas-scroll-area {
    grid-column: 2; grid-row: 2;
    overflow: hidden;
    padding: 0;
    display: flex;
  }
  .canvas-scroll {
    display: inline-block;
  }

  .canvas-frame {
    display: block; border: none;
    box-shadow: 0 4px 32px rgba(0,0,0,.6),
                0 0 0 1px rgba(255,255,255,.06);
  }
  .pb-empty { padding: 20px 14px; color: #445060; font-size: 12px; }

  .dash-picker { display: flex; flex-direction: row; flex-wrap: nowrap; gap: 4px; padding: 4px 0; }
  .dash-btn {
    display: flex; align-items: center; justify-content: center;
    background: #1a2230; border: 1px solid #2a3650;
    border-radius: 5px; padding: 4px 6px;
    cursor: pointer; transition: border-color .15s;
  }
  .dash-btn:hover { border-color: #4a6080; }
  .dash-btn-active { border-color: #3b82f6 !important; background: #1a2a40; }

  .canvas-hint {
    color: #3a4a5a; font-size: 14px;
    margin: auto; text-align: center;
  }
  .canvas-hint strong { color: #4a7a9a; }

  /* ── Right Properties Panel ───────────────────────────────────────────── */
  .props-bar {
    width: 300px; flex-shrink: 0;
    background: #2a2a2a;
    border-left: 1px solid #1a1a1a;
    display: flex; flex-direction: column;
    height: calc(100vh - 82px);
    max-height: calc(100vh - 82px);
    min-height: 0;
    overflow: hidden;
    position: relative;
  }
  .props-bar-locked { pointer-events: none; }
  .props-bar-lock-overlay {
    position: absolute; inset: 0; z-index: 100;
    background: rgba(20,20,20,.72);
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 10px; color: #555;
    font-size: 12px; pointer-events: all;
    backdrop-filter: blur(1px);
  }
  .props-bar-lock-overlay span { color: #444; letter-spacing: .02em; }

  .pb-header {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px 6px;
    background: #222222;
    border-bottom: 1px solid #1a1a1a;
    flex-shrink: 0;
  }
  .pb-grip {
    display: flex; flex-direction: column; gap: 2px;
    padding: 2px 3px; cursor: grab; opacity: .4;
  }
  .pb-grip span {
    display: block; width: 14px; height: 2px;
    background: #aaa; border-radius: 1px;
  }
  .pb-title {
    font-size: 12px; font-weight: 700; color: #cccccc;
  }

  .pb-tabs {
    display: flex; align-items: center; gap: 2px;
    padding: 5px 8px;
    background: #222222;
    border-bottom: 1px solid #1a1a1a;
    flex-shrink: 0;
  }
  .pb-tab {
    width: 32px; height: 28px;
    display: flex; align-items: center; justify-content: center;
    background: none; border: none;
    border-radius: 5px; cursor: pointer;
    color: #777;
    transition: background .12s, color .12s;
  }
  .pb-tab svg { width: 16px; height: 16px; }
  .pb-tab:hover { background: rgba(255,255,255,.1); color: #ccc; }
  .pb-tab-active {
    background: rgba(255,255,255,.12) !important; color: #eee !important;
  }

  .pb-body {
    padding: 8px 10px;
    overflow-y: auto; overflow-x: hidden; flex: 1;
    display: flex; flex-direction: column; gap: 7px;
  }
  .align-body {
    gap: 12px;
    padding-top: 16px;
  }
  .align-row {
    display: grid;
    grid-template-columns: 76px 1fr;
    gap: 10px;
    align-items: start;
  }
  .align-label {
    color: #e0e0e0;
    font-size: 13px;
    font-weight: 700;
    line-height: 32px;
  }
  .align-buttons {
    display: grid;
    grid-template-columns: repeat(4, 32px);
    gap: 7px;
  }
  .align-grid {
    grid-template-columns: repeat(4, 32px);
  }
  .align-btn {
    width: 32px;
    height: 32px;
    border: 1px solid #202020;
    border-radius: 5px;
    background: #292929;
    color: #aeb4bd;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
  }
  .align-btn:hover:not(:disabled) {
    background: #333333;
    color: #d9e2ee;
    border-color: #3a4a5c;
  }
  .align-btn:disabled {
    opacity: .35;
    cursor: default;
  }
  .align-btn svg {
    width: 18px;
    height: 18px;
    fill: rgba(170,170,170,.35);
    stroke: currentColor;
    stroke-width: 1.45;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  /* Feste Label-Höhe damit Felder links/rechts auf gleicher Linie liegen */
  .pb-label-fixed {
    height: 18px;
    display: flex; align-items: center; gap: 4px;
  }

  .pb-group-row {
    display: flex; gap: 6px;
  }
  .pb-group {
    flex: 1; display: flex; flex-direction: column; gap: 4px;
    min-width: 0;
  }
  .pb-group-label {
    font-size: 11px; font-weight: 600; color: #888;
    margin-bottom: 0;
  }


  .pb-divider {
    height: 1px; background: #3a3a3a; margin: 0;
  }

  .pb-field-row {
    display: flex; align-items: center; gap: 4px;
  }
  .pb-field-stack {
    align-items: stretch;
    flex-direction: column;
    gap: 5px;
    margin-top: 4px;
  }
  .pb-inline-label {
    flex: 1;
    min-width: 0;
  }
  .pb-axis {
    font-size: 11px; font-weight: 700; color: #999;
    width: 14px; flex-shrink: 0; text-align: right;
  }
  .pb-axis-icon {
    width: 20px; height: 20px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    color: #888;
  }
  .pb-axis-icon svg { width: 16px; height: 16px; }
  .pb-axis-icon.pb-shear-icon svg { width: 14px; height: 14px; }
  .polygon-sides-row { gap: 8px; min-height: 28px; }
  .polygon-sides-icon { width: 26px; height: 26px; color: #a0a0a0; flex-shrink: 0; }
  .polygon-sides-label { width: auto; margin: 0; color: #d0d0d0; font-size: 13px; }
  .polygon-sides-slider { flex: 1; min-width: 80px; }
  .polygon-sides-select { width: 62px; flex-shrink: 0; }

  /* Sperr-Button */
  .pb-lock {
    width: 18px; height: 18px; flex-shrink: 0;
    background: none; border: none; cursor: pointer;
    color: #666; padding: 0;
    display: flex; align-items: center; justify-content: center;
  }
  .pb-lock svg { width: 12px; height: 12px; }
  .pb-lock:hover { color: #aaa; }
  .pb-lock-on { color: #6ab0ff !important; }

  /* ── Spinner (Pill-Input) ─────────────────────────────────────────────── */
  .pb-spinner {
    flex: 1; min-width: 0;
    display: flex; align-items: center;
    background: #1e1e1e;
    border: 1px solid #3a3a3a;
    border-radius: 20px;
    padding: 0 6px;
    height: 24px;
    box-shadow: inset 0 1px 2px rgba(0,0,0,.3);
    gap: 2px;
  }
  .sp-arr {
    background: none; border: none;
    color: #666; font-size: 7px; line-height: 1;
    cursor: pointer; padding: 0 1px;
    display: flex; align-items: center;
    transition: color .1s;
    flex-shrink: 0;
  }
  .sp-arr:hover { color: #ccc; }
  .sp-input {
    flex: 1; min-width: 0;
    background: none; border: none; outline: none;
    font-size: 12px; color: #cccccc;
    text-align: center;
  }
  .sp-input::-webkit-inner-spin-button,
  .sp-input::-webkit-outer-spin-button { -webkit-appearance: none; }
  .sp-unit {
    font-size: 10px; color: #555;
    flex-shrink: 0;
  }

  /* ── Ebenen-Tab ──────────────────────────────────────────────────────── */
  .eb-panel {
    flex: 1; display: flex; flex-direction: column;
    overflow: hidden; padding: 6px;
  }
  .eb-scroll {
    flex: 1; overflow-y: auto; min-height: 0;
  }
  .eb-footer {
    flex-shrink: 0;
    padding: 6px 0 2px;
    border-top: 1px solid #333;
  }
  .eb-list {
    display: flex; flex-direction: column; gap: 2px;
    border: 1px solid #333; border-radius: 5px;
    overflow: hidden;
  }
  .eb-row {
    display: flex; align-items: center; gap: 4px;
    padding: 4px 6px;
    background: #2e2e2e;
    cursor: pointer;
    border-left: 3px solid transparent;
    transition: background .1s, border-color .1s, box-shadow .1s;
  }
  .eb-row:hover { background: #383838; }
  .eb-row-active {
    background: #123f73 !important;
    border-left-color: #4da3ff;
    box-shadow: inset 0 0 0 1px rgba(77,163,255,.45);
  }
  .eb-row-raster {
    background: #252525;
    border-top: 1px solid #333;
    cursor: default;
  }
  .eb-icon-btn {
    width: 20px; height: 20px; flex-shrink: 0;
    background: none; border: none; cursor: pointer;
    color: #777; padding: 0;
    display: flex; align-items: center; justify-content: center;
    border-radius: 3px;
    transition: color .1s, background .1s;
  }
  .eb-icon-btn:hover { color: #ccc; background: rgba(255,255,255,.08); }
  .eb-icon-btn svg { width: 13px; height: 13px; }
  .eb-collapse-btn {
    flex-shrink: 0; width: 14px; height: 14px;
    background: none; border: none; padding: 0;
    color: #555; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  .eb-collapse-btn:hover { color: #aaa; }
  .eb-name {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .eb-active-pill {
    margin-left: auto;
    padding: 1px 5px;
    border-radius: 4px;
    background: #4da3ff;
    color: #061526;
    font-size: 10px;
    font-weight: 700;
    line-height: 1.3;
  }

  .eb-obj-row {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 6px 3px 28px;
    border-radius: 3px; cursor: pointer;
    font-size: 11px; color: #888;
  }
  .eb-obj-row:hover { background: rgba(255,255,255,.05); color: #ccc; }
  .eb-obj-selected { background: rgba(59,130,246,.15) !important; color: #6ab0ff !important; }
  .eb-obj-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .eb-obj-lock {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    opacity: .75;
  }
  .eb-obj-delete {
    flex-shrink: 0;
    width: 18px; height: 18px;
    opacity: 0;
    color: #f87171;
    transition: opacity 120ms;
  }
  .eb-obj-row:hover .eb-obj-delete { opacity: .8; }
  .eb-obj-delete:hover { opacity: 1 !important; color: #f87171; }
  .eb-obj-lock-on {
    color: #6ab0ff;
    opacity: 1;
  }

  .eb-opacity-row {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 8px 5px 28px;
    background: #232323;
    border-bottom: 1px solid #1e1e1e;
  }
  .eb-opacity-label { font-size: 10px; color: #556070; width: 70px; flex-shrink: 0; }
  .eb-opacity-slider { flex: 1; accent-color: #3b82f6; cursor: pointer; height: 3px; }
  .eb-opacity-val { font-size: 10px; color: #8899aa; width: 32px; text-align: right; flex-shrink: 0; }

  /* ── Formen-Tab ─────────────────────────────────────────────────────── */
  .shapes-panel {
    flex: 1 1 0;
    height: calc(100vh - 162px);
    max-height: calc(100vh - 162px);
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 6px;
    box-sizing: border-box;
    scrollbar-width: thin;
    scrollbar-color: #4a4a4a #242424;
  }
  .shapes-hint {
    font-size: 11px;
    color: #667788;
    padding: 2px 2px 8px;
    line-height: 20px;
    overflow: hidden;
    white-space: nowrap;
  }
  .shapes-scroll {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-right: 2px;
  }
  .shapes-panel::-webkit-scrollbar { width: 5px; }
  .shapes-panel::-webkit-scrollbar-track { background: #242424; }
  .shapes-panel::-webkit-scrollbar-thumb {
    background: #4a4a4a;
    border-radius: 999px;
  }
  .shapes-panel::-webkit-scrollbar-thumb:hover { background: #5a5a5a; }
  .shape-group {
    border: 1px solid #333;
    border-radius: 5px;
    overflow: hidden;
    background: #252525;
  }
  .shape-group-head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    background: #2e2e2e;
    border: 0;
    color: #c8d6ef;
    font-size: 12px;
    font-weight: 600;
    padding: 6px 8px;
    cursor: pointer;
    text-align: left;
  }
  .shape-group-head:hover { background: #383838; }
  .shape-tree {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 5px;
  }

  /* ── Eigene Formen ────────────────────────────────────────────────────── */
  .saved-shapes-section {
    margin-bottom: 8px;
  }
  .saved-shapes-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 2px 6px;
  }
  .saved-shapes-title {
    font-size: 11px;
    font-weight: 700;
    color: #8a9ab5;
    text-transform: uppercase;
    letter-spacing: .04em;
  }
  .saved-shapes-save-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    background: #1a2535;
    border: 1px solid #263040;
    border-radius: 4px;
    color: #6a9fd8;
    font-size: 11px;
    padding: 3px 8px;
    cursor: pointer;
    transition: background .12s;
  }
  .saved-shapes-save-btn:hover { background: #1e3050; color: #9bbfdf; }
  .saved-shapes-empty {
    font-size: 11px;
    color: #4a5a70;
    padding: 4px 4px 8px;
    font-style: italic;
  }
  .saved-shape-item {
    display: flex;
    align-items: center;
    background: #161e2e;
    border: 1px solid #2a3650;
    border-radius: 4px;
    overflow: hidden;
  }
  .saved-shape-insert {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 7px;
    background: none;
    border: none;
    color: #8899aa;
    cursor: pointer;
    padding: 5px 7px;
    text-align: left;
    min-width: 0;
    font-size: 11px;
    transition: color .12s;
  }
  .saved-shape-insert:hover { color: #c8d6ef; background: rgba(59,130,246,.08); }
  .shape-lib-preview { flex-shrink: 0; filter: drop-shadow(0 1px 2px rgba(0,0,0,.4)); display:flex; align-items:center; }
  .shape-lib-preview svg { display:block; width:48px !important; height:24px !important; }
  .saved-shape-insert span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .saved-shape-del {
    flex-shrink: 0;
    background: none;
    border: none;
    border-left: 1px solid #2a3650;
    color: #4a5a70;
    cursor: pointer;
    padding: 5px 8px;
    display: flex;
    align-items: center;
    transition: color .12s, background .12s;
  }
  .saved-shape-del:hover { color: #e05555; background: rgba(224,85,85,.08); }
  .btn-primary {
    background: #2563eb; color: #fff;
    border: none; border-radius: 6px;
    padding: 8px 20px; font-size: 13px; font-weight: 600;
    cursor: pointer; transition: background .15s;
  }
  .btn-primary:hover:not(:disabled) { background: #3b7bff; }
  .btn-primary:disabled { opacity: .35; cursor: not-allowed; }
  .setup-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid #2d3a50;
    background: linear-gradient(#303338, #25282d);
    font-size: 13px; font-weight: 600; color: #e0e8f4;
  }
  .setup-close {
    background: none; border: none; color: #8899aa;
    font-size: 16px; cursor: pointer; padding: 2px 6px; border-radius: 4px; line-height: 1;
  }
  .setup-close:hover { color: #fff; background: rgba(255,255,255,.1); }

  .eb-grip {
    flex-shrink: 0; width: 14px;
    color: #555; cursor: grab;
    display: flex; align-items: center;
  }
  .eb-grip:active { cursor: grabbing; }
  .eb-grip-placeholder { flex-shrink: 0; width: 14px; }
  .eb-row-dragging { opacity: .4; }
  .eb-row-dragover { box-shadow: 0 -2px 0 0 #3b82f6; }
  .eb-del { margin-left: auto; }
  .eb-del:hover { color: #e05555 !important; }
  .eb-name-input {
    flex: 1; min-width: 0;
    background: #111; border: 1px solid #3b82f6;
    border-radius: 3px; color: #eee;
    font-size: 12px; padding: 1px 4px;
    outline: none;
  }
  .eb-name {
    flex: 1; font-size: 12px; color: #ccc;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    min-width: 0;
  }
  .eb-row-raster .eb-name { color: #888; font-style: italic; }
  .eb-add-btn {
    display: flex; align-items: center; gap: 6px;
    background: #252525; border: 1px solid #333;
    border-radius: 5px; color: #6a9fd8;
    font-size: 12px; padding: 6px 10px;
    cursor: pointer; width: 100%;
    transition: background .1s;
  }
  .eb-add-btn:hover { background: #2e3e50; }
  .eb-add-btn svg { width: 14px; height: 14px; }

  /* ── Footer / Zoom ────────────────────────────────────────────────────── */
  .app-footer {
    height: 40px; flex-shrink: 0;
    background: #2a2a2a;
    border-top: 1px solid #1a1a1a;
    display: flex; align-items: center;
    padding: 0 10px;
  }
  .zoom-area {
    display: flex; align-items: center; gap: 10px;
  }
  .zoom-label {
    color: #d4d4d4;
    font-size: 13px;
    font-weight: 700;
  }
  .zoom-separator {
    width: 1px;
    height: 28px;
    background: #0e0e0e;
    border-right: 1px solid #3a3a3a;
  }
  .zoom-value-box {
    width: 86px;
    height: 28px;
    background: #111111;
    border: 1px solid #333333;
    border-radius: 4px;
    color: #ffffff;
    font-size: 14px;
    font-weight: 700;
    display: flex;
    align-items: center;
    padding: 0 28px 0 8px;
    box-sizing: border-box;
    position: relative;
  }
  .zoom-value-box::after {
    content: '';
    position: absolute;
    right: 25px;
    top: 0;
    bottom: 0;
    width: 1px;
    background: #3a3a3a;
  }
  .zoom-value-box::before {
    content: '';
    position: absolute;
    right: 9px;
    top: 50%;
    width: 0;
    height: 0;
    border-left: 4px solid transparent;
    border-right: 4px solid transparent;
    border-top: 6px solid #d8d8d8;
    transform: translateY(-35%);
    pointer-events: none;
  }
  .zoom-select {
    width: 86px;
    height: 28px;
    margin-left: -96px;
    opacity: 0;
    cursor: pointer;
  }
  .zoom-slider-wrap {
    position: relative;
    width: 296px;
    height: 28px;
    padding-top: 9px;
    box-sizing: border-box;
    border-left: 2px solid #050505;
    border-right: 2px solid #050505;
  }
  .zoom-slider {
    width: 100%;
    height: 12px;
    appearance: none;
    -webkit-appearance: none;
    background: transparent;
    cursor: pointer;
    padding: 0;
    box-sizing: border-box;
  }
  .zoom-slider::-webkit-slider-runnable-track {
    height: 4px;
    background: #111827;
    border-radius: 999px;
    border: 1px solid #0b1220;
  }
  .zoom-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    margin-top: -6px;
    border-radius: 50%;
    background: #3b82f6;
    border: 1px solid #6aa8ff;
    box-shadow: 0 1px 3px rgba(0,0,0,.55);
  }
  .zoom-slider::-moz-range-track {
    height: 4px;
    background: #111827;
    border-radius: 999px;
    border: 1px solid #0b1220;
  }
  .zoom-slider::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #3b82f6;
    border: 1px solid #6aa8ff;
    box-shadow: 0 1px 3px rgba(0,0,0,.55);
  }
  .fit-btn {
    display: flex; align-items: center; gap: 4px;
    background: #1a2535; border: 1px solid #263040;
    color: #7a9ab8; font-size: 11px;
    padding: 3px 9px; border-radius: 4px;
    cursor: pointer; transition: background .12s, color .12s;
    white-space: nowrap;
  }
  .fit-btn:hover { background: #1e3050; color: #a0c0e0; }

  /* ── Raster-Tab ──────────────────────────────────────────────────────── */
  .raster-checks {
    display: flex; flex-direction: column; gap: 8px;
  }
  .raster-check-label {
    display: flex; align-items: center; gap: 7px;
    font-size: 12px; color: #cccccc; cursor: pointer;
    user-select: none;
  }
  .raster-check-label input[type="checkbox"] {
    width: 14px; height: 14px;
    accent-color: #3b82f6;
    cursor: pointer; flex-shrink: 0;
  }
  .raster-row {
    display: flex; align-items: center; gap: 6px;
  }
  .raster-label {
    font-size: 11px; color: #888;
    width: 78px; flex-shrink: 0; text-align: right;
  }
  .raster-spinner {
    flex: 1;
  }
  .raster-row-slider { align-items: center; }
  .raster-slider {
    flex: 1; accent-color: #3b82f6; cursor: pointer;
  }
  .raster-color {
    width: 26px; height: 24px;
    border: 1px solid #3a3a3a; border-radius: 4px;
    padding: 2px; background: #1e1e1e;
    cursor: pointer; flex-shrink: 0;
  }
  .raster-color-hex {
    font-size: 11px; color: #4a7a9a;
  }
  .raster-width-input {
    width: 38px; height: 24px;
    background: #141c2a; border: 1px solid #2a3650;
    border-radius: 4px; color: #d0dce8;
    font-size: 11px; padding: 0 4px;
    box-sizing: border-box;
  }

  /* ── Transform-Bar ────────────────────────────────────────────────────── */
  .tbar {
    display: flex; align-items: center; gap: 4px;
    padding: 4px 10px;
    background: #1e1e1e;
    border-bottom: 1px solid #161616;
    flex-shrink: 0;
    height: 32px; box-sizing: border-box;
  }
  .tbar-icon { width: 16px; height: 16px; color: #556070; flex-shrink: 0; margin-right: 4px; }
  .tbar-label { font-size: 11px; color: #667788; flex-shrink: 0; }
  .tbar-sep { width: 1px; height: 16px; background: #2a3040; margin: 0 4px; flex-shrink: 0; }
  .tbar-dim-icon { width: 14px; height: 10px; color: #667788; flex-shrink: 0; }
  .tbar-dim-icon-v { width: 10px; height: 14px; }

  .tbar-spinner {
    display: flex; align-items: center;
    background: #141c2a; border: 1px solid #2a3650;
    border-radius: 5px; height: 22px; overflow: hidden;
  }
  .tbar-arr {
    background: none; border: none; color: #4a6070;
    font-size: 7px; padding: 0 3px; cursor: pointer; line-height: 1;
    flex-shrink: 0; display: flex; flex-direction: column;
  }
  .tbar-arr:hover { color: #aac; }
  .tbar-input {
    width: 52px; background: none; border: none; outline: none;
    color: #d0dce8; font-size: 11px; text-align: right; padding: 0 2px;
    -moz-appearance: textfield;
  }
  .tbar-input::-webkit-inner-spin-button,
  .tbar-input::-webkit-outer-spin-button { -webkit-appearance: none; }
  .tbar-unit { font-size: 10px; color: #445566; padding: 0 4px 0 1px; flex-shrink: 0; }

  .tbar-lock {
    background: none; border: 1px solid #2a3650; border-radius: 4px;
    color: #556070; cursor: pointer; padding: 2px; width: 20px; height: 20px;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .tbar-lock svg { width: 12px; height: 12px; }
  .tbar-lock:hover { border-color: #4a6080; color: #8899aa; }
  .tbar-lock-on { border-color: #3b82f6 !important; color: #3b82f6 !important; }

  /* ── Canvas zoom outer wrapper ────────────────────────────────────────── */
  .canvas-zoom-outer {
    display: inline-block;
    flex-shrink: 0;
  }

  /* ── Zeichen-Overlay ──────────────────────────────────────────────────── */
  .draw-overlay {
    position: absolute;
    top: 0; left: 0;
    background: transparent;
    z-index: 10;
    user-select: none;
  }
  .draw-overlay-crosshair { cursor: crosshair; }
  .draw-overlay-text { cursor: text; }
  .draw-overlay-pencil { cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm17.71-10.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z' fill='%23000'/%3E%3C/svg%3E") 0 24, crosshair; }
  .draw-overlay-eraser { cursor: cell; }
  .draw-overlay-brush  { cursor: crosshair; }
  .draw-overlay-hand { cursor: grab; }
  .canvas-panning .draw-overlay-hand { cursor: grabbing; }
  .draw-overlay-zoom { cursor: zoom-in; }
  .draw-overlay-fill { cursor: copy; }
  .text-inline-edit {
    position: absolute; z-index: 20;
    background: transparent; border: none;
    padding: 0; margin: 0; resize: none; min-height: 24px;
    outline: none; box-shadow: none;
    white-space: pre-wrap; overflow: hidden; word-wrap: break-word; overflow-wrap: break-word;
    box-sizing: content-box;
  }
  .text-edit-overlay {
    position: absolute;
    pointer-events: auto;
    user-select: text;
    -webkit-user-select: text;
  }
  .text-prop-area {
    width: 100%; box-sizing: border-box;
    background: #141926; border: 1px solid #2d3a50; border-radius: 5px;
    color: #c8d6ef; font-size: 12px; padding: 6px 8px; resize: vertical;
    font-family: inherit;
  }
  .text-prop-area:focus { outline: none; border-color: #3b82f6; }
  .text-fmt-btn {
    width: 28px; height: 28px; background: #1e2433; border: 1px solid #2d3a50;
    border-radius: 4px; color: #c8d6ef; cursor: pointer;
    display: flex; align-items: center; justify-content: center; font-size: 13px;
  }
  .text-fmt-btn:hover { background: #2d3a50; }
  .text-fmt-active { background: #3b82f6 !important; border-color: #3b82f6 !important; color: #fff !important; }
  .sel-rubber {
    position: absolute; pointer-events: none; box-sizing: border-box;
    border: 1px solid #3b82f6; background: rgba(59,130,246,.1);
  }
  .sel-multi-box {
    position: absolute; box-sizing: border-box;
    border: calc(1px * var(--sel-inv, 1)) solid #1683ff;
    background: rgba(22,131,255,.04);
    z-index: 4;
  }
  .draw-preview-rect {
    position: absolute;
    pointer-events: none;
    opacity: 0.75;
    box-sizing: border-box;
  }
  .draw-preview-ellipse { border-radius: 50%; }
  .draw-preview-frame { background: transparent; }

  /* ── Objekt-Klickflächen & Selektion ─────────────────────────────────── */
  .obj-hit {
    position: absolute;
    box-sizing: border-box;
    cursor: default;
    border: 1px solid transparent;
  }
  .obj-hit:hover {
    border: calc(1px * var(--sel-inv, 1)) solid rgba(22,131,255,0.35);
  }
  .obj-locked { opacity: 0.85; }
  .obj-locked::after { content:'🔒'; position:absolute; top:2px; right:4px; font-size:9px; opacity:0.5; pointer-events:none; }
  .obj-selected {
    border: calc(1px * var(--sel-inv, 1)) solid rgba(22,131,255,0.35) !important;
    outline: none;
  }
  .sel-rotate-line {
    position: absolute;
    left: 50%;
    top: calc(-62px * var(--sel-inv, 1));
    width: 0;
    height: calc(56px * var(--sel-inv, 1));
    border-left: calc(1px * var(--sel-inv, 1)) solid #1683ff;
    pointer-events: none;
  }
  .sel-rotate-handle {
    position: absolute;
    left: calc(50% - 6px * var(--sel-inv, 1));
    top: calc(-68px * var(--sel-inv, 1));
    width: calc(12px * var(--sel-inv, 1));
    height: calc(12px * var(--sel-inv, 1));
    background: #fff;
    border: calc(2px * var(--sel-inv, 1)) solid #1683ff;
    border-radius: 50%;
    box-sizing: border-box;
    pointer-events: all;
    cursor: grab;
    z-index: 2;
  }
  .sel-rotate-handle:active {
    cursor: grabbing;
  }
  /* 8 Resize-Handles */
  .sel-handle {
    position: absolute;
    width: calc(13px * var(--sel-inv, 1));
    height: calc(13px * var(--sel-inv, 1));
    background: #ffffff;
    border: calc(2px * var(--sel-inv, 1)) solid #1683ff;
    border-radius: 50%;
    box-sizing: border-box;
    pointer-events: all;
    cursor: default;
  }
  .sel-h-tl { top:calc(-6.5px * var(--sel-inv, 1)); left:calc(-6.5px * var(--sel-inv, 1)); cursor:nw-resize; }
  .sel-h-tc { top:calc(-6.5px * var(--sel-inv, 1)); left:calc(50% - 6.5px * var(--sel-inv, 1)); cursor:n-resize; }
  .sel-h-tr { top:calc(-6.5px * var(--sel-inv, 1)); right:calc(-6.5px * var(--sel-inv, 1)); cursor:ne-resize; }
  .sel-h-ml { top:calc(50% - 6.5px * var(--sel-inv, 1)); left:calc(-6.5px * var(--sel-inv, 1)); cursor:w-resize; }
  .sel-h-mr { top:calc(50% - 6.5px * var(--sel-inv, 1)); right:calc(-6.5px * var(--sel-inv, 1)); cursor:e-resize; }
  .sel-h-bl { bottom:calc(-6.5px * var(--sel-inv, 1)); left:calc(-6.5px * var(--sel-inv, 1)); cursor:sw-resize; }
  .sel-h-bc { bottom:calc(-6.5px * var(--sel-inv, 1)); left:calc(50% - 6.5px * var(--sel-inv, 1)); cursor:s-resize; }
  .sel-h-br { bottom:calc(-6.5px * var(--sel-inv, 1)); right:calc(-6.5px * var(--sel-inv, 1)); cursor:se-resize; }

  /* ── Ebenen-Auswahl (Geo-Tab) ────────────────────────────────────────── */
  .obj-ebene-select {
    width: 100%;
    background: #1e1e1e; border: 1px solid #3a3a3a;
    border-radius: 6px; color: #cccccc;
    font-size: 12px; padding: 4px 8px;
    cursor: pointer; outline: none;
  }
  .obj-ebene-select:focus { border-color: #3b82f6; }

  /* ── Objekt-Farb-Picker (Geo-Tab) ─────────────────────────────────────── */
  .none-btn {
    background: #1a2230; border: 1px solid #2a3650; border-radius: 4px;
    color: #556070; cursor: pointer; padding: 3px; width: 22px; height: 22px;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .none-btn:hover { border-color: #4a6080; color: #8899aa; }
  .none-btn-active { border-color: #ef4444 !important; color: #ef4444 !important; background: #2a1a1a; }
  .obj-color-pick:disabled { opacity: 0.35; cursor: not-allowed; }
  .gradient-type-select {
    width: 100%;
    height: 32px;
    background: #10141d;
    border: 1px solid #3b414c;
    border-radius: 4px;
    color: #e5e7eb;
    font-size: 13px;
    padding: 3px 8px;
    margin-bottom: 10px;
  }
  .gradient-editor {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 8px;
  }
  .gradient-top-row {
    display: grid;
    grid-template-columns: 44px 1fr 30px;
    align-items: center;
    gap: 8px;
  }
  .gradient-preview {
    width: 42px;
    height: 28px;
    border: 1px solid #4a5568;
    border-radius: 4px;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.12);
  }
  .gradient-angle {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #8a9ab5;
    font-size: 11px;
    font-weight: 600;
  }
  .gradient-angle-input {
    height: 24px;
    display: flex;
    align-items: center;
    background: #1a2230;
    border: 1px solid #2a3a50;
    border-radius: 4px;
    color: #ccd6e0;
    padding: 0 5px;
    max-width: 72px;
  }
  .gradient-angle-input select {
    width: 62px;
    border: 0;
    background: transparent;
    color: #ccd6e0;
    font-size: 11px;
    outline: none;
    cursor: pointer;
  }
  .gradient-reverse-btn {
    width: 28px;
    height: 24px;
    border-radius: 4px;
    border: 1px solid #2a3a50;
    background: #1a2230;
    color: #8899aa;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .gradient-reverse-btn:hover { border-color: #4a6080; color: #ccd6e0; }
  .gradient-reverse-btn svg { width: 15px; height: 15px; }
  .gradient-ramp {
    position: relative;
    height: 22px;
    border: 1px solid #4a5568;
    border-radius: 4px;
    margin: 4px 7px 12px;
  }
  .gradient-stop {
    position: absolute;
    bottom: -13px;
    width: 14px;
    height: 18px;
    background: #202938;
    border: 1px solid #778399;
    border-radius: 2px;
    clip-path: polygon(50% 0,100% 28%,100% 100%,0 100%,0 28%);
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding: 1px;
    cursor: pointer;
  }
  .gradient-stop-left { left: -8px; }
  .gradient-stop-right { right: -8px; }
  .gradient-stop input {
    width: 8px;
    height: 8px;
    border: 0;
    padding: 0;
    background: transparent;
    cursor: pointer;
  }
  .gradient-presets {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 7px;
    margin: 0 0 10px;
  }
  .gradient-preset-btn {
    height: 30px;
    border: 1px solid #111827;
    border-radius: 4px;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.12);
    cursor: pointer;
  }
  .gradient-preset-btn:hover {
    outline: 1px solid rgba(255,255,255,.35);
  }
  .gradient-preset-active {
    outline: 1px solid #6ab0ff;
    outline-offset: 1px;
  }

  .stroke-slider { flex: 1; accent-color: #3b82f6; cursor: pointer; min-width: 0; }
  .stroke-val { font-size: 10px; color: #8899aa; white-space: nowrap; flex-shrink: 0; width: 36px; text-align: right; }
  .stroke-width-select { width: 72px; flex-shrink: 0; }
  .corner-style-picker { display: flex; gap: 4px; margin-bottom: 6px; }
  .corner-style-btn {
    flex: 1; display: flex; align-items: center; justify-content: center;
    background: #1a2230; border: 1px solid #2a3a50; color: #8899aa;
    border-radius: 5px; padding: 3px; cursor: pointer; transition: border-color .15s;
  }
  .corner-style-btn:hover { border-color: #4a6080; color: #ccd6e0; }
  .corner-style-active { border-color: #3b82f6 !important; background: #1a2a40 !important; color: #60a5fa !important; }
  .radius-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-top: 4px; }
  .radius-cell { display: flex; align-items: center; gap: 4px; }
  .radius-label { font-size: 10px; color: #4a6080; width: 16px; flex-shrink: 0; }
  .radius-input { flex: 1; background: #1a2230; border: 1px solid #2a3a50; color: #ccd6e0; border-radius: 4px; padding: 3px 5px; font-size: 11px; width: 0; min-width: 0; }
  .radius-input:focus { outline: none; border-color: #3b82f6; }
  .radius-all-btn { background: none; border: 1px solid #2a3a50; color: #4a6080; border-radius: 4px; padding: 2px 5px; cursor: pointer; display: flex; align-items: center; }
  .radius-all-btn:hover { border-color: #4a6080; color: #8899aa; }
  .shadow-toggle { display:flex;align-items:center;cursor:pointer; }
  .shadow-toggle input { display:none; }
  .shadow-toggle-track { width:28px;height:15px;background:#2a3650;border-radius:8px;position:relative;transition:background .2s; }
  .shadow-toggle-track::after { content:'';position:absolute;top:2px;left:2px;width:11px;height:11px;background:#8899aa;border-radius:50%;transition:transform .2s,background .2s; }
  .shadow-toggle input:checked ~ .shadow-toggle-track { background:#1d4ed8; }
  .shadow-toggle input:checked ~ .shadow-toggle-track::after { transform:translateX(13px);background:#fff; }
  .einpassen-btn { font-size: 11px; padding: 3px 10px; background: #1e2b3c; border: 1px solid #3a4a5c; color: #ccd6e0; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 4px; }
  .einpassen-btn:hover { background: #253444; border-color: #4a6080; }
  .einpassen-btn-active { border-color: #3b82f6 !important; background: #1a2a40 !important; color: #60a5fa !important; }

  .obj-color-pick {
    width: 36px; height: 24px;
    border: 1px solid #3a3a3a; border-radius: 4px;
    padding: 2px; background: #1e1e1e;
    cursor: pointer; flex-shrink: 0;
  }
  .obj-color-hex {
    font-size: 11px; color: #4a7a9a;
  }
  .measure-radio-row {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 8px; border-radius: 5px;
    color: #aabbcc; font-size: 10px; font-weight: 400; cursor: pointer;
    border: 1px solid transparent;
    transition: background .1s;
  }
  .measure-radio-row:hover { background: rgba(255,255,255,.07); }
  .measure-radio-active { border-color: #3b82f6 !important; color: #6ab0ff !important; }
  .measure-radio-row input[type=radio] { accent-color: #3b82f6; cursor: pointer; }
  .measure-radio-key { min-width: 22px; font-weight: 400; font-family: monospace; font-size: 10px; }

</style>
