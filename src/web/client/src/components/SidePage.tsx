import type { ReactNode } from 'react';
import { Box } from '@primer/react';

// Страница с правым сайдбаром, как «Города»: слева прокручиваемое содержимое, справа колонка шириной
// --sidebar-w (внутри — PanelShell из cityMapPanels). На телефоне сайдбар встаёт сверху и занимает до 45% экрана.
export function SidePage({ main, side }: { main: ReactNode; side: ReactNode }) {
  return (
    <Box sx={{
      display: 'flex', height: 'calc(100vh - var(--header-h))',
      '@media (max-width: 768px)': { flexDirection: 'column', height: 'calc(100dvh - 52px)' },
    }}>
      <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', p: 3, '@media (max-width: 768px)': { order: 2 } }}>{main}</Box>
      <Box sx={{
        width: 'var(--sidebar-w)', flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
        borderLeft: '1px solid', borderColor: 'border.default',
        '@media (max-width: 768px)': { order: 1, width: '100%', height: '45%', borderLeft: 0, borderBottom: '1px solid', borderBottomColor: 'border.default' },
      }}>{side}</Box>
    </Box>
  );
}

// вкладки-переключатель в стиле «Строительства» на карте городов (#map-cat-tabs из global.css)
export function CatTabs({ tabs, value, onChange }: { tabs: ReactNode[]; value: number; onChange: (i: number) => void }) {
  return (
    <div className="map-cat-tabs" role="tablist">
      {tabs.map((t, i) => (
        <span key={i} role="tab" aria-selected={i === value} className={'map-cat-tab' + (i === value ? ' active' : '')} onClick={() => onChange(i)}>{t}</span>
      ))}
    </div>
  );
}

// рамка выбранной карточки в сайдбаре
export const SELECTED_RING = { boxShadow: '0 0 0 2px var(--cyan)' } as const;
