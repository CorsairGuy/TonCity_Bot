import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionList, ActionMenu, Box, Button, CounterLabel, Flash, IconButton, Label, SegmentedControl, Text, TextInput, Textarea } from '@primer/react';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, CommentDiscussionIcon, KebabHorizontalIcon, MegaphoneIcon, MuteIcon, PaperAirplaneIcon, PersonIcon, PinIcon, SyncIcon, TrashIcon, UnmuteIcon } from '@primer/octicons-react';
import { api, type GuildChatFeed, type GuildChatListItem, type GuildChatMessage, type GuildChatViewer, type NotifyGuild, type NotifyItem } from '../api';
import { SidePage, CatTabs, SELECTED_RING } from '../components/SidePage';
import { PanelShell, Row } from './cityMapPanels';
import { LoadError } from '../components/LoadError';
import { onServerEvent } from '../serverEvents';
import { useAsk } from '../hooks/useAsk';

// Чаты гильдий (2.5): справа гильдии своих аккаунтов, слева переписка, сверху закреплена последняя
// рассылка гильдии, остальные — по кнопке «Все рассылки». Всё читается из БД (routes/guildChat.js и
// routes/notifications.js), новые сообщения приходят событием 'guild-chat'; игру зовут «Обновить»,
// «Показать раньше», отправка, прочтение и модерация.

const SEL_KEY = 'tc-chat-guild';
const MUTE_LABEL: Record<string, string> = { '1h': '1 час', '1d': '1 день', '7d': '7 дней', '30d': '30 дней' };
const initials = (n: string) => (n.replace(/[^A-Za-zА-Яа-яЁё0-9]/g, '').slice(0, 2) || '?').toUpperCase();
const COLORS = ['#8957e5', '#1f6feb', '#2da44e', '#bf8700', '#cf222e', '#0a7d8c'];
const hue = (n: string) => COLORS[[...n].reduce((s, c) => s + c.charCodeAt(0), 0) % COLORS.length];
const isLeader = (r?: string | null) => r === 'Leader';
const isOfficer = (r?: string | null) => /officer/i.test(r || '');
// права из клиента игры: лидер модерирует всех, кроме Superuser; офицер — только рядовых
const canModerateRole = (me?: string | null, target?: string | null) =>
  isLeader(me) ? target !== 'Superuser' : isOfficer(me) ? (!target || target === 'Member') : false;
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
function dayLabel(iso: string) {
  const d = new Date(iso), now = new Date();
  const k = (x: Date) => x.toDateString();
  if (k(d) === k(now)) return 'Сегодня';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (k(d) === k(y)) return 'Вчера';
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
function shortTime(iso?: string | null) {
  if (!iso) return '';
  const l = dayLabel(iso);
  return l === 'Сегодня' ? hhmm(iso) : l === 'Вчера' ? 'вчера' : new Date(iso).toLocaleDateString('ru', { day: 'numeric', month: 'short' });
}
const muteLeft = (m?: { until?: string | null; ends_in_seconds?: number | null } | null) => {
  if (!m) return null;
  const until = m.until ? new Date(m.until) : m.ends_in_seconds != null ? new Date(Date.now() + m.ends_in_seconds * 1000) : null;
  return until && until.getTime() > Date.now() ? until : null;
};

function GuildAva({ n, size = 36 }: { n: string; size?: number }) {
  return <Box sx={{ width: size, height: size, borderRadius: size > 36 ? '10px' : '8px', bg: hue(n), color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 'bold', fontSize: size > 36 ? 1 : 0, flexShrink: 0 }}>{initials(n)}</Box>;
}
const RoleL = ({ r }: { r?: string | null }) => isLeader(r) ? <Label size="small" variant="attention">Лидер</Label> : isOfficer(r) ? <Label size="small" variant="accent">Офицер</Label> : null;
function Day({ d }: { d: string }) {
  return <Box sx={{ display: 'flex', justifyContent: 'center', my: 2 }}><Text sx={{ fontSize: 0, color: 'fg.muted', bg: 'canvas.subtle', px: 3, py: '2px', borderRadius: '10px' }}>{d}</Text></Box>;
}

type Mod = { accountId: number; role?: string | null };
function Bubble({ m, mine, mod, onDelete, onMute }: { m: GuildChatMessage; mine: string | null; mod: Mod | null; onDelete: () => void; onMute: (d: '1h' | '1d' | '7d' | '30d') => void }) {
  const name = m.name || mine || `#${m.user_id}`;
  const canMod = !!mod && canModerateRole(mod.role, m.role);
  return (
    <Box sx={{ display: 'flex', gap: 2, flexDirection: mine ? 'row-reverse' : 'row', alignItems: 'flex-end', mb: 2, '&:hover .mact': { opacity: 1 } }}>
      <Box sx={{ maxWidth: '70%', px: 3, py: 2, borderRadius: '16px', borderBottomLeftRadius: mine ? '16px' : '4px', borderBottomRightRadius: mine ? '4px' : '16px', bg: mine ? 'accent.emphasis' : 'canvas.subtle', color: mine ? 'fg.onEmphasis' : 'fg.default' }}>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: '2px' }}>
          <Text sx={{ fontSize: 0, fontWeight: 'bold', color: mine ? 'rgba(255,255,255,.85)' : hue(name) }}>{mine || name}</Text><RoleL r={m.role} />
        </Box>
        <Text sx={{ fontSize: 1, display: 'block', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.text}</Text>
        <Text sx={{ fontSize: '10px', opacity: 0.7, display: 'block', textAlign: 'right' }}>{hhmm(m.created_at)}</Text>
      </Box>
      {canMod && !mine && (
        <Box className="mact" sx={{ opacity: 0, transition: 'opacity .15s' }}>
          <ActionMenu>
            <ActionMenu.Anchor><IconButton size="small" variant="invisible" icon={KebabHorizontalIcon} aria-label="Действия" /></ActionMenu.Anchor>
            <ActionMenu.Overlay>
              <ActionList>
                <ActionList.Item variant="danger" onSelect={onDelete}><ActionList.LeadingVisual><TrashIcon /></ActionList.LeadingVisual>Удалить сообщение</ActionList.Item>
                <ActionList.Divider />
                <ActionList.Group>
                  <ActionList.GroupHeading>Запретить писать</ActionList.GroupHeading>
                  {(['1h', '1d', '7d', '30d'] as const).map(d => <ActionList.Item key={d} onSelect={() => onMute(d)}><ActionList.LeadingVisual><MuteIcon /></ActionList.LeadingVisual>на {MUTE_LABEL[d]}</ActionList.Item>)}
                </ActionList.Group>
              </ActionList>
            </ActionMenu.Overlay>
          </ActionMenu>
        </Box>
      )}
    </Box>
  );
}

export function GuildChat() {
  const [list, setList] = useState<GuildChatListItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(() => { try { const v = localStorage.getItem(SEL_KEY); return v ? Number(v) : null; } catch { return null; } });
  const [feed, setFeed] = useState<GuildChatFeed | null>(null);
  const [notify, setNotify] = useState<{ guilds: NotifyGuild[]; items: NotifyItem[] } | null>(null);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState(0);
  const [mode, setMode] = useState(0);
  const [from, setFrom] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ msg: string; ok: boolean } | null>(null);
  const [allAnn, setAllAnn] = useState(false);
  const ask = useAsk();
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const loadList = useCallback(async () => {
    const r = await api.guildChats();
    if (!r.ok) { setErr(r.error ?? 'Ошибка загрузки'); return; }
    setErr(null); setList(r.guilds);
  }, []);
  const loadNotify = useCallback(async () => { const r = await api.notifications(); if (r.ok) setNotify({ guilds: r.guilds, items: r.items }); }, []);
  const loadFeed = useCallback(async (gid: number) => {
    const r = await api.guildChat(gid);
    if (r.ok) setFeed(r); else setNote({ msg: r.error ?? 'Ошибка загрузки', ok: false });
  }, []);
  useEffect(() => { loadList(); loadNotify(); }, [loadList, loadNotify]);
  // выбранная гильдия: сохранённая, иначе первая
  const cur = useMemo(() => list?.find(g => g.guild_id === sel) ?? list?.[0] ?? null, [list, sel]);
  useEffect(() => {
    if (!cur) return;
    try { localStorage.setItem(SEL_KEY, String(cur.guild_id)); } catch { /* приватный режим */ }
    setFeed(null); setNote(null); setAllAnn(false); atBottom.current = true;
    setFrom(cur.accounts[0]?.id ?? null);
    loadFeed(cur.guild_id);
  }, [cur?.guild_id, loadFeed]); // eslint-disable-line react-hooks/exhaustive-deps

  // живые сообщения из потока событий бота
  useEffect(() => onServerEvent<{ guild_id: number; type: string; message?: GuildChatMessage; message_id?: number }>('guild-chat', ev => {
    if (ev.type === 'message' && ev.message) {
      setFeed(f => f && f.guild.guild_id === ev.guild_id && !f.messages.some(m => m.id === ev.message!.id) ? { ...f, messages: [...f.messages, ev.message!] } : f);
      setList(l => l?.map(g => g.guild_id === ev.guild_id ? { ...g, last: ev.message!, unread: g.guild_id === cur?.guild_id ? g.unread : g.unread + 1 } : g) ?? l);
    } else if (ev.type === 'deleted') {
      setFeed(f => f && f.guild.guild_id === ev.guild_id ? { ...f, messages: f.messages.filter(m => m.id !== Number(ev.message_id)) } : f);
    } else if (ev.type === 'mute' && cur?.guild_id === ev.guild_id) {
      loadFeed(ev.guild_id);
    }
  }), [cur?.guild_id, loadFeed]);

  // прокрутка к низу, если пользователь и так был внизу
  useEffect(() => { const el = scrollRef.current; if (el && atBottom.current) el.scrollTop = el.scrollHeight; }, [feed?.messages.length]);
  // прочитано: открытая гильдия с новыми сообщениями
  const lastId = feed?.messages[feed.messages.length - 1]?.id ?? 0;
  useEffect(() => {
    if (!feed || !lastId || lastId <= feed.last_read || document.hidden) return;
    const gid = feed.guild.guild_id;
    const t = setTimeout(async () => {
      const r = await api.guildChatRead(gid);
      if (r.ok) { setFeed(f => f && f.guild.guild_id === gid ? { ...f, last_read: lastId } : f); setList(l => l?.map(g => g.guild_id === gid ? { ...g, unread: 0 } : g) ?? l); }
    }, 1500);
    return () => clearTimeout(t);
  }, [lastId, feed?.last_read, feed?.guild.guild_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const viewers = feed?.viewers ?? {};
  const mineById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of feed?.guild.accounts ?? []) { const v = viewers[a.id]; if (v?.user_id != null) m.set(String(v.user_id), a.name); }
    return m;
  }, [feed]); // eslint-disable-line react-hooks/exhaustive-deps
  // модератор: аккаунт с can_moderate, лидер раньше офицера
  const mod: Mod | null = useMemo(() => {
    const c = (feed?.guild.accounts ?? []).map(a => ({ a, v: viewers[a.id] as GuildChatViewer | undefined })).filter(x => x.v?.can_moderate);
    c.sort((x, y) => (isLeader(y.v?.role) ? 1 : 0) - (isLeader(x.v?.role) ? 1 : 0));
    return c[0] ? { accountId: c[0].a.id, role: c[0].v?.role ?? c[0].a.role } : null;
  }, [feed]); // eslint-disable-line react-hooks/exhaustive-deps
  const mutes = mod ? (viewers[mod.accountId]?.mutes ?? []).filter(x => muteLeft(x.mute)) : [];
  const ng = notify?.guilds.find(g => g.guild_id === cur?.guild_id);
  const anns = (notify?.items ?? []).filter(i => i.src === 'guild' && i.guild_id === cur?.guild_id);
  const fromMute = from != null ? muteLeft(viewers[from]?.mute) : null;

  const refresh = async () => {
    if (!cur) return;
    setBusy('refresh'); setNote(null);
    const [r] = await Promise.all([api.guildChatRefresh(cur.guild_id), api.notificationsRefresh(cur.guild_id)]);
    setBusy(null);
    await Promise.all([loadFeed(cur.guild_id), loadList(), loadNotify()]);
    if (!r.ok || r.errors?.length) setNote({ msg: r.error ?? `Не у всех аккаунтов получилось: ${r.errors!.join('; ')}`, ok: false });
  };
  const older = async () => {
    if (!cur) return;
    const el = scrollRef.current, h = el?.scrollHeight ?? 0;
    atBottom.current = false; setBusy('older');
    const r = await api.guildChatOlder(cur.guild_id);
    setBusy(null);
    if (!r.ok) { setNote({ msg: r.error ?? 'Ошибка', ok: false }); return; }
    await loadFeed(cur.guild_id);
    requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - h; });
  };
  const send = async () => {
    if (!cur || from == null) return;
    if (mode === 1) {
      const sender = ng?.sender_id;
      if (!sender) return;
      if (!await ask('Разослать уведомление?', `Рассылка «${title.trim()}» придёт всем участникам гильдии «${cur.title}».`, { ok: 'Разослать' })) return;
      setBusy('send');
      const r = await api.extraAction('notification-send', { account_id: sender, title: title.trim(), text: text.trim() });
      setBusy(null);
      if (!r.ok) { setNote({ msg: r.error ?? 'Ошибка', ok: false }); return; }
      setTitle(''); setText(''); setNote({ msg: 'Рассылка отправлена', ok: true });
      await api.notificationsRefresh(cur.guild_id); loadNotify();
      return;
    }
    setBusy('send'); atBottom.current = true;
    const r = await api.guildChatSend(cur.guild_id, from, text.trim());
    setBusy(null);
    if (!r.ok) { setNote({ msg: r.error ?? 'Ошибка', ok: false }); return; }
    setText(''); setNote(null);
    if (r.message) setFeed(f => f && !f.messages.some(m => m.id === r.message!.id) ? { ...f, messages: [...f.messages, r.message!] } : f);
    else loadFeed(cur.guild_id);
  };
  const del = async (m: GuildChatMessage) => {
    if (!cur || !mod) return;
    if (!await ask('Удалить сообщение?', `«${m.text.slice(0, 120)}» пропадёт из чата у всех участников.`, { ok: 'Удалить', danger: true })) return;
    const r = await api.guildChatDelete(cur.guild_id, mod.accountId, m.id);
    if (!r.ok) setNote({ msg: r.error ?? 'Ошибка', ok: false }); else loadFeed(cur.guild_id);
  };
  const mute = async (m: GuildChatMessage, d: '1h' | '1d' | '7d' | '30d') => {
    if (!cur || !mod) return;
    if (!await ask('Запретить писать?', `${m.name || `#${m.user_id}`} не сможет писать в чат ${MUTE_LABEL[d]}.`, { ok: 'Запретить', danger: true })) return;
    const r = await api.guildChatMute(cur.guild_id, mod.accountId, m.user_id, d);
    setNote(r.ok ? { msg: 'Запрет установлен', ok: true } : { msg: r.error ?? 'Ошибка', ok: false });
    loadFeed(cur.guild_id);
  };
  const unmute = async (userId: number, name?: string | null) => {
    if (!cur || !mod) return;
    const r = await api.guildChatUnmute(cur.guild_id, mod.accountId, userId);
    setNote(r.ok ? { msg: `Запрет снят${name ? `: ${name}` : ''}`, ok: true } : { msg: r.error ?? 'Ошибка', ok: false });
    loadFeed(cur.guild_id);
  };
  const markRead = async () => {
    if (!cur) return;
    await Promise.all([api.guildChatRead(cur.guild_id), api.notificationsRead(String(cur.guild_id))]);
    loadList(); loadNotify(); loadFeed(cur.guild_id);
  };

  if (err) return <Box sx={{ p: 3 }}><LoadError error={err} onRetry={loadList} /></Box>;

  const shown = (list ?? []).filter(g => (!q || g.title.toLowerCase().includes(q.toLowerCase())) && (tab === 0 || g.unread > 0));
  const side = (
    <PanelShell mode="view" title="Чаты" hint="Чат и рассылки гильдий, где состоят ваши аккаунты. Новые сообщения приходят сами, «Обновить с игры» — в меню «…» над перепиской.">
      <TextInput placeholder="Поиск" block value={q} onChange={e => setQ(e.target.value)} />
      <CatTabs tabs={['Все', 'Непрочитанные']} value={tab} onChange={setTab} />
      {!list ? <Text sx={{ color: 'fg.muted', fontSize: 1 }}>Загрузка…</Text>
        : !shown.length ? <Text sx={{ color: 'fg.muted', fontSize: 1 }}>{list.length ? 'Ничего не найдено' : 'Аккаунты не состоят в гильдиях'}</Text>
        : shown.map(g => {
          const lastName = g.last ? (g.last.name || '') : '';
          return (
            <Row key={g.guild_id} onClick={() => setSel(g.guild_id)} sx={g.guild_id === cur?.guild_id ? SELECTED_RING : undefined}
              lead={<GuildAva n={g.title} />} title={g.title}
              sub={g.last ? `${lastName ? lastName + ': ' : ''}${g.last.text}` : g.updated_at ? 'Сообщений нет' : 'Переписка ещё не загружена'}
              trail={<Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' }}><Text sx={{ fontSize: 0, color: 'fg.muted' }}>{shortTime(g.last?.created_at)}</Text>{g.unread > 0 && <CounterLabel scheme="primary">{g.unread}</CounterLabel>}</Box>} />
          );
        })}
    </PanelShell>
  );

  let main;
  if (!cur) main = <Text sx={{ color: 'fg.muted' }}>{list ? 'Нет гильдий с вашими аккаунтами.' : 'Загрузка…'}</Text>;
  else {
    const msgs = feed?.messages ?? [];
    const pinned = anns[0];
    const accName = (id: number | null) => cur.accounts.find(a => a.id === id)?.name ?? '—';
    const canSendAnn = !!ng?.can_send;
    const sendDisabled = !!busy || !text.trim() || (mode === 0 ? (from == null || !!fromMute || text.trim().length > 500) : (!title.trim() || text.trim().length > 200 || !canSendAnn));
    main = (
      <Box sx={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - var(--header-h) - 32px)', '@media (max-width: 768px)': { height: 'calc(55dvh - 60px)' } }}>

        <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', mb: 2, flexShrink: 0 }}>
        {pinned && (
            <Box sx={{ flex: 1, minWidth: 0, borderRadius: '12px', bg: 'done.subtle', border: '1px solid', borderColor: 'done.muted', overflow: 'hidden', flexShrink: 0 }}>
              <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', p: 2 }}>
                <PinIcon size={16} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Text sx={{ fontWeight: 'bold', fontSize: 1 }}>{pinned.title}</Text>
                  <Text sx={{ fontSize: 1, color: 'fg.muted', display: 'block', whiteSpace: allAnn ? 'pre-wrap' : 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pinned.text}</Text>
                </Box>
                <Button size="small" variant="invisible" trailingVisual={allAnn ? ChevronUpIcon : ChevronDownIcon} onClick={() => setAllAnn(v => !v)}>Все рассылки · {anns.length}</Button>
              </Box>
              {allAnn && (
                <Box sx={{ maxHeight: 260, overflowY: 'auto', borderTop: '1px solid', borderColor: 'done.muted' }}>
                  {anns.map(a => (
                    <Box key={a.id} sx={{ px: 3, py: 2, borderBottom: '1px solid', borderColor: 'done.muted', '&:last-child': { borderBottom: 0 } }}>
                      <Box sx={{ display: 'flex', gap: 2 }}><Text sx={{ fontWeight: 'semibold', fontSize: 1, flex: 1 }}>{a.title}</Text><Text sx={{ fontSize: 0, color: 'fg.muted' }}>{a.at ? `${dayLabel(a.at)}, ${hhmm(a.at)}` : ''}</Text></Box>
                      <Text sx={{ fontSize: 1, color: 'fg.muted', display: 'block', whiteSpace: 'pre-wrap' }}>{a.text}</Text>
                      {a.author && <Text sx={{ fontSize: 0, color: 'fg.muted' }}>рассылка · {a.author}</Text>}
                    </Box>
                  ))}
                </Box>
              )}
            </Box>
          )}
          {!pinned && <Box sx={{ flex: 1 }} />}
            <ActionMenu>
              <ActionMenu.Anchor><IconButton icon={KebabHorizontalIcon} aria-label="Ещё" /></ActionMenu.Anchor>
              <ActionMenu.Overlay width="medium">
                <ActionList>
                  <ActionList.Item disabled={!!busy} onSelect={refresh}><ActionList.LeadingVisual><SyncIcon /></ActionList.LeadingVisual>Обновить с игры</ActionList.Item>
                  <ActionList.Item onSelect={markRead}><ActionList.LeadingVisual><CheckIcon /></ActionList.LeadingVisual>Отметить прочитанным</ActionList.Item>
                  {mod && <>
                    <ActionList.Divider />
                    <ActionList.Group>
                      <ActionList.GroupHeading>Запреты писать{mutes.length ? ` · ${mutes.length}` : ''}</ActionList.GroupHeading>
                      {!mutes.length ? <ActionList.Item disabled>Запретов нет</ActionList.Item>
                        : mutes.map(x => (
                          <ActionList.Item key={x.user_id} onSelect={() => unmute(x.user_id, x.name)}>
                            <ActionList.LeadingVisual><UnmuteIcon /></ActionList.LeadingVisual>
                            Снять: {x.name || `#${x.user_id}`}
                            <ActionList.Description variant="block">до {muteLeft(x.mute)!.toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</ActionList.Description>
                          </ActionList.Item>
                        ))}
                    </ActionList.Group>
                  </>}
                </ActionList>
              </ActionMenu.Overlay>
            </ActionMenu>
        </Box>
        {note && <Flash variant={note.ok ? 'success' : 'danger'} sx={{ mb: 2, flexShrink: 0 }}>{note.msg}</Flash>}

        <Box ref={scrollRef} onScroll={() => { const el = scrollRef.current; if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}
          sx={{ flex: 1, minHeight: 0, overflowY: 'auto', pr: 1 }}>
          {!feed ? <Text sx={{ color: 'fg.muted' }}>Загрузка…</Text>
            : !feed.updated_at ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, py: 6 }}>
                <CommentDiscussionIcon size={32} />
                <Text sx={{ color: 'fg.muted' }}>Переписка этой гильдии ещё не загружена</Text>
                <Button variant="primary" leadingVisual={SyncIcon} loading={busy === 'refresh'} disabled={!!busy} onClick={refresh}>Загрузить с игры</Button>
              </Box>
            ) : <>
              {feed.has_more && <Box sx={{ display: 'flex', justifyContent: 'center', my: 2 }}><Button size="small" variant="invisible" loading={busy === 'older'} disabled={!!busy} onClick={older}>Показать раньше</Button></Box>}
              {!msgs.length && <Text sx={{ display: 'block', textAlign: 'center', color: 'fg.muted', my: 4 }}>Сообщений пока нет</Text>}
              {msgs.map((m, i) => {
                const d = dayLabel(m.created_at);
                const showDay = i === 0 || dayLabel(msgs[i - 1].created_at) !== d;
                return (
                  <Box key={m.id}>
                    {showDay && <Day d={d} />}
                    <Bubble m={m} mine={mineById.get(String(m.user_id)) ?? null} mod={mod} onDelete={() => del(m)} onMute={d2 => mute(m, d2)} />
                  </Box>
                );
              })}
            </>}
        </Box>

        <Box sx={{ borderTop: '1px solid', borderColor: 'border.default', pt: 2, display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
            <SegmentedControl aria-label="Тип" size="small">
              <SegmentedControl.Button selected={mode === 0} leadingIcon={CommentDiscussionIcon} onClick={() => setMode(0)}>Сообщение</SegmentedControl.Button>
              <SegmentedControl.Button selected={mode === 1} leadingIcon={MegaphoneIcon} onClick={() => setMode(1)}>Рассылка</SegmentedControl.Button>
            </SegmentedControl>
            <Box sx={{ flex: 1 }} />
            {mode === 0 ? (
              <ActionMenu>
                <ActionMenu.Button size="small" leadingVisual={PersonIcon}>от {accName(from)}</ActionMenu.Button>
                <ActionMenu.Overlay>
                  <ActionList selectionVariant="single">
                    {cur.accounts.map(a => <ActionList.Item key={a.id} selected={a.id === from} onSelect={() => setFrom(a.id)}>{a.name}{muteLeft(viewers[a.id]?.mute) && <ActionList.TrailingVisual><MuteIcon /></ActionList.TrailingVisual>}</ActionList.Item>)}
                  </ActionList>
                </ActionMenu.Overlay>
              </ActionMenu>
            ) : <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{canSendAnn ? `от ${accName(ng?.sender_id ?? null)}` : 'Рассылать может только лидер или офицер'}</Text>}
          </Box>
          {mode === 0 && fromMute && <Text sx={{ fontSize: 0, color: 'danger.fg' }}>{accName(from)} не может писать до {fromMute.toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</Text>}
          {mode === 1 && <TextInput block placeholder="Заголовок рассылки" value={title} onChange={e => setTitle(e.target.value)} disabled={!canSendAnn} />}
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-end' }}>
            <Textarea block rows={mode === 1 ? 2 : 1} resize="vertical" value={text} onChange={e => setText(e.target.value)} disabled={mode === 1 && !canSendAnn}
              placeholder={mode === 1 ? 'Текст рассылки, до 200 символов — придёт всем участникам уведомлением' : 'Написать в чат гильдии…'} sx={{ flex: 1 }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && mode === 0) { e.preventDefault(); if (!sendDisabled) send(); } }} />
            <Button variant="primary" leadingVisual={mode === 1 ? MegaphoneIcon : PaperAirplaneIcon} loading={busy === 'send'} disabled={sendDisabled} onClick={send}>{mode === 1 ? 'Разослать' : 'Отправить'}</Button>
          </Box>
        </Box>
      </Box>
    );
  }
  return <SidePage main={main} side={side} />;
}
