import { useEffect, useRef } from 'react';
import {
  createChart, CandlestickSeries, ColorType, CrosshairMode, LineStyle,
  type IChartApi, type ISeriesApi, type IPriceLine,
  type ISeriesPrimitive, type IPrimitivePaneView, type IPrimitivePaneRenderer,
  type PrimitivePaneViewZOrder, type SeriesAttachedParameter, type Time,
} from 'lightweight-charts';
import type { SatoshiCandle } from '../api';

// Открытая позиция для отрисовки на графике: вход + уровни TP/SL/ликвидации + сторона + СВОЙ цвет
// (hue) — каждая позиция своим оттенком, чтобы зоны различались при наложении.
export interface ChartPosition {
  id: number; side: 'long' | 'short';
  entry: number; tp?: number | null; sl?: number | null; liq?: number | null;
  hue: number;
}

// ── Заливка «зон» позиций (canvas-примитив, идеально синхронизирован со шкалой цен) ──────────────
// Полупрозрачные полосы вход→TP (зелёная) и вход→SL (красная). Накладываются друг на друга — где
// позиций больше, зона насыщеннее (наглядная «плотность»). Рисуем ПОД свечами (zOrder bottom).
type Band = { a: number; b: number; color: string };
class BandsRenderer implements IPrimitivePaneRenderer {
  constructor(private _p: PositionBands) {}
  draw(target: { useBitmapCoordinateSpace: (cb: (scope: { context: CanvasRenderingContext2D; bitmapSize: { width: number; height: number }; verticalPixelRatio: number }) => void) => void }) {
    const series = this._p.series;
    if (!series) return;
    target.useBitmapCoordinateSpace(scope => {
      const ctx = scope.context;
      for (const b of this._p.bands) {
        const y1 = series.priceToCoordinate(b.a);
        const y2 = series.priceToCoordinate(b.b);
        if (y1 == null || y2 == null) continue;
        const top = Math.min(y1, y2) * scope.verticalPixelRatio;
        const h = Math.max(1, Math.abs(y2 - y1) * scope.verticalPixelRatio);
        ctx.fillStyle = b.color;
        ctx.fillRect(0, top, scope.bitmapSize.width, h);
      }
    });
  }
}
class BandsPaneView implements IPrimitivePaneView {
  constructor(private _p: PositionBands) {}
  zOrder(): PrimitivePaneViewZOrder { return 'bottom'; }
  renderer(): IPrimitivePaneRenderer { return new BandsRenderer(this._p); }
}
class PositionBands implements ISeriesPrimitive<Time> {
  series: ISeriesApi<'Candlestick'> | null = null;
  bands: Band[] = [];
  private _requestUpdate?: () => void;
  private _view = new BandsPaneView(this);
  attached(p: SeriesAttachedParameter<Time>) { this.series = p.series as ISeriesApi<'Candlestick'>; this._requestUpdate = p.requestUpdate; }
  detached() { this.series = null; this._requestUpdate = undefined; }
  updateAllViews() { /* полосы статичны между setBands */ }
  paneViews() { return [this._view]; }
  setBands(bands: Band[]) { this.bands = bands; this._requestUpdate?.(); }
}

// та же библиотека, что использует сам клиент игры (lightweight-charts), стилизовано под светлую тему.
// gamePrice — линия текущего курса ИГРЫ (фиолетовый пунктир). positions — открытые позиции: рисуем
// заливку зон вход→TP/SL и дедуплицированные линии уровней (иначе десятки ярлыков перекрывают ось).
export function SatoshiChart({ candles, liveCandle, gamePrice, positions, height = 420 }: {
  candles: SatoshiCandle[];
  liveCandle?: SatoshiCandle | null;
  gamePrice?: number | null;
  positions?: ChartPosition[];
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const gamePriceLineRef = useRef<IPriceLine | null>(null);
  const posLinesRef = useRef<IPriceLine[]>([]);
  const bandsRef = useRef<PositionBands | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#57606a', fontSize: 12 },
      grid: { vertLines: { color: 'rgba(140,149,159,0.12)' }, horzLines: { color: 'rgba(140,149,159,0.12)' } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(84,174,255,0.5)', width: 1, style: 3, labelBackgroundColor: '#0969da' },
        horzLine: { color: 'rgba(84,174,255,0.5)', width: 1, style: 3, labelBackgroundColor: '#0969da' },
      },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: 'rgba(140,149,159,0.25)' },
      rightPriceScale: { borderColor: 'rgba(140,149,159,0.25)', scaleMargins: { top: 0.08, bottom: 0.08 } },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#1a7f37', downColor: '#cf222e', borderVisible: false,
      wickUpColor: '#1a7f37', wickDownColor: '#cf222e',
      priceFormat: { type: 'price', precision: 3, minMove: 0.001 },
    });
    chartRef.current = chart;
    seriesRef.current = series;
    const bands = new PositionBands();
    series.attachPrimitive(bands);
    bandsRef.current = bands;
    if (candles.length) {
      series.setData(candles.map(c => ({ time: c.time as never, open: c.open, high: c.high, low: c.low, close: c.close })));
      const VISIBLE_BARS = 50;
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, candles.length - VISIBLE_BARS), to: candles.length - 1 + 3 });
    }

    return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; gamePriceLineRef.current = null; posLinesRef.current = []; bandsRef.current = null; };
  }, [height]);

  useEffect(() => {
    if (!liveCandle || !seriesRef.current) return;
    seriesRef.current.update({ time: liveCandle.time as never, open: liveCandle.open, high: liveCandle.high, low: liveCandle.low, close: liveCandle.close });
  }, [liveCandle]);

  // курс игры — горизонтальная линия поверх биржевого графика (фиолетовый пунктир)
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || gamePrice == null) return;
    if (gamePriceLineRef.current) {
      gamePriceLineRef.current.applyOptions({ price: gamePrice });
    } else {
      gamePriceLineRef.current = series.createPriceLine({
        price: gamePrice, color: '#8250df', lineWidth: 2, lineStyle: LineStyle.Dashed, axisLabelVisible: true,
      });
    }
  }, [gamePrice]);

  // позиции: у КАЖДОЙ свой цвет (hue). Заливка-«коридор» между её TP и SL этим цветом (наложение
  // разных оттенков различимо), плюс её линии вход/TP/SL/ликв тем же цветом. Ярлыки правой оси НЕ
  // включаем (иначе десятки наезжают друг на друга — «баг»); идентичность даёт легенда под графиком.
  useEffect(() => {
    const series = seriesRef.current;
    const bands = bandsRef.current;
    if (!series) return;
    for (const l of posLinesRef.current) { try { series.removePriceLine(l); } catch { /* уже снята */ } }
    posLinesRef.current = [];

    const list = positions ?? [];
    const bandSpecs: Band[] = [];
    for (const p of list) {
      const fill = `hsla(${p.hue}, 70%, 45%, 0.13)`;
      const line = `hsl(${p.hue}, 68%, 42%)`;
      // коридор позиции: между TP и SL (если оба заданы), иначе между входом и единственным уровнем
      const exits = [p.tp, p.sl].filter((x): x is number => !!x && x > 0);
      if (exits.length === 2) bandSpecs.push({ a: Math.min(...exits), b: Math.max(...exits), color: fill });
      else if (exits.length === 1 && p.entry > 0) bandSpecs.push({ a: Math.min(p.entry, exits[0]), b: Math.max(p.entry, exits[0]), color: fill });
      const mk = (price: number | null | undefined, style: LineStyle, width: 1 | 2) => {
        if (!price || price <= 0) return;
        posLinesRef.current.push(series.createPriceLine({ price, color: line, lineWidth: width, lineStyle: style, axisLabelVisible: false }));
      };
      mk(p.entry, LineStyle.Solid, 1);
      mk(p.tp, LineStyle.Dashed, 2);
      mk(p.sl, LineStyle.Dashed, 2);
      mk(p.liq, LineStyle.Dotted, 1);
    }
    bands?.setBands(bandSpecs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions]);

  return <div ref={containerRef} style={{ width: '100%', height }} />;
}
