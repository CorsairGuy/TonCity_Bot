import { useState, useEffect, useMemo } from 'react';
import { Box, Button, Flash, Heading, Label, LabelGroup, Octicon, ProgressBar, Spinner, Text, TextInput, Token } from '@primer/react';
import { CheckCircleFillIcon, XCircleFillIcon, DashIcon, ZapIcon, TagIcon, SyncIcon, ChevronDownIcon, ChevronUpIcon } from '@primer/octicons-react';
import { api, type PromoAccount } from '../api';
import { PageHeader } from '../components/PageHeader';
import { CoinIcon, CrystalIcon } from '../components/Icons';
import { useFlash } from '../hooks/useFlash';
import { useNarrow } from '../hooks/useNarrow';
import { useItemCatalog, itemName, catalogItemImg } from '../hooks/useItemCatalog';

// Сводка по одному коду: кто получил, кому игра отказала, кто его ещё не вводил.
type Agg = { code: string; last: string; ok: string[]; fail: string[]; missing: { id: number; name: string }[]; reward: unknown };

const MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function fmtWhen(s: string) {
  const d = new Date(s);
  if (isNaN(d.getTime())) return '—';
  return `${d.getDate()} ${MON[d.getMonth()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function aggregate(accs: PromoAccount[]): Agg[] {
  const live = accs.filter(a => a.id != null);
  const m = new Map<string, Agg>();
  for (const a of accs) for (const e of a.entries) {
    let g = m.get(e.code);
    if (!g) { g = { code: e.code, last: e.used_at, ok: [], fail: [], missing: [], reward: null }; m.set(e.code, g); }
    if (e.used_at > g.last) g.last = e.used_at;
    if (e.success) { g.ok.push(a.name); if (!g.reward && e.reward) g.reward = e.reward; }
    else g.fail.push(a.name);
  }
  for (const g of m.values()) {
    const seen = new Set([...g.ok, ...g.fail]);
    g.missing = live.filter(a => !seen.has(a.name)).map(a => ({ id: a.id as number, name: a.name }));
  }
  return [...m.values()].sort((a, b) => b.last.localeCompare(a.last));
}

// Награду игра отдаёт в свободной форме — разбираем известные поля (монеты, кристаллы, предметы),
// остальное показываем как «ключ: значение», чтобы ничего не потерять.
type Part = { kind: 'coins' | 'crystals' | 'item' | 'other'; amount?: number; id?: number; text?: string };
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !isNaN(+v) ? +v : null);
function rewardParts(r: unknown): Part[] {
  if (r == null) return [];
  if (Array.isArray(r)) return r.flatMap(rewardParts);
  if (typeof r !== 'object') return [{ kind: 'other', text: String(r) }];
  const o = r as Record<string, unknown>;
  const out: Part[] = [];
  const type = typeof o.type === 'string' ? o.type.toLowerCase() : typeof o.reward_type === 'string' ? (o.reward_type as string).toLowerCase() : null;
  const amt = num(o.amount ?? o.quantity ?? o.qty ?? o.count ?? o.value);
  const itemId = num(o.item_id ?? o.market_id ?? (type === 'item' || (!type && amt != null) ? o.id : undefined));
  if (type && amt != null) {
    if (type.startsWith('coin')) return [{ kind: 'coins', amount: amt }];
    if (type.startsWith('crystal') || type.startsWith('gem')) return [{ kind: 'crystals', amount: amt }];
  }
  if (itemId != null) return [{ kind: 'item', id: itemId, amount: amt ?? 1 }];
  for (const [k, v] of Object.entries(o)) {
    const n = num(v);
    if (/^coins?$/i.test(k) && n != null) out.push({ kind: 'coins', amount: n });
    else if (/^(crystals?|gems?)$/i.test(k) && n != null) out.push({ kind: 'crystals', amount: n });
    else if (/items?|rewards?/i.test(k) && typeof v === 'object' && v) out.push(...rewardParts(v));
    else if (v != null && typeof v !== 'object' && k !== 'success' && k !== 'message') out.push({ kind: 'other', text: `${k}: ${v}` });
  }
  return out;
}

function Rewards({ r }: { r: unknown }) {
  const catalog = useItemCatalog();
  const parts = rewardParts(r);
  if (!parts.length) return null;
  const nf = (n?: number) => (n ?? 0).toLocaleString('ru-RU');
  return (
    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {parts.map((p, i) => {
        if (p.kind === 'coins') return <Token key={i} size="small" text={nf(p.amount)} leadingVisual={() => <CoinIcon size={14} />} />;
        if (p.kind === 'crystals') return <Token key={i} size="small" text={nf(p.amount)} leadingVisual={() => <CrystalIcon size={14} />} />;
        if (p.kind === 'item') {
          const img = catalogItemImg(p.id as number, catalog.get(p.id as number));
          return <Token key={i} size="small" text={`${itemName(p.id, catalog)} ×${p.amount}`}
            leadingVisual={img ? () => <img src={img} alt="" style={{ width: 16, height: 16, objectFit: 'contain' }} /> : undefined} />;
        }
        return <Token key={i} size="small" text={p.text ?? ''} />;
      })}
    </Box>
  );
}

function Count({ icon, color, n, title }: { icon: typeof DashIcon; color: string; n: number; title: string }) {
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }} title={title}>
      <Octicon icon={icon} size={14} sx={{ color }} />
      <Text sx={{ fontSize: 1, fontVariantNumeric: 'tabular-nums' }}>{n}</Text>
    </Box>
  );
}

function CodeCard({ g, total, busy, onRest }: { g: Agg; total: number; busy: boolean; onRest: () => void }) {
  const narrow = useNarrow();
  const [open, setOpen] = useState(false);
  const rest = g.fail.length + g.missing.length;
  const pct = (n: number) => (total ? (n / total) * 100 : 0);
  return (
    <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, bg: 'canvas.default', p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
        <Text sx={{ fontFamily: 'mono', fontWeight: 'semibold', fontSize: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.code}</Text>
        {rest === 0 ? <Label variant="success">Все {total}</Label> : <Label variant="attention">{g.ok.length} из {total}</Label>}
        <Text sx={{ ml: 'auto', color: 'fg.muted', fontSize: 0, whiteSpace: 'nowrap' }}>{fmtWhen(g.last)}</Text>
      </Box>
      <ProgressBar aria-label={`${g.code}: получили ${g.ok.length} из ${total}`}>
        <ProgressBar.Item progress={pct(g.ok.length)} sx={{ bg: 'success.emphasis' }} />
        <ProgressBar.Item progress={pct(g.fail.length)} sx={{ bg: 'danger.emphasis' }} />
      </ProgressBar>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
        <Box sx={{ display: 'flex', gap: 3 }}>
          <Count icon={CheckCircleFillIcon} color="success.fg" n={g.ok.length} title="Получили" />
          <Count icon={XCircleFillIcon} color="danger.fg" n={g.fail.length} title="Игра отказала" />
          <Count icon={DashIcon} color="fg.muted" n={g.missing.length} title="Ещё не вводили" />
        </Box>
        <Rewards r={g.reward} />
      </Box>
      {rest > 0 && (
        <Box sx={{ pt: 2, borderTop: '1px solid', borderColor: 'border.muted' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
            <Button variant="invisible" size="small" sx={{ ml: -2 }} trailingVisual={open ? ChevronUpIcon : ChevronDownIcon} onClick={() => setOpen(!open)}>
              Кто не получил
            </Button>
            <Button size="small" leadingVisual={SyncIcon} loading={busy} disabled={busy} onClick={onRest}>
              {narrow ? 'Оставшимся' : 'Активировать оставшимся'} · {rest}
            </Button>
          </Box>
          {open && (
            <LabelGroup sx={{ mt: 2 }}>
              {g.fail.map(n => <Label key={n} variant="danger" title="Игра отказала">{n}</Label>)}
              {g.missing.map(a => <Label key={a.name} title="Ещё не вводили">{a.name}</Label>)}
            </LabelGroup>
          )}
        </Box>
      )}
    </Box>
  );
}

export function Promocodes() {
  const narrow = useNarrow();
  const [accounts, setAccounts] = useState<PromoAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [promoCode, setPromoCode] = useState('');
  const [busy, setBusy] = useState<string | null>(null); // код, который сейчас вводится (или '' — новый из поля)
  const { flash, showFlash } = useFlash();

  const load = async () => {
    try {
      const d = await api.promoHistory();
      if (d.ok) setAccounts(d.accounts);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const codes = useMemo(() => aggregate(accounts), [accounts]);
  const total = accounts.filter(a => a.id != null).length;

  // ids не заданы — все аккаунты; иначе только перечисленные («Активировать оставшимся»).
  const activate = async (code: string, ids?: number[]) => {
    if (!code) { showFlash('Введите промокод', false); return; }
    setBusy(ids ? code : '');
    try {
      const d = await api.promoActivateAll(code, ids);
      if (d.ok) {
        const ok = d.results.filter(x => x.ok && x.success).length;
        showFlash(`${code}: получили ${ok} из ${d.results.length}`, ok > 0);
        if (!ids) setPromoCode('');
        await load();
      } else showFlash((d as { error?: string }).error ?? 'Ошибка', false);
    } catch (e: unknown) { showFlash(String(e), false); }
    finally { setBusy(null); }
  };

  const restIds = (g: Agg) => {
    const byName = new Map(accounts.filter(a => a.id != null).map(a => [a.name, a.id as number]));
    return [...g.fail.map(n => byName.get(n)).filter((x): x is number => x != null), ...g.missing.map(a => a.id)];
  };

  const field = (
    <Box sx={{ display: 'flex', gap: 2, width: narrow ? '100%' : 'auto', mb: narrow ? 3 : 0 }}>
      <TextInput
        value={promoCode}
        onChange={e => setPromoCode(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && busy === null && activate(promoCode.trim())}
        leadingVisual={TagIcon}
        placeholder="Промокод"
        aria-label="Промокод"
        sx={{ width: narrow ? 'auto' : 260, flex: narrow ? 1 : 'none', fontFamily: 'mono' }}
      />
      <Button variant="primary" leadingVisual={ZapIcon} loading={busy === ''} disabled={busy !== null} onClick={() => activate(promoCode.trim())}>
        Всем
      </Button>
    </Box>
  );

  return (
    <Box sx={{ p: 3 }}>
      <PageHeader title="Промокоды" sub={`${total} аккаунтов · ${codes.length} кодов`} actions={narrow ? undefined : field} />
      {narrow && field}
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}
      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 5 }}><Spinner /></Box>
      ) : codes.length === 0 ? (
        <Text sx={{ color: 'fg.muted' }}>Коды ещё не вводились.</Text>
      ) : (
        <>
          <Heading as="h3" sx={{ fontSize: 2, mb: 2 }}>Введённые коды</Heading>
          <Box sx={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : 'repeat(auto-fill,minmax(380px,1fr))', gap: 3 }}>
            {codes.map(g => (
              <CodeCard key={g.code} g={g} total={total} busy={busy === g.code} onRest={() => busy === null && activate(g.code, restIds(g))} />
            ))}
          </Box>
        </>
      )}
    </Box>
  );
}
