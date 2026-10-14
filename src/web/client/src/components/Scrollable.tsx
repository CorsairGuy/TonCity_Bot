import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';
import type { CSSProperties, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}

export function Scrollable({ children, style, className }: Props) {
  return (
    <OverlayScrollbarsComponent
      options={{ scrollbars: { autoHide: 'leave', autoHideDelay: 800, theme: 'os-theme-dark' } }}
      style={{ flex: 1, minHeight: 0, ...style }}
      className={className}
    >
      {children}
    </OverlayScrollbarsComponent>
  );
}
