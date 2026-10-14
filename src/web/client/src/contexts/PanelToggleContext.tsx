import { createContext, useContext, useEffect, useState, type ReactNode, type ElementType } from 'react';

// Позволяет странице (напр. CityMapCity/CityMapCapital с правым .map-panel) "прокинуть" кнопку
// открытия своей панели в общий мобильный хидер (.mobile-topbar в App.tsx), справа от бургера,
// не зная о структуре хидера. Кнопка рендерится ОДИН РАЗ хидером и просто визуально перекрывается
// самой панелью, когда та открыта и уезжает поверх экрана (z-index) — тот же приём, что уже
// работает у бургера левого меню (см. .sidebar z-index выше .mobile-topbar).
export interface PanelToggle { onOpen: () => void; icon: ElementType; label: string }

const Ctx = createContext<{ panel: PanelToggle | null; setPanel: (p: PanelToggle | null) => void }>({
  panel: null, setPanel: () => {},
});

export function PanelToggleProvider({ children }: { children: ReactNode }) {
  const [panel, setPanel] = useState<PanelToggle | null>(null);
  return <Ctx.Provider value={{ panel, setPanel }}>{children}</Ctx.Provider>;
}

export const usePanelToggleSlot = () => useContext(Ctx).panel;

// Страница зовёт это, пока у неё есть панель (обычно всегда, пока страница смонтирована) — передайте
// стабильные onOpen/icon (напр. onOpen через useCallback с пустыми deps), иначе эффект будет
// перерегистрировать на каждый рендер (не критично, просто лишняя работа). null — снять регистрацию
// раньше размонтирования (напр. пока у аккаунта нет зданий и панель показывать нечего).
export function useRegisterPanelToggle(reg: PanelToggle | null) {
  const { setPanel } = useContext(Ctx);
  useEffect(() => {
    setPanel(reg);
    return () => setPanel(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reg?.onOpen, reg?.icon, reg?.label]);
}
