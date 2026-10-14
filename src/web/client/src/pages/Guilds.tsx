import { useState, useEffect } from 'react';
import { Box, Button, Checkbox, Flash, Heading, Label, Text, Spinner } from '@primer/react';
import { Dialog } from '@primer/react/experimental';
import { DataTable, Table } from '@primer/react/experimental';
import { api, type GuildMembership, type GuildApplication, type GuildMember, type GuildSettings } from '../api';
import { fmt } from '../utils';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';

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
function ApplicationsModal({ guildId, title, onClose, showFlash }: {
  guildId: string; title: string; onClose: () => void; showFlash: (m: string, ok: boolean) => void;
}) {
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

function MembersModal({ guildId, title, myRole, onClose, showFlash }: {
  guildId: string; title: string; myRole: string; onClose: () => void; showFlash: (m: string, ok: boolean) => void;
}) {
  const [members, setMembers] = useState<GuildMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const isLeader = myRole === 'Leader';

  const load = async () => {
    setLoading(true);
    try { const d = await api.guildMembers(guildId); if (d.ok) setMembers(d.members); else showFlash(d.error || 'Ошибка', false); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const act = async (m: GuildMember, action: 'promote' | 'demote' | 'kick' | 'promote-to-leader') => {
    if (action === 'promote-to-leader' && !window.confirm(`Передать лидерство игроку ${m.first_name}? Вы станете офицером.`)) return;
    if (action === 'kick' && !window.confirm(`Исключить ${m.first_name} из гильдии?`)) return;
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

function SettingsModal({ guildId, title, onClose, showFlash }: {
  guildId: string; title: string; onClose: () => void; showFlash: (m: string, ok: boolean) => void;
}) {
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

  const inputStyle = { padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 13, width: 170, background: 'var(--bgColor-default, #0d1117)', color: 'var(--fgColor-default, #e6edf3)' };
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
        {loading ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><Spinner /></Box>
          : <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {/* Тип набора */}
              <Box>
                <Box sx={fieldRow}>
                  <Text sx={{ fontSize: 1 }}>Тип гильдии</Text>
                  <select value={guildType} onChange={e => setGuildType(e.target.value)} style={inputStyle}>
                    {GUILD_TYPES.map(t => <option key={t.v} value={t.v}>{t.n}</option>)}
                  </select>
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
                      <input type="number" value={pop} onChange={e => setPop(e.target.value)} placeholder="0" style={inputStyle} />
                    </Box>
                    <Box sx={fieldRow}>
                      <Text sx={{ fontSize: 1 }}>Мин. прибыль/час</Text>
                      <input type="number" value={profit} onChange={e => setProfit(e.target.value)} placeholder="0" style={inputStyle} />
                    </Box>
                  </>}
                </Box>
              )}

              {/* Авто-исключение */}
              <Box sx={fieldRow}>
                <Text sx={{ fontSize: 1 }}>Порог неактивности</Text>
                <select value={autoKick} onChange={e => setAutoKick(e.target.value)} style={inputStyle}>
                  {AUTOKICK.map(t => <option key={t.v} value={t.v}>{t.n}</option>)}
                </select>
              </Box>

              {/* Членский взнос */}
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Box sx={fieldRow}>
                  <Text sx={{ fontSize: 1 }}>Членский взнос</Text>
                  <select value={feeType} onChange={e => setFeeType(e.target.value)} style={inputStyle}>
                    {FEE_TYPES.map(t => <option key={t.v} value={t.v}>{t.n}</option>)}
                  </select>
                </Box>
                {feeType && <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pl: 2, borderLeft: '2px solid', borderColor: 'border.muted' }}>
                  <Box sx={fieldRow}>
                    <Text sx={{ fontSize: 1 }}>Сумма</Text>
                    <input type="number" value={feeAmount} onChange={e => setFeeAmount(e.target.value)} placeholder="0" style={inputStyle} />
                  </Box>
                  <Box sx={fieldRow}>
                    <Text sx={{ fontSize: 1 }}>Периодичность</Text>
                    <select value={feeFreq} onChange={e => setFeeFreq(e.target.value)} style={inputStyle}>
                      {FEE_FREQ.map(t => <option key={t.v} value={t.v}>{t.n}</option>)}
                    </select>
                  </Box>
                  <Box sx={fieldRow}>
                    <Text sx={{ fontSize: 1 }}>Валюта</Text>
                    <select value={feeCur} onChange={e => setFeeCur(e.target.value)} style={inputStyle}>
                      {FEE_CUR.map(t => <option key={t.v} value={t.v}>{t.n}</option>)}
                    </select>
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
  const [rows, setRows] = useState<GuildMembership[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:guilds', () => load());
  const [appsGuild, setAppsGuild] = useState<{ id: string; title: string } | null>(null);
  const [memGuild, setMemGuild] = useState<{ id: string; title: string; myRole: string } | null>(null);
  const [setGuild, setSetGuild] = useState<{ id: string; title: string } | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const { flash, showFlash } = useFlash();

  const removeDuplicate = async (accountId: number | null, accountName: string) => {
    if (accountId == null) { showFlash(`У аккаунта "${accountName}" не найден id — удалите вручную на странице Аккаунтов`, false); return; }
    if (!window.confirm(`Удалить дублирующийся аккаунт "${accountName}" (id ${accountId})? Действие необратимо.`)) return;
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
    try { await api.refresh('guilds' as Parameters<typeof api.refresh>[0]); await load(); showFlash('Обновлено', true); }
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
  // показываем только гильдии, где хотя бы один аккаунт — лидер
  const leaderGuilds = [...byGuild.entries()].filter(([, g]) => g.members.some(m => m.role === 'Leader'));

  // строки для Primer-таблицы: бафы разложены по отдельным числовым полям (для сортировки)
  const data = leaderGuilds.map(([guildId, { title, members }]) => {
    const blob = members.find(m => m.benefits)?.benefits;
    const ben = extractBenefits(blob) ?? {};
    const leaders = members.filter(m => m.role === 'Leader');
    const accounts = leaders.map(m => m.account);
    // у гильдии физически не может быть двух лидеров одновременно — если у нас ДВА своих
    // аккаунта числятся лидерами одной и той же гильдии, это стопроцентный признак того, что
    // один и тот же игровой аккаунт задвоен в базе бота (напр. один раз с реальным именем,
    // второй раз с плейсхолдером account_XXXXXXXX от старой уязвимости добавления без пароля).
    const duplicateLeaders = leaders.length > 1 ? leaders : [];
    return {
      id: guildId,
      title,
      accounts,
      duplicateLeaders,
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
      <Heading as="h2" sx={{ fontSize: 3, mb: 3 }}>Гильдии</Heading>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
        <Button onClick={refresh} disabled={refreshing} loading={refreshing}>
          ↻ Обновить
        </Button>
      </Box>

      {leaderGuilds.length === 0
        ? <Text sx={{ color: 'fg.muted' }}>Нет гильдий, где аккаунт — лидер</Text>
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
                        <Button onClick={() => setSetGuild({ id: r.id, title: r.title })}>Настройки</Button>
                        <Button onClick={() => setMemGuild({ id: r.id, title: r.title, myRole: 'Leader' })}>Участники</Button>
                        {r.gtype === 'application' && <Button variant="primary" onClick={() => setAppsGuild({ id: r.id, title: r.title })}>Заявки</Button>}
                      </Box>
                    ),
                  },
                ]}
              />
            </Table.Container>
          )
      }
      {appsGuild && <ApplicationsModal guildId={appsGuild.id} title={appsGuild.title} onClose={() => setAppsGuild(null)} showFlash={showFlash} />}
      {memGuild && <MembersModal guildId={memGuild.id} title={memGuild.title} myRole={memGuild.myRole} onClose={() => setMemGuild(null)} showFlash={showFlash} />}
      {setGuild && <SettingsModal guildId={setGuild.id} title={setGuild.title} onClose={() => setSetGuild(null)} showFlash={showFlash} />}
    </Box>
  );
}
