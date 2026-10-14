import { Box, Button, TextInput } from '@primer/react';
import { DashIcon, PlusIcon } from '@primer/octicons-react';

// Выбор количества для покупки в магазине: [−] [поле] [+] [Макс].
// Появился по просьбе 13.08: у части товаров дневной лимит 10 штук, и раньше «Купить» приходилось
// жать десять раз, хотя игра позволяет взять всё сразу (эндпоинт покупки принимает amount).
// max — сколько реально можно купить ЭТОМУ аккаунту: минимум из остатка дневного лимита и того,
// на сколько хватает монет/алмазов/билетов.
export function QtyPicker({ value, max, onChange, disabled = false, size = 'small' }: {
  value: number;
  max: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  size?: 'small' | 'medium';
}) {
  const clamp = (v: number) => Math.max(1, Math.min(Math.max(1, max), Math.floor(v) || 1));
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
      <Button size={size} aria-label="Меньше" disabled={disabled || value <= 1} onClick={() => onChange(clamp(value - 1))}>
        <DashIcon size={12} />
      </Button>
      <TextInput
        size={size}
        aria-label="Количество"
        value={String(value)}
        disabled={disabled}
        onChange={e => onChange(clamp(Number(e.target.value)))}
        sx={{ width: 58, '& input': { textAlign: 'center', fontVariantNumeric: 'tabular-nums' } }}
      />
      <Button size={size} aria-label="Больше" disabled={disabled || value >= max} onClick={() => onChange(clamp(value + 1))}>
        <PlusIcon size={12} />
      </Button>
      <Button size={size} disabled={disabled || max <= 1 || value >= max} onClick={() => onChange(Math.max(1, max))}>
        Макс
      </Button>
    </Box>
  );
}

// Сколько штук доступно к покупке: остаток дневного/недельного лимита и «на сколько хватает денег».
// За рекламу платить нечем — там ограничивает только лимит.
export function affordableCount(
  offer: { price: number; limit: number; current: number; offer_type: string },
  balance: number | undefined,
): number {
  const byLimit = Math.max(0, (offer.limit || 0) - (offer.current || 0));
  if (offer.offer_type === 'ads') return byLimit;
  if (!offer.price) return byLimit;
  const byMoney = Math.floor((balance ?? 0) / offer.price);
  return Math.max(0, Math.min(byLimit, byMoney));
}
