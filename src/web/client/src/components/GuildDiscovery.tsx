import { useEffect, useState } from 'react';
import { ArrowLeftIcon, SearchIcon, SyncIcon } from '@primer/octicons-react';
import { Box, Button, Flash, Label, Select, Text, TextInput, Spinner } from '@primer/react';
import { api, type GuildSearchData, type GuildJoinDetail } from '../api';
import { useAsk } from '../hooks/useAsk';
import { fmt } from '../utils';

const card = { p: 2, borderRadius: '12px', border: '1px solid', borderColor: 'border.default', bg: 'canvas.default', display: 'flex', flexDirection: 'column', gap: 2 } as const;
const guildTypeName = (type?: string) => type === 'open' ? 'Открытая' : type === 'application' ? 'По заявкам' : type === 'closed' ? 'Закрытая' : 'Неизвестно';

// Открытие/смена аккаунта читает БД. Игру вызывают только явные кнопки пользователя.
export function GuildDiscovery({ onJoined }: { onJoined: () => void }) {
  const [accounts, setAccounts] = useState<{ id: number; name: string }[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [account, setAccount] = useState(0), [query, setQuery] = useState('');
  const [data, setData] = useState<GuildSearchData | null>(null), [detail, setDetail] = useState<GuildJoinDetail | null>(null);
  const [reason, setReason] = useState<string | null>(null), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const ask = useAsk();

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
    setLoading(true); setData(null); setDetail(null); setReason(null); setMessage(null);
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
    setBusy(true); setMessage(null); setDetail(null); setReason(null);
    try {
      const r = await api.guildDetail(account, id);
      if (r.ok && r.data.guild) { setDetail(r.data); setReason(r.reason); }
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
    setBusy(true); setMessage(null); setDetail(null); setReason(null);
    try {
      const r = await api.guildSearch(account, term, page);
      if (r.ok) setData(r.data);
      else setMessage({ ok: false, text: r.error ?? 'Ошибка поиска. Предыдущая выдача сохранена.' });
    } catch (e) { setMessage({ ok: false, text: `${String(e)}. Предыдущая выдача сохранена.` }); }
    finally { setBusy(false); }
  };

  const join = async () => {
    if (!detail?.guild || reason || busy) return;
    const apply = detail.settings?.guild_type === 'application';
    const accountName = accounts.find(a => a.id === account)?.name ?? 'выбранного аккаунта';
    if (!await ask(apply ? 'Подать заявку?' : 'Вступить в гильдию?', `Аккаунт «${accountName}»: ${apply ? 'заявка в' : 'вступление в'} «${detail.guild.title}».`, { ok: apply ? 'Подать заявку' : 'Вступить' })) return;
    setBusy(true); setMessage(null);
    try {
      const r = await api.guildJoin(account, detail.guild.id, detail.settings?.guild_type ?? '');
      setMessage({ ok: r.ok, text: r.ok ? `${r.status === 'application_submitted' ? 'Заявка отправлена' : 'Аккаунт вступил в гильдию'}${r.refresh_error ? '. Снимок обновить не удалось: ' + r.refresh_error : ''}` : r.error ?? 'Ошибка вступления' });
      if (r.current) {
        setDetail(r.current);
        setReason(r.current.membership ? 'Аккаунт уже состоит в гильдии' : r.current.status === 'pending' ? 'Заявка уже отправлена' : null);
      }
      if (r.ok && r.status !== 'application_submitted') onJoined();
    } catch (e) { setMessage({ ok: false, text: String(e) }); }
    finally { setBusy(false); }
  };

  const selectedAccount = accounts.find(a => a.id === account);
  const term = query.trim();
  const staleResults = !!data && data.query !== term;

  return <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
    <Box sx={{ ...card, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
      <Select aria-label="Аккаунт для вступления" disabled={busy || loading || !accounts.length} value={String(account)} onChange={e => setAccount(Number(e.target.value))} sx={{ maxWidth: '100%' }}>
        {accounts.map(a => <Select.Option key={a.id} value={String(a.id)}>{a.name}</Select.Option>)}
      </Select>
      <TextInput aria-label="Название или ID гильдии" placeholder="Название или ID гильдии" disabled={!account || busy || loading} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void search(); }} sx={{ flex: '1 1 240px', minWidth: 0 }} />
      <Button leadingVisual={term ? SearchIcon : SyncIcon} disabled={!account || busy || loading} loading={busy} onClick={() => void search()}>{term ? 'Найти' : 'Популярные гильдии'}</Button>
    </Box>

    {message && <Flash variant={message.ok ? 'success' : 'danger'}>{message.text}</Flash>}
    {loading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><Spinner /></Box>}
    {!loading && accountsLoaded && !accounts.length && <Flash variant="warning">Нет аккаунтов для поиска. Сначала добавьте аккаунт бота.</Flash>}

    {!loading && accounts.length > 0 && detail?.guild && <Box sx={card}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Button leadingVisual={ArrowLeftIcon} disabled={busy} onClick={() => { setDetail(null); setReason(null); setMessage(null); }}>{data ? 'К результатам' : 'К поиску'}</Button>
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
      {reason && <Flash variant="warning">{reason}</Flash>}
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <Button variant="primary" disabled={busy || !!reason || detail.settings?.guild_type === 'closed'} loading={busy} onClick={() => void join()}>
          {detail.status === 'pending' ? 'Заявка отправлена' : detail.settings?.guild_type === 'application' ? 'Подать заявку' : 'Вступить'}
        </Button>
        <Button leadingVisual={SyncIcon} disabled={busy} loading={busy} onClick={() => void open(detail.guild!.id)}>Обновить условия</Button>
      </Box>
    </Box>}

    {!loading && accounts.length > 0 && !detail && data && <>
      {staleResults && <Flash variant="warning">Показаны результаты предыдущего поиска «{data.query || 'популярные гильдии'}». Нажмите «Найти», чтобы обновить выдачу.</Flash>}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Text sx={{ flex: 1, color: 'fg.muted' }}>{data.query ? `Результаты поиска «${data.query}»` : 'Популярные гильдии'} · страница {data.page}</Text>
        <Text sx={{ color: 'fg.muted', fontSize: 0 }}>От имени: {selectedAccount?.name ?? '—'}</Text>
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
  </Box>;
}
