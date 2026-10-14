import { useState, useEffect } from 'react';
import { Box, Button, Dialog, Flash, Heading, Spinner, Text, ToggleSwitch } from '@primer/react';
import { CheckIcon, GearIcon } from '@primer/octicons-react';
import { api, type GuildQuestGroup, type GuildQuest } from '../api';
import { fmt, ITEMS_BY_ID, itemImgSrc } from '../utils';
import { useFlash } from '../hooks/useFlash';
import { RenownValue } from '../components/Icons';

// автовыполнение гильдейских квестов — тумблеры пишут/читают questAutomation в общих настройках
// бота (/api/config), сам цикл — modules/questAutomation.js. КВЕСТ-ОСОЗНАННОЕ: действие выполняется,
// только если у аккаунта прямо сейчас есть подходящий незавершённый квест (см. комментарий в
// самом модуле про соответствие типов квестов действиям).
// Активация ускорителя убрана из автоматики (22.07.2026) — это намеренное решение игрока (тратит
// инвентарь, блокирует другие типы ускорителей на часы/сутки), теперь только кнопка "Активировать"
// прямо на строке квеста (см. QuestRow), не фоновый тумблер.
const AUTOMATION_LABELS: Record<string, string> = {
  ads: 'Смотреть рекламу — под квест "Просмотрите N роликов"',
  sudoku: 'Судоку (Оплот Мудрости) — под квест "Выиграйте N мини-игр"',
  minesweeper: 'Сапёр (Оплот Мудрости) — под квест "Выиграйте N мини-игр"',
  quiz: 'Викторина (Оплот Мудрости) — под квест "Выиграйте N мини-игр"',
  staking: 'Застейкать активы (сумма из Настроек) — под квест на стейкинг',
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
    <Dialog isOpen onDismiss={onClose} sx={{ maxWidth: 480, width: '95vw' }}>
      <Dialog.Header>
        <Text sx={{ fontWeight: 'bold' }}>Автовыполнение квестов</Text>
      </Dialog.Header>
      <Box sx={{ p: 2 }}>
        {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 2 }}>{flash.msg}</Flash>}
        <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 3 }}>
          Раз в день бот смотрит квесты гильдии этого аккаунта и выполняет действие, ТОЛЬКО если под
          него есть реальный незавершённый квест (иначе — не трогает, не тратит время/ресурсы зря).
          Сразу после действия проверяет, не выполнены ли оба условия (личное + общее), и если да —
          сам забирает награду. Квесты с тратой алмазов/монет (рынок, буст гильдии, покупка алмазов)
          и невозможные боту действия (приглашения) — не автоматизируются, заклейм для них появится
          ниже кнопкой, если условие выполнится каким-то другим путём.
        </Text>
        {!values
          ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><Spinner /></Box>
          : AUTOMATION_ORDER.map(key => (
            <Box key={key} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 3, py: 2, borderBottom: '1px solid', borderColor: 'border.muted' }}>
              <Text sx={{ fontSize: 1 }}>{AUTOMATION_LABELS[key]}</Text>
              <ToggleSwitch size="small" checked={values[key]} disabled={saving === key} onClick={() => toggle(key)} aria-label={AUTOMATION_LABELS[key]} />
            </Box>
          ))}
      </Box>
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

function QuestRow({ q, accountId, onCollected }: { q: GuildQuest; accountId?: number | null; onCollected: () => void }) {
  const meta = ITEMS_BY_ID[q.reward_item_id];
  const border = RARITY_BORDER[q.rarity] ?? '#6e7681';
  const t = timeLeft(q.expires_at);
  const name = questText(q.name, q.description_variables);
  const desc = questText(q.description, q.description_variables);
  const [collecting, setCollecting] = useState(false);
  const { flash, showFlash } = useFlash();
  // оба условия выполнены, но сервер ещё не отметил is_collected — кнопка появляется САМА, без
  // ручного выбора квеста: и для автоматизированных типов (пока не подтянулся свежий снимок), и
  // для НЕ покрытых автоматикой (invitations/item_acquire/booster_combine/market_*/...), если
  // пользователь выполнил условие каким-то другим путём (в игре напрямую, вручную на других
  // страницах бота).
  const readyToCollect = !q.is_collected && q.personal_progress >= q.personal_threshold && q.guild_progress >= q.guild_threshold;
  // квест "Активируйте ускоритель" — личное условие ещё не выполнено, нужна активация. Кнопка
  // всегда доступна (не только когда наступает readyToCollect выше) — activate-booster сам
  // проверит правило игры (пока активен другой тип — нельзя) и вернёт понятную причину, если
  // сейчас нельзя, а не тихо ничего не делает.
  const needsBoosterActivation = !q.is_collected && q.type === 'booster_activate' && q.personal_progress < q.personal_threshold;
  const [activating, setActivating] = useState(false);

  const collect = async () => {
    if (!accountId) return;
    setCollecting(true);
    try {
      const r = await api.guildQuestCollect(accountId, q.id);
      if (r.ok) onCollected(); else showFlash(r.error ?? 'Ошибка заклейма', false);
    } catch (e) { showFlash(String(e), false); } finally { setCollecting(false); }
  };

  const activateBooster = async () => {
    if (!accountId) return;
    setActivating(true);
    try {
      const r = await api.guildQuestActivateBooster(accountId, q.id);
      if (r.ok) { showFlash(`Активирован ${r.name ?? 'ускоритель'}`, true); onCollected(); }
      else showFlash(r.error ?? 'Не удалось активировать', false);
    } catch (e) { showFlash(String(e), false); } finally { setActivating(false); }
  };

  return (
    <Box sx={{
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
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Text sx={{ fontWeight: 'bold', fontSize: 1, display: 'block' }}>{name}</Text>
        <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: '2px' }}>
          {desc} [Личное: {fmt(q.personal_progress)}/{fmt(q.personal_threshold)}]
          {q.guild_threshold > 1 && <> [Общее: {fmt(q.guild_progress)}/{fmt(q.guild_threshold)}]</>}
        </Text>
        {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mt: 1, fontSize: 0, py: 1 }}>{flash.msg}</Flash>}
      </Box>

      {needsBoosterActivation && (
        <Button size="small" loading={activating} disabled={activating || !accountId} onClick={activateBooster}>
          Активировать
        </Button>
      )}

      {readyToCollect && (
        <Button size="small" variant="primary" loading={collecting} disabled={collecting || !accountId} onClick={collect}>
          Заклеймить
        </Button>
      )}

      {/* галочка (получено) / время / почёт — фикс. ширина, чтобы колонки выравнивались по рядам */}
      <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center', pr: '4px' }}>
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

  const load = async () => {
    setLoading(true);
    try {
      const d = await api.guildQuests();
      if (d.ok) setGroups(d.guilds);
      else showFlash('Ошибка загрузки', false);
    } catch (e) { showFlash(String(e), false); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Heading as="h2" sx={{ fontSize: 3 }}>Квесты</Heading>
        <Button leadingVisual={GearIcon} onClick={() => setSettingsOpen(true)}>Автовыполнение</Button>
      </Box>
      {settingsOpen && <AutomationSettingsModal onClose={() => setSettingsOpen(false)} />}
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      <Box sx={{ mb: 3 }}>
        <Button onClick={load}>↻ Обновить</Button>
      </Box>

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
                  : g.quests.map(q => <QuestRow key={q.id} q={q} accountId={g.account_id} onCollected={load} />)}
            </Box>
          ))}
    </Box>
  );
}
