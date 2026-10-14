import { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Button, Select, Text } from '@primer/react';
import { api } from '../api';

const MAX_LINES = 2000; // ограничение памяти в долго открытой вкладке
const BOTTOM_THRESHOLD = 40; // px — насколько близко к низу считается "у низа"

function colorLine(l: string) {
  const lw = l.toLowerCase();
  const isErr = lw.includes('error');
  const isWarn = lw.includes('warn');
  const m = l.match(/^(\d{2}:\d{2}:\d{2})\s+(\[\w+\])\s*([\s\S]*)$/);
  if (!m) return <span className={`log-line${isErr ? ' error' : isWarn ? ' warn' : ''}`}>{l}</span>;
  const [, ts, tag, msg] = m;
  const tagKey = tag.replace(/[\[\]]/g, '').toLowerCase();
  const tagCls = isErr ? 'error' : isWarn ? 'warn' : tagKey;
  return (
    <span className="log-line">
      <span className="log-ts">{ts}</span>{' '}
      <span className={`log-tag ${tagCls}`}>{tag}</span>{' '}
      <span className={`log-msg${isErr ? ' error' : isWarn ? ' warn' : ''}`}>{msg}</span>
    </span>
  );
}

export function Logs() {
  const [logs, setLogs] = useState<string[]>([]);
  const [filter, setFilter] = useState<'all' | 'error' | 'warn'>('all');
  const [lines, setLines] = useState(200);
  const bodyRef = useRef<HTMLDivElement>(null);
  // был ли пользователь у самого низа ПЕРЕД очередным обновлением — только тогда авто-скроллим
  // вниз при появлении новых строк. Если он прокрутил вверх читать историю — не сбиваем.
  const atBottomRef = useRef(true);

  const load = useCallback(async () => {
    const d = await api.logs(lines).catch(() => null);
    if (d?.ok) { atBottomRef.current = true; setLogs(d.logs); }
  }, [lines]);

  useEffect(() => { load(); }, [load]);

  // живой хвост — без поллинга, новые строки летят по SSE прямо в момент записи лога на сервере
  // (см. utils/logStream.js). /api/logs выше используется только для начальной подгрузки истории.
  useEffect(() => {
    const es = new EventSource('/api/logs/stream');
    es.onmessage = (e) => {
      const { line } = JSON.parse(e.data) as { line: string };
      setLogs(prev => {
        const next = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev;
        return [...next, line];
      });
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    if (bodyRef.current && atBottomRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [logs]);

  const handleScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
  };

  const filtered = filter === 'all' ? logs : logs.filter(l => l.toLowerCase().includes(filter));

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - var(--header-h))', p: 0, maxWidth: 'none' }}>
      {/* toolbar */}
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 2,
        p: 2,
        bg: 'canvas.subtle',
        borderBottom: '1px solid', borderColor: 'border.default',
        flexShrink: 0, flexWrap: 'wrap',
      }}>
        <Box sx={{ display: 'flex', gap: 1 }}>
          {(['all', 'error', 'warn'] as const).map(f => (
            <Button
              key={f}
              variant={filter === f ? 'primary' : 'default'}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'Все' : f === 'error' ? 'Ошибки' : 'Предупреждения'}
            </Button>
          ))}
        </Box>
        <Select value={String(lines)} onChange={e => setLines(Number(e.target.value))} sx={{ fontSize: 0 }}>
          <Select.Option value="100">100 строк</Select.Option>
          <Select.Option value="200">200 строк</Select.Option>
          <Select.Option value="500">500 строк</Select.Option>
          <Select.Option value="1000">1000 строк</Select.Option>
        </Select>
        <Button onClick={load} sx={{ ml: 'auto' }}>↻ Обновить</Button>
      </Box>

      <div ref={bodyRef} onScroll={handleScroll} style={{
        flex: 1, padding: '12px 16px',
        fontFamily: '"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace',
        fontSize: 12.5, lineHeight: 1.6,
        overflowY: 'auto', minHeight: 0,
      }}>
        {filtered.length === 0
          ? <Text sx={{ color: 'fg.subtle' }}>Нет записей</Text>
          : filtered.map((l, i) => <span key={i}>{colorLine(l)}{'\n'}</span>)
        }
      </div>
    </Box>
  );
}
