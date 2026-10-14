import { Box, Text, Heading } from '@primer/react';
import React from 'react';

interface CardProps { children: React.ReactNode; className?: string; }

export function GlassCard({ children }: CardProps) {
  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden', bg: 'canvas.default' }}>
      {children}
    </Box>
  );
}

export function CardHead({ title, desc, actions }: { title: string; desc?: string; actions?: React.ReactNode }) {
  return (
    <Box sx={{ px: 3, py: 3, borderBottom: '1px solid', borderColor: 'border.default', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, bg: 'canvas.subtle' }}>
      <Box>
        <Text sx={{ fontWeight: 'bold', fontSize: 1, color: 'fg.default', display: 'block' }}>{title}</Text>
        {desc && <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 1 }}>{desc}</Text>}
      </Box>
      {actions && <Box sx={{ flexShrink: 0 }}>{actions}</Box>}
    </Box>
  );
}

export function CardBody({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <Box sx={{ p: 3 }} style={style}>{children}</Box>;
}

export function CardFoot({ children }: { children: React.ReactNode }) {
  return (
    <Box sx={{ px: 3, py: 2, borderTop: '1px solid', borderColor: 'border.default', bg: 'canvas.subtle' }}>
      {children}
    </Box>
  );
}