import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box, Button, Flash, Heading, Label, Spinner, Text, TextInput, Avatar,
  ActionList, ActionMenu, TabNav, CounterLabel,
} from '@primer/react';
import {
  SyncIcon, PeopleIcon, ShieldIcon, XIcon, SearchIcon,
  CheckIcon, TrashIcon, PlusIcon, FlameIcon, RocketIcon, MegaphoneIcon,
} from '@primer/octicons-react';
import {
  api,
  type MidLiveData, type MidAlliance, type MidEnemy,
  type MidCampaign, type MidCampaignConfig, type MidSearchGuild, type MidAllianceRequest,
} from '../api';
import { useFlash } from '../hooks/useFlash';
import { fmt } from '../utils';
import { Scrollable } from '../components/Scrollable';
import { Dialog } from '@primer/react/experimental';
import { useAsk } from '../hooks/useAsk';

// ── helpers ───────────────────────────────────────────────────────────────────
const commissionReduction = (level: number) => (level * 0.5).toFixed(1).replace(/\.0$/, '');

// ── Alliance level / upgrade modal ────────────────────────────────────────────
function AllianceUpgradeModal({ open, alliance, onClose, onConfirm, loading }: {
  open: boolean; alliance: MidAlliance | null; onClose: () => void; onConfirm: () => void; loading: boolean;
}) {
  if (!open || !alliance) return null;
  const eff = alliance.effective_level ?? 0;
  const our = alliance.our_level ?? 0;
  const their = alliance.their_level ?? 0;
  const atMax = our >= 10;
  const canUpgrade = our <= their && our < 10;
  return (
    <Dialog
      title="Уровень альянса"
      onClose={onClose}
      width="large"
      position={{ narrow: 'bottom', regular: 'center' }}
      footerButtons={[
        { content: 'Закрыть', onClick: onClose },
        { content: 'Улучшить', buttonType: 'primary', disabled: !canUpgrade || loading, loading, onClick: onConfirm },
      ]}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <GuildAvatar photo={alliance.ally_guild_photo} title={alliance.ally_guild_title} size={40} />
          <Box>
            <Text sx={{ fontWeight: 'semibold', fontSize: 1, display: 'block' }}>{alliance.ally_guild_title}</Text>
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Эффективный уровень: {eff}</Text>
          </Box>
        </Box>

        <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, p: 3 }}>
          <Text sx={{ fontSize: 1, fontWeight: 'semibold', display: 'block', mb: 1 }}>Что даёт уровень</Text>
          <Text sx={{ fontSize: 1, color: 'success.fg', fontWeight: 'bold', display: 'block' }}>
            Снижение комиссии рынка: −{commissionReduction(eff)}%
          </Text>
          <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 1 }}>
            Каждый уровень даёт −0.5% к комиссии при торговле на Центральном рынке. Общий уровень = минимум из вашего и уровня союзника.
          </Text>
          <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 1 }}>
            Ваш уровень: <b>{our}</b> · Союзник: <b>{their}</b>
          </Text>
        </Box>

        {atMax ? (
          <Flash variant="success">Достигнут максимальный уровень (10).</Flash>
        ) : !canUpgrade ? (
          <Flash variant="warning">
            Союзнику нужно поднять свой уровень — общий уровень ограничен минимальным.
          </Flash>
        ) : (
          <Box sx={{ border: '1px solid', borderColor: 'accent.emphasis', borderRadius: 2, p: 3, bg: 'accent.subtle' }}>
            <Text sx={{ fontSize: 1, fontWeight: 'semibold', display: 'block' }}>Поднять ваш уровень до {our + 1}</Text>
            <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 1 }}>
              Бонус общего уровня вырастет до −{commissionReduction(Math.min(our + 1, their))}% (когда союзник тоже подтянется — до −{commissionReduction(our + 1)}%).
            </Text>
            <Text sx={{ fontSize: 1, fontWeight: 'bold', display: 'block', mt: 2 }}>
              Стоимость: 🪙 {fmt(alliance.next_level_cost ?? 0)} <Text as="span" sx={{ fontSize: 0, color: 'fg.muted', fontWeight: 'normal' }}>из казны гильдии</Text>
            </Text>
          </Box>
        )}
      </Box>
    </Dialog>
  );
}

function timeLeft(endsAt: string): string {
  const diff = new Date(endsAt).getTime() - Date.now();
  if (diff <= 0) return 'завершена';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? `${h}ч ${m}м` : `${m}м`;
}

function GuildAvatar({ photo, title, size = 32 }: { photo: string | null; title: string; size?: number }) {
  return photo
    ? <Avatar src={photo} size={size} square sx={{ borderRadius: 1, flexShrink: 0 }} />
    : <Box sx={{
        width: size, height: size, borderRadius: 1, bg: 'canvas.subtle',
        border: '1px solid', borderColor: 'border.default', display: 'flex',
        alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <PeopleIcon size={size > 28 ? 16 : 12} />
      </Box>;
}

// ── Guild picker modal ────────────────────────────────────────────────────────

interface GuildPickerProps {
  open: boolean;
  onClose: () => void;
  guildId: string;
  type: 'alliances' | 'enemies';
  title: string;
  onSelect: (guild: MidSearchGuild) => void;
}

const MAX_ALLIANCES = 3;

function GuildPicker({ open, onClose, guildId, type, title, onSelect }: GuildPickerProps) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<MidSearchGuild[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageRef = useRef(1);
  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(false);
  const qRef = useRef('');

  const search = useCallback(async (query: string) => {
    setLoading(true);
    setResults([]);
    setTotal(null);
    pageRef.current = 1;
    qRef.current = query;
    hasMoreRef.current = false;
    try {
      const d = await api.midSearch(guildId, query, type, 1);
      if (d.ok) {
        setResults(d.guilds);
        setTotal(d.total);
        hasMoreRef.current = d.total !== null && d.guilds.length < d.total;
      }
    } finally { setLoading(false); }
  }, [guildId, type]);

  const doLoadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const nextPage = pageRef.current + 1;
    try {
      const d = await api.midSearch(guildId, qRef.current, type, nextPage);
      if (d.ok) {
        setResults(prev => {
          const merged = [...prev, ...d.guilds];
          hasMoreRef.current = d.total !== null && merged.length < d.total;
          return merged;
        });
        setTotal(d.total);
        pageRef.current = nextPage;
      }
    } finally { loadingMoreRef.current = false; setLoadingMore(false); }
  }, [guildId, type]);

  const handleInput = (v: string) => {
    setQ(v);
    qRef.current = v;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(v), 400);
  };

  useEffect(() => {
    if (!open) { setQ(''); setResults([]); setTotal(null); pageRef.current = 1; hasMoreRef.current = false; }
    else search('');
  }, [open, search]);

  // IntersectionObserver на sentinel в конце списка
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) void doLoadMore();
    }, { threshold: 0.1 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [doLoadMore]);

  if (!open) return null;

  const hasMore = total !== null && results.length < total;

  return (
    <Dialog title={title} onClose={onClose} width="large" position={{ narrow: 'bottom', regular: 'center' }}>
      <Box>
        <TextInput
          leadingVisual={SearchIcon}
          placeholder="Поиск гильдии..."
          value={q}
          onChange={e => handleInput(e.target.value)}
          block
          autoFocus
        />
        <Scrollable style={{ marginTop: 8, maxHeight: 360 }}>
          {loading && <Box sx={{ p: 3, display: 'flex', justifyContent: 'center' }}><Spinner /></Box>}
          {!loading && results.length === 0 && (
            <Text sx={{ color: 'fg.muted', fontSize: 1, p: 2, display: 'block' }}>Ничего не найдено</Text>
          )}
          {results.map(g => {
            const allianceFull = type === 'alliances' && (g.alliance_count ?? 0) >= MAX_ALLIANCES;
            const isEnemy = type === 'enemies' && g.is_enemy;
            const disabled = allianceFull || isEnemy;
            return (
              <Box
                key={g.id}
                onClick={() => !disabled && onSelect(g)}
                sx={{
                  display: 'flex', alignItems: 'center', gap: 2, p: 2,
                  borderRadius: 1, cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.5 : 1,
                  '&:hover': { bg: disabled ? 'transparent' : 'canvas.subtle' },
                }}
              >
                <GuildAvatar photo={g.photo} title={g.title} size={36} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Text sx={{ fontSize: 1, fontWeight: 'semibold', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.title}</Text>
                  <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                    {g.members_count} участников
                    {type === 'alliances' && g.alliance_count != null && ` · ${g.alliance_count} союзника`}
                  </Text>
                </Box>
                {type === 'alliances' && allianceFull && (
                  <Label variant="secondary" sx={{ fontSize: 0, py: 0 }}>Макс. союзников</Label>
                )}
                {type === 'alliances' && !allianceFull && g.has_foreign_ministry && (
                  <Label variant="success" sx={{ fontSize: 0, py: 0 }}>Доступно</Label>
                )}
                {isEnemy && (
                  <Label variant="danger" sx={{ fontSize: 0, py: 0 }}>Враг</Label>
                )}
              </Box>
            );
          })}
          <div ref={sentinelRef} style={{ height: 1 }} />
          {loadingMore && (
            <Box sx={{ py: 2, display: 'flex', justifyContent: 'center' }}><Spinner /></Box>
          )}
          {!loadingMore && hasMore && total !== null && (
            <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', textAlign: 'center', py: 2 }}>
              Показано {results.length} из {total}
            </Text>
          )}
        </Scrollable>
      </Box>
    </Dialog>
  );
}

// ── Enemy add modal ───────────────────────────────────────────────────────────

const TARIFF_OPTIONS = ['10', '25', '50', '100'];

interface EnemyAddModalProps {
  open: boolean;
  guild: MidSearchGuild | null;
  onClose: () => void;
  onConfirm: (tariff: string) => void;
  loading: boolean;
}

function EnemyAddModal({ open, guild, onClose, onConfirm, loading }: EnemyAddModalProps) {
  const [tariff, setTariff] = useState('10');
  if (!open || !guild) return null;
  return (
    <Dialog
      title="Объявить врагом"
      onClose={onClose}
      width="medium"
      position={{ narrow: 'bottom', regular: 'center' }}
      footerButtons={[{ content: 'Объявить врагом', buttonType: 'danger', loading, onClick: () => onConfirm(tariff) }]}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <GuildAvatar photo={guild.photo} title={guild.title} size={40} />
          <Box>
            <Text sx={{ fontWeight: 'semibold', fontSize: 1, display: 'block' }}>{guild.title}</Text>
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{guild.members_count} участников</Text>
          </Box>
        </Box>
        <Box>
          <Text sx={{ fontSize: 1, fontWeight: 'semibold', mb: 1, display: 'block' }}>Уровень тарифа</Text>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {TARIFF_OPTIONS.map(t => (
              <Button
                key={t}
                variant={tariff === t ? 'primary' : 'default'}
                onClick={() => setTariff(t)}
              >{t}%</Button>
            ))}
          </Box>
          <Text sx={{ fontSize: 0, color: 'fg.muted', mt: 1, display: 'block' }}>
            Тариф применяется к торговле участников вражеской гильдии на Центральном рынке
          </Text>
        </Box>
      </Box>
    </Dialog>
  );
}

// ── Enemy tariff edit modal ───────────────────────────────────────────────────

function TariffEditModal({ open, enemy, onClose, onConfirm, loading }: {
  open: boolean; enemy: MidEnemy | null; onClose: () => void; onConfirm: (tariff: string) => void; loading: boolean;
}) {
  const [tariff, setTariff] = useState('10');
  useEffect(() => { if (enemy) setTariff(String(enemy.tariff_level)); }, [enemy]);
  if (!open || !enemy) return null;
  return (
    <Dialog
      title="Изменить тариф"
      onClose={onClose}
      width="medium"
      position={{ narrow: 'bottom', regular: 'center' }}
      footerButtons={[{ content: 'Сохранить', buttonType: 'primary', loading, onClick: () => onConfirm(tariff) }]}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <GuildAvatar photo={enemy.enemy_guild_photo} title={enemy.enemy_guild_title} size={40} />
          <Box>
            <Text sx={{ fontWeight: 'semibold', fontSize: 1, display: 'block' }}>{enemy.enemy_guild_title}</Text>
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{enemy.enemy_members_count} участников</Text>
          </Box>
        </Box>
        <Box>
          <Text sx={{ fontSize: 1, fontWeight: 'semibold', mb: 1, display: 'block' }}>Уровень тарифа</Text>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {TARIFF_OPTIONS.map(t => (
              <Button key={t} variant={tariff === t ? 'primary' : 'default'} onClick={() => setTariff(t)}>{t}%</Button>
            ))}
          </Box>
          <Text sx={{ fontSize: 0, color: 'fg.muted', mt: 1, display: 'block' }}>
            Тариф применяется к торговле участников вражеской гильдии на Центральном рынке
          </Text>
        </Box>
      </Box>
    </Dialog>
  );
}

// ── Campaign start modal ──────────────────────────────────────────────────────
// Кампании заменили разведку (scouting) в обновлении 06.07.2026 — реверс структуры
// см. комментарий у MidCampaign в api.ts.

interface CampaignStartModalProps {
  open: boolean;
  guild: MidSearchGuild | null;
  config: MidCampaignConfig | null;
  onClose: () => void;
  onConfirm: (durationHours: number) => void;
  loading: boolean;
}

function CampaignStartModal({ open, guild, config, onClose, onConfirm, loading }: CampaignStartModalProps) {
  const durations = config?.durations?.length ? config.durations : [24, 72];
  const [duration, setDuration] = useState(durations[0]);
  // сбрасываем на первую длительность при каждом открытии — у разных гильдий config.durations
  // может отличаться, поэтому не полагаемся на дефолт из предыдущего открытия
  useEffect(() => { if (open) setDuration(durations[0]); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open || !guild) return null;
  const stealFrac = duration >= 72 ? config?.steal_base_long : config?.steal_base_short;
  return (
    <Dialog
      title="Начать кампанию"
      onClose={onClose}
      width="medium"
      position={{ narrow: 'bottom', regular: 'center' }}
      footerButtons={[{ content: 'Начать кампанию', buttonType: 'danger', leadingVisual: FlameIcon, loading, onClick: () => onConfirm(duration) }]}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <GuildAvatar photo={guild.photo} title={guild.title} size={40} />
          <Box>
            <Text sx={{ fontWeight: 'semibold', fontSize: 1, display: 'block' }}>{guild.title}</Text>
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{guild.members_count} участников</Text>
          </Box>
        </Box>
        <Box>
          <Text sx={{ fontSize: 1, fontWeight: 'semibold', mb: 1, display: 'block' }}>Длительность</Text>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {durations.map(h => (
              <Button
                key={h}
                variant={duration === h ? 'primary' : 'default'}
                onClick={() => setDuration(h)}
              >{h < 24 ? `${h}ч` : `${Math.round(h / 24)}д`}</Button>
            ))}
          </Box>
          {stealFrac != null && (
            <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 1 }}>
              Базовый грабёж казны при победе: ≈{Math.round(stealFrac * 100)}%
            </Text>
          )}
        </Box>
      </Box>
    </Dialog>
  );
}

// ── Section components ────────────────────────────────────────────────────────

interface AllianceSectionProps {
  guildId: string;
  alliances: MidLiveData['alliances'];
  requests: MidLiveData['requests'];
  onRefresh: () => void;
  onFlash: (msg: string, ok: boolean) => void;
}

function AllianceSection({ guildId, alliances, requests, onRefresh, onFlash }: AllianceSectionProps) {
  const ask = useAsk();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [reqModal, setReqModal] = useState<null | 'incoming' | 'outgoing'>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [upgradeAlliance, setUpgradeAlliance] = useState<MidAlliance | null>(null);
  const [upgrading, setUpgrading] = useState(false);

  const doUpgrade = async () => {
    if (!upgradeAlliance) return;
    setUpgrading(true);
    try {
      const r = await api.midAllianceUpgrade(guildId, upgradeAlliance.ally_guild_id);
      if (r.ok) { onFlash('Уровень альянса повышен', true); setUpgradeAlliance(null); onRefresh(); }
      else onFlash(r.error ?? 'Ошибка', false);
    } catch (e) { onFlash(String(e), false); } finally { setUpgrading(false); }
  };

  const incomingCount = requests.incoming.length;
  const outgoingCount = requests.outgoing.length;

  const run = async (id: number, fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) => {
    setBusy(id);
    try { const r = await fn(); if (r.ok) { onFlash(okMsg, true); onRefresh(); } else onFlash(r.error ?? 'Ошибка', false); }
    catch (e) { onFlash(String(e), false); } finally { setBusy(null); }
  };

  const handleSend = async (guild: MidSearchGuild) => {
    setPickerOpen(false);
    setSending(true);
    try {
      const r = await api.midAllianceSend(guildId, guild.id);
      if (r.ok) { onFlash(`Заявка на альянс отправлена в "${guild.title}"`, true); onRefresh(); }
      else onFlash(r.error ?? 'Ошибка', false);
    } catch (e) { onFlash(String(e), false); }
    finally { setSending(false); }
  };

  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, overflow: 'hidden', mb: 3 }}>
      <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <PeopleIcon size={16} />
          <Text sx={{ fontWeight: 'bold', fontSize: 2 }}>Альянсы</Text>
          <Label variant="default" sx={{ fontSize: 0 }}>{alliances.alliances.length}/{alliances.max_alliances}</Label>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Button variant={incomingCount > 0 ? 'primary' : 'default'} onClick={() => setReqModal('incoming')}>
            Входящие {incomingCount > 0 && <CounterLabel scheme="primary" sx={{ ml: 1 }}>{incomingCount}</CounterLabel>}
          </Button>
          <Button onClick={() => setReqModal('outgoing')}>
            Исходящие {outgoingCount > 0 && <CounterLabel sx={{ ml: 1 }}>{outgoingCount}</CounterLabel>}
          </Button>
          <Button variant="primary" leadingVisual={PlusIcon} loading={sending}
            disabled={alliances.alliances.length >= alliances.max_alliances} onClick={() => setPickerOpen(true)}>
            Добавить
          </Button>
        </Box>
      </Box>

      <Box sx={{ p: 3 }}>
        {alliances.alliances.length === 0
          ? <Text sx={{ color: 'fg.muted', fontSize: 1 }}>Альянсов нет</Text>
          : alliances.alliances.map((a: MidAlliance) => (
            <Box key={a.id} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: '6px' }}>
              <GuildAvatar photo={a.ally_guild_photo} title={a.ally_guild_title} size={32} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Text sx={{ fontSize: 1, fontWeight: 'semibold', display: 'block' }}>{a.ally_guild_title}</Text>
                <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Уровень {a.effective_level ?? 0} · −{commissionReduction(a.effective_level ?? 0)}% комиссии</Text>
              </Box>
              <Button onClick={() => setUpgradeAlliance(a)}>↑ Ур. {a.effective_level ?? 0}</Button>
              <Button variant="danger" loading={busy === a.id} disabled={busy != null}
                onClick={async () => { if (await ask('Разорвать альянс?', `Альянс с «${a.ally_guild_title}» будет разорван.`, { ok: 'Разорвать', danger: true })) run(a.id, () => api.midAllianceBreak(guildId, a.ally_guild_id), 'Альянс разорван'); }}>
                Разорвать
              </Button>
            </Box>
          ))}
      </Box>

      <GuildPicker open={pickerOpen} onClose={() => setPickerOpen(false)} guildId={guildId} type="alliances" title="Предложить альянс" onSelect={handleSend} />
      <AllianceUpgradeModal open={!!upgradeAlliance} alliance={upgradeAlliance} onClose={() => setUpgradeAlliance(null)} onConfirm={doUpgrade} loading={upgrading} />

      {/* модалка заявок */}
      {reqModal && (
        <Dialog
          title={reqModal === 'incoming' ? 'Входящие заявки' : 'Исходящие заявки'}
          onClose={() => setReqModal(null)}
          width="large"
          position={{ narrow: 'bottom', regular: 'center' }}
        >
          <Box>
            {reqModal === 'incoming' ? (
              requests.incoming.length === 0
                ? <Text sx={{ color: 'fg.muted', fontSize: 1 }}>Нет входящих заявок</Text>
                : requests.incoming.map(r => (
                  <Box key={r.id} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: '8px', borderBottom: '1px solid', borderColor: 'border.muted' }}>
                    <GuildAvatar photo={r.guild_photo ?? null} title={r.guild_title ?? ''} size={32} />
                    <Text sx={{ fontSize: 1, flex: 1, minWidth: 0 }}>{r.guild_title}</Text>
                    <Button variant="primary" leadingVisual={CheckIcon} disabled={busy != null} onClick={() => run(r.id, () => api.midAllianceAccept(guildId, r.id), 'Альянс принят')}>Принять</Button>
                    <Button variant="danger" leadingVisual={XIcon} disabled={busy != null} onClick={() => run(r.id, () => api.midAllianceReject(guildId, r.id), 'Заявка отклонена')}>Отклонить</Button>
                  </Box>
                ))
            ) : (
              requests.outgoing.length === 0
                ? <Text sx={{ color: 'fg.muted', fontSize: 1 }}>Нет исходящих заявок</Text>
                : requests.outgoing.map(r => (
                  <Box key={r.id} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: '8px', borderBottom: '1px solid', borderColor: 'border.muted' }}>
                    <GuildAvatar photo={r.guild_photo ?? null} title={r.guild_title ?? ''} size={32} />
                    <Text sx={{ fontSize: 1, flex: 1, minWidth: 0 }}>{r.guild_title}</Text>
                    <Label variant="attention" sx={{ fontSize: 0 }}>Ожидает</Label>
                    <Button variant="danger" leadingVisual={XIcon} loading={busy === r.id} disabled={busy != null} onClick={() => run(r.id, () => api.midAllianceCancel(guildId, r.id), 'Заявка отменена')}>Отменить</Button>
                  </Box>
                ))
            )}
          </Box>
        </Dialog>
      )}
    </Box>
  );
}

interface EnemySectionProps {
  guildId: string;
  enemies: MidLiveData['enemies'];
  onRefresh: () => void;
  onFlash: (msg: string, ok: boolean) => void;
}

function EnemySection({ guildId, enemies, onRefresh, onFlash }: EnemySectionProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedGuild, setSelectedGuild] = useState<MidSearchGuild | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const [editEnemy, setEditEnemy] = useState<MidEnemy | null>(null);
  const [savingTariff, setSavingTariff] = useState(false);

  const handlePickerSelect = (guild: MidSearchGuild) => {
    setPickerOpen(false);
    setSelectedGuild(guild);
    setConfirmOpen(true);
  };

  const handleUpdateTariff = async (tariff: string) => {
    if (!editEnemy) return;
    setSavingTariff(true);
    try {
      const r = await api.midEnemyUpdateTariff(guildId, editEnemy.enemy_guild_id, tariff);
      if (r.ok) { onFlash('Тариф изменён', true); setEditEnemy(null); onRefresh(); }
      else onFlash(r.error ?? 'Ошибка', false);
    } catch (e) { onFlash(String(e), false); }
    finally { setSavingTariff(false); }
  };

  const handleAdd = async (tariff: string) => {
    if (!selectedGuild) return;
    setAdding(true);
    try {
      const r = await api.midEnemyAdd(guildId, selectedGuild.id, tariff);
      if (r.ok) { onFlash(`"${selectedGuild.title}" объявлена врагом`, true); setConfirmOpen(false); onRefresh(); }
      else onFlash(r.error ?? 'Ошибка', false);
    } catch (e) { onFlash(String(e), false); }
    finally { setAdding(false); }
  };

  const handleRemove = async (enemy: MidEnemy) => {
    setRemoving(enemy.id);
    try {
      const r = await api.midEnemyRemove(guildId, enemy.enemy_guild_id);
      if (r.ok) { onFlash(`"${enemy.enemy_guild_title}" удалена из врагов`, true); onRefresh(); }
      else onFlash(r.error ?? 'Ошибка', false);
    } catch (e) { onFlash(String(e), false); }
    finally { setRemoving(null); }
  };

  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, overflow: 'hidden', mb: 3 }}>
      <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <ShieldIcon size={16} />
          <Text sx={{ fontWeight: 'bold', fontSize: 2 }}>Враги</Text>
          <Label variant="default" sx={{ fontSize: 0 }}>{enemies.enemies.length}/{enemies.max_enemies}</Label>
        </Box>
        <Button
          variant="danger"
          leadingVisual={PlusIcon}
          disabled={enemies.enemies.length >= enemies.max_enemies}
          onClick={() => setPickerOpen(true)}
        >
          Добавить
        </Button>
      </Box>

      <Box sx={{ p: 3 }}>
        {enemies.enemies.length === 0
          ? <Text sx={{ color: 'fg.muted', fontSize: 1 }}>Врагов нет</Text>
          : enemies.enemies.map((e: MidEnemy) => (
            <Box key={e.id} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: '6px' }}>
              <GuildAvatar photo={e.enemy_guild_photo} title={e.enemy_guild_title} size={32} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Text sx={{ fontSize: 1, fontWeight: 'semibold', display: 'block' }}>{e.enemy_guild_title}</Text>
                <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{e.enemy_members_count} участников</Text>
              </Box>
              <Button variant="danger" onClick={() => setEditEnemy(e)}>Тариф {e.tariff_level}%</Button>
              <Button
                variant="danger"
                leadingVisual={TrashIcon}
                loading={removing === e.id}
                onClick={() => handleRemove(e)}
              />
            </Box>
          ))
        }
      </Box>

      <GuildPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        guildId={guildId}
        type="enemies"
        title="Объявить врага"
        onSelect={handlePickerSelect}
      />

      <EnemyAddModal
        open={confirmOpen}
        guild={selectedGuild}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleAdd}
        loading={adding}
      />

      <TariffEditModal
        open={!!editEnemy}
        enemy={editEnemy}
        onClose={() => setEditEnemy(null)}
        onConfirm={handleUpdateTariff}
        loading={savingTariff}
      />
    </Box>
  );
}

interface CampaignsSectionProps {
  guildId: string;
  campaigns: MidLiveData['campaigns'];
  onRefresh: () => void;
  onFlash: (msg: string, ok: boolean) => void;
}

function CampaignsSection({ guildId, campaigns, onRefresh, onFlash }: CampaignsSectionProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedGuild, setSelectedGuild] = useState<MidSearchGuild | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [deploying, setDeploying] = useState<number | null>(null);
  const [calling, setCalling] = useState<number | null>(null);

  const handlePickerSelect = (guild: MidSearchGuild) => {
    setSelectedGuild(guild);
    setPickerOpen(false);
    setConfirmOpen(true);
  };

  const handleStart = async (duration: number) => {
    if (!selectedGuild) return;
    setStarting(true);
    try {
      const r = await api.midCampaignsStart(guildId, selectedGuild.id, duration);
      if (r.ok) { onFlash('Кампания начата', true); setConfirmOpen(false); onRefresh(); }
      else onFlash(r.error ?? 'Ошибка', false);
    } catch (e) { onFlash(String(e), false); }
    finally { setStarting(false); }
  };

  const handleDeploy = async (c: MidCampaign) => {
    setDeploying(c.id);
    try {
      const r = await api.midCampaignsDeploy(guildId, c.id);
      if (r.ok) { onFlash('Вы участвуете в кампании', true); onRefresh(); }
      else onFlash(r.error ?? 'Ошибка', false);
    } catch (e) { onFlash(String(e), false); }
    finally { setDeploying(null); }
  };

  const handleCallToArms = async (c: MidCampaign) => {
    setCalling(c.id);
    try {
      const r = await api.midCampaignsCallToArms(guildId, c.id);
      if (r.ok) { onFlash('Союзники призваны на помощь', true); onRefresh(); }
      else onFlash(r.error ?? 'Ошибка', false);
    } catch (e) { onFlash(String(e), false); }
    finally { setCalling(null); }
  };

  const active = campaigns?.active ?? [];
  const recent = campaigns?.recent ?? [];

  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, overflow: 'hidden', mb: 3 }}>
      <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <FlameIcon size={16} />
          <Text sx={{ fontWeight: 'bold', fontSize: 2 }}>Кампании</Text>
          <Label variant="default" sx={{ fontSize: 0 }}>{active.length} активных</Label>
        </Box>
        <Button variant="danger" leadingVisual={PlusIcon} disabled={!campaigns} onClick={() => setPickerOpen(true)}>
          Начать кампанию
        </Button>
      </Box>

      <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {!campaigns
          ? <Text sx={{ color: 'fg.muted', fontSize: 1 }}>Нет данных по кампаниям — нажмите «Обновить» у этой гильдии</Text>
          : active.length === 0
          ? <Text sx={{ color: 'fg.muted', fontSize: 1 }}>Активных кампаний нет</Text>
          : active.map(c => {
            const mine = c.my_side === 'attacker' ? c.attacker : c.defender;
            const enemy = c.my_side === 'attacker' ? c.defender : c.attacker;
            return (
              <Box key={c.id} sx={{ border: '1px solid', borderColor: 'border.muted', borderRadius: 2, p: 2 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, mb: 1, flexWrap: 'wrap' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <GuildAvatar photo={enemy.guild_photo} title={enemy.guild_title} size={32} />
                    <Box>
                      <Text sx={{ fontSize: 1, fontWeight: 'semibold', display: 'block' }}>{enemy.guild_title}</Text>
                      <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                        {c.my_side === 'attacker' ? 'Мы атакуем' : 'Нас атакуют'} · осталось {timeLeft(c.ends_at)}
                      </Text>
                    </Box>
                  </Box>
                  {c.win_chance != null && (
                    <Label variant={c.win_chance >= 50 ? 'success' : 'danger'} sx={{ fontSize: 0 }}>
                      Шанс победы: {Math.round(c.win_chance)}%
                    </Label>
                  )}
                </Box>
                <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 2 }}>
                  Наша мощь {mine.power ?? '—'} ({mine.deployed_count ?? 0} чел.) vs {enemy.power ?? '—'} ({enemy.deployed_count ?? 0} чел.)
                </Text>
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                  <Button
                    variant={c.my_deployed ? 'default' : 'primary'} leadingVisual={RocketIcon}
                    loading={deploying === c.id} disabled={!!c.my_deployed || c.can_deploy === false} onClick={() => handleDeploy(c)}
                  >
                    {c.my_deployed ? 'Вы уже в бою' : 'Вступить в бой'}
                  </Button>
                  {c.my_side === 'defender' && (
                    <Button
                      leadingVisual={MegaphoneIcon}
                      loading={calling === c.id} disabled={c.can_call_to_arms === false} onClick={() => handleCallToArms(c)}
                    >
                      Призвать союзников
                    </Button>
                  )}
                </Box>
              </Box>
            );
          })}
      </Box>

      {recent.length > 0 && (
        <>
          <Box sx={{ px: 3, py: 1, borderTop: '1px solid', borderColor: 'border.muted' }}>
            <Text sx={{ fontSize: 0, color: 'fg.muted', fontWeight: 'bold' }}>Недавние кампании</Text>
          </Box>
          <Box sx={{ p: 3, pt: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {recent.slice(0, 10).map(c => {
              const enemy = c.my_side === 'attacker' ? c.defender : c.attacker;
              const won = c.attacker_won == null ? null : (c.my_side === 'attacker') === c.attacker_won;
              return (
                <Box key={c.id} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: '4px' }}>
                  <Label variant={won ? 'success' : 'danger'} sx={{ fontSize: 0, flexShrink: 0 }}>{won ? 'Победа' : 'Поражение'}</Label>
                  <Text sx={{ fontSize: 0, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{enemy.guild_title}</Text>
                  {(c.coins_taken || c.crystals_taken) ? (
                    <Text sx={{ fontSize: 0, color: won ? 'success.fg' : 'danger.fg', flexShrink: 0 }}>
                      {won ? '+' : '−'}{c.coins_taken ? `🪙${c.coins_taken.toLocaleString('ru')}` : ''}{c.crystals_taken ? ` 💎${c.crystals_taken}` : ''}
                    </Text>
                  ) : null}
                </Box>
              );
            })}
          </Box>
        </>
      )}

      <GuildPicker open={pickerOpen} onClose={() => setPickerOpen(false)} guildId={guildId} type="enemies" title="Выбрать цель кампании" onSelect={handlePickerSelect} />
      <CampaignStartModal open={confirmOpen} guild={selectedGuild} config={campaigns?.config ?? null} onClose={() => setConfirmOpen(false)} onConfirm={handleStart} loading={starting} />
    </Box>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

interface MidGuildData {
  guildId: string;
  guildTitle: string;
  data: (MidLiveData & { updated_at?: string }) | null;
  loading: boolean;
  refreshing: boolean;
  error?: string;
}

export function Mid() {
  const [guilds, setGuilds] = useState<MidGuildData[]>([]);
  const [pageLoading, setPageLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const { flash, showFlash } = useFlash();

  const loadFromDb = useCallback(async (guildId: string, guildTitle: string): Promise<MidGuildData> => {
    try {
      const data = await api.midOverview(guildId);
      return { guildId, guildTitle, data: data.ok ? data : null, loading: false, refreshing: false, error: data.ok ? undefined : data.error };
    } catch (e) {
      return { guildId, guildTitle, data: null, loading: false, refreshing: false, error: String(e) };
    }
  }, []);

  const load = useCallback(async () => {
    setPageLoading(true);
    try {
      const [g, sb] = await Promise.all([api.guilds(), api.specialBuildings()]);
      if (!g.ok) return;
      // показываем только гильдии, где есть здание МИД (определяется через /capitals/progress)
      const ministrySet = new Set((sb.ok ? sb.rows : []).filter(r => r.ministry_level != null).map(r => r.guild_id));
      const leaderGuilds = g.rows.filter(r => r.role === 'Leader' && ministrySet.has(r.guild_id));
      setGuilds(leaderGuilds.map(r => ({ guildId: r.guild_id, guildTitle: r.guild_title, data: null, loading: true, refreshing: false })));
      setPageLoading(false);
      await Promise.all(leaderGuilds.map(async r => {
        const res = await loadFromDb(r.guild_id, r.guild_title);
        setGuilds(prev => prev.map(x => x.guildId === r.guild_id ? res : x));
      }));
    } finally { setPageLoading(false); }
  }, [loadFromDb]);

  // верхняя «Обновить»: 1) пересканировать наличие зданий (/capitals/progress),
  // 2) запросить полные данные МИД с игры по всем найденным гильдиям.
  const scanAndLoad = useCallback(async () => {
    setScanning(true);
    try {
      await api.specialBuildingsRefresh().catch(() => {});
      const [g, sb] = await Promise.all([api.guilds(), api.specialBuildings()]);
      if (!g.ok) return;
      const ministrySet = new Set((sb.ok ? sb.rows : []).filter(r => r.ministry_level != null).map(r => r.guild_id));
      const leaderGuilds = g.rows.filter(r => r.role === 'Leader' && ministrySet.has(r.guild_id));
      // показать гильдии со спиннерами загрузки
      setPageLoading(false);
      setGuilds(leaderGuilds.map(r => ({ guildId: r.guild_id, guildTitle: r.guild_title, data: null, loading: true, refreshing: false })));
      // полные данные МИД с сервера игры — обновляем каждую гильдию по мере ответа
      await Promise.all(leaderGuilds.map(async r => {
        try {
          const data = await api.midRefresh(r.guild_id);
          setGuilds(prev => prev.map(x => x.guildId === r.guild_id
            ? { ...x, data: data.ok ? data : null, loading: false, error: data.ok ? undefined : data.error }
            : x));
        } catch (e) {
          setGuilds(prev => prev.map(x => x.guildId === r.guild_id
            ? { ...x, loading: false, error: String(e) }
            : x));
        }
      }));
    } finally { setScanning(false); setPageLoading(false); }
  }, []);

  const refreshGuild = useCallback(async (guildId: string, guildTitle: string) => {
    setGuilds(prev => prev.map(g => g.guildId === guildId ? { ...g, refreshing: true } : g));
    try {
      const data = await api.midRefresh(guildId);
      setGuilds(prev => prev.map(g => g.guildId === guildId
        ? { ...g, data: data.ok ? data : null, refreshing: false, error: data.ok ? undefined : data.error }
        : g
      ));
    } catch (e) {
      setGuilds(prev => prev.map(g => g.guildId === guildId ? { ...g, refreshing: false, error: String(e) } : g));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // если верхнее "Обновить" (пересканирование + МИД по всем гильдиям) или обновление конкретной
  // гильдии всё ещё выполняется на сервере с прошлой загрузки страницы — восстанавливаем спиннеры
  // и ждём завершения (своя версия useResumableRefresh.ts: тут стейт "refreshing" живёт внутри
  // элементов массива guilds, а не отдельным useState, generic-хук на такое не рассчитан).
  const guildIds = guilds.map(g => g.guildId);
  useEffect(() => {
    if (!guildIds.length) return;
    let cancelled = false, timer: ReturnType<typeof setInterval> | null = null;
    const keys = ['specialBuildingsRefresh', ...guildIds.map(id => `midRefresh:${id}`)];
    const applyStatus = (running: Record<string, boolean>) => {
      setScanning(running['specialBuildingsRefresh'] ?? false);
      setGuilds(prev => prev.map(g => running[`midRefresh:${g.guildId}`] ? { ...g, refreshing: true } : g));
    };
    api.opStatus(keys).then(d => {
      if (cancelled || !d.ok) return;
      const anyRunning = keys.some(k => d.running[k]);
      if (!anyRunning) return;
      applyStatus(d.running);
      timer = setInterval(async () => {
        const d2 = await api.opStatus(keys);
        if (cancelled || !d2.ok) return;
        if (!keys.some(k => d2.running[k])) {
          if (timer) clearInterval(timer);
          setScanning(false);
          load();
        } else applyStatus(d2.running);
      }, 1500);
    }).catch(() => {});
    return () => { cancelled = true; if (timer) clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildIds.join(',')]);

  if (pageLoading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Heading as="h2" sx={{ fontSize: 3 }}>МИД</Heading>
        <Button leadingVisual={SyncIcon} loading={scanning} onClick={scanAndLoad}>Обновить</Button>
      </Box>

      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      {guilds.length === 0 && (
        <Text sx={{ color: 'fg.muted' }}>Нет гильдий с МИД. Нажмите «Обновить», чтобы определить наличие здания с сервера игры.</Text>
      )}

      {guilds.map(g => (
        <Box key={g.guildId} sx={{ mb: 4 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
            <Box>
              <Heading as="h3" sx={{ fontSize: 2 }}>{g.guildTitle}</Heading>
              {g.data?.updated_at && (
                <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                  Обновлено: {new Date(g.data.updated_at).toLocaleString('ru')}
                </Text>
              )}
            </Box>
            <Button leadingVisual={SyncIcon} loading={g.refreshing} onClick={() => refreshGuild(g.guildId, g.guildTitle)} disabled={g.loading || g.refreshing}>
              Обновить
            </Button>
          </Box>

          {g.loading && <Box sx={{ p: 3, display: 'flex', justifyContent: 'center' }}><Spinner /></Box>}
          {g.error && <Flash variant="danger" sx={{ mb: 2 }}>{g.error}</Flash>}
          {!g.loading && g.data?.ok && !g.data.alliances && (
            <Text sx={{ fontSize: 1, color: 'fg.muted', mb: 2, display: 'block' }}>
              Нет сохранённых данных. Нажмите «Обновить» у этой гильдии, чтобы загрузить с сервера игры.
            </Text>
          )}

          {!g.loading && g.data?.ok && g.data.alliances && g.data.enemies && (
            <>
              <AllianceSection
                guildId={g.guildId}
                alliances={g.data.alliances}
                requests={g.data.requests}
                onRefresh={() => { void refreshGuild(g.guildId, g.guildTitle); }}
                onFlash={showFlash}
              />
              <EnemySection
                guildId={g.guildId}
                enemies={g.data.enemies}
                onRefresh={() => { void refreshGuild(g.guildId, g.guildTitle); }}
                onFlash={showFlash}
              />
              <CampaignsSection
                guildId={g.guildId}
                campaigns={g.data.campaigns}
                onRefresh={() => { void refreshGuild(g.guildId, g.guildTitle); }}
                onFlash={showFlash}
              />
            </>
          )}
        </Box>
      ))}
    </Box>
  );
}
