import { Box, Text } from '@primer/react';

export function Placeholder({ title }: { title: string }) {
  return (
    <Box sx={{ p: 3, display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 200 }}>
      <Box sx={{ textAlign: 'center' }}>
        <Text sx={{ fontSize: 5, display: 'block', mb: 2 }}>🔒</Text>
        <Text sx={{ fontSize: 3, fontWeight: 'bold', display: 'block', mb: 1 }}>{title}</Text>
        <Text sx={{ fontSize: 1, color: 'fg.muted', display: 'block' }}>Раздел появится после обновления игры</Text>
      </Box>
    </Box>
  );
}
