import { startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Box } from '@primer/react';
import { useScrollViewport } from './Scrollable';

// Карточка очереди: 36px содержимого + 16px отступов; между карточками 8px.
export const PANEL_ROW_HEIGHT = 52, PANEL_ROW_GAP = 8, PANEL_ROW_STEP = PANEL_ROW_HEIGHT + PANEL_ROW_GAP;
export function panelWindow(count: number, offset: number, height: number): { start: number; end: number } {
  const start = Math.min(Math.max(0, count - 1), Math.max(0, Math.floor(offset / PANEL_ROW_STEP) - 1));
  const end = Math.max(start, Math.min(count, Math.ceil((offset + height) / PANEL_ROW_STEP) + 1));
  return { start, end };
}
export function panelWindowIndices(count: number, start: number, end: number, pinned: (number | null)[]): number[] {
  const out = new Set<number>();
  for (let i = start; i < Math.min(count, end); i++) if (i >= 0) out.add(i);
  for (const i of pinned) if (i != null && i >= 0 && i < count) out.add(i);
  return [...out].sort((a, b) => a - b);
}

// Префиксные координаты позволяют смешивать карточки и заголовки дней без вложенных окон.
export function panelOffsets(count: number, height: number | ((index: number) => number)): number[] {
  const offsets = [0];
  for (let i = 0; i < count; i++) offsets.push(offsets[i] + (typeof height === 'function' ? height(i) : height) + PANEL_ROW_GAP);
  return offsets;
}
export function variablePanelWindow(offsets: number[], offset: number, height: number) {
  const count = offsets.length - 1;
  const lower = (value: number) => {
    let lo = 0, hi = count;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (offsets[mid] < value) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const start = Math.min(Math.max(0, count - 1), Math.max(0, lower(offset) - 2));
  return { start, end: Math.max(start, Math.min(count, lower(offset + height) + 1)) };
}

// Пропускаем недоступные действия, не монтируя скрытые карточки ради обхода Tab.
export function nextPanelFocus(count: number, from: number, direction: number, focusable?: (index: number) => boolean): number | null {
  for (let i = from + direction; i >= 0 && i < count; i += direction) if (!focusable || focusable(i)) return i;
  return null;
}

// Монтируем лишь видимые Primer-карточки; весь список, индексы и действия сохраняются.
export function MapPanelWindow({ count, pinned, rowHeight = PANEL_ROW_HEIGHT, force = false, onWindowChange, focusable, children }: {
  count: number; pinned?: number | null; force?: boolean; onWindowChange?: () => void; focusable?: (index: number) => boolean; rowHeight?: number | ((index: number) => number); children: (index: number) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scrollViewport = useScrollViewport();
  const [range, setRange] = useState({ start: 0, end: Math.min(count, 1) });
  const [focused, setFocused] = useState<number | null>(null);
  const pendingFocus = useRef<{ index: number; last: boolean } | null>(null);
  const offsets = useMemo(() => panelOffsets(count, rowHeight), [count, rowHeight]);
  const small = !force && count <= 16;
  const windowChange = useRef(onWindowChange);
  windowChange.current = onWindowChange;
  useEffect(() => { windowChange.current?.(); }, [range.start, range.end]);
  useEffect(() => {
    if (small) return;
    const host = ref.current;
    if (!host) return;
    // Событие initialized передаёт готовый viewport: effects дочерних списков
    // могут сработать раньше, чем OverlayScrollbars добавит ему атрибуты.
    const viewport = scrollViewport;
    if (!viewport) return;
    let frame = 0, disposed = false;
    const measure = () => {
      frame = 0;
      if (disposed) return;
      const offset = viewport.getBoundingClientRect().top - host.getBoundingClientRect().top;
      const next = variablePanelWindow(offsets, offset, viewport.clientHeight);
      // Измерение не должно превращать загрузку десятка Primer-карточек в срочный
      // синхронный render: ввод карты может прервать фоновую отрисовку окна.
      startTransition(() => setRange(old => old.start === next.start && old.end === next.end ? old : next));
    };
    const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    resize.observe(viewport); resize.observe(host);
    if (viewport.firstElementChild) resize.observe(viewport.firstElementChild);
    viewport.addEventListener('scroll', schedule, { passive: true });
    schedule();
    return () => { disposed = true; resize.disconnect(); viewport.removeEventListener('scroll', schedule); if (frame) cancelAnimationFrame(frame); };
  }, [offsets, small, scrollViewport]);
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    const row = ref.current?.querySelector<HTMLElement>(`:scope > [data-panel-row="${pending.index}"]`);
    if (row) pendingFocus.current = null;
    row?.focus({ preventScroll: true });
    const controls = row?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), [tabindex="0"]');
    if (controls?.length) {
      pendingFocus.current = null;
      const target = controls[pending.last ? controls.length - 1 : 0];
      target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest' });
    }
  });
  if (small) return <>{Array.from({ length: count }, (_, i) => <Box key={i}>{children(i)}</Box>)}</>;
  const indices = panelWindowIndices(count, range.start, range.end, [pinned ?? null, focused, nextPanelFocus(count, -1, 1, focusable), nextPanelFocus(count, count, -1, focusable)]);
  return <Box ref={ref} data-panel-window="list" sx={{ position: 'relative', flexShrink: 0 }} style={{ height: Math.max(0, offsets[count] - PANEL_ROW_GAP) }}
    onFocusCapture={e => { const row = [...e.currentTarget.querySelectorAll<HTMLElement>(':scope > [data-panel-row]')].find(el => el.contains(e.target as Node)); if (row) setFocused(Number(row.dataset.panelRow)); }}
    onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(null); }}
    onKeyDown={e => {
      if (e.key !== 'Tab' || e.defaultPrevented) return;
      const row = [...e.currentTarget.querySelectorAll<HTMLElement>(':scope > [data-panel-row]')].find(el => el.contains(e.target as Node));
      if (!row) return;
      const buttons = [...row.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), [tabindex="0"]')];
      if (e.target !== buttons[e.shiftKey ? 0 : buttons.length - 1]) return;
      const next = nextPanelFocus(count, Number(row.dataset.panelRow), e.shiftKey ? -1 : 1, focusable);
      if (next == null) return;
      e.preventDefault(); pendingFocus.current = { index: next, last: e.shiftKey }; setFocused(next);
    }}>
    {indices.map(i => <Box key={i} tabIndex={-1} data-panel-row={i} sx={{ position: 'absolute', left: 0, right: 0 }} style={{ top: offsets[i] }}>{children(i)}</Box>)}
  </Box>;

}
