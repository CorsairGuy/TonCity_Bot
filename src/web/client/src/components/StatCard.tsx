import { Box, Text } from '@primer/react';
import React from 'react';

type Color = 'ton' | 'cyan' | 'green' | 'yellow' | 'purple' | 'red' | 'default';

const colorMap: Record<Color, string> = {
  ton:     'accent.emphasis',
  cyan:    'accent.emphasis',
  green:   'success.emphasis',
  yellow:  'attention.emphasis',
  purple:  'done.emphasis',
  red:     'danger.emphasis',
  default: 'border.default',
};

interface Props {
  label: string;
  value?: React.ReactNode;
  hint?: React.ReactNode;
  color?: Color;
  children?: React.ReactNode;
}

export function StatCard({ label, value, hint, color = 'default', children }: Props) {
  return (
    <Box sx={{ p: 3, border: '1px solid', borderColor: 'border.default', borderRadius: 2, bg: 'canvas.default', position: 'relative', pt: '32px', overflow: 'hidden' }}>
      <Box sx={{ position: 'absolute', top: 0, left: 0, right: 0, height: '3px', bg: colorMap[color] }} />
      <Text sx={{ fontSize: 0, fontWeight: 600, color: 'fg.muted', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', mb: 2 }}>
        {label}
      </Text>
      {children ?? (
        <>
          <Text sx={{ fontSize: 4, fontWeight: 'bold', color: 'fg.default', lineHeight: 1, display: 'block' }}>{value ?? '—'}</Text>
          {hint && <Text sx={{ fontSize: 0, color: 'fg.subtle', display: 'block', mt: 1 }}>{hint}</Text>}
        </>
      )}
    </Box>
  );
}