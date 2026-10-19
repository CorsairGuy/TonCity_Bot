// Правый сайдбар карты города: палитра инструментов внизу карты переключает его содержимое,
// сам сайдбар всегда открыт. Здесь — оформление страниц сайдбара, данные и действия приходят из
// CityMapCity.tsx (там же остались Строительство/Перемещение/Реконструкция в прежнем виде).
import { useEffect, useMemo, useState, type ReactNode, type DragEvent } from 'react';
import { Box, Button, Checkbox, CounterLabel, IconButton, Label, Octicon, ProgressBar, Spinner, Text, TextInput, Timeline } from '@primer/react';
import { Tooltip } from '@primer/react/experimental';
import {
  GraphIcon, GoalIcon, StackIcon, ClockIcon, PlusIcon, ArrowBothIcon, TrashIcon, IterationsIcon, StarIcon, ZapIcon, LogIcon,
  QuestionIcon, SearchIcon, XIcon, DashIcon, ChevronDownIcon, ChevronRightIcon, ArrowRightIcon, ArrowUpIcon, ArrowDownIcon,
  GrabberIcon, PlusCircleIcon, UnlockIcon, CheckIcon, UndoIcon, PeopleIcon, SmileyIcon, CheckCircleFillIcon,
} from '@primer/octicons-react';
import type { CityActionMode } from '../components/CityActionsCanvas';
import type { CityStats, ServiceCat, CityStrategyTarget, CityStrategyQueueItem, MapBuilding, BuildingDef, CityBoosterRow, CityActionLogRow, ForecastEvent } from '../api';
import type { CityStatsMods } from '../cityStats';
import { BuildingSprite } from '../components/BuildingSprite';
import { Scrollable } from '../components/Scrollable';
import { CoinValue } from '../components/Icons';
import { fmt } from '../utils';
import { catalogItemImg } from '../hooks/useItemCatalog';

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
      display: 'flex', alignItems: 'center', gap: 2, p: 2, maxWidth: '100%', overflowX: 'auto', scrollbarWidth: 'none',
      bg: 'rgba(22,27,34,.78)', border: '1px solid', borderColor: 'rgba(255,255,255,.18)', borderRadius: '999px',
      boxShadow: '0 8px 24px rgba(0,0,0,.28)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
    }}>
      {CITY_TOOLS.map((grp, gi) => (
        <Box key={gi} sx={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          {grp.map(t => {
            const on = mode === t.mode;
            const onBg = 'accent.emphasis';
            return (
              <Tooltip key={t.mode} text={t.title} direction="n">
                <Box sx={{ position: 'relative' }}>
                  <IconButton icon={t.icon} aria-label={t.title} variant="invisible" onClick={() => onSelect(t.mode)}
                    sx={{
                      width: 36, height: 36, minWidth: 36, p: 0, borderRadius: '10px',
                      '& svg': { width: 18, height: 18, color: on ? 'fg.onEmphasis' : 'rgba(255,255,255,.9)' },
                      ...(on
                        ? { bg: onBg, '&:hover:not([disabled])': { bg: onBg } }
                        : t.danger
                          ? {
                            '&:hover:not([disabled]), &:focus-visible': { bg: 'rgba(248,81,73,.2)', '& svg': { color: '#ff7b72' } },
                          }
                          : {
                            '&:hover:not([disabled])': { bg: 'rgba(255,255,255,.14)' },
                          }),
                    }} />
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

// уровень кисти «Плана» — отдельная плашка справа от дока, в его же стиле
export function MapBrushLevel({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <Tooltip text="Уровень кисти: клик и мазок ставят цель до этого уровня" direction="n">
      <Box role="group" aria-label="Уровень кисти" sx={{
        display: 'flex', alignItems: 'center', gap: 1, p: 1, flexShrink: 0,
        bg: 'canvas.overlay', border: '1px solid', borderColor: 'border.default', borderRadius: '12px', boxShadow: 'shadow.large',
      }}>
        <IconButton icon={DashIcon} aria-label="Ниже" variant="invisible" disabled={value <= 1} onClick={() => onChange(Math.max(1, value - 1))} />
        <Text sx={{ minWidth: 24, textAlign: 'center', fontWeight: 'semibold', ...num }}>{value}</Text>
        <IconButton icon={PlusIcon} aria-label="Выше" variant="invisible" onClick={() => onChange(value + 1)} />
      </Box>
    </Tooltip>
  );
}

// ── каркас сайдбара ─────────────────────────────────────────────────────────
// gap — зазор между блоками содержимого: 8px, как отступы по бокам (Строительство — 16px)
export function PanelShell({ mode, count, hint, actions, footer, gap = 2, children }: { mode: PanelMode; count?: number; hint: ReactNode; actions?: ReactNode; footer?: ReactNode; gap?: number; children: ReactNode }) {
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
        {/* подпись группы при ритме 8px идёт вплотную к своему блоку, при 16px — с прежним отступом */}
        <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap, '& > *': { flexShrink: 0 }, '& .panel-caption': { pb: gap > 2 ? 2 : 0 } }}>
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
    <Box className="panel-caption" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
      <Text sx={{ fontSize: 0, fontWeight: 'semibold', color: 'fg.muted', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{children}</Text>
      {right != null && <Text sx={muted}>{right}</Text>}
    </Box>
  );
}
export function Empty({ children }: { children: ReactNode }) { return <Text sx={muted}>{children}</Text>; }
function Thumb({ id, size = 40, bg = 'canvas.subtle', dim }: { id: string; size?: number; bg?: string; dim?: boolean }) {
  return <Box sx={{ width: size, height: size, borderRadius: '8px', bg, display: 'grid', placeItems: 'center', flexShrink: 0 }}><BuildingSprite id={id} size={size - 8} dim={dim} /></Box>;
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

// ── общие кирпичики страниц в стиле «Плана» ─────────────────────────────────
// Ритм 8 px: карточки со скруглением 12, белые плитки внутри цветной сводки — 8.
// Заливки по состоянию — те же приглушённые цвета, что у шапок карточек «Плана».
const FILL_DANGER = 'var(--bgColor-danger-muted, rgba(255,129,130,.4))';
const FILL_ATTENTION = 'var(--bgColor-attention-muted, rgba(212,167,44,.4))';
const ell = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const;
// градиент из сегментов [цвет, процент], как прогресс в шапке карточки здания
function fillOf(parts: [string, number][]): string {
  let at = 0; const stops: string[] = [];
  for (const [c, p] of parts) { const to = Math.min(100, at + Math.max(0, p)); stops.push(`${c} ${at}% ${to}%`); at = to; }
  stops.push(`transparent ${at}%`);
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}
// цветная сводка сверху (зелёная у «Плана»): фон X.subtle, внутри белые плитки
function Summary({ tone = 'success', children }: { tone?: string; children: ReactNode }) {
  return <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, p: 2, borderRadius: '12px', bg: `${tone}.subtle` }}>{children}</Box>;
}
function Tile({ value, label, color, size = 3 }: { value: ReactNode; label: ReactNode; color?: string; size?: number }) {
  return (
    <Box sx={{ flex: 1, minWidth: 0, p: 2, borderRadius: '8px', bg: 'canvas.default' }}>
      <Text as="div" sx={{ fontSize: size, lineHeight: 1.1, fontWeight: 'semibold', color: color ?? 'fg.default', ...num, ...ell }}>{value}</Text>
      <Text as="div" sx={{ ...muted, ...ell }}>{label}</Text>
    </Box>
  );
}
function SumLine({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, ...muted, ...num }}><Text>{left}</Text>{right != null && <Text>{right}</Text>}</Box>;
}
// карточка-строка, как у здания в «Плане»: миниатюра, название, серая строка, справа — действие
function Row({ lead, title, sub, trail, fill, bg = 'canvas.subtle', onClick, sx, children }: {
  lead?: ReactNode; title: ReactNode; sub?: ReactNode; trail?: ReactNode; fill?: string; bg?: string; onClick?: () => void; sx?: object; children?: ReactNode;
}) {
  return (
    <Box sx={{ borderRadius: '12px', bg, display: 'flex', flexDirection: 'column', ...sx }}>
      <Box onClick={onClick} sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0, p: 2, borderRadius: '12px', backgroundImage: fill, cursor: onClick ? 'pointer' : undefined }}>
        {lead}
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Text sx={{ fontWeight: 'semibold', ...ell }}>{title}</Text>
          {sub != null && <Text sx={{ ...muted, ...num, ...ell }}>{sub}</Text>}
        </Box>
        {trail}
      </Box>
      {children}
    </Box>
  );
}
// плоская строка «как в Строительстве»
function Line({ lead, left, right, sx }: { lead?: ReactNode; left: ReactNode; right?: ReactNode; sx?: object }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minHeight: 36, px: 2, borderRadius: '6px', ...sx }}>
      {lead}
      <Text sx={{ flex: 1, minWidth: 0, fontSize: 1, ...ell }}>{left}</Text>
      {right != null && <Text sx={{ fontSize: 0, fontWeight: 'semibold', flexShrink: 0, display: 'inline-flex', alignItems: 'center', ...num }}>{right}</Text>}
    </Box>
  );
}
function Dashed({ children, h = 48 }: { children: ReactNode; h?: number }) {
  return <Box sx={{ minHeight: h, px: 3, borderRadius: '12px', border: '1px dashed', borderColor: 'border.default', display: 'grid', placeItems: 'center', textAlign: 'center', ...muted }}>{children}</Box>;
}
function IconThumb({ icon, color = 'fg.muted', size = 36 }: { icon: React.ElementType; color?: string; size?: number }) {
  return <Box sx={{ width: size, height: size, borderRadius: '8px', bg: 'canvas.default', display: 'grid', placeItems: 'center', flexShrink: 0, color }}><Octicon icon={icon} /></Box>;
}
function ImgThumb({ src, size = 36, dim }: { src: string | null; size?: number; dim?: boolean }) {
  return (
    <Box sx={{ width: size, height: size, borderRadius: '8px', bg: 'canvas.default', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
      {src && <img src={src} alt="" style={{ width: size - 8, height: size - 8, objectFit: 'contain', opacity: dim ? 0.5 : 1 }} />}
    </Box>
  );
}
// миниатюра здания с бейджем (номер в очереди, значок типа в логе)
function BadgeThumb({ id, badge, badgeBg = 'accent.emphasis', corner = 'tl', dim }: { id: string; badge: ReactNode; badgeBg?: string; corner?: 'tl' | 'br'; dim?: boolean }) {
  return (
    <Box sx={{ position: 'relative', flexShrink: 0 }}>
      <Thumb id={id} size={36} bg="canvas.default" dim={dim} />
      <Box sx={{
        position: 'absolute', ...(corner === 'tl' ? { top: '-4px', left: '-4px' } : { right: '-4px', bottom: '-4px' }),
        minWidth: 18, height: 18, px: '3px', borderRadius: '9px', bg: badgeBg, color: 'fg.onEmphasis', border: '2px solid', borderColor: 'canvas.subtle',
        fontSize: '10px', fontWeight: 'bold', lineHeight: 1, display: 'grid', placeItems: 'center', ...num,
      }}>{badge}</Box>
    </Box>
  );
}
const itemSrc = (tag: string) => `/items/${tag}.png`;
const ItemIcon = ({ tag, size = 14 }: { tag: string; size?: number }) => <img src={itemSrc(tag)} alt="" style={{ width: size, height: size, objectFit: 'contain', verticalAlign: 'middle' }} />;
const Glyph = ({ tag, v }: { tag: string; v: ReactNode }) => <Box as="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}><ItemIcon tag={tag} />{v}</Box>;

// кнопка внизу на всю ширину с белым каунтером (как «Сохранить 45» у Плана)
const COUNT_FG: Record<string, string> = { primary: '#116329', danger: '#a40e26', accent: '#0a3069' };
export function FooterButton({ label, count, icon, tone = 'primary', busy, disabled, onClick }: {
  label: string; count?: number; icon?: React.ElementType; tone?: 'primary' | 'danger' | 'accent'; busy?: boolean; disabled?: boolean; onClick: () => void;
}) {
  const Count = () => <CounterLabel sx={{ bg: '#ffffff', color: COUNT_FG[tone], fontWeight: 'semibold', border: 0 }}>{count}</CounterLabel>;
  const on = { color: 'fg.onEmphasis', borderColor: 'transparent', '& svg': { color: 'fg.onEmphasis' } };
  const sx = disabled || busy ? undefined
    : tone === 'danger' ? { ...on, bg: 'danger.emphasis', '&:hover:not([disabled])': { bg: 'danger.emphasis', filter: 'brightness(1.08)' } }
      : tone === 'accent' ? { ...on, bg: 'accent.emphasis', '&:hover:not([disabled])': { bg: 'accent.emphasis', filter: 'brightness(1.08)' } }
        : undefined;
  // с loading Primer оборачивает кнопку в свой Box — растягиваем и его
  return (
    <Box sx={{ flex: 1, minWidth: 0, '& > *': { width: '100%' } }}>
      <Button variant="primary" block leadingVisual={icon} trailingVisual={count != null ? Count : undefined} loading={busy} disabled={disabled || busy} onClick={onClick} sx={sx}>{label}</Button>
    </Box>
  );
}

// ── Показатели: синяя сводка дохода, жители/счастье и сервисы карточками ───
const SERVICE_LABEL: Record<ServiceCat, string> = { hospital: 'Больницы', 'police-station': 'Полиция', 'fire-station': 'Пожарные', park: 'Парки' };
// спрайт для карточки сервиса — типичное здание этого вида
const SERVICE_SPRITE: Record<ServiceCat, string> = { hospital: 'SER_city_hospital.png', 'police-station': 'SER_city_police.png', 'fire-station': 'SER_fire_station.png', park: 'SER_central_park.png' };
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
    ['Политики', afterPolicy - base, pct((policyMult - 1) * 100), 'success.emphasis'],
    ['Гильдия', afterGuild - afterPolicy, pct(guild * 100), 'done.emphasis'],
    ['Разнообразие', s.profitFinal - afterGuild, pct(diversity * 100), 'attention.emphasis'],
  ];
  const total = parts.reduce((a, p) => a + Math.max(0, p[1]), 0) || 1;
  const gain = s.profitFinal > 0 ? (projected.profitFinal / s.profitFinal - 1) * 100 : 0;
  const people: [React.ElementType, string, string, string, string][] = [
    [PeopleIcon, 'accent.fg', fmtStat(s.population), 'жителей', fmtStat(projected.population)],
    [SmileyIcon, 'success.fg', `${(s.happiness * 100).toFixed(1)}%`, 'счастье', `${(projected.happiness * 100).toFixed(1)}%`],
  ];
  return (
    <>
      <Summary tone="accent">
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Tile value={fmtStat(s.profitFinal)} label="доход в час" color="accent.fg" />
          <Tile value={pct(gain)} label="после плана" color={gain >= 0.5 ? 'success.fg' : 'fg.muted'} />
        </Box>
        <Box sx={{ display: 'flex', height: 8, borderRadius: '4px', overflow: 'hidden', gap: '2px', bg: 'canvas.default' }}>
          {parts.filter(p => p[1] > 0).map(([k, v, , c]) => <Box key={k} sx={{ width: `${v / total * 100}%`, bg: c }} />)}
        </Box>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {parts.map(([k, , v, c]) => (
            <Box key={k} sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, ...muted }}>
              <Box sx={{ width: 8, height: 8, borderRadius: '2px', bg: c, flexShrink: 0 }} />
              <Text sx={{ flex: 1, minWidth: 0, ...ell }}>{k}</Text><Text sx={{ color: 'fg.default', ...num }}>{v}</Text>
            </Box>
          ))}
        </Box>
      </Summary>
      {people.map(([ic, c, v, k, after]) => (
        <Row key={k} lead={<IconThumb icon={ic} color={c} />} title={v} sub={k}
          trail={after !== v ? <Text sx={{ ...muted, ...num, flexShrink: 0 }}>→ {after}</Text> : undefined} />
      ))}
      {(Object.keys(SERVICE_LABEL) as ServiceCat[]).map(k => {
        const v = Math.round(s.serviceRatios[k] * 100);
        const ok = v >= 90;
        return (
          <Row key={k} lead={<Thumb id={SERVICE_SPRITE[k]} size={36} bg="canvas.default" />} title={SERVICE_LABEL[k]}
            sub={v >= 100 ? 'с запасом' : ok ? 'почти хватает' : 'не хватает'} fill={fillOf([[ok ? FILL_DONE : FILL_ATTENTION, Math.min(100, v)]])}
            trail={<Text title={`Покрытие: ${fmtStat(s.coverageByCat[k])}`} sx={{ fontWeight: 'semibold', color: ok ? 'success.fg' : 'attention.fg', ...num }}>{v}%</Text>} />
        );
      })}
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
export function PlanPanel({ targets, owned, labelFor, upgradeCost, onHover, removed, onMarkRemoved }: {
  targets: CityStrategyTarget[]; owned: MapBuilding[]; labelFor: (id: string) => string;
  upgradeCost: (id: string, fromLvl: number, toLvl: number) => number; // монет на улучшения fromLvl → toLvl
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
      {groups.length > 0 && <TextInput placeholder="Поиск" aria-label="Поиск по плану" block value={q} onChange={e => setQ(e.target.value)} />}
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
// ── Очередь улучшений: синяя сводка бюджета и перетаскиваемые карточки ───────
// бюджет прохода — 80% монет (как у бота, modules/progress.js); строка, на которую уже не хватит, серая
export function QueuePanel({ queue, owned, labelFor, prices, balance, onReorder, onRemove }: {
  queue: CityStrategyQueueItem[]; owned: MapBuilding[]; labelFor: (id: string) => string; prices: (number | null)[]; balance: number;
  onReorder: (from: number, to: number) => void; onRemove: (i: number) => void;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const onDrop = (e: DragEvent, i: number) => { e.preventDefault(); if (drag != null && drag !== i) onReorder(drag, i); setDrag(null); setOver(null); };
  const total = prices.reduce((s: number, p) => s + (p ?? 0), 0);
  const budget = balance * 0.8;
  let run = 0;
  const fits = prices.map(p => (run += p ?? 0) <= budget);
  const fitCount = fits.filter(Boolean).length;
  return (
    <>
      {queue.length > 0 && (
        <Summary tone="accent">
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Tile size={2} value={queue.length} label="в очереди" color="accent.fg" />
            <Tile size={2} value={<CoinValue value={fmt(total)} />} label="монет на всё" />
          </Box>
          <PlanBar done={Math.min(budget, total)} wip={0} span={total || 1} size="large" bg="canvas.default" />
          <SumLine left={`хватит на ${fitCount} из ${queue.length}`} right="бюджет 80%" />
        </Summary>
      )}
      {queue.map((q, i) => {
        const b = owned.find(o => o.x === q.x && o.y === q.y);
        const prior = queue.slice(0, i).filter(qq => qq.x === q.x && qq.y === q.y).length;
        const from = b ? (Number(b.level) || 0) + prior : null;
        return (
          <Box key={i} draggable onDragStart={e => { setDrag(i); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => { setDrag(null); setOver(null); }}
            onDragOver={e => { e.preventDefault(); if (over !== i) setOver(i); }} onDrop={e => onDrop(e, i)}
            sx={{
              borderRadius: '12px', opacity: drag === i ? 0.5 : 1, cursor: 'grab',
              boxShadow: over === i && drag !== i ? '0 0 0 2px var(--borderColor-accent-emphasis, #0969da)' : undefined,
              // крестик виден под курсором; на сенсорных экранах — всегда
              '& .q-rm': { opacity: 0 }, '&:hover .q-rm, & .q-rm:focus-visible': { opacity: 1 }, '@media (hover: none)': { '& .q-rm': { opacity: 1 } },
            }}>
            <Row lead={b ? <BadgeThumb id={b.id} badge={i + 1} badgeBg={i === 0 ? 'accent.emphasis' : 'neutral.emphasis'} /> : <Box sx={{ width: 36 }} />}
              title={b ? labelFor(b.id) : '—'} fill={i === 0 ? fillOf([[FILL_WIP, 100]]) : undefined}
              sub={<>{from != null ? `${from} → ${from + 1}` : `${q.x},${q.y}`}{prices[i] != null && <> · {fits[i] ? <CoinValue value={fmt(prices[i]!)} /> : <Text sx={{ color: 'attention.fg' }}>не хватит</Text>}</>}</>}
              trail={<IconButton className="q-rm" size="small" variant="invisible" icon={XIcon} aria-label="Убрать из очереди" onClick={() => onRemove(i)} />} />
          </Box>
        );
      })}
      <Dashed>Кликните здание на карте, чтобы добавить</Dashed>
    </>
  );
}

// ── отложенные действия (строительство/перемещение/снос/реконструкция/реновация) ─────────────
export interface PendingRow { id: number; kind: string; label: string; sprite?: string }
const PENDING_ICON: Record<string, React.ElementType> = { build: PlusIcon, move: ArrowBothIcon, demolish: TrashIcon, reconstruct: IterationsIcon, renovate: StarIcon };
export function PendingList({ rows, disabled, onRemove }: { rows: PendingRow[]; disabled: boolean; onRemove: (id: number) => void }) {
  if (!rows.length) return null;
  return (
    <>
      <Caption right={`всего ${rows.length}`}>Ждут выполнения</Caption>
      {rows.map(r => (
        <Row key={r.id} lead={r.sprite ? <Thumb id={r.sprite} size={36} bg="canvas.default" dim={r.kind === 'demolish'} /> : <IconThumb icon={PENDING_ICON[r.kind] ?? PlusIcon} />}
          title={r.label.split(': ')[0]} sub={r.label.split(': ').slice(1).join(': ')}
          trail={<IconButton size="small" variant="invisible" icon={XIcon} aria-label="Убрать" disabled={disabled} onClick={() => onRemove(r.id)} />} />
      ))}
    </>
  );
}

// ── Перемещение: «откуда» карточкой, «куда» пунктиром, ниже готовые пары ─────
export function MovePanel({ from, moves, labelFor, disabled, onCancel, onRemove }: {
  from: { x: number; y: number; id?: string; level?: number } | null;
  moves: { id: number; sprite?: string; from: { x: number; y: number }; to: { x: number; y: number } }[];
  labelFor: (id: string) => string; disabled: boolean; onCancel: () => void; onRemove: (id: number) => void;
}) {
  return (
    <>
      {from ? (
        <>
          <Row lead={from.id ? <Thumb id={from.id} size={36} bg="canvas.default" /> : <IconThumb icon={ArrowBothIcon} />} title={from.id ? labelFor(from.id) : '—'}
            sub={`откуда ${from.x},${from.y}${from.level ? ` · ур. ${from.level}` : ''}`} fill={fillOf([[FILL_WIP, 100]])}
            trail={<IconButton size="small" variant="invisible" icon={XIcon} aria-label="Отменить выбор" onClick={onCancel} />} />
          <Box sx={{ display: 'grid', placeItems: 'center', color: 'fg.muted' }}><Octicon icon={ArrowDownIcon} /></Box>
          <Dashed h={52}>Куда? Кликните пустую клетку</Dashed>
        </>
      ) : <Dashed h={52}>Кликните здание, которое хотите переместить</Dashed>}
      {moves.length > 0 && <Caption right={`всего ${moves.length}`}>Ждут выполнения</Caption>}
      {moves.map(m => (
        <Row key={m.id} lead={m.sprite ? <Thumb id={m.sprite} size={36} bg="canvas.default" /> : <IconThumb icon={ArrowBothIcon} />} title={m.sprite ? labelFor(m.sprite) : 'Перемещение'}
          sub={`${m.from.x},${m.from.y} → ${m.to.x},${m.to.y}`}
          trail={<IconButton size="small" variant="invisible" icon={XIcon} aria-label="Убрать" disabled={disabled} onClick={() => onRemove(m.id)} />} />
      ))}
    </>
  );
}

// ── Снос: красная сводка потерь и строки с долей потери дохода ──────────────
export interface DemolishTile { id: number; sprite: string; x: number; y: number; name: string; level: number; loss: number }
export function DemolishPanel({ tiles, lossPerHour, popLoss, income, disabled, onRemove }: {
  tiles: DemolishTile[]; lossPerHour: number; popLoss: number; income: number; disabled: boolean; onRemove: (id: number) => void;
}) {
  const max = Math.max(1, ...tiles.map(t => t.loss));
  return (
    <>
      {tiles.length > 0 && (
        <Summary tone="danger">
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Tile size={2} value={tiles.length} label="зданий" />
            <Tile size={2} value={`−${fmt(lossPerHour)}`} label="дохода в час" color="danger.fg" />
          </Box>
          <SumLine left={popLoss > 0 ? `жителей −${fmt(popLoss)}` : 'жители без изменений'} right={income > 0 ? `−${(lossPerHour / income * 100).toFixed(1)}% дохода` : undefined} />
        </Summary>
      )}
      {[...tiles].sort((a, b) => b.loss - a.loss).map(t => (
        <Row key={t.id} lead={<Thumb id={t.sprite} size={36} bg="canvas.default" dim />} title={t.name}
          sub={<>ур. {t.level} · {t.loss > 0 ? <Text sx={{ color: 'danger.fg' }}>−{fmt(t.loss)}/ч</Text> : `${t.x},${t.y}`}</>}
          fill={fillOf([[FILL_DANGER, t.loss / max * 100]])}
          trail={<IconButton size="small" variant="invisible" icon={XIcon} aria-label="Снять отметку" disabled={disabled} onClick={() => onRemove(t.id)} />} />
      ))}
      <Dashed>Кликните или проведите кистью по зданиям</Dashed>
    </>
  );
}

// ── Реконструкция: группы по типу здания, внутри полосы уровней до нужного ──
// Клетка готова — клик отмечает реконструкцию сейчас (кнопка «Выполнить»), не готова — ставит в план:
// бот сам отправит её, когда здание дорастёт и освободится от стройки.
export interface ReconCell { x: number; y: number; level: number; req: number; building: boolean; ready: boolean; queued: boolean; planned: boolean }
export interface ReconGroup { id: string; name: string; comp: number | null; gain: number | null; cells: ReconCell[] }
export function ReconstructPanel({ groups, components, disabled, onToggle }: { groups: ReconGroup[]; components: number; disabled: boolean; onToggle: (x: number, y: number) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const cells = groups.flatMap(g => g.cells.map(c => ({ ...c, g })));
  const ready = cells.filter(c => c.ready).length;
  const queued = cells.filter(c => c.queued);
  const spend = queued.reduce((s, c) => s + (c.g.comp ?? 0), 0), gain = queued.reduce((s, c) => s + (c.g.gain ?? 0), 0);
  if (groups.length === 0) return <Empty>В городе нет зданий, которые умеют реконструироваться.</Empty>;
  const shownOpen = open ?? groups[0].id;
  return (
    <>
      <Summary>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Tile size={2} value={`${ready}/${cells.length}`} label="готовы" color="success.fg" />
          <Tile size={2} value={<Box as="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}><ItemIcon tag="component" size={18} />{components}</Box>} label="компонентов" />
        </Box>
        <PlanBar done={ready} wip={0} span={cells.length} size="large" bg="canvas.default" />
        <SumLine left={queued.length ? <>отмечено {queued.length}: <Glyph tag="component" v={`−${spend}`} /> <Glyph tag="masterplan" v={`+${gain}`} /></> : 'отметьте готовые здания'}
          right={cells.some(c => c.planned) ? `в плане ${cells.filter(c => c.planned).length}` : undefined} />
      </Summary>
      {groups.map(g => {
        const ok = g.cells.filter(c => c.ready).length; const o = shownOpen === g.id;
        return (
          <Row key={g.id} lead={<Thumb id={g.id} size={36} bg="canvas.default" />} title={g.name} onClick={() => setOpen(o ? '' : g.id)}
            sub={<>{ok}/{g.cells.length} готовы{g.comp != null && <> · <Glyph tag="component" v={`−${g.comp}`} /></>}{g.gain != null && <> <Glyph tag="masterplan" v={`+${g.gain}`} /></>}</>}
            fill={fillOf([[FILL_DONE, ok / g.cells.length * 100]])} trail={<Octicon icon={o ? ChevronDownIcon : ChevronRightIcon} sx={{ color: 'fg.muted', flexShrink: 0 }} />}>
            {o && (
              <Box sx={{ display: 'flex', flexDirection: 'column', p: 1 }}>
                {g.cells.map(c => {
                  const span = Math.max(1, c.req - 1);
                  const done = Math.max(0, Math.min(c.level, c.req) - 1);
                  const state = c.queued ? <Octicon icon={CheckCircleFillIcon} size={14} sx={{ color: 'success.fg' }} />
                    : c.planned ? <Octicon icon={ClockIcon} size={14} sx={{ color: 'accent.fg' }} />
                      : <Box sx={{ width: 14, height: 14, borderRadius: '50%', border: '1px solid', borderColor: 'border.default' }} />;
                  return (
                    <Box key={`${c.x},${c.y}`} as="button" type="button" disabled={disabled} onClick={() => onToggle(c.x, c.y)}
                      title={c.queued ? 'Отмечено: выполнится кнопкой внизу' : c.planned ? 'В плане: бот сделает сам. Клик — убрать' : c.ready ? 'Отметить к реконструкции' : 'Поставить в план'}
                      sx={{ display: 'flex', alignItems: 'center', gap: 2, height: 28, px: 1, border: 0, borderRadius: '6px', bg: 'transparent', font: 'inherit', color: 'fg.default', cursor: 'pointer', '&:hover': { bg: 'canvas.default' } }}>
                      {state}
                      <PlanBar done={done} wip={c.building && c.level < c.req ? 1 : 0} span={span} />
                      <Text sx={{ fontSize: 0, width: 40, textAlign: 'right', color: c.ready ? 'success.fg' : 'fg.muted', ...num }}>{c.level}/{c.req}</Text>
                    </Box>
                  );
                })}
              </Box>
            )}
          </Row>
        );
      })}
    </>
  );
}

// ── Реновация: мастерпланы кубиками и плотный список с галочками ────────────
export function RenovatePanel({ masterplans, items, incomeGain, onToggle, disabled }: {
  masterplans: number; disabled: boolean; incomeGain: number;
  items: { x: number; y: number; id: string; nextId: string; name: string; nextName: string; cost: number | null; marked: boolean }[];
  onToggle: (x: number, y: number) => void;
}) {
  const used = items.filter(i => i.marked).reduce((s, i) => s + (i.cost ?? 0), 0);
  const left = masterplans - used;
  return (
    <>
      <Box sx={{ p: 2, borderRadius: '12px', bg: 'canvas.subtle', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <ItemIcon tag="masterplan" size={28} />
          <Text sx={{ fontSize: 3, fontWeight: 'semibold', color: left < 0 ? 'danger.fg' : 'fg.default', ...num }}>{left}</Text>
          <Text sx={muted}>из {masterplans} свободно</Text>
        </Box>
        {/* до 30 мастерпланов — кубиками, больше — сплошной полосой */}
        {masterplans > 0 && masterplans <= 30
          ? <Box sx={{ display: 'flex', gap: '2px' }}>{Array.from({ length: masterplans }, (_, k) => <Box key={k} sx={{ flex: 1, height: 8, borderRadius: '2px', bg: k < used ? 'done.emphasis' : 'neutral.muted' }} />)}</Box>
          : <ProgressBar barSize="small" progress={masterplans ? Math.min(100, used / masterplans * 100) : 0} bg="done.emphasis" aria-label="Мастерпланы" />}
      </Box>
      {items.length === 0 ? <Empty>Нет зданий, подходящих под реновацию</Empty> : (
        <Box>
          {items.map(it => {
            const can = it.marked || (it.cost ?? 0) <= left;
            return (
              <Box key={`${it.x},${it.y}`} as="label" sx={{ display: 'flex', alignItems: 'center', gap: 2, minHeight: 36, px: 2, borderRadius: '6px', cursor: can && !disabled ? 'pointer' : 'default', bg: it.marked ? 'done.subtle' : undefined }}
                title={`${it.name} (${it.x},${it.y}) → ${it.nextName}`}>
                <Checkbox checked={it.marked} disabled={disabled || !can} onChange={() => onToggle(it.x, it.y)} />
                <Text sx={{ flex: 1, minWidth: 0, fontSize: 1, color: can ? 'fg.default' : 'fg.muted', ...ell }}>{it.nextName}</Text>
                {can ? <Text sx={{ fontSize: 0, fontWeight: 'semibold', flexShrink: 0, ...num }}><Glyph tag="masterplan" v={it.cost ?? '?'} /></Text> : <Label variant="secondary">мало</Label>}
              </Box>
            );
          })}
        </Box>
      )}
      {incomeGain > 0 && <SumLine left="доход после реновации" right={<Text sx={{ color: 'success.fg' }}>+{fmt(incomeGain)}/ч</Text>} />}
    </>
  );
}

// ── Ускорители: активный жёлтой карточкой, очередь и склад карточками ───────
export function BoostersPanel({ boosters, loading, queue, activating, onAdd, onReorder, onRemoveAt, onActivate }: {
  boosters: CityBoosterRow[]; loading: boolean; queue: { name: string; label: string }[]; activating: Set<string>;
  onAdd: (name: string) => void; onReorder: (from: number, to: number) => void; onRemoveAt: (i: number) => void; onActivate: (name: string) => void;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  if (loading && boosters.length === 0) return <Spinner size="small" />;
  const active = boosters.filter(b => b.currently_active > 0);
  const queued = (name: string) => queue.filter(q => q.name === name).length;
  const img = (name: string) => catalogItemImg(Number(name));
  const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  return (
    <>
      {active.map(b => (
        <Row key={b.name} lead={<ImgThumb src={img(b.name)} />} title={b.label} bg="attention.subtle"
          sub={<>{b.ends_at != null ? `активен · ещё ${fmtTimeLeft(b.ends_at - Date.now())}` : 'активен'}{b.active_limit > 1 && ` · ${b.currently_active}/${b.active_limit}`}</>}
          trail={b.ends_at != null ? <Text sx={{ fontFamily: 'mono', fontWeight: 'semibold', fontSize: 1, color: 'attention.fg', flexShrink: 0 }}>{hhmm(b.ends_at)}</Text> : undefined} />
      ))}
      <Caption right={queue.length ? `${queue.length}` : undefined}>Очередь</Caption>
      {queue.length === 0 ? <Dashed>Пусто. Бот включает ускорители отсюда по порядку, как только освобождается слот.</Dashed> : queue.map((q, i) => (
        <Box key={`${q.name}:${i}`} draggable onDragStart={e => { setDrag(i); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDrag(null)}
          onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (drag != null && drag !== i) onReorder(drag, i); setDrag(null); }}
          sx={{ opacity: drag === i ? 0.5 : 1 }}>
          <Row lead={<ImgThumb src={img(q.name)} />} title={q.label} sub={i === 0 ? '#1 · следующий' : `#${i + 1}`} fill={i === 0 ? fillOf([[FILL_WIP, 100]]) : undefined}
            trail={<>
              <IconButton size="small" variant="invisible" icon={XIcon} aria-label="Убрать из очереди" onClick={() => onRemoveAt(i)} />
              <Box sx={{ color: 'fg.subtle', display: 'flex', cursor: 'grab' }}><Octicon icon={GrabberIcon} /></Box>
            </>} />
        </Box>
      ))}
      <Caption>На складе</Caption>
      {boosters.length === 0 ? <Empty>Ускорителей в инвентаре нет</Empty> : boosters.map(b => {
        const k = queued(b.name);
        const canActivate = b.available > 0 && b.currently_active < b.active_limit && !b.blocked_by_other;
        return (
          <Row key={b.name} lead={<ImgThumb src={img(b.name)} dim={!b.available} />} title={b.label}
            sub={<Text sx={{ color: b.blocked_by_other && b.available ? 'attention.fg' : 'fg.muted' }}>
              {b.available ? `${b.available} шт.` : 'нет на складе'}{k > 0 && ` · в очереди ${k}`}{b.blocked_by_other && b.available > 0 && ' · ждёт другой'}
            </Text>}
            trail={<>
              {/* у IconButton своя подсказка из aria-label; Tooltip вокруг выключенной кнопки Primer не принимает */}
              <IconButton size="small" variant="invisible" icon={ZapIcon} aria-label="Активировать сейчас" disabled={!canActivate || activating.has(b.name)} onClick={() => onActivate(b.name)} />
              <IconButton size="small" variant="invisible" icon={PlusIcon} aria-label="В очередь" disabled={k >= b.available} onClick={() => onAdd(b.name)} />
            </>} />
        );
      })}
    </>
  );
}

// ── Лог и прогноз: карточки по дням ─────────────────────────────────────────
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
const Time = ({ ms, sub }: { ms: number; sub?: ReactNode }) => (
  <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px', alignSelf: 'flex-start', flexShrink: 0 }}>
    <Text sx={{ fontFamily: 'mono', fontSize: 0, fontWeight: 'semibold', color: 'fg.muted' }}>{hhmm(ms)}</Text>{sub}
  </Box>
);
// тип действия: название, значок и цвет бейджа на миниатюре
const LOG_TYPE: Record<string, [string, React.ElementType, string]> = {
  upgrade: ['Улучшение', ArrowUpIcon, 'success.emphasis'], build: ['Постройка', PlusCircleIcon, 'accent.emphasis'],
  move: ['Перемещение', ArrowBothIcon, 'accent.emphasis'], demolish: ['Снос', TrashIcon, 'danger.emphasis'],
  reconstruct: ['Реконструкция', IterationsIcon, 'done.emphasis'], renovate: ['Реновация', StarIcon, 'done.emphasis'],
  booster_activate: ['Ускоритель', ZapIcon, 'attention.emphasis'], booster_combine: ['Комбинирование', ZapIcon, 'attention.emphasis'],
  unlock_section: ['Секция', UnlockIcon, 'neutral.emphasis'],
};
export function LogPanel({ rows, loading, label, labelFor }: { rows: CityActionLogRow[]; loading: boolean; label: (r: CityActionLogRow) => string; labelFor: (id: string) => string }) {
  if (loading && rows.length === 0) return <Spinner size="small" />;
  if (rows.length === 0) return <Empty>Лог пуст</Empty>;
  return (
    <>
      {byDay(rows, r => new Date(r.created_at).getTime()).map(([day, list]) => (
        <Box key={day} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Caption right={`${list.length}`}>{day}</Caption>
          {list.map(r => {
            const [kind, ic, badge] = LOG_TYPE[r.type] ?? [r.type, LogIcon, 'neutral.emphasis'];
            const text = label(r); const cut = text.indexOf(': ');
            // у ускорителей building_id — тип ускорителя, а не здание: спрайта нет, только значок
            const sprite = r.building_id && !r.type.startsWith('booster') ? r.building_id : null;
            const isUp = r.type === 'upgrade' && sprite;
            return (
              <Row key={r.id} lead={sprite ? <BadgeThumb id={sprite} badge={<Octicon icon={ic} size={10} />} badgeBg={badge} corner="br" dim={r.type === 'demolish'} /> : <IconThumb icon={ic} color={badge.replace('emphasis', 'fg')} />}
                title={isUp ? labelFor(sprite!) : kind} bg={r.type === 'demolish' ? 'danger.subtle' : 'canvas.subtle'}
                sub={isUp ? `${r.level_from} → ${r.level_to}${r.duration_ms ? ` · ${fmtTimeLeft(r.duration_ms)}` : ''}` : (cut > 0 ? text.slice(cut + 2) : text)}
                trail={<Time ms={new Date(r.created_at).getTime()} />} />
            );
          })}
        </Box>
      ))}
    </>
  );
}
// стройка под ускорителем залита жёлтым и подписана множителем
export function ForecastPanel({ events, loading, labelFor }: { events: ForecastEvent[]; loading: boolean; labelFor: (id: string) => string }) {
  if (loading) return <Spinner size="small" />;
  if (events.length === 0) return <Empty>Прогноз пуст: в ближайшие трое суток запускать нечего.</Empty>;
  return (
    <>
      {byDay(events, e => e.start).map(([day, list]) => (
        <Box key={day} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Caption right={`${list.length} ул.`}>{day}</Caption>
          {list.map((e, i) => {
            const boost = e.boost_multiplier != null && e.boost_multiplier > 1 ? e.boost_multiplier : null;
            return (
              <Row key={i} lead={<Thumb id={e.building_id} size={36} bg="canvas.default" />} title={labelFor(e.building_id)} fill={boost ? fillOf([[FILL_ATTENTION, 100]]) : undefined}
                sub={`${e.level_from} → ${e.level_to} · ${fmtTimeLeft(e.duration_ms)}`}
                trail={<Time ms={e.start} sub={boost ? <Text title={e.boost_name ?? undefined} sx={{ fontSize: 0, fontWeight: 'semibold', color: 'attention.fg' }}>×{boost}</Text> : undefined} />} />
            );
          })}
        </Box>
      ))}
    </>
  );
}
