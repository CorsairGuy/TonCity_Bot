import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { ThemeProvider, BaseStyles } from '@primer/react';
import { api } from '../api';

// Тема приложения — ТОЛЬКО ручное переключение (в Настройках), без авто по системе.
// Управляет и Primer-компонентами (colorMode), и кастомным CSS (атрибут data-theme на <html>,
// под который в global.css заданы тёмные переопределения переменных).
// Копия выбора хранится на сервере в config.ui.theme: iOS чистит localStorage у PWA после простоя,
// и тёмная тема без неё внезапно становилась светлой (то же решение, что у групп меню).
// Цвет фона страницы, строки состояния и сплэша — одни и те же (см. index.html).
export type AppTheme = 'light' | 'dark';
const LS_KEY = 'tc-theme';

function loadTheme(): AppTheme {
  try { return localStorage.getItem(LS_KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}
const BG: Record<AppTheme, string> = { light: '#ebebeb', dark: '#0d1117' };
function applyChrome(t: AppTheme) {
  const html = document.documentElement;
  html.setAttribute('data-theme', t);
  html.style.colorScheme = t;           // полосы прокрутки и системные поля — в цвет темы
  html.style.background = BG[t];
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BG[t]);
}

const ThemeCtx = createContext<{ theme: AppTheme; setTheme: (t: AppTheme) => void; toggle: () => void }>({
  theme: 'light', setTheme: () => {}, toggle: () => {},
});
export const useAppTheme = () => useContext(ThemeCtx);

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<AppTheme>(loadTheme);

  useEffect(() => {
    applyChrome(theme);
    try { localStorage.setItem(LS_KEY, theme); } catch { /* */ }
  }, [theme]);

  // серверная копия читается при каждом открытии панели; ошибка/офлайн — остаёмся на локальной
  useEffect(() => {
    let cancelled = false;
    api.config().then(r => {
      const t = r.ok ? r.settings.ui?.theme : null;
      if (!cancelled && !touched.current && (t === 'light' || t === 'dark')) setThemeState(t);
    }).catch(() => { /* */ });
    return () => { cancelled = true; };
  }, []);

  const touched = useRef(false); // переключили до ответа сервера — его старое значение не применяем
  const save = (t: AppTheme) => { touched.current = true; api.saveConfig({ ui: { theme: t } }).catch(() => { /* офлайн — localStorage уже сохранён */ }); };
  const setTheme = useCallback((t: AppTheme) => { setThemeState(t); save(t); }, []);
  const toggle = useCallback(() => setThemeState(t => { const n = t === 'dark' ? 'light' : 'dark'; save(n); return n; }), []);

  return (
    <ThemeCtx.Provider value={{ theme, setTheme, toggle }}>
      {/* colorMode фиксированный (day/night), без 'auto' — переключение только вручную */}
      <ThemeProvider colorMode={theme === 'dark' ? 'night' : 'day'}>
        <BaseStyles>{children}</BaseStyles>
      </ThemeProvider>
    </ThemeCtx.Provider>
  );
}
