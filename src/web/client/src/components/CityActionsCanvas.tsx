import { useEffect, useRef, useCallback, useMemo } from 'react';
import type { MapBuilding, CityStrategyTarget, CityStrategyQueueItem, BuildingDef, GlobalUpgradeRule, MapSection } from '../api';
import cityCoordsData from '../data/city-coords.json';
import capitalCoordsData from '../data/capital-coords.json';
import cityRoadMapData from '../data/road-map.json';
import capitalRoadMapData from '../data/capital-road-map.json';
import { getPreparedSprite, pickMip, requestSprite, onSpritesReady } from './mapSprites';
import { startFpsCounter, type FpsCounter } from './fpsCounter';
import {
  type DayNightMode, type Phase, ensureNight, hourFor, stepOf, phaseAt, setPhase, shownPhase, nightBusy, onNightChange,
  wantGraded, gradedSprite, litMask, hasWindows, lampsOf, drawBuildingLights,
} from './mapNight';

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
const MIN_SCALE = 0.3, MAX_SCALE = 2;

// Отрисовка рассчитана на 60 кадров/с при быстром свайпе на любом устройстве: неподвижная часть
// карты (земля, дороги, здания, бейджи уровней) рисуется кусками CHUNK×CHUNK device-px, и каждый
// кусок — отдельный <canvas> в DOM внутри слоя-контейнера. Пан и зум двигают только CSS-transform
// контейнера: сдвиг готовых кусков делает композитор браузера на видеокарте, без перерисовки
// canvas и без работы главного потока. Поверх — прозрачный canvas «живого» слоя (прогресс стройки,
// подсветка, кисть), он перерисовывается, только когда на нём что-то есть.
// Куски рисуются в масштабе layerR (device-px на мировой px); пока идёт зум, контейнер просто
// масштабируется, а через ZOOM_SETTLE_MS после последнего шага зума куски перерисовываются в
// точном масштабе (до готовности под ними остаётся контейнер прежнего масштаба). Недостающие
// куски дорисовываются в пределах бюджета кадра (FRAME_BUDGET_MS), при свободном времени —
// заранее по кольцу вокруг экрана.
const CHUNK = 512;
const FRAME_BUDGET_MS = 6;
// время кусков на видеокарте JS-таймером не видно (отрисовка уходит в GPU асинхронно), поэтому
// бюджет ограничен ещё и числом кусков за кадр: видимых — до 3, заранее по кольцу — 1
const MAX_VISIBLE_CHUNKS_PER_FRAME = 3;
const MAX_RING_CHUNKS_PER_FRAME = 1;
const ZOOM_SETTLE_MS = 180;
// фон карты: куски непрозрачные (alpha:false) — композитору не нужно смешивать их с подложкой
const MAP_BG = '#d8d8d8';

function deviceDpr(): number {
  return Math.min(3, Math.max(1, window.devicePixelRatio || 1));
}

// Плотность пикселей всегда настоящая. Динамическое снижение разрешения при просадках убрано:
// пан и зум теперь делает композитор, а пониженная плотность заметно мылила карту.
function getDpr(): number {
  return deviceDpr();
}

// z — слой при ночной отрисовке куска (см. renderChunk): 0 — плоская земля (пустые клетки, дороги), 1 —
// здания, лес и фонари, 2 — бейджи поверх тонирования. Днём всё рисуется одним проходом по порядку списка
interface DrawItem { x0: number; y0: number; x1: number; y1: number; z?: 0 | 1 | 2; draw: (ctx: CanvasRenderingContext2D, r: number) => void }
// кусок — свой <canvas> в DOM-контейнере своего масштаба
interface Chunk { el: HTMLCanvasElement; ver: number }

// мягкие пятна света ночью: на земле под фонарём и плафон фонаря
const glows: Record<string, HTMLCanvasElement> = {};
function glowSprite(kind: 'ground' | 'bulb'): HTMLCanvasElement {
  let c = glows[kind];
  if (c) return c;
  const n = kind === 'ground' ? 64 : 32;
  c = document.createElement('canvas'); c.width = n; c.height = n;
  const x = c.getContext('2d')!, g = x.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  if (kind === 'ground') { g.addColorStop(0, 'rgba(255,190,110,1)'); g.addColorStop(1, 'rgba(255,170,90,0)'); }
  else { g.addColorStop(0, 'rgba(255,240,200,1)'); g.addColorStop(0.35, 'rgba(255,220,150,.8)'); g.addColorStop(1, 'rgba(255,200,120,0)'); }
  x.fillStyle = g; x.fillRect(0, 0, n, n);
  glows[kind] = c;
  return c;
}

function releaseChunk(ch: Chunk) {
  ch.el.remove();
  ch.el.width = 0; ch.el.height = 0;
}

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
  // "x_y" — клетки, которые нужно выделить поверх затемнения (наведение на строку «Плана»). Неподвижный
  // слой при этом не перерисовывается: сверху плавно проявляется полупрозрачная пелена цвета фона,
  // а выделенные клетки дорисовываются над ней на отдельном canvas — без мигания кусков карты
  focusSet?: Set<string> | null;
  // смена суток (только город — у столицы ночной разметки нет): по часам устройства, всегда день или
  // всегда ночь. По умолчанию — день, карта рисуется как раньше
  dayNight?: DayNightMode;
}

// сколько карта ждёт ночной набор спрайтов, прежде чем рисовать без него
const NIGHT_HOLD_MAX_MS = 4000;
// как часто сверяться с часами: свет в окнах и ступень суток
const NIGHT_TICK_MS = 20000;

export function CityActionsCanvas({ buildings, type, mapKey, mode, validSet, pickedSet, targets, queue, globalPlan, catalog, onPick, sections, unlockedSections, onUnlockCell, focusSet, dayNight = 'day' }: Props) {
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
  const layersRef = useRef<HTMLDivElement>(null);
  const fpsRef = useRef<HTMLCanvasElement>(null);
  const focusWrapRef = useRef<HTMLDivElement>(null);
  const focusCanvasRef = useRef<HTMLCanvasElement>(null);
  const focusVeilRef = useRef<HTMLDivElement>(null);
  const fpsCtl = useRef<FpsCounter | null>(null);
  // какую карту (тип+ключ) уже центрировали — сбрасывается только при реальном переключении карты,
  // не при каждом обновлении данных той же карты (см. Props.mapKey)
  const centeredForRef = useRef<string | null>(null);

  const state = useRef({
    spriteMap: (spriteMapCache || {}) as Record<string, { pngUrl: string; frame: { x: number; y: number; w: number; h: number } }>,
    dpr: 1,
    // слой неподвижной карты: draw-list в порядке художника, версия содержимого (любая смена зданий/
    // режима/спрайтов увеличивает ver — куски старой версии ещё рисуются, пока не перерисованы),
    // кэш кусков (Map в порядке последнего использования — LRU) и пул освободившихся canvas
    drawList: [] as DrawItem[],
    listDirty: true,
    world: { x0: 0, y0: 0, x1: 0, y1: 0 },
    ver: 1,
    nextEndMs: Infinity,
    layerR: 0,
    chunks: new Map<string, Chunk>(),
    // контейнеры кусков по масштабу: текущий (layerR) и, пока он не дорисован, прежний
    layers: new Map<number, HTMLDivElement>(),
    // на живом слое сейчас что-то нарисовано — его нужно перерисовать (или очистить) при сдвиге
    overlayUsed: false,
    zoomTimer: null as ReturnType<typeof setTimeout> | null,
    // подписи бейджей — пересчёт только при смене зданий/целей/очереди/плана
    labels: new Map<string, string | null>(),
    labelsDirty: true,
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
    // выделение поверх пелены: пока пелена гаснет, рисуется последнее непустое выделение
    focusShown: null as Set<string> | null,
    // смена суток: nightOn — режим не «всегда день» и это город; ph — ступень, под которую перекрашены
    // спрайты (null — день, карта рисуется как раньше); lit — горящие группы квартир по клеткам;
    // itemBox — мировой bbox здания (какие куски перерисовать, когда в нём зажглось или погасло окно);
    // dirty — такие куски, они перерисовываются, только пока карту не тянут; lampGlows — пятна света
    // фонарей на земле; nightHold — карта ждёт ночной набор и пока не рисует новые куски
    nightOn: false,
    dayNight: 'day' as DayNightMode,
    ph: null as Phase | null,
    lit: new Map<string, number>(),
    itemBox: new Map<string, { x0: number; y0: number; x1: number; y1: number }>(),
    dirty: new Set<string>(),
    lampGlows: [] as { x: number; y: number }[],
    roadCells: [] as { x: number; y: number }[],
    nightHold: false,
    nightHoldTimer: null as ReturnType<typeof setTimeout> | null,
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
    fpsCtl.current?.request();
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
    s.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(W / totalW, H / totalH) * 0.88));
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

  // ширина спрайта под максимальный зум этого экрана: на MAX_SCALE пиксель спрайта = пиксель экрана
  function spriteTargetW(drawW: number): number {
    return Math.ceil(drawW * MAX_SCALE * deviceDpr());
  }

  // рисует подготовленный спрайт (см. mapSprites.ts); false — ещё не готов, нужна заглушка
  function drawSprite(ctx: CanvasRenderingContext2D, id: string, drawW: number, r: number, dx: number, dy: number, dw: number, dh: number): boolean {
    const s = state.current;
    const info = s.spriteMap[id];
    if (!info) return false;
    const tw = spriteTargetW(drawW);
    if (s.ph) {
      // ночью — только перекрашенный под ступень суток; пока его нет, заглушка, как у неготового спрайта
      const g = gradedSprite(id, tw);
      if (!g) { wantGraded(id, tw); if (!getPreparedSprite(id, tw)) requestSprite(id, info, tw); return false; }
      ctx.drawImage(pickMip(g, dw * r), dx, dy, dw, dh);
      return true;
    }
    const sp = getPreparedSprite(id, tw);
    if (!sp) { requestSprite(id, info, tw); return false; }
    ctx.drawImage(pickMip(sp, dw * r), dx, dy, dw, dh);
    return true;
  }

  // draw-list неподвижного слоя: те же три вида клеток и тот же порядок художника (по диагоналям),
  // что раньше рисовались прямо в кадре. У каждого элемента — мировой bbox, по нему кусок берёт
  // только пересекающиеся с ним клетки.
  function buildDrawList() {
    const s = state.current;
    const items: DrawItem[] = [];
    const want: [string, number][] = [];
    const nowMs = Date.now();
    let nextEnd = Infinity;
    s.itemBox = new Map();
    s.lampGlows = [];
    s.roadCells = [];
    // клетки под большими деревьями леса (2×2) — фонарей там нет
    const underForest = new Set<string>();
    if (s.nightOn) for (const [k, v] of Object.entries(s.roadMap)) {
      if (!v.big) continue;
      const i = k.indexOf('_'), x = +k.slice(0, i), y = +k.slice(i + 1);
      for (const [ax, ay] of [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 0], [0, -1]]) underForest.add(`${x + ax}_${y + ay}`);
    }
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
          items.push({ x0: sx, y0: sy, x1: sx + TW, y1: sy + TH, z: 0, draw: ctx => drawTile(ctx, sx, sy, 'rgba(8,8,12,.62)', 'rgba(255,255,255,.15)', '🔒') });
        } else if (b) {
          const cat = buildingCat(b.id);
          const cc = MAP_CAT_COLORS[cat] || { fill: 'rgba(100,100,100,.3)', stroke: 'rgba(150,150,150,.6)' };
          // здание в процессе стройки/улучшения — игра подменяет тайл на один из общих спрайтов
          // стройки (не рисует своё готовое здание), см. constructionSpriteId — сверено с бандлом
          const endMs = b.end ? new Date(b.end).getTime() : 0;
          const underConstruction = endMs > nowMs;
          if (underConstruction && endMs < nextEnd) nextEnd = endMs;
          const spriteId = underConstruction ? constructionSpriteId(b.id, s.type) : b.id;
          const sp = s.spriteMap[spriteId];
          // в режимах "Реконструкция"/"Реновация"/"Улучшение"/"План" прячем (сильно затемняем) здания,
          // к которым действие неприменимо — так на карте видны только реально подходящие кандидаты,
          // не нужно самому вычислять required_lvl/is_reconstructible/занятость стройкой на глаз
          const hideAsInapplicable = DIM_INAPPLICABLE_MODES.has(s.mode) && !s.validSet.has(`${gx}_${gy}`);
          const RS = 1.025, dw = TW * RS;
          const dh = sp ? sp.frame.h * TW / 753 * RS : TH;
          const dx = sx - (dw - TW) / 2, dy = sy + TH - dh;
          want.push([spriteId, dw]);
          const key = `${gx}_${gy}`;
          const box = { x0: Math.min(sx, dx), y0: Math.min(sy, dy), x1: Math.max(sx + TW, dx + dw), y1: sy + TH };
          if (!underConstruction) s.itemBox.set(key, box);
          items.push({ ...box, draw: (ctx, r) => {
            if (hideAsInapplicable) ctx.globalAlpha = 0.12;
            const ok = drawSprite(ctx, spriteId, dw, r, dx, dy, dw, dh);
            if (!ok) drawTile(ctx, sx, sy, cc.fill, cc.stroke, buildingLabel(b.id));
            if (hideAsInapplicable) ctx.globalAlpha = 1;
            // ночью — горящие окна и подсветка поверх перекрашенного спрайта
            else if (ok && s.ph && !underConstruction) drawBuildingLights(ctx, s.ph, spriteId, s.lit.get(key) ?? 0, spriteTargetW(dw), r, dx, dy, dw, dh);
          } });
        } else if (valid) {
          const empSp = s.spriteMap['empty.png'];
          const RS = 1.025, dw = TW * RS;
          const dh0 = empSp ? empSp.frame.h * TW / 753 : TH, dh = dh0 * RS;
          const dx = sx - (dw - TW) / 2, dy = sy + TH - dh + (dh - dh0) / 2;
          want.push(['empty.png', dw]);
          items.push({ x0: Math.min(sx, dx), y0: Math.min(sy, dy), x1: Math.max(sx + TW, dx + dw), y1: Math.max(sy + TH, dy + dh), z: 0, draw: (ctx, r) => {
            if (!drawSprite(ctx, 'empty.png', dw, r, dx, dy, dw, dh)) drawTile(ctx, sx, sy, 'rgba(255,255,255,.06)', 'rgba(255,255,255,.18)');
          } });
        } else {
          const env = s.roadMap[`${gx}_${gy}`] || null;
          const envSp = env ? s.spriteMap[env.asset] : null;
          if (env && envSp) {
            const f = envSp.frame;
            if (env.big) {
              const dw = Math.round(TW * 2), dh = Math.round(f.h * TW / 753 * 2);
              const dx = Math.round(sx), dy = Math.round(sy + 3 * TH / 2 - dh);
              want.push([env.asset, dw]);
              items.push({ x0: dx, y0: dy, x1: dx + dw, y1: dy + dh, draw: (ctx, r) => { drawSprite(ctx, env.asset, dw, r, dx, dy, dw, dh); } });
            } else {
              const RS = 1.05, dh0 = f.h * TW / 753;
              const dw = TW * RS, dh = dh0 * RS;
              const dx = sx - (dw - TW) / 2, dy = sy + TH - dh + (dh - dh0) / 2;
              want.push([env.asset, dw]);
              items.push({ x0: dx, y0: dy, x1: dx + dw, y1: dy + dh, z: 0, draw: (ctx, r) => { drawSprite(ctx, env.asset, dw, r, dx, dy, dw, dh); } });
              // клетка дороги — свет фонарей ложится только на такие клетки (асфальт и тротуары)
              if (s.nightOn) s.roadCells.push({ x: sx, y: sy });
              // фонари на тротуарах вдоль бордюра
              if (s.nightOn && !underForest.has(`${gx}_${gy}`)) lampsOf(env.asset).forEach(([lx, ly]) => {
                const x = dx + lx * dw, y = dy + ly * dh;
                s.lampGlows.push({ x, y });
                items.push({ x0: x - TW * 0.5, y0: y - TH * 1.2, x1: x + TW * 0.5, y1: y + TH * 0.6, draw: ctx => drawLampPost(ctx, x, y) });
              });
            }
          }
        }
      }
    }
    // бейджи уровней — тоже неподвижный слой, поверх всех зданий (после них в порядке художника).
    // Бейдж стройки с живым прогрессом рисуется в живом слое, см. redraw
    const fsz = Math.max(8, Math.round(TW * 0.13));
    const mctx = probeCtx();
    mctx.font = `bold ${fsz}px sans-serif`;
    for (const b of s.blist) {
      const col = b.x - s.x0, row = b.y - s.y0;
      if (col < 0 || col >= s.cols || row < 0 || row >= s.rows) continue;
      if (DIM_INAPPLICABLE_MODES.has(s.mode) && !s.validSet.has(`${b.x}_${b.y}`)) continue;
      const endMs = b.end ? new Date(b.end).getTime() : 0;
      if (endMs > nowMs) continue;
      const label = s.labels.get(`${b.x}_${b.y}`);
      if (!label) continue;
      const { x: sx, y: sy } = isoToScreen(col, row);
      const bx = sx + TW / 2, by = sy + TH / 2;
      const hw = Math.max(mctx.measureText(label).width + 8, fsz + 6) / 2 + 8, hh = (fsz + 5) / 2 + 8; // +8 — тень
      items.push({ x0: bx - hw, y0: by - hh, x1: bx + hw, y1: by + hh, z: 2, draw: ctx => drawLevelBadge(ctx, bx, by, label, fsz) });
    }

    const w = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const it of items) {
      if (it.x0 < w.x0) w.x0 = it.x0; if (it.y0 < w.y0) w.y0 = it.y0;
      if (it.x1 > w.x1) w.x1 = it.x1; if (it.y1 > w.y1) w.y1 = it.y1;
    }
    if (!items.length) { w.x0 = w.y0 = 0; w.x1 = w.y1 = 1; }
    s.drawList = items;
    s.world = w;
    s.nextEndMs = nextEnd;
    s.listDirty = false;
    // сразу ставим в очередь подготовку всех спрайтов карты, не дожидаясь, пока до них доскроллят
    for (const [id, drawW] of want) {
      const info = s.spriteMap[id];
      if (!info) continue;
      requestSprite(id, info, spriteTargetW(drawW));
      if (s.nightOn) wantGraded(id, spriteTargetW(drawW));
    }
  }

  // ── смена суток ──
  // столб и плафон фонаря (днём фонарей на карте нет)
  function drawLampPost(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const ph = state.current.ph;
    if (!ph) return;
    // невысокий тонкий столб и маленький тусклый плафон — не спорят со светом окон
    const hp = TH * 0.4, b = TW * 0.075;
    ctx.strokeStyle = `rgba(${Math.round(70 * ph.S[0] / 255)},${Math.round(74 * ph.S[1] / 255)},${Math.round(84 * ph.S[2] / 255)},.55)`;
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - hp); ctx.stroke();
    if (ph.lamps > 0.01) {
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.6 * ph.lamps;
      ctx.drawImage(glowSprite('bulb'), x - b / 2, y - hp - b / 2, b, b);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    }
  }

  // ночной проход куска: земля, пятна света фонарей, здания с окнами, тонирование стороны солнца и
  // дымки у горизонта, бейджи поверх
  function paintNight(ctx: CanvasRenderingContext2D, r: number, ph: Phase, wx0: number, wy0: number, wx1: number, wy1: number) {
    const s = state.current;
    const hit = (it: { x0: number; y0: number; x1: number; y1: number }) => !(it.x1 < wx0 || it.x0 > wx1 || it.y1 < wy0 || it.y0 > wy1);
    for (const it of s.drawList) if (it.z === 0 && hit(it)) it.draw(ctx, r);
    if (ph.lamps > 0.01 && s.lampGlows.length) {
      // пятна света — только на клетках дорог: свет не заливает пустые участки и подножия зданий
      ctx.save();
      ctx.beginPath();
      for (const c of s.roadCells) {
        if (c.x + TW < wx0 || c.x > wx1 || c.y + TH < wy0 || c.y > wy1) continue;
        ctx.moveTo(c.x + TW / 2, c.y); ctx.lineTo(c.x + TW, c.y + TH / 2); ctx.lineTo(c.x + TW / 2, c.y + TH); ctx.lineTo(c.x, c.y + TH / 2); ctx.closePath();
      }
      ctx.clip();
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.4 * ph.lamps;
      const gw = TW * 0.9, gh = gw * 0.58, g = glowSprite('ground');
      for (const l of s.lampGlows) {
        if (l.x + gw / 2 < wx0 || l.x - gw / 2 > wx1 || l.y + gh / 2 < wy0 || l.y - gh / 2 > wy1) continue;
        ctx.drawImage(g, l.x - gw / 2, l.y - gh / 2, gw, gh);
      }
      ctx.restore();
    }
    for (const it of s.drawList) if ((it.z ?? 1) === 1 && hit(it)) it.draw(ctx, r);
    const w = s.world;
    // сторона солнца: освещённый край карты теплее и светлее, противоположный холоднее
    if (ph.sunA > 0.02) {
      const g = ctx.createLinearGradient(w.x0, w.y0, w.x1, w.y0 + (w.x1 - w.x0) * 0.3), a = ph.sunA;
      const warm = ph.sun > 0 ? `rgba(255,190,150,${a})` : `rgba(255,150,60,${a})`, cool = `rgba(60,70,170,${a * 0.75})`;
      g.addColorStop(0, ph.sun < 0 ? warm : cool); g.addColorStop(1, ph.sun < 0 ? cool : warm);
      ctx.globalCompositeOperation = 'soft-light'; ctx.fillStyle = g; ctx.fillRect(wx0, wy0, wx1 - wx0, wy1 - wy0);
      ctx.globalCompositeOperation = 'source-over';
    }
    // дымка у горизонта (верх карты дальше от зрителя): утром гуще
    if (ph.mist > 0.02) {
      const g = ctx.createLinearGradient(0, w.y0, 0, w.y0 + (w.y1 - w.y0) * 0.75);
      const c = ph.sun > 0 ? '255,226,222' : '255,180,150';
      g.addColorStop(0, `rgba(${c},${0.42 * ph.mist})`); g.addColorStop(1, `rgba(${c},0)`);
      ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = g; ctx.fillRect(wx0, wy0, wx1 - wx0, wy1 - wy0);
      ctx.globalCompositeOperation = 'source-over';
    }
    for (const it of s.drawList) if (it.z === 2 && hit(it)) it.draw(ctx, r);
  }

  // какие группы квартир горят в час hour; markDirty — пометить куски зданий, где что-то поменялось
  function updateLit(hour: number, markDirty: boolean): boolean {
    const s = state.current;
    const cw = CHUNK / (s.layerR || 1);
    let changed = false;
    for (const b of s.blist) {
      const key = `${b.x}_${b.y}`, box = s.itemBox.get(key);
      if (!box || !hasWindows(b.id)) continue;
      const m = litMask(key, hour);
      if (s.lit.get(key) === m) continue;
      s.lit.set(key, m);
      changed = true;
      if (!markDirty || !s.layerR || !s.ph) continue;
      for (let cy = Math.floor(box.y0 / cw); cy <= Math.floor(box.y1 / cw); cy++)
        for (let cx = Math.floor(box.x0 / cw); cx <= Math.floor(box.x1 / cw); cx++) s.dirty.add(`${s.layerR}:${cx}:${cy}`);
    }
    return changed;
  }

  // сверка с часами: ступень суток (перекраска спрайтов идёт в фоне) и свет в окнах
  function nightTick() {
    const s = state.current;
    if (!s.nightOn) return;
    const hour = hourFor(s.dayNight), ph = phaseAt(stepOf(hour));
    setPhase(ph);
    // ночной набор ещё не готов — новые куски не рисуем (на экране остаются прежние), пока не будет
    if (!ph.isDay && !s.ph && nightBusy() && !s.nightHold) {
      s.nightHold = true;
      if (s.nightHoldTimer) clearTimeout(s.nightHoldTimer);
      s.nightHoldTimer = setTimeout(() => { s.nightHoldTimer = null; s.nightHold = false; requestRedraw(); }, NIGHT_HOLD_MAX_MS);
    }
    if (updateLit(hour, true)) requestRedraw();
  }

  function applyGround() {
    const bg = state.current.ph?.ground ?? MAP_BG;
    if (wrapRef.current) wrapRef.current.style.background = bg;
    if (focusVeilRef.current) focusVeilRef.current.style.background = bg;
  }

  // служебный контекст 1×1 — только для measureText при сборке картинок бейджей
  let probe: CanvasRenderingContext2D | null = null;
  function probeCtx(): CanvasRenderingContext2D {
    if (!probe) { const c = document.createElement('canvas'); c.width = 1; c.height = 1; probe = c.getContext('2d')!; }
    return probe;
  }

  function invalidateLayer() {
    state.current.ver++;
    requestRedraw();
  }

  // контейнер кусков масштаба r: кусок (cx,cy) стоит в нём на (cx,cy)·CHUNK/dpr css-px, а сам
  // контейнер сдвигается и масштабируется CSS-transform'ом
  function layerFor(r: number): HTMLDivElement {
    const s = state.current;
    let el = s.layers.get(r);
    if (!el) {
      el = document.createElement('div');
      el.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform;pointer-events:none';
      const host = layersRef.current!;
      // текущий масштаб всегда сверху: новые контейнеры добавляются в конец
      host.appendChild(el);
      s.layers.set(r, el);
    }
    return el;
  }

  function dropLayer(r: number) {
    const s = state.current;
    for (const [k, ch] of s.chunks) if (k.startsWith(`${r}:`)) { releaseChunk(ch); s.chunks.delete(k); }
    s.layers.get(r)?.remove();
    s.layers.delete(r);
  }

  function renderChunk(r: number, cx: number, cy: number, reuse?: Chunk): Chunk {
    const s = state.current;
    let el = reuse?.el;
    if (!el) {
      el = document.createElement('canvas');
      el.width = CHUNK; el.height = CHUNK;
      const css = CHUNK / s.dpr;
      el.style.cssText = `position:absolute;display:block;left:${cx * css}px;top:${cy * css}px;width:${css}px;height:${css}px`;
      layerFor(r).appendChild(el);
    }
    const ctx = el.getContext('2d', { alpha: false })!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = s.ph ? s.ph.ground : MAP_BG;
    ctx.fillRect(0, 0, CHUNK, CHUNK);
    // 'low' = обычная билинейная выборка: нужный mip-уровень уже выбран (сжатие не больше 2:1), а
    // 'high' заставляет GPU строить свои mip-цепочки для каждого спрайта при каждой отрисовке куска
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'low';
    const cw = CHUNK / r;
    // запас 2 мировых px: обводка тайла и сглаживание краёв спрайта выходят за bbox на полпикселя
    const wx0 = cx * cw - 2, wy0 = cy * cw - 2, wx1 = (cx + 1) * cw + 2, wy1 = (cy + 1) * cw + 2;
    ctx.setTransform(r, 0, 0, r, -cx * CHUNK, -cy * CHUNK);
    s.dirty.delete(`${r}:${cx}:${cy}`);
    if (s.ph) { paintNight(ctx, r, s.ph, wx0, wy0, wx1, wy1); return { el, ver: s.ver }; }
    for (const it of s.drawList) {
      if (it.x1 < wx0 || it.x0 > wx1 || it.y1 < wy0 || it.y0 > wy1) continue;
      it.draw(ctx, r);
    }
    return { el, ver: s.ver };
  }

  function evictChunks(limit: number) {
    const s = state.current;
    while (s.chunks.size > limit) {
      const [k, ch] = s.chunks.entries().next().value as [string, Chunk];
      s.chunks.delete(k);
      releaseChunk(ch);
    }
  }

  // неподвижный слой: ставит transform контейнерам и дорисовывает недостающие куски в бюджете кадра.
  // true — остались недорисованные куски, нужен ещё кадр
  function syncLayer(W: number, H: number): boolean {
    const s = state.current;
    const desired = s.scale * s.dpr;
    const t0 = performance.now();
    const r = s.layerR;
    // контейнер текущего масштаба создаётся ДО расстановки transform: иначе новый контейнер после
    // зума живёт кадр без transform и его куски мелькают не на своём месте
    layerFor(r);
    // контейнеры: translate(ox,oy) scale(desired/r) — до 1:1 к экрану, когда r === desired
    for (const [lr, el] of s.layers) {
      // сдвиг — в целых пикселях экрана: дробный заставил бы композитор пересэмплировать куски (мыло)
      const tf = `translate(${Math.round(s.ox * s.dpr) / s.dpr}px,${Math.round(s.oy * s.dpr) / s.dpr}px) scale(${desired / lr})`;
      if (el.dataset.tf !== tf) { el.dataset.tf = tf; el.style.transform = tf; }
    }
    // ночной набор спрайтов ещё готовится — на экране остаются прежние куски
    if (s.nightHold) return false;
    // куски, где зажглись или погасли окна, перерисовываются, только пока карту не тянут и не зумят:
    // на это время они копятся
    const allowDirty = !s.dragging && s.pinchDist == null && !s.zoomTimer;
    const isDirty = (key: string) => allowDirty && s.dirty.size > 0 && s.dirty.has(key);
    // видимая область в мировых координатах, обрезанная по содержимому карты
    const vx0 = Math.max(-s.ox / s.scale, s.world.x0), vy0 = Math.max(-s.oy / s.scale, s.world.y0);
    const vx1 = Math.min((W - s.ox) / s.scale, s.world.x1), vy1 = Math.min((H - s.oy) / s.scale, s.world.y1);
    if (vx1 <= vx0 || vy1 <= vy0) return false;
    const cw = CHUNK / r;
    const range = (ring: number) => ({
      cx0: Math.floor(vx0 / cw) - ring, cx1: Math.floor(vx1 / cw) + ring,
      cy0: Math.floor(vy0 / cw) - ring, cy1: Math.floor(vy1 / cw) + ring,
    });

    const vr = range(0);
    const need: { cx: number; cy: number; d: number }[] = [];
    let anyMissing = false;
    const ccx = (vr.cx0 + vr.cx1) / 2, ccy = (vr.cy0 + vr.cy1) / 2;
    for (let cy = vr.cy0; cy <= vr.cy1; cy++) for (let cx = vr.cx0; cx <= vr.cx1; cx++) {
      const key = `${r}:${cx}:${cy}`;
      const ch = s.chunks.get(key);
      if (!ch) anyMissing = true;
      else { s.chunks.delete(key); s.chunks.set(key, ch); } // отметка использования для LRU
      if (!ch || ch.ver !== s.ver || isDirty(key)) need.push({ cx, cy, d: Math.hypot(cx - ccx, cy - ccy) });
    }
    // недостающие и устаревшие видимые куски — от центра экрана, в пределах бюджета кадра
    need.sort((a, b) => a.d - b.d);
    let done = 0;
    for (const n of need) {
      if (done > 0 && (performance.now() - t0 > FRAME_BUDGET_MS || done >= MAX_VISIBLE_CHUNKS_PER_FRAME)) break;
      const key = `${r}:${n.cx}:${n.cy}`;
      const old = s.chunks.get(key);
      s.chunks.delete(key); s.chunks.set(key, renderChunk(r, n.cx, n.cy, old));
      done++;
    }
    let pending = done < need.length;
    // все видимые куски текущего масштаба есть — контейнеры прежних масштабов больше не нужны
    if (!anyMissing || !pending) {
      for (const lr of [...s.layers.keys()]) if (lr !== r) dropLayer(lr);
    }
    // время осталось — заранее готовим кольцо кусков вокруг экрана, чтобы быстрый свайп не упирался
    // в отрисовку
    if (!pending) {
      let ringLeft = MAX_RING_CHUNKS_PER_FRAME;
      const rr = range(1);
      outer: for (let cy = rr.cy0; cy <= rr.cy1; cy++) for (let cx = rr.cx0; cx <= rr.cx1; cx++) {
        if ((cx + 1) * cw < s.world.x0 || cx * cw > s.world.x1 || (cy + 1) * cw < s.world.y0 || cy * cw > s.world.y1) continue;
        const key = `${r}:${cx}:${cy}`;
        const old = s.chunks.get(key);
        if (old && old.ver === s.ver && !isDirty(key)) continue;
        if (ringLeft <= 0 || performance.now() - t0 > FRAME_BUDGET_MS) { pending = true; break outer; }
        s.chunks.delete(key); s.chunks.set(key, renderChunk(r, cx, cy, old));
        ringLeft--;
      }
    }
    const visible = (vr.cx1 - vr.cx0 + 1) * (vr.cy1 - vr.cy0 + 1);
    evictChunks(Math.max(24, visible * 3));
    // отложенные из-за пана окна: когда отпустят, их нужно дорисовать — без этого кадр не запросится
    if (!allowDirty && s.dirty.size) {
      for (let cy = vr.cy0; cy <= vr.cy1; cy++) for (let cx = vr.cx0; cx <= vr.cx1; cx++) if (s.dirty.has(`${r}:${cx}:${cy}`)) return true;
    }
    return pending;
  }

  // подписи бейджей для всех зданий — badgeFor раньше считался на каждое здание в каждом кадре
  function rebuildLabels() {
    const s = state.current;
    s.labels = new Map();
    for (const b of s.blist) s.labels.set(`${b.x}_${b.y}`, badgeFor(b));
    s.labelsDirty = false;
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

  // выделенные клетки поверх пелены: спрайт и бейдж — те же, что в неподвижном слое, в порядке художника
  function drawFocus(W: number, H: number, dpr: number, k: number) {
    const s = state.current, fc = focusCanvasRef.current;
    if (!fc || !s.focusShown) return;
    const Wd = Math.round(W * dpr), Hd = Math.round(H * dpr);
    if (fc.width !== Wd || fc.height !== Hd) { fc.width = Wd; fc.height = Hd; fc.style.width = `${W}px`; fc.style.height = `${H}px`; }
    const ctx = fc.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, Wd, Hd);
    ctx.setTransform(k, 0, 0, k, s.ox * dpr, s.oy * dpr);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'low';
    const nowMs = Date.now(), fsz = Math.max(8, Math.round(TW * 0.13));
    const list = [...s.focusShown].map(key => s.bmap[key]).filter((b): b is MapBuilding => !!b)
      .map(b => ({ b, col: b.x - s.x0, row: b.y - s.y0 }))
      .filter(t => t.col >= 0 && t.col < s.cols && t.row >= 0 && t.row < s.rows)
      .sort((a, b) => (a.col + a.row) - (b.col + b.row) || a.col - b.col);
    for (const { b, col, row } of list) {
      const { x: sx, y: sy } = isoToScreen(col, row);
      const endMs = b.end ? new Date(b.end).getTime() : 0;
      const spriteId = endMs > nowMs ? constructionSpriteId(b.id, s.type) : b.id;
      const sp = s.spriteMap[spriteId];
      const RS = 1.025, dw = TW * RS, dh = sp ? sp.frame.h * TW / 753 * RS : TH;
      if (!drawSprite(ctx, spriteId, dw, k, sx - (dw - TW) / 2, sy + TH - dh, dw, dh)) {
        const cc = MAP_CAT_COLORS[buildingCat(b.id)] || { fill: 'rgba(100,100,100,.3)', stroke: 'rgba(150,150,150,.6)' };
        drawTile(ctx, sx, sy, cc.fill, cc.stroke, buildingLabel(b.id));
      }
    }
    for (const { b, col, row } of list) {
      const label = s.labels.get(`${b.x}_${b.y}`);
      if (!label) continue;
      const { x: sx, y: sy } = isoToScreen(col, row);
      const bx = sx + TW / 2, by = sy + TH / 2;
      const endMs = b.end ? new Date(b.end).getTime() : 0;
      if (endMs > nowMs) {
        const durationMs = b.start ? endMs - new Date(b.start).getTime() : upgradeDurationSec(s.catalog.find(c => c.id === b.id)?.construction_increment || 0, b.level || 1) * 1000;
        const progress = durationMs > 0 ? Math.min(1, Math.max(0, 1 - (endMs - nowMs) / durationMs)) : 0;
        drawProgressBadge(ctx, bx, by, label, fsz, progress, fmtTimeLeft(endMs - nowMs), false);
      } else drawLevelBadge(ctx, bx, by, label, fsz);
    }
  }

  function redraw() {
    const wrap = wrapRef.current, canvas = canvasRef.current;
    if (!wrap || !canvas || !layersRef.current) return;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    if (!W || !H) return;
    const s = state.current;
    // куски и живой слой — в физических пикселях экрана (с поправкой на ступень разрешения)
    const dpr = getDpr();
    if (dpr !== s.dpr) {
      s.dpr = dpr; s.listDirty = true; s.ver++;
      for (const lr of [...s.layers.keys()]) dropLayer(lr);
      s.layerR = 0;
    }
    const Wd = Math.round(W * dpr), Hd = Math.round(H * dpr);
    if (canvas.width !== Wd || canvas.height !== Hd) {
      canvas.width = Wd; canvas.height = Hd;
      canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
      s.needsCenter = true; s.overlayUsed = true;
    }
    if (s.needsCenter && W > 0 && H > 0) { centerOnBuildings(); s.needsCenter = false; }
    if (!s.cols || !s.rows) return;
    fpsCtl.current?.frame();

    // стройка закончилась по времени — здание снова рисуется своим спрайтом и обычным бейджем
    if (Date.now() >= s.nextEndMs) { s.listDirty = true; s.ver++; }
    if (s.labelsDirty) { rebuildLabels(); s.listDirty = true; s.ver++; }
    if (s.listDirty) buildDrawList();

    // масштаб кусков: сразу точный при первом кадре и при большом скачке зума, иначе — после паузы
    const desired = s.scale * dpr;
    if (!s.layerR) s.layerR = desired;
    else if (s.layerR !== desired) {
      const k = desired / s.layerR;
      if (k < 0.5 || k > 1.6) s.layerR = desired;
      if (s.zoomTimer) clearTimeout(s.zoomTimer);
      s.zoomTimer = setTimeout(() => {
        s.zoomTimer = null;
        const want = s.scale * s.dpr;
        if (s.layerR !== want) { s.layerR = want; requestRedraw(); }
      }, ZOOM_SETTLE_MS);
    }

    // проход 1 — неподвижный слой: только transform контейнеров и недостающие куски
    const layerPending = syncLayer(W, H);
    drawFocus(W, H, dpr, desired);

    // живой слой: прогресс стройки, выбранные клетки, кисть, наведение. Пусто сейчас и было пусто —
    // canvas не трогаем вовсе
    const nowMs = Date.now();
    const building = s.blist.some(b => b.end && new Date(b.end).getTime() > nowMs && s.labels.get(`${b.x}_${b.y}`) != null);
    const overlayNeeded = building || s.pickedSet.size > 0 || (s.selDragging && !!s.selCur) || (!!s.hoverTile && s.mode !== 'view');
    if (!overlayNeeded && !s.overlayUsed) {
      if (s.liveTimer) { clearTimeout(s.liveTimer); s.liveTimer = null; }
      if (layerPending) requestRedraw();
      return;
    }
    s.overlayUsed = overlayNeeded;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, Wd, Hd);

    ctx.save();
    ctx.setTransform(desired, 0, 0, desired, s.ox * dpr, s.oy * dpr);
    // видимая область в мировых координатах — бейджи за экраном не рисуем
    const vx0 = -s.ox / s.scale - TW, vy0 = -s.oy / s.scale - TH;
    const vx1 = (W - s.ox) / s.scale + TW, vy1 = (H - s.oy) / s.scale + TH;

    // проход 2 — живой прогресс-бар стройки для зданий, у которых b.end ещё в будущем (обычные
    // бейджи уровней — в неподвижном слое, см. buildDrawList)
    const fsz = Math.max(8, Math.round(TW * 0.13));
    let anyUnderConstruction = false;
    for (const b of s.blist) {
      const col = b.x - s.x0, row = b.y - s.y0;
      if (col < 0 || col >= s.cols || row < 0 || row >= s.rows) continue;
      // не рисуем бейдж уровня поверх здания, спрятанного как неприменимое к текущему действию
      if (DIM_INAPPLICABLE_MODES.has(s.mode) && !s.validSet.has(`${b.x}_${b.y}`)) continue;
      const { x: sx, y: sy } = isoToScreen(col, row);
      const bx = sx + TW / 2, by = sy + TH / 2;
      const endMs = b.end ? new Date(b.end).getTime() : 0;
      if (endMs > nowMs && s.labels.get(`${b.x}_${b.y}`) != null) anyUnderConstruction = true;
      if (bx < vx0 || bx > vx1 || by < vy0 || by > vy1) continue;
      if (endMs > nowMs) {
        const label = s.labels.get(`${b.x}_${b.y}`) ?? null;
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
      fpsCtl.current?.request();
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

      fpsCtl.current?.request();
      s.rafId = requestAnimationFrame(() => { s.rafId = null; if (s.hoverTile) redraw(); });
    }

    ctx.restore();

    // живой тик прогресс-бара стройки — раз в секунду достаточно (не 60кадр/с, тексту минут не нужно)
    if (s.liveTimer) { clearTimeout(s.liveTimer); s.liveTimer = null; }
    if (anyUnderConstruction) s.liveTimer = setTimeout(() => { s.liveTimer = null; redraw(); }, 1000);
    // куски, не успевшие в бюджет кадра, дорисовываются в следующих кадрах
    if (layerPending) requestRedraw();
  }

  useEffect(() => {
    const s = state.current;
    // готовые спрайты — перерисовать куски (старые остаются на экране, пока не перерисованы)
    const off = onSpritesReady(() => invalidateLayer());
    return () => {
      off();
      if (s.liveTimer) clearTimeout(s.liveTimer);
      if (s.rafId) cancelAnimationFrame(s.rafId);
      if (s.zoomTimer) clearTimeout(s.zoomTimer);
      for (const lr of [...s.layers.keys()]) dropLayer(lr);
    };
  }, []);

  // смена суток: ступень и свет в окнах сверяются с часами раз в NIGHT_TICK_MS; готовый набор
  // перекрашенных спрайтов (или ночные слои) — перерисовка всей карты
  useEffect(() => {
    const s = state.current;
    s.dayNight = dayNight;
    s.nightOn = type === 'city' && dayNight !== 'day';
    const off = onNightChange(() => {
      s.ph = s.nightOn ? shownPhase() : null;
      if (s.nightHold && !nightBusy()) {
        s.nightHold = false;
        if (s.nightHoldTimer) { clearTimeout(s.nightHoldTimer); s.nightHoldTimer = null; }
      }
      if (s.nightOn) updateLit(hourFor(s.dayNight), false);
      applyGround();
      s.listDirty = true; invalidateLayer();
    });
    let timer: ReturnType<typeof setInterval> | null = null;
    if (s.nightOn) {
      void ensureNight();
      // набор с прошлого открытия карты ещё жив — рисуем им сразу
      s.ph = shownPhase();
      applyGround();
      nightTick();
      timer = setInterval(nightTick, NIGHT_TICK_MS);
    } else {
      // всегда день: перекрашенные наборы больше не нужны
      setPhase(phaseAt(stepOf(hourFor('day'))));
      s.ph = null; s.nightHold = false;
      applyGround();
    }
    s.listDirty = true; invalidateLayer();
    return () => {
      off();
      if (timer) clearInterval(timer);
      if (s.nightHoldTimer) { clearTimeout(s.nightHoldTimer); s.nightHoldTimer = null; }
    };
  }, [dayNight, type]);

  useEffect(() => {
    const c = fpsRef.current;
    if (!c) return undefined;
    const ctl = startFpsCounter(c);
    fpsCtl.current = ctl;
    return () => { ctl.stop(); fpsCtl.current = null; };
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
    s.listDirty = true; s.ver++;
    if (Object.keys(s.spriteMap).length === 0) {
      if (spriteMapCache) {
        s.spriteMap = spriteMapCache;
        s.listDirty = true; invalidateLayer();
      } else {
        fetch('/sprites/sprite-map.json').then(r => r.json()).then(sm => {
          const map: typeof s.spriteMap = {};
          for (const [id, info] of Object.entries(sm as Record<string, { atlas: string; frame: any }>)) {
            map[id] = { pngUrl: '/sprites/' + info.atlas, frame: info.frame };
          }
          spriteMapCache = map;
          s.spriteMap = map;
          s.listDirty = true; invalidateLayer();
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

    // спрайты (в т.ч. общие спрайты стройки) заказываются при сборке draw-list, см. buildDrawList
    s.listDirty = true; s.labelsDirty = true; s.ver++;

    let attempts = 0;
    const waitCenter = () => {
      const wrap = wrapRef.current;
      if (wrap && wrap.clientWidth > 0) { requestRedraw(); }
      else if (attempts++ < 30) setTimeout(waitCenter, 16);
    };
    waitCenter();
  }, [buildings, type, mapKey]);

  // режим и valid-set меняют затемнение зданий — это неподвижный слой; picked-set и цели/очередь/
  // план — только подсветку и бейджи поверх него
  useEffect(() => { state.current.listDirty = true; invalidateLayer(); }, [mode, validSet, lockedCells]);
  useEffect(() => { state.current.labelsDirty = true; requestRedraw(); }, [pickedSet, targets, queue, globalPlan, requestRedraw]);
  // пелена: проявляется сразу, а гаснет с задержкой — переход между соседними строками «Плана» её не трогает
  useEffect(() => {
    const el = focusWrapRef.current; if (!el) return;
    const on = !!focusSet && focusSet.size > 0;
    if (on) state.current.focusShown = focusSet;
    el.style.transitionDelay = on ? '0ms' : '120ms';
    el.style.opacity = on ? '1' : '0';
    requestRedraw();
  }, [focusSet, requestRedraw]);

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
      const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s.scale * factor));
      s.ox = mx + (s.ox - mx) * (newScale / s.scale);
      s.oy = my + (s.oy - my) * (newScale / s.scale);
      s.scale = newScale;
      clampPan();
      requestRedraw();
    };

    let downX = 0, downY = 0, moved = false, downOnMap = false;
    const isBatch = () => BATCHABLE.includes(s.mode);
    // mousemove/mouseup слушаются на window (чтобы пан и кисть не обрывались за краем карты), поэтому
    // наведение и клик считаем «по карте», только если курсор над самой картой, а не над тем, что
    // лежит поверх неё (палитра инструментов внизу, её подсказки), и если нажатие началось на карте
    const overMap = (e: MouseEvent) => e.target instanceof Node && wrap.contains(e.target);
    const onMouseDown = (e: MouseEvent) => {
      downOnMap = true;
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
        if (overMap(e) && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
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
        if (overMap(e) && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
          const t = screenToGrid(e.clientX - rect.left, e.clientY - rect.top);
          const inBounds = t.col >= 0 && t.col < s.cols && t.row >= 0 && t.row < s.rows;
          const gx = inBounds ? t.gx : null, gy = inBounds ? t.gy : null;
          if (s.badgeHoverGx !== gx || s.badgeHoverGy !== gy) { s.badgeHoverGx = gx; s.badgeHoverGy = gy; requestRedraw(); }
        } else if (s.badgeHoverGx !== null || s.badgeHoverGy !== null) { s.badgeHoverGx = null; s.badgeHoverGy = null; requestRedraw(); }
      }
    };
    const onMouseUp = (e: MouseEvent) => {
      s.dragging = false;
      if (!downOnMap) return;
      downOnMap = false;
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
      } else if (!moved && e.button === 0 && overMap(e)) {
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
        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s.scale * factor));
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
    <div ref={wrapRef} style={{ flex: 1, position: 'relative', overflow: 'hidden', cursor, background: MAP_BG, border: '1px solid var(--border)', touchAction: 'none' }}>
      <div ref={layersRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} />
      <canvas ref={canvasRef} style={{ display: 'block', position: 'absolute', left: 0, top: 0 }} />
      <div ref={focusWrapRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', opacity: 0, transition: 'opacity 180ms ease' }}
        onTransitionEnd={() => { if (focusWrapRef.current?.style.opacity === '0') state.current.focusShown = null; }}>
        <div ref={focusVeilRef} style={{ position: 'absolute', inset: 0, background: MAP_BG, opacity: 0.88 }} />
        <canvas ref={focusCanvasRef} style={{ display: 'block', position: 'absolute', left: 0, top: 0 }} />
      </div>
      <canvas ref={fpsRef} />
    </div>
  );
}
