// Старые файлы содержат UTC без зоны, новые — ISO с явным смещением.
// Преобразование выполняется при отображении одинаково для истории и SSE.
export function localLogLine(line: string): string {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})?)(\s+\[[\w]+\][\s\S]*)$/);
  if (!match) return line;
  let stamp = match[1].replace(' ', 'T');
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(stamp)) stamp += 'Z';
  const date = new Date(stamp);
  if (!Number.isFinite(date.getTime())) return line;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${match[2]}`;
}
