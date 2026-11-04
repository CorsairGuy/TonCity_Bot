import { useEffect, useState, type ElementType } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Button, CounterLabel, Flash, IconButton, Label, Text, TextInput, Textarea } from '@primer/react';
import {
  SyncIcon, CheckIcon, ClockIcon, XIcon, TrashIcon, InboxIcon, MegaphoneIcon, KeyIcon, PackageIcon,
  ArrowUpIcon, ToolsIcon, PaperAirplaneIcon,
} from '@primer/octicons-react';
import { api, type NotifyGuild, type NotifyItem, type NotifySrc } from '../api';
import { PageHeader } from '../components/PageHeader';
import { LoadError } from '../components/LoadError';
import { SidePage, SELECTED_RING } from '../components/SidePage';
import { PanelShell, Row, Caption, SWAP } from './cityMapPanels';
import { useFlash } from '../hooks/useFlash';
import { useAsk } from '../hooks/useAsk';

// Уведомления: справа источники (все, гильдии из игры, события бота) со счётчиками непрочитанного,
// слева — плитки «Ждут вашего действия» и лента по дням. Лента читается из БД (routes/notifications.js),
// игру зовут «Обновить с игры», «Отметить прочитанными», удаление и отправка рассылки гильдии.

const KIND: Record<string, { icon: ElementType; color: string }> = {
  guild: { icon: MegaphoneIcon, color: 'done.emphasis' },
  alert: { icon: KeyIcon, color: 'danger.emphasis' },
  success: { icon: ArrowUpIcon, color: 'success.emphasis' },
  attention: { icon: ToolsIcon, color: 'attention.emphasis' },
  info: { icon: PackageIcon, color: 'accent.emphasis' },
};
const BOT_SRC: { k: NotifySrc; n: string; kind: string }[] = [
  { k: 'accounts', n: 'Аккаунты', kind: 'alert' },
  { k: 'update', n: 'Обновления бота', kind: 'success' },
  { k: 'maintenance', n: 'Техработы игры', kind: 'attention' },
  { k: 'market', n: 'Продажи на рынке', kind: 'info' },
];

function NIcon({ kind, size = 36, square }: { kind: string; size?: number; square?: boolean }) {
  const k = KIND[kind] ?? KIND.info; const I = k.icon;
  return <Box sx={{ width: size, height: size, borderRadius: square ? '8px' : '50%', bg: k.color, color: 'fg.onEmphasis', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><I size={size * 0.45} /></Box>;
}
const ago = (iso: string | null) => {
  if (!iso) return 'сейчас';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  if (m < 24 * 60) return new Date(iso).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  return new Date(iso).toLocaleDateString('ru', { day: 'numeric', month: 'short' });
};
const dayOf = (iso: string | null) => {
  const d = iso ? new Date(iso) : new Date();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  return diff <= 0 ? 'Сегодня' : diff === 1 ? 'Вчера' : d.toLocaleDateString('ru', { day: 'numeric', month: 'long' });
};
const who = (n: NotifyItem) => n.guild ?? n.account ?? 'бот';

function GuildCompose({ g, onSent, onFlash }: { g: NotifyGuild; onSent: () => void; onFlash: (m: string, ok: boolean) => void }) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const sender = g.accounts.find(a => a.id === g.sender_id);
  const send = async () => {
    if (!sender) return;
    setBusy(true);
    const r = await api.extraAction('notification-send', { account_id: sender.id, title: title.trim(), text: text.trim() });
    setBusy(false);
    if (r.ok) { setTitle(''); setText(''); onFlash('Рассылка отправлена', true); onSent(); } else onFlash(r.error ?? 'Не удалось отправить', false);
  };
  return (
    <Box sx={{ mb: 3, p: 2, borderRadius: '12px', bg: 'canvas.subtle', display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 960 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <MegaphoneIcon />
        <Text sx={{ fontWeight: 'semibold', flex: 1 }}>Рассылка участникам</Text>
        <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{sender ? `от ${sender.name}` : 'отправлять может лидер или офицер (по последней проверке)'}</Text>
      </Box>
      <TextInput block placeholder="Заголовок" value={title} onChange={e => setTitle(e.target.value)} disabled={!sender} />
      <Textarea block placeholder="Текст (до 200 символов)" rows={2} value={text} onChange={e => setText(e.target.value.slice(0, 200))} disabled={!sender} />
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{text.length} / 200</Text>
        <Button variant="primary" leadingVisual={PaperAirplaneIcon} loading={busy} disabled={!sender || !title.trim() || !text.trim() || busy} onClick={send}>Отправить</Button>
      </Box>
    </Box>
  );
}

export function Notifications() {
  const navigate = useNavigate();
  const ask = useAsk();
  const [guilds, setGuilds] = useState<NotifyGuild[] | null>(null);
  const [items, setItems] = useState<NotifyItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState('all');
  const [q, setQ] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const { flash, showFlash } = useFlash();

  const load = async () => {
    const r = await api.notifications();
    if (!r.ok) { setErr(r.error ?? 'Ошибка загрузки'); return; }
    setErr(null); setGuilds(r.guilds); setItems(r.items);
  };
  useEffect(() => { load(); }, []);

  const refresh = async (guildId?: number) => {
    setRefreshing(true);
    const r = await api.notificationsRefresh(guildId);
    setRefreshing(false);
    await load();
    showFlash(!r.ok ? (r.error ?? 'Ошибка обновления') : r.errors?.length ? `Обновлено, но с ошибками: ${r.errors.join('; ')}` : 'Обновлено с сервера игры', r.ok && !r.errors?.length);
  };

  if (err) return <Box sx={{ p: 3 }}><LoadError error={err} onRetry={load} /></Box>;
  const gs = guilds ?? [];
  const inSrc = (n: NotifyItem, s: string) => s === 'all' || (s.startsWith('g') ? n.src === 'guild' && `g${n.guild_id}` === s : n.src === s);
  const msgs = items.filter(n => inSrc(n, sel));
  const act = msgs.filter(n => n.act);
  const feed = msgs.filter(n => !n.act);
  const unread = msgs.filter(n => n.unread).length;
  const days = [...new Set(feed.map(n => dayOf(n.at)))];
  const g0 = sel.startsWith('g') ? gs.find(g => `g${g.guild_id}` === sel) : undefined;
  const botSrc = BOT_SRC.find(b => b.k === sel);

  const markRead = async () => {
    const source = sel === 'all' ? 'all' : g0 ? String(g0.guild_id) : 'bot';
    const r = await api.notificationsRead(source);
    await load();
    if (!r.ok || r.errors?.length) showFlash(r.error ?? `Не все отмечены: ${r.errors?.join('; ')}`, false);
  };
  const remove = async (n: NotifyItem) => {
    if (n.src === 'guild') {
      const g = gs.find(x => x.guild_id === n.guild_id);
      const accId = g?.sender_id ?? g?.accounts[0]?.id;
      if (!g || accId == null) return;
      if (!await ask('Удалить рассылку?', `«${n.title}» удалится в игре для всей гильдии «${g.title}».`, { ok: 'Удалить', danger: true })) return;
      const r = await api.extraAction('notification-delete', { account_id: accId, notification_id: n.notification_id });
      if (!r.ok) { showFlash(r.error ?? 'Не удалось удалить', false); return; }
      await refresh(g.guild_id);
    } else {
      setItems(xs => xs.filter(x => x.id !== n.id));
      const r = await api.notificationDismiss(n.id);
      if (!r.ok) { showFlash(r.error ?? 'Ошибка', false); load(); }
    }
  };
  const snooze = async (n: NotifyItem) => {
    setItems(xs => xs.filter(x => x.id !== n.id));
    const r = await api.notificationSnooze(n.id);
    if (r.ok) showFlash('Напомню через 4 часа', true); else { showFlash(r.error ?? 'Ошибка', false); load(); }
  };

  const srcRow = (key: string, title: string, lead: React.ReactNode, list: NotifyItem[]) => {
    const c = list.filter(n => n.unread).length;
    return <Row key={key} onClick={() => setSel(key)} sx={key === sel ? SELECTED_RING : undefined} lead={lead} title={title}
      sub={list[0]?.title ?? 'нет событий'} trail={c > 0 ? <CounterLabel scheme="primary">{c}</CounterLabel> : undefined} />;
  };
  const match = (s: string) => s.toLowerCase().includes(q.toLowerCase());
  const side = (
    <PanelShell mode="view" title="Источники" busy={guilds == null}
      hint="Рассылки гильдий приходят из игры (обновляются кнопкой внизу), остальное — события бота. Счётчик — непрочитанные."
      footer={<Button block leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing || !gs.length} onClick={() => refresh()}>Обновить с игры</Button>}>
      <TextInput placeholder="Поиск" value={q} onChange={e => setQ(e.target.value)} block />
      {srcRow('all', 'Все', <Box sx={{ width: 36, height: 36, borderRadius: '8px', bg: 'canvas.default', display: 'grid', placeItems: 'center' }}><InboxIcon size={16} /></Box>, items)}
      {gs.some(g => match(g.title)) && <Caption>Гильдии · из игры</Caption>}
      {gs.filter(g => match(g.title)).map(g => srcRow(`g${g.guild_id}`, g.title, <NIcon kind="guild" square />, items.filter(n => n.src === 'guild' && n.guild_id === g.guild_id)))}
      {BOT_SRC.some(b => match(b.n)) && <Caption>События бота</Caption>}
      {BOT_SRC.filter(b => match(b.n)).map(b => srcRow(b.k, b.n, <NIcon kind={b.kind} square />, items.filter(n => n.src === b.k)))}
    </PanelShell>
  );

  const main = (
    <>
      <PageHeader title={g0?.title ?? botSrc?.n ?? 'Уведомления'}
        sub={g0 ? `Рассылка гильдии из игры${g0.updated_at ? ` · проверено ${ago(g0.updated_at)}` : ' · ещё не загружалась'}` : botSrc ? 'События бота' : 'Все источники, новые сверху'} />
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      {g0 && <GuildCompose key={g0.guild_id} g={g0} onSent={() => refresh(g0.guild_id)} onFlash={showFlash} />}
      <Box sx={{ maxWidth: 960 }}>
        {act.length > 0 && (
          <Box sx={{ mb: 4 }}>
            <Caption right={act.length}>Ждут вашего действия</Caption>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 420px), 1fr))', gap: 2, mt: 2 }}>
              {act.map(n => {
                const danger = n.kind === 'alert';
                return (
                  <Box key={n.id} sx={{ position: 'relative', overflow: 'hidden', borderRadius: '12px', p: 2, pl: 3, bg: 'canvas.subtle', display: 'flex', gap: 2, alignItems: 'center' }}>
                    <Box sx={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '4px', bg: (KIND[n.kind] ?? KIND.info).color }} />
                    <NIcon kind={n.kind} square />
                    <Box sx={{ flex: 1, minWidth: 0 }} title={n.text}>
                      <Text sx={{ fontWeight: 'semibold', fontSize: 1, display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.title}</Text>
                      <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{who(n)} · {n.text}</Text>
                    </Box>
                    <Button size="small" variant={danger ? 'danger' : 'primary'} onClick={() => navigate(n.act!.href)}>{n.act!.label}</Button>
                    <IconButton size="small" variant="invisible" icon={ClockIcon} aria-label="Напомнить через 4 часа" onClick={() => snooze(n)} />
                  </Box>
                );
              })}
            </Box>
          </Box>
        )}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
          <Text sx={{ fontWeight: 'semibold', flex: 1 }}>Лента</Text>
          {unread > 0 && <Button size="small" variant="invisible" leadingVisual={CheckIcon} onClick={markRead}>Отметить {unread} прочитанными</Button>}
        </Box>
        {days.map(d => {
          const day = feed.filter(n => dayOf(n.at) === d);
          return (
            <Box key={d} sx={{ mb: 3 }}>
              <Caption right={day.length}>{d}</Caption>
              <Box sx={{ mt: 2, position: 'relative' }}>
                <Box sx={{ position: 'absolute', left: '17px', top: '18px', bottom: '18px', width: '2px', bg: 'border.muted' }} />
                {day.map(n => (
                  <Box key={n.id} sx={{ position: 'relative', display: 'flex', gap: 3, alignItems: 'flex-start', py: 2, pr: 2, borderRadius: '12px', ':hover': { bg: 'canvas.subtle' }, ...SWAP }}>
                    <Box sx={{ position: 'relative', zIndex: 1, boxShadow: '0 0 0 4px var(--bgColor-default, #0d1117)', borderRadius: '50%' }}><NIcon kind={n.kind} /></Box>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
                        <Text sx={{ fontWeight: n.unread ? 'bold' : 'semibold', fontSize: 1 }}>{n.title}</Text>
                        {n.unread && <Box sx={{ width: 6, height: 6, borderRadius: '50%', bg: 'accent.emphasis' }} />}
                        <Label size="small" variant={n.src === 'guild' ? 'done' : 'secondary'}>{who(n)}</Label>
                        {n.author && <Text sx={{ fontSize: 0, color: 'fg.muted' }}>от {n.author}</Text>}
                      </Box>
                      <Text sx={{ fontSize: 1, color: 'fg.muted', wordBreak: 'break-word' }}>{n.text}</Text>
                    </Box>
                    <Text className="sw-v" sx={{ fontSize: 0, color: 'fg.muted', whiteSpace: 'nowrap', pt: 1 }}>{ago(n.at)}</Text>
                    <Box as="span" className="sw-x"><IconButton size="small" variant="invisible" icon={n.src === 'guild' ? TrashIcon : XIcon}
                      aria-label={n.src === 'guild' ? 'Удалить рассылку' : 'Убрать из ленты'} onClick={() => remove(n)} /></Box>
                  </Box>
                ))}
              </Box>
            </Box>
          );
        })}
        {!msgs.length && guilds != null && (
          <Box sx={{ p: 4, textAlign: 'center', color: 'fg.muted' }}>
            <InboxIcon size={24} />
            <Text sx={{ display: 'block' }}>{g0 && !g0.updated_at ? 'Рассылки этой гильдии ещё не загружались — нажмите «Обновить с игры»' : 'Пусто'}</Text>
          </Box>
        )}
      </Box>
    </>
  );
  return <SidePage main={main} side={side} />;
}
