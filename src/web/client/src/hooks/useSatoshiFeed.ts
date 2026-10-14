import { useEffect, useRef } from 'react';
import type { SatoshiCandle, SatoshiFeedSource } from '../api';

interface PriceTick { price: number; change_percent: number; timestamp: number; source?: string }
type WsMsg =
  | { source: SatoshiFeedSource; type: 'snapshot'; price: PriceTick }
  | { source: SatoshiFeedSource; type: 'tick'; price: PriceTick }
  | { source: SatoshiFeedSource; type: 'candle'; timeframe: string; candle: SatoshiCandle }
  | { type: 'positions-changed'; account: string };

// Один общий WS на вкладку. Курс БИРЖИ бэкенд рассылает всегда (лёгкий, нужен многим страницам).
// Курс ИГРЫ рассылается ТОЛЬКО тем вкладкам, которые явно подписались (страница "Торговля") — если
// на ней никто не смотрит, бэкенд всё равно держит фид для авто-закрытия TP/SL, но в браузер не шлёт.
export function useSatoshiFeed(handlers: {
  sources?: SatoshiFeedSource[]; // какие источники нужны этой странице (по умолчанию только exchange)
  onTick?: (source: SatoshiFeedSource, price: PriceTick) => void;
  onCandle?: (source: SatoshiFeedSource, timeframe: string, candle: SatoshiCandle) => void;
  // позиция открылась/закрылась (в т.ч. авто по TP/SL или условному ордеру) — толкает бэкенд сразу,
  // без этого пришлось бы ждать периодического опроса, чтобы таблицы отразили закрытую позицию
  onPositionsChanged?: (account: string) => void;
}) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const sources = handlers.sources ?? ['exchange'];
  const sourcesKey = sources.join(',');

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let backoff = 1000;

    const subscribeAll = () => {
      for (const s of sourcesKey.split(',')) ws?.send(JSON.stringify({ type: 'subscribe', source: s }));
    };

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws/satoshi`);
      ws.onopen = () => { backoff = 1000; subscribeAll(); };
      ws.onmessage = ev => {
        let msg: WsMsg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'tick' || msg.type === 'snapshot') handlersRef.current.onTick?.(msg.source, msg.price);
        else if (msg.type === 'candle') handlersRef.current.onCandle?.(msg.source, msg.timeframe, msg.candle);
        else if (msg.type === 'positions-changed') handlersRef.current.onPositionsChanged?.(msg.account);
      };
      ws.onclose = () => {
        if (closed) return;
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 15000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      closed = true;
      if (ws?.readyState === WebSocket.OPEN) { for (const s of sourcesKey.split(',')) ws.send(JSON.stringify({ type: 'unsubscribe', source: s })); }
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesKey]);
}
