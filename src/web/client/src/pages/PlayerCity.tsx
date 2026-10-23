import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Box, Button, Flash, Heading, Spinner, Text } from '@primer/react';
import { ChevronLeftIcon, SyncIcon } from '@primer/octicons-react';
import { api, type BuildingDef, type MapSection, type PlayerCity as PlayerCityData } from '../api';
import { CityActionsCanvas } from '../components/CityActionsCanvas';
import { DayNightMenu } from '../components/DayNightMenu';
import { PlayerAvatar, ProfitValue } from '../components/League';
import { useMapDayNight } from '../hooks/useMapDayNight';

const NONE = new Set<string>();
const noop = () => { /* чужой город — только просмотр */ };

// Карта чужого города (как «Посетить город» в игре): /player-city?id=<user_id>&name=<имя>&from=<откуда пришли>.
// Только просмотр — та же отрисовка, что у своих городов, без действий и планов.
export function PlayerCity() {
  const [q] = useSearchParams();
  const navigate = useNavigate();
  const id = q.get('id') ?? '';
  const back = q.get('from') === 'leagues' ? '/leagues' : '/greatest-mayors';
  const [data, setData] = useState<PlayerCityData | null>(null);
  const [loading, setLoading] = useState(false);
  const [catalog, setCatalog] = useState<BuildingDef[]>([]);
  const [sections, setSections] = useState<MapSection[]>([]);
  const [dayNight, setDayNight] = useMapDayNight();

  const load = useCallback(async (force = false) => {
    if (!id) return;
    setLoading(true);
    try { setData(await api.playerCity(id, force)); }
    catch (e) { setData({ ok: false, error: String(e) }); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { setData(null); load(); }, [load]);
  useEffect(() => {
    api.buildingsList('city').then(d => { if (d.ok) setCatalog(d.buildings); });
    api.sections().then(d => { if (d.ok) setSections(d.sections); });
  }, []);

  const name = data?.user?.name ?? q.get('name') ?? `#${id}`;
  const buildings = useMemo(() => data?.buildings ?? [], [data]);

  return (
    <Box sx={{
      display: 'flex', flexDirection: 'column', height: 'calc(100vh - var(--header-h))',
      '@media (max-width: 768px)': { height: 'calc(100dvh - 52px)' },
    }}>
      <Box sx={{ p: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default', display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
        {/* назад по истории — вернёт рейтинг с той же лигой, списком и прокруткой (они в адресе);
            открыли по прямой ссылке — просто на страницу рейтинга */}
        <Button leadingVisual={ChevronLeftIcon} onClick={() => (window.history.state?.idx ? navigate(-1) : navigate(back))}>Назад</Button>
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2, flexWrap: 'wrap' }}>
          <PlayerAvatar src={data?.user?.small_url} name={name} size={24} />
          <Heading as="h3" sx={{ fontSize: 2, m: 0 }}>{name}</Heading>
          {data?.ok && (
            <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              Зданий: {buildings.length}
              {data.profit_per_hour != null && <> · <ProfitValue v={data.profit_per_hour} /></>}
              {data.happiness != null && <> · счастье {Math.round(data.happiness)}%</>}
            </Text>
          )}
        </Box>
        <DayNightMenu value={dayNight} onChange={setDayNight} />
        <Button leadingVisual={SyncIcon} loading={loading} disabled={loading || !id} onClick={() => load(true)}>Обновить</Button>
      </Box>

      {data?.error && <Box sx={{ px: 3, pt: 2 }}><Flash variant="danger">Не удалось загрузить город: {data.error}</Flash></Box>}

      <Box sx={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative' }}>
        {!data && <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner /></Box>}
        {data?.ok && (buildings.length
          ? <CityActionsCanvas
              buildings={buildings}
              type="city"
              mapKey={`player:${id}`}
              mode="view"
              validSet={NONE}
              pickedSet={NONE}
              targets={[]}
              queue={[]}
              globalPlan={[]}
              catalog={catalog}
              onPick={noop}
              sections={sections}
              unlockedSections={data.unlocked_sections ?? undefined}
              dayNight={dayNight}
            />
          : <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Text sx={{ color: 'fg.muted' }}>Нет данных о зданиях</Text></Box>)}
      </Box>
    </Box>
  );
}
