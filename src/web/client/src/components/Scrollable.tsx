import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';
import type { OverlayScrollbars } from 'overlayscrollbars';
import { createContext, useContext, useMemo, useState, type CSSProperties, type ReactNode } from 'react';

const SCROLL_OPTIONS = { scrollbars: { autoHide: 'leave', autoHideDelay: 800, theme: 'os-theme-dark' } } as const;

const ScrollViewport = createContext<HTMLElement | null>(null);
export const useScrollViewport = () => useContext(ScrollViewport);

interface Props {
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}

export function Scrollable({ children, style, className }: Props) {
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const events = useMemo(() => ({ initialized: (instance: OverlayScrollbars) => setViewport(instance.elements().viewport) }), []);
  return (
    <ScrollViewport.Provider value={viewport}>
    <OverlayScrollbarsComponent
      events={events}
      options={SCROLL_OPTIONS}
      style={{ flex: 1, minHeight: 0, ...style }}
      className={className}
    >
      {children}
    </OverlayScrollbarsComponent>
    </ScrollViewport.Provider>
  );
}
