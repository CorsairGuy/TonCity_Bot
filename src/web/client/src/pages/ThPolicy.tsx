import { useState, useEffect } from 'react';
import { Box, Button, Flash, Spinner, Text, Tooltip } from '@primer/react';
import { SyncIcon } from '@primer/octicons-react';
import { api, type PolicyDefEntry } from '../api';
import { useFlash } from '../hooks/useFlash';
import { useResumableRefresh } from '../hooks/useResumableRefresh';
import { PolicyCardModal, RARITY_COLOR, RARITY_NAME, RARITY_ORDER, defName } from '../components/PolicyCardModal';
import { PolicyIcon } from '../components/PolicyIcon';
import { PageHeader } from '../components/PageHeader';

// "Библиотека политик" — каталог описаний, собранный со всех аккаунтов бота.
// Игра НЕ хранит на клиенте полный список всех политик: /policies/library отдаёт по каждому
// аккаунту только уже открытые им записи (для неоткрытых показывает лишь количество и "?").
// Поэтому копим общий каталог в БД (src/modules/policies.js: harvestDefs) — он растёт по мере
// того, как разные аккаунты открывают разные политики. Раздел "Политика" (распределение доходов
// мэрии) в игру пока не завезли — эта страница заменяет прежнюю заглушку.

// Тот же размер/каркас, что у карточки предмета склада (.item-card, 77×77) — единообразие
// со страницами Предметы/Осколки/Политики. Константы редкости/имени и модалка — в общем
// компоненте components/PolicyCardModal (переиспользуется и на странице лотов рынка).
function DefBadge({ def, onClick }: { def: PolicyDefEntry; onClick: () => void }) {
  return (
    <Tooltip text={defName(def)} direction="n" noDelay>
      <div className="item-card clickable" aria-label={defName(def)} onClick={onClick}>
        <PolicyIcon rarity={def.rarity} iconKey={def.icon_key} />
      </div>
    </Tooltip>
  );
}

export function ThPolicy() {
  const [defs, setDefs] = useState<PolicyDefEntry[]>([]);
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useResumableRefresh('refresh:policies', () => load(true));
  const [modal, setModal] = useState<PolicyDefEntry | null>(null);
  const { flash, showFlash } = useFlash();

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const d = await api.policyDefs();
      if (d.ok) { setDefs(d.defs); setTotals(d.totalsByRarity ?? {}); }
      else showFlash(d.error ?? 'Ошибка загрузки', false);
    } catch (e) { showFlash(String(e), false); }
    finally { if (!silent) setLoading(false); }
  };

  const refresh = async () => {
    setRefreshing(true);
    try { await api.refresh('policies'); await load(true); showFlash('Обновлено', true); }
    catch (e) { showFlash(String(e), false); }
    finally { setRefreshing(false); }
  };

  useEffect(() => { load(); }, []);

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  // разные def_id могут иметь одинаковое отображаемое имя (варианты одной и той же политики) —
  // в списке показываем каждое название один раз, но счётчик "известно X" считает все def_id
  const byRarity = new Map<string, PolicyDefEntry[]>();
  for (const d of defs) {
    if (!byRarity.has(d.rarity)) byRarity.set(d.rarity, []);
    byRarity.get(d.rarity)!.push(d);
  }
  const uniqueByRarity = new Map<string, PolicyDefEntry[]>();
  for (const [rarity, list] of byRarity) {
    const seen = new Set<string>();
    const unique: PolicyDefEntry[] = [];
    for (const d of list) {
      const key = defName(d);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(d);
    }
    uniqueByRarity.set(rarity, unique);
  }
  // показываем ВСЕ редкости, что есть в игре (из totals), даже если в них пока ничего не открыто —
  // чтобы был виден полный масштаб коллекции и сколько ещё заперто в каждой редкости
  const rarities = [...new Set([...byRarity.keys(), ...Object.keys(totals)])].sort((a, b) => RARITY_ORDER.indexOf(a) - RARITY_ORDER.indexOf(b));

  return (
    <Box sx={{ p: 3 }}>
      <PageHeader mb={2} title="Библиотека политик" actions={<>
        <Button leadingVisual={SyncIcon} loading={refreshing} disabled={refreshing} onClick={refresh}>
          Обновить
        </Button>
      </>} />
      <Text sx={{ color: 'fg.muted', fontSize: 1, display: 'block', mb: 3 }}>
        Каталог из всех аккаунтов бота, пополняется по мере открытия. Игра сообщает лишь СКОЛЬКО
        политик каждой редкости существует (прогресс ниже) — но идентичность запертых (их имена/эффекты)
        не раскрывает, пока политика не открыта. Поэтому «заперто N» показать поимённо нельзя.
      </Text>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}


      {defs.length === 0 && Object.keys(totals).length === 0
        ? <Text sx={{ color: 'fg.muted' }}>Пока ничего не найдено — политики ещё не открыты ни у одного аккаунта</Text>
        : rarities.map(rarity => {
            const all = byRarity.get(rarity) ?? [];
            const unique = uniqueByRarity.get(rarity) ?? [];
            const total = totals[rarity];
            const color = RARITY_COLOR[rarity] ?? '#6e7681';
            const locked = total != null ? Math.max(0, total - all.length) : null;
            const pct = total ? Math.min(100, Math.round((all.length / total) * 100)) : 0;
            return (
              <Box key={rarity} sx={{ mb: 4 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2, flexWrap: 'wrap' }}>
                  <Text sx={{ fontWeight: 'bold', color }}>{RARITY_NAME[rarity] ?? rarity}</Text>
                  <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
                    открыто {all.length}{total != null ? ` из ${total}` : ''}{locked != null && locked > 0 ? ` · заперто ${locked}` : ''}
                  </Text>
                  {total != null && (
                    <Box sx={{ width: 120, height: 6, borderRadius: 3, bg: 'canvas.subtle', overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: color }} />
                    </Box>
                  )}
                </Box>
                {unique.length > 0
                  // тот же отступ, что у карточек на странице "Политики" (сетка/осколки) — единая сетка
                  ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                      {unique.map(d => <DefBadge key={d.def_id} def={d} onClick={() => setModal(d)} />)}
                    </div>
                  : <Text sx={{ fontSize: 0, color: 'fg.subtle' }}>
                      Пока не открыто ни одной{locked ? ` — заперто ${locked} (какие именно, игра не раскрывает до открытия)` : ''}
                    </Text>}
              </Box>
            );
          })}

      {modal && <PolicyCardModal variants={defs.filter(d => defName(d) === defName(modal))} onClose={() => setModal(null)} />}
    </Box>
  );
}
