import { useState, useEffect } from 'react';
import { Box, Button, Flash, Label, Text, TextInput } from '@primer/react';
import { DataTable, Table } from '@primer/react/experimental';
import { TrashIcon } from '@primer/octicons-react';
import { api, type Account } from '../api';
import { sortByName } from '../utils';

export function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [duplicateGroups, setDuplicateGroups] = useState<{ id: number; name: string }[][]>([]);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState<Set<number>>(new Set());
  const [addUrl, setAddUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [flash, setFlash] = useState<{ msg: string; ok: boolean } | null>(null);

  const showFlash = (msg: string, ok: boolean) => {
    setFlash({ msg, ok });
    setTimeout(() => setFlash(null), 4000);
  };

  const load = async () => {
    setLoading(true);
    try {
      const [d, dup] = await Promise.all([api.accounts(), api.accountDuplicates()]);
      if (d.ok) setAccounts(sortByName(d.accounts, 'name'));
      if (dup.ok) setDuplicateGroups(dup.groups);
    } finally { setLoading(false); }
  };

  const addAccount = async () => {
    if (!addUrl.trim()) return;
    setAdding(true);
    try {
      const d = await api.addAccount(addUrl.trim());
      if (d.ok) {
        showFlash(`Аккаунт ${d.name} ${d.created ? 'добавлен' : 'обновлён'}`, true);
        setAddUrl('');
        await load();
      } else showFlash(d.error ?? 'Ошибка', false);
    } finally { setAdding(false); }
  };

  const removeAccount = async (id: number, name: string) => {
    if (!confirm(`Удалить аккаунт «${name}»?`)) return;
    setRemoving(prev => new Set(prev).add(id));
    try {
      const d = await api.deleteAccount(id);
      if (d.ok) await load();
    } finally {
      setRemoving(prev => { const s = new Set(prev); s.delete(id); return s; });
    }
  };

  useEffect(() => { load(); }, []);

  // сортировка статуса от "хуже к лучше", чтобы проблемные аккаунты было видно сразу при клике на колонку
  const STATUS_RANK: Record<Account['sessionStatus'], number> = { dead: 0, unknown: 1, connecting: 2, active: 3 };
  const data = [...accounts]
    .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }))
    .map(a => ({ ...a, _status: a.hasToken ? STATUS_RANK[a.sessionStatus] : -1 }));

  return (
    <Box sx={{ p: 3 }}>
      {flash && <Flash variant={flash.ok ? 'success' : 'danger'} sx={{ mb: 3 }}>{flash.msg}</Flash>}

      {duplicateGroups.length > 0 && (
        <Box sx={{ border: '1px solid', borderColor: 'danger.emphasis', borderRadius: 2, mb: 3, p: 3, bg: 'danger.subtle' }}>
          <Text sx={{ fontSize: 1, fontWeight: 'bold', color: 'danger.fg', display: 'block', mb: 1 }}>
            Найдены задвоенные аккаунты ({duplicateGroups.length})
          </Text>
          <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 2 }}>
            Эти пары аккаунтов раскодируются в ОДИН и тот же ID игрового пользователя (проверено по JWT
            в access_token, не догадка) — значит это один и тот же реальный игровой аккаунт, добавленный
            дважды. Игра ротирует refresh_token на каждый рефреш: пока обе записи бота живут независимо,
            рефреш из одной строки БД инвалидирует токен другой — отсюда постоянные «Invalid or expired
            refresh token» без возможности восстановиться. Оставьте одну запись на пару, вторую удалите.
          </Text>
          {duplicateGroups.map((group, i) => (
            <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', py: 1 }}>
              {group.map(a => (
                <Box key={a.id} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Label variant="danger">{a.name} (id {a.id})</Label>
                  <Button
                    variant="danger"
                    loading={removing.has(a.id)}
                    disabled={removing.size > 0}
                    onClick={() => removeAccount(a.id, a.name)}
                  >
                    Удалить
                  </Button>
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      )}

      <Box sx={{ border: '1px solid', borderColor: 'border.default', borderRadius: 2, mb: 3, p: 3, bg: 'canvas.subtle' }}>
        <Text sx={{ fontSize: 1, fontWeight: 'bold', display: 'block', mb: 1 }}>Добавить аккаунт</Text>
        <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mb: 2 }}>
          Вставьте ссылку из игры вида https://game.toncity.io/auth?t=...
        </Text>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <TextInput
            value={addUrl}
            onChange={e => setAddUrl(e.target.value)}
            placeholder="https://game.toncity.io/auth?t=..."
            onKeyDown={e => e.key === 'Enter' && addAccount()}
            sx={{ flex: 1 }}
          />
          <Button variant="primary" onClick={addAccount} loading={adding}>+ Добавить</Button>
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
              header: 'Статус',
              field: '_status',
              sortBy: 'basic',
              renderCell: row => {
                if (!row.hasToken) return <Label variant="danger">Нет токена</Label>;
                switch (row.sessionStatus) {
                  case 'active': return <Label variant="success">Активен</Label>;
                  case 'dead': return <Label variant="danger">Токен протух</Label>;
                  case 'connecting': return <Label variant="attention">Подключается…</Label>;
                  default: return <Label variant="secondary">Не проверялся</Label>;
                }
              },
            },
            {
              header: '',
              field: 'name',
              id: 'action',
              renderCell: row => (
                <Button
                  variant="danger"
                  leadingVisual={TrashIcon}
                  loading={removing.has(row.id)}
                  onClick={() => removeAccount(row.id, row.name)}
                >
                  Удалить
                </Button>
              ),
            },
          ]}
        />
      </Table.Container>
    </Box>
  );
}
