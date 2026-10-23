import { useCallback, type ReactNode } from 'react';
import { useConfirm } from '@primer/react';

// Подтверждение действия окном Primer вместо системного confirm(): в PWA на iPhone системное окно
// выглядит чужим и показывает адрес сайта. danger — красная кнопка для необратимых действий.
export function useAsk() {
  const confirm = useConfirm();
  return useCallback(
    (title: string, content: ReactNode, opts: { ok?: string; danger?: boolean } = {}) =>
      confirm({
        title,
        content,
        confirmButtonContent: opts.ok ?? 'Да',
        cancelButtonContent: 'Отмена',
        confirmButtonType: opts.danger ? 'danger' : 'primary',
      }),
    [confirm],
  );
}
