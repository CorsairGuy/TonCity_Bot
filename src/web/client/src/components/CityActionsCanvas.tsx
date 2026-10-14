import { useEffect, useRef, useCallback, useMemo } from 'react';
import type { MapBuilding, CityStrategyTarget, CityStrategyQueueItem, BuildingDef, GlobalUpgradeRule, MapSection } from '../api';
import cityCoordsData from '../data/city-coords.json';
import capitalCoordsData from '../data/capital-coords.json';
import cityRoadMapData from '../data/road-map.json';
import capitalRoadMapData from '../data/capital-road-map.json';

// Рендер — из CityMapCanvas.tsx (реальная карта аккаунта, спрайты, badges). Hover-подсветка клетки,
// drag-select прямоугольником ("кисть") и математика сетки — из MapEditor.tsx. ЛКМ-drag в режимах,
// где массовый выбор уместен (upgrade/build/demolish/reconstruct/renovate — не move, там нужна
// точная пара кликов), выделяет прямоугольник и на mouseup вызывает onPick для каждой валидной
// клетки внутри — parent (CityMap.tsx) сам решает что делать с каждой (добавить в очередь/цель).
// Панорамирование — ПКМ-drag всегда, и ЛКМ-drag в режимах без кисти (view/move), как в MapEditor.

const BATCHABLE: CityActionMode[] = ['upgrade', 'queue', 'build', 'demolish', 'reconstruct', 'renovate'];

// Сетка карты (полный список клеток — лес/дороги/пустые) и road-map (какой тайл-спрайт на какой
// клетке) — статические данные разметки карты, никогда не регенерируются скриптом (в отличие от
// sprite-map.json — тот качается заново download-sprites.js при обновлении игры, поэтому ЕГО
// продолжаем грузить через /sprites/sprite-map.json, а не бандлим). Импортируем прямо в JS-бандл
// вместо fetch('/api/coords') — так вся сетка доступна СИНХРОННО с первым рендером компонента, без
// какой-либо гонки/мелькания "обрезок → полная карта" при ожидании ответа сервера.
const COORDS: Record<'city' | 'capital', { x: number; y: number }[]> = {
  city: cityCoordsData as { x: number; y: number }[],
  capital: capitalCoordsData as { x: number; y: number }[],
};
const ROAD_MAP: Record<'city' | 'capital', Record<string, { asset: string; big?: boolean }>> = {
  city: cityRoadMapData as Record<string, { asset: string; big?: boolean }>,
  capital: capitalRoadMapData as Record<string, { asset: string; big?: boolean }>,
};

// sprite-map.json остаётся живым fetch (регенерируется scripts/download-sprites.js при обновлении
// игры) — кэшируем на уровне модуля просто чтобы не дёргать его повторно при каждом открытии карты
// в рамках одной сессии.
let spriteMapCache: Record<string, { pngUrl: string; frame: { x: number; y: number; w: number; h: number } }> | null = null;

const TW = 90;
const TH = Math.round(TW * 434 / 753); // 52

const MAP_CAT_COLORS: Record<string, { fill: string; stroke: string }> = {
  COM: { fill: 'rgba(0,152,234,.35)',   stroke: 'rgba(0,152,234,.85)' },
  RES: { fill: 'rgba(137,87,229,.35)',  stroke: 'rgba(137,87,229,.85)' },
  SER: { fill: 'rgba(46,160,67,.35)',   stroke: 'rgba(46,160,67,.85)' },
  SPE: { fill: 'rgba(198,144,38,.35)',  stroke: 'rgba(198,144,38,.85)' },
  CAP: { fill: 'rgba(38,198,218,.35)',  stroke: 'rgba(38,198,218,.85)' },
  DEC: { fill: 'rgba(84,93,104,.25)',   stroke: 'rgba(120,130,140,.6)' },
  BEN: { fill: 'rgba(46,160,67,.35)',   stroke: 'rgba(46,160,67,.85)' },
};

function buildingCat(id: string): string {
  if (id.startsWith('CAP_')) { const m = id.slice(4).match(/^([A-Z]+)_/); return m ? m[1] : ''; }
  const m = id.match(/^([A-Z]+)_/);
  return m ? m[1] : '';
}
function buildingLabel(id: string): string {
  return id.replace(/\.png$/i, '').replace(/^[A-Z]+_(?:[A-Z]+_)?/, '').replace(/_/g, ' ');
}

// время улучшения — та же формула, что и upgradeDuration() в web/cityStats.js (сверена с бандлом
// игры: getBaseUpgradeDuration городского здания), нужна клиенту для живого прогресс-бара стройки,
// т.к. игра не отдаёт время НАЧАЛА стройки — только b.end (время окончания)
// Потолок временный: на «Летний карнавал» (10-23.08.2026) игра урезала его с 24ч до 12ч —
// см. подробный комментарий у upgradeTimeCapSec() в web/cityStats.js. Столиц это не касается.
const UPGRADE_TIME_CAP_SEC = 86400;
const EVENT_UPGRADE_TIME_CAP_SEC = 43200;
const EVENT_CAP_FROM_MS = Date.UTC(2026, 7, 10);
const EVENT_CAP_TO_MS = Date.UTC(2026, 7, 24);
function upgradeTimeCapSec(nowMs = Date.now()): number {
  return (nowMs >= EVENT_CAP_FROM_MS && nowMs < EVENT_CAP_TO_MS) ? EVENT_UPGRADE_TIME_CAP_SEC : UPGRADE_TIME_CAP_SEC;
}
function upgradeDurationSec(incSec: number, level: number): number {
  if (!incSec) return 0;
  const cap = upgradeTimeCapSec();
  const capLevel = Math.floor(Math.log2(cap / incSec)) + 2;
  return level > capLevel ? cap : incSec * Math.pow(2, level - 2);
}
function fmtTimeLeft(ms: number): string {
  if (ms <= 0) return '0м';
  const totalMin = Math.ceil(ms / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h > 0 ? `${h}ч ${m}м` : `${m}м`;
}
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if ((ctx as any).roundRect) (ctx as any).roundRect(x, y, w, h, rr);
  else ctx.rect(x, y, w, h);
}

// какой спрайт игра подставляет вместо здания на время стройки — сверено с бандлом
// (setLevelUpTimeout: setAsset(aF()|lF()|i_e()) при isUnderConstruction). Не "картинка на каждое
// здание своя" — на самом деле всего 3 общих спрайта: обычный, увеличенный (для высоких зданий из
// списка ниже) и "фундамент" (только для нескольких построек столицы).
const CITY_TALL_CONSTRUCTION_IDS = new Set([
  'RES_seaside_condominiums.png', 'RES_celestial_spire.png', 'RES_crystal_aurora.png', 'RES_nova_nexus.png',
  'RES_skyscraper.png', 'RES_utopia_megacomplex.png', 'RES_crystal_aurora_1_star.png', 'RES_crystal_aurora_2_star.png',
  'RES_crystal_aurora_3_star.png', 'RES_nova_nexus_1_star.png', 'RES_nova_nexus_2_star.png', 'RES_nova_nexus_3_star.png',
  'COM_grand_arcanum.png', 'COM_empyrean_exchange.png', 'COM_casino_resort.png', 'COM_grand_arcanum_1_star.png',
  'COM_grand_arcanum_2_star.png', 'COM_grand_arcanum_3_star.png',
]);
const CAPITAL_FOUNDATION_IDS = new Set([
  'CAP_BEN_treasury_hall.png', 'CAP_BEN_commerce_hall.png', 'CAP_BEN_prosperity_tower.png',
  'CAP_BEN_resource_barn.png', 'CAP_BEN_clock_tower.png', 'CAP_BEN_trade_center.png',
]);
const CAPITAL_TALL_CONSTRUCTION_IDS = new Set(['CAP_COM_finance_center.png', 'CAP_guild_headquarters.png']);

function constructionSpriteId(id: string, type: 'city' | 'capital'): string {
  if (type === 'capital') {
    if (CAPITAL_FOUNDATION_IDS.has(id)) return 'CAP_level0.png';
    if (CAPITAL_TALL_CONSTRUCTION_IDS.has(id)) return 'construction2.png';
    return 'construction.png';
  }
  return CITY_TALL_CONSTRUCTION_IDS.has(id) ? 'construction2.png' : 'construction.png';
}

export type CityActionMode = 'view' | 'upgrade' | 'queue' | 'build' | 'move' | 'demolish' | 'reconstruct' | 'renovate' | 'boosters' | 'log' | 'forecast' | 'skip';

// режимы, где здания, недоступные для действия (не входят в validSet), затеняются на карте —
// видны только реально подходящие кандидаты (сверено с "Реконструкция"/"Реновация", теперь и
// "Улучшение"/"План" по тому же принципу)
const DIM_INAPPLICABLE_MODES = new Set<CityActionMode>(['reconstruct', 'renovate', 'queue', 'upgrade', 'skip']);

interface Props {
  buildings: MapBuilding[];
  type: 'city' | 'capital';
  // идентификатор конкретной карты (имя аккаунта у города / guild_title у столицы) — нужен, чтобы
  // отличить "переключились на другую карту" (тогда зум/пан сбрасываем и центрируем заново) от
  // "пришло живое обновление данных этой же карты" (SSE после завершения стройки и т.п. — зум/пан
  // должны остаться как есть, см. baseline-баг: зум сбрасывался при каждом обновлении)
  mapKey: string;
  mode: CityActionMode;
  validSet: Set<string>;   // "x_y" — клетки, кликабельные в текущем режиме
  pickedSet: Set<string>;  // "x_y" — уже выбранные в текущем действии (устойчивая подсветка)
  targets: CityStrategyTarget[]; // цели улучшений (личный план) — для бейджа "12-25"
  queue: CityStrategyQueueItem[]; // ручная приоритетная очередь — для бейджа "Q1 12"
  // общий план по семействам (точный id здания, см. resolveEffectiveTargets/resolveEffectiveCapitalTargets
  // на бэкенде) — используется бейджем ТОЛЬКО если для клетки нет личной цели, тот же приоритет,
  // что применяет реальный бот: очередь → личный план → общий план
  globalPlan: GlobalUpgradeRule[];
  catalog: BuildingDef[]; // каталог зданий — для construction_increment (прогресс-бар стройки)
  onPick: (gx: number, gy: number) => void;
  // закрытые секции карты (только у города, см. config/city_sections.json) — sections: статический
  // каталог, unlockedSections: что уже открыто у ЭТОГО аккаунта (прямо из /progress/, см. progress.js).
  // Клик по клетке закрытой секции ВСЕГДА (в любом режиме, включая "Просмотр") запускает
  // onUnlockCell вместо обычного onPick — сама секция ещё не является полем боя для build/upgrade.
  sections?: MapSection[];
  unlockedSections?: string[];
  onUnlockCell?: (sectionId: string) => void;
}

export function CityActionsCanvas({ buildings, type, mapKey, mode, validSet, pickedSet, targets, queue, globalPlan, catalog, onPick, sections, unlockedSections, onUnlockCell }: Props) {
  // "x_y" клетки закрытой секции → id секции — только город, только пока секция не в unlockedSections
  const lockedCells = useMemo(() => {
    const m = new Map<string, string>();
    // unlockedSections не передали (снимок ещё без этих данных) — замков не рисуем вовсе,
    // иначе весь город выглядит запертым
    if (type !== 'city' || !sections?.length || !unlockedSections) return m;
    const unlocked = new Set(unlockedSections);
    for (const sec of sections) {
      if (unlocked.has(sec.id)) continue;
      for (const c of sec.coordinates) m.set(`${c.x}_${c.y}`, sec.id);
    }
    return m;
  }, [type, sections, unlockedSections]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // какую карту (тип+ключ) уже центрировали — сбрасывается только при реальном переключении карты,
  // не при каждом обновлении данных той же карты (см. Props.mapKey)
  const centeredForRef = useRef<string | null>(null);

  const state = useRef({
    spriteMap: (spriteMapCache || {}) as Record<string, { pngUrl: string; frame: { x: number; y: number; w: number; h: number } }>,
    imgCache: {} as Record<string, HTMLImageElement>,
    roadMap: ROAD_MAP[type],
    bmap: {} as Record<string, MapBuilding>,
    x0: 0, y0: 0, cols: 0, rows: 0,
    coords: new Set<string>(COORDS[type].map(c => `${c.x}_${c.y}`)),
    // тот же набор клеток карты, что coords выше, но в исходном {x,y} виде — нужен computeBounds,
    // чтобы граница карты всегда охватывала ВСЮ сетку (лес/дороги), а не только клетки с постройками.
    // Статический импорт (см. COORDS выше) — доступен сразу, без fetch, поэтому границы можно
    // посчитать уже на первом рендере, без промежуточного "обрезанного" кадра.
    coordsList: COORDS[type],
    lockedCells: new Map<string, string>(),
    ox: 0, oy: 0, scale: 1,
    needsCenter: true,
    rafId: null as number | null,
    liveTimer: null as ReturnType<typeof setTimeout> | null,
    dragging: false, dx: 0, dy: 0,
    hoverTile: null as { col: number; row: number; gx: number; gy: number } | null,
    // отдельный, ВСЕГДА активный hover (не зависит от режима/validSet, в отличие от hoverTile выше,
    // который используется только кистью выбора) — нужен только чтобы при наведении на строящееся
    // здание подменить текст бейджа на оставшееся время
    badgeHoverGx: null as number | null,
    badgeHoverGy: null as number | null,
    selStart: null as { col: number; row: number; gx: number; gy: number } | null,
    selCur: null as { col: number; row: number; gx: number; gy: number } | null,
    selDragging: false,
    // pinch-to-zoom + двупальцевый пан (тачскрин) — расстояние/средняя точка между двумя пальцами с
    // прошлого touchmove, чтобы считать приращения покадрово (как у колеса мыши, только источник —
    // не delta, а изменение dist/mid между кадрами)
    pinchDist: null as number | null,
    pinchMidX: null as number | null,
    pinchMidY: null as number | null,
    mode: 'view' as CityActionMode,
    validSet: new Set<string>(),
    pickedSet: new Set<string>(),
    targets: [] as CityStrategyTarget[],
    queue: [] as CityStrategyQueueItem[],
    globalPlan: [] as GlobalUpgradeRule[],
    blist: [] as MapBuilding[],
    type: 'city' as 'city' | 'capital',
    catalog: [] as BuildingDef[],
  });
  state.current.mode = mode;
  state.current.validSet = validSet;
  state.current.lockedCells = lockedCells;
  state.current.pickedSet = pickedSet;
  state.current.targets = targets;
  state.current.queue = queue;
  state.current.globalPlan = globalPlan;
  state.current.catalog = catalog;
  // ВАЖНО: buildings/type тоже зеркалятся в ref, не только читаются из пропа напрямую — redraw()
  // вызывается через requestRedraw (useCallback с пустыми deps, замороженный на первом рендере),
  // поэтому любая переменная, читаемая внутри redraw() напрямую из замыкания (а не из state.current),
  // навсегда остаётся значением ПЕРВОГО рендера. Раньше badge-проход читал buildings из замыкания —
  // после переноса/сноса здания бейдж продолжал рисоваться на старом месте, хотя тайл/спрайт (через
  // s.bmap, уже реф) обновлялся верно. Тот же паттерн уже эталонно применён в MapEditor.tsx, где
  // здания вообще хранятся только в реф-поле, а не как проп.
  state.current.blist = buildings;
  state.current.type = type;

  const requestRedraw = useCallback(() => {
    const s = state.current;
    if (s.rafId) return;
    s.rafId = requestAnimationFrame(() => { s.rafId = null; redraw(); });
  }, []);

  function isoToScreen(col: number, row: number) {
    const { rows } = state.current;
    return { x: (col - row + (rows - 1)) * TW / 2, y: (col + row) * TH / 2 };
  }

  function screenToGrid(cx: number, cy: number) {
    const s = state.current;
    const wx = (cx - s.ox) / s.scale, wy = (cy - s.oy) / s.scale;
    const a = wx * 2 / TW - s.rows;
    const b = wy * 2 / TH - 1;
    const col = Math.round((a + b) / 2);
    const row = Math.round((b - a) / 2);
    return { col, row, gx: s.x0 + col, gy: s.y0 + row };
  }

  function computeBounds(blds: MapBuilding[], coordsList: { x: number; y: number }[]) {
    let xMin = 999, xMax = -999, yMin = 999, yMax = -999;
    const src = [...blds, ...coordsList];
    for (const b of src) {
      const x = +b.x, y = +b.y;
      if (x < xMin) xMin = x; if (x > xMax) xMax = x;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    }
    if (!src.length) { xMin = 0; xMax = 10; yMin = 0; yMax = 10; }
    const pad = 3;
    const s = state.current;
    s.x0 = xMin - pad; s.y0 = yMin - pad;
    s.cols = xMax + pad - s.x0 + 1; s.rows = yMax + pad - s.y0 + 1;
  }

  function rebuildBmap() {
    const s = state.current;
    s.bmap = {};
    for (const b of buildings) s.bmap[`${b.x}_${b.y}`] = b;
  }

  function centerOnBuildings() {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const s = state.current;
    // (cols+rows-2)*TW/2 — расстояние между угловыми точками ромба сетки, но каждый тайл рисуется
    // шириной TW (см. drawTile), поэтому реальный пиксельный охват карты на один TW/TH больше —
    // без этого центр съезжал влево на TW/2, из-за чего слева и справа было по-разному пусто
    const totalW = (s.cols + s.rows - 2) * TW / 2 + TW;
    const totalH = (s.cols + s.rows - 2) * TH / 2 + TH;
    s.scale = Math.max(0.3, Math.min(2, Math.min(W / totalW, H / totalH) * 0.88));
    s.ox = W / 2 - totalW / 2 * s.scale;
    s.oy = H / 2 - totalH / 2 * s.scale;
  }

  function clampPan() {
    const wrap = wrapRef.current; if (!wrap) return;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const s = state.current;
    const mapW = (s.cols + s.rows - 1) * TW / 2 * s.scale;
    const mapH = (s.cols + s.rows - 1) * TH / 2 * s.scale;
    const m = 120;
    s.ox = Math.min(s.ox, W - m); s.ox = Math.max(s.ox, m - mapW);
    s.oy = Math.min(s.oy, H - m); s.oy = Math.max(s.oy, m - mapH);
  }

  function getImg(url: string): HTMLImageElement | null {
    const s = state.current;
    const cached = s.imgCache[url];
    if (cached) return cached.complete && cached.naturalWidth > 0 ? cached : null;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => requestRedraw();
    img.onerror = () => { (img as any)._error = true; };
    img.src = url;
    s.imgCache[url] = img;
    return null;
  }

  function drawTile(ctx: CanvasRenderingContext2D, sx: number, sy: number, fill: string, stroke: string, label?: string | null) {
    const hw = TW / 2, hh = TH / 2;
    ctx.beginPath();
    ctx.moveTo(sx + hw, sy); ctx.lineTo(sx + TW, sy + hh);
    ctx.lineTo(sx + hw, sy + TH); ctx.lineTo(sx, sy + hh);
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke();
    if (label) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(sx + hw, sy); ctx.lineTo(sx + TW, sy + hh);
      ctx.lineTo(sx + hw, sy + TH); ctx.lineTo(sx, sy + hh);
      ctx.closePath(); ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.font = `bold ${Math.max(7, Math.round(TW * 0.115))}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, sx + hw, sy + hh, TW - 6);
      ctx.restore();
    }
  }

  function badgeFor(b: MapBuilding): string | null {
    if (!b.level) return null;
    // специальные здания (город: SPE_*, столица: !is_upgradable) нельзя улучшить — уровень им не
    // рисуем вообще, показывать голое число без смысла улучшения только сбивает с толку
    const upgradable = state.current.type === 'capital' ? (b as any).is_upgradable === true : !b.id.startsWith('SPE_');
    if (!upgradable) return null;
    // текущий уровень → уровень после ручной очереди (если она есть, +1 за каждый её апгрейд этой
    // же клетки — они выполняются строго по одному подряд, см. progress.js pickStrategyTargets) →
    // плановый уровень (вкладка "План"), если он выше. Показываем только ГРАНИЦЫ, не каждый
    // промежуточный шаг: "19-22-25", а не "19-20-21-22-25". "-" вместо "→": стрелка в canvas-шрифте
    // не совпадает по вертикальным метрикам с цифрами и визуально "плавает" не по центру строки —
    // обычный дефис всегда стоит на общей базовой линии.
    const queueCount = state.current.queue.filter(q => q.x === b.x && q.y === b.y).length;
    const levels = [b.level];
    if (queueCount > 0) levels.push(b.level + queueCount);
    // приоритет цели — как у реального бота (resolveEffectiveTargets/resolveEffectiveCapitalTargets):
    // личная цель для КОНКРЕТНОЙ клетки (x,y) важнее общего плана; общий план матчится по ТОЧНОМУ
    // id здания и действует, только если для клетки нет личной цели
    const personal = state.current.targets.find(t => t.x === b.x && t.y === b.y);
    const globalTarget = state.current.globalPlan.find(g => g.family_id === b.id)?.target_level;
    const effectiveTarget = personal?.target_level ?? globalTarget;
    const lastLevel = levels[levels.length - 1];
    if (effectiveTarget && effectiveTarget > lastLevel) levels.push(effectiveTarget);
    return levels.join('-');
  }

  // обычный бейдж уровня (здание сейчас не строится) — плашка строго по центру тайла (bx,by уже
  // центр диаманта тайла, см. вызов ниже). textBaseline 'middle' у canvas центрирует по метрикам
  // ШРИФТА (em-box), а не по фактическим глифам — для цифр без нижних выносных элементов это
  // визуально "топит" текст ниже центра; ручной расчёт через actualBoundingBoxAscent/Descent
  // центрирует именно по РЕАЛЬНО нарисованным пикселям глифов, поэтому вернул его.
  function drawLevelBadge(ctx: CanvasRenderingContext2D, bx: number, by: number, label: string, fsz: number) {
    ctx.font = `bold ${fsz}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const m = ctx.measureText(label);
    const bw = Math.max(m.width + 8, fsz + 6), bh = fsz + 5, r = bh / 2;
    const textCenterY = by + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 1;
    ctx.fillStyle = 'rgba(15,15,20,0.82)';
    roundRectPath(ctx, bx - bw / 2, by - bh / 2, bw, bh, r);
    ctx.fill(); ctx.restore();
    ctx.fillStyle = '#fff';
    ctx.fillText(label, bx, textCenterY);
  }

  // бейдж стройки — тот же чёрный фон и та же плашка, что и обычный уровень (drawLevelBadge), но
  // сам фон заполняется прогрессом слева направо (заливка БЕЗ скруглений — прямоугольник, в отличие
  // от скруглённой плашки вокруг). Текст — цепочка уровней, как обычно; при наведении на этот тайл
  // (badgeHoverGx/Gy) подменяется на оставшееся время.
  function drawProgressBadge(ctx: CanvasRenderingContext2D, bx: number, by: number, label: string, fsz: number, progress: number, timeLeft: string, hovered: boolean) {
    const displayText = hovered ? timeLeft : label;
    ctx.font = `bold ${fsz}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    // ширина плашки — под ОБА возможных текста разом, чтобы при наведении плашка не "прыгала"
    const wLabel = ctx.measureText(label).width, wTime = ctx.measureText(timeLeft).width;
    const bw = Math.max(Math.max(wLabel, wTime) + 8, fsz + 6), bh = fsz + 5, r = bh / 2;
    const x0 = bx - bw / 2, y0 = by - bh / 2;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 1;
    ctx.fillStyle = 'rgba(15,15,20,0.82)'; // тот же чёрный фон, что и у обычного бейджа
    roundRectPath(ctx, x0, y0, bw, bh, r);
    ctx.fill();
    ctx.restore();

    if (progress > 0) {
      ctx.save();
      roundRectPath(ctx, x0, y0, bw, bh, r); ctx.clip(); // не даём прямоугольной заливке вылезти за скруглённые углы плашки
      ctx.fillStyle = 'rgba(46,225,90,0.92)'; // ярче — прежняя заливка (0.55 альфа) была почти не видна на тёмном фоне
      ctx.fillRect(x0, y0, bw * Math.min(1, progress), bh); // без скруглений — реальный % прогресса
      ctx.restore();
    }

    // центрируем по РЕАЛЬНЫМ пикселям текущего displayText (не label) — при подмене на время при
    // наведении шрифт/метрики те же, но пересчитываем на случай другой высоты глифов
    const m = ctx.measureText(displayText);
    const textCenterY = by + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
    ctx.fillStyle = '#fff';
    ctx.fillText(displayText, bx, textCenterY);
  }

  function redraw() {
    const wrap = wrapRef.current, canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; state.current.needsCenter = true; }
    const s = state.current;
    if (s.needsCenter && W > 0 && H > 0) { centerOnBuildings(); s.needsCenter = false; }
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    if (!s.cols || !s.rows) return;
    ctx.save();
    ctx.translate(s.ox, s.oy);
    ctx.scale(s.scale, s.scale);

    // проход 1 — тайлы и спрайты
    for (let d = 0; d <= (s.cols - 1) + (s.rows - 1); d++) {
      for (let col = 0; col <= d; col++) {
        const row = d - col;
        if (col >= s.cols || row >= s.rows) continue;
        const gx = s.x0 + col, gy = s.y0 + row;
        const { x: sx, y: sy } = isoToScreen(col, row);
        const b = s.bmap[`${gx}_${gy}`];
        const valid = s.coords.size === 0 || s.coords.has(`${gx}_${gy}`);
        const lockedSectionId = s.lockedCells.get(`${gx}_${gy}`);
        if (lockedSectionId) {
          // закрытая секция — тёмный тайл с замком вместо обычной травы/построек (там их и не может
          // быть, пока секция не открыта); клик по клетке ловится отдельно, см. onMouseUp/onTouchEnd
          drawTile(ctx, sx, sy, 'rgba(8,8,12,.62)', 'rgba(255,255,255,.15)', '🔒');
        } else if (b) {
          const cat = buildingCat(b.id);
          const cc = MAP_CAT_COLORS[cat] || { fill: 'rgba(100,100,100,.3)', stroke: 'rgba(150,150,150,.6)' };
          // здание в процессе стройки/улучшения — игра подменяет тайл на один из общих спрайтов
          // стройки (не рисует своё готовое здание), см. constructionSpriteId — сверено с бандлом
          const underConstruction = !!b.end && new Date(b.end).getTime() > Date.now();
          const spriteId = underConstruction ? constructionSpriteId(b.id, s.type) : b.id;
          const sp = s.spriteMap[spriteId];
          const img = sp ? getImg(sp.pngUrl) : null;
          // в режимах "Реконструкция"/"Реновация"/"Улучшение"/"План" прячем (сильно затемняем) здания,
          // к которым действие неприменимо — так на карте видны только реально подходящие кандидаты,
          // не нужно самому вычислять required_lvl/is_reconstructible/занятость стройкой на глаз
          const hideAsInapplicable = DIM_INAPPLICABLE_MODES.has(s.mode) && !s.validSet.has(`${gx}_${gy}`);
          if (hideAsInapplicable) ctx.globalAlpha = 0.12;
          if (img) {
            const f = sp!.frame, RS = 1.025, dh0 = f.h * TW / 753;
            const dw = TW * RS, dh = dh0 * RS;
            ctx.drawImage(img, f.x, f.y, f.w, f.h, sx - (dw - TW) / 2, sy + TH - dh, dw, dh);
          } else {
            drawTile(ctx, sx, sy, cc.fill, cc.stroke, buildingLabel(b.id));
          }
          if (hideAsInapplicable) ctx.globalAlpha = 1;
        } else if (valid) {
          const empSp = s.spriteMap['empty.png'];
          const empImg = empSp ? getImg(empSp.pngUrl) : null;
          if (empImg) {
            const f = empSp!.frame, RS = 1.025, dh0 = f.h * TW / 753;
            const dw = TW * RS, dh = dh0 * RS;
            ctx.drawImage(empImg, f.x, f.y, f.w, f.h, sx - (dw - TW) / 2, sy + TH - dh + (dh - dh0) / 2, dw, dh);
          } else {
            drawTile(ctx, sx, sy, 'rgba(255,255,255,.06)', 'rgba(255,255,255,.18)');
          }
        } else {
          const env = s.roadMap[`${gx}_${gy}`] || null;
          const envSp = env ? s.spriteMap[env.asset] : null;
          const envImg = envSp ? getImg(envSp.pngUrl) : null;
          if (envImg && env) {
            const f = envSp!.frame;
            if (env.big) {
              const dw = Math.round(TW * 2), dh = Math.round(f.h * TW / 753 * 2);
              ctx.drawImage(envImg, f.x, f.y, f.w, f.h, Math.round(sx), Math.round(sy + 3 * TH / 2 - dh), dw, dh);
            } else {
              const RS = 1.05, dh0 = f.h * TW / 753;
              const dw = TW * RS, dh = dh0 * RS;
              ctx.drawImage(envImg, f.x, f.y, f.w, f.h, sx - (dw - TW) / 2, sy + TH - dh + (dh - dh0) / 2, dw, dh);
            }
          }
        }
      }
    }

    // проход 2 — бейджи уровней (текущий, либо "текущий→целевой" при активной цели улучшения), либо
    // живой прогресс-бар стройки для зданий, у которых b.end ещё в будущем (см. drawProgressPill)
    const fsz = Math.max(8, Math.round(TW * 0.13));
    const nowMs = Date.now();
    let anyUnderConstruction = false;
    for (const b of s.blist) {
      const col = b.x - s.x0, row = b.y - s.y0;
      if (col < 0 || col >= s.cols || row < 0 || row >= s.rows) continue;
      // не рисуем бейдж уровня поверх здания, спрятанного как неприменимое к текущему действию
      if (DIM_INAPPLICABLE_MODES.has(s.mode) && !s.validSet.has(`${b.x}_${b.y}`)) continue;
      const { x: sx, y: sy } = isoToScreen(col, row);
      const bx = sx + TW / 2, by = sy + TH / 2;
      const endMs = b.end ? new Date(b.end).getTime() : 0;
      if (endMs > nowMs) {
        const label = badgeFor(b);
        if (label == null) continue; // здание нельзя улучшить (special) — прогресс не рисуем
        anyUnderConstruction = true;
        // start — реальное время начала стройки, отдаёт сама игра (см. api.ts MapBuilding.start,
        // подтверждено бандлом: deserialize() читает n.start наравне с n.end). Работает для ЛЮБого
        // улучшения — и запущенного ботом, и напрямую в игре — duration=end-start точно, без формул
        // и без знания о бустах ускорения вообще. Формула — только запасной вариант, если start вдруг
        // не пришёл (старый снимок до этого добавления, либо сбой на стороне игры)
        let durationMs: number;
        if (b.start) {
          durationMs = endMs - new Date(b.start).getTime();
        } else {
          const info = s.catalog.find(c => c.id === b.id);
          durationMs = upgradeDurationSec(info?.construction_increment || 0, b.level || 1) * 1000;
        }
        const progress = durationMs > 0 ? Math.min(1, Math.max(0, 1 - (endMs - nowMs) / durationMs)) : 0;
        const hovered = s.badgeHoverGx === b.x && s.badgeHoverGy === b.y;
        drawProgressBadge(ctx, bx, by, label, fsz, progress, fmtTimeLeft(endMs - nowMs), hovered);
      } else {
        const label = badgeFor(b);
        if (label) drawLevelBadge(ctx, bx, by, label, fsz);
      }
    }

    // проход 3 — устойчивая подсветка уже выбранных клеток (move-from и т.п.), зелёная, без пульсации
    if (s.pickedSet.size) {
      const hw = TW / 2, hh = TH / 2;
      for (const key of s.pickedSet) {
        const i = key.indexOf('_');
        const gx = parseInt(key.slice(0, i)), gy = parseInt(key.slice(i + 1));
        const col = gx - s.x0, row = gy - s.y0;
        if (col < 0 || col >= s.cols || row < 0 || row >= s.rows) continue;
        const { x: sx, y: sy } = isoToScreen(col, row);
        ctx.beginPath();
        ctx.moveTo(sx + hw, sy); ctx.lineTo(sx + TW, sy + hh);
        ctx.lineTo(sx + hw, sy + TH); ctx.lineTo(sx, sy + hh);
        ctx.closePath();
        ctx.fillStyle = 'rgba(46,160,67,.32)'; ctx.fill();
        ctx.strokeStyle = 'rgba(46,160,67,.95)'; ctx.lineWidth = 2; ctx.stroke();
      }
    }

    // проход 3.5 — прямоугольник кисти во время drag-select (пульсирующая заливка + обводка клеток,
    // попадающих в validSet — как selection-rect в MapEditor.tsx, только критерий не coords, а validSet)
    if (s.selDragging && s.selCur && s.selStart) {
      const c1 = Math.min(s.selStart.col, s.selCur.col), c2 = Math.max(s.selStart.col, s.selCur.col);
      const r1 = Math.min(s.selStart.row, s.selCur.row), r2 = Math.max(s.selStart.row, s.selCur.row);
      const hw = TW / 2, hh = TH / 2;
      const pulse = 0.55 + 0.35 * Math.sin(Date.now() / 180);
      const isErase = s.mode === 'demolish';
      const rgb = isErase ? '229,83,75' : '0,152,234';
      const sel = new Set<string>();
      for (let col = c1; col <= c2; col++) {
        for (let row = r1; row <= r2; row++) {
          const gx = s.x0 + col, gy = s.y0 + row;
          if (s.validSet.has(`${gx}_${gy}`)) sel.add(`${col}_${row}`);
        }
      }
      ctx.fillStyle = `rgba(${rgb},${pulse * 0.22})`;
      for (const k of sel) {
        const [col, row] = k.split('_').map(Number);
        const { x: sx, y: sy } = isoToScreen(col, row);
        ctx.beginPath();
        ctx.moveTo(sx + hw, sy); ctx.lineTo(sx + TW, sy + hh);
        ctx.lineTo(sx + hw, sy + TH); ctx.lineTo(sx, sy + hh);
        ctx.closePath(); ctx.fill();
      }
      const lw = 2 / s.scale;
      for (const k of sel) {
        const [col, row] = k.split('_').map(Number);
        const { x: sx, y: sy } = isoToScreen(col, row);
        const edges: [boolean, number, number, number, number][] = [
          [!sel.has(`${col}_${row - 1}`), sx + hw, sy, sx + TW, sy + hh],
          [!sel.has(`${col + 1}_${row}`), sx + TW, sy + hh, sx + hw, sy + TH],
          [!sel.has(`${col}_${row + 1}`), sx + hw, sy + TH, sx, sy + hh],
          [!sel.has(`${col - 1}_${row}`), sx, sy + hh, sx + hw, sy],
        ];
        ctx.strokeStyle = `rgba(${rgb},${0.6 + pulse * 0.4})`; ctx.lineWidth = lw;
        for (const [draw, x1, y1, x2, y2] of edges) {
          if (!draw) continue;
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        }
      }
      s.rafId = requestAnimationFrame(() => { s.rafId = null; if (s.selDragging) redraw(); });
    }

    // проход 4 — pulsing hover текущей клетки (синяя обычно, красная в режиме сноса — как ластик в MapEditor)
    if (s.hoverTile && s.mode !== 'view' && !s.selDragging) {
      const { col, row } = s.hoverTile;
      const { x: hsx, y: hsy } = isoToScreen(col, row);
      const isErase = s.mode === 'demolish';
      const pulse = 0.55 + 0.35 * Math.sin(Date.now() / 180);
      const hw = TW / 2, hh = TH / 2;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(hsx + hw, hsy - 4); ctx.lineTo(hsx + TW + 4, hsy + hh);
      ctx.lineTo(hsx + hw, hsy + TH + 4); ctx.lineTo(hsx - 4, hsy + hh);
      ctx.closePath();
      ctx.fillStyle = isErase ? `rgba(229,83,75,${pulse * 0.18})` : `rgba(0,152,234,${pulse * 0.18})`;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(hsx + hw, hsy); ctx.lineTo(hsx + TW, hsy + hh);
      ctx.lineTo(hsx + hw, hsy + TH); ctx.lineTo(hsx, hsy + hh);
      ctx.closePath();
      ctx.fillStyle = isErase ? `rgba(229,83,75,${pulse * 0.25})` : `rgba(0,152,234,${pulse * 0.25})`;
      ctx.fill();
      ctx.strokeStyle = isErase ? `rgba(229,83,75,${0.6 + pulse * 0.4})` : `rgba(0,152,234,${0.6 + pulse * 0.4})`;
      ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(hsx + hw, hsy + 4); ctx.lineTo(hsx + TW - 4, hsy + hh);
      ctx.lineTo(hsx + hw, hsy + TH - 4); ctx.lineTo(hsx + 4, hsy + hh);
      ctx.closePath();
      ctx.strokeStyle = isErase ? `rgba(255,120,120,${pulse * 0.4})` : `rgba(80,200,255,${pulse * 0.4})`;
      ctx.lineWidth = 1; ctx.stroke();
      ctx.restore();

      s.rafId = requestAnimationFrame(() => { s.rafId = null; if (s.hoverTile) redraw(); });
    }

    ctx.restore();

    // живой тик прогресс-бара стройки — раз в секунду достаточно (не 60кадр/с, тексту минут не нужно)
    if (s.liveTimer) { clearTimeout(s.liveTimer); s.liveTimer = null; }
    if (anyUnderConstruction) s.liveTimer = setTimeout(() => { s.liveTimer = null; redraw(); }, 1000);
  }

  useEffect(() => {
    const s = state.current;
    return () => {
      if (s.liveTimer) clearTimeout(s.liveTimer);
      if (s.rafId) cancelAnimationFrame(s.rafId);
    };
  }, []);

  // roadMap/coords — статические импортированные данные (см. COORDS/ROAD_MAP выше), доступны
  // синхронно уже в самом первом рендере через инициализатор state.current; этот эффект нужен
  // только чтобы пересинхронизировать их, если проп type реально меняется (city<->capital) без
  // полного размонтирования компонента. spriteMap — единственное, что всё ещё грузится живым fetch
  // (регенерируется download-sprites.js при обновлении игры), кэшируем на уровне модуля.
  useEffect(() => {
    const s = state.current;
    s.roadMap = ROAD_MAP[type];
    s.coordsList = COORDS[type];
    s.coords = new Set(s.coordsList.map(c => `${c.x}_${c.y}`));
    if (Object.keys(s.spriteMap).length === 0) {
      if (spriteMapCache) {
        s.spriteMap = spriteMapCache;
        requestRedraw();
      } else {
        fetch('/sprites/sprite-map.json').then(r => r.json()).then(sm => {
          const map: typeof s.spriteMap = {};
          for (const [id, info] of Object.entries(sm as Record<string, { atlas: string; frame: any }>)) {
            map[id] = { pngUrl: '/sprites/' + info.atlas, frame: info.frame };
          }
          spriteMapCache = map;
          s.spriteMap = map;
          requestRedraw();
        });
      }
    }
  }, [type, requestRedraw]);

  // данные карты (постройки) — центрируем ЗАНОВО только когда реально переключились на другую карту
  // (другой аккаунт/гильдия, либо city<->capital, см. mapKey), НЕ на каждое обновление buildings —
  // иначе зум/пан сбрасывались бы при любом живом обновлении (завершение стройки и т.п.)
  useEffect(() => {
    const s = state.current;
    rebuildBmap();
    const key = `${type}:${mapKey}`;
    // ВТОРОЙ аргумент computeBounds — полный список клеток карты (лес/дороги/пустые), не только
    // постройки: без него граница карты (и, следом, зум/центрирование) подгонялась только под сами
    // здания — при малом числе построек или 0 (пустой город) карта оказывалась обрезана по краям.
    // s.coordsList — статический импорт (см. COORDS выше), уже доступен на первом рендере, поэтому
    // границы считаются верно сразу, без промежуточного "обрезанного" кадра и без гонки с fetch.
    computeBounds(buildings, s.coordsList);
    if (centeredForRef.current !== key) {
      centeredForRef.current = key;
      s.needsCenter = true;
    }

    const needed = new Set(['empty.png', 'construction.png', 'construction2.png']);
    if (type === 'capital') needed.add('CAP_level0.png');
    for (const v of Object.values(s.roadMap)) needed.add(v.asset);
    for (const b of buildings) if (s.spriteMap[b.id]) needed.add(b.id);
    const urls = new Set<string>();
    for (const id of needed) { const sp = s.spriteMap[id]; if (sp) urls.add(sp.pngUrl); }
    const preloads = [...urls].map(url => new Promise<void>(res => {
      const cached = s.imgCache[url];
      if (cached && cached.complete && cached.naturalWidth > 0) return res();
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => { requestRedraw(); res(); };
      img.onerror = () => res();
      img.src = url; s.imgCache[url] = img;
    }));
    Promise.all(preloads).then(() => requestRedraw());

    let attempts = 0;
    const waitCenter = () => {
      const wrap = wrapRef.current;
      if (wrap && wrap.clientWidth > 0) { requestRedraw(); }
      else if (attempts++ < 30) setTimeout(waitCenter, 16);
    };
    waitCenter();
  }, [buildings, type, mapKey]);

  // перерисовать при смене режима / valid-set / picked-set / целей (даже без движения мыши)
  useEffect(() => { requestRedraw(); }, [mode, validSet, pickedSet, targets, globalPlan, requestRedraw]);

  useEffect(() => {
    const wrap = wrapRef.current; if (!wrap) return;
    const ro = new ResizeObserver(() => { state.current.needsCenter = true; requestRedraw(); });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // pan/zoom + hover + click
  useEffect(() => {
    const wrap = wrapRef.current, canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const s = state.current;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const newScale = Math.max(0.3, Math.min(2, s.scale * factor));
      s.ox = mx + (s.ox - mx) * (newScale / s.scale);
      s.oy = my + (s.oy - my) * (newScale / s.scale);
      s.scale = newScale;
      clampPan();
      requestRedraw();
    };

    let downX = 0, downY = 0, moved = false;
    const isBatch = () => BATCHABLE.includes(s.mode);
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 2 || !isBatch()) {
        s.dragging = true; moved = false;
        downX = e.clientX; downY = e.clientY;
        s.dx = e.clientX - s.ox; s.dy = e.clientY - s.oy;
      } else if (e.button === 0) {
        const rect = wrap.getBoundingClientRect();
        s.selStart = screenToGrid(e.clientX - rect.left, e.clientY - rect.top);
        s.selCur = null; s.selDragging = false;
      }
    };
    const onMouseMove = (e: MouseEvent) => {
      if (s.dragging) {
        if (Math.abs(e.clientX - downX) > 3 || Math.abs(e.clientY - downY) > 3) moved = true;
        s.ox = e.clientX - s.dx; s.oy = e.clientY - s.dy;
        clampPan(); requestRedraw();
      } else if (s.selStart) {
        const rect = wrap.getBoundingClientRect();
        const t = screenToGrid(e.clientX - rect.left, e.clientY - rect.top);
        const moved2 = !s.selCur || t.col !== s.selCur.col || t.row !== s.selCur.row;
        if (moved2) {
          if (!s.selDragging && (t.col !== s.selStart.col || t.row !== s.selStart.row)) s.selDragging = true;
          s.selCur = t;
          if (s.selDragging) requestRedraw();
        }
      }
      if (s.mode !== 'view' && !s.selDragging) {
        const rect = wrap.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
          const t = screenToGrid(e.clientX - rect.left, e.clientY - rect.top);
          const valid = t.col >= 0 && t.col < s.cols && t.row >= 0 && t.row < s.rows && s.validSet.has(`${t.gx}_${t.gy}`);
          const changed = !s.hoverTile || s.hoverTile.gx !== t.gx || s.hoverTile.gy !== t.gy;
          const next = valid ? t : null;
          if (changed || (!s.hoverTile) !== (!next)) { s.hoverTile = next; requestRedraw(); }
        } else if (s.hoverTile) { s.hoverTile = null; requestRedraw(); }
      } else if (s.selDragging && s.hoverTile) { s.hoverTile = null; requestRedraw(); }

      // hover для подмены текста бейджа стройки на время до конца — работает всегда, в т.ч. в
      // режиме "Просмотр", не завязан на validSet
      if (!s.dragging && !s.selDragging) {
        const rect = wrap.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
          const t = screenToGrid(e.clientX - rect.left, e.clientY - rect.top);
          const inBounds = t.col >= 0 && t.col < s.cols && t.row >= 0 && t.row < s.rows;
          const gx = inBounds ? t.gx : null, gy = inBounds ? t.gy : null;
          if (s.badgeHoverGx !== gx || s.badgeHoverGy !== gy) { s.badgeHoverGx = gx; s.badgeHoverGy = gy; requestRedraw(); }
        } else if (s.badgeHoverGx !== null || s.badgeHoverGy !== null) { s.badgeHoverGx = null; s.badgeHoverGy = null; requestRedraw(); }
      }
    };
    const onMouseUp = (e: MouseEvent) => {
      s.dragging = false;
      if (s.selStart && e.button === 0) {
        const t1 = s.selStart, t2 = s.selCur ?? s.selStart;
        const c1 = Math.min(t1.col, t2.col), c2 = Math.max(t1.col, t2.col);
        const r1 = Math.min(t1.row, t2.row), r2 = Math.max(t1.row, t2.row);
        const picks: { x: number; y: number }[] = [];
        for (let col = c1; col <= c2; col++) {
          for (let row = r1; row <= r2; row++) {
            const gx = s.x0 + col, gy = s.y0 + row;
            if (s.validSet.has(`${gx}_${gy}`)) picks.push({ x: gx, y: gy });
          }
        }
        for (const p of picks) onPick(p.x, p.y);
        s.selStart = null; s.selCur = null; s.selDragging = false;
        requestRedraw();
      } else if (!moved && e.button === 0) {
        const rect = wrap.getBoundingClientRect();
        const t = screenToGrid(e.clientX - rect.left, e.clientY - rect.top);
        const key = `${t.gx}_${t.gy}`;
        // клик по закрытой секции — ВСЕГДА (в любом режиме, включая "Просмотр") предложение
        // разблокировать, вместо обычного onPick (действия build/upgrade/etc там не применимы)
        const sectionId = s.lockedCells.get(key);
        if (sectionId) onUnlockCell?.(sectionId);
        else if (s.mode !== 'view' && s.validSet.has(key)) onPick(t.gx, t.gy);
      }
    };
    const onLeave = () => {
      if (s.hoverTile) { s.hoverTile = null; requestRedraw(); }
      if (s.badgeHoverGx !== null || s.badgeHoverGy !== null) { s.badgeHoverGx = null; s.badgeHoverGy = null; requestRedraw(); }
    };
    const onCtxMenu = (e: Event) => e.preventDefault();

    // ── тачскрин: тот же набор жестов, что и мышью — один палец панорамирует (в режиме "Просмотр"/
    // "Перемещение") или тянет кисть выбора (в batch-режимах — Улучшение/План/Строительство/Снос/
    // Реконструкция/Реновация), два пальца — pinch-to-zoom. preventDefault везде, иначе браузер сам
    // начинает скроллить/зумить страницу вместо канваса.
    const touchDist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const touchMid = (t: TouchList, rect: DOMRect) => ({
      x: (t[0].clientX + t[1].clientX) / 2 - rect.left,
      y: (t[0].clientY + t[1].clientY) / 2 - rect.top,
    });
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        s.dragging = false; s.selStart = null; s.selCur = null; s.selDragging = false;
        s.pinchDist = touchDist(e.touches);
        const rect = wrap.getBoundingClientRect();
        const mid = touchMid(e.touches, rect);
        s.pinchMidX = mid.x; s.pinchMidY = mid.y;
      } else if (e.touches.length === 1) {
        e.preventDefault();
        const t0 = e.touches[0];
        if (isBatch()) {
          const rect = wrap.getBoundingClientRect();
          s.selStart = screenToGrid(t0.clientX - rect.left, t0.clientY - rect.top);
          s.selCur = null; s.selDragging = false;
        } else {
          s.dragging = true; moved = false;
          downX = t0.clientX; downY = t0.clientY;
          s.dx = t0.clientX - s.ox; s.dy = t0.clientY - s.oy;
        }
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && s.pinchDist != null) {
        e.preventDefault();
        const rect = wrap.getBoundingClientRect();
        const dist = touchDist(e.touches), mid = touchMid(e.touches, rect);
        const factor = dist / s.pinchDist;
        const newScale = Math.max(0.3, Math.min(2, s.scale * factor));
        // зум, привязанный к текущей средней точке двух пальцев (она не "уезжает" на экране)
        s.ox = mid.x + (s.ox - mid.x) * (newScale / s.scale);
        s.oy = mid.y + (s.oy - mid.y) * (newScale / s.scale);
        s.scale = newScale;
        // плюс пан — если сама средняя точка сдвинулась между кадрами (два пальца двигаются вместе,
        // не только сближаются/расходятся) — это и есть двупальцевое перемещение карты, нужное в
        // batch-режимах, где один палец занят кистью выбора
        if (s.pinchMidX != null && s.pinchMidY != null) {
          s.ox += mid.x - s.pinchMidX;
          s.oy += mid.y - s.pinchMidY;
        }
        s.pinchDist = dist;
        s.pinchMidX = mid.x; s.pinchMidY = mid.y;
        clampPan();
        requestRedraw();
        return;
      }
      if (e.touches.length !== 1) return;
      e.preventDefault();
      const t0 = e.touches[0];
      if (s.dragging) {
        if (Math.abs(t0.clientX - downX) > 3 || Math.abs(t0.clientY - downY) > 3) moved = true;
        s.ox = t0.clientX - s.dx; s.oy = t0.clientY - s.dy;
        clampPan(); requestRedraw();
      } else if (s.selStart) {
        const rect = wrap.getBoundingClientRect();
        const t = screenToGrid(t0.clientX - rect.left, t0.clientY - rect.top);
        const moved2 = !s.selCur || t.col !== s.selCur.col || t.row !== s.selCur.row;
        if (moved2) {
          if (!s.selDragging && (t.col !== s.selStart.col || t.row !== s.selStart.row)) s.selDragging = true;
          s.selCur = t;
          if (s.selDragging) requestRedraw();
        }
      }
      // тот же бейдж-hover, что и у мыши — держишь палец на строящемся здании, видишь время до конца
      const rect = wrap.getBoundingClientRect();
      const t = screenToGrid(t0.clientX - rect.left, t0.clientY - rect.top);
      const inBounds = t.col >= 0 && t.col < s.cols && t.row >= 0 && t.row < s.rows;
      const gx = inBounds ? t.gx : null, gy = inBounds ? t.gy : null;
      if (s.badgeHoverGx !== gx || s.badgeHoverGy !== gy) { s.badgeHoverGx = gx; s.badgeHoverGy = gy; requestRedraw(); }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length > 0) { s.pinchDist = null; s.pinchMidX = null; s.pinchMidY = null; return; } // один из двух пальцев убрали — просто сбрасываем pinch
      s.pinchDist = null; s.pinchMidX = null; s.pinchMidY = null;
      s.dragging = false;
      if (s.selStart) {
        const t1 = s.selStart, t2 = s.selCur ?? s.selStart;
        const c1 = Math.min(t1.col, t2.col), c2 = Math.max(t1.col, t2.col);
        const r1 = Math.min(t1.row, t2.row), r2 = Math.max(t1.row, t2.row);
        const picks: { x: number; y: number }[] = [];
        for (let col = c1; col <= c2; col++) {
          for (let row = r1; row <= r2; row++) {
            const gx = s.x0 + col, gy = s.y0 + row;
            if (s.validSet.has(`${gx}_${gy}`)) picks.push({ x: gx, y: gy });
          }
        }
        for (const p of picks) onPick(p.x, p.y);
        s.selStart = null; s.selCur = null; s.selDragging = false;
      } else if (!moved && e.changedTouches.length) {
        const rect = wrap.getBoundingClientRect();
        const ct = e.changedTouches[0];
        const t = screenToGrid(ct.clientX - rect.left, ct.clientY - rect.top);
        const key = `${t.gx}_${t.gy}`;
        const sectionId = s.lockedCells.get(key);
        if (sectionId) onUnlockCell?.(sectionId);
        else if (s.mode !== 'view' && s.validSet.has(key)) onPick(t.gx, t.gy);
      }
      s.badgeHoverGx = null; s.badgeHoverGy = null;
      requestRedraw();
    };

    wrap.addEventListener('wheel', onWheel, { passive: false });
    wrap.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    wrap.addEventListener('mouseleave', onLeave);
    wrap.addEventListener('contextmenu', onCtxMenu);
    wrap.addEventListener('touchstart', onTouchStart, { passive: false });
    wrap.addEventListener('touchmove', onTouchMove, { passive: false });
    wrap.addEventListener('touchend', onTouchEnd, { passive: false });
    wrap.addEventListener('touchcancel', onTouchEnd, { passive: false });

    return () => {
      wrap.removeEventListener('wheel', onWheel);
      wrap.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      wrap.removeEventListener('mouseleave', onLeave);
      wrap.removeEventListener('contextmenu', onCtxMenu);
      wrap.removeEventListener('touchstart', onTouchStart);
      wrap.removeEventListener('touchmove', onTouchMove);
      wrap.removeEventListener('touchend', onTouchEnd);
      wrap.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [onPick, requestRedraw, onUnlockCell]);

  const cursor = mode !== 'view' ? 'crosshair' : 'grab';

  return (
    <div ref={wrapRef} style={{ flex: 1, position: 'relative', overflow: 'hidden', cursor, background: '#d8d8d8', border: '1px solid var(--border)', touchAction: 'none' }}>
      <canvas ref={canvasRef} style={{ display: 'block' }} />
    </div>
  );
}
