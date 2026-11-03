import { useEffect, useRef, useState } from 'react';
import { Box, Button, Flash, Spinner, Text, TextInput } from '@primer/react';
import { Dialog } from '@primer/react/experimental';
import { api, type SatoshiOpenPosition } from '../api';
import { CrystalValue } from './Icons';
import { fmt } from '../utils';

type Snapshot = { position: SatoshiOpenPosition; balance: number; maxAmount: number };
export function SatoshiMarginDialog({ position, onClose, onChanged }: { position: SatoshiOpenPosition; onClose: () => void; onChanged: () => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [amount, setAmount] = useState('1');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const posting = useRef(false);
  useEffect(() => {
    let alive = true;
    setLoading(true); setSnapshot(null); setLoadError('');
    if (!position.account_id) { setLoading(false); setLoadError('Аккаунт позиции не найден'); return; }
    api.satoshiMarginPreview(position.account_id, position.id).then(r => {
      if (!alive) return;
      if (r.ok && r.position && r.balance != null && r.maxAmount != null) { setSnapshot({ position: r.position, balance: r.balance, maxAmount: r.maxAmount }); setLoadError(''); }
      else setLoadError(r.error ?? 'Не удалось проверить позицию');
    }).catch(e => { if (alive) setLoadError(String(e)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [position.account_id, position.id, revision]);
  const add = Number(amount);
  const valid = !!snapshot && /^\d+$/.test(amount) && Number.isSafeInteger(add) && add > 0 && add <= snapshot.maxAmount;
  const newMargin = snapshot ? Number(snapshot.position.margin) + (valid ? add : 0) : 0;
  const notional = Number(snapshot?.position.notional ?? 0);
  const ratio = notional > 0 ? (newMargin - Math.max(newMargin * .005, .5)) / notional : 0;
  const liq = Number(snapshot?.position.entry_price ?? 0) * (snapshot?.position.side === 'short' ? 1 + ratio : 1 - ratio);
  const save = async () => {
    if (!valid || !position.account_id || posting.current) return;
    posting.current = true; setBusy(true); setError('');
    try {
      const r = await api.satoshiAddMargin(position.account_id, position.id, add);
      onChanged();
      if (r.ok && !r.refreshWarning) onClose();
      else { setError(r.refreshWarning ? `Маржа добавлена. Не удалось обновить состояние: ${r.refreshWarning}` : r.error ?? 'Ошибка добавления маржи'); setRevision(n => n + 1); }
    } catch (e) { setError(String(e)); onChanged(); setRevision(n => n + 1); }
    finally { posting.current = false; setBusy(false); }
  };
  return <Dialog title={`Добавить маржу — ${position.account} #${position.id}`} onClose={() => { if (!posting.current) onClose(); }} width="large" position={{ narrow: 'bottom', regular: 'center' }}
    footerButtons={[{ content: 'Отмена', disabled: busy, onClick: onClose }, { content: 'Добавить маржу', buttonType: 'primary', loading: busy, disabled: loading || busy || !valid, onClick: save }]}>
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {error && <Flash variant="danger">{error}</Flash>}
      {loadError && <Flash variant="danger">{loadError}</Flash>}
      {loading ? <Spinner size="small" /> : snapshot ? <>
        <Text>Текущая маржа: <CrystalValue value={fmt(Number(snapshot.position.margin))} /></Text>
        <Text>Баланс: <CrystalValue value={fmt(snapshot.balance)} /> · Доступно для добавления: <CrystalValue value={fmt(snapshot.maxAmount)} /></Text>
        <TextInput aria-label="Добавить кристаллов в маржу" type="number" min={1} max={snapshot.maxAmount} step={1} value={amount} onChange={e => setAmount(e.target.value)} disabled={busy} block />
        <Button disabled={busy || snapshot.maxAmount < 1} onClick={() => setAmount(String(snapshot.maxAmount))}>Максимум</Button>
        {snapshot.maxAmount < 1 && <Text sx={{ color: 'fg.muted' }}>Нет свободных кристаллов или позиция уже обеспечена до плеча 1×.</Text>}
        {valid && <Box sx={{ bg: 'canvas.subtle', borderRadius: 2, p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Text>Новая маржа: <CrystalValue value={fmt(newMargin)} /></Text>
          <Text>Эффективное плечо: {(notional / newMargin).toFixed(2)}×</Text>
          <Text>Оценка цены ликвидации: {liq.toFixed(3)}</Text>
        </Box>}
        <Text sx={{ color: 'fg.muted', fontSize: 0 }}>Размер позиции и ценовые уровни TP/SL сохраняются. Процентные пороги бота будут пересчитаны, чтобы сохранить прежнюю сумму прибыли или убытка.</Text>
      </> : <Button disabled={busy} onClick={() => setRevision(n => n + 1)}>Повторить проверку</Button>}
    </Box>
  </Dialog>;
}
