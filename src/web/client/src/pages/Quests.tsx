import { useState, useEffect } from 'react';
import { Box, Button, Flash, Heading, Spinner, Text, ToggleSwitch } from '@primer/react';
import { Dialog } from '@primer/react/experimental';
import { AlertIcon, CheckIcon, GearIcon, SyncIcon } from '@primer/octicons-react';
import { api, type GuildQuestGroup, type GuildQuest } from '../api';
import { fmt, ITEMS_BY_ID, itemImgSrc } from '../utils';
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

// три колонки справа (галочка / время / почёт) — одинаковая фикс. ширина, чтобы ряды
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
type QuestAcc = { account: string; accountId: number | null; q: GuildQuest };

// Типы квестов, по которым бот умеет выполнить условие сам (кнопка "Выполнить" + модалка).
// Всё остальное — только заклейм по готовности.
const ACTIONABLE_QUEST_TYPES = new Set(['booster_activate', 'booster_combine', 'guild_boost']);

function QuestDoModal({ rows: initialRows, onClose, onChanged, claiming }: {
  rows: QuestAcc[]; onClose: () => void; onChanged: (account: string, q: GuildQuest) => void; claiming: Set<string>;
}) {
  const [rows, setRows] = useState<QuestAcc[]>(initialRows);
  const [busy, setBusy] = useState<string | null>(null);
  const { flash, showFlash } = useFlash();
  const first = rows[0]?.q;
  if (!first) return null;
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
    if (!r.accountId) return;
    setBusy(r.account);
    try {
      const res = await api.guildQuestCollect(r.accountId, r.q.id);
      // строку обновляем по свежему квесту с сервера В ЛЮБОМ случае: на ошибке он тоже приходит,
      // и без этого кнопка «Заклеймить» оставалась бы на уже собранном квесте
      const done = res.quest ?? { ...r.q, is_collected: res.ok ? true : r.q.is_collected };
      setRows(prev => prev.map(x => x.account === r.account ? { ...x, q: done } : x));
      onChanged(r.account, done);
      if (res.ok) showFlash(`[${r.account}] ${res.already ? 'награда уже была забрана' : 'награда забрана'}`, true);
      else showFlash(`[${r.account}] ${res.error ?? 'ошибка заклейма'}`, false);
    } catch (e) { showFlash(String(e), false); } finally { setBusy(null); }
  };

  const run = async (r: QuestAcc) => {
    if (!r.accountId) return;
    setBusy(r.account);
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
    } catch (e) { showFlash(String(e), false); } finally { setBusy(null); }
  };

  return (
    <Dialog
      title={questText(first.name, first.description_variables)}
      onClose={onClose}
      width="xlarge"
      position={{ narrow: 'bottom', regular: 'center' }}
    >
      <Box>
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
        </Box>
      </Box>
    </Dialog>
  );
}

function QuestRow({ q: qProp, accountId, account: ownAccount, onCollected, siblings, claiming, claimingNow }: {
  q: GuildQuest; accountId?: number | null; account: string; onCollected: () => void;
  siblings: QuestAcc[];          // все аккаунты этой гильдии по ЭТОМУ же квесту (для модалки "Выполнить")
  claiming: Set<string>; claimingNow: boolean;
}) {
  // Свежий квест, пришедший прямо в ответе на действие (активация/комбинирование): сервер ждёт,
  // пока игра реально учтёт прогресс, и возвращает актуальный объект. Показываем его сразу, не
  // дожидаясь перезагрузки списка — раньше прогресс обновлялся только со второго нажатия.
  // Как только придёт свежий список сверху (qProp меняется) — оверлей сбрасывается.
  const [fresh, setFresh] = useState<GuildQuest | null>(null);
  useEffect(() => { setFresh(null); }, [qProp]);
  const q = fresh ?? qProp;
  const meta = ITEMS_BY_ID[q.reward_item_id];
  const border = RARITY_BORDER[q.rarity] ?? '#6e7681';
  const t = timeLeft(q.expires_at);
  const name = questText(q.name, q.description_variables);
  const desc = questText(q.description, q.description_variables);
  // оба условия выполнены, но сервер ещё не отметил is_collected
  const readyToCollect = !q.is_collected && q.personal_progress >= q.personal_threshold && q.guild_progress >= q.guild_threshold;
  // Модалка "Выполнить" имеет смысл ТОЛЬКО там, где боту реально есть что сделать: активировать
  // ускоритель, скомбинировать ускорители, купить бусты гильдии. Остальные типы (реклама, рынок,
  // приглашения, мини-игры и т.д.) закрываются в самой игре или другими страницами бота — им
  // кнопка не нужна, у них только заклейм по готовности (прямо в строке, модалки нет).
  const actionable = !q.is_collected && ACTIONABLE_QUEST_TYPES.has(q.type);
  // Действия и остаток ускорителей — в модалке "Выполнить" (сразу по всем аккаунтам гильдии),
  // в самой строке их не дублируем.
  const [doOpen, setDoOpen] = useState(false);
  // заклейм в строке нужен только типам БЕЗ модалки (у остальных он внутри неё, по аккаунтам)
  const [collecting, setCollecting] = useState(false);
  const { flash, showFlash } = useFlash();
  const collect = async () => {
    if (!accountId) return;
    setCollecting(true);
    try {
      const r = await api.guildQuestCollect(accountId, q.id);
      // и при ошибке перечитываем список: сервер уже ресинкнул снимок, и квест мог оказаться
      // собранным — тогда строка сама перестанет предлагать заклейм
      onCollected();
      if (!r.ok) showFlash(r.error ?? 'Ошибка заклейма', false);
    } catch (e) { showFlash(String(e), false); } finally { setCollecting(false); }
  };

  return (
    // className quest-row* — раскладка для телефона (см. global.css): иконка и текст сверху,
    // таймер/почёт и кнопка — отдельной строкой снизу, чтобы кнопка не наезжала на описание
    <Box className="quest-row" sx={{
      display: 'flex', alignItems: 'center', gap: '12px', p: '8px', mb: '8px',
      border: '2px solid', borderColor: border, borderRadius: '21px', bg: 'canvas.default',
      opacity: q.is_collected ? 0.55 : 1,
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
          {desc} [Личное: {fmt(q.personal_progress)}/{fmt(q.personal_threshold)}]
          {q.guild_threshold > 1 && <> [Общее: {fmt(q.guild_progress)}/{fmt(q.guild_threshold)}]</>}
        </Text>
        {/* флеш нужен только для заклейма прямо в строке; результаты действий показывает модалка */}
        {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mt: 1, fontSize: 0, py: 1 }}>{flash.msg}</Flash>}
      </Box>

      {/* одна кнопка на квест: внутри — все аккаунты гильдии со своим прогрессом, действием
          (Активировать/Комбинировать) и заклеймом. Остаток ускорителей и занятость слота тоже
          показываются там — в строке квеста их намеренно нет, чтобы не дублировать */}
      {actionable && (
        <Button className="quest-row__btn" size="small" variant={readyToCollect ? 'primary' : 'default'} onClick={() => setDoOpen(true)}>
          {claimingNow ? 'Забираем…' : 'Выполнить'}
        </Button>
      )}

      {/* типы без действий бота: модалки у них нет, поэтому заклейм остаётся прямо в строке */}
      {!actionable && readyToCollect && (
        <Button className="quest-row__btn" size="small" variant="primary" loading={collecting || claimingNow}
          disabled={collecting || claimingNow || !accountId} onClick={collect}>
          {claimingNow ? 'Забираем…' : 'Заклеймить'}
        </Button>
      )}

      {doOpen && (
        <QuestDoModal
          rows={siblings}
          claiming={claiming}
          onClose={() => setDoOpen(false)}
          onChanged={(acc, fresh) => { if (acc === ownAccount) setFresh(fresh); onCollected(); }}
        />
      )}

      {/* галочка (получено) / время / почёт — фикс. ширина, чтобы колонки выравнивались по рядам */}
      <Box className="quest-row__meta" sx={{ flexShrink: 0, display: 'flex', alignItems: 'center', pr: '4px' }}>
        <Box sx={{ width: RIGHT_COL_WIDTH, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
          {q.is_collected && <CheckIcon size={16} fill="var(--green)" />}
        </Box>
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
  const { flash, showFlash } = useFlash();

  // silent=true — обновление ПОСЛЕ действия на странице (заклейм/активация/комбинирование), список
  // остаётся на экране, страница не мигает во весь экран спиннером и не прыгает в начало скролла
  // (что и происходило раньше: setLoading(true) размонтировал весь список ради центрированного
  // спиннера на всю высоту, потом список монтировался заново — скролл сбрасывался наверх)
  const load = async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const d = await api.guildQuests();
      if (d.ok) setGroups(d.guilds);
      else showFlash('Ошибка загрузки', false);
    } catch (e) { showFlash(String(e), false); } finally { if (!opts?.silent) setLoading(false); }
  };
  useEffect(() => { load(); }, []);
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

  // "Обновить" — живой перезапрос по всем аккаунтам (раньше кнопка просто перечитывала снимок из
  // БД и по сути ничего не обновляла). Долгая операция, поэтому с loading-состоянием, как на
  // остальных страницах; переживает перезагрузку вкладки через useResumableRefresh.
  const [refreshing, setRefreshing] = useResumableRefresh('guildQuestsRefresh', () => load({ silent: true }));
  const refresh = async () => {
    setRefreshing(true);
    try {
      const d = await api.guildQuestsRefresh();
      if (d.ok) {
        const errs = (d.results ?? []).filter(r => !r.ok && r.error !== 'нет токена');
        await load({ silent: true });
        showFlash(errs.length ? `Обновлено, без квестов: ${errs.map(e => e.name).join(', ')}` : 'Обновлено', errs.length === 0);
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
      {settingsOpen && <AutomationSettingsModal onClose={() => setSettingsOpen(false)} />}

      {groups.length === 0
        ? <Text sx={{ color: 'fg.muted' }}>Нет данных. Квесты собирает бот раз в день по каждому аккаунту — появятся после первого цикла.</Text>
        : groups.map(g => (
            // ключ включает аккаунт — своих аккаунтов в одной гильдии может быть несколько, у
            // каждого своя строка (своё personal_progress)
            <Box key={`${g.guild_id}:${g.account ?? ''}`} sx={{ mb: 4 }}>
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, mb: 2 }}>
                <Text sx={{ fontWeight: 'bold', fontSize: 1, color: 'fg.muted' }}>{g.guild_title || g.guild_id}</Text>
                {g.account && <Text sx={{ fontSize: 0, color: 'fg.subtle' }}>({g.account})</Text>}
                {g.updated_at && <Text sx={{ fontSize: 0, color: 'fg.subtle' }}>обновлено {new Date(g.updated_at).toLocaleString()}</Text>}
              </Box>
              {g.error
                ? <Text sx={{ fontSize: 0, color: 'danger.fg' }}>{g.error}</Text>
                : g.quests.length === 0
                  ? <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Нет активных квестов</Text>
                  // сортировка по id — игра НЕ гарантирует стабильный порядок квестов в ответе
                  // между запросами; без сортировки после каждого действия (заклейм/активация/
                  // комбинирование), которое перечитывает список заново, строки могли менять
                  // порядок в DOM и визуально "прыгать"/переставляться, даже без единого reload
                  : [...g.quests].sort((a, b) => a.id - b.id).map(q => (
                      <QuestRow
                        key={q.id}
                        q={q}
                        accountId={g.account_id}
                        account={g.account ?? ''}
                        onCollected={silentReload}
                        claiming={claiming}
                        claimingNow={claiming.has(`${g.account ?? ''}:${q.id}`)}
                        // все свои аккаунты ЭТОЙ гильдии, у которых есть этот же квест (общее
                        // условие у них общее, личное — у каждого своё)
                        siblings={groups
                          .filter(x => x.guild_id === g.guild_id)
                          .map(x => ({ account: x.account ?? '', accountId: x.account_id ?? null, q: x.quests.find(y => y.id === q.id) }))
                          .filter((x): x is QuestAcc => !!x.q)}
                      />
                    ))}
            </Box>
          ))}
    </Box>
  );
}
