import { useState, useEffect } from 'react';
import { Box, Button, Flash, Heading, Text, Spinner, CounterLabel, ProgressBar, Label } from '@primer/react';
import { SyncIcon, CheckCircleIcon, ClockIcon } from '@primer/octicons-react';
import { api, type JourneyAccount } from '../api';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';

function LevelCell({ level, claimed, condition_met }: { level: number; claimed: boolean; condition_met: boolean }) {
  const bg = claimed ? 'success.subtle' : condition_met ? 'attention.subtle' : 'canvas.inset';
  const border = claimed ? 'success.muted' : condition_met ? 'attention.muted' : 'border.muted';
  const color = claimed ? 'success.fg' : condition_met ? 'attention.fg' : 'fg.subtle';
  return (
    <Box
      title={claimed ? 'Получено' : condition_met ? 'Готово к получению' : 'Не выполнено'}
      sx={{
        width: 32, height: 32, borderRadius: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        bg, border: '1px solid', borderColor: border, color,
        fontSize: 0, fontWeight: 'bold', flexShrink: 0,
      }}
    >
      {level}
    </Box>
  );
}

function AccountCard({ account }: { account: JourneyAccount }) {
  const total = account.levels.length;
  const claimed = account.levels.filter(l => l.claimed).length;
  const ready = account.levels.filter(l => l.condition_met && !l.claimed).length;
  const pct = total > 0 ? Math.round((claimed / total) * 100) : 0;

  return (
    <Box sx={{
      border: '1px solid', borderColor: ready > 0 ? 'attention.muted' : 'border.default',
      borderRadius: 2, overflow: 'hidden',
      boxShadow: ready > 0 ? 'inset 3px 0 0 var(--color-attention-fg)' : 'none',
    }}>
      {/* Header */}
      <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.muted', display: 'flex', alignItems: 'center', gap: 2 }}>
        <Text sx={{ fontWeight: 'semibold', fontSize: 1, flex: 1 }}>{account.name}</Text>
        {ready > 0 && (
          <Label variant="attention" sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 0 }}>
            <CheckCircleIcon size={12} /> Готово: {ready}
          </Label>
        )}
        <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'flex', alignItems: 'center', gap: 1 }}>
          <ClockIcon size={12} />
          {claimed}/{total}
        </Text>
      </Box>

      {/* Progress bar */}
      <Box sx={{ px: 3, pt: 2, pb: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Прогресс</Text>
          <Text sx={{ fontSize: 0, color: pct === 100 ? 'success.fg' : 'fg.muted', fontWeight: 'semibold' }}>{pct}%</Text>
        </Box>
        <ProgressBar
          progress={pct}
          sx={{ height: 6 }}
          bg={pct === 100 ? 'success.emphasis' : undefined}
        />
      </Box>

      {/* Level grid */}
      <Box sx={{ px: 3, pt: 1, pb: 3 }}>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 2 }}>
          {account.levels.map(l => (
            <LevelCell key={l.level} {...l} />
          ))}
        </Box>
      </Box>
    </Box>
  );
}

export function Journey() {
  const [accounts, setAccounts] = useState<JourneyAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:journey', () => load());
  const { flash, showFlash } = useFlash();

  const load = async () => {
    setLoading(true);
    try {
      const d = await api.journey();
      if (d.ok) setAccounts([...d.accounts].sort((a, b) => {
        const aReady = a.levels.filter(l => l.condition_met && !l.claimed).length;
        const bReady = b.levels.filter(l => l.condition_met && !l.claimed).length;
        if (bReady !== aReady) return bReady - aReady;
        return a.name.localeCompare(b.name);
      }));
    } finally { setLoading(false); }
  };

  const refresh = async () => {
    setRefreshing(true);
    try { await api.refresh('journey'); await load(); showFlash('Обновлено', true); }
    catch { showFlash('Ошибка обновления', false); }
    finally { setRefreshing(false); }
  };

  useEffect(() => { load(); }, []);

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const totalReady = accounts.reduce((s, a) => s + a.levels.filter(l => l.condition_met && !l.claimed).length, 0);
  const totalClaimed = accounts.reduce((s, a) => s + a.levels.filter(l => l.claimed).length, 0);
  const totalLevels = accounts.reduce((s, a) => s + a.levels.length, 0);

  return (
    <Box sx={{ p: 3 }}>
      {/* Page header */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Heading as="h2" sx={{ fontSize: 3 }}>Путь Мэра</Heading>
        <Button leadingVisual={SyncIcon} loading={refreshing} onClick={refresh}>Обновить</Button>
      </Box>

      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      {/* Summary */}
      {accounts.length > 0 && (
        <Box sx={{ display: 'flex', gap: 3, mb: 4, flexWrap: 'wrap' }}>
          <Box sx={{ flex: 1, minWidth: 140, border: '1px solid', borderColor: 'border.default', borderRadius: 2, p: 3, bg: 'canvas.subtle', textAlign: 'center' }}>
            <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 1 }}>Аккаунты</Text>
            <Text sx={{ fontSize: 4, fontWeight: 'bold', color: 'fg.default' }}>{accounts.length}</Text>
          </Box>
          <Box sx={{ flex: 1, minWidth: 140, border: '1px solid', borderColor: 'success.muted', borderRadius: 2, p: 3, bg: 'success.subtle', textAlign: 'center' }}>
            <Text sx={{ fontSize: 0, color: 'success.fg', display: 'block', mb: 1 }}>Получено</Text>
            <Text sx={{ fontSize: 4, fontWeight: 'bold', color: 'success.fg' }}>{totalClaimed}</Text>
            <Text sx={{ fontSize: 0, color: 'success.fg' }}>из {totalLevels}</Text>
          </Box>
          <Box sx={{ flex: 1, minWidth: 140, border: '1px solid', borderColor: totalReady > 0 ? 'attention.muted' : 'border.default', borderRadius: 2, p: 3, bg: totalReady > 0 ? 'attention.subtle' : 'canvas.subtle', textAlign: 'center' }}>
            <Text sx={{ fontSize: 0, color: totalReady > 0 ? 'attention.fg' : 'fg.muted', display: 'block', mb: 1 }}>Готово к получению</Text>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1 }}>
              <Text sx={{ fontSize: 4, fontWeight: 'bold', color: totalReady > 0 ? 'attention.fg' : 'fg.default' }}>{totalReady}</Text>
              {totalReady > 0 && <CounterLabel>{totalReady}</CounterLabel>}
            </Box>
          </Box>
        </Box>
      )}

      {accounts.length === 0
        ? <Text sx={{ color: 'fg.muted' }}>Нет данных</Text>
        : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {accounts.map(a => <AccountCard key={a.name} account={a} />)}
          </Box>
        )
      }
    </Box>
  );
}
