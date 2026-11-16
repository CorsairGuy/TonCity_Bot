import { useState, useEffect, useRef } from 'react';
import { Box, Button, Flash, Heading, Spinner, Text, ToggleSwitch } from '@primer/react';
import { Dialog } from '@primer/react/experimental';
import { AlertIcon, CheckIcon, GearIcon, SyncIcon } from '@primer/octicons-react';
import { api, type GuildQuestGroup, type GuildQuest } from '../api';
import { fmt, ITEMS_BY_ID, itemImgSrc } from '../utils';
import { LoadError } from '../components/LoadError';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { RenownValue } from '../components/Icons';
import { richHeader, RichBody, RichFooter } from '../components/RichDialog';

// автовыполнение гильдейских квестов — тумблеры пишут/читают questAutomation в общих настройках
// бота (/api/config), сам цикл — modules/questAutomation.js. КВЕСТ-ОСОЗНАННОЕ: действие выполняется,
// только если у аккаунта прямо сейчас есть подходящий незавершённый квест (см. комментарий в
// самом модуле про соответствие типов квестов действиям).
// Активация ускорителя убрана из автоматики (22.07.2026) — это намеренное решение игрока (тратит
// инвентарь, блокирует другие типы ускорителей на часы/сутки), теперь только кнопка "Активировать"
// прямо на строке квеста (см. QuestRow), не фоновый тумблер.
const AUTOMATION_ITEMS: Record<string, { title: string; quest: string }> = {
  ads: { title: 'Смотреть рекламу', quest: 'Квест «Просмотрите N роликов»' },
  sudoku: { title: 'Судоку', quest: 'Квест «Выиграйте N мини-игр» · Оплот Мудрости' },
  minesweeper: { title: 'Сапёр', quest: 'Квест «Выиграйте N мини-игр» · Оплот Мудрости' },
  quiz: { title: 'Викторина', quest: 'Квест «Выиграйте N мини-игр» · Оплот Мудрости' },
  staking: { title: 'Застейкать активы', quest: 'Квест на стейкинг · сумма из Настроек' },
};
const AUTOMATION_ORDER = ['ads', 'sudoku', 'minesweeper', 'quiz', 'staking'];

function AutomationSettingsModal({ onClose }: { onClose: () => void }) {
  const [values, setValues] = useState<Record<string, boolean> | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const { flash, showFlash } = useFlash();

  useEffect(() => {
    (async () => {
      try {
        const d = await api.config();
        if (d.ok) {
          const qa = (d.settings.questAutomation as Record<string, boolean>) ?? {};
          setValues(Object.fromEntries(AUTOMATION_ORDER.map(k => [k, !!qa[k]])));
        } else showFlash('Ошибка загрузки настроек', false);
      } catch (e) { showFlash(String(e), false); }
    })();
  }, []);

  const toggle = async (key: string) => {
    if (!values) return;
    const next = !values[key];
    setValues({ ...values, [key]: next });
    setSaving(key);
    try {
      const r = await api.saveConfig({ questAutomation: { [key]: next } });
      if (!r.ok) { showFlash(r.error ?? 'Ошибка сохранения', false); setValues(v => v && ({ ...v, [key]: !next })); }
    } catch (e) { showFlash(String(e), false); setValues(v => v && ({ ...v, [key]: !next })); }
    finally { setSaving(null); }
  };

  return (
    <Dialog
      title="Автовыполнение квестов"
      subtitle="Бот делает действие, только если под него есть живой квест гильдии"
      renderHeader={richHeader(GearIcon)}
      onClose={onClose}
      width="large"
      position={{ narrow: 'bottom', regular: 'center' }}
      renderFooter={() => <RichFooter><Button variant="primary" onClick={onClose}>Готово</Button></RichFooter>}
    >
      <RichBody>
        {flash && <Flash variant={flash.ok ? 'success' : 'danger'}>{flash.msg}</Flash>}
        <details className="rdlg-note rdlg-note--info" style={{ display: 'block' }}>
          <summary>Как это работает</summary>
          <Text as="p" sx={{ m: 0, mt: 2 }}>
            Раз в день бот смотрит квесты гильдии каждого аккаунта и выполняет действие, только если под
            него есть незавершённый квест, иначе ничего не трогает. Сразу после действия проверяет, выполнены
            ли оба условия (личное и общее), и сам забирает награду. Невозможные боту квесты (приглашения)
            не автоматизируются: кнопка забрать награду появится на строке квеста, если условие выполнится иначе.
          </Text>
        </details>
        {!values
          ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><Spinner /></Box>
          : <div>{AUTOMATION_ORDER.map(key => (
            <div key={key} className="rdlg-tg">
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Text sx={{ fontWeight: 600, fontSize: 1, display: 'block' }}>{AUTOMATION_ITEMS[key].title}</Text>
                <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{AUTOMATION_ITEMS[key].quest}</Text>
              </Box>
              <ToggleSwitch size="small" checked={values[key]} disabled={saving === key} onClick={() => toggle(key)}
                aria-label={AUTOMATION_ITEMS[key].title} statusLabelPosition="end" />
            </div>
          ))}</div>}
        <div className="rdlg-note rdlg-note--warn">
          <AlertIcon size={16} />
          <span>Квесты с тратой монет и алмазов (рынок, буст гильдии, покупка алмазов) бот не выполняет.</span>
        </div>
      </RichBody>
    </Dialog>
  );
}

// Колонки времени и Почёта — одинаковая фиксированная ширина, чтобы ряды
// выравнивались друг под другом независимо от длины текста времени
const RIGHT_COL_WIDTH = 60;

// цвет рамки по редкости (как в игре)
const RARITY_BORDER: Record<string, string> = {
  common: '#6e7681', uncommon: '#27AE60', rare: '#2E86C1', epic: '#8E44AD',
  legendary: '#D4AC0D', mythic: '#C0392B', eternal: '#C0392B',
};

// дни+часы → часы+минуты → минуты
function timeLeft(iso?: string): { text: string; soon: boolean; over: boolean } {
  if (!iso) return { text: '—', soon: false, over: false };
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return { text: 'истёк', soon: false, over: true };
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000);
  const text = d > 0 ? `${d}д ${h}ч` : h > 0 ? `${h}ч ${m}м` : `${m}м`;
  return { text, soon: ms < 86400000, over: false };
}

// подстановка чисел в описание (description_variables) + перевод
function questText(loc: { en?: string; ru?: string }, vars: Record<string, string | number> | null): string {
  let s = loc?.ru || loc?.en || '';
  if (vars) for (const [k, v] of Object.entries(vars)) {
    const val = typeof v === 'number' ? fmt(v) : String(v);
    s = s.replace(new RegExp(`\\{\\{?${k}\\}?\\}`, 'g'), val);
  }
  return s;
}

// ── модалка "Выполнить": все аккаунты гильдии по ОДНОМУ квесту ──────────────────
// В гильдии обычно несколько своих аккаунтов, и у каждого свой personal_progress по одному и тому же
// квесту (общее условие — общее на всех). Раньше действие можно было запустить только из строки
// конкретного аккаунта; теперь одна кнопка "Выполнить" открывает список всех аккаунтов этой гильдии
// с их прогрессом и персональной кнопкой Активировать/Комбинировать (тип действия — от типа квеста).
// Данные берём из уже загруженного снимка (БД), живьём обновляем ответами на сами действия.
type QuestAcc = { account: string; accountId: number | null; q: GuildQuest; updatedAt: string | undefined };

// Типы квестов, по которым бот умеет выполнить условие сам (кнопка "Выполнить" + модалка).
// Всё остальное — только заклейм по готовности.
const ACTIONABLE_QUEST_TYPES = new Set(['booster_activate', 'booster_combine', 'guild_boost']);

function QuestDoModal({ rows: initialRows, quest, missing, onClose, onChanged, claiming }: {
  rows: QuestAcc[]; quest: GuildQuest; missing: { account: string; updated_at?: string }[]; onClose: () => void; onChanged: (account: string, q: GuildQuest) => void; claiming: Set<string>;
}) {
  const [rows, setRows] = useState<QuestAcc[]>(initialRows);
  const [busy, setBusy] = useState<string | null>(null);
  const { flash, showFlash } = useFlash();
  const busyRef = useRef(false);
  useEffect(() => { if (!busyRef.current) setRows(initialRows); }, [initialRows]);
  const first = quest;
  const isCombine = first.type === 'booster_combine';
  const isBooster = isCombine || first.type === 'booster_activate';
  const isGuildBoost = first.type === 'guild_boost';
  const label = isCombine ? 'Комбинировать' : 'Активировать';
  // сколько алмазов спишется этим нажатием: пока не закрыто личное — за личное, дальше за общее
  const boostCost = (q: GuildQuest): number | null => {
    const personalLeft = q.personal_progress < q.personal_threshold;
    return personalLeft ? (q.boost_cost_personal ?? null) : (q.boost_cost_guild ?? null);
  };

  // заклейм — тоже здесь: у каждого аккаунта своя награда за один и тот же квест гильдии
  const collect = async (r: QuestAcc) => {
    if (!r.accountId || busyRef.current) return;
    busyRef.current = true; setBusy(r.account);
    try {
      const res = await api.guildQuestCollect(r.accountId, r.q.id);
      // строку обновляем по свежему квесту с сервера В ЛЮБОМ случае: на ошибке он тоже приходит,
      // и без этого кнопка «Заклеймить» оставалась бы на уже собранном квесте
      const done = res.quest ?? { ...r.q, is_collected: res.ok ? true : r.q.is_collected };
      setRows(prev => prev.map(x => x.account === r.account ? { ...x, q: done } : x));
      onChanged(r.account, done);
      if (res.ok) showFlash(`[${r.account}] ${res.already ? 'награда уже была забрана' : 'награда забрана'}`, true);
      else showFlash(`[${r.account}] ${res.error ?? 'ошибка заклейма'}`, false);
    } catch (e) { showFlash(String(e), false); } finally { busyRef.current = false; setBusy(null); }
  };

  const run = async (r: QuestAcc) => {
    if (!r.accountId || busyRef.current) return;
    busyRef.current = true; setBusy(r.account);
    try {
      const res = isGuildBoost
        ? await api.guildQuestGuildBoost(r.accountId, r.q.id)
        : isCombine
          ? await api.guildQuestCombineBooster(r.accountId, r.q.id)
          : await api.guildQuestActivateBooster(r.accountId, r.q.id);
      if (res.ok) {
        const spent = 'spent' in res && res.spent != null ? ` (−${fmt(res.spent)} 💎)` : '';
        showFlash(res.collected ? `[${r.account}] готово${spent} — награда забрана` : `[${r.account}] готово${spent}`, true);
        if (res.quest) {
          const fresh = res.quest;
          // общее условие — общее на всю гильдию: подтягиваем его во ВСЕ строки, личное — только в свою
          setRows(prev => prev.map(x => x.account === r.account
            ? { ...x, q: fresh }
            : { ...x, q: { ...x.q, guild_progress: fresh.guild_progress, guild_threshold: fresh.guild_threshold } }));
          onChanged(r.account, fresh);
        }
      } else {
        // даже при отказе сервер отдаёт СВЕЖИЙ квест — применяем, иначе строка застревает на
        // устаревшем прогрессе и, например, не показывает появившуюся кнопку заклейма
        const fresh = (res as { quest?: GuildQuest | null }).quest;
        if (fresh) setRows(prev => prev.map(x => x.account === r.account
          ? { ...x, q: fresh }
          : { ...x, q: { ...x.q, guild_progress: fresh.guild_progress, guild_threshold: fresh.guild_threshold } }));
        showFlash(`[${r.account}] ${res.error ?? 'ошибка'}`, false);
      }
    } catch (e) { showFlash(String(e), false); } finally { busyRef.current = false; setBusy(null); }
  };

  return (
    <Dialog
      title={questText(first.name, first.description_variables)}
      onClose={busy ? () => {} : onClose}
      width="xlarge"
      position={{ narrow: 'bottom', regular: 'center' }}
    >
      <Box sx={{ p: 3 }}>
        <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 2 }}>
          {questText(first.description, first.description_variables)}
        </Text>
        <Text sx={{ fontSize: 1, display: 'block', mb: 3 }}>
          Общее условие: <b>{fmt(first.guild_progress)}/{fmt(first.guild_threshold)}</b>
        </Text>
        {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3, fontSize: 0, py: 1 }}>{flash.msg}</Flash>}
        <Box sx={{ border: '1px solid', borderColor: 'border.muted', borderRadius: 2, overflow: 'hidden' }}>
          {rows.map(r => {
            const have = r.q.booster_owned;
            const need = r.q.booster_needed;
            const notEnough = have != null && need != null && have < need;
            const blockedMs = r.q.booster_blocked_until ? new Date(r.q.booster_blocked_until).getTime() : 0;
            const blocked = blockedMs > Date.now();
            const done = r.q.personal_progress >= r.q.personal_threshold;
            const isClaiming = claiming.has(`${r.account}:${r.q.id}`);
            // занятость слотов ускорителей, напр. « (2/4)» — сколько сейчас активно из лимита
            const slots = r.q.booster_slots_limit != null && r.q.booster_slots_used != null
              ? ` (${r.q.booster_slots_used}/${r.q.booster_slots_limit})` : '';
            // бусты гильдии: стоимость текущего шага в алмазах + хватает ли баланса
            const cost = isGuildBoost ? boostCost(r.q) : null;
            const noCrystals = isGuildBoost && cost != null && (r.q.account_crystals ?? 0) < cost;
            // оба условия выполнены → вместо действия предлагаем забрать награду
            const ready = !r.q.is_collected && done && r.q.guild_progress >= r.q.guild_threshold;
            return (
              <Box key={r.account} sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 2, py: '8px', borderBottom: '1px solid', borderColor: 'border.muted' }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Text sx={{ fontSize: 1, display: 'block' }}>{r.account}</Text>
                  <Text sx={{ fontSize: 0, color: done ? 'success.fg' : 'fg.muted', display: 'block' }}>
                    личное: {fmt(r.q.personal_progress)}/{fmt(r.q.personal_threshold)}
                  </Text>
                  <Text sx={{ fontSize: 0, color: 'fg.subtle', display: 'block' }}>{r.updatedAt ? `Снимок от ${new Date(r.updatedAt).toLocaleString('ru')}` : 'Время личного снимка неизвестно'}</Text>
                </Box>
                {isBooster && !ready && (blocked
                  ? <Text sx={{ fontSize: 0, color: 'attention.fg', whiteSpace: 'nowrap' }}
                      title="Ждём освобождения БЛИЖАЙШЕГО слота, а не всех сразу">
                      слот{slots} до {new Date(blockedMs).toLocaleString('ru')}
                    </Text>
                  : have != null && (
                      <Text sx={{ fontSize: 0, color: notEnough ? 'danger.fg' : 'fg.muted', whiteSpace: 'nowrap' }}>
                        есть {fmt(have)}{need != null && need > 1 ? ` / ${fmt(need)}` : ''}{slots}
                      </Text>
                    ))}
                {isGuildBoost && !ready && r.q.account_crystals != null && (
                  <Text sx={{ fontSize: 0, color: noCrystals ? 'danger.fg' : 'fg.muted', whiteSpace: 'nowrap' }}>
                    есть {fmt(r.q.account_crystals)} 💎
                  </Text>
                )}
                {r.q.is_collected
                  ? <CheckIcon size={16} fill="var(--green)" />
                  : ready
                    ? <Button size="small" variant="primary" loading={busy === r.account || isClaiming}
                        disabled={busy != null || isClaiming || !r.accountId}
                        onClick={() => collect(r)}>{isClaiming ? 'Забираем…' : 'Заклеймить'}</Button>
                    : isBooster
                      ? <Button size="small" loading={busy === r.account}
                          disabled={busy != null || !r.accountId || notEnough || blocked}
                          onClick={() => run(r)}>{label}</Button>
                      : isGuildBoost
                        // сумма прямо на кнопке — списание видно ДО нажатия
                        ? <Button size="small" loading={busy === r.account}
                            disabled={busy != null || !r.accountId || cost == null || cost <= 0 || noCrystals}
                            onClick={() => run(r)}>
                            {cost != null ? `Забустить (${fmt(cost)} 💎)` : 'Забустить'}
                          </Button>
                        : <Text sx={{ fontSize: 0, color: 'fg.subtle', whiteSpace: 'nowrap' }}>ждём условий</Text>}
              </Box>
            );
          })}
          {missing.map(r => <Box key={r.account} sx={{ px: 2, py: 2, borderTop: '1px solid', borderColor: 'border.muted' }}><Text sx={{ display: 'block' }}>{r.account}</Text><Text sx={{ fontSize: 0, color: 'fg.muted' }}>Личный прогресс этого квеста не сохранён. Действия недоступны без собственного снимка аккаунта.</Text></Box>)}
          {!rows.length && !missing.length && <Text sx={{ p: 2, color: 'fg.muted' }}>Нет личных снимков действующих участников для этого квеста.</Text>}
        </Box>
      </Box>
    </Dialog>
  );
}

function QuestRow({ q, onCollected, siblings, missing, claiming }: {
  q: GuildQuest; onCollected: () => void; siblings: QuestAcc[];
  missing: { account: string; updated_at?: string }[]; claiming: Set<string>;
}) {
  const meta = ITEMS_BY_ID[q.reward_item_id];
  const border = RARITY_BORDER[q.rarity] ?? '#6e7681';
  const t = timeLeft(q.expires_at);
  const name = questText(q.name, q.description_variables);
  const desc = questText(q.description, q.description_variables);
  const ready = siblings.some(r => !r.q.is_collected && r.q.personal_progress >= r.q.personal_threshold && r.q.guild_progress >= r.q.guild_threshold);
  const actionable = ACTIONABLE_QUEST_TYPES.has(q.type);
  const [doOpen, setDoOpen] = useState(false);
  const claimingNow = siblings.some(r => claiming.has(`${r.account}:${q.id}`));
  return (
    // className quest-row* — раскладка для телефона (см. global.css): иконка и текст сверху,
    // таймер/почёт и кнопка — отдельной строкой снизу, чтобы кнопка не наезжала на описание
    <Box className="quest-row" sx={{
      display: 'flex', alignItems: 'center', gap: '12px', p: '8px', mb: '8px',
      border: '2px solid', borderColor: border, borderRadius: '21px', bg: 'canvas.default',
    }}>
      {/* награда: карточка предмета как на странице инвентаря (56px) */}
      <div className={`item-card__box${meta ? ` ic-${meta.tag}` : ' ic-common'}`} style={{ flexShrink: 0, width: 56, height: 56 }}>
        {meta
          ? <img className="item-card__img" src={itemImgSrc(meta.tag)} alt="" style={{ scale: String(meta.scale), height: 56 }}
              onError={e => { (e.target as HTMLImageElement).style.opacity = '.3'; }} />
          : <span style={{ fontSize: 10, textAlign: 'center', padding: 4 }}>#{q.reward_item_id}</span>}
        <span className="item-card__count">{q.reward_amount}</span>
      </div>

      {/* текст */}
      <Box className="quest-row__text" sx={{ flex: 1, minWidth: 0 }}>
        <Text sx={{ fontWeight: 'bold', fontSize: 1, display: 'block' }}>{name}</Text>
        <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: '2px' }}>
          {desc} [Общее: {fmt(q.guild_progress)}/{fmt(q.guild_threshold)}]
        </Text>
      </Box>
      <Button className="quest-row__btn" size="small" variant={ready ? 'primary' : 'default'} onClick={() => setDoOpen(true)}>
        {claimingNow ? 'Забираем…' : ready ? 'Забрать награды' : actionable ? 'Выполнить' : 'Личный прогресс'}
      </Button>
      {doOpen && <QuestDoModal quest={q} rows={siblings} missing={missing} claiming={claiming} onClose={() => setDoOpen(false)} onChanged={() => onCollected()} />}

      {/* Время и Почёт относятся к общему квесту; личные отметки — только в окне аккаунтов. */}
      <Box className="quest-row__meta" sx={{ flexShrink: 0, display: 'flex', alignItems: 'center', pr: '4px' }}>
        <Box sx={{ width: RIGHT_COL_WIDTH, flexShrink: 0, textAlign: 'center' }}>
          <Text className="mono" sx={{ fontSize: 1, fontWeight: 'bold', color: t.over ? 'fg.muted' : t.soon ? 'attention.fg' : 'success.fg' }}>{t.text}</Text>
        </Box>
        <Box sx={{ width: RIGHT_COL_WIDTH, flexShrink: 0, textAlign: 'center' }}>
          {!!q.renown_reward && (
            <Text className="mono" sx={{ fontSize: 0, fontWeight: 'bold', color: '#e8930c' }}>
              <RenownValue value={`+${fmt(q.renown_reward)}`} />
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}

export function Quests() {
  const [groups, setGroups] = useState<GuildQuestGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadSerial = useRef(0);
  const { flash, showFlash } = useFlash();

  // silent=true — обновление ПОСЛЕ действия на странице (заклейм/активация/комбинирование), список
  // остаётся на экране, страница не мигает во весь экран спиннером и не прыгает в начало скролла
  // (что и происходило раньше: setLoading(true) размонтировал весь список ради центрированного
  // спиннера на всю высоту, потом список монтировался заново — скролл сбрасывался наверх)
  const load = async (opts?: { silent?: boolean }) => {
    const serial = ++loadSerial.current;
    if (!opts?.silent) setLoading(true);
    try {
      const d = await api.guildQuests();
      if (serial !== loadSerial.current) return false;
      if (d.ok) { setGroups(d.guilds); setLoadError(null); return true; }
      setLoadError(d.error ?? 'Ошибка чтения сохранённых квестов'); return false;
    } catch (e) { if (serial === loadSerial.current) setLoadError(String(e)); return false; } finally { if (serial === loadSerial.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { loadSerial.current++; }; }, []);
  const silentReload = () => { load({ silent: true }); };

  // Идущие ПРЯМО СЕЙЧАС автозаклеймы (после активации/комбинирования либо фоновым циклом) — по SSE,
  // ключ `${аккаунт}:${quest_id}`. Нужно, чтобы кнопка «Заклеймить» показывала «Забираем…» и было
  // видно, что жать её не надо. Снимок текущего состояния приходит первым сообщением, поэтому
  // работает и после F5 (см. web/lib/questClaimProgress.js).
  const [claiming, setClaiming] = useState<Set<string>>(new Set());
  useEffect(() => {
    const es = new EventSource('/api/guild-quests/claim-stream');
    es.onmessage = ev => {
      try {
        const d = JSON.parse(ev.data) as { type: string; account?: string; quest_id?: number; items?: { account: string; quest_id: number }[] };
        if (d.type === 'snapshot') setClaiming(new Set((d.items ?? []).map(i => `${i.account}:${i.quest_id}`)));
        else if (d.type === 'begin') setClaiming(p => new Set(p).add(`${d.account}:${d.quest_id}`));
        else if (d.type === 'end') {
          setClaiming(p => { const s = new Set(p); s.delete(`${d.account}:${d.quest_id}`); return s; });
          load({ silent: true });   // заклейм завершился — подтянуть актуальный is_collected
        }
      } catch { /* мусорная строка потока — игнорируем */ }
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // «Обновить» — один успешный запрос списка на гильдию с выбором доступного участника. Список из
  // БД и по сути ничего не обновляла). Долгая операция, поэтому с loading-состоянием, как на
  // остальных страницах; переживает перезагрузку вкладки через useResumableRefresh.
  const [refreshing, setRefreshing] = useResumableRefresh('guildQuestsRefresh', () => load({ silent: true }));
  const refresh = async () => {
    setRefreshing(true);
    try {
      const d = await api.guildQuestsRefresh();
      if (d.ok) {
        const errs = (d.results ?? []).filter(r => !r.ok && r.error !== 'нет токена');
        if (!await load({ silent: true })) return;
        showFlash(errs.length ? `Часть списков не обновлена: ${errs.map(e => `${e.name}: ${e.error ?? 'нет доступа'}`).join('; ')}` : 'Обновлено', errs.length === 0);
      } else showFlash(d.error || 'Ошибка', false);
    } catch (e) { showFlash(String(e), false); } finally { setRefreshing(false); }
  };

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  return (
    <Box sx={{ p: 3 }}>
      {/* кнопки — справа, на одном уровне с заголовком страницы */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Heading as="h2" sx={{ fontSize: 3 }}>Квесты</Heading>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refresh}>Обновить</Button>
          <Button leadingVisual={GearIcon} onClick={() => setSettingsOpen(true)}>Автовыполнение</Button>
        </Box>
      </Box>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      {loadError && <LoadError error={loadError} onRetry={() => { void load({ silent: true }); }} />}
      {settingsOpen && <AutomationSettingsModal onClose={() => setSettingsOpen(false)} />}

      {!loadError && groups.length === 0
        ? <Text sx={{ color: 'fg.muted' }}>Нет сохранённых квестов актуальных гильдий. Нажмите «Обновить».</Text>
        : groups.map(g => {
          const personal = g.accounts ?? (g.account ? [{ account: g.account, account_id: g.account_id ?? null, quests: g.quests, updated_at: g.updated_at }] : []);
          return <Box key={g.guild_id} sx={{ mb: 4 }}>
            <Box sx={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 2, mb: 2 }}>
              <Text sx={{ fontWeight: 'bold', fontSize: 1, color: 'fg.muted' }}>{g.guild_title || g.guild_id}</Text>
              {g.updated_at && <Text sx={{ fontSize: 0, color: 'fg.subtle' }}>обновлено {new Date(g.updated_at).toLocaleString()}</Text>}
            </Box>
            {g.error && <Flash variant="warning" sx={{ mb: 2 }}>{g.error}{g.eligible_at && <> · доступ ожидается {new Date(g.eligible_at).toLocaleString('ru')}</>}</Flash>}
            {!g.quests.length
              ? !g.error && <Text sx={{ fontSize: 0, color: 'fg.muted' }}>{g.read_status === 'no_snapshot' ? 'Список ещё не сохранён — нажмите «Обновить»' : 'Нет активных квестов'}</Text>
              : [...g.quests].sort((a, b) => a.id - b.id).map(q => <QuestRow key={q.id} q={q} onCollected={silentReload} claiming={claiming}
                siblings={personal.map(x => { const own = x.quests.find(y => y.id === q.id); return { account: x.account, accountId: x.account_id, updatedAt: x.updated_at, q: own ? { ...own, guild_progress: q.guild_progress, guild_threshold: q.guild_threshold } : undefined }; }).filter((x): x is QuestAcc => !!x.q)}
                missing={personal.filter(x => !x.quests.some(y => y.id === q.id)).map(x => ({ account: x.account, updated_at: x.updated_at }))} />)}
          </Box>;
        })}

    </Box>
  );
}
