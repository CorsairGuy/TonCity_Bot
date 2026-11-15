import { useEffect, useState } from 'react';
import { ArrowLeftIcon, SearchIcon, SyncIcon } from '@primer/octicons-react';
import { Box, Button, Checkbox, Flash, Label, Text, TextInput, Spinner } from '@primer/react';
import { Dialog } from '@primer/react/experimental';
import { api, type GuildSearchData, type GuildJoinDetail } from '../api';
import { fmt } from '../utils';

const card = { p: 2, borderRadius: '12px', border: '1px solid', borderColor: 'border.default', bg: 'canvas.default', display: 'flex', flexDirection: 'column', gap: 2 } as const;
const guildTypeName = (type?: string) => type === 'open' ? 'Открытая' : type === 'application' ? 'По заявкам' : type === 'closed' ? 'Закрытая' : 'Неизвестно';

// Открытие/смена аккаунта читает БД. Игру вызывают только явные кнопки пользователя.
export function GuildDiscovery({ onJoined, freeAccounts }: { onJoined: () => void; freeAccounts: { id: number; name: string }[] }) {
  const [accounts, setAccounts] = useState<{ id: number; name: string }[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [account, setAccount] = useState(0), [query, setQuery] = useState('');
  const [data, setData] = useState<GuildSearchData | null>(null), [detail, setDetail] = useState<GuildJoinDetail | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [joinOpen, setJoinOpen] = useState(false), [selectedFree, setSelectedFree] = useState<number[]>([]);

  useEffect(() => {
    let alive = true;
    api.guildDiscovery().then(r => {
      if (!alive) return;
      if (!r.ok) { setMessage({ ok: false, text: r.error ?? 'Не удалось загрузить аккаунты' }); setLoading(false); return; }
      setAccountsLoaded(true);
      setAccounts(r.accounts);
      if (r.accounts.length) setAccount(r.accounts[0].id);
      else setLoading(false);
    }).catch(e => {
      if (alive) { setMessage({ ok: false, text: String(e) }); setLoading(false); }
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!account) return;
    let alive = true;
    setLoading(true); setData(null); setDetail(null); setMessage(null);
    api.guildDiscovery(account).then(r => {
      if (!alive) return;
      if (r.ok) { setAccounts(r.accounts); setData(r.data); }
      else setMessage({ ok: false, text: r.error ?? 'Ошибка чтения сохранённого поиска' });
    }).catch(e => { if (alive) setMessage({ ok: false, text: String(e) }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [account]);

  const open = async (id: number) => {
    if (!account || busy || loading) return;
    setBusy(true); setMessage(null); setDetail(null);
    try {
      const r = await api.guildDetail(account, id);
      if (r.ok && r.data.guild) setDetail(r.data);
      else setMessage({ ok: false, text: r.error ?? 'Игра не вернула данные этой гильдии' });
    } catch (e) { setMessage({ ok: false, text: String(e) }); }
    finally { setBusy(false); }
  };

  const search = async (page = 1) => {
    if (!account || busy || loading) return;
    const term = query.trim();
    if (page === 1 && /^#?-?\d+$/.test(term)) {
      const id = Number(term.replace(/^#/, ''));
      if (!Number.isSafeInteger(id) || id === 0) { setMessage({ ok: false, text: 'Введите корректный ID гильдии' }); return; }
      await open(id);
      return;
    }
    setBusy(true); setMessage(null); setDetail(null);
    try {
      const r = await api.guildSearch(account, term, page);
      if (r.ok) setData(r.data);
      else setMessage({ ok: false, text: r.error ?? 'Ошибка поиска. Предыдущая выдача сохранена.' });
    } catch (e) { setMessage({ ok: false, text: `${String(e)}. Предыдущая выдача сохранена.` }); }
    finally { setBusy(false); }
  };

  const openJoin = () => {
    if (!detail?.guild || busy || detail.settings?.guild_type === 'closed' || !freeAccounts.length) return;
    setSelectedFree(freeAccounts.map(a => a.id));
    setJoinOpen(true);
  };

  const join = async () => {
    if (!detail?.guild || busy || !selectedFree.length) return;
    const apply = detail.settings?.guild_type === 'application';
    const target = detail.guild;
    const chosen = freeAccounts.filter(a => selectedFree.includes(a.id));
    setBusy(true); setMessage(null);
    setJoinOpen(false);
    let succeeded = 0, joined = 0, lastCurrent: GuildJoinDetail | null = null;
    const errors: string[] = [];
    try {
      for (const acc of chosen) {
        try {
          const r = await api.guildJoin(acc.id, target.id, detail.settings?.guild_type ?? '');
          if (r.current) lastCurrent = r.current;
          if (r.ok) {
            succeeded++;
            if (r.status !== 'application_submitted') joined++;
            if (r.refresh_error) errors.push(`${acc.name}: действие выполнено, но снимок обновить не удалось (${r.refresh_error})`);
          } else errors.push(`${acc.name}: ${r.error ?? 'ошибка вступления'}`);
        } catch (e) {
          errors.push(`${acc.name}: ${String(e)}`);
        }
      }
      const action = apply ? 'заявок отправлено' : 'аккаунтов вступило';
      const summary = `${succeeded} из ${chosen.length} ${action}${errors.length ? `; ошибки: ${errors.join('; ')}` : ''}`;
      setMessage({ ok: succeeded > 0 && errors.length === 0, text: summary });
      if (joined) onJoined();
      if (lastCurrent?.guild) setDetail(lastCurrent);
    } finally { setBusy(false); }
  };

  const term = query.trim();
  const staleResults = !!data && data.query !== term;

  return <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
    <Box sx={{ ...card, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
      <TextInput aria-label="Название или ID гильдии" placeholder="Название или ID гильдии" disabled={!account || busy || loading} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void search(); }} sx={{ flex: '1 1 240px', minWidth: 0 }} />
      <Button leadingVisual={term ? SearchIcon : SyncIcon} disabled={!account || busy || loading} loading={busy} onClick={() => void search()}>{term ? 'Найти' : 'Популярные гильдии'}</Button>
      <Text sx={{ width: '100%', color: 'fg.muted', fontSize: 0 }}>Для вступления доступны свободные аккаунты: {freeAccounts.length}</Text>
    </Box>

    {message && <Flash variant={message.ok ? 'success' : 'danger'}>{message.text}</Flash>}
    {loading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><Spinner /></Box>}
    {!loading && accountsLoaded && !accounts.length && <Flash variant="warning">Нет аккаунтов для поиска. Сначала добавьте аккаунт бота.</Flash>}

    {!loading && accounts.length > 0 && detail?.guild && <Box sx={card}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Button leadingVisual={ArrowLeftIcon} disabled={busy} onClick={() => { setDetail(null); setMessage(null); }}>{data ? 'К результатам' : 'К поиску'}</Button>
        <Text sx={{ flex: 1, fontWeight: 'bold', fontSize: 2 }}>{detail.guild.title}</Text>
        <Label>#{detail.guild.id}</Label>
        <Label>{guildTypeName(detail.settings?.guild_type)}</Label>
      </Box>
      {!!detail.guild.description && <Text sx={{ color: 'fg.muted' }}>{detail.guild.description}</Text>}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 2 }}>
        <Text>Участники: {detail.guild.members_count ?? '—'} / {detail.settings?.member_capacity ?? '—'}</Text>
        <Text>Минимум населения: {fmt(detail.settings?.application_criteria_population ?? 0)}</Text>
        <Text>Минимум дохода: {fmt(detail.settings?.application_criteria_profit ?? 0)}/ч</Text>
      </Box>
      {detail.settings?.membership_fee_type && <Text>Членский взнос: {detail.settings.membership_fee_amount ?? '—'} {detail.settings.membership_fee_currency === 'crystals' ? 'алмазов' : 'монет'}</Text>}
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <Button variant="primary" disabled={busy || detail.settings?.guild_type === 'closed' || !freeAccounts.length} loading={busy} onClick={openJoin}>
          {detail.settings?.guild_type === 'application' ? 'Подать заявку' : 'Вступить'}
        </Button>
        <Button leadingVisual={SyncIcon} disabled={busy} loading={busy} onClick={() => void open(detail.guild!.id)}>Обновить условия</Button>
      </Box>
    </Box>}

    {!loading && accounts.length > 0 && !detail && data && <>
      {staleResults && <Flash variant="warning">Показаны результаты предыдущего поиска «{data.query || 'популярные гильдии'}». Нажмите «Найти», чтобы обновить выдачу.</Flash>}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Text sx={{ flex: 1, color: 'fg.muted' }}>{data.query ? `Результаты поиска «${data.query}»` : 'Популярные гильдии'} · страница {data.page}</Text>
      </Box>
      {data.results.length === 0
        ? <Box sx={{ ...card, alignItems: 'center', py: 4 }}><Text sx={{ fontWeight: 'semibold' }}>Гильдии не найдены</Text><Text sx={{ color: 'fg.muted' }}>{data.query ? 'Попробуйте изменить запрос или проверьте ID гильдии.' : 'Сейчас нет популярных гильдий. Попробуйте поиск по названию или ID.'}</Text></Box>
        : <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 2 }}>
          {data.results.map(g => <Box key={g.id} sx={card}>
            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
              <Box sx={{ flex: 1, minWidth: 0 }}><Text sx={{ display: 'block', fontWeight: 'semibold', overflowWrap: 'anywhere' }}>{g.title || 'Гильдия без названия'}</Text><Text sx={{ color: 'fg.muted', fontSize: 0 }}>#{g.id}</Text></Box>
              <Label>{g.members_count == null ? 'Состав неизвестен' : `${fmt(g.members_count)} уч.`}</Label>
            </Box>
            <Text sx={{ color: 'fg.muted', fontSize: 0 }}>Население {fmt(g.population ?? 0)} · Доход {fmt(g.profit ?? 0)}/ч</Text>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}><Button size="small" disabled={busy} onClick={() => void open(g.id)}>Условия и вступление</Button></Box>
          </Box>)}
        </Box>}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
        <Button leadingVisual={ArrowLeftIcon} disabled={busy || data.page <= 1} onClick={() => void search(data.page - 1)}>Назад</Button>
        <Text sx={{ color: 'fg.muted', fontSize: 0 }}>Страница {data.page}</Text>
        <Button disabled={busy || !data.has_more} onClick={() => void search(data.page + 1)}>Далее</Button>
      </Box>
    </>}

    {!loading && accounts.length > 0 && !detail && !data && !message && <Text sx={{ color: 'fg.muted' }}>Введите название или ID либо нажмите «Популярные гильдии». При открытии читается сохранённый снимок; поиск отправляется только по кнопке.</Text>}

    {joinOpen && detail?.guild && <Dialog title={detail.settings?.guild_type === 'application' ? 'Выбрать аккаунты для заявки' : 'Выбрать аккаунты для вступления'} onClose={() => { if (!busy) setJoinOpen(false); }} width="large" position={{ narrow: 'bottom', regular: 'center' }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Text>Гильдия: <strong>{detail.guild.title}</strong>. В списке только аккаунты, не состоящие в гильдии.</Text>
        {!freeAccounts.length
          ? <Text sx={{ color: 'fg.muted' }}>Свободных аккаунтов нет.</Text>
          : <>
              <Box as="label" sx={{ display: 'flex', alignItems: 'center', gap: 2, cursor: 'pointer', fontWeight: 'semibold' }}>
                <Checkbox checked={selectedFree.length === freeAccounts.length} indeterminate={selectedFree.length > 0 && selectedFree.length < freeAccounts.length} onChange={e => setSelectedFree(e.target.checked ? freeAccounts.map(a => a.id) : [])} />
                Выбрать все ({freeAccounts.length})
              </Box>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, maxHeight: '40vh', overflowY: 'auto' }}>
                {freeAccounts.map(a => <Box key={a.id} as="label" sx={{ display: 'flex', alignItems: 'center', gap: 2, p: 2, border: '1px solid', borderColor: 'border.default', borderRadius: 2, cursor: 'pointer' }}>
                  <Checkbox checked={selectedFree.includes(a.id)} onChange={e => setSelectedFree(old => e.target.checked ? [...old, a.id] : old.filter(id => id !== a.id))} />
                  <Text>{a.name}</Text>
                </Box>)}
              </Box>
            </>}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2, flexWrap: 'wrap' }}>
          <Button disabled={busy} onClick={() => setJoinOpen(false)}>Отмена</Button>
          <Button variant="primary" disabled={busy || !selectedFree.length} loading={busy} onClick={() => void join()}>
            {detail.settings?.guild_type === 'application' ? `Подать заявки (${selectedFree.length})` : `Вступить (${selectedFree.length})`}
          </Button>
        </Box>
      </Box>
    </Dialog>}
  </Box>;
}
