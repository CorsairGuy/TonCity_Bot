import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // регистрацию SW делаем сами (src/registerSW.ts) — нужен контроль над авто-перезагрузкой
      // вкладки при появлении новой версии и над периодической проверкой обновлений (браузер сам
      // проверяет sw.js на новизну не чаще раза в 24ч при обычной навигации — этого мало для PWA,
      // которое подолгу не перезагружается)
      injectRegister: null,
      includeAssets: ['pwa-icon.svg','apple-touch-icon.png'],
      manifest: {
        id: '/',
        name: 'TON City Bot',
        short_name: 'TON City',
        description: 'Панель управления ботом TON City',
        lang: 'ru',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#0d1117',
        theme_color: '#0d1117',
        icons: [
          // PNG обязательны: установка на Android/десктоп и иконка на iOS не берут SVG с фиксированным размером
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        // живые данные (аккаунты, карта города, рынок и т.п.) — НИКОГДА не кэшируем, только статику
        // сборки (JS/CSS/иконки), иначе офлайн/устаревший кэш будет подсовывать неактуальные данные
        navigateFallbackDenylist: [/^\/api\//],
        // + шрифт иконок MDI (woff2), чтобы иконки политик были и без сети
        globPatterns: ['**/*.{js,css,html,woff2}'],
        // RegExp в urlPattern Workbox сверяет с ПОЛНЫМ адресом (https://host/api/…), поэтому /^\/api\//
        // не срабатывал никогда — проверяем путь
        runtimeCaching: [{
          urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
          handler: 'NetworkOnly',
        }],
      },
    }),
  ],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-core':   ['react', 'react-dom', 'react-router-dom'],
          'primer':       ['@primer/react', '@primer/octicons-react'],
          'styled':       ['styled-components'],
          'scrollbars':   ['overlayscrollbars', 'overlayscrollbars-react'],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/sprites': 'http://localhost:3000',
      '/items': 'http://localhost:3000',
    }
  }
})
