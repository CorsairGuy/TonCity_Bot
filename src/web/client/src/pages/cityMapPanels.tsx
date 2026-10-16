// Правый сайдбар карты города: палитра инструментов внизу карты переключает его содержимое,
// сам сайдбар всегда открыт. Здесь — оформление страниц сайдбара, данные и действия приходят из
// CityMapCity.tsx (там же остались Строительство/Перемещение/Реконструкция в прежнем виде).
import { useEffect, useMemo, useState, type ReactNode, type DragEvent } from 'react';
import { Box, Button, CounterLabel, IconButton, Label, Octicon, ProgressBar, Spinner, Text, TextInput, Timeline } from '@primer/react';
import { Tooltip } from '@primer/react/experimental';
import {
  GraphIcon, GoalIcon, StackIcon, ClockIcon, PlusIcon, ArrowBothIcon, TrashIcon, IterationsIcon, StarIcon, ZapIcon, LogIcon,
  QuestionIcon, SearchIcon, XIcon, DashIcon, ChevronDownIcon, ChevronRightIcon, ArrowRightIcon, ArrowUpIcon, ArrowDownIcon,
  GrabberIcon, PlusCircleIcon, UnlockIcon, CheckIcon, UndoIcon,
} from '@primer/octicons-react';
import type { CityActionMode } from '../components/CityActionsCanvas';
import type { CityStats, ServiceCat, CityStrategyTarget, CityStrategyQueueItem, MapBuilding, BuildingDef, CityBoosterRow, CityActionLogRow, ForecastEvent } from '../api';
import type { CityStatsMods } from '../cityStats';
import { BuildingSprite } from '../components/BuildingSprite';
import { Scrollable } from '../components/Scrollable';
import { CoinValue } from '../components/Icons';
import { fmt } from '../utils';

export type PanelMode = Exclude<CityActionMode, 'skip'>;

// ── палитра ──────────────────────────────────────────────────────────────────
interface Tool { mode: PanelMode; icon: React.ElementType; title: string; danger?: boolean }
export const CITY_TOOLS: Tool[][] = [
  [{ mode: 'view', icon: GraphIcon, title: 'Показатели' }],
  [{ mode: 'upgrade', icon: GoalIcon, title: 'План' }, { mode: 'queue', icon: StackIcon, title: 'Очередь' }, { mode: 'forecast', icon: ClockIcon, title: 'Прогноз' }],
  [{ mode: 'build', icon: PlusIcon, title: 'Строительство' }, { mode: 'move', icon: ArrowBothIcon, title: 'Перемещение' }, { mode: 'demolish', icon: TrashIcon, title: 'Снос', danger: true }],
  [{ mode: 'reconstruct', icon: IterationsIcon, title: 'Реконструкция' }, { mode: 'renovate', icon: StarIcon, title: 'Реновация' }, { mode: 'boosters', icon: ZapIcon, title: 'Ускорители' }],
  [{ mode: 'log', icon: LogIcon, title: 'Лог' }],
];
export const toolFor = (m: PanelMode): Tool => CITY_TOOLS.flat().find(t => t.mode === m) ?? CITY_TOOLS[0][0];

export function MapPalette({ mode, onSelect, dots }: { mode: PanelMode; onSelect: (m: PanelMode) => void; dots: Partial<Record<PanelMode, boolean>> }) {
  return (
    <Box sx={{
      display: 'flex', alignItems: 'center', gap: 1, p: 1, maxWidth: '100%', overflowX: 'auto', scrollbarWidth: 'none',
      bg: 'canvas.overlay', border: '1px solid', borderColor: 'border.default', borderRadius: '12px', boxShadow: 'shadow.large',
    }}>
      {CITY_TOOLS.map((grp, gi) => (
        <Box key={gi} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
          {gi > 0 && <Box sx={{ width: 1, height: 20, bg: 'border.default', mx: 1 }} />}
          {grp.map(t => {
            const on = mode === t.mode;
            const onBg = t.danger ? 'danger.emphasis' : 'accent.emphasis';
            return (
              <Tooltip key={t.mode} text={t.title} direction="n">
                <Box sx={{ position: 'relative' }}>
                  <IconButton icon={t.icon} aria-label={t.title} variant="invisible" onClick={() => onSelect(t.mode)}
                    sx={on
                      ? { bg: onBg, '& svg': { color: 'fg.onEmphasis' }, '&:hover:not([disabled])': { bg: onBg } }
                      : { '& svg': { color: t.danger ? 'danger.fg' : 'fg.default' } }} />
                  {dots[t.mode] && !on && <Box sx={{ position: 'absolute', top: '4px', right: '4px', width: 6, height: 6, borderRadius: '50%', bg: 'accent.emphasis', pointerEvents: 'none' }} />}
                </Box>
              </Tooltip>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

// ── каркас сайдбара ─────────────────────────────────────────────────────────
// gap — зазор между блоками содержимого (по умолчанию 16px; «План» — 8px, как отступы по бокам)
export function PanelShell({ mode, count, hint, actions, footer, gap = 3, children }: { mode: PanelMode; count?: number; hint: ReactNode; actions?: ReactNode; footer?: ReactNode; gap?: number; children: ReactNode }) {
  const [help, setHelp] = useState(false);
  const t = toolFor(mode);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, bg: 'canvas.default' }}>
      <Box sx={{ height: 48, flexShrink: 0, pl: 3, pr: 2, display: 'flex', alignItems: 'center', gap: 2, borderBottom: '1px solid', borderColor: 'border.default' }}>
        <Text sx={{ fontWeight: 'semibold', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</Text>
        {count != null && count > 0 && <CounterLabel>{count}</CounterLabel>}
        {actions}
        <IconButton size="small" variant="invisible" icon={QuestionIcon} aria-label="Подсказка" aria-pressed={help} onClick={() => setHelp(h => !h)}
          sx={help ? { bg: 'accent.subtle', '& svg': { color: 'accent.fg' } } : undefined} />
      </Box>
      {/* полоса прокрутки поверх содержимого (как в прежнем сайдбаре) — отступ ровно 8px со всех сторон */}
      <Scrollable>
        <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap, '& > *': { flexShrink: 0 } }}>
          {help && <Text as="p" sx={{ m: 0, fontSize: 0, color: 'fg.muted', bg: 'canvas.subtle', p: 2, borderRadius: 2 }}>{hint}</Text>}
          {children}
        </Box>
      </Scrollable>
      {footer && <Box sx={{ flexShrink: 0, p: 2, display: 'flex', alignItems: 'center', gap: 2, borderTop: '1px solid', borderColor: 'border.default' }}>{footer}</Box>}
    </Box>
  );
}

const muted = { fontSize: 0, color: 'fg.muted' } as const;
const num = { fontVariantNumeric: 'tabular-nums' } as const;
export function Caption({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, pb: 2 }}>
      <Text sx={{ fontSize: 0, fontWeight: 'semibold', color: 'fg.muted', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{children}</Text>
      {right != null && <Text sx={muted}>{right}</Text>}
    </Box>
  );
}
export function Empty({ children }: { children: ReactNode }) { return <Text sx={muted}>{children}</Text>; }
function Thumb({ id, size = 40, bg = 'canvas.subtle' }: { id: string; size?: number; bg?: string }) {
  return <Box sx={{ width: size, height: size, borderRadius: '8px', bg, display: 'grid', placeItems: 'center', flexShrink: 0 }}><BuildingSprite id={id} size={size - 8} /></Box>;
}
function Stepper({ value, onChange, min = 1 }: { value: number; onChange: (v: number) => void; min?: number }) {
  return (
    <Box onClick={e => e.stopPropagation()} sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
      <IconButton size="small" variant="invisible" icon={DashIcon} aria-label="Ниже" disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))} />
      <Text sx={{ minWidth: 24, textAlign: 'center', fontWeight: 'semibold', ...num }}>{value}</Text>
      <IconButton size="small" variant="invisible" icon={PlusIcon} aria-label="Выше" onClick={() => onChange(value + 1)} />
    </Box>
  );
}
// как в игре — 2 знака после запятой
export function fmtStat(n: number): string {
  const abs = Math.abs(n), sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return sign + (abs / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(2) + 'K';
  return String(Math.round(n));
}
export function fmtTimeLeft(ms: number): string {
  if (ms <= 0) return '0м';
  const totalMin = Math.ceil(ms / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h > 0 ? `${h}ч ${m}м` : `${m}м`;
}
const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`;

// ── Показатели: доход разложением ───────────────────────────────────────────
const SERVICE_LABEL: Record<ServiceCat, string> = { hospital: 'Больницы', 'police-station': 'Полиция', 'fire-station': 'Пожарные', park: 'Парки' };
// "Базовый доход" — доход совсем без политик (raw, как на экране "Обзор доходов" в игре), "Политики" —
// общий эффект category/type-множителей и глобального множителя относительно raw.profit
export function StatsPanel({ raw, s, projected, mods }: { raw: CityStats; s: CityStats; projected: CityStats; mods: CityStatsMods }) {
  const base = raw.profit * raw.happiness;
  const guild = mods.incomeBoost ?? 0;
  const policyMult = raw.profit > 0 ? (s.profit / raw.profit) * (mods.globalIncomeMult ?? 1) : (mods.globalIncomeMult ?? 1);
  const diversity = mods.diversityIncomeBoost ?? 0;
  // доли полосы: база, затем прибавка от политик, гильдии и разнообразия — в том порядке, в каком
  // множители применяются; отрицательная прибавка в полосе не рисуется
  const afterPolicy = base * policyMult, afterGuild = afterPolicy * (1 + guild);
  const parts: [string, number, string, string][] = [
    ['Базовый', base, fmtStat(base), 'accent.emphasis'],
    ['Гильдия', afterGuild - afterPolicy, pct(guild * 100), 'done.emphasis'],
    ['Политики', afterPolicy - base, pct((policyMult - 1) * 100), 'success.emphasis'],
    ['Разнообразие', s.profitFinal - afterGuild, pct(diversity * 100), 'attention.emphasis'],
  ];
  const total = parts.reduce((a, p) => a + Math.max(0, p[1]), 0) || 1;
  const after = projected.profitFinal, gain = s.profitFinal > 0 ? (after / s.profitFinal - 1) * 100 : 0;
  return (
    <>
      <Box>
        <Text sx={muted}>Доход в час</Text>
        <Text as="div" sx={{ fontSize: 5, fontWeight: 'semibold', lineHeight: 1.2, ...num }}>{fmtStat(s.profitFinal)}</Text>
        <Box sx={{ display: 'flex', height: 8, borderRadius: '4px', overflow: 'hidden', gap: '2px', mt: 2, bg: 'neutral.muted' }}>
          {parts.filter(p => p[1] > 0).map(([k, v, , c]) => <Box key={k} sx={{ width: `${v / total * 100}%`, bg: c }} />)}
        </Box>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 3 }}>
          {parts.map(([k, , v, c]) => (
            <Box key={k} sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
              <Box sx={{ width: 8, height: 8, borderRadius: '2px', bg: c, flexShrink: 0 }} />
              <Text sx={{ fontSize: 1, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k}</Text>
              <Text sx={{ fontSize: 1, ...num }}>{v}</Text>
            </Box>
          ))}
        </Box>
      </Box>
      <Box sx={{ borderTop: '1px solid', borderColor: 'border.muted', pt: 3, display: 'flex', alignItems: 'center', gap: 2 }}>
        <Octicon icon={GoalIcon} sx={{ color: 'accent.fg' }} />
        <Text sx={{ flex: 1 }}>После плана</Text>
        <Text sx={{ fontWeight: 'semibold', ...num }}>{fmtStat(after)}</Text>
        {gain >= 0.5 && <Label variant="accent">{pct(gain)}</Label>}
      </Box>
      <Box>
        <Caption right={`${fmtStat(s.population)} жителей · ${(s.happiness * 100).toFixed(1)}%`}>Город</Caption>
        {(Object.keys(SERVICE_LABEL) as ServiceCat[]).map(k => {
          const v = Math.round(s.serviceRatios[k] * 100);
          return (
            <Box key={k} title={`Покрытие: ${fmtStat(s.coverageByCat[k])}`} sx={{ display: 'flex', alignItems: 'center', gap: 3, height: 32 }}>
              <Text sx={{ width: 72, fontSize: 1, flexShrink: 0 }}>{SERVICE_LABEL[k]}</Text>
              <Box sx={{ flex: 1 }}><ProgressBar progress={Math.min(100, v)} barSize="small" bg={v < 90 ? 'attention.emphasis' : 'success.emphasis'} aria-label={SERVICE_LABEL[k]} /></Box>
              <Text sx={{ width: 40, textAlign: 'right', fontSize: 1, ...num }}>{v}%</Text>
            </Box>
          );
        })}
      </Box>
    </>
  );
}

// ── План: сводка, карточки зданий и полоса прогресса на каждую клетку ──────
// Шкала клетки — от 1-го уровня до цели: (уровень−1)/(цель−1), уровень выше цели = 100%.
// Пока идёт стройка, игра уже подняла level (realLevel = level−1), строящийся уровень — синий сегмент.
// Прогресс здания и всего плана — сумма пройденных уровней к сумме нужных.
interface PlanCell { key: string; level: number; target: number; done: number; wip: number; span: number; cost: number }
interface PlanSum { done: number; wip: number; span: number; ready: number; building: number; cost: number }
function planSum(cells: PlanCell[]): PlanSum {
  const r = { done: 0, wip: 0, span: 0, ready: 0, building: 0, cost: 0 };
  for (const c of cells) { r.done += c.done; r.wip += c.wip; r.span += c.span; r.cost += c.cost; if (c.done >= c.span) r.ready++; if (c.wip) r.building++; }
  return r;
}
const pctOf = (n: number, of: number) => of ? n / of * 100 : 0;
// заливка шапки здания: те же цвета, что у полос, приглушённые (переменные Primer с запасным значением)
const FILL_DONE = 'var(--bgColor-success-muted, rgba(74,194,107,.4))';
const FILL_WIP = 'var(--bgColor-accent-muted, rgba(84,174,255,.4))';
function PlanBar({ done, wip, span, size = 'small', bg }: { done: number; wip: number; span: number; size?: 'small' | 'default' | 'large'; bg?: string }) {
  return (
    <ProgressBar barSize={size} aria-label="Прогресс" sx={{ flex: '1 1 auto', minWidth: 0, ...(bg ? { bg } : null) }}>
      <ProgressBar.Item className="pb-fill" progress={pctOf(done, span)} sx={{ bg: 'success.emphasis' }} />
      {wip > 0 && <ProgressBar.Item className="pb-fill" progress={pctOf(wip, span)} sx={{ bg: 'accent.emphasis' }} />}
    </ProgressBar>
  );
}
const cellsWord = (n: number) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? 'клетка' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'клетки' : 'клеток'; };
export function PlanPanel({ targets, owned, labelFor, upgradeCost, brushLevel, onBrushLevel, onHover, removed, onMarkRemoved }: {
  targets: CityStrategyTarget[]; owned: MapBuilding[]; labelFor: (id: string) => string;
  upgradeCost: (id: string, fromLvl: number, toLvl: number) => number; // монет на улучшения fromLvl → toLvl
  brushLevel: number; onBrushLevel: (v: number) => void;
  onHover: (cells: string[] | null) => void; // "x_y" — на карте остаются видны только эти клетки
  // клетки ("x,y"), помеченные к удалению: остаются в списке бледными, из плана уходят при «Сохранить»
  removed: Set<string>; onMarkRemoved: (keys: string[], on: boolean) => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [hot, setHot] = useState<string | null>(null); // клетка под курсором: вместо полосы — уровни и цена
  useEffect(() => () => onHover(null), [onHover]); // ушли со вкладки — карта снова целиком
  const groups = useMemo(() => {
    const now = Date.now();
    const byCell = new Map(owned.map(b => [`${b.x},${b.y}`, b]));
    const m = new Map<string, { id: string; name: string; cells: (PlanCell & { x: number; y: number })[] }>();
    for (const t of targets) {
      const b = byCell.get(`${t.x},${t.y}`);
      const id = b?.id ?? '';
      const building = !!b?.end && Date.parse(b.end) > now;
      const level = (Number(b?.level) || 0) - (building ? 1 : 0);
      const span = Math.max(1, t.target_level - 1);
      const done = Math.max(0, Math.min(level, t.target_level) - 1);
      if (!m.has(id)) m.set(id, { id, name: id ? labelFor(id) : 'Пустая клетка', cells: [] });
      // строящийся уровень уже оплачен — цена считается со следующего
      const cost = id ? upgradeCost(id, building ? level + 1 : level, t.target_level) : 0;
      m.get(id)!.cells.push({ x: t.x, y: t.y, key: `${t.x},${t.y}`, level, target: t.target_level, done, wip: building && level < t.target_level ? 1 : 0, span, cost });
    }
    // помеченные к удалению в прогресс не входят — после сохранения их в плане не будет
    return [...m.values()].map(g => {
      g.cells.sort((a, b) => a.x - b.x || a.y - b.y);
      const kept = g.cells.filter(c => !removed.has(c.key));
      return { ...g, sum: planSum(kept), marked: g.cells.length - kept.length };
    }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [targets, owned, labelFor, upgradeCost, removed]);
  const all = useMemo(() => planSum(groups.flatMap(g => g.cells.filter(c => !removed.has(c.key)))), [groups, removed]);
  const keptCount = targets.length - groups.reduce((n, g) => n + g.marked, 0);
  const ql = q.trim().toLowerCase();
  const shown = ql ? groups.filter(g => g.name.toLowerCase().includes(ql) || g.cells.some(c => c.key.startsWith(ql))) : groups;
  const hover = (keys: string[]) => ({ onMouseEnter: () => onHover(keys.map(k => k.replace(',', '_'))), onMouseLeave: () => onHover(null) });
  const allPct = pctOf(all.done, all.span);
  return (
    <>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {groups.length > 0 && <TextInput placeholder="Поиск" aria-label="Поиск по плану" block value={q} onChange={e => setQ(e.target.value)} />}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, minHeight: 32 }}>
          <Text sx={{ color: 'fg.muted' }}>Уровень кисти</Text>
          <Stepper value={brushLevel} onChange={onBrushLevel} />
        </Box>
      </Box>
      {groups.length === 0 ? <Empty>Целей пока нет. Кликните здание на карте или проведите кистью.</Empty> : (
        <>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, p: 2, borderRadius: '12px', bg: 'success.subtle' }}>
            {/* две плитки: сколько плана пройдено и сколько монет нужно до цели */}
            <Box sx={{ display: 'flex', gap: 2 }}>
              <Box sx={{ flex: 1, minWidth: 0, p: 2, borderRadius: '8px', bg: 'canvas.default' }}>
                <Text as="div" sx={{ fontSize: 3, lineHeight: 1.1, fontWeight: 'semibold', color: 'success.fg', ...num }}>{Math.floor(allPct)}%</Text>
                <Text as="div" sx={muted}>плана выполнено</Text>
              </Box>
              <Box sx={{ flex: 1, minWidth: 0, p: 2, borderRadius: '8px', bg: 'canvas.default' }}>
                <Text as="div" sx={{ fontSize: 3, lineHeight: 1.1, fontWeight: 'semibold', ...num }}><CoinValue value={fmt(all.cost)} /></Text>
                <Text as="div" sx={muted}>монет до цели</Text>
              </Box>
            </Box>
            <PlanBar done={all.done} wip={all.wip} span={all.span} size="large" bg="canvas.default" />
            <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, ...muted, ...num }}>
              <Text>клеток готово {all.ready}/{keptCount}</Text>{all.building > 0 && <Text>строится {all.building}</Text>}
            </Box>
          </Box>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {shown.map(g => {
              const o = open === g.id;
              const toggle = () => setOpen(o ? null : g.id);
              // прогресс здания — заливка шапки карточки; шапка скруглена и в раскрытом виде
              const a = pctOf(g.sum.done, g.sum.span), b = pctOf(g.sum.done + g.sum.wip, g.sum.span);
              return (
                <Box key={g.id} sx={{ borderRadius: '12px', bg: 'canvas.subtle', display: 'flex', flexDirection: 'column' }}>
                  <Box role="button" tabIndex={0} aria-expanded={o} onClick={toggle} {...hover(g.cells.map(c => c.key))}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
                    sx={{
                      display: 'flex', alignItems: 'center', gap: 2, minWidth: 0, p: 2, borderRadius: '12px', cursor: 'pointer',
                      backgroundImage: `linear-gradient(90deg, ${FILL_DONE} 0 ${a}%, ${FILL_WIP} ${a}% ${b}%, transparent ${b}%)`,
                    }}>
                    {g.id ? <Thumb id={g.id} size={36} bg="canvas.default" /> : <Box sx={{ width: 36, height: 36 }} />}
                    <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                      <Text sx={{ fontWeight: 'semibold', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.name}</Text>
                      <Text sx={{ ...muted, ...num, whiteSpace: 'nowrap' }}>{g.cells.length - g.marked} кл. · {g.sum.cost > 0 ? <CoinValue value={fmt(g.sum.cost)} /> : <Text sx={{ color: 'success.fg' }}>готово</Text>}</Text>
                    </Box>
                    <Octicon icon={o ? ChevronDownIcon : ChevronRightIcon} sx={{ color: 'fg.muted', flexShrink: 0 }} />
                  </Box>
                  {o && (
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, p: 2 }}>
                      {/* строки 22 px вплотную: полоса 16 px + бывший зазор входят в саму строку, щелей для мыши нет */}
                      <Box sx={{ display: 'flex', flexDirection: 'column', my: '-3px' }}>
                        {g.cells.map(c => {
                          const off = removed.has(c.key);
                          const levels = c.done >= c.span ? `готово, ур. ${c.level}` : `${c.level} → ${c.target}`;
                          const k = c.key.replace(',', '_');
                          // под курсором полоса сменяется строкой «уровень → цель · цена»; клик помечает клетку к удалению
                          // (полоса бледнеет и перечёркнута), повторный — возвращает
                          return (
                            <Box key={c.key} as="button" type="button" aria-label={`${c.key} · ${levels}`} aria-pressed={off} onClick={() => onMarkRemoved([c.key], !off)}
                              onMouseEnter={() => { setHot(c.key); onHover([k]); }} onMouseLeave={() => { setHot(h => h === c.key ? null : h); onHover(null); }}
                              sx={{ position: 'relative', display: 'flex', alignItems: 'center', height: 22, p: 0, border: 0, bg: 'transparent', cursor: 'pointer', fontFamily: 'inherit', color: 'fg.default' }}>
                              {hot === c.key && !off
                                ? <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, height: 20, px: 2, borderRadius: '4px', bg: 'canvas.default', fontSize: '11px', ...num }}>
                                    <Text sx={{ color: 'fg.muted', whiteSpace: 'nowrap' }}>{levels}</Text>
                                    {c.cost > 0 && <Text sx={{ fontWeight: 'semibold', whiteSpace: 'nowrap' }}><CoinValue value={fmt(c.cost)} /></Text>}
                                  </Box>
                                : <>
                                    <Box sx={{ flex: 1, minWidth: 0, display: 'flex', opacity: off ? 0.35 : 1, '& .pb-fill': off ? { bg: 'danger.emphasis' } : undefined }}>
                                      <PlanBar done={c.done} wip={c.wip} span={c.span} />
                                    </Box>
                                    {off && <Box sx={{ position: 'absolute', left: 0, right: 0, top: '50%', height: '1px', bg: 'danger.fg' }} />}
                                  </>}
                            </Box>
                          );
                        })}
                      </Box>
                      {g.marked > 0 && <Text sx={{ fontSize: 0, color: 'danger.fg', textAlign: 'center' }}>{g.marked} {cellsWord(g.marked)} {g.marked === 1 ? 'уйдёт' : 'уйдут'} из плана при сохранении</Text>}
                      {g.marked < g.cells.length
                        ? <Button size="small" block variant="invisible" leadingVisual={TrashIcon} onClick={() => onMarkRemoved(g.cells.map(c => c.key), true)}
                            sx={{ color: 'danger.fg', bg: 'canvas.default', '& svg': { color: 'danger.fg' }, '&:hover:not([disabled])': { bg: 'danger.subtle' }, '&:active:not([disabled])': { bg: 'danger.muted' } }}>Убрать все клетки</Button>
                        : <Button size="small" block variant="invisible" leadingVisual={UndoIcon} onClick={() => onMarkRemoved(g.cells.map(c => c.key), false)}
                            sx={{ bg: 'canvas.default', '&:hover:not([disabled])': { bg: 'neutral.muted' }, '&:active:not([disabled])': { bg: 'neutral.muted' } }}>Вернуть все клетки</Button>}
                    </Box>
                  )}
                </Box>
              );
            })}
            {shown.length === 0 && <Empty>Ничего не нашлось</Empty>}
          </Box>
        </>
      )}
    </>
  );
}
// «Сохранить» плана: на всю ширину, число целей — белый каунтер с тёмно-зелёными цифрами
export function PlanSaveButton({ count, busy, onClick }: { count: number; busy: boolean; onClick: () => void }) {
  const Count = () => <CounterLabel sx={{ bg: '#ffffff', color: '#116329', fontWeight: 'semibold', border: 0 }}>{count}</CounterLabel>;
  // с loading Primer оборачивает кнопку в свой Box — растягиваем и его
  return (
    <Box sx={{ flex: 1, minWidth: 0, '& > *': { width: '100%' } }}>
      <Button variant="primary" block leadingVisual={CheckIcon} trailingVisual={Count} loading={busy} disabled={busy} onClick={onClick}>Сохранить</Button>
    </Box>
  );
}

// ── Очередь улучшений: перетаскиваемый список ───────────────────────────────
export function QueuePanel({ queue, owned, labelFor, prices, onReorder, onRemove }: {
  queue: CityStrategyQueueItem[]; owned: MapBuilding[]; labelFor: (id: string) => string; prices: (number | null)[];
  onReorder: (from: number, to: number) => void; onRemove: (i: number) => void;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const onDrop = (e: DragEvent, i: number) => { e.preventDefault(); if (drag != null && drag !== i) onReorder(drag, i); setDrag(null); setOver(null); };
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {queue.map((q, i) => {
        const b = owned.find(o => o.x === q.x && o.y === q.y);
        const prior = queue.slice(0, i).filter(qq => qq.x === q.x && qq.y === q.y).length;
        const from = b ? (Number(b.level) || 0) + prior : null;
        const first = i === 0;
        return (
          <Box key={i} draggable onDragStart={e => { setDrag(i); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => { setDrag(null); setOver(null); }}
            onDragOver={e => { e.preventDefault(); if (over !== i) setOver(i); }} onDrop={e => onDrop(e, i)}
            sx={{
              display: 'flex', alignItems: 'center', gap: 1, p: 2, pl: 1, pr: 1, borderRadius: '12px', border: '1px solid',
              borderColor: over === i && drag !== i ? 'accent.emphasis' : first ? 'accent.muted' : 'border.default',
              bg: first ? 'accent.subtle' : 'canvas.default', opacity: drag === i ? 0.5 : 1,
            }}>
            <Box sx={{ display: 'flex', cursor: 'grab', color: 'fg.subtle' }}><Octicon icon={GrabberIcon} /></Box>
            <Text sx={{ width: 16, textAlign: 'center', fontSize: 2, fontWeight: 'semibold', color: first ? 'accent.fg' : 'fg.muted', ...num }}>{i + 1}</Text>
            {b ? <Thumb id={b.id} size={32} /> : <Box sx={{ width: 32 }} />}
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Text as="div" sx={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b ? labelFor(b.id) : '—'}</Text>
              <Text as="div" sx={{ ...muted, ...num }}>{q.x},{q.y}{from != null && ` · ${from}→${from + 1}`}</Text>
              {prices[i] != null && <Text as="div" sx={{ ...muted, ...num }}><CoinValue value={fmt(prices[i]!)} /></Text>}
            </Box>
            <IconButton size="small" variant="invisible" icon={XIcon} aria-label="Убрать из очереди" onClick={() => onRemove(i)} />
          </Box>
        );
      })}
      <Box sx={{ minHeight: 48, px: 3, borderRadius: '12px', border: '1px dashed', borderColor: 'border.default', display: 'grid', placeItems: 'center', textAlign: 'center', ...muted }}>
        Кликните здание на карте, чтобы добавить
      </Box>
    </Box>
  );
}

// ── отложенные действия (строительство/перемещение/снос/реконструкция/реновация) ─────────────
export interface PendingRow { id: number; kind: string; label: string; sprite?: string }
const PENDING_ICON: Record<string, React.ElementType> = { build: PlusIcon, move: ArrowBothIcon, demolish: TrashIcon, reconstruct: IterationsIcon, renovate: StarIcon };
export function PendingList({ rows, disabled, onRemove }: { rows: PendingRow[]; disabled: boolean; onRemove: (id: number) => void }) {
  if (!rows.length) return null;
  return (
    <Box>
      <Caption right={`всего ${rows.length}`}>Ждут выполнения</Caption>
      {rows.map((r, i) => (
        <Box key={r.id} sx={{ display: 'flex', alignItems: 'center', gap: 2, minHeight: 40, borderTop: i ? '1px solid' : 0, borderColor: 'border.muted' }}>
          {r.sprite ? <Thumb id={r.sprite} size={32} /> : <Box sx={{ width: 32, display: 'grid', placeItems: 'center' }}><Octicon icon={PENDING_ICON[r.kind] ?? PlusIcon} /></Box>}
          <Text sx={{ flex: 1, minWidth: 0, fontSize: 1, color: r.kind === 'demolish' ? 'danger.fg' : 'fg.default' }}>{r.label}</Text>
          <IconButton size="small" variant="invisible" icon={XIcon} aria-label="Убрать" disabled={disabled} onClick={() => onRemove(r.id)} />
        </Box>
      ))}
    </Box>
  );
}

// ── Снос: плитки отмеченного ────────────────────────────────────────────────
export function DemolishPanel({ tiles, lossPerHour, disabled, onRemove }: { tiles: { id: number; sprite: string; x: number; y: number; name: string }[]; lossPerHour: number; disabled: boolean; onRemove: (id: number) => void }) {
  return (
    <>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 2 }}>
        {tiles.map(t => (
          <Box key={t.id} as="button" type="button" disabled={disabled} title={`${t.name} — снять отметку`} onClick={() => onRemove(t.id)}
            sx={{ position: 'relative', p: 2, borderRadius: '12px', bg: 'danger.subtle', border: 0, font: 'inherit', cursor: disabled ? 'default' : 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
            <BuildingSprite id={t.sprite} size={48} dim />
            <Text sx={{ fontSize: 0, fontFamily: 'mono', color: 'danger.fg' }}>{t.x},{t.y}</Text>
            <Box sx={{ position: 'absolute', top: '4px', right: '4px', width: 20, height: 20, borderRadius: '50%', bg: 'danger.emphasis', color: 'fg.onEmphasis', display: 'grid', placeItems: 'center' }}><Octicon icon={XIcon} size={12} /></Box>
          </Box>
        ))}
        <Box sx={{ borderRadius: '12px', border: '1px dashed', borderColor: 'border.default', display: 'grid', placeItems: 'center', textAlign: 'center', minHeight: 88, p: 2, ...muted }}>
          {tiles.length ? '+ ещё на карте' : 'Кликайте здания на карте'}
        </Box>
      </Box>
      {tiles.length > 0 && (
        <Box sx={{ display: 'flex', justifyContent: 'space-between', ...muted }}>
          <Text>Потеря дохода</Text><Text sx={{ color: 'danger.fg', ...num }}>−{fmtStat(lossPerHour)}/ч</Text>
        </Box>
      )}
    </>
  );
}

// ── Реновация: сравнение «сейчас → после» ───────────────────────────────────
export function RenovatePanel({ masterplans, items, onToggle, disabled }: {
  masterplans: number; disabled: boolean;
  items: { x: number; y: number; id: string; nextId: string; name: string; nextName: string; cost: number | null; marked: boolean }[];
  onToggle: (x: number, y: number) => void;
}) {
  return (
    <>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text sx={{ color: 'fg.muted' }}>Мастерпланов на складе</Text><CounterLabel scheme="primary">{masterplans}</CounterLabel>
      </Box>
      {items.length === 0 ? <Empty>Нет зданий, подходящих под реновацию</Empty> : items.map(it => (
        <Box key={`${it.x},${it.y}`} sx={{ borderRadius: '12px', bg: it.marked ? 'accent.subtle' : 'canvas.subtle', overflow: 'hidden' }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)', alignItems: 'end', p: 2, gap: 1, textAlign: 'center' }}>
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}><BuildingSprite id={it.id} size={48} dim /><Text sx={{ fontSize: 0 }}>{it.name}</Text></Box>
            <Octicon icon={ArrowRightIcon} sx={{ color: 'fg.muted', mb: 4 }} />
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}><BuildingSprite id={it.nextId} size={48} /><Text sx={{ fontSize: 0, fontWeight: 'semibold' }}>{it.nextName}</Text></Box>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 2, py: 2, bg: 'canvas.default', borderTop: '1px solid', borderColor: 'border.muted' }}>
            <Box sx={{ flex: 1, minWidth: 0, ...muted }}><Text as="div" sx={{ fontFamily: 'mono' }}>{it.x},{it.y}</Text>{it.cost != null && <Text as="div">−{it.cost} мастерпл.</Text>}</Box>
            <Button size="small" variant={it.marked ? 'default' : 'default'} disabled={disabled} onClick={() => onToggle(it.x, it.y)}>{it.marked ? 'Снять' : 'Отметить'}</Button>
          </Box>
        </Box>
      ))}
    </>
  );
}

// ── Ускорители: активные, очередь активации, склад ──────────────────────────
export function BoostersPanel({ boosters, loading, queue, activating, onAdd, onMove, onRemoveAt, onActivate }: {
  boosters: CityBoosterRow[]; loading: boolean; queue: { name: string; label: string }[]; activating: Set<string>;
  onAdd: (name: string) => void; onMove: (i: number, dir: -1 | 1) => void; onRemoveAt: (i: number) => void; onActivate: (name: string) => void;
}) {
  if (loading && boosters.length === 0) return <Spinner size="small" />;
  const active = boosters.filter(b => b.currently_active > 0);
  const queued = (name: string) => queue.filter(q => q.name === name).length;
  return (
    <>
      {active.map(b => (
        <Box key={b.name} sx={{ p: 2, borderRadius: '12px', bg: 'attention.subtle', display: 'flex', alignItems: 'center', gap: 2 }}>
          <Octicon icon={ZapIcon} size={20} sx={{ color: 'attention.fg', flexShrink: 0 }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Text as="div" sx={{ fontWeight: 'semibold' }}>{b.label}</Text>
            <Text sx={muted}>{b.ends_at != null ? `активен, осталось ${fmtTimeLeft(b.ends_at - Date.now())}` : 'активен'}{b.active_limit > 1 && ` · ${b.currently_active}/${b.active_limit}`}</Text>
          </Box>
        </Box>
      ))}
      <Box>
        <Caption right={queue.length ? `${queue.length}` : undefined}>Очередь активации</Caption>
        {queue.length === 0 ? <Empty>Пусто. Бот включает ускорители отсюда по порядку, как только освобождается слот.</Empty> : queue.map((q, i) => (
          <Box key={`${q.name}:${i}`} sx={{ display: 'flex', alignItems: 'center', gap: 2, minHeight: 40, borderTop: i ? '1px solid' : 0, borderColor: 'border.muted' }}>
            <Text sx={{ width: 20, textAlign: 'center', fontWeight: 'semibold', color: i === 0 ? 'accent.fg' : 'fg.muted', ...num }}>{i + 1}</Text>
            <Text sx={{ flex: 1, minWidth: 0, fontSize: 1 }}>{q.label}</Text>
            <IconButton size="small" variant="invisible" icon={ArrowUpIcon} aria-label="Выше" disabled={i === 0} onClick={() => onMove(i, -1)} />
            <IconButton size="small" variant="invisible" icon={ArrowDownIcon} aria-label="Ниже" disabled={i === queue.length - 1} onClick={() => onMove(i, 1)} />
            <IconButton size="small" variant="invisible" icon={XIcon} aria-label="Убрать" onClick={() => onRemoveAt(i)} />
          </Box>
        ))}
      </Box>
      <Box>
        <Caption>На складе</Caption>
        {boosters.length === 0 ? <Empty>Ускорителей в инвентаре нет</Empty> : boosters.map((b, i) => {
          const k = queued(b.name);
          const canActivate = b.available > 0 && b.currently_active < b.active_limit && !b.blocked_by_other;
          return (
            <Box key={b.name} sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, py: 2, borderTop: i ? '1px solid' : 0, borderColor: 'border.muted' }}>
              <Box sx={{ flexBasis: '100%', minWidth: 0 }}>
                <Text as="div" sx={{ fontSize: 1, fontWeight: 'semibold' }}>{b.label}</Text>
                <Text sx={{ ...muted, color: b.blocked_by_other ? 'attention.fg' : 'fg.muted' }}>
                  {b.available} шт.{k > 0 && ` · в очереди ${k}`}{b.blocked_by_other && ' · ждёт другой ускоритель'}
                </Text>
              </Box>
              <Box sx={{ flex: 1 }} />
              <Tooltip text="Активировать сейчас" direction="w">
                <IconButton size="small" variant="invisible" icon={ZapIcon} aria-label={`Активировать ${b.label} сейчас`} disabled={!canActivate || activating.has(b.name)} onClick={() => onActivate(b.name)} />
              </Tooltip>
              <Button size="small" disabled={k >= b.available} onClick={() => onAdd(b.name)}>В очередь</Button>
            </Box>
          );
        })}
      </Box>
    </>
  );
}

// ── Лог и прогноз: таймлайн ─────────────────────────────────────────────────
function dayTitle(ms: number): string {
  const d = new Date(ms), now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 864e5);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Завтра';
  if (diff === -1) return 'Вчера';
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'long' });
}
function byDay<T>(rows: T[], at: (r: T) => number): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = dayTitle(at(r)); if (!m.has(k)) m.set(k, []); m.get(k)!.push(r); }
  return [...m.entries()];
}
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
function TimeRow({ icon, time, title, sub }: { icon: React.ElementType; time: string; title: ReactNode; sub?: ReactNode }) {
  return (
    <Timeline.Item condensed>
      <Timeline.Badge><Octicon icon={icon} /></Timeline.Badge>
      <Timeline.Body sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'baseline', minWidth: 0 }}>
          <Text sx={{ fontFamily: 'mono', fontSize: 0, color: 'fg.muted', flexShrink: 0 }}>{time}</Text>
          <Text sx={{ color: 'fg.default', minWidth: 0 }}>{title}</Text>
        </Box>
        {sub && <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap', fontSize: 0 }}>{sub}</Box>}
      </Timeline.Body>
    </Timeline.Item>
  );
}
const LOG_ICON: Record<string, React.ElementType> = {
  upgrade: ArrowUpIcon, build: PlusCircleIcon, move: ArrowBothIcon, demolish: TrashIcon, reconstruct: IterationsIcon,
  renovate: StarIcon, booster_activate: ZapIcon, booster_combine: ZapIcon, unlock_section: UnlockIcon,
};
export function LogPanel({ rows, loading, label }: { rows: CityActionLogRow[]; loading: boolean; label: (r: CityActionLogRow) => string }) {
  if (loading && rows.length === 0) return <Spinner size="small" />;
  if (rows.length === 0) return <Empty>Лог пуст</Empty>;
  return (
    <>
      {byDay(rows, r => new Date(r.created_at).getTime()).map(([day, list]) => (
        <Box key={day}>
          <Caption>{day}</Caption>
          <Timeline clipSidebar>
            {list.map(r => {
              const text = label(r); const cut = text.indexOf(': ');
              return <TimeRow key={r.id} icon={LOG_ICON[r.type] ?? LogIcon} time={hhmm(new Date(r.created_at).getTime())}
                title={cut > 0 ? text.slice(0, cut) : text} sub={cut > 0 ? <Text sx={{ color: 'fg.muted' }}>{text.slice(cut + 2)}</Text> : undefined} />;
            })}
          </Timeline>
        </Box>
      ))}
    </>
  );
}
export function ForecastPanel({ events, loading, labelFor }: { events: ForecastEvent[]; loading: boolean; labelFor: (id: string) => string }) {
  if (loading) return <Spinner size="small" />;
  if (events.length === 0) return <Empty>Прогноз пуст: в ближайшие трое суток запускать нечего.</Empty>;
  return (
    <>
      {byDay(events, e => e.start).map(([day, list]) => (
        <Box key={day}>
          <Caption>{day}</Caption>
          <Timeline clipSidebar>
            {list.map((e, i) => (
              <TimeRow key={i} icon={GoalIcon} time={hhmm(e.start)} title={`${labelFor(e.building_id)} (${e.x},${e.y})`}
                sub={<>
                  <Text>{e.level_from}→{e.level_to} · {fmtTimeLeft(e.duration_ms)}</Text>
                  {e.boost_multiplier != null && e.boost_multiplier > 1 && <Label variant="attention">ускоритель ×{e.boost_multiplier}</Label>}
                </>} />
            ))}
          </Timeline>
        </Box>
      ))}
    </>
  );
}
