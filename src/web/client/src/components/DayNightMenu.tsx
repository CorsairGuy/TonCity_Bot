import { ActionList, ActionMenu, IconButton } from '@primer/react';
import { ClockIcon, MoonIcon, SunIcon } from '@primer/octicons-react';
import type { DayNightMode } from './mapNight';

// время суток на карте (город и столица): по часам устройства (рассвет, закат, ночь со светом в окнах), всегда день или ночь
const DAY_NIGHT: { value: DayNightMode; label: string; icon: typeof SunIcon }[] = [
  { value: 'auto', label: 'По часам устройства', icon: ClockIcon },
  { value: 'day', label: 'Всегда день', icon: SunIcon },
  { value: 'night', label: 'Всегда ночь', icon: MoonIcon },
];
export function DayNightMenu({ value, onChange }: { value: DayNightMode; onChange: (m: DayNightMode) => void }) {
  const cur = DAY_NIGHT.find(o => o.value === value) ?? DAY_NIGHT[0];
  return (
    <ActionMenu>
      <ActionMenu.Anchor>
        <IconButton icon={cur.icon} aria-label={`Время суток на карте: ${cur.label.toLowerCase()}`} />
      </ActionMenu.Anchor>
      <ActionMenu.Overlay width="small">
        <ActionList selectionVariant="single">
          <ActionList.Group>
            <ActionList.GroupHeading>Время суток</ActionList.GroupHeading>
            {DAY_NIGHT.map(o => (
              <ActionList.Item key={o.value} selected={o.value === value} onSelect={() => onChange(o.value)}>
                <ActionList.LeadingVisual><o.icon /></ActionList.LeadingVisual>
                {o.label}
              </ActionList.Item>
            ))}
          </ActionList.Group>
        </ActionList>
      </ActionMenu.Overlay>
    </ActionMenu>
  );
}
