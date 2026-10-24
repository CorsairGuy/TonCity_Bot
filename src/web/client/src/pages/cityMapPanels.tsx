// Правый сайдбар карты города: палитра инструментов внизу карты переключает его содержимое,
// сам сайдбар всегда открыт. Здесь — оформление страниц сайдбара, данные и действия приходят из
// CityMapCity.tsx (там же остались Строительство/Перемещение/Реконструкция в прежнем виде).
import { useEffect, useMemo, useRef, useState, type ReactNode, type DragEvent } from 'react';
import { Box, Button, CounterLabel, IconButton, Octicon, ProgressBar, Spinner, Text, TextInput, Timeline } from '@primer/react';
import { Tooltip } from '@primer/react/experimental';
import {
  GraphIcon, GoalIcon, StackIcon, ClockIcon, PlusIcon, ArrowBothIcon, TrashIcon, IterationsIcon, StarIcon, ZapIcon, LogIcon,
  QuestionIcon, SearchIcon, XIcon, DashIcon, ArrowRightIcon, ArrowUpIcon,
  PlusCircleIcon, UnlockIcon, CheckIcon, PeopleIcon, SmileyIcon, CheckCircleFillIcon, RocketIcon,
} from '@primer/octicons-react';
import type { CityActionMode } from '../components/CityActionsCanvas';
import type { CityStats, ServiceCat, CityStrategyTarget, CityStrategyQueueItem, MapBuilding, BuildingDef, CityBoosterRow, CityActiveBooster, CityActionLogRow, ForecastEvent } from '../api';
import type { CityStatsMods } from '../cityStats';
import { BuildingSprite } from '../components/BuildingSprite';
import { Scrollable } from '../components/Scrollable';
import { CoinValue, CrystalValue } from '../components/Icons';
import { fmt, ITEMS_BY_ID } from '../utils';
import { catalogItemImg } from '../hooks/useItemCatalog';

export type PanelMode = CityActionMode;

// ── палитра ──────────────────────────────────────────────────────────────────
interface Tool { mode: PanelMode; icon: React.ElementType; title: string; danger?: boolean }
export const CITY_TOOLS: Tool[][] = [
  [{ mode: 'view', icon: GraphIcon, title: 'Показатели' }],
  [{ mode: 'upgrade', icon: GoalIcon, title: 'План' }, { mode: 'queue', icon: StackIcon, title: 'Очередь' }, { mode: 'forecast', icon: ClockIcon, title: 'Прогноз' }],
  [{ mode: 'build', icon: PlusIcon, title: 'Строительство' }, { mode: 'move', icon: ArrowBothIcon, title: 'Перемещение' }, { mode: 'demolish', icon: TrashIcon, title: 'Снос', danger: true }],
  [{ mode: 'reconstruct', icon: IterationsIcon, title: 'Реконструкция' }, { mode: 'renovate', icon: StarIcon, title: 'Реновация' }, { mode: 'boosters', icon: ZapIcon, title: 'Ускорители' }],
  [{ mode: 'log', icon: LogIcon, title: 'Лог' }],
];
// у столицы нет реконструкции/реновации/ускорителей, зато есть ускорение стройки за алмазы
export const CAPITAL_TOOLS: Tool[][] = [
  [{ mode: 'view', icon: GraphIcon, title: 'Показатели' }],
  [{ mode: 'upgrade', icon: GoalIcon, title: 'План' }, { mode: 'queue', icon: StackIcon, title: 'Очередь' }, { mode: 'forecast', icon: ClockIcon, title: 'Прогноз' }],
  [{ mode: 'build', icon: PlusIcon, title: 'Строительство' }, { mode: 'move', icon: ArrowBothIcon, title: 'Перемещение' }, { mode: 'demolish', icon: TrashIcon, title: 'Снос', danger: true }],
  [{ mode: 'skip', icon: RocketIcon, title: 'Ускорить' }],
  [{ mode: 'log', icon: LogIcon, title: 'Лог' }],
];
export const toolFor = (m: PanelMode): Tool => [...CITY_TOOLS, ...CAPITAL_TOOLS].flat().find(t => t.mode === m) ?? CITY_TOOLS[0][0];

// стекло дока и плашки кисти — общее: обе висят на карте, непрозрачный overlay её закрывал бы
const DOCK_GLASS = {
  display: 'flex', alignItems: 'center', p: 2, flexShrink: 0,
  bg: 'rgba(22,27,34,.5)', border: '1px solid', borderColor: 'rgba(255,255,255,.1)',
  borderRadius: '19px', boxShadow: 'shadow.large',
  backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
} as const;
// кнопка дока 36×36, радиус 10: капсула 19 = 10 + поле 8 + рамка 1 (углы концентричны)
const dockBtn = (on = false) => ({
  width: 36, height: 36, minWidth: 36, p: 0, borderRadius: '10px',
  '& svg': { width: 18, height: 18, color: on ? 'fg.onEmphasis' : 'rgba(255,255,255,.9)' },
});

// на сенсорном экране фокус после тапа остаётся на кнопке, и её подсказка висит, пока не тапнешь в другое место
export function blurOnTouch(el: HTMLElement) {
  if (window.matchMedia('(hover: none)').matches) el.blur();
}

function PaletteTool({ t, on, dot, onSelect }: { t: Tool; on: boolean; dot: boolean; onSelect: (m: PanelMode) => void }) {
  const onBg = 'accent.emphasis';
  return (
    <Box sx={{ display: 'flex', lineHeight: 0, position: 'relative', flexShrink: 0, '& > span': { display: 'flex', lineHeight: 0 } }}>
      <Tooltip text={t.title} direction="n">
        <IconButton icon={t.icon} aria-label={t.title} variant="invisible" size="medium"
          onClick={e => { onSelect(t.mode); blurOnTouch(e.currentTarget); }}
          sx={{
            ...dockBtn(on),
            ...(on
              ? { bg: onBg, '&:hover:not([disabled])': { bg: onBg } }
              : t.danger
                ? { '&:hover:not([disabled]), &:focus-visible': { bg: 'danger.subtle', '& svg': { color: 'danger.fg' } } }
                : { '&:hover:not([disabled])': { bg: 'rgba(255,255,255,.14)' } }),
          }} />
      </Tooltip>
      {dot && !on && <Box sx={{ position: 'absolute', top: '4px', right: '4px', width: 6, height: 6, borderRadius: '50%', bg: 'accent.emphasis', pointerEvents: 'none' }} />}
    </Box>
  );
}

export function MapPalette({ mode, onSelect, dots, tools = CITY_TOOLS }: { mode: PanelMode; onSelect: (m: PanelMode) => void; dots: Partial<Record<PanelMode, boolean>>; tools?: Tool[][] }) {
  // в стиле дока macOS: без линий-разделителей, кнопки внутри группы через 4px, группы — через 20px
  // (4 + пустой зазор 12 + 4). Tooltip — inline-span, без flex/lineHeight:0 снизу появляется strut
  // и нижнее поле перестаёт быть 8px.
  return (
    <Box sx={{
      ...DOCK_GLASS, gap: 1, maxWidth: '100%', overflowX: 'auto',
      scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' },
      // телефон: 12 кнопок в ширину не влезают — переносим во второй ряд, а не листаем со скрытой
      // полосой (часть режимов и даже активная кнопка оказывались за краем)
      '@media (max-width: 768px)': { flexWrap: 'wrap', justifyContent: 'center', overflowX: 'visible', rowGap: 1 },
    }}>
      {tools.flatMap((grp, gi) => [
        gi > 0 ? <Box key={`gap-${gi}`} aria-hidden sx={{ width: 12, flexShrink: 0 }} /> : null,
        ...grp.map(t => (
          <PaletteTool key={t.mode} t={t} on={mode === t.mode} dot={!!dots[t.mode]} onSelect={onSelect} />
        )),
      ])}
    </Box>
  );
}

// уровень кисти «Плана» — отдельная плашка справа от дока, из того же стекла и той же высоты
export function MapBrushLevel({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const btn = { ...dockBtn(), '&:hover:not([disabled])': { bg: 'rgba(255,255,255,.14)' }, '&[disabled] svg': { color: 'rgba(255,255,255,.35)' } };
  return (
    <Tooltip text="Уровень кисти: клик и мазок ставят цель до этого уровня" direction="n">
      <Box role="group" aria-label="Уровень кисти" sx={{ ...DOCK_GLASS, gap: 1 }}>
        <IconButton icon={DashIcon} aria-label="Ниже" variant="invisible" size="medium" disabled={value <= 1} onClick={() => onChange(Math.max(1, value - 1))} sx={btn} />
        <Text sx={{ minWidth: 24, textAlign: 'center', fontWeight: 'semibold', color: 'rgba(255,255,255,.9)', ...num }}>{value}</Text>
        <IconButton icon={PlusIcon} aria-label="Выше" variant="invisible" size="medium" onClick={() => onChange(value + 1)} sx={btn} />
      </Box>
    </Tooltip>
  );
}

// ── каркас сайдбара ─────────────────────────────────────────────────────────
// gap — зазор между блоками содержимого: 8px, как отступы по бокам (Строительство — 16px)
export function PanelShell({ mode, title, hint, actions, footer, gap = 2, children }: { mode: PanelMode; title?: ReactNode; hint: ReactNode; actions?: ReactNode; footer?: ReactNode; gap?: number; children: ReactNode }) {
  const [help, setHelp] = useState(false);
  const t = toolFor(mode);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, bg: 'canvas.default' }}>
      <Box sx={{ height: 48, flexShrink: 0, pl: 3, pr: 2, display: 'flex', alignItems: 'center', gap: 2, borderBottom: '1px solid', borderColor: 'border.default' }}>
        <Text sx={{ fontWeight: 'semibold', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title ?? t.title}</Text>
        {actions}
        <IconButton size="small" variant="invisible" icon={QuestionIcon} aria-label="Подсказка" aria-pressed={help} onClick={() => setHelp(h => !h)}
          sx={help ? { bg: 'accent.subtle', '& svg': { color: 'accent.fg' } } : undefined} />
      </Box>
      {/* полоса прокрутки поверх содержимого (как в прежнем сайдбаре) — отступ ровно 8px со всех сторон */}
      <Scrollable>
        {/* подпись группы при ритме 8px идёт вплотную к своему блоку, при 16px — с прежним отступом */}
        {/* подсказка всегда в 8px от содержимого, даже когда блоки идут через 16px (Строительство) */}
        <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {help && <Text as="p" sx={{ m: 0, fontSize: 0, color: 'fg.muted', bg: 'canvas.subtle', p: 2, borderRadius: 2 }}>{hint}</Text>}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap, '& > *': { flexShrink: 0 }, '& .panel-caption': { pb: gap > 2 ? 2 : 0 } }}>{children}</Box>
        </Box>
      </Scrollable>
      {footer && <Box sx={{ flexShrink: 0, p: 2, display: 'flex', flexDirection: 'column', gap: 2, borderTop: '1px solid', borderColor: 'border.default' }}>{footer}</Box>}
    </Box>
  );
}

const muted = { fontSize: 0, color: 'fg.muted' } as const;
// вторая строка карточки: светлее серой подписи, но не белая (--fg-sub в global.css, своя для каждой темы)
const sub2 = { fontSize: 0, color: 'var(--fg-sub)', lineHeight: '16px' } as const;
const num = { fontVariantNumeric: 'tabular-nums' } as const;
// строка обрезается до высоты заглавных — подпись встаёт ровно по центру между карточками
const CAP_TRIM = { textBox: 'trim-both cap alphabetic' } as const;
// подпись группы: 8px от краёв карточек слева и справа, число справа — без значков
export function Caption({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <Box className="panel-caption" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, px: 2, my: 1 }}>
      <Text sx={{ fontSize: 0, lineHeight: 1, fontWeight: 'semibold', color: 'fg.muted', textTransform: 'uppercase', letterSpacing: '0.04em', minWidth: 0, ...ell, ...CAP_TRIM }}>{children}</Text>
      {right != null && <Text sx={{ ...muted, lineHeight: 1, flexShrink: 0, ...num, ...CAP_TRIM }}>{right}</Text>}
    </Box>
  );
}
export function Empty({ children }: { children: ReactNode }) { return <Text sx={muted}>{children}</Text>; }
export function Thumb({ id, size = 40, bg = 'canvas.subtle', dim }: { id: string; size?: number; bg?: string; dim?: boolean }) {
  return <Box sx={{ width: size, height: size, borderRadius: '8px', bg, display: 'grid', placeItems: 'center', flexShrink: 0 }}><BuildingSprite id={id} size={size - 8} dim={dim} /></Box>;
}
// тот же формат, что во всей панели (fmt, 1 знак): раньше карта писала 55.27M, а таблицы — 55.3M
export const fmtStat = (n: number): string => fmt(n);
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
const FILL_DANGER = 'rgba(255,129,130,.4)';
export const FILL_ATTENTION = 'rgba(212,167,44,.4)';
const FILL_RENOVATE = 'rgba(171,125,248,.35)'; // здание отмечено к реновации
const ell = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const;
// градиент из сегментов [цвет, процент], как прогресс в шапке карточки здания
export function fillOf(parts: [string, number][]): string {
  let at = 0; const stops: string[] = [];
  for (const [c, p] of parts) { const to = Math.min(100, at + Math.max(0, p)); stops.push(`${c} ${at}% ${to}%`); at = to; }
  stops.push(`transparent ${at}%`);
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}
// цветная сводка сверху (зелёная у «Плана»): фон X.subtle, внутри белые плитки
export function Summary({ tone = 'success', children }: { tone?: string; children: ReactNode }) {
  return <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, p: 2, borderRadius: '12px', bg: `${tone}.subtle` }}>{children}</Box>;
}
export function Tile({ value, label, color, size = 3 }: { value: ReactNode; label: ReactNode; color?: string; size?: number }) {
  return (
    <Box sx={{ flex: 1, minWidth: 0, p: 2, borderRadius: '8px', bg: 'canvas.default' }}>
      <Text as="div" sx={{ fontSize: size, lineHeight: 1.1, fontWeight: 'semibold', color: color ?? 'fg.default', ...num, ...ell }}>{value}</Text>
      <Text as="div" sx={{ ...muted, ...ell }}>{label}</Text>
    </Box>
  );
}
export function SumLine({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, ...muted, ...num }}><Text>{left}</Text>{right != null && <Text>{right}</Text>}</Box>;
}
// карточка-строка, как у здания в «Плане»: миниатюра 36px и две строки 20+16px — карточка 52px,
// картинка ровно в 8px от краёв со всех сторон; справа — действие, стрелка раскрытия (chevron) в 16px от края
// название карточки: не влезающее бежит влево до конца и обратно, пока курсор на карточке ([data-mq-host]),
// без курсора сразу встаёт на место. Слушатели — на самой карточке, поэтому работает и в шапках внутри map
function MarqueeTitle({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [run, setRun] = useState<{ d: number; t: number } | null>(null);
  useEffect(() => {
    const el = ref.current, host = el?.closest('[data-mq-host]');
    if (!el || !host) return;
    const enter = () => {
      // ширину меряем дробной: scrollWidth округляется, и при переполнении меньше пикселя
      // многоточие уже есть, а scrollWidth === clientWidth — строка не бежала
      const inner = el.firstElementChild;
      const d = inner ? Math.ceil(inner.getBoundingClientRect().width - el.getBoundingClientRect().width) : 0;
      if (d > 0) setRun({ d, t: 2 * d / 40 + 2.4 });
    };
    const leave = () => setRun(null);
    host.addEventListener('mouseenter', enter); host.addEventListener('mouseleave', leave);
    return () => { host.removeEventListener('mouseenter', enter); host.removeEventListener('mouseleave', leave); };
  }, []);
  return (
    <Text ref={ref} sx={{ fontWeight: 'semibold', lineHeight: '20px', ...ell, ...(run ? { textOverflow: 'clip' } : null) }}>
      <span className={run ? 'tc-marquee' : undefined} style={run ? { ['--mq' as string]: `-${run.d}px`, animationDuration: `${run.t}s` } : undefined}>{children}</span>
    </Text>
  );
}
export function Row({ lead, title, sub, trail, fill, bg = 'canvas.subtle', onClick, chevron, sx, children }: {
  lead?: ReactNode; title: ReactNode; sub?: ReactNode; trail?: ReactNode; fill?: string; bg?: string; onClick?: () => void; chevron?: boolean; sx?: object; children?: ReactNode;
}) {
  return (
    <Box sx={{ borderRadius: '12px', bg, display: 'flex', flexDirection: 'column', ...sx }}>
      <Box onClick={onClick} data-mq-host=""
        sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0, p: 2, pr: chevron ? 3 : 2, borderRadius: '12px', backgroundImage: fill, cursor: onClick ? 'pointer' : undefined }}>
        {lead}
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <MarqueeTitle>{title}</MarqueeTitle>
          {sub != null && <Text sx={{ ...sub2, ...num, ...ell }}>{sub}</Text>}
        </Box>
        {trail}
      </Box>
      {children}
    </Box>
  );
}
// цена на карточке здания: вверх до 1 знака в своей единице (2.13B → 2.2B) — короче, и денег точно хватит
export function fmtUp(n: number): string {
  for (const [k, u] of [[1e15, 'Q'], [1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (n < k) continue;
    const v = Math.ceil(n / k * 10 - 1e-6) / 10;
    // 999.95K округлилось бы в 1000K — тогда следующая единица
    return v >= 1000 && k < 1e15 ? fmtUp(1000 * k) : String(v) + u;
  }
  return String(Math.ceil(n));
}
// мини-карточка предмета, как на странице «Предметы»: цвет редкости, количество в синем ярлыке (не хватает — в красном)
export function ItemCard({ tag, count, short, className, src, dim }: { tag: string; count?: ReactNode; short?: boolean; className?: string; src?: string | null; dim?: boolean }) {
  return (
    // непрозрачная подложка: фон редкости полупрозрачный и иначе окрашивался бы заливкой карточки
    <Box className={className} sx={{ width: 36, height: 36, borderRadius: '8px', bg: 'canvas.default', flexShrink: 0 }}>
      <Box className={`item-card__box ic-${tag}`} style={{ width: 36, height: 36, borderRadius: 8 }}>
        {(src !== null) && <img src={src ?? itemSrc(tag)} alt="" style={{ width: 28, height: 28, objectFit: 'contain', opacity: dim ? 0.5 : 1 }} />}
        {count != null && <span className="item-card__count" style={{ fontSize: 10, lineHeight: '14px', padding: '0 4px', borderRadius: 7, right: -4, bottom: -4, fontVariantNumeric: 'tabular-nums', ...(short ? { background: '#e5534b' } : null) }}>{count}</span>}
      </Box>
    </Box>
  );
}
// значение справа в карточке: одно, по центру по вертикали, 14px
export function Val({ children, color = 'fg.default', mono, className }: { children: ReactNode; color?: string; mono?: boolean; className?: string }) {
  return <Text className={className} sx={{ fontSize: 1, fontWeight: 'semibold', color, flexShrink: 0, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 1, ...num, ...(mono ? { fontFamily: 'mono', fontSize: '13px' } : null) }}>{children}</Text>;
}
// число справа, под курсором на его месте крестик (на сенсорных экранах крестик всегда рядом с числом)
const SWAP = {
  '& .sw-x': { display: 'none' }, '&:hover .sw-x, &:focus-within .sw-x': { display: 'inline-flex' }, '&:hover .sw-v, &:focus-within .sw-v': { display: 'none' },
  '@media (hover: none)': { '& .sw-x': { display: 'inline-flex' }, '&:hover .sw-v, &:focus-within .sw-v': { display: 'inline-flex' } },
} as const;
// здание в списке «Строительства»: цена справа, выбранное залито синим, недоступное бледнее, причина — второй строкой
export function BuildItem({ id, name, sub, trail, active, unavailable, onClick }: { id: string; name: string; sub?: ReactNode; trail?: ReactNode; active: boolean; unavailable: boolean; onClick: () => void }) {
  return <Row lead={<Thumb id={id} size={36} bg="canvas.default" dim={unavailable} />} title={name} sub={sub} trail={trail} fill={active ? fillOf([[FILL_WIP, 100]]) : undefined}
    onClick={unavailable ? undefined : onClick} sx={unavailable ? { opacity: 0.6 } : undefined} />;
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
function IconThumb({ icon, color = 'fg.muted', size = 36 }: { icon: React.ElementType; color?: string; size?: number }) {
  return <Box sx={{ width: size, height: size, borderRadius: '8px', bg: 'canvas.default', display: 'grid', placeItems: 'center', flexShrink: 0, color }}><Octicon icon={icon} /></Box>;
}
// миниатюра здания с бейджем (номер в очереди, значок типа в логе)
export function BadgeThumb({ id, badge, badgeBg = 'accent.emphasis', corner = 'tl', dim }: { id: string; badge: ReactNode; badgeBg?: string; corner?: 'tl' | 'br'; dim?: boolean }) {
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
const Glyph = ({ tag, v }: { tag: string; v: ReactNode }) => <Box as="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: '2px', height: 16, verticalAlign: 'top' }}><ItemIcon tag={tag} />{v}</Box>;

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

// красная «Отменить» под кнопкой подтверждения — одна на всех вкладках (зазор 8px даёт подвал сайдбара)
export function CancelButton({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
  return <Button variant="danger" block disabled={disabled} onClick={onClick}>Отменить</Button>;
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
          trail={after !== v ? <Val color="fg.muted">→ {after}</Val> : undefined} />
      ))}
      {(Object.keys(SERVICE_LABEL) as ServiceCat[]).map(k => {
        const v = Math.round(s.serviceRatios[k] * 100);
        const ok = v >= 90;
        return (
          <Row key={k} lead={<Thumb id={SERVICE_SPRITE[k]} size={36} bg="canvas.default" />} title={SERVICE_LABEL[k]}
            sub={v >= 100 ? 'с запасом' : ok ? 'почти хватает' : 'не хватает'} fill={fillOf([[ok ? FILL_DONE : FILL_ATTENTION, Math.min(100, v)]])}
            trail={<Val color={ok ? 'success.fg' : 'attention.fg'}><span title={`Покрытие: ${fmtStat(s.coverageByCat[k])}`}>{v}%</span></Val>} />
        );
      })}
    </>
  );
}


// ── Показатели столицы: монеты и кристаллы, доход, сила экономики и штаб-квартира ──
export function CapitalStatsPanel({ coins, crystals, profitCoins, profitCrystals, econStrength, hallLevel, hallId }: {
  coins: number; crystals: number; profitCoins: number; profitCrystals: number; econStrength: number; hallLevel: number; hallId?: string;
}) {
  return (
    <>
      <Summary tone="accent">
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Tile value={<CoinValue value={fmt(coins)} />} label="монет" />
          <Tile value={<CrystalValue value={fmt(crystals)} />} label="кристаллов" />
        </Box>
        <SumLine left="доход монет в час" right={<CoinValue value={fmt(profitCoins)} />} />
        <SumLine left="доход кристаллов в час" right={<CrystalValue value={fmt(profitCrystals)} />} />
      </Summary>
      <Row lead={<IconThumb icon={GraphIcon} color="success.fg" />} title={econStrength.toFixed(2)} sub="сила экономики" />
      <Row lead={hallId ? <Thumb id={hallId} size={36} bg="canvas.default" /> : <IconThumb icon={StackIcon} />} title={`ур. ${hallLevel}`} sub="штаб-квартира" />
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
// заливка шапки здания и плашек клеток: те же цвета, что у полос, приглушённые
export const FILL_DONE = 'rgba(74,194,107,.4)';
export const FILL_WIP = 'rgba(84,174,255,.4)';
const FILL_OFF = 'rgba(248,81,73,.4)'; // клетка помечена к удалению
const DONE_FG = '#7ee787'; // «готово» в шапке поверх зелёной заливки — светлее success.fg
export function PlanBar({ done, wip, span, size = 'small', bg }: { done: number; wip: number; span: number; size?: 'small' | 'default' | 'large'; bg?: string }) {
  return (
    <ProgressBar barSize={size} aria-label="Прогресс" sx={{ flex: '1 1 auto', minWidth: 0, ...(bg ? { bg } : null) }}>
      <ProgressBar.Item className="pb-fill" progress={pctOf(done, span)} sx={{ bg: 'success.emphasis' }} />
      {wip > 0 && <ProgressBar.Item className="pb-fill" progress={pctOf(wip, span)} sx={{ bg: 'accent.emphasis' }} />}
    </ProgressBar>
  );
}
const cellsWord = (n: number) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? 'клетка' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'клетки' : 'клеток'; };
// сравнение ключей сортировки по элементам: числа — по величине, строки — по алфавиту
function cmpKeys(a: (string | number)[], b: (string | number)[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? '', y = b[i] ?? '';
    const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ru');
    if (d) return d;
  }
  return 0;
}
export function PlanPanel({ targets, owned, labelFor, upgradeCost, onHover, removed, onMarkRemoved, sortKey }: {
  targets: CityStrategyTarget[]; owned: MapBuilding[]; labelFor: (id: string) => string;
  sortKey?: (id: string) => (string | number)[]; // порядок зданий — как в «Строительстве»; без него — по алфавиту
  upgradeCost: (id: string, fromLvl: number, toLvl: number) => number; // монет на улучшения fromLvl → toLvl
  onHover: (cells: string[] | null) => void; // "x_y" — на карте остаются видны только эти клетки
  // клетки ("x,y"), помеченные к удалению: остаются в списке бледными, из плана уходят при «Сохранить»
  removed: Set<string>; onMarkRemoved: (keys: string[], on: boolean) => void;
}) {
  const [q, setQ] = useState('');
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
    }).sort((a, b) => !a.id !== !b.id ? (a.id ? -1 : 1) : sortKey ? cmpKeys(sortKey(a.id), sortKey(b.id)) : a.name.localeCompare(b.name, 'ru'));
  }, [targets, owned, labelFor, upgradeCost, removed, sortKey]);
  const all = useMemo(() => planSum(groups.flatMap(g => g.cells.filter(c => !removed.has(c.key)))), [groups, removed]);
  const keptCount = targets.length - groups.reduce((n, g) => n + g.marked, 0);
  const ql = q.trim().toLowerCase();
  // карточка на клетку, как в «Реконструкции»: здания подряд в порядке «Строительства», внутри — по клетке
  const cells = groups.flatMap(g => g.cells.map(c => ({ ...c, id: g.id, name: g.name })));
  const shown = ql ? cells.filter(c => c.name.toLowerCase().includes(ql) || c.key.startsWith(ql)) : cells;
  const marked = groups.reduce((n, g) => n + g.marked, 0);
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
            {shown.map(c => {
              const off = removed.has(c.key);
              const ca = pctOf(c.done, c.span), cb = pctOf(c.done + c.wip, c.span);
              // клик помечает клетку к удалению (карточка бледнеет, заливка красная), повторный — возвращает
              return (
                <Box key={c.key} {...hover([c.key])} sx={{ opacity: off ? 0.35 : 1 }}>
                  <Row lead={c.id ? <Thumb id={c.id} size={36} bg="canvas.default" /> : <Box sx={{ width: 36, height: 36 }} />} title={c.name}
                    sub={`${c.done >= c.span ? `ур. ${c.level}` : `${c.level} → ${c.target}`} · ${c.key}`}
                    fill={fillOf(off ? [[FILL_OFF, cb]] : [[FILL_DONE, ca], [FILL_WIP, cb - ca]])} onClick={() => onMarkRemoved([c.key], !off)}
                    trail={c.cost > 0 ? <Val><CoinValue value={fmtUp(c.cost)} /></Val> : c.done >= c.span ? <Val><Octicon icon={CheckIcon} /></Val> : undefined} />
                </Box>
              );
            })}
            {marked > 0 && <Text sx={{ fontSize: 0, color: 'danger.fg', textAlign: 'center' }}>{marked} {cellsWord(marked)} {marked === 1 ? 'уйдёт' : 'уйдут'} из плана при сохранении</Text>}
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
              boxShadow: over === i && drag !== i ? '0 0 0 2px var(--cyan)' : undefined,
              // крестик виден под курсором; на сенсорных экранах — всегда
              ...SWAP,
            }}>
            <Row lead={b ? <BadgeThumb id={b.id} badge={i + 1} badgeBg={i === 0 ? 'accent.emphasis' : 'neutral.emphasis'} /> : <Box sx={{ width: 36 }} />}
              title={b ? labelFor(b.id) : '—'} fill={i === 0 ? fillOf([[FILL_WIP, 100]]) : undefined}
              sub={<>{from != null ? `${from} → ${from + 1}` : `${q.x},${q.y}`}{prices[i] != null && !fits[i] && <Text sx={{ color: 'attention.fg' }}> · не хватит</Text>}</>}
              trail={<>
                {prices[i] != null && <Val className="sw-v" color={fits[i] ? 'fg.default' : 'fg.muted'}><CoinValue value={fmtUp(prices[i]!)} /></Val>}
                <Box as="span" className="sw-x"><IconButton size="small" variant="invisible" icon={XIcon} aria-label="Убрать из очереди" onClick={() => onRemove(i)} /></Box>
              </>} />
          </Box>
        );
      })}
    </>
  );
}

// ── отложенные действия (строительство/перемещение/снос/реконструкция/реновация) ─────────────
export interface PendingRow { id: number; kind: string; label: string; sprite?: string }
const PENDING_ICON: Record<string, React.ElementType> = { build: PlusIcon, move: ArrowBothIcon, demolish: TrashIcon, reconstruct: IterationsIcon, renovate: StarIcon, skip: RocketIcon };
const PENDING_BADGE: Record<string, string> = { build: 'accent.emphasis', move: 'accent.emphasis', demolish: 'danger.emphasis', reconstruct: 'done.emphasis', renovate: 'done.emphasis', skip: 'attention.emphasis' };
// как у остальных карточек: сверху здание, второй строкой «действие · клетка», значок действия — бейджем на картинке
export function PendingList({ rows, labelFor, disabled, onRemove }: { rows: PendingRow[]; labelFor: (id: string) => string; disabled: boolean; onRemove: (id: number) => void }) {
  if (!rows.length) return null;
  return (
    <>
      <Caption right={`всего ${rows.length}`}>Ждут выполнения</Caption>
      {rows.map(r => {
        const cut = r.label.indexOf(': ');
        const action = cut > 0 ? r.label.slice(0, cut) : r.label;
        const name = r.sprite ? labelFor(r.sprite) : '';
        let rest = cut > 0 ? r.label.slice(cut + 2) : '';
        if (name && rest.startsWith(name)) rest = rest.slice(name.length).trim();
        rest = rest.replace(/\((\d+,\d+)\)/g, '$1');
        const icon = PENDING_ICON[r.kind] ?? PlusIcon;
        return (
        <Row key={r.id} lead={r.sprite ? <BadgeThumb id={r.sprite} badge={<Octicon icon={icon} size={10} />} badgeBg={PENDING_BADGE[r.kind] ?? 'accent.emphasis'} corner="br" dim={r.kind === 'demolish'} /> : <IconThumb icon={icon} />}
          title={name || action} sub={name ? (rest ? `${action} · ${rest}` : action) : rest}
          trail={<IconButton size="small" variant="invisible" icon={XIcon} aria-label="Убрать" disabled={disabled} onClick={() => onRemove(r.id)} />} />
        );
      })}
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
        </>
      ) : null}
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
          sub={`ур. ${t.level} · ${t.x},${t.y}`} fill={fillOf([[FILL_DANGER, t.loss / max * 100]])} sx={SWAP}
          trail={<>
            {t.loss > 0 && <Val className="sw-v" color="danger.fg">−{fmt(t.loss)}/ч</Val>}
            <Box as="span" className="sw-x"><IconButton size="small" variant="invisible" icon={XIcon} aria-label="Снять отметку" disabled={disabled} onClick={() => onRemove(t.id)} /></Box>
          </>} />
      ))}
    </>
  );
}

// ── Реконструкция: группы по типу здания, внутри полосы уровней до нужного ──
// Клетка готова — клик отмечает реконструкцию сейчас (кнопка «Выполнить»), не готова — ставит в план:
// бот сам отправит её, когда здание дорастёт и освободится от стройки.
export interface ReconCell { x: number; y: number; level: number; req: number; building: boolean; ready: boolean; queued: boolean; planned: boolean }
export interface ReconGroup { id: string; name: string; comp: number | null; gain: number | null; cells: ReconCell[] }
export function ReconstructPanel({ groups, components, disabled, onToggle }: { groups: ReconGroup[]; components: number; disabled: boolean; onToggle: (x: number, y: number) => void }) {
  const cells = groups.flatMap(g => g.cells.map(c => ({ ...c, g })));
  const ready = cells.filter(c => c.ready).length;
  const queued = cells.filter(c => c.queued);
  const spend = queued.reduce((s, c) => s + (c.g.comp ?? 0), 0), gain = queued.reduce((s, c) => s + (c.g.gain ?? 0), 0);
  if (groups.length === 0) return <Empty>В городе нет зданий, которые умеют реконструироваться.</Empty>;
  // в списке только выбранное кистью: отмеченное к выполнению сейчас и ждущее в плане нужного уровня
  const picked = cells.filter(c => c.queued || c.planned).sort((a, b) => Number(b.queued) - Number(a.queued) || b.level / b.req - a.level / a.req);
  let left = components;
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
      {picked.map(c => {
        const span = Math.max(1, c.req - 1), done = Math.max(0, Math.min(c.level, c.req) - 1);
        const ca = pctOf(done, span), cb = pctOf(done + (c.building && c.level < c.req ? 1 : 0), span);
        // компонентов хватает по порядку списка: отмеченные к выполнению тратят первыми
        const short = c.g.comp != null && (left -= c.g.comp) < 0;
        return (
          <Row key={`${c.x},${c.y}`} lead={<Thumb id={c.g.id} size={36} bg="canvas.default" />} title={c.g.name}
            sub={c.queued ? `готово · ${c.x},${c.y}` : `ур. ${c.level} из ${c.req} · ${c.x},${c.y}`}
            fill={c.queued ? fillOf([[FILL_RENOVATE, 100]]) : fillOf([[FILL_DONE, ca], [FILL_WIP, cb - ca]])}
            trail={c.g.comp != null ? <ItemCard tag="component" count={c.g.comp} short={short} /> : undefined} />
        );
      })}
    </>
  );
}

// ── Реновация: мастерпланы кубиками и плотный список с галочками ────────────
export function RenovatePanel({ masterplans, items, onToggle, disabled }: {
  masterplans: number; disabled: boolean;
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
        <>
          {/* в списке только отмеченное на карте; мастерпланов не хватает — ярлык красный с того здания, где кончились */}
          {(() => { let rest = masterplans; return items.filter(it => it.marked).map(it => {
            const short = (rest -= it.cost ?? 0) < 0;
            return (
              <Row key={`${it.x},${it.y}`} lead={<Thumb id={it.nextId} size={36} bg="canvas.default" />} title={it.nextName}
                fill={fillOf([[FILL_RENOVATE, 100]])}
                trail={<ItemCard tag="masterplan" count={it.cost ?? '?'} short={short} />} />
            );
          }); })()}
        </>
      )}
    </>
  );
}

// ── Ускорители: активный жёлтой карточкой, очередь и склад карточками ───────
export function BoostersPanel({ boosters, active, loading, queue, onAdd, onReorder, onRemoveAt }: {
  boosters: CityBoosterRow[]; active: CityActiveBooster[]; loading: boolean; queue: { name: string; label: string }[];
  onAdd: (name: string) => void; onReorder: (from: number, to: number) => void; onRemoveAt: (i: number) => void;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  if (loading && boosters.length === 0) return <Spinner size="small" />;
  const queued = (name: string) => queue.filter(q => q.name === name).length;
  const img = (name: string) => catalogItemImg(Number(name));
  // ускоритель — карточкой предмета, как мастерплан и компонент: рамка цвета редкости (тег = редкость, у вечного — eternal)
  const card = (name: string, count?: number, dim?: boolean) => {
    const tag = ITEMS_BY_ID[Number(name)]?.tag?.replace(/_booster$/, '') ?? 'common';
    return <ItemCard tag={tag} src={img(name)} count={count} dim={dim} />;
  };
  const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  return (
    <>
      {active.map(b => (
        <Row key={b.name} lead={card(b.name)} title={b.label} bg="attention.subtle"
          sub={<>{`активен · ещё ${fmtTimeLeft(b.ends_at - Date.now())}`}{b.active_limit > 1 && ` · ${b.currently_active}/${b.active_limit}`}</>}
          trail={<Val mono color="attention.fg">{hhmm(b.ends_at)}</Val>} />
      ))}
      {queue.length > 0 && <Caption right={queue.length}>Очередь</Caption>}
      {queue.map((q, i) => (
        <Box key={`${q.name}:${i}`} draggable onDragStart={e => { setDrag(i); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDrag(null)}
          onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (drag != null && drag !== i) onReorder(drag, i); setDrag(null); }}
          sx={{ opacity: drag === i ? 0.5 : 1, cursor: 'grab' }}>
          <Row lead={card(q.name)} title={q.label} sub={i === 0 ? '#1 · следующий' : `#${i + 1}`} fill={i === 0 ? fillOf([[FILL_WIP, 100]]) : undefined}
            trail={<IconButton size="small" variant="invisible" icon={XIcon} aria-label="Убрать из очереди" onClick={() => onRemoveAt(i)} />} />
        </Box>
      ))}
      <Caption>На складе</Caption>
      {boosters.length === 0 ? <Empty>Ускорителей в инвентаре нет</Empty> : boosters.map(b => {
        const k = queued(b.name);
        return (
          <Row key={b.name} lead={card(b.name, b.available || undefined, !b.available)} title={b.label}
            sub={<Text sx={{ color: b.blocked_by_other && b.available ? 'attention.fg' : 'inherit' }}>
              {[!b.available && 'нет на складе', k > 0 && `в очереди ${k}`, b.blocked_by_other && b.available > 0 && 'ждёт другой'].filter(Boolean).join(' · ') || 'на складе'}
            </Text>}
            trail={<IconButton size="small" variant="invisible" icon={PlusIcon} aria-label="В очередь" disabled={k >= b.available} onClick={() => onAdd(b.name)} />} />
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
const Time = ({ ms, title }: { ms: number; title?: string }) => <Val mono><span title={title}>{hhmm(ms)}</span></Val>;
// тип действия: название, значок и цвет бейджа на миниатюре
const LOG_TYPE: Record<string, [string, React.ElementType, string]> = {
  upgrade: ['Улучшение', ArrowUpIcon, 'success.emphasis'], build: ['Постройка', PlusCircleIcon, 'accent.emphasis'],
  move: ['Перемещение', ArrowBothIcon, 'accent.emphasis'], demolish: ['Снос', TrashIcon, 'danger.emphasis'],
  reconstruct: ['Реконструкция', IterationsIcon, 'done.emphasis'], renovate: ['Реновация', StarIcon, 'done.emphasis'],
  booster_activate: ['Ускоритель', ZapIcon, 'attention.emphasis'], booster_combine: ['Комбинирование', ZapIcon, 'attention.emphasis'],
  unlock_section: ['Секция', UnlockIcon, 'neutral.emphasis'],
  'skip-upgrade': ['Ускорение', RocketIcon, 'attention.emphasis'],
};
// общее у лога города и столицы (у столицы guild_id вместо account)
type LogRow = Pick<CityActionLogRow, 'id' | 'type' | 'building_id' | 'level_from' | 'level_to' | 'duration_ms' | 'created_at'>;
// place — город строки на общей карте всех городов: встаёт в начало второй строки
const withPlace = (place: string | undefined, sub: string) => place ? `${place} · ${sub}` : sub;
export function LogPanel<R extends LogRow>({ rows, loading, label, labelFor, place }: { rows: R[]; loading: boolean; label: (r: R) => string; labelFor: (id: string) => string; place?: (r: R) => string | undefined }) {
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
                sub={withPlace(place?.(r), isUp ? `${r.level_from} → ${r.level_to}${r.duration_ms ? ` · ${fmtTimeLeft(r.duration_ms)}` : ''}` : (cut > 0 ? text.slice(cut + 2) : text))}
                trail={<Time ms={new Date(r.created_at).getTime()} />} />
            );
          })}
        </Box>
      ))}
    </>
  );
}
// стройка под ускорителем залита жёлтым и подписана множителем
export function ForecastPanel<E extends ForecastEvent>({ events, loading, labelFor, place }: { events: E[]; loading: boolean; labelFor: (id: string) => string; place?: (e: E) => string | undefined }) {
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
                sub={withPlace(place?.(e), `${e.level_from} → ${e.level_to} · ${fmtTimeLeft(e.duration_ms)}`)}
                trail={<Time ms={e.start} title={boost ? `${e.boost_name ?? 'ускоритель'} ×${boost}` : undefined} />} />
            );
          })}
        </Box>
      ))}
    </>
  );
}
