import { Box, Label, Text } from '@primer/react';
import { PolicyIcon } from './PolicyIcon';
import { Dialog } from '@primer/react/experimental';
import { type PolicyDefEntry } from '../api';
import { effectLabel, effectValue } from '../policyEffects';

// Общая карточка/модалка политики — используется и в «Библиотеке политик», и на странице лотов рынка
// (клик по политике-лоту). Показывает ВСЕ известные варианты с одинаковым названием (в игре бывают
// политики с одним именем, но разной «баной» → разные def_id и редкость).

export const RARITY_COLOR: Record<string, string> = {
  common: '#6e7681', uncommon: '#27AE60', rare: '#2E86C1', epic: '#8E44AD',
  legendary: '#D4AC0D', mythic: '#C0392B', eternal: '#C0392B',
};
export const RARITY_NAME: Record<string, string> = {
  common: 'Обычная', uncommon: 'Необычная', rare: 'Редкая', epic: 'Эпическая',
  legendary: 'Легендарная', mythic: 'Мифическая', eternal: 'Вечная',
};
export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'eternal'];

export function defName(d: PolicyDefEntry): string {
  return d.name?.ru || d.name?.en || d.def_id;
}

function VariantCard({ def, multi }: { def: PolicyDefEntry; multi: boolean }) {
  const color = RARITY_COLOR[def.rarity] ?? '#6e7681';
  const boons = (def.effects ?? []).filter(e => e.kind === 'boon');
  const banes = (def.effects ?? []).filter(e => e.kind === 'bane');
  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, p: 2, mb: 2 }}>
      <Box sx={{ display: 'flex', gap: 2, mb: 2, flexWrap: 'wrap', alignItems: 'center' }}>
        <Label sx={{ bg: color, color: 'white', borderColor: 'transparent' }}>{RARITY_NAME[def.rarity] ?? def.rarity}</Label>
        {def.max_level != null && <Label>Макс. уровень {def.max_level}</Label>}
      </Box>
      {def.description && (def.description.ru || def.description.en) && (
        <Text sx={{ fontSize: 1, color: 'fg.muted', display: 'block', mb: 2 }}>{def.description.ru || def.description.en}</Text>
      )}
      {(boons.length > 0 || banes.length > 0) && (
        <Box sx={{ mb: 1 }}>
          {!multi && <Text sx={{ fontSize: 0, color: 'fg.muted', fontWeight: 'bold', display: 'block', mb: 1 }}>Эффекты (на замеченном уровне)</Text>}
          {[...boons, ...banes].map((e, i) => (
            <Box key={i} sx={{ display: 'flex', justifyContent: 'space-between', fontSize: 1, py: '2px' }}>
              <Text sx={{ color: e.kind === 'boon' ? 'success.fg' : 'danger.fg' }}>{effectLabel(e)}</Text>
              <Text className="mono" sx={{ fontWeight: 'bold' }}>{effectValue(e)}</Text>
            </Box>
          ))}
        </Box>
      )}
      <Text sx={{ fontSize: 0, color: 'fg.subtle', display: 'block' }}>
        def_id: {def.def_id}{def.seen_account ? ` · впервые замечена: ${def.seen_account}` : ''}
      </Text>
    </Box>
  );
}

export function PolicyCardModal({ variants, onClose }: { variants: PolicyDefEntry[]; onClose: () => void }) {
  if (!variants.length) return null;
  const primary = variants[0];
  const sorted = [...variants].sort((a, b) => RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity));
  return (
    <Dialog title={defName(primary)} onClose={onClose} width="large" position={{ narrow: 'bottom', regular: 'center' }}>
      <Box>
        <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
          <PolicyIcon rarity={primary.rarity} iconKey={primary.icon_key} size={72} iconSize={38} radius={16} />
        </Box>
        {sorted.length > 1 && (
          <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', textAlign: 'center', mb: 2 }}>
            Известно вариантов: {sorted.length} — одинаковое название, разные эффекты
          </Text>
        )}
        {sorted.map(def => <VariantCard key={def.def_id} def={def} multi={sorted.length > 1} />)}
      </Box>
    </Dialog>
  );
}
