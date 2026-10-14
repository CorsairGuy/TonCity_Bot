import { useState, useEffect } from 'react';
import { Box, Button, Flash, Heading, Label, Text, TextInput } from '@primer/react';
import { DataTable, Table } from '@primer/react/experimental';
import { TagIcon, ZapIcon } from '@primer/octicons-react';
import { api, type PromoAccount } from '../api';
import { sortByName } from '../utils';
import { useFlash } from '../hooks/useFlash';

export function Promocodes() {
  const [accounts, setAccounts] = useState<PromoAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [promoCode, setPromoCode] = useState('');
  const [activatingAll, setActivatingAll] = useState(false);
  const [activatingOne, setActivatingOne] = useState<Set<number>>(new Set());
  const { flash, showFlash } = useFlash();

  const load = async () => {
    setLoading(true);
    try {
      const d = await api.promoHistory();
      if (d.ok) setAccounts(sortByName(d.accounts, 'name'));
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const activateOne = async (id: number, name: string) => {
    if (!promoCode.trim()) { showFlash('Введите промокод', false); return; }
    setActivatingOne(prev => new Set(prev).add(id));
    try {
      const d = await api.promoActivate(id, promoCode.trim());
      if (d.ok) { showFlash(`[${name}] промокод активирован`, true); await load(); }
      else showFlash(`[${name}] ${d.error}`, false);
    } catch (e: unknown) { showFlash(String(e), false); }
    finally { setActivatingOne(prev => { const n = new Set(prev); n.delete(id); return n; }); }
  };

  const activateAll = async () => {
    if (!promoCode.trim()) { showFlash('Введите промокод', false); return; }
    setActivatingAll(true);
    try {
      const d = await api.promoActivateAll(promoCode.trim());
      if (d.ok) {
        const ok = d.results.filter((x: Record<string, unknown>) => x.ok).length;
        showFlash(`Активировано ${ok} аккаунтов`, ok > 0);
        await load();
      } else showFlash((d as { ok: boolean; error?: string }).error ?? 'Ошибка', false);
    } catch (e: unknown) { showFlash(String(e), false); }
    finally { setActivatingAll(false); }
  };

  const data = [...accounts]
    .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }))
    .map(a => ({ id: a.id ?? a.name, name: a.name, _entries: a.entries ?? [], _id: a.id ?? 0 }));

  return (
    <Box sx={{ p: 3 }}>
      <Heading as="h2" sx={{ fontSize: 3, mb: 3 }}>Промокоды</Heading>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, overflow: 'hidden' }}>
        <Box sx={{ px: 3, py: 2, bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.default' }}>
          <Text sx={{ fontWeight: 'bold' }}>Активация промокода</Text>
        </Box>
        <Box sx={{ p: 3, display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <TextInput
            value={promoCode}
            onChange={e => setPromoCode(e.target.value)}
            placeholder="Промокод..."
            onKeyDown={e => e.key === 'Enter' && activateAll()}
            sx={{ flex: 1, minWidth: 180 }}
          />
          <Button variant="primary" leadingVisual={ZapIcon} loading={activatingAll} disabled={activatingAll} onClick={activateAll}>
            Активировать всем
          </Button>
        </Box>
      </Box>

      <Table.Container>
        <DataTable
          data={data}
          initialSortColumn="name"
          initialSortDirection="ASC"
          columns={[
            {
              header: 'Аккаунт',
              field: 'name',
              rowHeader: true,
              sortBy: 'alphanumeric',
              renderCell: row => <strong>{row.name}</strong>,
            },
            {
              header: 'История',
              field: 'name',
              id: 'history',
              renderCell: row => row._entries.length === 0
                ? <Text sx={{ color: 'fg.muted', fontSize: 1 }}>—</Text>
                : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {row._entries.map((e, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="mono" style={{ fontSize: 12 }}>{e.code}</span>
                        <span className="mono" style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{e.used_at ?? '—'}</span>
                        {e.success ? <Label variant="success">OK</Label> : <Label variant="danger">Нет</Label>}
                      </div>
                    ))}
                  </div>
                ),
            },
            {
              header: '',
              field: 'name',
              id: 'action',
              renderCell: row => (
                <Button
                  variant="primary"
                  leadingVisual={TagIcon}
                  loading={activatingOne.has(row._id)}
                  disabled={activatingOne.has(row._id)}
                  onClick={() => activateOne(row._id, row.name)}
                >
                  Активировать
                </Button>
              ),
            },
          ]}
        />
      </Table.Container>
    </Box>
  );
}
