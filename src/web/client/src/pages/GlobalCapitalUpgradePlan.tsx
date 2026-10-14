import { useState, useEffect, useMemo } from 'react';
import { Box, Button, Flash, Heading, Text, FormControl, TextInput, Spinner } from '@primer/react';
import { api, type GlobalUpgradeRule } from '../api';
import { useFlash } from '../hooks/useFlash';
import { Scrollable } from '../components/Scrollable';

// Здания столицы (config/capital_buildings.txt) — своя форма, отличная от городского BuildingDef
// (api.ts): нет category/star_lvl, зато есть is_upgradable (декоративные CAP_DEC_*/спецздания
// CAP_SPE_* — max_level=1, is_upgradable=false: план по ним не имеет смысла, их и фильтруем ниже),
// см. тот же тип в CityMapCapital.tsx.
interface CapitalBuildingDef {
  id: string;
  name: string; // JSON-строка {en,ru}
  base_profit: number | null;
  is_upgradable: boolean;
}

// Общий (глобальный) план улучшений столицы — копия GlobalUpgradePlan.tsx (город), только
// api.buildingsList('capital')/api.globalCapitalUpgradePlan(), см. web/routes/capitalStrategy.js.
// Применяется modules/capitalProgress.js (resolveEffectiveCapitalTargets) ко всем столицам, где
// есть здание с ТОЧНО ТАКИМ ЖЕ id — но только если у самой столицы нет личной цели для этого же
// здания (страница «Карта города» тип столица → вкладка «План» всегда важнее). Ручная очередь
// («Улучшение») важнее этих планов.
function buildingName(b: CapitalBuildingDef): string {
  try {
    const n = JSON.parse(b.name) as { en?: string; ru?: string } | null;
    return n?.ru || n?.en || b.id;
  } catch { return b.id; }
}
function buildingCat(id: string): string {
  if (id.startsWith('CAP_')) { const m = id.slice(4).match(/^([A-Z]+)_/); return m ? m[1] : ''; }
  const m = id.match(/^([A-Z]+)_/);
  return m ? m[1] : '';
}
const CAT_ORDER = ['COM'];
const catRank = (c: string) => { const i = CAT_ORDER.indexOf(c); return i === -1 ? 999 : i; };

export function GlobalCapitalUpgradePlan() {
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<CapitalBuildingDef[]>([]);
  const [plan, setPlan] = useState<GlobalUpgradeRule[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [level, setLevel] = useState('20');
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const { flash, showFlash } = useFlash();

  useEffect(() => {
    Promise.all([
      api.buildingsList('capital') as unknown as Promise<{ ok: boolean; buildings: CapitalBuildingDef[] }>,
      api.globalCapitalUpgradePlan(),
    ])
      .then(([b, p]) => {
        if (b.ok) setCatalog(b.buildings);
        if (p.ok) setPlan(p.plan);
      })
      .finally(() => setLoading(false));
  }, []);

  const labelFor = (id: string) => {
    const b = catalog.find(x => x.id === id);
    return b ? buildingName(b) : id;
  };

  // здания без реального улучшения (декор CAP_DEC_*, разовые спецздания CAP_SPE_* — is_upgradable
  // false, max_level 1) в плане улучшений смысла не имеют — исключаем их из палитры целиком
  const buildable = useMemo(() => catalog.filter(b => b.is_upgradable), [catalog]);
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
    // у столицы нет звёздных тиров (каждый id — ровно одно здание), поэтому просто сортируем: в
    // COM — по прибыли (лучшее сверху), иначе по алфавиту
    return [...filtered].sort((a, b) => catFilter === 'COM'
      ? (b.base_profit ?? 0) - (a.base_profit ?? 0)
      : buildingName(a).localeCompare(buildingName(b), 'ru'));
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
      const r = await api.saveGlobalCapitalUpgradePlan(plan);
      showFlash(r.ok ? 'Сохранено' : (r.error ?? 'Ошибка'), !!r.ok);
    } catch (e) { showFlash(String(e), false); } finally { setBusy(false); }
  };

  if (loading) return <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - var(--header-h))' }}><Spinner /></Box>;

  return (
    <Box sx={{ p: 3, maxWidth: 720 }}>
      <Heading as="h2" sx={{ fontSize: 3, mb: 2 }}>Общий план улучшений столицы</Heading>
      <Text sx={{ fontSize: 1, color: 'fg.muted', display: 'block', mb: 3 }}>
        Правило вида «Здание — до уровня 20» применяется автоматически ко всем столицам гильдий, где
        у вас есть аккаунт-лидер и есть здания этого типа — но только если у самой столицы нет
        личной цели для этого же здания (вкладка «План» на карте столицы всегда важнее). Ручная
        очередь (вкладка «Улучшение») важнее этих планов.
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
