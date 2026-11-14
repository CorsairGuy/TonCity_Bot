import { useEffect, useState } from 'react';
import { Box, Button, Flash, Label, Select, Text, TextInput, Spinner } from '@primer/react';
import { api, type GuildSearchData, type GuildJoinDetail } from '../api';
import { useAsk } from '../hooks/useAsk';
import { fmt } from '../utils';

// Открытие/смена аккаунта читает БД. Игру вызывают только явные кнопки пользователя.
export function GuildDiscovery({ onJoined }: { onJoined: () => void }) {
  const [accounts, setAccounts] = useState<{ id: number; name: string }[]>([]);
  const [account, setAccount] = useState(0), [query, setQuery] = useState('');
  const [data, setData] = useState<GuildSearchData | null>(null), [detail, setDetail] = useState<GuildJoinDetail | null>(null);
  const [reason, setReason] = useState<string | null>(null), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const ask = useAsk();
  useEffect(() => {
    let alive = true; setLoading(true); setData(null); setDetail(null); setMessage(null);
    api.guildDiscovery(account || undefined).then(r => {
      if (!alive) return;
      if (r.ok) { setAccounts(r.accounts); setData(r.data); if (!account && r.accounts.length) setAccount(r.accounts[0].id); }
      else setMessage({ ok: false, text: r.error ?? 'Ошибка чтения снимка' });
    }).catch(e => { if (alive) setMessage({ ok: false, text: String(e) }); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [account]);
  const open = async (id: number) => {
    if (!account || busy) return;
    setBusy(true); setMessage(null); setDetail(null);
    try { const r = await api.guildDetail(account, id); if (r.ok) { setDetail(r.data); setReason(r.reason); } else setMessage({ ok: false, text: r.error ?? 'Гильдия не найдена' }); }
    catch (e) { setMessage({ ok: false, text: String(e) }); } finally { setBusy(false); }
  };
  const search = async (page = 1) => {
    if (!account || busy) return;
    if (page === 1 && /^\d+$/.test(query.trim())) { await open(Number(query.trim())); return; }
    setBusy(true); setMessage(null); setDetail(null);
    try { const r = await api.guildSearch(account, query, page); if (r.ok) setData(r.data); else setMessage({ ok: false, text: r.error ?? 'Ошибка поиска' }); }
    catch (e) { setMessage({ ok: false, text: String(e) }); } finally { setBusy(false); }
  };
  const join = async () => {
    if (!detail?.guild || reason || busy) return;
    const apply = detail.settings?.guild_type === 'application';
    if (!await ask(apply ? 'Подать заявку?' : 'Вступить в гильдию?', `Аккаунт «${accounts.find(a => a.id === account)?.name}»: ${apply ? 'заявка в' : 'вступление в'} «${detail.guild.title}».`, { ok: apply ? 'Подать заявку' : 'Вступить' })) return;
    setBusy(true); setMessage(null);
    try {
      const r = await api.guildJoin(account, detail.guild.id, detail.settings?.guild_type ?? '');
      setMessage({ ok: r.ok, text: r.ok ? `${r.status === 'application_submitted' ? 'Заявка отправлена' : 'Аккаунт вступил в гильдию'}${r.refresh_error ? '. Снимок обновить не удалось: ' + r.refresh_error : ''}` : r.error ?? 'Ошибка вступления' });
      if (r.current) { setDetail(r.current); setReason(r.current.membership ? 'Аккаунт уже состоит в гильдии' : r.current.status === 'pending' ? 'Заявка уже отправлена' : null); }
      if (r.ok && r.status !== 'application_submitted') onJoined();
    } catch (e) { setMessage({ ok: false, text: String(e) }); } finally { setBusy(false); }
  };
  return <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
      <Select aria-label="Аккаунт для вступления" disabled={busy || loading} value={String(account)} onChange={e => setAccount(Number(e.target.value))}>{accounts.map(a => <Select.Option key={a.id} value={String(a.id)}>{a.name}</Select.Option>)}</Select>
      <TextInput aria-label="Название или ID гильдии" placeholder="Название или ID гильдии" disabled={busy} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void search(); }} />
      <Button disabled={!account || busy || loading} loading={busy} onClick={() => search()}>Найти / Обновить</Button>
    </Box>
    {message && <Flash variant={message.ok ? 'success' : 'danger'}>{message.text}</Flash>}
    {loading ? <Spinner /> : !data && !detail && <Text sx={{ color: 'fg.muted' }}>Введите название или ID и нажмите «Найти / Обновить». При открытии читается сохранённый снимок.</Text>}
    {detail?.guild && <Box sx={{ p: 3, border: '1px solid', borderColor: 'border.default', borderRadius: 2 }}>
      <Text sx={{ fontWeight: 'bold', display: 'block' }}>{detail.guild.title} · #{detail.guild.id}</Text>
      <Text sx={{ display: 'block', my: 2 }}>{detail.guild.description}</Text>
      <Text sx={{ display: 'block' }}>Участники: {detail.guild.members_count ?? '—'} / {detail.settings?.member_capacity ?? '—'}</Text>
      <Text sx={{ display: 'block' }}>Условия: население {fmt(detail.settings?.application_criteria_population ?? 0)}, доход {fmt(detail.settings?.application_criteria_profit ?? 0)}</Text>
      {detail.settings?.membership_fee_type && <Text sx={{ display: 'block' }}>Членский взнос: {detail.settings.membership_fee_amount ?? '—'} {detail.settings.membership_fee_currency === 'crystals' ? 'алмазов' : 'монет'}</Text>}
      {reason && <Text sx={{ display: 'block', my: 2, color: 'fg.muted' }}>{reason}</Text>}
      <Button sx={{ mt: 2 }} variant="primary" disabled={busy || !!reason} onClick={join}>{detail.status === 'pending' ? 'Заявка отправлена' : detail.settings?.guild_type === 'application' ? 'Подать заявку' : 'Вступить'}</Button>
      <Button sx={{ ml: 2 }} disabled={busy} onClick={() => open(detail.guild!.id)}>Обновить условия</Button>
    </Box>}
    {data && <>
      <Text sx={{ color: 'fg.muted' }}>Сохранённый поиск: {data.query || 'популярные гильдии'} · страница {data.page}</Text>
      {data.results.length === 0 && <Text>Гильдии не найдены</Text>}
      {data.results.map(g => <Box key={g.id} sx={{ p: 3, border: '1px solid', borderColor: 'border.default', borderRadius: 2, display: 'flex', justifyContent: 'space-between', gap: 2 }}>
        <Box><Text sx={{ fontWeight: 'bold' }}>{g.title}</Text> <Label>#{g.id}</Label><Text sx={{ display: 'block', color: 'fg.muted' }}>Население: {fmt(g.population ?? 0)} · Доход: {fmt(g.profit ?? 0)}</Text></Box>
        <Button disabled={busy} onClick={() => open(g.id)}>Условия и вступление</Button>
      </Box>)}
      <Box sx={{ display: 'flex', gap: 2 }}><Button disabled={busy || data.page <= 1} onClick={() => search(data.page - 1)}>Назад</Button><Button disabled={busy || !data.has_more} onClick={() => search(data.page + 1)}>Далее</Button></Box>
    </>}
  </Box>;
}
