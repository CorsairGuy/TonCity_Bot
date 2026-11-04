import { useState } from 'react';
import { Box, Button, Flash, Text, UnderlineNav, Spinner, TextInput, Label } from '@primer/react';
import { Dialog } from '@primer/react/experimental';
import { SyncIcon } from '@primer/octicons-react';
import { api } from '../api';
import { useExtra } from '../hooks/useExtra';
import { fmt, fmtInt } from '../utils';
import { RenownValue, CoinValue, CrystalValue } from './Icons';

// Казна, Почёт и достижения гильдии (новые ручки 2.5, routes/gameExtras.js). Данные — последний
// снимок из БД, «Обновить» спрашивает игру. Взнос Почёта — только вручную, с подтверждением суммы.
type Person = { user_id?: number; first_name?: string | null; last_name?: string | null; username?: string | null };
type TreasuryAction = Person & { action_type?: string; currency?: string; amount?: number; created_at?: string };
type TreasuryLbRow = Person & { coins_contribution?: number; crystals_contribution?: number };
type RenownAction = Person & { type?: string; amount?: number; created_at?: string };
type RenownLbRow = Person & { contribution?: number };
type RenownState = { balance?: number; guild_balance?: number; guild_earned?: number };
type GuildAch = { id?: string; achievement_id?: string; name?: unknown; title?: unknown; current_milestone?: number; progress?: number | null; milestones?: { level: number; requirement?: number }[] };

const who = (p: Person) => [p.first_name, p.last_name].filter(Boolean).join(' ') || p.username || (p.user_id != null ? `#${p.user_id}` : '—');
const when = (s?: string) => s ? new Date(s).toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
const locText = (v: unknown) => typeof v === 'string' ? v : (v && typeof v === 'object' ? ((v as Record<string, string>).ru || (v as Record<string, string>).en || '') : '');
const listOf = <T,>(d: unknown, key?: string): T[] => Array.isArray(d) ? d as T[] : (key && d && typeof d === 'object' && Array.isArray((d as Record<string, unknown>)[key]) ? (d as Record<string, T[]>)[key] : []);

function Stamp({ at, refreshing, onRefresh }: { at: string | null; refreshing: boolean; onRefresh: () => void }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
      <Text sx={{ fontSize: 0, color: 'fg.muted', flex: 1 }}>{at ? `Снимок от ${new Date(at).toLocaleString('ru')}` : 'Ещё не загружалось — нажмите «Обновить»'}</Text>
      <Button size="small" leadingVisual={SyncIcon} loading={refreshing} onClick={onRefresh}>Обновить</Button>
    </Box>
  );
}
function Rows({ children, empty }: { children: React.ReactNode[]; empty: string }) {
  if (!children.length) return <Text sx={{ color: 'fg.muted', display: 'block', py: 2 }}>{empty}</Text>;
  return <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2 }}>{children}</Box>;
}
function Row({ i, left, right }: { i: number; left: React.ReactNode; right: React.ReactNode }) {
  return <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 3, py: 2, borderTop: i ? '1px solid' : 'none', borderColor: 'border.muted' }}><Box sx={{ flex: 1, minWidth: 0 }}>{left}</Box>{right}</Box>;
}

function TreasuryTab({ accountId }: { accountId: number }) {
  const actions = useExtra<unknown>('treasury-actions', accountId);
  const lb = useExtra<{ coins?: TreasuryLbRow[]; crystals?: TreasuryLbRow[] }>('treasury-lb', accountId);
  const [cur, setCur] = useState<'coins' | 'crystals'>('coins');
  const refresh = async () => { await actions.refresh(); await lb.refresh(); };
  const acts = listOf<TreasuryAction>(actions.data, 'actions');
  const top = (cur === 'coins' ? lb.data?.coins : lb.data?.crystals) ?? [];
  const err = actions.error || lb.error;
  return (
    <>
      <Stamp at={actions.updatedAt} refreshing={actions.refreshing || lb.refreshing} onRefresh={refresh} />
      {err && <Flash variant="danger" sx={{ mb: 2 }}>{err}</Flash>}
      <Text sx={{ fontWeight: 'bold', display: 'block', mb: 2 }}>Последние операции</Text>
      <Rows empty="Операций нет">{acts.slice(0, 30).map((a, i) => (
        <Row key={i} i={i} left={<><Text sx={{ display: 'block' }}>{who(a)}</Text><Text sx={{ fontSize: 0, color: 'fg.muted' }}>{when(a.created_at)}</Text></>}
          right={<Text sx={{ fontWeight: 'semibold', color: a.action_type === 'deposit' ? 'success.fg' : 'danger.fg' }}>{a.action_type === 'deposit' ? '+' : '−'}{a.currency === 'crystals' ? <CrystalValue value={fmtInt(a.amount ?? 0)} /> : <CoinValue value={fmt(a.amount ?? 0)} />}</Text>} />
      ))}</Rows>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 3, mb: 2 }}>
        <Text sx={{ fontWeight: 'bold', flex: 1 }}>Лучшие вкладчики</Text>
        <Button size="small" variant={cur === 'coins' ? 'primary' : 'default'} onClick={() => setCur('coins')}>Монеты</Button>
        <Button size="small" variant={cur === 'crystals' ? 'primary' : 'default'} onClick={() => setCur('crystals')}>Кристаллы</Button>
      </Box>
      <Rows empty="Пусто">{top.slice(0, 20).map((r, i) => (
        <Row key={i} i={i} left={<Text>{i + 1}. {who(r)}</Text>}
          right={cur === 'coins' ? <CoinValue value={fmt(r.coins_contribution ?? 0)} /> : <CrystalValue value={fmtInt(r.crystals_contribution ?? 0)} />} />
      ))}</Rows>
    </>
  );
}

function RenownTab({ accountId }: { accountId: number }) {
  const st = useExtra<RenownState>('renown', accountId);
  const actions = useExtra<unknown>('renown-actions', accountId);
  const lb = useExtra<unknown>('renown-lb', accountId);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const refresh = async () => { await st.refresh(); await actions.refresh(); await lb.refresh(); };
  const n = Math.floor(Number(amount));
  const balance = st.data?.balance ?? 0;
  const deposit = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.extraAction('renown-deposit', { account_id: accountId, amount: n });
      if (r.ok) { setMsg({ ok: true, t: `Вложено ${fmtInt(n)} Почёта` }); setAmount(''); await st.refresh(); await actions.refresh(); }
      else setMsg({ ok: false, t: r.error ?? 'Ошибка' });
    } finally { setBusy(false); }
  };
  return (
    <>
      <Stamp at={st.updatedAt} refreshing={st.refreshing || actions.refreshing || lb.refreshing} onRefresh={refresh} />
      {(st.error || msg) && <Flash variant={msg?.ok ? 'success' : 'danger'} sx={{ mb: 2 }}>{msg?.t ?? st.error}</Flash>}
      <Box sx={{ display: 'flex', gap: 4, mb: 3, flexWrap: 'wrap' }}>
        <Box><Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>Мой Почёт</Text><Text sx={{ fontSize: 3, fontWeight: 'bold' }}><RenownValue value={fmtInt(balance)} /></Text></Box>
        <Box><Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>Казна Почёта гильдии</Text><Text sx={{ fontSize: 3, fontWeight: 'bold' }}><RenownValue value={fmtInt(st.data?.guild_balance ?? 0)} /></Text></Box>
        <Box><Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>Гильдия заработала</Text><Text sx={{ fontSize: 3, fontWeight: 'bold' }}>{fmtInt(st.data?.guild_earned ?? 0)}</Text></Box>
      </Box>
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', mb: 3, flexWrap: 'wrap' }}>
        <TextInput type="number" placeholder="Сумма Почёта" value={amount} onChange={e => setAmount(e.target.value)} sx={{ width: 160 }} />
        <Button size="small" onClick={() => setAmount(String(Math.floor(balance / 2)))} disabled={!balance}>Половина</Button>
        <Button variant="primary" loading={busy} disabled={!(n > 0) || n > balance || !st.updatedAt} onClick={deposit}>Вложить в гильдию</Button>
        {n > balance && <Text sx={{ fontSize: 0, color: 'danger.fg' }}>Больше, чем есть</Text>}
      </Box>
      <Text sx={{ fontWeight: 'bold', display: 'block', mb: 2 }}>Операции с казной Почёта</Text>
      <Rows empty="Операций нет">{listOf<RenownAction>(actions.data, 'actions').slice(0, 30).map((a, i) => (
        <Row key={i} i={i} left={<><Text sx={{ display: 'block' }}>{who(a)} <Label size="small" variant={a.type === 'deposit' ? 'success' : 'attention'}>{a.type === 'deposit' ? 'вклад' : 'трата'}</Label></Text><Text sx={{ fontSize: 0, color: 'fg.muted' }}>{when(a.created_at)}</Text></>}
          right={<Text sx={{ fontWeight: 'semibold', color: a.type === 'deposit' ? 'success.fg' : 'danger.fg' }}>{a.type === 'deposit' ? '+' : '−'}<RenownValue value={fmt(a.amount ?? 0)} /></Text>} />
      ))}</Rows>
      <Text sx={{ fontWeight: 'bold', display: 'block', mt: 3, mb: 2 }}>Лучшие вкладчики Почёта</Text>
      <Rows empty="Пусто">{listOf<RenownLbRow>(lb.data, 'leaderboard').slice(0, 20).map((r, i) => (
        <Row key={i} i={i} left={<Text>{i + 1}. {who(r)}</Text>} right={<RenownValue value={fmt(r.contribution ?? 0)} />} />
      ))}</Rows>
    </>
  );
}

function AchTab({ accountId }: { accountId: number }) {
  const a = useExtra<unknown>('guild-achievements', accountId);
  const list = listOf<GuildAch>(a.data, 'achievements');
  return (
    <>
      <Stamp at={a.updatedAt} refreshing={a.refreshing} onRefresh={a.refresh} />
      {a.error && <Flash variant="danger" sx={{ mb: 2 }}>{a.error}</Flash>}
      <Rows empty="Достижений нет">{list.map((x, i) => {
        const total = x.milestones?.length ?? 0, cur = x.current_milestone ?? 0;
        return <Row key={i} i={i} left={<Text>{locText(x.name) || locText(x.title) || x.achievement_id || x.id}</Text>}
          right={<Label variant={total && cur >= total ? 'success' : 'secondary'}>{cur}/{total || '?'}</Label>} />;
      })}</Rows>
    </>
  );
}

export function GuildExtrasModal({ accountId, title, onClose }: { accountId: number; title: string; onClose: () => void }) {
  const [tab, setTab] = useState<'treasury' | 'renown' | 'ach'>('treasury');
  const tabs: [typeof tab, string][] = [['treasury', 'Казна'], ['renown', 'Почёт'], ['ach', 'Достижения']];
  return (
    <Dialog title={`Гильдия · ${title}`} onClose={onClose} width="large" position={{ narrow: 'bottom', regular: 'center' }}>
      <UnderlineNav aria-label="Разделы гильдии" sx={{ mb: 3 }}>
        {tabs.map(([k, t]) => <UnderlineNav.Item key={k} href="#" aria-current={k === tab ? 'page' : undefined} onSelect={e => { e.preventDefault(); setTab(k); }}>{t}</UnderlineNav.Item>)}
      </UnderlineNav>
      {tab === 'treasury' ? <TreasuryTab accountId={accountId} /> : tab === 'renown' ? <RenownTab accountId={accountId} /> : <AchTab accountId={accountId} />}
    </Dialog>
  );
}
void Spinner;
