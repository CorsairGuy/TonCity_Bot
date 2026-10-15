import { Box, Heading, Text } from '@primer/react';
import type { ReactNode } from 'react';

// Единая шапка страницы: заголовок и короткая подпись слева, действия справа (главное — зелёное,
// крайнее справа). На узком экране действия переносятся под заголовок, но остаются прижатыми вправо.
export function PageHeader({ title, sub, actions, mb = 3 }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; mb?: number }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, mb, flexWrap: 'wrap' }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, flexWrap: 'wrap', minWidth: 0 }}>
        <Heading as="h2" sx={{ fontSize: 3 }}>{title}</Heading>
        {sub && <Text sx={{ fontSize: 1, color: 'fg.muted' }}>{sub}</Text>}
      </Box>
      {actions && <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', ml: 'auto' }}>{actions}</Box>}
    </Box>
  );
}
