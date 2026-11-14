import { useState, useEffect, useRef } from 'react';
import { GuildDiscovery } from '../components/GuildDiscovery';
import { RenownTab, AchTab } from '../components/GuildExtrasModal';
import { GuildGifts } from '../components/GuildGifts';
import { GuildTreasury } from '../components/GuildTreasury';
import { SidePage, CatTabs, SELECTED_RING } from '../components/SidePage';
import { PanelShell, Row, Summary, Tile, SumLine, Val } from './cityMapPanels';
import { CoinIcon, CrystalIcon, CoinValue, CrystalValue } from '../components/Icons';
import { OrganizationIcon, PeopleIcon, SearchIcon, SyncIcon, GiftIcon, KebabHorizontalIcon, SignOutIcon, GearIcon } from '@primer/octicons-react';
import { Box, Button, Checkbox, Flash, Heading, Label, Select, Text, TextInput, Spinner, UnderlineNav, ActionMenu, ActionList, FormControl } from '@primer/react';
import { Dialog } from '@primer/react/experimental';
import { DataTable, Table } from '@primer/react/experimental';
import { api, type GuildMembership, type GuildApplication, type GuildMember, type GuildSettings, type GuildFeesState, type Account } from '../api';
import { fmt } from '../utils';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { useAsk } from '../hooks/useAsk';

// автооплата взносов всех аккаунтов (modules/guildFeesAuto.js) — отдельная настройка, по умолчанию выключена
function GuildFeesAuto() {
  const [cfg, setCfg] = useState<{ auto: boolean; coins: string; crystals: string } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const ask = useAsk();
  useEffect(() => { api.config().then(r => { if (r.ok) { const g = r.settings.guildFees ?? {}; setCfg({ auto: !!g.auto, coins: String(g.reserve?.coins ?? 0), crystals: String(g.reserve?.crystals ?? 0) }); } }); }, []);
  if (!cfg) return null;
  const save = async (next: typeof cfg) => {
    const r = await api.saveConfig({ guildFees: { auto: next.auto, reserve: { coins: Math.max(0, Number(next.coins) || 0), crystals: Math.max(0, Number(next.crystals) || 0) } } });
    setSaved(r.ok ? 'Сохранено' : 'Не удалось сохранить');
  };
  const toggle = async () => {
    if (!cfg.auto && !await ask('Включить автооплату взносов?', 'Бот раз в 3 часа будет сам оплачивать остаток взноса на всех аккаунтах, если после оплаты на балансе останется не меньше резерва.', { ok: 'Включить' })) return;
    const next = { ...cfg, auto: !cfg.auto }; setCfg(next); void save(next);
  };
  return <Box sx={{ borderTop: '1px solid', borderColor: 'border.default', pt: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
    <Box as="label" sx={{ display: 'flex', gap: 2, alignItems: 'center', fontWeight: 'semibold' }}>
      <Checkbox checked={cfg.auto} onChange={toggle} /> Автооплата взносов на всех аккаунтах
    </Box>
    <Text sx={{ color: 'fg.muted', fontSize: 1 }}>Оставлять на балансе после оплаты не меньше:</Text>
    <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
      <TextInput sx={{ width: 160 }} trailingVisual="монет" inputMode="numeric" value={cfg.coins} onChange={e => setCfg({ ...cfg, coins: e.target.value.replace(/\D/g, '') })} onBlur={() => save(cfg)} />
      <TextInput sx={{ width: 160 }} trailingVisual="алмазов" inputMode="numeric" value={cfg.crystals} onChange={e => setCfg({ ...cfg, crystals: e.target.value.replace(/\D/g, '') })} onBlur={() => save(cfg)} />
      {saved && <Text sx={{ color: 'fg.muted', fontSize: 0 }}>{saved}</Text>}
    </Box>
  </Box>;
}

const FEE_STATUS: Record<string, string> = { due: 'нужно оплатить', paid: 'оплачен', exempt: 'освобождён', next_period: 'со следующего периода' };
function GuildFeesModal({ accountId, accountName, onClose }: { accountId: number; accountName: string; onClose: () => void }) {
  const [data, setData] = useState<GuildFeesState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<{ msg: string; ok: boolean } | null>(null);
  const ask = useAsk();
  const load = async () => {
    setLoading(true);
    try {
      const r = await api.guildFees(accountId);
      if (r.ok && r.fees) { setData(r as GuildFeesState); setNote(null); }
      else { setData(null); setNote({ msg: r.error || 'Ошибка загрузки', ok: false }); }
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [accountId]);
  const pay = async () => {
    if (!data?.payable || data.remaining == null) return;
    const currency = data.currency === 'crystals' ? 'алмазов' : 'монет';
    if (!await ask('Оплатить членский взнос?', `С аккаунта «${accountName}» в казну «${data.guild_title}» поступит ${fmt(data.remaining)} ${currency}. Оплачивается только оставшийся долг.`, { ok: 'Оплатить' })) return;
    setBusy(true);
    try {
      const r = await api.guildFeesPay(accountId, data);
      setData(r.fees ? r as GuildFeesState : null);
      setNote({ msg: r.ok ? `Взнос оплачен.${r.refresh_error ? ' Не удалось обновить все данные — нажмите Обновить.' : ''}` : r.error || 'Ошибка оплаты', ok: r.ok });
    } finally { setBusy(false); }
  };
  const me = data?.fees.me;
  return <Dialog title={`Членский взнос · ${accountName}`} onClose={busy ? () => {} : onClose} width="large" position={{ narrow: 'bottom', regular: 'center' }}>
    <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
      {note && <Flash variant={note.ok ? 'success' : 'danger'}>{note.msg}</Flash>}
      {loading ? <Spinner /> : data && <>
        <Text sx={{ fontWeight: 'semibold' }}>{data.guild_title}</Text>
        {!data.fees.current ? <Text sx={{ color: 'fg.muted' }}>Текущего периода взносов нет</Text> : <>
          <Text>Статус: {FEE_STATUS[me?.status ?? ''] ?? me?.status ?? 'нет данных'}</Text>
          <Text>Внесено {fmt(me?.deposited ?? 0)} из {fmt(me?.required ?? 0)} {data.currency === 'crystals' ? 'алмазов' : 'монет'}</Text>
          <Text>Остаток: {data.remaining == null ? 'нет данных' : fmt(data.remaining)}</Text>
          {data.deadline != null && <Text sx={{ color: 'fg.muted' }}>Срок: {new Date(data.deadline).toLocaleString('ru')}</Text>}
          <Button variant="primary" loading={busy} disabled={!data.payable || busy} onClick={pay}>Оплатить остаток</Button>
        </>}
        {data.fees.upcoming && <Text sx={{ color: 'fg.muted' }}>Следующий период: {fmt(data.fees.upcoming.terms?.amount ?? 0)} {data.fees.upcoming.terms?.currency === 'crystals' ? 'алмазов' : 'монет'}</Text>}
        {!!data.fees.members?.length && <Table.Container><DataTable data={data.fees.members.map((m, i) => ({ ...m, id: m.user_id ?? i }))} columns={[
          { header: 'Участник', field: 'id', rowHeader: true, renderCell: m => [m.first_name, m.last_name].filter(Boolean).join(' ') || `#${m.user_id ?? m.id}` },
          { header: 'Внесено', field: 'deposited', renderCell: m => `${fmt(m.deposited)} / ${fmt(m.required)}` },
          { header: 'Статус', field: 'status', renderCell: m => FEE_STATUS[m.status] ?? m.status },
        ]} /></Table.Container>}
      </>}
      <Button disabled={loading || busy} onClick={load}>Обновить взнос</Button>
      <GuildFeesAuto />
    </Box>
  </Dialog>;
}

function GuildDepositModal({ row, currency: initialCurrency, coins, crystals, onClose, onChanged }: {
  row: GuildMembership; currency: 'coins' | 'crystals'; coins: number | null; crystals: number | null;
  onClose: () => void; onChanged: () => Promise<void>;
}) {
  const [currency, setCurrency] = useState(initialCurrency);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; msg: string } | null>(null);
  const ask = useAsk();
  const saved = currency === 'coins' ? coins : crystals;
  const max = saved != null && Number.isFinite(saved) && saved >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(saved)) : null;
  const n = Number(amount), valid = max != null && Number.isSafeInteger(n) && n > 0 && n <= max;
  const unit = currency === 'coins' ? 'монет' : 'алмазов';
  const choose = (value: number) => setAmount(String(Math.max(0, Math.min(max ?? 0, Math.floor(value)))));
  const pay = async () => {
    if (!valid || busy || row.account_id == null) return;
    if (!await ask('Внести в казну?', `С аккаунта «${row.account}» в гильдию «${row.guild_title}» будет внесено ${n.toLocaleString('ru')} ${unit}.`, { ok: 'Внести' })) return;
    setBusy(true); setNote(null);
    try {
      const r = await api.guildDeposit(row.account_id, row.guild_id, currency, n);
      // В том числе после неоднозначного ответа перечитываем только БД; POST не повторяем.
      await onChanged();
      if (!r.ok) { setNote({ ok: false, msg: r.error ?? 'Перед повтором проверьте баланс и историю казны.' }); return; }
      setAmount('');
      const fresh = await Promise.allSettled([api.extraRefresh('treasury', row.account_id), api.extraRefresh('treasury-actions', row.account_id), api.extraRefresh('treasury-lb', row.account_id)]);
      await onChanged();
      const updated = fresh.every(r => r.status === 'fulfilled' && r.value.ok);
      setNote({ ok: true, msg: `Внесено ${n.toLocaleString('ru')} ${unit}.${updated ? '' : ' Взнос выполнен, но снимок казны обновить не удалось.'}` });
    } catch (e) { setNote({ ok: false, msg: `${String(e)}. Перед повтором проверьте баланс и историю казны.` }); }
    finally { setBusy(false); }
  };
  return <Dialog title={`Взнос в казну · ${row.guild_title}`} onClose={busy ? () => {} : onClose} width="large" position={{ narrow: 'bottom', regular: 'center' }}>
    <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Row title={row.account} sub={row.guild_title} />
      {note && <Flash variant={note.ok ? 'success' : 'danger'}>{note.msg}</Flash>}
      <CatTabs tabs={['Монеты', 'Алмазы']} value={currency === 'coins' ? 0 : 1} onChange={i => { if (!busy) { setCurrency(i === 0 ? 'coins' : 'crystals'); setAmount(''); setNote(null); } }} />
      <Summary tone="accent"><Tile value={max == null ? '—' : currency === 'coins' ? <CoinValue value={max.toLocaleString('ru')} /> : <CrystalValue value={max.toLocaleString('ru')} />} label="доступно на аккаунте" /><SumLine left="Сохранённый баланс" /></Summary>
      {max == null && <Text sx={{ color: 'fg.muted' }}>Нет снимка баланса — нажмите «Обновить» на странице гильдий.</Text>}
      <FormControl disabled={busy || max == null}><FormControl.Label>Сумма взноса</FormControl.Label><TextInput aria-label="Сумма взноса" type="number" min={1} max={max ?? 0} step={1} value={amount} onChange={e => setAmount(max != null && Number(e.target.value) > max ? String(max) : e.target.value)} placeholder="Сумма" block /></FormControl>
      <Box as="input" aria-label="Доля баланса" type="range" min={0} max={max ?? 0} step={1} value={Math.max(0, Math.min(max ?? 0, Number.isFinite(n) ? n : 0))} disabled={busy || !max} onChange={(e: React.ChangeEvent<HTMLInputElement>) => choose(Number(e.target.value))} sx={{ width: '100%', m: 0, accentColor: 'var(--cyan)' }} />
      <SumLine left="0" right={max == null ? '—' : max.toLocaleString('ru')} />
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 2 }}>{[25, 50, 75, 100].map(p => <Button key={p} disabled={busy || !max} onClick={() => choose((max ?? 0) * p / 100)}>{p}%</Button>)}</Box>
      <SumLine left="Останется на аккаунте" right={max == null ? '—' : Math.max(0, max - (valid ? n : 0)).toLocaleString('ru')} />
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}><Button disabled={busy} onClick={onClose}>Отмена</Button><Button variant="primary" disabled={!valid || busy} loading={busy} onClick={pay}>Внести {valid ? n.toLocaleString('ru') : unit}</Button></Box>
    </Box>
  </Dialog>;
}

// ── бафы гильдии (GET /guilds/benefits) ──────────────────────────────────────
type GuildBenefits = {
  additional_builder?: number;
  income_boost?: number;
  upgrades_discount?: number;
  building_purchases_discount?: number;
  reduced_upgrade_times?: number;
  storage_cap_increase?: number;
};
function benefitText(kind: 'pct+' | 'pct-' | 'abs' | 'time', v: number): string {
  if (kind === 'time') return '+' + fmtStorageBonus(v);
  if (kind === 'abs') return '+' + fmt(v);
  return (kind === 'pct+' ? '+' : '−') + Math.round(v * 100) + '%';
}
// storage_cap_increase приходит в секундах — доп. время сверх базовых 6ч сбора прибыли
function fmtStorageBonus(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0 && m > 0) return `${h}ч ${m}м`;
  if (h > 0) return `${h}ч`;
  return `${m}м`;
}
// benefits хранится как { benefits: {...}, guild_type: '...' } — достаём вложенное
function extractBenefits(raw: unknown): GuildBenefits | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const b = (obj.benefits ?? obj) as GuildBenefits;
  return b && typeof b === 'object' ? b : null;
}
function extractGuildType(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = (raw as Record<string, unknown>).guild_type;
  return typeof t === 'string' ? t : null;
}

// ── модалка заявок на вступление ────────────────────────────────────────────
function ApplicationsModal({ guildId, accountId, title, onClose, showFlash: showPageFlash }: {
  guildId: string; accountId: number; title: string; onClose: () => void; showFlash: (m: string, ok: boolean) => void;
}) {
  // сообщения — внутри окна: флэш на странице прятался под затемнением открытого диалога
  const [note, setNote] = useState<{ msg: string; ok: boolean } | null>(null);
  const showFlash = (msg: string, ok: boolean) => { setNote({ msg, ok }); showPageFlash(msg, ok); };
  const [apps, setApps] = useState<GuildApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    try { const d = await api.guildApplications(guildId, accountId); if (d.ok) setApps(d.applications); else showFlash(d.error || 'Ошибка', false); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const act = async (appId: number, name: string, kind: 'approve' | 'reject') => {
    setBusy(appId);
    try {
      const d = kind === 'approve' ? await api.guildAppApprove(guildId, appId, accountId) : await api.guildAppReject(guildId, appId, accountId);
      if (d.ok) { showFlash(`${kind === 'approve' ? 'Принят' : 'Отклонён'}: ${name}`, true); setApps(a => a.filter(x => x.id !== appId)); }
      else showFlash(d.error || 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); } finally { setBusy(null); }
  };

  return (
    <Dialog title={`Заявки · ${title}`} onClose={onClose} width="xlarge" position={{ narrow: 'bottom', regular: 'center' }}>
      <Box>
        {note && <Flash variant={note.ok ? 'success' : 'danger'} sx={{ mb: 2 }}>{note.msg}</Flash>}
        <Box sx={{ mb: 2 }}>
          <Button onClick={load} disabled={loading}>↻ Обновить</Button>
        </Box>
        {loading ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><Spinner /></Box>
          : apps.length === 0 ? <Text sx={{ color: 'fg.muted' }}>Нет заявок на вступление</Text>
          : apps.map(a => (
            <Box key={a.id} sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 1, py: '8px', borderBottom: '1px solid', borderColor: 'border.muted' }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Text sx={{ fontWeight: 'bold', fontSize: 1 }}>{a.first_name}{a.last_name ? ` ${a.last_name}` : ''}</Text>
                <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>👥 {fmt(a.population)} · 🪙 {fmt(a.profit)}/ч · {new Date(a.timestamp).toLocaleDateString()}</Text>
              </Box>
              <Button variant="primary" loading={busy === a.id} disabled={busy != null} onClick={() => act(a.id, a.first_name, 'approve')}>Принять</Button>
              <Button variant="danger" disabled={busy != null} onClick={() => act(a.id, a.first_name, 'reject')}>Отклонить</Button>
            </Box>
          ))
        }
      </Box>
    </Dialog>
  );
}

// ── модалка участников гильдии ──────────────────────────────────────────────
const ONLINE_COLOR: Record<string, string> = { green: 'var(--green)', yellow: '#d4a23c', red: 'var(--red)', gray: 'var(--fg-subtle)' };
const ROLE_NAME: Record<string, string> = { Leader: 'Лидер', Officer: 'Офицер', Member: 'Участник' };

function GuildMembersPanel({ guildId, accountId, myRole, showFlash }: {
  guildId: string; accountId: number; myRole: string; showFlash: (m: string, ok: boolean) => void;
}) {
  const [members, setMembers] = useState<GuildMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const isLeader = myRole === 'Leader';
  const ask = useAsk();

  const load = async (manual = false) => {
    if (manual) setRefreshing(true);
    else setLoading(true);
    try {
      const d = await api.guildMembers(guildId, accountId);
      if (d.ok) setMembers(d.members);
      else showFlash(d.error || 'Не удалось загрузить участников гильдии', false);
    } finally { setLoading(false); setRefreshing(false); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [guildId, accountId]);

  const act = async (m: GuildMember, action: 'promote' | 'demote' | 'kick' | 'promote-to-leader') => {
    if (action === 'promote-to-leader' && !await ask('Передать лидерство?', `Лидером станет ${m.first_name}, вы станете офицером.`, { ok: 'Передать', danger: true })) return;
    if (action === 'kick' && !await ask('Исключить из гильдии?', `${m.first_name} будет исключён из гильдии.`, { ok: 'Исключить', danger: true })) return;
    setBusy(m.id);
    try {
      const d = await api.guildMemberAction(guildId, m.id, action, accountId);
      if (d.ok) { showFlash('Изменения участников сохранены', true); await load(); }
      else showFlash(d.error || 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); } finally { setBusy(null); }
  };

  const sorted = [...members].sort((a, b) => {
    const ro = { Leader: 0, Officer: 1, Member: 2 } as Record<string, number>;
    return (ro[a.role] ?? 3) - (ro[b.role] ?? 3);
  });

  return <Box sx={guildCard}>
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
      <Text sx={{ fontWeight: 'semibold', flex: 1 }}>Участники гильдии{!loading && ` · ${sorted.length}`}</Text>
      <Button size="small" leadingVisual={SyncIcon} loading={refreshing} disabled={loading || refreshing || busy != null} onClick={() => void load(true)}>Обновить список</Button>
    </Box>
    {loading ? <Spinner /> : sorted.length === 0 ? <Text sx={{ color: 'fg.muted' }}>Игра не вернула участников гильдии.</Text>
      : sorted.map(m => (
        <Box key={m.id} sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 1, py: 2, borderTop: '1px solid', borderColor: 'border.muted', flexWrap: 'wrap' }}>
          <Box sx={{ width: 8, height: 8, borderRadius: '50%', bg: ONLINE_COLOR[m.online_status] ?? 'var(--fg-subtle)', flexShrink: 0 }} />
          <Box sx={{ flex: 1, minWidth: 180 }}>
            <Text sx={{ fontWeight: 'bold', fontSize: 1 }}>{m.first_name}{m.last_name ? ` ${m.last_name}` : ''}</Text>
            <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>{ROLE_NAME[m.role] ?? m.role} · 👥 {fmt(m.population)} · 🪙 {fmt(m.profit)}/ч</Text>
          </Box>
          {m.role !== 'Leader' && (
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              {isLeader && m.role === 'Member' && <Button size="small" disabled={busy != null} onClick={() => void act(m, 'promote')}>↑ Офицер</Button>}
              {isLeader && m.role === 'Officer' && <Button size="small" disabled={busy != null} onClick={() => void act(m, 'demote')}>↓ Участник</Button>}
              {isLeader && <Button size="small" disabled={busy != null} onClick={() => void act(m, 'promote-to-leader')}>👑 Лидер</Button>}
              <Button size="small" variant="danger" loading={busy === m.id} disabled={busy != null} onClick={() => void act(m, 'kick')}>Исключить</Button>
            </Box>
          )}
        </Box>
      ))}
  </Box>;
}

// ── модалка настроек гильдии (поля 1:1 с UI игры) ────────────────────────────
const GUILD_TYPES = [{ v: 'open', n: 'Открытая' }, { v: 'closed', n: 'Закрытая' }, { v: 'application', n: 'По заявкам' }];
const GUILD_TYPE_HINT: Record<string, string> = {
  open: 'Любой может вступить мгновенно',
  closed: 'Никто не может вступить',
  application: 'Вступление по заявке',
};
const AUTOKICK = [{ v: 'none', n: 'Нет' }, { v: '7', n: '7 дней' }, { v: '14', n: '14 дней' }, { v: '30', n: '30 дней' }, { v: '90', n: '90 дней' }];
const FEE_TYPES = [{ v: '', n: 'Нет' }, { v: 'hourly', n: 'Почасовой доход' }, { v: 'fixed', n: 'Фикс. сумма' }];
const FEE_FREQ = [{ v: 'daily', n: 'Ежедневно' }, { v: 'weekly', n: 'Еженедельно' }, { v: 'monthly', n: 'Ежемесячно' }];
const FEE_CUR = [{ v: 'coins', n: 'Монеты' }, { v: 'crystals', n: 'Кристаллы' }];

function SettingsModal({ guildId, accountId, title, onClose, showFlash: showPageFlash }: {
  guildId: string; accountId: number; title: string; onClose: () => void; showFlash: (m: string, ok: boolean) => void;
}) {
  // сообщения — внутри окна: флэш на странице прятался под затемнением открытого диалога
  const [note, setNote] = useState<{ msg: string; ok: boolean } | null>(null);
  const showFlash = (msg: string, ok: boolean) => { setNote({ msg, ok }); showPageFlash(msg, ok); };
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [info, setInfo] = useState<GuildSettings | null>(null);
  // форма (модель UI игры)
  const [guildType, setGuildType] = useState('application');
  const [autoAccept, setAutoAccept] = useState(false);
  const [pop, setPop] = useState('');
  const [profit, setProfit] = useState('');
  const [autoKick, setAutoKick] = useState('none');
  const [feeType, setFeeType] = useState('');
  const [feeAmount, setFeeAmount] = useState('');
  const [feeFreq, setFeeFreq] = useState('weekly');
  const [feeCur, setFeeCur] = useState('coins');

  const load = async () => {
    setLoading(true);
    try {
      const d = await api.guildSettings(guildId, accountId);
      if (d.ok) {
        const s = d.settings; setInfo(s);
        setGuildType(s.guild_type || 'application');
        setAutoAccept(!!(s.application_criteria_population || s.application_criteria_profit));
        setPop(s.application_criteria_population ? String(s.application_criteria_population) : '');
        setProfit(s.application_criteria_profit ? String(s.application_criteria_profit) : '');
        setAutoKick(s.auto_kick && s.auto_kick !== 'none' ? String(s.auto_kick) : 'none');
        setFeeType(s.membership_fee_type || '');
        setFeeAmount(s.membership_fee_amount ? String(s.membership_fee_amount) : '');
        setFeeFreq(s.membership_fee_duration || 'weekly');
        setFeeCur(s.membership_fee_currency || 'coins');
      } else showFlash(d.error || 'Ошибка', false);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const criteriaApplicable = guildType === 'application' || guildType === 'open';

  const save = async () => {
    setSaving(true);
    try {
      const criteriaOn = criteriaApplicable && autoAccept;
      const ft = feeType || null;
      const d = await api.guildSaveSettings(guildId, {
        guild_type: guildType,
        auto_kick: autoKick && autoKick !== 'none' ? String(autoKick) : 'none',
        application_criteria_population: criteriaOn && pop ? parseInt(pop) : null,
        application_criteria_profit: criteriaOn && profit ? parseInt(profit) : null,
        membership_fee_type: ft,
        membership_fee_amount: ft ? (parseInt(feeAmount) || 0) : null,
        membership_fee_duration: ft ? feeFreq : null,
        membership_fee_currency: ft ? feeCur : null,
      }, accountId);
      if (d.ok) { showFlash('Настройки сохранены', true); onClose(); }
      else showFlash(d.error || 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); } finally { setSaving(false); }
  };

  const inputSx = { width: 170, flexShrink: 0 } as const;
  const fieldRow = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 } as const;

  return (
    <Dialog
      title={`Настройки · ${title}`}
      onClose={onClose}
      width="xlarge"
      position={{ narrow: 'bottom', regular: 'center' }}
      footerButtons={[{ content: 'Сохранить', buttonType: 'primary', loading: saving, disabled: saving || loading, onClick: save }]}
    >
      <Box>
        {note && <Flash variant={note.ok ? 'success' : 'danger'} sx={{ mb: 2 }}>{note.msg}</Flash>}
        {loading ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><Spinner /></Box>
          : <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {/* Тип набора */}
              <Box>
                <Box sx={fieldRow}>
                  <Text sx={{ fontSize: 1 }}>Тип гильдии</Text>
                  <Select aria-label="Тип гильдии" value={guildType} onChange={e => setGuildType(e.target.value)} sx={inputSx}>
                    {GUILD_TYPES.map(t => <Select.Option key={t.v} value={t.v}>{t.n}</Select.Option>)}
                  </Select>
                </Box>
                <Text sx={{ fontSize: 0, color: 'fg.muted', mt: 1, display: 'block', textAlign: 'right' }}>{GUILD_TYPE_HINT[guildType]}</Text>
              </Box>

              {/* Критерии (только open/application) */}
              {criteriaApplicable && (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pl: 2, borderLeft: '2px solid', borderColor: 'border.muted' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                    <Checkbox checked={autoAccept} onChange={e => setAutoAccept(e.target.checked)} />
                    Включить минимальные критерии для заявок
                  </label>
                  {autoAccept && <>
                    <Box sx={fieldRow}>
                      <Text sx={{ fontSize: 1 }}>Мин. население</Text>
                      <TextInput type="number" aria-label="Мин. население" value={pop} onChange={e => setPop(e.target.value)} placeholder="0" sx={inputSx} />
                    </Box>
                    <Box sx={fieldRow}>
                      <Text sx={{ fontSize: 1 }}>Мин. прибыль/час</Text>
                      <TextInput type="number" aria-label="Мин. прибыль/час" value={profit} onChange={e => setProfit(e.target.value)} placeholder="0" sx={inputSx} />
                    </Box>
                  </>}
                </Box>
              )}

              {/* Авто-исключение */}
              <Box sx={fieldRow}>
                <Text sx={{ fontSize: 1 }}>Порог неактивности</Text>
                <Select aria-label="Порог неактивности" value={autoKick} onChange={e => setAutoKick(e.target.value)} sx={inputSx}>
                  {AUTOKICK.map(t => <Select.Option key={t.v} value={t.v}>{t.n}</Select.Option>)}
                </Select>
              </Box>

              {/* Членский взнос */}
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Box sx={fieldRow}>
                  <Text sx={{ fontSize: 1 }}>Членский взнос</Text>
                  <Select aria-label="Членский взнос" value={feeType} onChange={e => setFeeType(e.target.value)} sx={inputSx}>
                    {FEE_TYPES.map(t => <Select.Option key={t.v} value={t.v}>{t.n}</Select.Option>)}
                  </Select>
                </Box>
                {feeType && <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pl: 2, borderLeft: '2px solid', borderColor: 'border.muted' }}>
                  <Box sx={fieldRow}>
                    <Text sx={{ fontSize: 1 }}>Сумма</Text>
                    <TextInput type="number" aria-label="Сумма" value={feeAmount} onChange={e => setFeeAmount(e.target.value)} placeholder="0" sx={inputSx} />
                  </Box>
                  <Box sx={fieldRow}>
                    <Text sx={{ fontSize: 1 }}>Периодичность</Text>
                    <Select aria-label="Периодичность" value={feeFreq} onChange={e => setFeeFreq(e.target.value)} sx={inputSx}>
                      {FEE_FREQ.map(t => <Select.Option key={t.v} value={t.v}>{t.n}</Select.Option>)}
                    </Select>
                  </Box>
                  <Box sx={fieldRow}>
                    <Text sx={{ fontSize: 1 }}>Валюта</Text>
                    <Select aria-label="Валюта" value={feeCur} onChange={e => setFeeCur(e.target.value)} sx={inputSx}>
                      {FEE_CUR.map(t => <Select.Option key={t.v} value={t.v}>{t.n}</Select.Option>)}
                    </Select>
                  </Box>
                </Box>}
              </Box>

              {info && <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                Вместимость: {info.member_capacity ?? '—'} · Уровень столицы: {info.headquarters_level ?? '—'}{info.is_verified ? ' · ✓ верифицирована' : ''}
              </Text>}
            </Box>
        }
      </Box>
    </Dialog>
  );
}

const guildCard = { p: 2, borderRadius: '12px', border: '1px solid', borderColor: 'border.default', bg: 'canvas.default', display: 'flex', flexDirection: 'column', gap: 2 } as const;
const roleName = (role: string) => ({ Leader: 'Лидер', Officer: 'Офицер', Member: 'Участник', Superuser: 'Администратор' }[role] ?? role);
const rankRole = (role: string) => role === 'Leader' ? 0 : role === 'Officer' ? 1 : 2;
function savedBalance(account: Account | undefined, currency: 'coins' | 'crystals'): number | null {
  const raw = currency === 'coins' ? account?.balance : account?.crystals;
  if (raw == null || String(raw).trim() === '') return null;
  const value = Number(raw); return Number.isFinite(value) && value >= 0 ? value : null;
}

export function Guilds() {
  const [rows, setRows] = useState<GuildMembership[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actors, setActors] = useState<Record<string, number>>({});
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState(0);
  const [tab, setTab] = useState('Казна');
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [feesOpen, setFeesOpen] = useState(false);
  const [deposit, setDeposit] = useState<{ row: GuildMembership; currency: 'coins' | 'crystals' } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [appsGuild, setAppsGuild] = useState<{ id: string; title: string } | null>(null);
  const [setGuild, setSetGuild] = useState<{ id: string; title: string } | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const loadSerial = useRef(0);
  const { flash, showFlash } = useFlash();
  const ask = useAsk();
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:guilds', () => { void load(true); });
  const load = async (silent = false) => {
    const serial = ++loadSerial.current;
    if (!silent) setLoading(true);
    try {
      const [g, a] = await Promise.all([api.guilds(), api.accounts()]);
      if (!g.ok || !a.ok) throw new Error('Не удалось прочитать сохранённые гильдии и балансы');
      if (serial === loadSerial.current) { setRows(g.rows); setAccounts(a.accounts); }
      return g.rows;
    } catch (e) { if (serial === loadSerial.current) showFlash(String(e), false); return null; }
    finally { if (serial === loadSerial.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { loadSerial.current++; }; }, []);

  const currentRows = new Map<number, GuildMembership>();
  for (const row of rows) {
    if (row.account_id == null || !accounts.some(a => a.id === row.account_id)) continue;
    const previous = currentRows.get(row.account_id);
    if (!previous || new Date(row.updated_at).getTime() >= new Date(previous.updated_at).getTime()) currentRows.set(row.account_id, row);
  }
  const groups = new Map<string, { id: string; title: string; members: GuildMembership[] }>();
  for (const row of currentRows.values()) {
    const group = groups.get(row.guild_id) ?? { id: row.guild_id, title: row.guild_title, members: [] };
    group.members.push(row); groups.set(row.guild_id, group);
  }
  const guilds = [...groups.values()].sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  guilds.forEach(g => g.members.sort((a, b) => rankRole(a.role) - rankRole(b.role) || a.account.localeCompare(b.account, 'ru')));
  const searchMode = selectedId === 'search';
  const guild = !searchMode ? guilds.find(g => g.id === selectedId) ?? guilds[0] ?? null : null;
  const selected = guild?.members.find(m => m.account_id === actors[guild.id]) ?? guild?.members[0] ?? null;
  const actor = accounts.find(a => a.id === selected?.account_id);
  const coins = savedBalance(actor, 'coins'), crystals = savedBalance(actor, 'crystals');
  const ungrouped = accounts.filter(a => !currentRows.has(a.id));
  const canManage = selected?.role === 'Leader' || selected?.role === 'Officer';
  const duplicateLeaders = guild?.members.filter(m => m.role === 'Leader') ?? [];
  const benRow = guild?.members.filter(m => m.benefits).sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0];
  const ben = extractBenefits(benRow?.benefits);
  const gtype = extractGuildType(benRow?.benefits);
  const changed = async () => { await load(true); setReloadKey(k => k + 1); };
  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await api.refresh('guilds');
      const latest = await load(true);
      const failed = ((r.results ?? []) as { name?: string; ok?: boolean; error?: string }[]).filter(x => x.ok === false);
      const extraFailed: string[] = [];
      if (selected?.account_id != null && latest?.some(x => x.account_id === selected.account_id && x.guild_id === selected.guild_id)) {
        const kinds = tab === 'Казна' ? ['treasury', 'treasury-actions', 'treasury-lb'] as const : tab === 'Подарки' ? ['guild-gifts'] as const : tab === 'Почёт' ? ['renown', 'renown-actions', 'renown-lb'] as const : tab === 'Достижения' ? ['guild-achievements'] as const : [];
        for (const kind of kinds) { try { const d = await api.extraRefresh(kind, selected.account_id); if (!d.ok) extraFailed.push(d.error ?? kind); } catch (e) { extraFailed.push(String(e)); } }
      }
      setReloadKey(k => k + 1);
      const errors = [...failed.map(x => `${x.name ?? 'аккаунт'}: ${x.error ?? 'ошибка'}`), ...extraFailed];
      showFlash(!r.ok ? 'Не удалось обновить гильдии' : errors.length ? errors.join('; ') : 'Членство, бонусы и данные гильдии обновлены', r.ok && !errors.length);
    } catch (e) { showFlash(String(e), false); }
    finally { setRefreshing(false); }
  };
  const leave = async () => {
    if (selected?.account_id == null || leaving) return;
    const isLeader = selected.role === 'Leader';
    if (!await ask(isLeader ? 'Выйти из гильдии лидером?' : 'Выйти из гильдии?', `Аккаунт «${selected.account}» покинет «${selected.guild_title}».${isLeader ? ' Выход лидера может расформировать гильдию. Действие нельзя отменить.' : ''}`, { ok: 'Выйти', danger: true })) return;
    setLeaving(true);
    try {
      const r = await api.guildLeave(selected.account_id, selected.guild_id, isLeader);
      showFlash(r.ok ? `Аккаунт вышел из гильдии.${r.refresh_error ? ' Снимок не обновлён: ' + r.refresh_error : ''}` : r.error ?? 'Ошибка выхода', r.ok);
      await changed();
    } catch (e) { showFlash(String(e), false); }
    finally { setLeaving(false); }
  };
  const removeDuplicate = async (row: GuildMembership) => {
    if (row.account_id == null || !await ask('Удалить дубль аккаунта?', `Аккаунт «${row.account}» будет удалён из бота. Действие необратимо.`, { ok: 'Удалить', danger: true })) return;
    setDeletingId(row.account_id);
    try { const r = await api.deleteAccount(row.account_id); if (!r.ok) showFlash(r.error ?? 'Ошибка', false); else await changed(); }
    catch (e) { showFlash(String(e), false); } finally { setDeletingId(null); }
  };
  const closeGuildModals = () => { setDeposit(null); setFeesOpen(false); setAppsGuild(null); setSetGuild(null); };
  const pickGuild = (id: string) => { if (leaving || refreshing) return; setSelectedId(id); setTab('Казна'); closeGuildModals(); };
  const side = <PanelShell mode="view" title="Гильдии" busy={loading} hint="Управление доступно от имени выбранного лидера или офицера. Для взноса можно выбрать любой свой аккаунт в гильдии.">
    <Summary tone="accent"><Box sx={{ display: 'flex', gap: 2 }}><Tile size={2} value={guilds.length} label="гильдии" color="accent.fg" /><Tile size={2} value={currentRows.size} label="аккаунтов" /></Box><SumLine left="С лидером" right={guilds.filter(g => g.members.some(m => m.role === 'Leader')).length} /></Summary>
    <TextInput aria-label="Поиск гильдии" placeholder="Поиск гильдии" value={query} onChange={e => setQuery(e.target.value)} block />
    <CatTabs tabs={['Все', 'С лидером']} value={filter} onChange={setFilter} />
    {guilds.filter(g => g.title.toLowerCase().includes(query.toLowerCase()) && (!filter || g.members.some(m => m.role === 'Leader'))).map(g => <Row key={g.id} onClick={() => pickGuild(g.id)} sx={guild?.id === g.id ? SELECTED_RING : undefined} lead={<Box sx={{ width: 36, height: 36, borderRadius: '8px', bg: 'canvas.default', display: 'grid', placeItems: 'center', color: 'accent.fg' }}><OrganizationIcon size={16} /></Box>} title={g.title} sub={g.members.some(m => m.role === 'Leader') ? 'Есть лидер' : g.members.some(m => m.role === 'Officer') ? 'Есть офицер' : 'Участники'} trail={<Val>{g.members.length}</Val>} />)}
    {!guilds.length && <Text sx={{ color: 'fg.muted', fontSize: 0 }}>Нет сохранённых гильдий — нажмите «Обновить».</Text>}
    <Row onClick={() => pickGuild('search')} sx={searchMode ? SELECTED_RING : undefined} lead={<Box sx={{ width: 36, height: 36, borderRadius: '8px', bg: 'canvas.default', display: 'grid', placeItems: 'center', color: 'attention.fg' }}><PeopleIcon size={16} /></Box>} title="Без гильдии" sub="Выбрать гильдию для вступления" trail={<Val>{ungrouped.length}</Val>} />
    <Button leadingVisual={SearchIcon} disabled={leaving || refreshing} onClick={() => pickGuild('search')}>Найти гильдию</Button>
  </PanelShell>;
  const main = <>
    <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2, mb: 3, flexWrap: 'wrap' }}><Box><Heading as="h2" sx={{ fontSize: 3 }}>Гильдии</Heading><Text sx={{ color: 'fg.muted', fontSize: 1 }}>{guild ? `${guild.title} · своих аккаунтов: ${guild.members.length}` : searchMode ? 'Поиск и вступление' : 'Выберите гильдию справа'}</Text></Box><Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing || leaving} onClick={refresh}>Обновить</Button></Box>
    {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
    {loading ? <Spinner /> : searchMode ? <GuildDiscovery onJoined={() => { void changed(); }} /> : !guild || !selected ? <Text sx={{ color: 'fg.muted' }}>Выберите гильдию справа или найдите новую.</Text> : <>
      <Box sx={{ ...guildCard, mb: 3 }}><Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}><Box sx={{ width: 36, height: 36, borderRadius: 2, bg: 'accent.subtle', color: 'accent.fg', display: 'grid', placeItems: 'center' }}><OrganizationIcon size={22} /></Box><Box sx={{ flex: 1, minWidth: 0 }}><Text sx={{ fontWeight: 'semibold', display: 'block' }}>{guild.title}</Text><Text sx={{ fontSize: 0, color: 'fg.muted' }}>#{guild.id}{gtype ? ` · ${{ open: 'Открытая', application: 'По заявке', closed: 'Закрытая' }[gtype] ?? gtype}` : ''}</Text></Box>{canManage && <Label variant="accent">Управление: {roleName(selected.role)}</Label>}
        <ActionMenu><ActionMenu.Button aria-label="Действия гильдии" disabled={leaving || refreshing} trailingVisual={KebabHorizontalIcon}>Ещё</ActionMenu.Button><ActionMenu.Overlay><ActionList>{canManage && <ActionList.Item onSelect={() => setSetGuild({ id: guild.id, title: guild.title })}><ActionList.LeadingVisual><GearIcon /></ActionList.LeadingVisual>Настройки гильдии</ActionList.Item>}<ActionList.Item variant="danger" onSelect={leave}><ActionList.LeadingVisual><SignOutIcon /></ActionList.LeadingVisual>Выйти: {selected.account}</ActionList.Item></ActionList></ActionMenu.Overlay></ActionMenu>
      </Box>{ben ? <Summary tone="accent"><Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 2 }}><Tile size={2} value={ben.additional_builder == null ? '—' : `+${ben.additional_builder}`} label="строителей" /><Tile size={2} value={ben.upgrades_discount == null ? '—' : benefitText('pct-', ben.upgrades_discount)} label="улучшения" /><Tile size={2} value={ben.income_boost == null ? '—' : benefitText('pct+', ben.income_boost)} label="доход" /><Tile size={2} value={ben.reduced_upgrade_times == null ? '—' : benefitText('pct-', ben.reduced_upgrade_times)} label="время улучшений" /></Box></Summary> : <Text sx={{ fontSize: 0, color: 'fg.muted', px: 1 }}>Бонусы ещё не загружены — нажмите «Обновить».</Text>}</Box>
      <Box sx={{ ...guildCard, mb: 3, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}><Text sx={{ color: 'fg.muted', fontSize: 0, px: 1 }}>От имени</Text><Select aria-label="Аккаунт для действия" disabled={leaving || refreshing} value={String(selected.account_id)} onChange={e => { setActors(old => ({ ...old, [guild.id]: Number(e.target.value) })); closeGuildModals(); }}>
        {guild.members.map(m => <Select.Option key={m.account_id!} value={String(m.account_id)}>{m.account} · {roleName(m.role)}</Select.Option>)}
      </Select><Text sx={{ ml: 'auto', color: 'fg.muted', fontSize: 0 }}>Личный баланс</Text><CoinValue value={coins == null ? '—' : fmt(coins)} /><CrystalValue value={crystals == null ? '—' : fmt(crystals)} /></Box>
      <UnderlineNav aria-label="Разделы гильдии" sx={{ mb: 3 }}>{['Казна', 'Подарки', 'Участники', 'Почёт', 'Достижения', 'Настройки'].map(t => <UnderlineNav.Item key={t} href="#" icon={t === 'Подарки' ? GiftIcon : undefined} aria-current={tab === t ? 'page' : undefined} onSelect={e => { e.preventDefault(); setTab(t); }}>{t}</UnderlineNav.Item>)}</UnderlineNav>
      <Box key={`${guild.id}:${selected.account_id}:${tab}:${reloadKey}`}>
        {tab === 'Казна' ? <GuildTreasury accountId={selected.account_id!} coins={coins} crystals={crystals} onDeposit={currency => setDeposit({ row: selected, currency })} onFees={() => setFeesOpen(true)} /> : tab === 'Подарки' ? <GuildGifts accountId={selected.account_id!} /> : tab === 'Почёт' ? <RenownTab accountId={selected.account_id!} /> : tab === 'Достижения' ? <AchTab accountId={selected.account_id!} /> : tab === 'Участники' ? <Box sx={guildCard}>
          {canManage ? <GuildMembersPanel key={`${guild.id}:${selected.account_id}`} guildId={guild.id} accountId={selected.account_id!} myRole={selected.role} showFlash={showFlash} /> : <>
            <Text sx={{ fontWeight: 'semibold', px: 1 }}>Мои аккаунты в гильдии</Text>{guild.members.map(m => <Row key={m.account_id!} title={m.account} sub={roleName(m.role)} lead={<PeopleIcon />} />)}
            <Text sx={{ color: 'fg.muted', fontSize: 0 }}>Полный список участников доступен выбранному лидеру или офицеру.</Text>
          </>}
          {canManage && gtype === 'application' && <Button onClick={() => setAppsGuild({ id: guild.id, title: guild.title })}>Заявки на вступление</Button>}
        </Box> : <Box sx={guildCard}><Text sx={{ fontWeight: 'semibold' }}>Настройки гильдии</Text>{canManage ? <Button leadingVisual={GearIcon} onClick={() => setSetGuild({ id: guild.id, title: guild.title })}>Открыть настройки</Button> : <Text sx={{ color: 'fg.muted' }}>Выберите аккаунт-лидер или офицер для управления.</Text>}{ben && <><SumLine left="Скидка покупки зданий" right={ben.building_purchases_discount == null ? '—' : benefitText('pct-', ben.building_purchases_discount)} /><SumLine left="Дополнительное хранилище" right={ben.storage_cap_increase == null ? '—' : benefitText('time', ben.storage_cap_increase)} /></>}{duplicateLeaders.length > 1 && <Flash variant="warning">Несколько аккаунтов числятся лидером. Проверьте дубли.{duplicateLeaders.map(m => <Button key={m.account_id!} variant="danger" disabled={deletingId != null} loading={deletingId === m.account_id} onClick={() => removeDuplicate(m)}>Удалить «{m.account}»</Button>)}</Flash>}</Box>}
      </Box>
      <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 3 }}>Членство: снимок от {new Date(selected.updated_at).toLocaleString('ru')}</Text>
    </>}
  </>;
  const depositAccount = accounts.find(a => a.id === deposit?.row.account_id);
  return <><SidePage main={main} side={side} />
    {deposit && <GuildDepositModal key={`${deposit.row.account_id}:${deposit.currency}`} row={deposit.row} currency={deposit.currency} coins={savedBalance(depositAccount, 'coins')} crystals={savedBalance(depositAccount, 'crystals')} onClose={() => setDeposit(null)} onChanged={changed} />}
    {feesOpen && selected?.account_id != null && <GuildFeesModal key={selected.account_id} accountId={selected.account_id} accountName={selected.account} onClose={() => setFeesOpen(false)} />}
    {appsGuild && selected?.account_id != null && <ApplicationsModal key={selected.account_id} guildId={appsGuild.id} accountId={selected.account_id} title={appsGuild.title} onClose={() => setAppsGuild(null)} showFlash={showFlash} />}
    {setGuild && selected?.account_id != null && <SettingsModal key={selected.account_id} guildId={setGuild.id} accountId={selected.account_id} title={setGuild.title} onClose={() => setSetGuild(null)} showFlash={showFlash} />}
  </>;
}
