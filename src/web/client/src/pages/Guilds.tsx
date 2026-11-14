import { useState, useEffect } from 'react';
import { GuildDiscovery } from '../components/GuildDiscovery';
import { GuildExtrasModal } from '../components/GuildExtrasModal';
import { Box, Button, Checkbox, Flash, Label, Select, Text, TextInput, Spinner } from '@primer/react';
import { Dialog } from '@primer/react/experimental';
import { DataTable, Table } from '@primer/react/experimental';
import { api, type GuildMembership, type GuildApplication, type GuildMember, type GuildSettings, type GuildFeesState } from '../api';
import { fmt } from '../utils';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { PageHeader } from '../components/PageHeader';
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

function GuildDepositModal({ row, currency, onClose }: { row: GuildMembership; currency: 'coins' | 'crystals'; onClose: () => void }) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; msg: string } | null>(null);
  const ask = useAsk();
  const n = Number(amount), valid = Number.isSafeInteger(n) && n > 0;
  const unit = currency === 'coins' ? 'монет' : 'алмазов';
  const pay = async () => {
    if (!valid || busy || row.account_id == null) return;
    if (!await ask('Внести в казну?', `С аккаунта «${row.account}» в гильдию «${row.guild_title}» будет внесено ${n.toLocaleString('ru')} ${unit}.`, { ok: 'Внести' })) return;
    setBusy(true); setNote(null);
    try {
      const r = await api.guildDeposit(row.account_id, row.guild_id, currency, n);
      if (!r.ok) { setNote({ ok: false, msg: r.error ?? 'Не удалось выполнить взнос. Перед повтором проверьте баланс и историю казны.' }); return; }
      setAmount('');
      const fresh = await Promise.allSettled([api.extraRefresh('treasury', row.account_id), api.extraRefresh('treasury-actions', row.account_id), api.extraRefresh('treasury-lb', row.account_id)]);
      const updated = fresh.every(r => r.status === 'fulfilled' && r.value.ok);
      setNote({ ok: true, msg: `Внесено ${n.toLocaleString('ru')} ${unit}.${updated ? '' : ' Взнос выполнен, но снимок казны обновить не удалось.'}` });
    } catch (e) { setNote({ ok: false, msg: `${String(e)}. Перед повтором проверьте баланс и историю казны.` }); }
    finally { setBusy(false); }
  };
  return <Dialog title={`Взнос ${unit} · ${row.account}`} onClose={busy ? () => {} : onClose} width="medium">
    <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Text>Гильдия: {row.guild_title}</Text>
      {note && <Flash variant={note.ok ? 'success' : 'danger'}>{note.msg}</Flash>}
      <TextInput aria-label={`Сумма ${unit}`} type="number" min={1} step={1} value={amount} disabled={busy} onChange={e => setAmount(e.target.value)} placeholder="Сумма" block />
      <Button variant="primary" disabled={!valid || busy} loading={busy} onClick={pay}>Внести {unit}</Button>
    </Box>
  </Dialog>;
}

// ── бафы гильдии (GET /guilds/benefits) ──────────────────────────────────────
type GuildBenefits = {
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
function ApplicationsModal({ guildId, title, onClose, showFlash: showPageFlash }: {
  guildId: string; title: string; onClose: () => void; showFlash: (m: string, ok: boolean) => void;
}) {
  // сообщения — внутри окна: флэш на странице прятался под затемнением открытого диалога
  const [note, setNote] = useState<{ msg: string; ok: boolean } | null>(null);
  const showFlash = (msg: string, ok: boolean) => { setNote({ msg, ok }); showPageFlash(msg, ok); };
  const [apps, setApps] = useState<GuildApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    try { const d = await api.guildApplications(guildId); if (d.ok) setApps(d.applications); else showFlash(d.error || 'Ошибка', false); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const act = async (appId: number, name: string, kind: 'approve' | 'reject') => {
    setBusy(appId);
    try {
      const d = kind === 'approve' ? await api.guildAppApprove(guildId, appId) : await api.guildAppReject(guildId, appId);
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

function MembersModal({ guildId, title, myRole, onClose, showFlash: showPageFlash }: {
  guildId: string; title: string; myRole: string; onClose: () => void; showFlash: (m: string, ok: boolean) => void;
}) {
  // сообщения — внутри окна: флэш на странице прятался под затемнением открытого диалога
  const [note, setNote] = useState<{ msg: string; ok: boolean } | null>(null);
  const showFlash = (msg: string, ok: boolean) => { setNote({ msg, ok }); showPageFlash(msg, ok); };
  const [members, setMembers] = useState<GuildMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const isLeader = myRole === 'Leader';
  const ask = useAsk();

  const load = async () => {
    setLoading(true);
    try { const d = await api.guildMembers(guildId); if (d.ok) setMembers(d.members); else showFlash(d.error || 'Ошибка', false); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const act = async (m: GuildMember, action: 'promote' | 'demote' | 'kick' | 'promote-to-leader') => {
    if (action === 'promote-to-leader' && !await ask('Передать лидерство?', `Лидером станет ${m.first_name}, вы станете офицером.`, { ok: 'Передать', danger: true })) return;
    if (action === 'kick' && !await ask('Исключить из гильдии?', `${m.first_name} будет исключён из гильдии.`, { ok: 'Исключить', danger: true })) return;
    setBusy(m.id);
    try {
      const d = await api.guildMemberAction(guildId, m.id, action);
      if (d.ok) { showFlash('Готово', true); load(); }
      else showFlash(d.error || 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); } finally { setBusy(null); }
  };

  const sorted = [...members].sort((a, b) => {
    const ro = { Leader: 0, Officer: 1, Member: 2 } as Record<string, number>;
    return (ro[a.role] ?? 3) - (ro[b.role] ?? 3);
  });

  return (
    <Dialog title={`Участники · ${title}`} onClose={onClose} width="xlarge" position={{ narrow: 'bottom', regular: 'center' }}>
      <Box>
        {note && <Flash variant={note.ok ? 'success' : 'danger'} sx={{ mb: 2 }}>{note.msg}</Flash>}
        <Box sx={{ mb: 2 }}><Button onClick={load} disabled={loading}>↻ Обновить</Button></Box>
        {loading ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><Spinner /></Box>
          : sorted.length === 0 ? <Text sx={{ color: 'fg.muted' }}>Нет участников</Text>
          : sorted.map(m => (
            <Box key={m.id} sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 1, py: '8px', borderBottom: '1px solid', borderColor: 'border.muted' }}>
              <Box sx={{ width: 8, height: 8, borderRadius: '50%', bg: ONLINE_COLOR[m.online_status] ?? 'var(--fg-subtle)', flexShrink: 0 }} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Text sx={{ fontWeight: 'bold', fontSize: 1 }}>{m.first_name}{m.last_name ? ` ${m.last_name}` : ''}</Text>
                <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>{ROLE_NAME[m.role] ?? m.role} · 👥 {fmt(m.population)} · 🪙 {fmt(m.profit)}/ч</Text>
              </Box>
              {m.role !== 'Leader' && (
                <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
                  {isLeader && m.role === 'Member' && <Button disabled={busy != null} onClick={() => act(m, 'promote')}>↑ Офицер</Button>}
                  {isLeader && m.role === 'Officer' && <Button disabled={busy != null} onClick={() => act(m, 'demote')}>↓ Участник</Button>}
                  {isLeader && <Button disabled={busy != null} onClick={() => act(m, 'promote-to-leader')}>👑 Лидер</Button>}
                  <Button variant="danger" loading={busy === m.id} disabled={busy != null} onClick={() => act(m, 'kick')}>Кик</Button>
                </Box>
              )}
            </Box>
          ))
        }
      </Box>
    </Dialog>
  );
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

function SettingsModal({ guildId, title, onClose, showFlash: showPageFlash }: {
  guildId: string; title: string; onClose: () => void; showFlash: (m: string, ok: boolean) => void;
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
      const d = await api.guildSettings(guildId);
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
      });
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

export function Guilds() {
  const [tab, setTab] = useState<'mine' | 'search'>('mine');
  const [rows, setRows] = useState<GuildMembership[]>([]);
  const [feeAccount, setFeeAccount] = useState('');
  const [feesOpen, setFeesOpen] = useState(false);
  const [extrasOpen, setExtrasOpen] = useState(false);
  const [deposit, setDeposit] = useState<{ row: GuildMembership; currency: 'coins' | 'crystals' } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:guilds', () => load());
  const [appsGuild, setAppsGuild] = useState<{ id: string; title: string } | null>(null);
  const [memGuild, setMemGuild] = useState<{ id: string; title: string; myRole: string } | null>(null);
  const [setGuild, setSetGuild] = useState<{ id: string; title: string } | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const { flash, showFlash } = useFlash();
  const ask = useAsk();

  const selected = rows.find(r => String(r.account_id) === feeAccount) ?? rows.find(r => r.account_id != null);
  const leave = async () => {
    if (!selected || selected.account_id == null || leaving) return;
    const leader = selected.role === 'Leader';
    if (!await ask(leader ? 'Выйти из гильдии лидером?' : 'Выйти из гильдии?',
      `Аккаунт «${selected.account}» покинет «${selected.guild_title}».${leader ? ' В игре выход лидера может расформировать гильдию. Это действие нельзя отменить.' : ''}`,
      { ok: 'Выйти', danger: true })) return;
    setLeaving(true);
    try {
      const r = await api.guildLeave(selected.account_id, selected.guild_id, leader);
      showFlash(r.ok ? `Аккаунт вышел из гильдии.${r.refresh_error ? ' Не удалось обновить снимок: ' + r.refresh_error : ''}` : r.error ?? 'Ошибка выхода', r.ok);
      setFeeAccount(''); await load();
    } catch (e) { showFlash(String(e), false); }
    finally { setLeaving(false); }
  };

  const removeDuplicate = async (accountId: number | null, accountName: string) => {
    if (accountId == null) { showFlash(`У аккаунта "${accountName}" не найден id — удалите вручную на странице Аккаунтов`, false); return; }
    if (!await ask('Удалить дубль аккаунта?', `Аккаунт «${accountName}» (id ${accountId}) будет удалён из бота. Действие необратимо.`, { ok: 'Удалить', danger: true })) return;
    setDeletingId(accountId);
    try {
      const d = await api.deleteAccount(accountId);
      if (d.ok) { showFlash(`Аккаунт "${accountName}" удалён`, true); await load(); }
      else showFlash(d.error || 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); } finally { setDeletingId(null); }
  };

  const load = async () => {
    setLoading(true);
    try {
      const d = await api.guilds();
      if (d.ok) setRows(d.rows);
    } finally { setLoading(false); }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await api.refresh('guilds'); await load();
      const failed = ((r.results ?? []) as { name?: string; ok?: boolean; error?: string }[]).filter(x => x.ok === false);
      showFlash(!r.ok ? 'Не удалось обновить гильдии' : failed.length ? `Не обновлены: ${failed.map(x => `${x.name ?? 'аккаунт'}: ${x.error ?? 'ошибка'}`).join('; ')}` : 'Членство, бонусы гильдий и строители обновлены', r.ok && !failed.length);
    }
    catch (e) { showFlash(String(e), false); }
    finally { setRefreshing(false); }
  };

  useEffect(() => { load(); }, []);

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const byGuild = new Map<string, { title: string; members: GuildMembership[] }>();
  for (const r of rows) {
    if (!byGuild.has(r.guild_id)) byGuild.set(r.guild_id, { title: r.guild_title, members: [] });
    byGuild.get(r.guild_id)!.members.push(r);
  }
  // Все свои гильдии; управление доступно только при наличии лидера.
  const leaderGuilds = [...byGuild.entries()];

  // строки для Primer-таблицы: бафы разложены по отдельным числовым полям (для сортировки)
  const data = leaderGuilds.map(([guildId, { title, members }]) => {
    const blob = members.find(m => m.benefits)?.benefits;
    const ben = extractBenefits(blob) ?? {};
    const leaders = members.filter(m => m.role === 'Leader');
    const accounts = members.map(m => `${m.account} (${m.role})`);
    // у гильдии физически не может быть двух лидеров одновременно — если у нас ДВА своих
    // аккаунта числятся лидерами одной и той же гильдии, это стопроцентный признак того, что
    // один и тот же игровой аккаунт задвоен в базе бота (напр. один раз с реальным именем,
    // второй раз с плейсхолдером account_XXXXXXXX от старой уязвимости добавления без пароля).
    const duplicateLeaders = leaders.length > 1 ? leaders : [];
    const canManage = leaders.length > 0;
    return {
      id: guildId,
      title,
      accounts,
      duplicateLeaders, canManage,
      accountsStr: accounts.join(', '),
      income_boost: Number(ben.income_boost ?? 0),
      upgrades_discount: Number(ben.upgrades_discount ?? 0),
      building_purchases_discount: Number(ben.building_purchases_discount ?? 0),
      reduced_upgrade_times: Number(ben.reduced_upgrade_times ?? 0),
      storage_cap_increase: Number(ben.storage_cap_increase ?? 0),
      gtype: extractGuildType(blob),
    };
  });

  const benCell = (kind: 'pct+' | 'pct-' | 'abs' | 'time', v: number) =>
    v ? <Text sx={{ fontVariantNumeric: 'tabular-nums', color: 'success.fg', fontWeight: 'semibold' }}>{benefitText(kind, v)}</Text>
      : <Text sx={{ color: 'fg.subtle' }}>—</Text>;

  return (
    <Box sx={{ p: 3 }}>
      <PageHeader title="Гильдии" actions={<>
        <Button onClick={refresh} disabled={refreshing} loading={refreshing}>
          ↻ Обновить
        </Button>
      </>} />
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
        <Button variant={tab === 'mine' ? 'primary' : 'default'} onClick={() => setTab('mine')}>Мои гильдии</Button>
        <Button variant={tab === 'search' ? 'primary' : 'default'} onClick={() => setTab('search')}>Поиск гильдии</Button>
      </Box>
      {tab === 'search' ? <GuildDiscovery onJoined={() => { void load(); }} /> : <>
      {rows.some(r => r.account_id != null) && <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3, flexWrap: 'wrap' }}>
        <Text sx={{ fontWeight: 'semibold' }}>Аккаунт гильдии</Text>
        <Select aria-label="Аккаунт гильдии" disabled={leaving} value={feeAccount || String(rows.find(r => r.account_id != null)?.account_id ?? '')} onChange={e => setFeeAccount(e.target.value)}>
          {rows.filter(r => r.account_id != null).map(r => <Select.Option key={r.account_id!} value={String(r.account_id)}>{r.account} · {r.guild_title}</Select.Option>)}
        </Select>
        <Button onClick={() => setFeesOpen(true)}>Проверить взнос</Button>
        <Button onClick={() => setExtrasOpen(true)}>Казна, Почёт, достижения</Button>
        <Button disabled={leaving || !selected} onClick={() => selected && setDeposit({ row: selected, currency: 'coins' })}>Внести монеты</Button>
        <Button disabled={leaving || !selected} onClick={() => selected && setDeposit({ row: selected, currency: 'crystals' })}>Внести алмазы</Button>
        <Button variant="danger" disabled={leaving || !selected} loading={leaving} onClick={leave}>Выйти из гильдии</Button>
      </Box>}
      {deposit && <GuildDepositModal row={deposit.row} currency={deposit.currency} onClose={() => setDeposit(null)} />}
      {extrasOpen && (() => { const id = Number(feeAccount || rows.find(r => r.account_id != null)?.account_id); const r = rows.find(x => x.account_id === id); return <GuildExtrasModal key={id} accountId={id} title={`${r?.guild_title ?? ''} (${r?.account ?? ''})`} onClose={() => setExtrasOpen(false)} />; })()}
      {feesOpen && <GuildFeesModal key={feeAccount || String(rows.find(r => r.account_id != null)?.account_id)} accountId={Number(feeAccount || rows.find(r => r.account_id != null)?.account_id)} accountName={rows.find(r => String(r.account_id) === feeAccount)?.account || rows.find(r => r.account_id != null)?.account || ''} onClose={() => setFeesOpen(false)} />}

      {leaderGuilds.length === 0
        ? <Text sx={{ color: 'fg.muted' }}>Нет сохранённых гильдий — нажмите «Обновить» или перейдите в поиск</Text>
        : (
            <Table.Container>
              <DataTable
                data={data}
                initialSortColumn="title"
                initialSortDirection="ASC"
                columns={[
                  {
                    header: 'Гильдия', field: 'title', rowHeader: true, sortBy: 'alphanumeric',
                    renderCell: r => <strong>{r.title}</strong>,
                  },
                  {
                    header: 'Мои аккаунты', field: 'accountsStr', sortBy: 'alphanumeric',
                    renderCell: r => (
                      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, maxWidth: 260 }}>
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                          {r.accounts.map((a, i) => <Label key={i} variant="accent">{a}</Label>)}
                        </Box>
                        {r.duplicateLeaders.length > 1 && (
                          <Box sx={{ fontSize: 0 }}>
                            <Text sx={{ color: 'danger.fg', fontWeight: 'bold', display: 'block' }}>
                              ⚠ У гильдии не может быть двух лидеров — один из этих аккаунтов задвоен в базе
                            </Text>
                            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
                              {r.duplicateLeaders.map(m => (
                                <Button
                                  key={m.account}
                                  variant="danger"
                                  loading={deletingId === m.account_id}
                                  disabled={deletingId != null}
                                  onClick={() => removeDuplicate(m.account_id, m.account)}
                                >
                                  Удалить «{m.account}»
                                </Button>
                              ))}
                            </Box>
                          </Box>
                        )}
                      </Box>
                    ),
                  },
                  { header: 'Доход', field: 'income_boost', sortBy: 'basic', renderCell: r => benCell('pct+', r.income_boost) },
                  { header: 'Улучшения', field: 'upgrades_discount', sortBy: 'basic', renderCell: r => benCell('pct-', r.upgrades_discount) },
                  { header: 'Покупка зданий', field: 'building_purchases_discount', sortBy: 'basic', renderCell: r => benCell('pct-', r.building_purchases_discount) },
                  { header: 'Время улучш.', field: 'reduced_upgrade_times', sortBy: 'basic', renderCell: r => benCell('pct-', r.reduced_upgrade_times) },
                  { header: 'Хранилище', field: 'storage_cap_increase', sortBy: 'basic', renderCell: r => benCell('time', r.storage_cap_increase) },
                  {
                    header: '', id: 'actions', align: 'end',
                    renderCell: r => (
                      <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        {r.canManage && <Button onClick={() => setSetGuild({ id: r.id, title: r.title })}>Настройки</Button>}
                        {r.canManage && <Button onClick={() => setMemGuild({ id: r.id, title: r.title, myRole: 'Leader' })}>Участники</Button>}
                        {r.canManage && r.gtype === 'application' && <Button variant="primary" onClick={() => setAppsGuild({ id: r.id, title: r.title })}>Заявки</Button>}
                      </Box>
                    ),
                  },
                ]}
              />
            </Table.Container>
          )
      }
      </>}
      {appsGuild && <ApplicationsModal guildId={appsGuild.id} title={appsGuild.title} onClose={() => setAppsGuild(null)} showFlash={showFlash} />}
      {memGuild && <MembersModal guildId={memGuild.id} title={memGuild.title} myRole={memGuild.myRole} onClose={() => setMemGuild(null)} showFlash={showFlash} />}
      {setGuild && <SettingsModal guildId={setGuild.id} title={setGuild.title} onClose={() => setSetGuild(null)} showFlash={showFlash} />}
    </Box>
  );
}
