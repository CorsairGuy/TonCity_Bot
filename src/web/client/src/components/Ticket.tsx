// Билет «Летнего карнавала» — иконка взята из ассетов игры
// (https://game.toncity.io/assets/tickets/ticket.png → src/items/ticket.png, раздаётся /items).
// Отдельный компонент, потому что билеты показывают сразу три страницы раздела «Годовщина».
export function TicketIcon({ size = 16 }: { size?: number }) {
  return (
    <img
      src="/items/ticket.png"
      alt="билет"
      width={size}
      height={size}
      style={{ objectFit: 'contain', verticalAlign: 'middle', flexShrink: 0 }}
      onError={e => { (e.target as HTMLImageElement).style.opacity = '.3'; }}
    />
  );
}

export function TicketValue({ value, size = 16 }: { value: number | string; size?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
      {value}
      <TicketIcon size={size} />
    </span>
  );
}

// «до конца дня»: событие живёт по UTC-суткам, игра отдаёт готовый момент day_end.
export function fmtCountdown(target: string | null | undefined, now: number): string {
  if (!target) return '';
  const ms = new Date(target).getTime() - now;
  if (!isFinite(ms) || ms <= 0) return '00:00:00';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d} д ${h % 24} ч`;
  }
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
