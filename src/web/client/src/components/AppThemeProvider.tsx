import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { ThemeProvider, BaseStyles } from '@primer/react';

// Тема приложения — ТОЛЬКО ручное переключение (в Настройках), без авто по системе.
// Управляет и Primer-компонентами (colorMode), и кастомным CSS (атрибут data-theme на <html>,
// под который в global.css заданы тёмные переопределения переменных).
export type AppTheme = 'light' | 'dark';
const LS_KEY = 'tc-theme';

function loadTheme(): AppTheme {
  try { return localStorage.getItem(LS_KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}

const ThemeCtx = createContext<{ theme: AppTheme; setTheme: (t: AppTheme) => void; toggle: () => void }>({
  theme: 'light', setTheme: () => {}, toggle: () => {},
});
export const useAppTheme = () => useContext(ThemeCtx);

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<AppTheme>(loadTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(LS_KEY, theme); } catch { /* */ }
  }, [theme]);

  const setTheme = useCallback((t: AppTheme) => setThemeState(t), []);
  const toggle = useCallback(() => setThemeState(t => (t === 'dark' ? 'light' : 'dark')), []);

  return (
    <ThemeCtx.Provider value={{ theme, setTheme, toggle }}>
      {/* colorMode фиксированный (day/night), без 'auto' — переключение только вручную */}
      <ThemeProvider colorMode={theme === 'dark' ? 'night' : 'day'}>
        <BaseStyles>{children}</BaseStyles>
      </ThemeProvider>
    </ThemeCtx.Provider>
  );
}
