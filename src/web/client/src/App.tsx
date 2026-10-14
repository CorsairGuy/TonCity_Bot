import { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api';
import { Box, IconButton, Spinner } from '@primer/react';
import { ThreeBarsIcon, XIcon } from '@primer/octicons-react';
import { PanelToggleProvider, usePanelToggleSlot } from './contexts/PanelToggleContext';








































import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';
import { LoginGate } from './components/LoginGate';
import { MaintenanceBanner } from './components/MaintenanceBanner';
import { VersionBadge } from './components/VersionBadge';
import { startBuildWatcher, check as checkBuild } from './hooks/useBuildWatcher';
import { PageErrorBoundary } from './components/PageErrorBoundary';

// Страницы грузятся лениво, каждая — своим чанком. Раньше все они лежали в одном бандле
// (~714 kB), который целиком парсился до первого кадра, хотя за раз открыта ровно одна
// страница. Теперь при входе скачивается только оболочка и нужный роут, остальное
// подтягивается по мере перехода (и заранее кладётся в кэш service worker'ом).
const Accounts = lazy(() => import('./pages/Accounts').then(m => ({ default: m.Accounts })));
const Inventory = lazy(() => import('./pages/Inventory').then(m => ({ default: m.Inventory })));
const Policies = lazy(() => import('./pages/Policies').then(m => ({ default: m.Policies })));
const Fortune = lazy(() => import('./pages/Fortune').then(m => ({ default: m.Fortune })));
const Daily = lazy(() => import('./pages/Daily').then(m => ({ default: m.Daily })));
const DailyAds = lazy(() => import('./pages/DailyAds').then(m => ({ default: m.DailyAds })));
const Reserve = lazy(() => import('./pages/Reserve').then(m => ({ default: m.Reserve })));
const Wordle = lazy(() => import('./pages/Wordle').then(m => ({ default: m.Wordle })));
const Minesweeper = lazy(() => import('./pages/Minesweeper').then(m => ({ default: m.Minesweeper })));
const Sudoku = lazy(() => import('./pages/Sudoku').then(m => ({ default: m.Sudoku })));
const Quiz = lazy(() => import('./pages/Quiz').then(m => ({ default: m.Quiz })));
const Game2048 = lazy(() => import('./pages/Game2048').then(m => ({ default: m.Game2048 })));
const MarketStats = lazy(() => import('./pages/MarketStats').then(m => ({ default: m.MarketStats })));
const MarketListings = lazy(() => import('./pages/MarketDeals').then(m => ({ default: m.MarketListings })));
const MarketPurchases = lazy(() => import('./pages/MarketDeals').then(m => ({ default: m.MarketPurchases })));
const MarketSales = lazy(() => import('./pages/MarketDeals').then(m => ({ default: m.MarketSales })));
const MarketLots = lazy(() => import('./pages/MarketLots').then(m => ({ default: m.MarketLots })));
const Journey = lazy(() => import('./pages/Journey').then(m => ({ default: m.Journey })));
const Achievements = lazy(() => import('./pages/Achievements').then(m => ({ default: m.Achievements })));
const Promocodes = lazy(() => import('./pages/Promocodes').then(m => ({ default: m.Promocodes })));
const Mid = lazy(() => import('./pages/Mid').then(m => ({ default: m.Mid })));
const Builders = lazy(() => import('./pages/Builders').then(m => ({ default: m.Builders })));
const Loyalty = lazy(() => import('./pages/Loyalty').then(m => ({ default: m.Loyalty })));
const Guilds = lazy(() => import('./pages/Guilds').then(m => ({ default: m.Guilds })));
const Quests = lazy(() => import('./pages/Quests').then(m => ({ default: m.Quests })));
const QuestTiers = lazy(() => import('./pages/QuestTiers').then(m => ({ default: m.QuestTiers })));
const Auditorium = lazy(() => import('./pages/SpecialBuildings').then(m => ({ default: m.Auditorium })));
const Factory = lazy(() => import('./pages/SpecialBuildings').then(m => ({ default: m.Factory })));
const Capitals = lazy(() => import('./pages/Capitals').then(m => ({ default: m.Capitals })));
const City = lazy(() => import('./pages/City').then(m => ({ default: m.City })));
const CityMap = lazy(() => import('./pages/CityMap').then(m => ({ default: m.CityMap })));
const ShopBoosters = lazy(() => import('./pages/ShopBoosters').then(m => ({ default: m.ShopBoosters })));
const ShopPacks = lazy(() => import('./pages/ShopPacks').then(m => ({ default: m.ShopPacks })));
const ShopPolicies = lazy(() => import('./pages/ShopPolicies').then(m => ({ default: m.ShopPolicies })));
const ThDistribution = lazy(() => import('./pages/ThDistribution').then(m => ({ default: m.ThDistribution })));
const ThPolicy = lazy(() => import('./pages/ThPolicy').then(m => ({ default: m.ThPolicy })));
const ThDiversity = lazy(() => import('./pages/ThDiversity').then(m => ({ default: m.ThDiversity })));
const CivicDraw = lazy(() => import('./pages/CivicDraw').then(m => ({ default: m.CivicDraw })));
const SatoshiTower = lazy(() => import('./pages/SatoshiTower').then(m => ({ default: m.SatoshiTower })));
const GlobalUpgradePlan = lazy(() => import('./pages/GlobalUpgradePlan').then(m => ({ default: m.GlobalUpgradePlan })));
const GlobalCapitalUpgradePlan = lazy(() => import('./pages/GlobalCapitalUpgradePlan').then(m => ({ default: m.GlobalCapitalUpgradePlan })));
// Годовщина — раздел жил на время события «Летний карнавал» (10-23.08.2026). Событие кончилось,
// поэтому пункты меню скрыты, но страницы, маршруты и серверные ручки на месте: вернуть раздел
// на следующий такой ивент = поставить флаг обратно в true.
const ANNIVERSARY_EVENT = false;
const AnniversaryOffer = lazy(() => import('./pages/AnniversaryOffer').then(m => ({ default: m.AnniversaryOffer })));
const AnniversaryCarnival = lazy(() => import('./pages/AnniversaryCarnival').then(m => ({ default: m.AnniversaryCarnival })));
const AnniversaryRoad = lazy(() => import('./pages/AnniversaryRoad').then(m => ({ default: m.AnniversaryRoad })));
const AnniversaryVault = lazy(() => import('./pages/AnniversaryVault').then(m => ({ default: m.AnniversaryVault })));
const AnniversaryMidway = lazy(() => import('./pages/AnniversaryMidway').then(m => ({ default: m.AnniversaryMidway })));
const ShopTickets = lazy(() => import('./pages/ShopTickets').then(m => ({ default: m.ShopTickets })));
const Settings = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })));
const Logs = lazy(() => import('./pages/Logs').then(m => ({ default: m.Logs })));

import {
  PersonIcon, PackageIcon, DatabaseIcon, GraphIcon, StarIcon, SyncIcon,
  LightBulbIcon, CommentIcon, RocketIcon, TrophyIcon, TagIcon, ToolsIcon,
  GlobeIcon, OrganizationIcon, HomeIcon, LocationIcon, PeopleIcon, CpuIcon,
  PlayIcon,
  HeartIcon, CalendarIcon, MegaphoneIcon, ZapIcon, GiftIcon, FileIcon,
  GearIcon, ChecklistIcon, LawIcon, BookmarkIcon,
  StackIcon, NorthStarIcon, FlagIcon, DiamondIcon, ChevronDownIcon,
  CreditCardIcon, PulseIcon,
} from '@primer/octicons-react';

// ── localStorage helpers ──────────────────────────────────────────────────────

const LS_KEY = 'nav-open-groups';


// Пока грузится чанк страницы — тот же спиннер, что и при загрузке данных внутри страниц,
// по центру области контента (без него при переходе был бы пустой экран).
function PageFallback() {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}>
      <Spinner />
    </Box>
  );
}

function loadOpenGroups(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(LS_KEY) ?? '[]')); }
  catch { return new Set(); }
}
// localStorage — только быстрый локальный кэш (мгновенно доступен до первого ответа сервера, без
// "мигания" закрытыми группами при загрузке). Источник истины — config.ui.navOpenGroups на сервере:
// у iOS Safari для standalone-PWA (добавлено на главный экран) есть известное ограничение ITP —
// localStorage может очищаться после ~недели, если приложением не пользовались (подтверждено
// пользователем: сброс воспроизводится именно после долгого простоя, не при обычном перезапуске).
// Серверная копия этому не подвержена — читается заново при каждом открытии панели.
function saveOpenGroups(s: Set<string>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify([...s])); } catch { /* */ }
  api.saveConfig({ ui: { navOpenGroups: [...s] } }).catch(() => { /* офлайн — переживём, localStorage уже сохранён */ });
}

// page → group mapping (same as original)
const PAGE_GROUP: Record<string, string> = {
  inventory: 'storage', policies: 'storage',
  reserve: 'reserve',
  fortune: 'fortune',
  wordle: 'fortress', minesweeper: 'fortress', sudoku: 'fortress', quiz: 'fortress', game2048: 'fortress',
  journey: 'profile', achievements: 'profile', promocodes: 'profile',
  'daily': 'tasks', 'daily-ads': 'tasks',
  'th-distribution': 'townhall', 'th-policy': 'townhall', 'th-diversity': 'townhall', 'civic-draw': 'townhall',
  'shop-boosters': 'shop', 'shop-packs': 'shop', 'shop-policies': 'shop',
  'market-stats': 'market', 'market-listings': 'market', 'market-purchases': 'market', 'market-sales': 'market', 'market-lots': 'market',
  loyalty: 'missions', quests: 'missions', questTiers: 'missions',
  'anniversary-offer': 'anniversary', 'anniversary-carnival': 'anniversary',
  'anniversary-road': 'anniversary', 'anniversary-vault': 'anniversary', 'shop-tickets': 'anniversary',
  'anniversary-midway': 'anniversary',
};

// ── sidebar nav component ─────────────────────────────────────────────────────

function SidebarNav({ open, onClose }: { open: boolean; onClose: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const current = location.pathname.replace('/', '');

  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    const saved = loadOpenGroups();
    const grp = PAGE_GROUP[current];
    if (grp) saved.add(grp);
    return saved;
  });

  // догружаем серверную копию один раз при монтировании — на случай если локальный кэш очищен
  // (iOS ITP, см. комментарий у saveOpenGroups) или это вообще новое устройство/браузер.
  // Сравниваем именно с localStorage-снимком на момент запроса (а не с текущим openGroups в
  // замыкании) — если пользователь уже успел кликнуть по группе, пока шёл запрос, свежий локальный
  // клик не должен быть затёрт устаревшим серверным ответом.
  useEffect(() => {
    let cancelled = false;
    api.config().then(r => {
      if (cancelled || !r.ok) return;
      const serverGroups = r.settings.ui?.navOpenGroups;
      if (!Array.isArray(serverGroups)) return;
      const localSnapshot = loadOpenGroups();
      const same = serverGroups.length === localSnapshot.size && serverGroups.every(g => localSnapshot.has(g));
      if (same) return;
      const next = new Set(serverGroups);
      const grp = PAGE_GROUP[current];
      if (grp) next.add(grp);
      setOpenGroups(next);
      try { localStorage.setItem(LS_KEY, JSON.stringify(serverGroups)); } catch { /* */ }
    }).catch(() => { /* нет сети/сервера — остаёмся на локальном кэше */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleGroup = useCallback((id: string) => {
    setOpenGroups(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      saveOpenGroups(next);
      return next;
    });
  }, []);

  const go = (page: string) => { navigate('/' + page); onClose(); }; // на мобиле закрываем меню после перехода
  const Icon = ({ ic: Ic }: { ic: React.ElementType }) => <Ic className="nav-icon" />;
  const item = (page: string, label: string, Ic: React.ElementType) => (
    <button key={page} className={'nav-item' + (current === page ? ' active' : '')} onClick={() => go(page)}>
      <Icon ic={Ic} />
      {label}
    </button>
  );
  const group = (id: string, label: string, Ic: React.ElementType, children: React.ReactNode) => {
    const open = openGroups.has(id);
    const hasActive = Object.entries(PAGE_GROUP).some(([p, g]) => g === id && p === current);
    return (
      <div key={id} className={'nav-group' + (open ? ' open' : '')} id={'ng-' + id}>
        <button className={'nav-group-head' + (!open && hasActive ? ' has-active-child' : '')} onClick={() => toggleGroup(id)}>
          <Icon ic={Ic} />
          {label}
          <ChevronDownIcon className="nav-arrow" />
        </button>
        <div className="nav-sub">{children}</div>
      </div>
    );
  };

  return (
    <nav className={'sidebar' + (open ? ' open' : '')}>
      {/* шапка меню только для мобильного оверлея (на десктопе скрыта через CSS). Крестик — ПЕРВЫМ,
          на месте бургера в топбаре (см. .sidebar-mobile-head в global.css). */}
      <div className="sidebar-mobile-head">
        <IconButton icon={XIcon} aria-label="Закрыть меню" variant="invisible" onClick={onClose} />
        <span className="header-logo">TON City</span>
      </div>
      <OverlayScrollbarsComponent className="nav" options={{ scrollbars: { autoHide: 'leave', autoHideDelay: 800 } }} style={{ flex: 1, minHeight: 0, padding: 8 }}>
        {item('accounts',    'Аккаунты',           PersonIcon)}

        {/* Годовщина — показывается только пока идёт событие, см. ANNIVERSARY_EVENT выше */}
        {ANNIVERSARY_EVENT && group('anniversary', 'Годовщина', GiftIcon,
          <>
            {item('anniversary-offer',    'Предложение дня', StarIcon)}
            {item('anniversary-carnival', 'Летний карнавал', ChecklistIcon)}
            {item('anniversary-road',     'Дорога наград',   NorthStarIcon)}
            {item('anniversary-vault',    'Хранилище призов', StarIcon)}
            {item('anniversary-midway',   'Карнавальная аллея', PlayIcon)}
            {item('shop-tickets',         'Магазин билетов', TagIcon)}
          </>
        )}

        {group('storage', 'Хранилище', PackageIcon,
          <>
            {item('inventory', 'Предметы', PackageIcon)}
            {item('policies',  'Политики', LawIcon)}
          </>
        )}

        {group('tasks', 'Задания', ChecklistIcon,
          <>
            {item('daily',     'Ежедневная награда',    CalendarIcon)}
            {item('daily-ads', 'Ежедневная реклама', MegaphoneIcon)}
          </>
        )}

        {group('reserve', 'Федеральный Резерв', DatabaseIcon,
          <>{item('reserve', 'Стейкинг', StackIcon)}</>
        )}

        {group('fortune', 'Павильон удачи', StarIcon,
          <>{item('fortune', 'Колесо Фортуны', SyncIcon)}</>
        )}

        {group('fortress', 'Оплот Мудрости', LightBulbIcon,
          <>
            {item('wordle',      'Вордли', CommentIcon)}
            {item('minesweeper', 'Сапёр',  FlagIcon)}
            {item('sudoku',      'Судоку', StackIcon)}
            {item('quiz',        'Викторина', CommentIcon)}
            {item('game2048',    '2048', DiamondIcon)}
          </>
        )}

        {group('profile', 'Профиль', PersonIcon,
          <>
            {item('journey',      'Путь Мэра',    RocketIcon)}
            {item('achievements', 'Достижения',   TrophyIcon)}
            {item('promocodes',   'Промокоды',    TagIcon)}
          </>
        )}

        {item('builders',    'Строители',          ToolsIcon)}
        {item('mid',         'МИД',                GlobeIcon)}
        {item('guilds',      'Гильдии',            OrganizationIcon)}

        {group('missions', 'Сфера миссий', NorthStarIcon,
          <>
            {item('loyalty',    'Дорога верности', HeartIcon)}
            {item('quests',     'Квесты',          ChecklistIcon)}
            {item('questTiers', 'Уровни квестов',  ChecklistIcon)}
          </>
        )}

        {item('capitals',    'Столицы',            DiamondIcon)}
        {item('city',        'Города',             LocationIcon)}
        {item('auditorium',  'Аудиториум',         PeopleIcon)}
        {item('techfactory', 'Фабрика',            CpuIcon)}

        {group('townhall', 'Мэрия', HomeIcon,
          <>
            {item('th-distribution', 'Распределение',     GraphIcon)}
            {item('th-policy',       'Библиотека политик', LawIcon)}
            {item('th-diversity',    'Разнообразие',      BookmarkIcon)}
            {item('civic-draw',      'Городской розыгрыш', GiftIcon)}
          </>
        )}

        {group('shop', 'Магазин', GiftIcon,
          <>
            {item('shop-boosters', 'Ускорители', ZapIcon)}
            {item('shop-packs',    'Наборы',     PackageIcon)}
            {item('shop-policies', 'Политики',   LawIcon)}
          </>
        )}

        {group('market', 'Центральный рынок', CreditCardIcon,
          <>
            {item('market-lots',      'Офферы',      TagIcon)}
            {item('market-listings',  'Листинги',   StackIcon)}
            {item('market-stats',     'Статистика', GraphIcon)}
            {item('market-purchases', 'Покупки',    PackageIcon)}
            {item('market-sales',     'Продажи',    DiamondIcon)}
          </>
        )}

        {item('satoshi', 'Башня Сатоши', PulseIcon)}

        <div className="nav-separator" />
        {item('logs',     'Логи',       FileIcon)}
        {item('settings', 'Настройки',  GearIcon)}
        <VersionBadge />
      </OverlayScrollbarsComponent>
    </nav>
  );
}

// ── app ───────────────────────────────────────────────────────────────────────

// Кнопка правой панели текущей страницы (если та её зарегистрировала, см. PanelToggleContext) —
// та же IconButton/variant="invisible", что и бургер слева, просто с другой иконкой. Рендерится
// ВСЕГДА, пока страница что-то зарегистрировала (не только пока панель закрыта) — когда панель
// открывается, она сама (position:fixed, z-index выше топбара) наезжает поверх и визуально
// перекрывает эту кнопку, а закрывающий крестик внутри панели (см. global.css) стоит ровно на её
// месте — тот же приём, что уже работает у бургера/крестика левого меню.
function MobilePanelButton() {
  const panel = usePanelToggleSlot();
  if (!panel) return null;
  const Icon = panel.icon;
  return <IconButton icon={Icon} aria-label={panel.label} variant="invisible" onClick={panel.onOpen} />;
}

// последняя открытая страница (чтобы PWA при открытии возвращал туда же, а не всегда на "Аккаунты")
const LAST_PAGE_KEY = 'tc-last-page';
function loadLastPage(): string {
  try { return localStorage.getItem(LAST_PAGE_KEY) || '/accounts'; } catch { return '/accounts'; }
}

export default function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  // закрываем меню при смене маршрута (на случай навигации не через клик по пункту) и блокируем
  // прокрутку фона, пока открыт полноэкранный оверлей меню
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);
  // бот перезапустился на новой версии — перезагружаем панель на любой странице; переход между
  // страницами тоже повод проверить сразу (см. hooks/useBuildWatcher)
  const firstRoute = useRef(true);
  useEffect(() => {
    if (firstRoute.current) { firstRoute.current = false; startBuildWatcher(); return; }
    checkBuild();
  }, [location.pathname]);
  // запоминаем каждую реальную страницу (кроме "/", это transient-редирект, а не контент) — читает
  // loadLastPage() ниже при следующем открытии PWA. Невалидный/удалённый путь не страшен: маршрут
  // "*" ниже сам уводит на /accounts.
  // ВАЖНО: сохраняем pathname+search, а НЕ только pathname — карта конкретного города/столицы
  // (/city-map) выбирает аккаунт из query-параметра (?account=...&type=), а не из пути (см.
  // CityMap.tsx). Без search при возврате подставлялся дефолтный аккаунт (первый по алфавиту),
  // а не тот, что реально был открыт.
  useEffect(() => {
    if (location.pathname === '/') return;
    try { localStorage.setItem(LAST_PAGE_KEY, location.pathname + location.search); } catch { /* */ }
  }, [location.pathname, location.search]);
  useEffect(() => {
    document.body.classList.toggle('menu-open', menuOpen);
    return () => document.body.classList.remove('menu-open');
  }, [menuOpen]);

  return (
    <LoginGate>
      <PanelToggleProvider>
      <MaintenanceBanner />
      {/* мобильный топбар с бургером — виден только на узких экранах (CSS), на десктопе скрыт.
          Слева — бургер+лого (группой, чтобы кнопка страницы справа не разъезжалась с justify-
          content:space-between). Справа — кнопка правой панели текущей страницы, если она её
          зарегистрировала (см. PanelToggleContext) — раньше это была отдельная кнопка "Панель"
          внутри тулбара каждой страницы (CityMapCity/CityMapCapital), теперь общий хидер сам решает,
          показывать её или нет, не зная о конкретных страницах. */}
      <div className="mobile-topbar">
        <div className="mobile-topbar-left">
          <IconButton icon={ThreeBarsIcon} aria-label="Меню" variant="invisible" onClick={() => setMenuOpen(true)} />
          <span className="header-logo">TON City</span>
        </div>
        <MobilePanelButton />
      </div>
      <div className={'menu-overlay' + (menuOpen ? ' show' : '')} onClick={() => setMenuOpen(false)} />
      <SidebarNav open={menuOpen} onClose={() => setMenuOpen(false)} />
      <main className="main">
        {/* ошибка страницы (в т.ч. протухший lazy-чанк после пересборки) не должна гасить всё
            приложение до чёрного экрана — см. PageErrorBoundary */}
        <PageErrorBoundary>
        <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/"                element={<Navigate to={loadLastPage()} replace />} />
          <Route path="/accounts"        element={<Accounts />} />
          <Route path="/inventory"       element={<Inventory />} />
          <Route path="/policies"        element={<Policies />} />
          <Route path="/fortune"         element={<Fortune />} />
          <Route path="/daily"           element={<Daily />} />
          <Route path="/daily-ads"       element={<DailyAds />} />
          <Route path="/dailyads"        element={<DailyAds />} />
          <Route path="/reserve"         element={<Reserve />} />
          <Route path="/wordle"          element={<Wordle />} />
          <Route path="/minesweeper"     element={<Minesweeper />} />
          <Route path="/sudoku"          element={<Sudoku />} />
          <Route path="/quiz"            element={<Quiz />} />
          <Route path="/game2048"        element={<Game2048 />} />
          <Route path="/journey"         element={<Journey />} />
          <Route path="/achievements"    element={<Achievements />} />
          <Route path="/promocodes"      element={<Promocodes />} />
          <Route path="/mid"             element={<Mid />} />
          <Route path="/builders"        element={<Builders />} />
          <Route path="/loyalty"         element={<Loyalty />} />
          <Route path="/guilds"          element={<Guilds />} />
          <Route path="/quests"          element={<Quests />} />
          <Route path="/questTiers"      element={<QuestTiers />} />
          <Route path="/capitals"        element={<Capitals />} />
          <Route path="/city"            element={<City />} />
          <Route path="/city-map"        element={<CityMap />} />
          <Route path="/global-upgrade-plan" element={<GlobalUpgradePlan />} />
          <Route path="/global-capital-upgrade-plan" element={<GlobalCapitalUpgradePlan />} />
          <Route path="/shop-boosters"   element={<ShopBoosters />} />
          <Route path="/shop-packs"      element={<ShopPacks />} />
          <Route path="/shop-policies"   element={<ShopPolicies />} />
          <Route path="/market-lots"     element={<MarketLots />} />
          <Route path="/market-stats"    element={<MarketStats />} />
          <Route path="/market-listings" element={<MarketListings />} />
          <Route path="/market-purchases" element={<MarketPurchases />} />
          <Route path="/market-sales"    element={<MarketSales />} />
          <Route path="/satoshi"         element={<SatoshiTower />} />
          <Route path="/th-distribution" element={<ThDistribution />} />
          <Route path="/th-policy"       element={<ThPolicy />} />
          <Route path="/th-diversity"    element={<ThDiversity />} />
          <Route path="/civic-draw"      element={<CivicDraw />} />
          <Route path="/anniversary-offer"    element={<AnniversaryOffer />} />
          <Route path="/anniversary-carnival" element={<AnniversaryCarnival />} />
          <Route path="/anniversary-road"     element={<AnniversaryRoad />} />
          <Route path="/anniversary-vault"    element={<AnniversaryVault />} />
          <Route path="/anniversary-midway"   element={<AnniversaryMidway />} />
          <Route path="/shop-tickets"         element={<ShopTickets />} />
          <Route path="/settings"        element={<Settings />} />
          <Route path="/logs"            element={<Logs />} />
          <Route path="/auditorium"      element={<Auditorium />} />
          <Route path="/techfactory"     element={<Factory />} />
          <Route path="*"                element={<Navigate to="/accounts" replace />} />
        </Routes>
        </Suspense>
        </PageErrorBoundary>
      </main>
      </PanelToggleProvider>
    </LoginGate>
  );
}
