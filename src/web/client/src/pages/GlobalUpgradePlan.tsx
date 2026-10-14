import { useState, useEffect, useMemo } from 'react';
import { Box, Button, Flash, Heading, Text, FormControl, TextInput, Spinner } from '@primer/react';
import { api, type BuildingDef, type GlobalUpgradeRule } from '../api';
import { useFlash } from '../hooks/useFlash';
import { Scrollable } from '../components/Scrollable';

// Общий (глобальный) план улучшений — не привязан к аккаунту/городу, см. web/routes/cityStrategy.js.
// Применяется modules/progress.js (resolveEffectiveTargets) к любому городу, где есть здание с ТОЧНО
// ТАКИМ ЖЕ id, НО только если у самого города нет личной цели для этого же здания (страница «Карта
// города» → вкладка «План» всегда важнее). Ручная очередь (вкладка «Улучшение») важнее этих планов.
// Правило матчится по ТОЧНОМУ id здания, БЕЗ нормализации звёздного суффикса — базовое здание и
// каждый его звёздный тир настраиваются НЕЗАВИСИМО (правило "Городской банк" действует, пока здание
// не эволюционировало ни в один тир; "Городской банк ★2" — отдельное правило для этого тира).
function buildingName(b: BuildingDef): string {
  try {
    const n = JSON.parse(b.name) as { en?: string; ru?: string } | null;
    const base = n?.ru || n?.en || b.id;
    // звёздные варианты называются в каталоге точно так же, как базовое здание — без суффикса их
    // не отличить друг от друга в списке (сверено с config/buildings.txt)
    return b.star_lvl != null ? `${base} ★${b.star_lvl}` : base;
  } catch { return b.id; }
}
function buildingCat(id: string): string {
  if (id.startsWith('CAP_')) { const m = id.slice(4).match(/^([A-Z]+)_/); return m ? m[1] : ''; }
  const m = id.match(/^([A-Z]+)_/);
  return m ? m[1] : '';
}
const CAT_ORDER = ['COM', 'RES'];
const catRank = (c: string) => { const i = CAT_ORDER.indexOf(c); return i === -1 ? 999 : i; };
const familyIdOf = (id: string) => id.replace(/_\d+_star\.png$/i, '.png');
function labelForFamily(fam: string, list: BuildingDef[]): string {
  const opts = list.filter(x => familyIdOf(x.id) === fam);
  const b = opts.find(x => x.star_lvl == null) ?? opts[0];
  return b ? buildingName(b) : fam;
}

export function GlobalUpgradePlan() {
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<BuildingDef[]>([]);
  const [plan, setPlan] = useState<GlobalUpgradeRule[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [level, setLevel] = useState('20');
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const { flash, showFlash } = useFlash();

  useEffect(() => {
    Promise.all([api.buildingsList('city'), api.globalUpgradePlan()])
      .then(([b, p]) => {
        if (b.ok) setCatalog(b.buildings);
        if (p.ok) setPlan(p.plan);
      })
      .finally(() => setLoading(false));
  }, []);

  // подпись правила по точному id здания
  const labelFor = (id: string) => {
    const b = catalog.find(x => x.id === id);
    return b ? buildingName(b) : id;
  };

  // полный каталог (все здания, включая звёздные — по образцу палитры MapEditor.tsx/вкладки
  // "Строительство" на карте города, только без фильтра is_purchasable, т.к. звёздные тиры
  // недоступны для прямой постройки, но являются валидной целью общего плана), кроме спецзданий
  // (category === 'special') — им лимит 1 на город, общий план по ним не имеет смысла. С поиском и
  // категориями; внутри категории — та же сортировка по эффективности, что и на вкладке
  // "Строительство" (CityMap.tsx): коммерческие по прибыли, жилые по населению, служебные по
  // покрытию — но ПО СЕМЬЯМ (familyId, только для группировки — правило всё равно хранит точный id),
  // чтобы звёздные тиры одного здания шли подряд, а не перемешивались с тирами других зданий.
  const buildable = useMemo(() => catalog.filter(b => b.category !== 'special'), [catalog]);
  const paletteCats = [...new Set(buildable.map(b => buildingCat(b.id)))].filter(Boolean).sort((a, b) => catRank(a) - catRank(b));
  const paletteFiltered = useMemo(() => {
    const filtered = buildable.filter(b => {
      if (catFilter && buildingCat(b.id) !== catFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!buildingName(b).toLowerCase().includes(q) && !b.id.toLowerCase().includes(q)) return false;
      }
      return true;
    });
    // показатель эффективности семьи — берём у базового (не звёздного) варианта, если он есть в
    // отфильтрованном списке, иначе у первого попавшегося тира этой семьи
    const metricOf = (fam: string) => {
      const opts = filtered.filter(x => familyIdOf(x.id) === fam);
      const b = opts.find(x => x.star_lvl == null) ?? opts[0];
      if (catFilter === 'COM') return b?.base_profit ?? 0;
      if (catFilter === 'RES') return b?.base_population ?? 0;
      if (catFilter === 'SER') return b?.service_coverage ?? 0;
      return 0;
    };
    const families = [...new Set(filtered.map(b => familyIdOf(b.id)))]
      .sort((a, b) => catFilter ? metricOf(b) - metricOf(a) : labelForFamily(a, filtered).localeCompare(labelForFamily(b, filtered), 'ru'));
    const result: BuildingDef[] = [];
    for (const fam of families) {
      const tiers = filtered.filter(b => familyIdOf(b.id) === fam).sort((a, b) => (a.star_lvl ?? -1) - (b.star_lvl ?? -1));
      result.push(...tiers);
    }
    return result;
  }, [buildable, catFilter, search]);

  const addRule = () => {
    const lvl = Math.floor(Number(level)) || 0;
    if (!selectedId || lvl <= 0) return;
    setPlan(prev => [...prev.filter(r => r.family_id !== selectedId), { family_id: selectedId, target_level: lvl }]);
    setSelectedId('');
  };
  const removeRule = (fid: string) => setPlan(prev => prev.filter(r => r.family_id !== fid));
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.saveGlobalUpgradePlan(plan);
      showFlash(r.ok ? 'Сохранено' : (r.error ?? 'Ошибка'), !!r.ok);
    } catch (e) { showFlash(String(e), false); } finally { setBusy(false); }
  };

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  return (
    <Box sx={{ p: 3, maxWidth: 720 }}>
      <Heading as="h2" sx={{ fontSize: 3, mb: 2 }}>Общий план улучшений</Heading>
      <Text sx={{ fontSize: 1, color: 'fg.muted', display: 'block', mb: 3 }}>
        Правило вида «Меридианы — до уровня 20» применяется автоматически ко всем городам всех
        аккаунтов, где есть здания этого семейства — но только если у конкретного города нет своей
        личной цели для этого же здания (страница «Карта города» → вкладка «План» всегда важнее).
        Ручная очередь (вкладка «Улучшение») важнее этих планов.
      </Text>

      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      <Box sx={{ display: 'flex', gap: 3, mb: 3, flexWrap: 'wrap' }}>
        <Box sx={{ flex: 1, minWidth: 280, border: '1px solid', borderColor: 'border.muted', borderRadius: 2 }}>
          <Box sx={{ p: 2, borderBottom: '1px solid', borderColor: 'border.muted' }}>
            <TextInput placeholder="Поиск" value={search} onChange={e => setSearch(e.target.value)} block />
          </Box>
          <div id="map-cat-tabs">
            {['', ...paletteCats].map(cat => (
              <span key={cat || '__all'} className={'map-cat-tab' + (catFilter === cat ? ' active' : '')} onClick={() => setCatFilter(cat)}>
                {cat || 'ВСЕ'}
              </span>
            ))}
          </div>
          <Scrollable style={{ maxHeight: 320 }}>
            <Box sx={{ display: 'flex', flexDirection: 'column', p: 1 }}>
              {paletteFiltered.map(b => (
                <div key={b.id} className={'map-bitem' + (selectedId === b.id ? ' active' : '')} onClick={() => setSelectedId(b.id)}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{buildingName(b)}</span>
                </div>
              ))}
            </Box>
          </Scrollable>
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 200 }}>
          <FormControl>
            <FormControl.Label>Выбрано</FormControl.Label>
            <Text sx={{ fontSize: 1, display: 'block' }}>{selectedId ? labelFor(selectedId) : '— кликните здание слева —'}</Text>
          </FormControl>
          <FormControl>
            <FormControl.Label>Целевой уровень</FormControl.Label>
            <TextInput type="number" value={level} onChange={e => setLevel(e.target.value)} block />
          </FormControl>
          <Button onClick={addRule} disabled={!selectedId}>Добавить правило</Button>
        </Box>
      </Box>

      {plan.length === 0
        ? <Text sx={{ fontSize: 1, color: 'fg.muted' }}>Правил пока нет</Text>
        : <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mb: 3 }}>
            {plan.map(r => (
              <Box key={r.family_id} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2, border: '1px solid', borderColor: 'border.muted', borderRadius: 2 }}>
                <Text sx={{ fontSize: 1 }}>{labelFor(r.family_id)} — до ур. {r.target_level}</Text>
                <Button variant="danger" onClick={() => removeRule(r.family_id)}>×</Button>
              </Box>
            ))}
          </Box>}

      <Button variant="primary" loading={busy} disabled={busy} onClick={save}>Сохранить</Button>
    </Box>
  );
}
