import type { ReactNode } from 'react';
import { Box } from '@primer/react';
import { Dialog } from '@primer/react/experimental';
import type { Icon } from '@primer/octicons-react';

// Общие части «нового» модального окна (15.10.2026, макеты в треде «Модальные окна: было и станет»):
// шапка с иконкой и пояснением, подвал с итогом слева и кнопками справа, разделы с подписью,
// список выбора аккаунтов и пустое состояние. Стили — блок «Модальные окна» в global.css.
// Окно помечается классом .rdlg на корне тела (RichBody) — по нему CSS через :has() меняет отступы,
// скругления и подвал только у переделанных окон, остальные остаются как были.

type Tone = 'accent' | 'danger' | 'attention' | 'success';

export function richHeader(icon: Icon, tone: Tone = 'accent') {
  const Ic = icon;
  return function RichHeader({ dialogLabelId, dialogDescriptionId, title, subtitle, onClose }: {
    dialogLabelId: string; dialogDescriptionId: string; title?: ReactNode; subtitle?: ReactNode;
    onClose: (gesture: 'close-button' | 'escape') => void;
  }) {
    return (
      <Dialog.Header className="rdlg-head">
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <div className={`rdlg-ic rdlg-ic--${tone}`}><Ic size={20} /></div>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Dialog.Title id={dialogLabelId} className="rdlg-title">{title}</Dialog.Title>
            {subtitle && <Dialog.Subtitle id={dialogDescriptionId} className="rdlg-sub">{subtitle}</Dialog.Subtitle>}
          </Box>
          <Dialog.CloseButton onClose={() => onClose('close-button')} />
        </Box>
      </Dialog.Header>
    );
  };
}

export function RichBody({ children }: { children: ReactNode }) {
  return <div className="rdlg">{children}</div>;
}

// Подвал: итог слева, кнопки справа. На телефоне — итог сверху, кнопки во всю ширину одна над
// другой (основная сверху), см. .rdlg-btns в global.css. Кнопки передавать в порядке
// «второстепенная, основная».
export function RichFooter({ summary, children }: { summary?: ReactNode; children: ReactNode }) {
  return (
    <Dialog.Footer className="rdlg-foot">
      {summary != null && <div className="rdlg-sum">{summary}</div>}
      <div className="rdlg-btns">{children}</div>
    </Dialog.Footer>
  );
}

export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <div className="rdlg-sec"><span>{children}</span>{action}</div>;
}

// Строка списка выбора (аккаунты): on — выбрана, off — недоступна (серая).
export function PickRow({ on, off, children, onClick }: { on?: boolean; off?: boolean; children: ReactNode; onClick?: () => void }) {
  return <div className={`rdlg-row${on ? ' on' : ''}${off ? ' off' : ''}`} onClick={off ? undefined : onClick}>{children}</div>;
}

export function EmptyState({ icon, title, children }: { icon: Icon; title: ReactNode; children?: ReactNode }) {
  const Ic = icon;
  return (
    <div className="rdlg-empty">
      <div className="rdlg-empty__ic"><Ic size={24} /></div>
      <div className="rdlg-empty__t">{title}</div>
      {children && <div className="rdlg-empty__d">{children}</div>}
    </div>
  );
}
