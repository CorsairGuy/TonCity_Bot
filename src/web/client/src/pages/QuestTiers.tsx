import { useState, useEffect } from 'react';
import { Box, Button, Checkbox, Flash, Heading, Spinner, Text, Label, ProgressBar, TextInput, Select } from '@primer/react';
import { Dialog } from '@primer/react/experimental';
import { DataTable, Table, type Column } from '@primer/react/experimental';
import { api, type GuildMembership, type QuestTierGuild, type QuestTierData } from '../api';
import { useFlash } from '../hooks/useFlash';
import { fmtDate } from '../utils';

// Уровни гильдейских квестов (guild-quests/tiers) — новая система обновления 06.07.2026.
// GET подтверждён живым запросом (DevTools, 09.07.2026). Тело POST contribute — нет (пробуем
// {tier_id, amount}; если формат другой, сервер обычно возвращает понятную 400-ошибку с описанием
// недостающего/неверного поля — тогда останется просто поправить payload на бэкенде).
// Почёт похоже привязан к каждому УЧАСТНИКУ отдельно (см. eligible_members в ответе), поэтому
// в модалке взноса можно выбрать конкретные аккаунты гильдии (или все разом), а не только лидера.
const RARITY_COLOR: Record<string, string> = {
  common: '#6e7681', uncommon: '#27AE60', rare: '#2E86C1', epic: '#8E44AD',
  legendary: '#D4AC0D', mythic: '#C0392B', eternal: '#8E44AD',
};
const RARITY_NAME: Record<string, string> = {
  common: 'Обычная', uncommon: 'Необычная', rare: 'Редкая', epic: 'Эпическая',
  legendary: 'Легендарная', mythic: 'Мифическая', eternal: 'Вечная',
};

// ── модалка взноса Почёта со всех аккаунтов гильдии ───────────────────────────

function ContributeModal({ guildId, title, accounts, data, onClose, onRefreshed }: {
  guildId: string; title: string; accounts: string[]; data: QuestTierData | null;
  onClose: () => void; onRefreshed: () => void;
}) {
  const fundable = (data?.tiers ?? []).filter(t => !t.unlocked && t.pool.fundable);
  const [tierId, setTierId] = useState<number | null>(fundable[0]?.id ?? data?.tiers[0]?.id ?? null);
  const [amount, setAmount] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set(accounts));
  const [busy, setBusy] = useState(false);
  const { flash, showFlash } = useFlash();

  const selectedTier = data?.tiers.find(t => t.id === tierId) ?? null;
  const allChecked = selected.size === accounts.length;

  const toggleOne = (acc: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(acc)) next.delete(acc); else next.add(acc);
    return next;
  });
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(accounts));

  const submit = async () => {
    const n = Number(amount);
    if (!(n > 0)) { showFlash('Введите сумму больше 0', false); return; }
    if (tierId == null) { showFlash('Выберите тир', false); return; }
    if (selected.size === 0) { showFlash('Выберите хотя бы один аккаунт', false); return; }
    setBusy(true);
    try {
      const r = await api.questTiersContributeAll(guildId, tierId, n, [...selected]);
      if (r.ok) {
        showFlash(`Внесено с ${r.succeeded}/${r.total} аккаунтов`, (r.succeeded ?? 0) > 0);
        onRefreshed();
      } else showFlash(r.error ?? 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); } finally { setBusy(false); }
  };

  return (
    <Dialog
      title={`Взнос Почёта · ${title}`}
      onClose={onClose}
      width="large"
      position={{ narrow: 'bottom', regular: 'center' }}
      footerButtons={[{
        content: `Внести с выбранных (${selected.size})`,
        buttonType: 'primary',
        block: true,
        loading: busy,
        disabled: busy || !data || tierId == null || selected.size === 0,
        onClick: submit,
      }]}
    >
      <Box>
        {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 2 }}>{flash.msg}</Flash>}

        {!data ? (
          <Text sx={{ color: 'fg.muted' }}>Нет данных по тирам — обновите таблицу</Text>
        ) : (
          <>
            <Box sx={{ mb: 2 }}>
              <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 1 }}>Тир</Text>
              <Select value={String(tierId ?? '')} onChange={e => setTierId(Number(e.target.value))} block>
                {data.tiers.map(t => (
                  <Select.Option key={t.id} value={String(t.id)} disabled={t.unlocked || !t.pool.fundable}>
                    #{t.id} · {RARITY_NAME[t.rarity] ?? t.rarity} · {t.pool.progress}/{t.pool.target}
                    {t.unlocked ? ' · открыт' : !t.pool.fundable ? ' · недоступен' : ''}
                  </Select.Option>
                ))}
              </Select>
            </Box>

            {selectedTier && (
              <Box sx={{ mb: 2 }}>
                <ProgressBar
                  progress={selectedTier.pool.target > 0 ? Math.min(100, Math.round(selectedTier.pool.progress / selectedTier.pool.target * 100)) : 0}
                  sx={{ mb: 1, bg: 'canvas.subtle' }}
                />
                <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                  Осталось до цели: {Math.max(0, selectedTier.pool.target - selectedTier.pool.progress)}
                </Text>
              </Box>
            )}

            <Box sx={{ mb: 2 }}>
              <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 1 }}>Сумма Почёта с каждого аккаунта</Text>
              <TextInput type="number" value={amount} onChange={e => setAmount(e.target.value)} block />
            </Box>

            <Box sx={{ bg: 'canvas.subtle', borderRadius: 2, p: 2 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Аккаунты ({selected.size}/{accounts.length})</Text>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 }}>
                  <Checkbox checked={allChecked} onChange={toggleAll} />
                  Выбрать все
                </label>
              </Box>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {accounts.map(a => (
                  <label key={a} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                    <Checkbox checked={selected.has(a)} onChange={() => toggleOne(a)} />
                    {a}
                  </label>
                ))}
              </Box>
            </Box>
          </>
        )}
      </Box>
    </Dialog>
  );
}

// ── страница ────────────────────────────────────────────────────────────────

export function QuestTiers() {
  const [memberships, setMemberships] = useState<GuildMembership[]>([]);
  const [tiers, setTiers] = useState<QuestTierGuild[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [modalGuild, setModalGuild] = useState<{ id: string; title: string; accounts: string[] } | null>(null);
  const { flash, showFlash } = useFlash();

  // silent=true — обновить данные на месте, без спиннера на весь экран (иначе таблица размонтируется
  // и сколл страницы слетает на каждое нажатие «Обновить»)
  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [g, t] = await Promise.all([api.guilds(), api.questTiers()]);
      if (g.ok) setMemberships(g.rows);
      if (t.ok) setTiers(t.guilds);
    } finally { if (!silent) setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  // если "Обновить" (для конкретной гильдии или "все гильдии") ещё выполняется на сервере с
  // прошлой загрузки страницы — восстанавливаем состояние загрузки и ждём завершения (см.
  // useResumableRefresh.ts — тут своя версия, т.к. нужно опросить сразу несколько ключей: одну
  // гильдию из них может быть много одновременно, а generic-хук рассчитан на один ключ).
  const guildIds = [...new Set(memberships.map(r => r.guild_id))];
  useEffect(() => {
    if (!guildIds.length) return;
    let cancelled = false, timer: ReturnType<typeof setInterval> | null = null;
    const keys = ['questTiersRefreshAll', ...guildIds.map(id => `questTiersRefresh:${id}`)];
    api.opStatus(keys).then(d => {
      if (cancelled || !d.ok) return;
      if (d.running['questTiersRefreshAll']) setRefreshingAll(true);
      else { const running = guildIds.find(id => d.running[`questTiersRefresh:${id}`]); if (running) setRefreshingId(running); }
      if (!d.running['questTiersRefreshAll'] && !guildIds.some(id => d.running[`questTiersRefresh:${id}`])) return;
      timer = setInterval(async () => {
        const d2 = await api.opStatus(keys);
        if (cancelled || !d2.ok) return;
        if (!d2.running['questTiersRefreshAll'] && !guildIds.some(id => d2.running[`questTiersRefresh:${id}`])) {
          if (timer) clearInterval(timer);
          setRefreshingAll(false); setRefreshingId(null);
          load(true);
        }
      }, 1500);
    }).catch(() => {});
    return () => { cancelled = true; if (timer) clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildIds.join(',')]);

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  const byGuild = new Map<string, { title: string; members: GuildMembership[] }>();
  for (const r of memberships) {
    if (!byGuild.has(r.guild_id)) byGuild.set(r.guild_id, { title: r.guild_title, members: [] });
    byGuild.get(r.guild_id)!.members.push(r);
  }
  const tierByGuild = new Map(tiers.map(t => [t.guild_id, t]));

  // "Актуальная" гильдия аккаунта — та, где его запись синкалась ПОСЛЕДНЕЙ (updated_at max).
  // GuildSnapshot копится историей (при смене гильдии старая запись не удаляется), поэтому
  // одного account_id может быть несколько guild_id — самый свежий и есть текущий.
  const latestByAccount = new Map<string, GuildMembership>();
  for (const r of memberships) {
    const cur = latestByAccount.get(r.account);
    if (!cur || new Date(r.updated_at).getTime() > new Date(cur.updated_at).getTime()) latestByAccount.set(r.account, r);
  }
  const currentGuildIds = new Set([...latestByAccount.values()].map(r => r.guild_id));

  // Список тир-колонок — объединение всех id/rarity, встреченных хоть в одной гильдии
  // (обычно фиксированный набор — 3 тира одной и той же редкости у всех, но на всякий случай
  // строим динамически, а не хардкодим).
  const tierColumns = new Map<number, string>();
  for (const t of tiers) for (const tier of t.data?.tiers ?? []) if (!tierColumns.has(tier.id)) tierColumns.set(tier.id, tier.rarity);
  const sortedTierIds = [...tierColumns.keys()].sort((a, b) => a - b);

  // ВСЕ гильдии, в которых когда-либо состоял хоть один наш аккаунт (GuildSnapshot копится
  // историей, старые записи не удаляются — поэтому здесь уже все, а не только текущие)
  const data = [...byGuild.entries()].map(([guildId, { title, members }]) => {
    const snap = tierByGuild.get(guildId);
    const d = snap?.data ?? null;
    const fundableCount = d?.tiers.filter(t => !t.unlocked && t.pool.fundable).length ?? 0;
    const tierById = new Map((d?.tiers ?? []).map(t => [t.id, t]));
    return {
      id: guildId,
      title,
      accounts: members.map(m => m.account),
      accountsStr: members.map(m => m.account).join(', '),
      renown: d?.renown_balance ?? null,
      fundableCount,
      tierById,
      updatedAt: snap?.updated_at ?? null,
    };
  });
  const currentData = data.filter(r => currentGuildIds.has(r.id));
  const historicalData = data.filter(r => !currentGuildIds.has(r.id));

  const refresh = async (guildId: string) => {
    setRefreshingId(guildId);
    try {
      const r = await api.questTiersRefresh(guildId);
      if (r.ok) { showFlash('Обновлено', true); await load(true); }
      else showFlash(r.error ?? 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setRefreshingId(null); }
  };

  const refreshAll = async () => {
    setRefreshingAll(true);
    try {
      const r = await api.questTiersRefreshAll();
      if (r.ok) { showFlash(`Обновлено ${r.succeeded}/${r.total} гильдий`, (r.succeeded ?? 0) > 0); await load(true); }
      else showFlash(r.error ?? 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); }
    finally { setRefreshingAll(false); }
  };

  type Row = typeof data[number];
  const buildColumns = (): Column<Row>[] => [
    { header: 'Гильдия', field: 'title', rowHeader: true, sortBy: 'alphanumeric', renderCell: (r: Row) => <strong>{r.title}</strong> },
    {
      header: 'Мои аккаунты', field: 'accountsStr', sortBy: 'alphanumeric',
      renderCell: (r: Row) => (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, maxWidth: 240 }}>
          {r.accounts.map((a, i) => <Label key={i} variant="accent">{a}</Label>)}
        </Box>
      ),
    },
    {
      header: 'Почёт', field: 'renown', sortBy: 'basic',
      renderCell: (r: Row) => r.renown != null ? <span className="mono">{r.renown}</span> : <Text sx={{ color: 'fg.subtle' }}>—</Text>,
    },
    ...sortedTierIds.map(tid => ({
      header: RARITY_NAME[tierColumns.get(tid) ?? ''] ?? `Тир ${tid}`,
      id: `tier_${tid}`,
      renderCell: (r: Row) => {
        const t = r.tierById.get(tid);
        if (!t) return <Text sx={{ color: 'fg.subtle' }}>—</Text>;
        if (t.unlocked) return <Text sx={{ color: 'success.fg', fontWeight: 'bold' }}>✓</Text>;
        return (
          <span className="mono" style={{ color: t.pool.fundable ? undefined : 'var(--fg-subtle)' }}>
            {t.pool.progress}/{t.pool.target}
          </span>
        );
      },
    })),
    {
      header: 'Доступно тиров', field: 'fundableCount', sortBy: 'basic',
      renderCell: (r: Row) => r.fundableCount > 0
        ? <Label variant="success">{r.fundableCount}</Label>
        : <Text sx={{ color: 'fg.subtle' }}>—</Text>,
    },
    {
      header: 'Данные на', field: 'updatedAt',
      sortBy: (a: Row, b: Row) => new Date(a.updatedAt ?? 0).getTime() - new Date(b.updatedAt ?? 0).getTime(),
      renderCell: (r: Row) => r.updatedAt
        ? <span className="mono" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{fmtDate(r.updatedAt)}</span>
        : <Text sx={{ color: 'fg.subtle' }}>—</Text>,
    },
    {
      header: '', id: 'actions', align: 'end',
      renderCell: (r: Row) => (
        <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <Button loading={refreshingId === r.id} disabled={refreshingId != null} onClick={() => refresh(r.id)}>
            Обновить
          </Button>
          <Button variant="primary" onClick={() => setModalGuild({ id: r.id, title: r.title, accounts: r.accounts })}>
            Взнос
          </Button>
        </Box>
      ),
    },
  ];

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Heading as="h2" sx={{ fontSize: 3 }}>Уровни квестов</Heading>
        <Button loading={refreshingAll} disabled={refreshingAll || refreshingId != null} onClick={refreshAll}>
          Обновить все гильдии
        </Button>
      </Box>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      {data.length === 0 ? (
        <Text sx={{ color: 'fg.muted' }}>Нет данных о гильдиях — синхронизируйте бота</Text>
      ) : (
        <>
          <Heading as="h3" sx={{ fontSize: 2, mb: 2 }}>Актуальные гильдии</Heading>
          {currentData.length === 0 ? (
            <Text sx={{ color: 'fg.muted', display: 'block', mb: 4 }}>Нет гильдий, где сейчас состоят аккаунты</Text>
          ) : (
            <Table.Container sx={{ mb: 4 }}>
              <DataTable data={currentData} initialSortColumn="title" initialSortDirection="ASC" columns={buildColumns()} />
            </Table.Container>
          )}

          <Heading as="h3" sx={{ fontSize: 2, mb: 2 }}>Ранее — аккаунтов там больше нет</Heading>
          {historicalData.length === 0 ? (
            <Text sx={{ color: 'fg.muted' }}>Нет таких гильдий</Text>
          ) : (
            <Table.Container>
              <DataTable data={historicalData} initialSortColumn="title" initialSortDirection="ASC" columns={buildColumns()} />
            </Table.Container>
          )}
        </>
      )}

      {modalGuild && (
        <ContributeModal
          guildId={modalGuild.id}
          title={modalGuild.title}
          accounts={modalGuild.accounts}
          data={tierByGuild.get(modalGuild.id)?.data ?? null}
          onClose={() => setModalGuild(null)}
          onRefreshed={() => { void load(true); }}
        />
      )}
    </Box>
  );
}
