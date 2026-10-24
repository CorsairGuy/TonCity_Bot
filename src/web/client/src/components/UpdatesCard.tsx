import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Box, Text, Link, Label, Button, IconButton, Select, Radio, FormControl, ToggleSwitch,
  ConfirmationDialog, Spinner, Flash,
} from '@primer/react';
import {
  SyncIcon, GitBranchIcon, TagIcon, PinIcon, HistoryIcon, ChevronDownIcon, ChevronRightIcon, LinkExternalIcon,
} from '@primer/octicons-react';
import { api, VersionInfo, UpdateRelease } from '../api';
import { useSelfUpdate, checkNote } from '../hooks/useSelfUpdate';
import { useBuildState } from '../hooks/useBuildWatcher';
import { onServerEvent } from '../serverEvents';
import { UpdateProgress } from './UpdateProgress';

const SmallSpinner = () => <Spinner size="small" sx={{ width: 14, height: 14 }} />;

// Настройки → Обновления: выбор канала (ветка / stable / закреплённая версия), автообновление,
// откат и список релизов с изменениями. Переключение делает обновлятель (сервис updater):
// скачивает образ нужного тега, прописывает BOT_TAG в .env и перезапускает бота.

type Kind = 'branch' | 'stable' | 'pin';

const short = (s?: string | null) => (s ? s.slice(0, 7) : '—');
const fmtDay = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '');
const fmtDayTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
// latest и main — один и тот же образ
const norm = (tag: string) => (tag === 'latest' ? 'main' : tag);

function Tile({ selected, disabled, children, onSelect }: { selected: boolean; disabled?: boolean; children: React.ReactNode; onSelect: () => void }) {
  return (
    <Box
      onClick={() => !disabled && onSelect()}
      sx={{
        flex: '1 1 220px', p: 3, borderRadius: 2, border: '1px solid',
        borderColor: selected ? 'accent.emphasis' : 'border.default',
        bg: selected ? 'accent.subtle' : 'canvas.default',
        boxShadow: selected ? (t: { colors: { accent: { emphasis: string } } }) => `0 0 0 1px ${t.colors.accent.emphasis}` : 'none',
        opacity: disabled ? 0.6 : 1, cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex', flexDirection: 'column', gap: 2, transition: 'border-color .15s, background-color .15s',
      }}
    >
      {children}
    </Box>
  );
}

function ReleaseRow({ r, current, onPick, picked }: { r: UpdateRelease; current: boolean; picked: boolean; onPick: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Box sx={{ borderTop: '1px solid', borderColor: 'border.muted', py: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <IconButton icon={open ? ChevronDownIcon : ChevronRightIcon} aria-label="Что изменилось" size="small" variant="invisible"
          onClick={() => setOpen(o => !o)} />
        <Text sx={{ fontFamily: 'mono', fontWeight: 'bold' }}>{r.version}</Text>
        {r.name && r.name !== r.tagName && <Text sx={{ color: 'fg.muted' }}>{r.name}</Text>}
        {current && <Label variant="accent">Установлена</Label>}
        {r.isNew && <Label variant="success">Новая</Label>}
        {r.prerelease && <Label variant="attention">Пре-релиз</Label>}
        <Box sx={{ flex: 1 }} />
        <Text sx={{ color: 'fg.muted', fontSize: 0 }}>{fmtDay(r.date)}</Text>
        <Link href={r.url} target="_blank" rel="noreferrer" muted aria-label="Открыть на GitHub"><LinkExternalIcon size={14} /></Link>
        <Button size="small" variant={picked ? 'primary' : 'default'} disabled={current} onClick={onPick}>
          {picked ? 'Выбрана' : 'Выбрать'}
        </Button>
      </Box>
      {open && (
        <Box sx={{ mt: 2, ml: 5, p: 2, bg: 'canvas.subtle', borderRadius: 2, fontSize: 1, whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>
          {r.notes.trim() || <Text sx={{ color: 'fg.muted' }}>Описание изменений не заполнено.</Text>}
        </Box>
      )}
    </Box>
  );
}

export function UpdatesCard() {
  const [v, setV] = useState<VersionInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState<Kind>('branch');
  const [branch, setBranch] = useState('main');
  const [pin, setPin] = useState('');
  const [auto, setAuto] = useState(true);
  const [savingAuto, setSavingAuto] = useState(false);
  const [confirm, setConfirm] = useState<null | { tag: string; title: string; rollback?: boolean }>(null);
  const [showAll, setShowAll] = useState(false);
  const upd = useSelfUpdate();
  const build = useBuildState();
  const ref = useRef<HTMLDivElement>(null);
  const location = useLocation();

  const applyFrom = (d: VersionInfo) => {
    setAuto(!!d.auto);
    const ch = d.channel;
    if (ch.kind === 'branch') { setKind('branch'); setBranch(ch.name); }
    else if (ch.kind === 'stable') setKind('stable');
    else { setKind('pin'); setPin(ch.tag); }
  };

  const [note, setNote] = useState<string | null>(null);
  const load = async (force = false) => {
    setLoading(true);
    if (force) setNote(null);
    try {
      const d = await api.version(force);
      if (d && d.ok) {
        setV(d); if (!v) applyFrom(d);
        // плашка версии в меню берёт те же данные, чтобы не показывать устаревшее
        window.dispatchEvent(new CustomEvent('tc-version', { detail: d }));
        if (force) { setNote(checkNote(d)); setTimeout(() => setNote(null), 6000); }
      }
    } catch { if (force) setNote('Панель не отвечает'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);
  // свежие проверки бота приходят сами; перезагрузку после перезапуска на новой версии делает
  // useBuildWatcher по событию build
  useEffect(() => onServerEvent<VersionInfo>('version', d => { if (d && d.ok) setV(d); }), []);
  // обновление идёт — бот сообщает сам (событие build), в том числе начатое из другой вкладки
  const busy = build.busy || !!v?.updater?.busy;
  useEffect(() => {
    if (v && location.hash === '#updates') ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [!!v, location.hash]);

  // варианты закрепления: релизы + собранные ранее версии (для отката)
  const pinOptions = useMemo(() => {
    if (!v) return [];
    const opts = v.releases.map(r => ({ tag: r.tag, label: `${r.version}${r.prerelease ? ' (пре-релиз)' : ''} · ${fmtDay(r.date)}` }));
    for (const h of v.history || []) {
      const tag = `sha-${h.commit}`;
      if (!opts.some(o => o.tag === tag)) opts.push({ tag, label: `Сборка ${short(h.commit)}${h.ref ? ' · ' + h.ref : ''} · ${fmtDay(h.at)}` });
    }
    if (v.channel.kind === 'commit' && !opts.some(o => o.tag === v.channel.tag))
      opts.push({ tag: v.channel.tag, label: `Сборка ${v.channel.name}` });
    return opts;
  }, [v]);

  useEffect(() => { if (kind === 'pin' && !pin && pinOptions[0]) setPin(pinOptions[0].tag); }, [kind, pinOptions]);

  if (!v) {
    return (
      <Card>
        <Box sx={{ p: 3, display: 'flex', gap: 2, alignItems: 'center' }}>
          {loading ? <><Spinner size="small" /><Text sx={{ color: 'fg.muted' }}>Проверяю версии на GitHub…</Text></> : <Text sx={{ color: 'fg.muted' }}>Не удалось получить версию бота.</Text>}
        </Box>
      </Card>
    );
  }

  const ch = v.channel;
  const pinned = ch.kind === 'release' || ch.kind === 'commit';
  const hasReleases = v.releases.some(r => !r.prerelease);
  const target = kind === 'branch' ? (v.branches.find(b => b.name === branch)?.tag || branch) : kind === 'stable' ? 'stable' : pin;
  const targetTitle = kind === 'branch' ? `ветку ${branch}` : kind === 'stable' ? `стабильный канал${v.stable ? ` (${v.stable.version})` : ''}` : (pinOptions.find(o => o.tag === pin)?.label.split(' · ')[0] || pin);
  const changed = !!target && norm(target) !== norm(ch.tag);
  const prev = (v.history || []).find(h => h.commit !== v.local?.sha);
  const buildRunning = v.build && v.build.status !== 'completed';
  const buildFailed = v.build && v.build.status === 'completed' && v.build.conclusion !== 'success';
  const ChIcon = pinned ? PinIcon : ch.kind === 'stable' ? TagIcon : GitBranchIcon;
  const chTitle = ch.kind === 'branch' ? `Ветка ${ch.name}` : ch.kind === 'stable' ? `Стабильный${v.currentRelease ? ' · ' + v.currentRelease : ''}` : ch.kind === 'release' ? `Закреплена ${ch.name}` : `Закреплена сборка ${ch.name}`;
  const updaterLast = v.updater?.last;
  // ошибку прошлого переключения показываем, только пока бот с тех пор не перезапускался: если он
  // перезапустился позже, обновление всё-таки прошло (или его сделали вручную) и ошибка устарела
  const lastError = updaterLast?.state === 'error' && !(v.startedAt && Date.parse(updaterLast.at) < v.startedAt) ? updaterLast : null;
  const releases = showAll ? v.releases : v.releases.slice(0, 6);

  const toggleAuto = async (next: boolean) => {
    setAuto(next); setSavingAuto(true);
    try { const d = await api.saveConfig({ update: { auto: next } }); if (!d.ok) setAuto(!next); }
    catch { setAuto(!next); } finally { setSavingAuto(false); }
  };

  return (
    <Card innerRef={ref}
      right={<>
        <Text sx={{ fontSize: 0, color: 'fg.muted' }}>проверено {new Date(v.checkedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</Text>
        <Button size="small" leadingVisual={loading ? SmallSpinner : SyncIcon} disabled={loading || upd.updating} onClick={() => load(true)}>Проверить</Button>
      </>}
    >
      <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {busy && v.updater?.last && (
          <Flash>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Spinner size="small" />
              <Text>Идёт обновление на {v.updater.last.tag}: {v.updater.last.message}. Когда бот перезапустится, страница обновится сама.</Text>
            </Box>
          </Flash>
        )}
        {!busy && !v.updater?.alive && (
          <Flash variant="warning">
            Обновлятель не запущен, поэтому переключать версии из панели пока нельзя. На сервере нужен сервис
            {' '}<Text sx={{ fontFamily: 'mono' }}>updater</Text>: в Portainer — обновите стек с «Re-pull image», при запуске из консоли —
            {' '}<Text sx={{ fontFamily: 'mono' }}>docker compose up -d --remove-orphans</Text>.
          </Flash>
        )}
        {v.updater?.alive && v.updater.outdated && (
          <Flash variant="warning">
            Обновлятель устарел (версия {v.updater.version ?? '?'}), из-за этого обновление может не работать. Новый обновлятель
            сам обновляется вместе с ботом, а этот нужно один раз обновить вручную: в Portainer — обновите стек с «Re-pull image»,
            при запуске из консоли — в папке проекта
            {' '}<Text sx={{ fontFamily: 'mono' }}>docker compose pull updater && docker compose up -d updater</Text>.
          </Flash>
        )}
        {v.error && <Flash variant="warning">Нет связи с GitHub: {v.error}</Flash>}
        {lastError && (
          <Flash variant="danger">Последнее переключение на {lastError.tag} ({fmtDayTime(lastError.at)}) не удалось: {lastError.message}</Flash>
        )}

        {/* сейчас установлено */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap', p: 3, bg: 'canvas.subtle', borderRadius: 2 }}>
          <Box sx={{ width: 40, height: 40, borderRadius: '50%', bg: pinned ? 'attention.subtle' : 'accent.subtle', color: pinned ? 'attention.fg' : 'accent.fg', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <ChIcon size={20} />
          </Box>
          <Box sx={{ flex: 1, minWidth: 200 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
              <Text sx={{ fontWeight: 'bold', fontSize: 2 }}>{chTitle}</Text>
              {v.status === 'current' && <Label variant="success">Актуальная</Label>}
              {v.status === 'behind' && <Label variant="attention">Доступна новая{v.behindBy ? `: +${v.behindBy}` : ''}</Label>}
              {pinned && <Label variant="secondary">Сама не обновляется</Label>}
              {pinned && !!v.newerReleases && <Label variant="success">Есть релизы новее: {v.newerReleases}</Label>}
              {(v.status === 'ahead' || v.status === 'diverged' || v.status === 'unknown_local') && <Label variant="severe">Локальная сборка</Label>}
            </Box>
            <Text as="div" sx={{ color: 'fg.muted', fontSize: 1, mt: 1 }}>
              Коммит{' '}
              {v.local ? <Link href={`${v.repoUrl}/commit/${v.local.sha}`} target="_blank" rel="noreferrer" sx={{ fontFamily: 'mono' }}>{short(v.local.sha)}</Link> : 'неизвестен'}
              {' · '}образ <Text sx={{ fontFamily: 'mono' }}>{ch.tag}</Text>
              {v.status === 'behind' && v.remote && <>
                {' · '}в канале{' '}
                <Link href={v.compareUrl || v.remote.url} target="_blank" rel="noreferrer">{short(v.remote.sha)}</Link>
                {v.remote.date ? ` от ${fmtDayTime(v.remote.date)}` : ''}: {v.remote.message}
              </>}
            </Text>
            {buildRunning && v.build && <Link href={v.build.url} target="_blank" rel="noreferrer" sx={{ fontSize: 1 }}>Новый образ собирается на GitHub…</Link>}
            {buildFailed && v.build && <Link href={v.build.url} target="_blank" rel="noreferrer" sx={{ fontSize: 1, color: 'danger.fg' }}>Сборка нового образа не удалась</Link>}
          </Box>
          {v.status === 'behind' && !pinned && (
            <Button variant="primary" disabled={!v.canUpdate || upd.updating || !!buildRunning || !!buildFailed}
              onClick={() => setConfirm({ tag: ch.tag, title: 'Обновить бота сейчас?' })}>Обновить сейчас</Button>
          )}
        </Box>

        {/* выбор канала */}
        <Box>
          <Text as="div" sx={{ fontWeight: 'bold', mb: 2 }}>Канал обновлений</Text>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            <Tile selected={kind === 'branch'} onSelect={() => setKind('branch')}>
              <FormControl>
                <Radio name="upd-channel" value="branch" checked={kind === 'branch'} onChange={() => setKind('branch')} />
                <FormControl.Label><GitBranchIcon size={14} /> Свежая сборка ветки</FormControl.Label>
                <FormControl.Caption>Каждый новый коммит ветки, сразу после сборки образа</FormControl.Caption>
              </FormControl>
              <Select size="small" block value={branch} disabled={kind !== 'branch'} onChange={e => setBranch(e.target.value)} onClick={e => e.stopPropagation()}>
                {(v.branches.length ? v.branches : [{ name: 'main', tag: 'main' }]).map(b => <Select.Option key={b.name} value={b.name}>{b.name}</Select.Option>)}
              </Select>
            </Tile>
            <Tile selected={kind === 'stable'} disabled={!hasReleases} onSelect={() => setKind('stable')}>
              <FormControl disabled={!hasReleases}>
                <Radio name="upd-channel" value="stable" checked={kind === 'stable'} onChange={() => setKind('stable')} />
                <FormControl.Label><TagIcon size={14} /> Стабильный</FormControl.Label>
                <FormControl.Caption>
                  {v.stable ? `Только релизы. Последний: ${v.stable.version} от ${fmtDay(v.stable.date)}` : 'Только релизы. Релизов пока нет'}
                </FormControl.Caption>
              </FormControl>
            </Tile>
            <Tile selected={kind === 'pin'} disabled={!pinOptions.length} onSelect={() => setKind('pin')}>
              <FormControl disabled={!pinOptions.length}>
                <Radio name="upd-channel" value="pin" checked={kind === 'pin'} onChange={() => setKind('pin')} />
                <FormControl.Label><PinIcon size={14} /> Закрепить версию</FormControl.Label>
                <FormControl.Caption>Бот остаётся на ней и сам не обновляется</FormControl.Caption>
              </FormControl>
              <Select size="small" block value={pin} disabled={kind !== 'pin' || !pinOptions.length} onChange={e => setPin(e.target.value)} onClick={e => e.stopPropagation()}>
                {pinOptions.map(o => <Select.Option key={o.tag} value={o.tag}>{o.label}</Select.Option>)}
              </Select>
            </Tile>
          </Box>
        </Box>

        {/* автообновление */}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 3, p: 2, border: '1px solid', borderColor: 'border.default', borderRadius: 2 }}>
          <Box>
            <Text as="div" id="upd-auto-label" sx={{ fontWeight: 'bold' }}>Ставить обновления автоматически</Text>
            <Text as="div" sx={{ fontSize: 0, color: 'fg.muted' }}>
              {kind === 'pin'
                ? 'У закреплённой версии автообновления нет'
                : 'Как только в канале готов новый образ, бот обновится сам (не посреди ручных операций). Выключено — только кнопкой.'}
            </Text>
          </Box>
          <ToggleSwitch size="small" aria-labelledby="upd-auto-label" checked={auto && kind !== 'pin'} disabled={savingAuto || kind === 'pin'}
            onClick={() => toggleAuto(!auto)} />
        </Box>

        {/* действия */}
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button variant="primary" disabled={!changed || !v.canUpdate || upd.updating}
            onClick={() => setConfirm({ tag: target, title: `Перейти на ${targetTitle}?` })}>
            {changed ? `Перейти на ${targetTitle}` : 'Канал уже выбран'}
          </Button>
          {prev && (
            <Button leadingVisual={HistoryIcon} disabled={!v.canUpdate || upd.updating}
              onClick={() => setConfirm({ tag: `sha-${prev.commit}`, title: `Вернуться на сборку ${short(prev.commit)}?`, rollback: true })}>
              Вернуться на {short(prev.commit)}{prev.ref ? ` (${prev.ref})` : ''}
            </Button>
          )}
          {(upd.updating || build.busy) && <Box sx={{ maxWidth: 420 }}><UpdateProgress stage={build.update} fallback="Скачиваю образ и перезапускаю бота…" /></Box>}
        </Box>
        {note && <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{note}</Text>}
        {upd.msg && <Flash variant="warning">{upd.msg}</Flash>}

        {/* релизы */}
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, mb: 1 }}>
            <Text sx={{ fontWeight: 'bold' }}>Релизы</Text>
            <Link href={`${v.repoUrl}/releases`} target="_blank" rel="noreferrer" muted sx={{ fontSize: 0 }}>все на GitHub</Link>
          </Box>
          {v.releases.length === 0
            ? <Text as="div" sx={{ color: 'fg.muted', fontSize: 1 }}>Релизов пока нет. Выпустить: GitHub → Releases → Draft a new release, тег вида <Text sx={{ fontFamily: 'mono' }}>v1.0</Text>.</Text>
            : <>
              {releases.map(r => (
                <ReleaseRow key={r.tagName} r={r} current={norm(ch.tag) === r.tag || (ch.kind === 'stable' && v.currentRelease === r.version)}
                  picked={kind === 'pin' && pin === r.tag} onPick={() => { setKind('pin'); setPin(r.tag); }} />
              ))}
              {v.releases.length > 6 && (
                <Button variant="invisible" size="small" onClick={() => setShowAll(s => !s)}>
                  {showAll ? 'Свернуть' : `Показать все (${v.releases.length})`}
                </Button>
              )}
            </>}
        </Box>
      </Box>

      {(confirm || upd.busyOps) && (
        <ConfirmationDialog
          title={upd.busyOps ? 'Идут операции' : confirm?.title || ''}
          cancelButtonContent="Отмена"
          confirmButtonContent={upd.busyOps ? 'Всё равно перезапустить' : confirm?.rollback ? 'Откатить' : 'Перезапустить бота'}
          confirmButtonType={upd.busyOps || confirm?.rollback ? 'danger' : 'primary'}
          onClose={(gesture) => {
            const tag = upd.busyOps ? upd.busyOps.tag : confirm?.tag;
            const force = !!upd.busyOps;
            setConfirm(null);
            upd.setBusyOps(null);
            if (gesture === 'confirm') upd.run(tag, force);
          }}
        >
          {upd.busyOps
            ? <>Сейчас идут операции: {upd.busyOps.ops.join(', ')}. При перезапуске они прервутся.</>
            : <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Text>
                Сейчас: <b>{chTitle}</b> ({short(v.local?.sha)}). Бот скачает образ <Text sx={{ fontFamily: 'mono' }}>{confirm?.tag}</Text> и
                перезапустится, обычно это меньше минуты. Настройки, база и токены не меняются.
              </Text>
              {(confirm?.rollback || /^sha-|^\d/.test(confirm?.tag || '')) && (
                <Text sx={{ color: 'attention.fg' }}>
                  Версия будет закреплена: автообновление не сработает, пока вы не выберете ветку или стабильный канал.
                  {confirm?.rollback ? ' Изменения базы данных, сделанные новой версией, назад не откатываются.' : ''}
                </Text>
              )}
              {kind === 'branch' && confirm?.tag === target && auto && <Text>Дальше бот будет сам ставить каждую новую сборку ветки {branch}.</Text>}
              {kind === 'stable' && confirm?.tag === 'stable' && auto && <Text>Дальше бот будет сам ставить каждый новый релиз.</Text>}
            </Box>}
        </ConfirmationDialog>
      )}
    </Card>
  );
}

// карточка в стиле остальных разделов страницы «Настройки»
function Card({ children, right, innerRef }: { children: React.ReactNode; right?: React.ReactNode; innerRef?: React.Ref<HTMLDivElement> }) {
  return (
    <Box ref={innerRef} id="updates" sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden', scrollMarginTop: 64 }}>
      <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
        <Text sx={{ fontWeight: 'bold' }}>Обновления</Text>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>{right}</Box>
      </Box>
      {children}
    </Box>
  );
}
