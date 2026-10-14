import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AppThemeProvider } from './components/AppThemeProvider'
import App from './App'
import './global.css'
import 'overlayscrollbars/overlayscrollbars.css'
import { waitForFreshSW } from './registerSW'

// Auto-hide scrollbars: add .is-scrolling while scrolling, remove after 900ms idle
;(function () {
  const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>()
  document.addEventListener('scroll', (e) => {
    const el = e.target as Element
    if (!(el instanceof Element)) return
    el.classList.add('is-scrolling')
    const prev = timers.get(el)
    if (prev) clearTimeout(prev)
    timers.set(el, setTimeout(() => {
      el.classList.remove('is-scrolling')
      timers.delete(el)
    }, 900))
  }, { capture: true, passive: true })
})()

// ждём короткое окно проверки обновления SW (см. registerSW.ts) — если найдётся новая версия,
// сюда управление вообще не вернётся (страница перезагрузится раньше сама), и пользователь не
// увидит старый UI даже на долю секунды.
waitForFreshSW().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <AppThemeProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AppThemeProvider>
    </React.StrictMode>
  )
  // сплэш из index.html — ПИКСЕЛЬ В ПИКСЕЛЬ тот же спиннер, что рисует LoginGate.tsx первым делом
  // после маунта (см. комментарий в index.html), поэтому не убираем его СРАЗУ после render(): React
  // должен успеть реально нарисовать кадр со своим спиннером ПОД сплэшем (двойной rAF — гарантия,
  // что браузер уже сделал layout+paint), и только тогда плавно скрыть сплэш — снаружи это выглядит
  // как один и тот же спиннер, а не смена одного на другой.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const splash = document.getElementById('splash')
    if (!splash) return
    splash.style.opacity = '0'
    setTimeout(() => splash.remove(), 200) // чуть больше длительности transition (150ms) в index.html
  }))
})
