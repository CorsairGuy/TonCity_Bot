import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Button, Flash, Heading, Label, Select, Spinner, Text, TextInput } from '@primer/react';
import { Dialog } from '@primer/react/experimental';
import { api, type Account, type ChampionshipAction, type ChampionshipId, type ChampionshipMember, type ChampionshipOverview, type ChampionshipSquad } from '../api';
import { PageHeader } from '../components/PageHeader';
import { LoadError } from '../components/LoadError';
import { useAsk } from '../hooks/useAsk';

const same = (a: ChampionshipId | null | undefined, b: ChampionshipId | null | undefined) => a != null && b != null && String(a) === String(b);
const statusText = { forming: 'Набор', submitted: 'На рассмотрении', fielded: 'Выставлен' };
type Form = { kind: 'create' } | { kind: 'rename'; squad: ChampionshipSquad } |  { kind: 'move'; squad: ChampionshipSquad; member: ChampionshipMember };
type Input = { squadId?: ChampionshipId; memberId?: ChampionshipId; name?: string; toSquadId?: ChampionshipId };

function AccountChampionships({ accountId }: { accountId: number }) {
  const ask = useAsk(), mounted = useRef(false), request = useRef(0);
  const [data, setData] = useState<ChampionshipOverview | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState<{ text: string; warning: boolean } | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [needsRefresh, setNeedsRefresh] = useState(false);
  const [form, setForm] = useState<Form | null>(null), [name, setName] = useState(''), [target, setTarget] = useState(''), [formError, setFormError] = useState('');
  const load = useCallback(async () => {
    const revision = ++request.current;
    setLoading(true);
    const reply = await api.championships(accountId);
    if (!mounted.current || revision !== request.current) return;
    setLoading(false);
    if (reply.ok && reply.data) { setData(reply.data); setError(''); setNeedsRefresh(false); }
    else { setError(reply.error ?? 'Не удалось загрузить чемпионаты'); setNeedsRefresh(true); }
  }, [accountId]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; request.current++; }; }, [load]);
  const run = async (action: ChampionshipAction, input: Input = {}) => {
    if (!mounted.current || busy || needsRefresh) return false;
    setBusy(true); setNote(null); setFormError('');
    try {
      const reply = await api.championshipAction(accountId, action, input);
      if (!mounted.current) return false;
      if (reply.data) setData(reply.data);
      setNeedsRefresh(!!reply.needsRefresh);
      if (!reply.ok) { const text = reply.error ?? 'Действие не выполнено'; setNote({ text, warning: true }); setFormError(text); return false; }
      setNote({ text: reply.error ?? 'Готово', warning: !!reply.needsRefresh });
      return true;
    } finally { if (mounted.current) setBusy(false); }
  };
  const confirm = async (action: ChampionshipAction, squad: ChampionshipSquad, title: string, text: string, input: Input = {}, danger = false) => {
    if (await ask(title, text, { ok: 'Подтвердить', danger })) await run(action, { squadId: squad.id, ...input });
  };
  const openForm = (value: Form) => { setForm(value); setFormError(''); setName(value.kind === 'rename' ? value.squad?.name ?? '' : ''); setTarget(''); };
  const config = data?.config, viewer = data?.viewer;
  const disabled = busy || loading || needsRefresh;
  const targets = form?.kind === 'move' ? data?.squads.filter(s => !same(s.id, form.squad.id) && s.status === 'forming' && s.members.length < (config?.max_squad_size ?? 0)) ?? [] : [];
  const saveForm = async () => {
    if (!form) return;
    const input: Input = form.kind === 'move' ? { squadId: form.squad.id, memberId: form.member.user_id, toSquadId: target } : { name: name.trim().replace(/\s+/g, ' '), ...(form.kind === 'rename' ? { squadId: form.squad?.id } : {}) };
    if (await run(form.kind, input)) setForm(null);
  };
  const renderSquad = (squad: ChampionshipSquad) => {
    if (!viewer || !config) return null;
    const leader = same(squad.leader_id, viewer.user_id), mine = same(viewer.squad_id, squad.id), admin = viewer.is_guild_admin;
    const forming = squad.status === 'forming', submitted = squad.status === 'submitted', fielded = squad.status === 'fielded';
    const applied = viewer.applied_squad_ids.some(id => same(id, squad.id)), full = squad.members.length >= config.max_squad_size;
    const lockedText = 'После одобрения участники не смогут покинуть отряд или гильдию, пока гильдия не отзовёт отряд.';
    return <Box key={squad.id} sx={{ p: 3, border: '1px solid', borderColor: mine ? 'accent.emphasis' : 'border.default', borderRadius: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        <Heading as="h3" sx={{ fontSize: 2 }}>{squad.name}</Heading>
        <Label variant={fielded ? 'success' : submitted ? 'attention' : 'secondary'}>{statusText[squad.status] ?? squad.status}</Label>
        <Text sx={{ color: 'fg.muted' }}>{squad.members.length}/{config.max_squad_size}</Text>
        {mine && <Label variant="accent">Ваш отряд</Label>}
        {leader && forming && <Button size="small" disabled={disabled} onClick={() => openForm({ kind: 'rename', squad })}>Переименовать</Button>}
      </Box>
      {squad.members.map(member => <Box key={member.user_id} sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        <Text sx={{ flex: 1 }}>{member.name}{same(member.user_id, viewer.user_id) ? ' · вы' : ''}</Text>
        {same(member.user_id, squad.leader_id) ? <Label>Лидер</Label> : forming && <>
          {leader && <Button size="small" disabled={disabled} onClick={() => void confirm('leader', squad, 'Передать лидерство?', `${member.name} станет лидером отряда.`, { memberId: member.user_id })}>Передать лидерство</Button>}
          {admin && <Button size="small" disabled={disabled || !data?.squads.some(s => !same(s.id, squad.id) && s.status === 'forming' && s.members.length < config.max_squad_size)} onClick={() => openForm({ kind: 'move', squad, member })}>Перевести</Button>}
          {leader && <Button size="small" variant="danger" disabled={disabled} onClick={() => void confirm('kick', squad, 'Исключить участника?', `${member.name} будет исключён из отряда «${squad.name}».`, { memberId: member.user_id }, true)}>Исключить</Button>}
        </>}
      </Box>)}
      {!!squad.applications?.length && <Box sx={{ borderTop: '1px solid', borderColor: 'border.default', pt: 2 }}>
        <Text sx={{ fontWeight: 'semibold' }}>Заявки</Text>
        {squad.applications.map(member => <Box key={member.user_id} sx={{ display: 'flex', gap: 2, alignItems: 'center', mt: 2, flexWrap: 'wrap' }}>
          <Text sx={{ flex: 1 }}>{member.name}</Text>
          {leader && <><Button size="small" disabled={disabled} onClick={() => void run('decline', { squadId: squad.id, memberId: member.user_id })}>Отклонить</Button>
            <Button size="small" variant="primary" disabled={disabled || !forming || full} onClick={() => void run('accept', { squadId: squad.id, memberId: member.user_id })}>Принять</Button></>}
        </Box>)}
      </Box>}
      {fielded && mine && <Flash variant="warning">{lockedText}</Flash>}
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        {leader && <>
          {forming && <Button variant="primary" disabled={disabled || squad.members.length < config.min_squad_size || squad.members.length > config.max_squad_size} onClick={() => void confirm('submit', squad, 'Подать состав?', lockedText)}>Подать состав</Button>}
          {submitted && <Button disabled={disabled} onClick={() => void run('recall', { squadId: squad.id })}>Снять с рассмотрения</Button>}
          {!fielded && <Button variant="danger" disabled={disabled} onClick={() => void confirm('disband', squad, 'Распустить отряд?', `Отряд «${squad.name}» будет распущен. Его участники и подавшие заявки получат уведомление игры.`, {}, true)}>Распустить</Button>}
        </>}
        {!leader && mine && !fielded && <Button variant="danger" disabled={disabled} onClick={() => void confirm('leave', squad, 'Покинуть отряд?', submitted ? 'Состав будет снят с рассмотрения и снова начнёт набор.' : 'Вы сможете подать заявку в другой отряд.', {}, true)}>Покинуть</Button>}
        {viewer.squad_id == null && (applied ? <Button disabled={disabled} onClick={() => void run('withdrawApplication', { squadId: squad.id })}>Отозвать заявку</Button> : forming && !full && <Button disabled={disabled} onClick={() => void run('apply', { squadId: squad.id })}>Подать заявку</Button>)}
        {admin && submitted && <>
          <Button disabled={disabled} onClick={() => void confirm('reject', squad, 'Вернуть состав?', 'Отряд снова начнёт набор, лидер получит уведомление игры.')}>Вернуть состав</Button>
          <Button variant="primary" disabled={disabled} onClick={() => void confirm('approve', squad, 'Выставить отряд?', lockedText)}>Выставить</Button>
        </>}
        {admin && fielded && <Button disabled={disabled} onClick={() => void confirm('withdraw', squad, 'Отозвать отряд?', 'Отряд выйдет из сезона, его участники смогут покинуть отряд и гильдию.')}>Отозвать из сезона</Button>}
      </Box>
    </Box>;
  };
  return <>
    <PageHeader title="Чемпионаты" sub={config?.season != null ? `Сезон ${config.season}` : undefined} actions={<Button disabled={busy || loading} onClick={() => void load()}>Обновить</Button>} />
    <LoadError error={error} onRetry={() => void load()} />
    {note && <Flash variant={note.warning ? 'warning' : 'success'} sx={{ mb: 3 }}>{note.text}</Flash>}
    {needsRefresh && data && <Flash variant="warning" sx={{ mb: 3 }}>Перед следующим действием обновите состояние отрядов.</Flash>}
    {loading && !data ? <Spinner /> : data && <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {!viewer ? <Text>Для участия в чемпионатах аккаунту нужна гильдия.</Text> : !config ? <Text>Правила сезона пока недоступны.</Text> : <>
        <Text sx={{ color: 'fg.muted' }}>Размер отряда: {config.min_squad_size}–{config.max_squad_size}. {config.season_starts_on ? `Начало сезона: ${new Date(config.season_starts_on).toLocaleDateString('ru')}.` : ''}</Text>
        <Text sx={{ color: 'fg.muted' }}>Лидер отряда подаёт состав, лидер или офицер гильдии одобряет его. До отзыва выставленного отряда его участники не могут покинуть отряд и гильдию.</Text>
        {viewer.squad_id == null && <Box><Button variant="primary" disabled={disabled} onClick={() => openForm({ kind: 'create' })}>Создать отряд</Button></Box>}
        {data.squads.length === 0 && <Text sx={{ color: 'fg.muted' }}>В вашей гильдии пока нет отрядов.</Text>}
        {[...data.squads].sort((a, b) => Number(same(b.id, viewer.squad_id)) - Number(same(a.id, viewer.squad_id))).map(renderSquad)}
      </>}
    </Box>}
    {form && config && <Dialog title={form.kind === 'create' ? 'Создать отряд' : form.kind === 'rename' ? 'Переименовать отряд' : `Перевести ${form.member.name}`} onClose={() => { if (!busy) setForm(null); }} position={{ narrow: 'bottom', regular: 'center' }} footerButtons={[
      { content: 'Отмена', onClick: () => setForm(null), disabled: busy },
      { content: 'Сохранить', buttonType: 'primary', loading: busy, disabled: busy || needsRefresh || (form.kind === 'move' ? !target : name.trim().length < config.name_min_length || name.trim().length > config.name_max_length), onClick: () => void saveForm() },
    ]}>
      {formError && <Flash variant="danger" sx={{ mb: 3 }}>{formError}</Flash>}
      {form.kind === 'move' ? <Select aria-label="Другой отряд" value={target} onChange={e => setTarget(e.target.value)} block>
        <Select.Option value="">Выберите отряд</Select.Option>{targets.map(s => <Select.Option key={s.id} value={String(s.id)}>{s.name} · {s.members.length}/{config.max_squad_size}</Select.Option>)}
      </Select> : <><Text as="p">Название: {config.name_min_length}–{config.name_max_length} символов.</Text><TextInput aria-label="Название отряда" value={name} onChange={e => setName(e.target.value)} maxLength={config.name_max_length} block /></>}
    </Dialog>}
  </>;
}

export function Championships() {
  const [accounts, setAccounts] = useState<Account[]>([]), [accountId, setAccountId] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); const reply = await api.accounts(); setLoading(false);
    if (!reply.ok) { setError('Не удалось загрузить аккаунты'); return; }
    const list = reply.accounts.filter(a => a.hasToken).sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
    setAccounts(list); setError(''); setAccountId(previous => list.some(a => String(a.id) === previous) ? previous : String(list[0]?.id ?? ''));
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <Box sx={{ p: 3 }}>
    <LoadError error={error} onRetry={() => void load()} />
    {loading ? <Spinner /> : !accounts.length ? <Text>Нет аккаунтов с токеном.</Text> : <>
      <Select aria-label="Аккаунт чемпионатов" value={accountId} onChange={e => setAccountId(e.target.value)} sx={{ mb: 3 }}>
        {accounts.map(a => <Select.Option key={a.id} value={String(a.id)}>{a.name}</Select.Option>)}
      </Select>
      {accountId && <AccountChampionships key={accountId} accountId={Number(accountId)} />}
    </>}
  </Box>;
}
