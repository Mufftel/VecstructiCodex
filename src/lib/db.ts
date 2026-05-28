import Database from '@tauri-apps/plugin-sql';

export const DB_PATH = 'sqlite:vecstructi.db';
export const SHAPES_DB_PATH = 'sqlite:vecstructi_shapes.db';
export const DEFAULT_DOCUMENT_ID = 'default';

let dbPromise: Promise<Database> | null = null;
let dbPath = DB_PATH;
let dbWriteQueue: Promise<unknown> = Promise.resolve();

let shapesDbPromise: Promise<Database> | null = null;

export function getShapesDb(): Promise<Database> {
  if (!shapesDbPromise) {
    shapesDbPromise = Database.load(SHAPES_DB_PATH).then(async db => {
      await db.execute('PRAGMA journal_mode = WAL');
      await db.execute('PRAGMA synchronous = NORMAL');
      return db;
    }).catch(e => {
      shapesDbPromise = null;
      throw e;
    });
  }
  return shapesDbPromise;
}


export function getDb(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.load(dbPath).then(async db => {
    await db.execute('PRAGMA journal_mode = WAL');
    await db.execute('PRAGMA synchronous = NORMAL');
    await db.execute('PRAGMA busy_timeout = 10000');
    return db;
  });
  return dbPromise;
}

export function queueDbWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = dbWriteQueue.then(() => fn(), () => fn());
  dbWriteQueue = next.then(() => {}, () => {});
  return next;
}

export function getDbPath(): string {
  return dbPath;
}

export function setDbPath(path: string) {
  dbPath = path;
  dbPromise = null;
}

export async function closeDb() {
  if (!dbPromise) return;
  const db = await dbPromise;
  try {
    await db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {}
  await db.close();
  dbPromise = null;
  shapesDbPromise = null; // shapes pool zurücksetzen falls er mitgeschlossen wurde
  dbWriteQueue = Promise.resolve();
}

export async function compactDb() {
  const db = await getDb();
  try {
    await db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {}
  await db.execute('VACUUM');
}

export async function initDocumentDb() {
  const db = await getDb();

  await db.execute('PRAGMA foreign_keys = ON');
  await db.execute(
    `CREATE TABLE IF NOT EXISTS image_assets (
      document_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      data BLOB NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (document_id, file_name)
    )`,
  );
  await db.execute(
    `INSERT OR IGNORE INTO documents
      (id, title, width_um, height_um, unit, precision, background, background_transparent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [DEFAULT_DOCUMENT_ID, 'Dokument', 297000, 210000, 'px', 1, '#ffffff', 0],
  );

  return db;
}

export async function clearDocumentDb() {
  const db = await initDocumentDb();
  await db.execute('DELETE FROM image_assets');
  await db.execute('DELETE FROM transaction_steps');
  await db.execute('DELETE FROM transactions');
  await db.execute('DELETE FROM object_points');
  await db.execute('DELETE FROM objects');
  await db.execute('DELETE FROM document_settings');
  await db.execute('DELETE FROM layers');
  await db.execute('DELETE FROM documents');
  await db.execute(
    `INSERT INTO documents
      (id, title, width_um, height_um, unit, precision, background, background_transparent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [DEFAULT_DOCUMENT_ID, 'Dokument', 297000, 210000, 'px', 1, '#ffffff', 0],
  );
}

export async function assertDocumentDbEmpty() {
  const db = await initDocumentDb();
  const checks = [
    ['objects', 'SELECT COUNT(*) AS count FROM objects'],
    ['object_points', 'SELECT COUNT(*) AS count FROM object_points'],
    ['image_assets', 'SELECT COUNT(*) AS count FROM image_assets'],
    ['transactions', 'SELECT COUNT(*) AS count FROM transactions'],
    ['transaction_steps', 'SELECT COUNT(*) AS count FROM transaction_steps'],
  ] as const;
  for (const [name, sql] of checks) {
    const rows = await db.select<Array<{ count: number }>>(sql);
    const count = rows[0]?.count ?? 0;
    if (count !== 0) throw new Error(`SQLite clear failed: ${name} contains ${count} rows`);
  }
}

export const UM_PER_MM = 1000;
export const UM_PER_IN = 25400;
export const PX_PER_IN = 96;

export function pxToUm(px: number): number {
  return Math.round((px * UM_PER_IN) / PX_PER_IN);
}

export function umToPx(um: number): number {
  return (um * PX_PER_IN) / UM_PER_IN;
}

export function mmToUm(mm: number): number {
  return Math.round(mm * UM_PER_MM);
}

export function umToMm(um: number): number {
  return um / UM_PER_MM;
}

export interface DocumentLayoutSettings {
  widthMm: number;
  heightMm: number;
  unit: 'px' | 'mm' | 'cm';
  precision: 1 | 2 | 3;
  background: string;
  backgroundTransparent: boolean;
  gridXmm: number;
  gridYmm: number;
  gridSubdivision: number;
  gridLineWidth: number;
  gridColor: string;
  gridOpacity: number;
  gridVisible: boolean;
  gridSnap: boolean;
  gridMarginLeftMm: number;
  gridMarginRightMm: number;
  gridMarginTopMm: number;
  gridMarginBottomMm: number;
  gridBeyondMargins: boolean;
  gridOffsetFromMargins: boolean;
  rulerVisible: boolean;
  pageTemplate: string;
  zoomPercent: number;
}

const DEFAULT_LAYOUT: DocumentLayoutSettings = {
  widthMm: 297,
  heightMm: 210,
  unit: 'px',
  precision: 1,
  background: '#ffffff',
  backgroundTransparent: false,
  gridXmm: 10,
  gridYmm: 10,
  gridSubdivision: 1,
  gridLineWidth: 0.75,
  gridColor: '#cccccc',
  gridOpacity: 50,
  gridVisible: true,
  gridSnap: false,
  gridMarginLeftMm: 0,
  gridMarginRightMm: 0,
  gridMarginTopMm: 0,
  gridMarginBottomMm: 0,
  gridBeyondMargins: false,
  gridOffsetFromMargins: false,
  rulerVisible: true,
  pageTemplate: 'blank',
  zoomPercent: 100,
};

export async function loadDocumentLayout(): Promise<DocumentLayoutSettings> {
  const db = await getDb();
  const docs = await db.select<Array<{
    width_um: number;
    height_um: number;
    unit: 'px' | 'mm' | 'cm';
    precision: number;
    background: string;
    background_transparent: number;
  }>>(
    `SELECT width_um, height_um, unit, precision, background, background_transparent
       FROM documents
      WHERE id = $1
      LIMIT 1`,
    [DEFAULT_DOCUMENT_ID],
  );
  const settingsRows = await db.select<Array<{ key: string; value_json: string }>>(
    `SELECT key, value_json
       FROM document_settings
      WHERE document_id = $1`,
    [DEFAULT_DOCUMENT_ID],
  );
  const settings: Record<string, unknown> = {};
  for (const row of settingsRows) {
    try {
      settings[row.key] = JSON.parse(row.value_json);
    } catch {
      settings[row.key] = row.value_json;
    }
  }
  const doc = docs[0];
  return {
    ...DEFAULT_LAYOUT,
    widthMm: doc ? umToMm(doc.width_um) : DEFAULT_LAYOUT.widthMm,
    heightMm: doc ? umToMm(doc.height_um) : DEFAULT_LAYOUT.heightMm,
    unit: doc?.unit ?? DEFAULT_LAYOUT.unit,
    precision: (doc?.precision as 1 | 2 | 3) ?? DEFAULT_LAYOUT.precision,
    background: doc?.background ?? DEFAULT_LAYOUT.background,
    backgroundTransparent: doc ? !!doc.background_transparent : DEFAULT_LAYOUT.backgroundTransparent,
    gridXmm: Number(settings.gridXmm ?? DEFAULT_LAYOUT.gridXmm),
    gridYmm: Number(settings.gridYmm ?? DEFAULT_LAYOUT.gridYmm),
    gridSubdivision: Number(settings.gridSubdivision ?? DEFAULT_LAYOUT.gridSubdivision),
    gridLineWidth: Number(settings.gridLineWidth ?? DEFAULT_LAYOUT.gridLineWidth),
    gridColor: String(settings.gridColor ?? DEFAULT_LAYOUT.gridColor),
    gridOpacity: Number(settings.gridOpacity ?? DEFAULT_LAYOUT.gridOpacity),
    gridVisible: Boolean(settings.gridVisible ?? DEFAULT_LAYOUT.gridVisible),
    gridSnap: Boolean(settings.gridSnap ?? DEFAULT_LAYOUT.gridSnap),
    gridMarginLeftMm: Number(settings.gridMarginLeftMm ?? DEFAULT_LAYOUT.gridMarginLeftMm),
    gridMarginRightMm: Number(settings.gridMarginRightMm ?? DEFAULT_LAYOUT.gridMarginRightMm),
    gridMarginTopMm: Number(settings.gridMarginTopMm ?? DEFAULT_LAYOUT.gridMarginTopMm),
    gridMarginBottomMm: Number(settings.gridMarginBottomMm ?? DEFAULT_LAYOUT.gridMarginBottomMm),
    gridBeyondMargins: Boolean(settings.gridBeyondMargins ?? DEFAULT_LAYOUT.gridBeyondMargins),
    gridOffsetFromMargins: Boolean(settings.gridOffsetFromMargins ?? DEFAULT_LAYOUT.gridOffsetFromMargins),
    rulerVisible: Boolean(settings.rulerVisible ?? DEFAULT_LAYOUT.rulerVisible),
    pageTemplate: String(settings.pageTemplate ?? DEFAULT_LAYOUT.pageTemplate),
    zoomPercent: Number(settings.zoomPercent ?? DEFAULT_LAYOUT.zoomPercent),
  };
}

export async function saveDocumentLayout(settings: DocumentLayoutSettings) {
  const db = await getDb();
  await db.execute(
    `UPDATE documents
        SET width_um = $1,
            height_um = $2,
            unit = $3,
            precision = $4,
            background = $5,
            background_transparent = $6,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $7`,
    [
      mmToUm(settings.widthMm),
      mmToUm(settings.heightMm),
      settings.unit,
      settings.precision,
      settings.background,
      settings.backgroundTransparent ? 1 : 0,
      DEFAULT_DOCUMENT_ID,
    ],
  );

  const entries: Array<[string, unknown]> = [
    ['gridXmm', settings.gridXmm],
    ['gridYmm', settings.gridYmm],
    ['gridSubdivision', settings.gridSubdivision],
    ['gridLineWidth', settings.gridLineWidth],
    ['gridColor', settings.gridColor],
    ['gridOpacity', settings.gridOpacity],
    ['gridVisible', settings.gridVisible],
    ['gridSnap', settings.gridSnap],
    ['gridMarginLeftMm', settings.gridMarginLeftMm],
    ['gridMarginRightMm', settings.gridMarginRightMm],
    ['gridMarginTopMm', settings.gridMarginTopMm],
    ['gridMarginBottomMm', settings.gridMarginBottomMm],
    ['gridBeyondMargins', settings.gridBeyondMargins],
    ['gridOffsetFromMargins', settings.gridOffsetFromMargins],
    ['rulerVisible', settings.rulerVisible],
    ['pageTemplate', settings.pageTemplate],
    ['zoomPercent', settings.zoomPercent],
  ];
  for (const [key, value] of entries) {
    await db.execute(
      `INSERT INTO document_settings (document_id, key, value_json)
       VALUES ($1, $2, $3)
       ON CONFLICT(document_id, key) DO UPDATE SET value_json = excluded.value_json`,
      [DEFAULT_DOCUMENT_ID, key, JSON.stringify(value)],
    );
  }
}

export interface DbRectObject {
  type: 'RECHTECK';
  uid: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  stroke: string;
  strokeW: number;
  strokeDash: string;
  radiusOL: number;
  radiusOR: number;
  radiusUL: number;
  radiusUR: number;
  rotation: number;
  ebene: string;
  shape?: 'rect' | 'ellipse' | 'polygon' | 'frame';
  polygonSides?: number;
  frameWidth?: number;
  isImageFrame?: boolean;
  imageShape?: 'rect' | 'circle';
  imageUrl?: string;
  imageFile?: string;
  imageScale?: number;
  imageOffsetX?: number;
  imageOffsetY?: number;
  imageRenderW?: number;
  imageRenderH?: number;
  imageMaskD?: string;
  imageNativeW?: number;
  imageNativeH?: number;
  imageFormat?: string;
  imageSizeBytes?: number;
  shadowEnabled?: boolean;
  shadowX?: number;
  shadowY?: number;
  shadowBlur?: number;
  shadowColor?: string;
  cornerStyle?: 'round' | 'chamfer' | 'concave';
  shearX?: number;
  shearY?: number;
  groupId?: string;
  gesperrt?: boolean;
  libraryName?: string;
  dbZIndex?: number;
}

export interface DbLineObject {
  type: 'LINIE';
  uid: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x: number;
  y: number;
  w: number;
  h: number;
  stroke: string;
  strokeW: number;
  strokeDash: string;
  fill: string;
  arrowStart: 'none' | 'arrow' | 'dot' | 'tick';
  arrowEnd: 'none' | 'arrow' | 'dot' | 'tick';
  isMasslinie: boolean;
  massText?: string;
  massTextPos?: 'ueber' | 'in';
  massFontSize?: number;
  massFontFamily?: string;
  massFontWeight?: 'normal' | 'bold';
  massFontStyle?: 'normal' | 'italic';
  ebene: string;
  rotation: number;
  radiusOL: number;
  radiusOR: number;
  radiusUL: number;
  radiusUR: number;
  shadowEnabled?: boolean;
  shadowX?: number;
  shadowY?: number;
  shadowBlur?: number;
  shadowColor?: string;
  groupId?: string;
  gesperrt?: boolean;
  libraryName?: string;
  dbZIndex?: number;
}

export interface DbTextObject {
  type: 'TEXT';
  uid: string;
  x: number;
  y: number;
  w: number;
  h: number;
  richHtml: string;
  textAlign: 'left' | 'center' | 'right';
  lineHeight: number;
  shadowEnabled?: boolean;
  shadowX?: number;
  shadowY?: number;
  shadowBlur?: number;
  shadowColor?: string;
  fill: string;
  stroke: string;
  strokeW: number;
  strokeDash: string;
  ebene: string;
  rotation: number;
  radiusOL: number;
  radiusOR: number;
  radiusUL: number;
  radiusUR: number;
  groupId?: string;
  gesperrt?: boolean;
  libraryName?: string;
  dbZIndex?: number;
}

export interface DbPathObject {
  type: 'PFAD';
  uid: string;
  x: number;
  y: number;
  w: number;
  h: number;
  ox: number;
  oy: number;
  points: { x: number; y: number; t?: number }[];
  d: string;
  glaettung: number;
  isCurve?: boolean;
  curveClosed?: boolean;
  isBrush?: boolean;
  isWall?: boolean;
  wallWidth?: number;
  wallHatchSpacing?: number;
  wallHatchType?: 'diagonal' | 'cross' | 'brick' | 'concrete' | 'insulation' | 'none';
  wallHatchColor?: string;
  brushForm?: 'kreis' | 'rechteck' | 'linie' | 'gepunktet' | 'faecher' | 'airbrush' | 'tinte' | 'kreide' | 'textur' | 'zickzack' | 'doppellinie';
  brushSize?: number;
  stroke: string;
  strokeW: number;
  strokeDash: string;
  fill: string;
  ebene: string;
  rotation: number;
  radiusOL: number;
  radiusOR: number;
  radiusUL: number;
  radiusUR: number;
  groupId?: string;
  gesperrt?: boolean;
  libraryName?: string;
  dbZIndex?: number;
}

interface ObjectRow {
  uid: string;
  layer_name: string;
  group_id: string | null;
  z_index: number;
  x_um: number;
  y_um: number;
  w_um: number;
  h_um: number;
  rotation_mdeg: number;
  stroke: string;
  fill: string;
  stroke_w_um: number;
  stroke_dash: string;
  payload_json: string;
}

function rectPayload(rect: DbRectObject): string {
  return JSON.stringify({
    radiusOL: rect.radiusOL,
    radiusOR: rect.radiusOR,
    radiusUL: rect.radiusUL,
    radiusUR: rect.radiusUR,
    shape: rect.shape,
    polygonSides: rect.polygonSides,
    frameWidth: rect.frameWidth,
    isImageFrame: rect.isImageFrame,
    imageShape: rect.imageShape,
    imageFile: rect.imageFile,
    imageScale: rect.imageScale,
    imageOffsetX: rect.imageOffsetX,
    imageOffsetY: rect.imageOffsetY,
    imageRenderW: rect.imageRenderW,
    imageRenderH: rect.imageRenderH,
    imageMaskD: rect.imageMaskD,
    imageNativeW: rect.imageNativeW,
    imageNativeH: rect.imageNativeH,
    imageFormat: rect.imageFormat,
    imageSizeBytes: rect.imageSizeBytes,
    shadowEnabled: rect.shadowEnabled,
    shadowX: rect.shadowX,
    shadowY: rect.shadowY,
    shadowBlur: rect.shadowBlur,
    shadowColor: rect.shadowColor,
    cornerStyle: rect.cornerStyle,
    shearX: rect.shearX,
    shearY: rect.shearY,
    gesperrt: rect.gesperrt,
    libraryName: rect.libraryName,
  });
}

function linePayload(line: DbLineObject): string {
  return JSON.stringify({
    x1: pxToUm(line.x1),
    y1: pxToUm(line.y1),
    x2: pxToUm(line.x2),
    y2: pxToUm(line.y2),
    arrowStart: line.arrowStart,
    arrowEnd: line.arrowEnd,
    isMasslinie: line.isMasslinie,
    massText: line.massText,
    massTextPos: line.massTextPos,
    massFontSize: line.massFontSize,
    massFontFamily: line.massFontFamily,
    massFontWeight: line.massFontWeight,
    massFontStyle: line.massFontStyle,
    gesperrt: line.gesperrt,
  });
}

function textPayload(text: DbTextObject): string {
  return JSON.stringify({
    richHtml: text.richHtml,
    textAlign: text.textAlign,
    lineHeight: text.lineHeight,
    shadowEnabled: text.shadowEnabled,
    shadowX: text.shadowX,
    shadowY: text.shadowY,
    shadowBlur: text.shadowBlur,
    shadowColor: text.shadowColor,
    gesperrt: text.gesperrt,
  });
}

function pathPayload(path: DbPathObject): string {
  return JSON.stringify({
    ox: pxToUm(path.ox),
    oy: pxToUm(path.oy),
    points: path.points.map(p => typeof p.t === 'number' ? [pxToUm(p.x), pxToUm(p.y), p.t] : [pxToUm(p.x), pxToUm(p.y)]),
    rawD: path.d,
    glaettung: path.glaettung,
    isCurve: path.isCurve,
    curveClosed: path.curveClosed,
    isBrush: path.isBrush,
    isWall: path.isWall,
    wallWidth: typeof path.wallWidth === 'number' ? pxToUm(path.wallWidth) : undefined,
    wallHatchSpacing: typeof path.wallHatchSpacing === 'number' ? pxToUm(path.wallHatchSpacing) : undefined,
    wallHatchType: path.wallHatchType,
    wallHatchColor: path.wallHatchColor,
    brushForm: path.brushForm,
    brushSize: path.brushSize,
    gesperrt: path.gesperrt,
    libraryName: path.libraryName,
  });
}

async function ensureLayer(name: string) {
  const db = await getDb();
  await db.execute(
    `INSERT OR IGNORE INTO layers
      (document_id, name, position, visible, locked, opacity)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [DEFAULT_DOCUMENT_ID, name, 0, 1, 0, 100],
  );
}

export async function upsertRectObject(rect: DbRectObject, zIndex: number) {
  const db = await getDb();
  await ensureLayer(rect.ebene);
  await db.execute(
    `INSERT INTO objects
      (document_id, uid, type, layer_name, group_id, z_index, x_um, y_um, w_um, h_um,
       rotation_mdeg, stroke, fill, stroke_w_um, stroke_dash, payload_json, updated_at)
     VALUES ($1, $2, 'RECHTECK', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP)
     ON CONFLICT(document_id, uid) DO UPDATE SET
       layer_name = excluded.layer_name,
       group_id = excluded.group_id,
       z_index = excluded.z_index,
       x_um = excluded.x_um,
       y_um = excluded.y_um,
       w_um = excluded.w_um,
       h_um = excluded.h_um,
       rotation_mdeg = excluded.rotation_mdeg,
       stroke = excluded.stroke,
       fill = excluded.fill,
       stroke_w_um = excluded.stroke_w_um,
       stroke_dash = excluded.stroke_dash,
       payload_json = excluded.payload_json,
       updated_at = CURRENT_TIMESTAMP`,
    [
      DEFAULT_DOCUMENT_ID,
      rect.uid,
      rect.ebene,
      rect.groupId ?? null,
      zIndex,
      pxToUm(rect.x),
      pxToUm(rect.y),
      pxToUm(rect.w),
      pxToUm(rect.h),
      Math.round(rect.rotation * 1000),
      rect.stroke,
      rect.fill,
      pxToUm(rect.strokeW),
      rect.strokeDash ?? '',
      rectPayload(rect),
    ],
  );
}

export async function upsertLineObject(line: DbLineObject, zIndex: number) {
  const db = await getDb();
  await ensureLayer(line.ebene);
  await db.execute(
    `INSERT INTO objects
      (document_id, uid, type, layer_name, group_id, z_index, x_um, y_um, w_um, h_um,
       rotation_mdeg, stroke, fill, stroke_w_um, stroke_dash, payload_json, updated_at)
     VALUES ($1, $2, 'LINIE', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP)
     ON CONFLICT(document_id, uid) DO UPDATE SET
       layer_name = excluded.layer_name,
       group_id = excluded.group_id,
       z_index = excluded.z_index,
       x_um = excluded.x_um,
       y_um = excluded.y_um,
       w_um = excluded.w_um,
       h_um = excluded.h_um,
       rotation_mdeg = excluded.rotation_mdeg,
       stroke = excluded.stroke,
       fill = excluded.fill,
       stroke_w_um = excluded.stroke_w_um,
       stroke_dash = excluded.stroke_dash,
       payload_json = excluded.payload_json,
       updated_at = CURRENT_TIMESTAMP`,
    [
      DEFAULT_DOCUMENT_ID,
      line.uid,
      line.ebene,
      line.groupId ?? null,
      zIndex,
      pxToUm(line.x),
      pxToUm(line.y),
      pxToUm(line.w),
      pxToUm(line.h),
      Math.round(line.rotation * 1000),
      line.stroke,
      line.fill,
      pxToUm(line.strokeW),
      line.strokeDash ?? '',
      linePayload(line),
    ],
  );
}

export async function upsertTextObject(text: DbTextObject, zIndex: number) {
  const db = await getDb();
  await ensureLayer(text.ebene);
  await db.execute(
    `INSERT INTO objects
      (document_id, uid, type, layer_name, group_id, z_index, x_um, y_um, w_um, h_um,
       rotation_mdeg, stroke, fill, stroke_w_um, stroke_dash, payload_json, updated_at)
     VALUES ($1, $2, 'TEXT', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP)
     ON CONFLICT(document_id, uid) DO UPDATE SET
       layer_name = excluded.layer_name,
       group_id = excluded.group_id,
       z_index = excluded.z_index,
       x_um = excluded.x_um,
       y_um = excluded.y_um,
       w_um = excluded.w_um,
       h_um = excluded.h_um,
       rotation_mdeg = excluded.rotation_mdeg,
       stroke = excluded.stroke,
       fill = excluded.fill,
       stroke_w_um = excluded.stroke_w_um,
       stroke_dash = excluded.stroke_dash,
       payload_json = excluded.payload_json,
       updated_at = CURRENT_TIMESTAMP`,
    [
      DEFAULT_DOCUMENT_ID,
      text.uid,
      text.ebene,
      text.groupId ?? null,
      zIndex,
      pxToUm(text.x),
      pxToUm(text.y),
      pxToUm(text.w),
      pxToUm(text.h),
      Math.round(text.rotation * 1000),
      text.stroke,
      text.fill,
      pxToUm(text.strokeW),
      text.strokeDash ?? '',
      textPayload(text),
    ],
  );
}

export async function upsertPathObject(path: DbPathObject, zIndex: number) {
  const db = await getDb();
  await ensureLayer(path.ebene);
  await db.execute(
    `INSERT INTO objects
      (document_id, uid, type, layer_name, group_id, z_index, x_um, y_um, w_um, h_um,
       rotation_mdeg, stroke, fill, stroke_w_um, stroke_dash, payload_json, updated_at)
     VALUES ($1, $2, 'PFAD', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP)
     ON CONFLICT(document_id, uid) DO UPDATE SET
       layer_name = excluded.layer_name,
       group_id = excluded.group_id,
       z_index = excluded.z_index,
       x_um = excluded.x_um,
       y_um = excluded.y_um,
       w_um = excluded.w_um,
       h_um = excluded.h_um,
       rotation_mdeg = excluded.rotation_mdeg,
       stroke = excluded.stroke,
       fill = excluded.fill,
       stroke_w_um = excluded.stroke_w_um,
       stroke_dash = excluded.stroke_dash,
       payload_json = excluded.payload_json,
       updated_at = CURRENT_TIMESTAMP`,
    [
      DEFAULT_DOCUMENT_ID,
      path.uid,
      path.ebene,
      path.groupId ?? null,
      zIndex,
      pxToUm(path.x),
      pxToUm(path.y),
      pxToUm(path.w),
      pxToUm(path.h),
      Math.round(path.rotation * 1000),
      path.stroke,
      path.fill,
      pxToUm(path.strokeW),
      path.strokeDash ?? '',
      pathPayload(path),
    ],
  );
}

export async function loadLayerObjects(): Promise<Array<{ name: string; visible: boolean; locked: boolean; opacity: number }>> {
  const db = await getDb();
  const rows = await db.select<Array<{ name: string; visible: number; locked: number; opacity: number }>>(
    `SELECT name, visible, locked, opacity FROM layers WHERE document_id = $1 AND name != 'Raster' ORDER BY position`,
    [DEFAULT_DOCUMENT_ID],
  );
  return rows.map(r => ({ name: r.name, visible: !!r.visible, locked: !!r.locked, opacity: r.opacity }));
}

export async function loadRectObjects(): Promise<DbRectObject[]> {
  const db = await getDb();
  const rows = await db.select<ObjectRow[]>(
    `SELECT uid, layer_name, group_id, z_index, x_um, y_um, w_um, h_um, rotation_mdeg,
            stroke, fill, stroke_w_um, stroke_dash, payload_json
       FROM objects
      WHERE document_id = $1 AND type = 'RECHTECK'
      ORDER BY z_index ASC`,
    [DEFAULT_DOCUMENT_ID],
  );

  return rows.map(row => {
    let payload: Partial<DbRectObject> = {};
    try {
      payload = JSON.parse(row.payload_json || '{}');
    } catch {
      payload = {};
    }
    return {
      type: 'RECHTECK',
      uid: row.uid,
      x: Math.round(umToPx(row.x_um)),
      y: Math.round(umToPx(row.y_um)),
      w: Math.max(1, Math.round(umToPx(row.w_um))),
      h: Math.max(1, Math.round(umToPx(row.h_um))),
      fill: row.fill,
      stroke: row.stroke,
      strokeW: umToPx(row.stroke_w_um),
      strokeDash: row.stroke_dash,
      radiusOL: payload.radiusOL ?? 0,
      radiusOR: payload.radiusOR ?? 0,
      radiusUL: payload.radiusUL ?? 0,
      radiusUR: payload.radiusUR ?? 0,
      rotation: row.rotation_mdeg / 1000,
      ebene: row.layer_name,
      shape: payload.shape,
      polygonSides: payload.polygonSides,
      frameWidth: payload.frameWidth,
      isImageFrame: payload.isImageFrame,
      imageShape: payload.imageShape,
      imageFile: payload.imageFile,
      imageScale: payload.imageScale,
      imageOffsetX: payload.imageOffsetX,
      imageOffsetY: payload.imageOffsetY,
      imageRenderW: payload.imageRenderW,
      imageRenderH: payload.imageRenderH,
      imageMaskD: payload.imageMaskD,
      shadowEnabled: payload.shadowEnabled,
      shadowX: payload.shadowX,
      shadowY: payload.shadowY,
      shadowBlur: payload.shadowBlur,
      shadowColor: payload.shadowColor,
      cornerStyle: payload.cornerStyle,
      shearX: payload.shearX,
      shearY: payload.shearY,
      gesperrt: payload.gesperrt,
      libraryName: payload.libraryName,
      groupId: row.group_id ?? undefined,
      dbZIndex: row.z_index,
    };
  });
}

export async function loadLineObjects(): Promise<DbLineObject[]> {
  const db = await getDb();
  const rows = await db.select<ObjectRow[]>(
    `SELECT uid, layer_name, group_id, z_index, x_um, y_um, w_um, h_um, rotation_mdeg,
            stroke, fill, stroke_w_um, stroke_dash, payload_json
       FROM objects
      WHERE document_id = $1 AND type = 'LINIE'
      ORDER BY z_index ASC`,
    [DEFAULT_DOCUMENT_ID],
  );

  return rows.map(row => {
    let payload: Partial<DbLineObject> & { x1?: number; y1?: number; x2?: number; y2?: number } = {};
    try {
      payload = JSON.parse(row.payload_json || '{}');
    } catch {
      payload = {};
    }
    const x1 = Math.round(umToPx(payload.x1 ?? row.x_um));
    const y1 = Math.round(umToPx(payload.y1 ?? row.y_um));
    const x2 = Math.round(umToPx(payload.x2 ?? row.x_um + row.w_um));
    const y2 = Math.round(umToPx(payload.y2 ?? row.y_um + row.h_um));
    return {
      type: 'LINIE',
      uid: row.uid,
      x1,
      y1,
      x2,
      y2,
      x: Math.round(umToPx(row.x_um)),
      y: Math.round(umToPx(row.y_um)),
      w: Math.max(1, Math.round(umToPx(row.w_um))),
      h: Math.max(1, Math.round(umToPx(row.h_um))),
      stroke: row.stroke,
      strokeW: umToPx(row.stroke_w_um),
      strokeDash: row.stroke_dash,
      fill: row.fill,
      arrowStart: payload.arrowStart ?? 'none',
      arrowEnd: payload.arrowEnd ?? 'none',
      isMasslinie: payload.isMasslinie ?? false,
      massText: payload.massText,
      massTextPos: payload.massTextPos ?? 'ueber',
      massFontSize: payload.massFontSize ?? 11,
      massFontFamily: payload.massFontFamily ?? "'Helvetica Neue', Helvetica, Arial, sans-serif",
      massFontWeight: payload.massFontWeight ?? 'normal',
      massFontStyle: payload.massFontStyle ?? 'normal',
      ebene: row.layer_name,
      rotation: row.rotation_mdeg / 1000,
      radiusOL: 0,
      radiusOR: 0,
      radiusUL: 0,
      radiusUR: 0,
      shadowEnabled: payload.shadowEnabled,
      shadowX: payload.shadowX,
      shadowY: payload.shadowY,
      shadowBlur: payload.shadowBlur,
      shadowColor: payload.shadowColor,
      gesperrt: payload.gesperrt,
      groupId: row.group_id ?? undefined,
      dbZIndex: row.z_index,
    };
  });
}

export async function loadTextObjects(): Promise<DbTextObject[]> {
  const db = await getDb();
  const rows = await db.select<ObjectRow[]>(
    `SELECT uid, layer_name, group_id, z_index, x_um, y_um, w_um, h_um, rotation_mdeg,
            stroke, fill, stroke_w_um, stroke_dash, payload_json
       FROM objects
      WHERE document_id = $1 AND type = 'TEXT'
      ORDER BY z_index ASC`,
    [DEFAULT_DOCUMENT_ID],
  );

  return rows.map(row => {
    let payload: Partial<DbTextObject> = {};
    try {
      payload = JSON.parse(row.payload_json || '{}');
    } catch {
      payload = {};
    }
    return {
      type: 'TEXT',
      uid: row.uid,
      x: Math.round(umToPx(row.x_um)),
      y: Math.round(umToPx(row.y_um)),
      w: Math.max(1, Math.round(umToPx(row.w_um))),
      h: Math.max(1, Math.round(umToPx(row.h_um))),
      richHtml: payload.richHtml ?? '',
      textAlign: payload.textAlign ?? 'left',
      lineHeight: payload.lineHeight ?? 1.4,
      shadowEnabled: payload.shadowEnabled,
      shadowX: payload.shadowX,
      shadowY: payload.shadowY,
      shadowBlur: payload.shadowBlur,
      shadowColor: payload.shadowColor,
      fill: row.fill,
      stroke: row.stroke,
      strokeW: umToPx(row.stroke_w_um),
      strokeDash: row.stroke_dash,
      ebene: row.layer_name,
      rotation: row.rotation_mdeg / 1000,
      radiusOL: 0,
      radiusOR: 0,
      radiusUL: 0,
      radiusUR: 0,
      gesperrt: payload.gesperrt,
      groupId: row.group_id ?? undefined,
      dbZIndex: row.z_index,
    };
  });
}

export async function loadPathObjects(): Promise<DbPathObject[]> {
  const db = await getDb();
  const rows = await db.select<ObjectRow[]>(
    `SELECT uid, layer_name, group_id, z_index, x_um, y_um, w_um, h_um, rotation_mdeg,
            stroke, fill, stroke_w_um, stroke_dash, payload_json
       FROM objects
      WHERE document_id = $1 AND type = 'PFAD'
      ORDER BY z_index ASC`,
    [DEFAULT_DOCUMENT_ID],
  );

  return rows.map(row => {
    let payload: {
      ox?: number;
      oy?: number;
      points?: unknown;
      glaettung?: number;
      isCurve?: boolean;
      curveClosed?: boolean;
      isBrush?: boolean;
      isWall?: boolean;
      wallWidth?: number;
      wallHatchSpacing?: number;
      wallHatchType?: DbPathObject['wallHatchType'];
      wallHatchColor?: string;
      brushForm?: DbPathObject['brushForm'];
      brushSize?: number;
      gesperrt?: boolean;
      libraryName?: string;
    } = {};
    try {
      payload = JSON.parse(row.payload_json || '{}');
    } catch {
      payload = {};
    }
    const points = Array.isArray(payload.points)
      ? payload.points
          .filter((p): p is [number, number, number?] => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number')
          .map(([x, y, t]) => ({ x: Math.round(umToPx(x)), y: Math.round(umToPx(y)), t: typeof t === 'number' ? t : undefined }))
      : [];
    return {
      type: 'PFAD',
      uid: row.uid,
      x: Math.round(umToPx(row.x_um)),
      y: Math.round(umToPx(row.y_um)),
      w: Math.max(1, Math.round(umToPx(row.w_um))),
      h: Math.max(1, Math.round(umToPx(row.h_um))),
      ox: Math.round(umToPx(payload.ox ?? row.x_um)),
      oy: Math.round(umToPx(payload.oy ?? row.y_um)),
      points,
      d: typeof (payload as { rawD?: unknown }).rawD === 'string' ? (payload as { rawD: string }).rawD : '',
      glaettung: payload.glaettung ?? 0.5,
      isCurve: payload.isCurve,
      curveClosed: payload.curveClosed,
      isBrush: payload.isBrush,
      isWall: payload.isWall,
      wallWidth: typeof payload.wallWidth === 'number' ? umToPx(payload.wallWidth) : undefined,
      wallHatchSpacing: typeof payload.wallHatchSpacing === 'number' ? umToPx(payload.wallHatchSpacing) : undefined,
      wallHatchType: payload.wallHatchType,
      wallHatchColor: payload.wallHatchColor,
      brushForm: payload.brushForm,
      brushSize: payload.brushSize,
      stroke: row.stroke,
      strokeW: umToPx(row.stroke_w_um),
      strokeDash: row.stroke_dash,
      fill: row.fill,
      ebene: row.layer_name,
      rotation: row.rotation_mdeg / 1000,
      radiusOL: 0,
      radiusOR: 0,
      radiusUL: 0,
      radiusUR: 0,
      gesperrt: payload.gesperrt,
      libraryName: payload.libraryName,
      groupId: row.group_id ?? undefined,
      dbZIndex: row.z_index,
    };
  });
}

export async function deleteObjectsByUid(uids: string[]) {
  if (!uids.length) return;
  const db = await getDb();
  for (const uid of uids) {
    await db.execute(
      'DELETE FROM objects WHERE document_id = $1 AND uid = $2',
      [DEFAULT_DOCUMENT_ID, uid],
    );
  }
}

