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
      includeAssets: ['pwa-icon.svg'],
      manifest: {
        name: 'TonCity Bot',
        short_name: 'TonCity',
        description: 'Панель управления ботом TON City',
        start_url: '/',
        display: 'standalone',
        background_color: '#0d1117',
        theme_color: '#0d1117',
        icons: [
          { src: '/pwa-icon.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
          { src: '/pwa-icon.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        // живые данные (аккаунты, карта города, рынок и т.п.) — НИКОГДА не кэшируем, только статику
        // сборки (JS/CSS/иконки), иначе офлайн/устаревший кэш будет подсовывать неактуальные данные
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [{
          urlPattern: /^\/api\//,
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
