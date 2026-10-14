import { Component, type ReactNode } from 'react';

// Ограждение вокруг страниц. Две задачи:
//
// 1. Чёрный экран при переходе на другую страницу. Страницы грузятся лениво (lazy chunk), а после
//    каждой пересборки панели имена чанков меняются. Вкладка, открытая ДО пересборки, помнит старые
//    имена — при переходе браузер получает 404, динамический импорт падает, Suspense срывается и
//    приложение размонтируется целиком (не видно даже меню). Такую ошибку узнаём по тексту и просто
//    перезагружаем страницу один раз — новый index.html подтянет актуальные чанки.
// 2. Любая другая ошибка рендера больше не «съедает» весь интерфейс: показываем текст ошибки и
//    кнопку перезагрузки, а меню остаётся на месте.
const RELOAD_FLAG = 'tc-chunk-reload';
const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk/i;

interface State { error: Error | null }

export class PageErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error) {
    if (!CHUNK_ERROR.test(error?.message ?? '')) return;
    // защита от петли: перезагружаемся не чаще одного раза подряд
    try {
      if (sessionStorage.getItem(RELOAD_FLAG)) return;
      sessionStorage.setItem(RELOAD_FLAG, '1');
    } catch { /* приватный режим — просто пробуем перезагрузиться */ }
    location.reload();
  }

  componentDidMount() { try { sessionStorage.removeItem(RELOAD_FLAG); } catch { /* */ } }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ padding: 24 }}>
        <h2 style={{ marginBottom: 8 }}>Страница не открылась</h2>
        <p style={{ color: 'var(--fgColor-muted, #8b949e)', marginBottom: 16, whiteSpace: 'pre-wrap' }}>
          {error.message || String(error)}
        </p>
        <button onClick={() => { this.setState({ error: null }); location.reload(); }}>
          Перезагрузить
        </button>
      </div>
    );
  }
}
