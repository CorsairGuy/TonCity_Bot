import { useEffect, useRef, type KeyboardEvent, type ClipboardEvent } from 'react';
import { Box } from '@primer/react';

// Поле слова «как код из СМС»: по ячейке на букву. Фокус сам идёт вперёд при вводе и назад
// при стирании, стрелки двигают курсор, вставка раскладывает слово по ячейкам, Enter — onEnter.
const LETTER = /[а-яёa-z]/i;
const onlyLetters = (s: string) => Array.from(s).filter(ch => LETTER.test(ch)).join('').toLowerCase();

export function WordCells({ value, onChange, onEnter, length = 5, size = 48, disabled, autoFocus }: {
  value: string; onChange: (v: string) => void; onEnter?: () => void;
  length?: number; size?: number; disabled?: boolean; autoFocus?: boolean;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  // пустая ячейка внутри слова хранится пробелом, хвостовые пробелы срезаются
  const chars = Array.from({ length }, (_, i) => (value[i] ?? '').trim());
  const emit = (arr: string[]) => onChange(arr.map(c => c || ' ').join('').trimEnd());
  const firstEmpty = () => { const k = chars.findIndex(c => !c); return k < 0 ? length - 1 : k; };
  const focusAt = (i: number) => { const el = refs.current[Math.max(0, Math.min(length - 1, i))]; el?.focus(); el?.select(); };

  useEffect(() => { if (autoFocus) focusAt(firstEmpty()); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // кладём буквы, начиная с ячейки i, и переводим фокус на следующую
  const put = (i: number, letters: string) => {
    const arr = chars.slice();
    let k = i;
    for (const ch of letters) { if (k >= length) break; arr[k++] = ch; }
    emit(arr);
    focusAt(Math.min(k, length - 1));
  };
  const clearAt = (i: number) => { const arr = chars.slice(); arr[i] = ''; emit(arr); };

  const onKeyDown = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); onEnter?.(); return; }
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (chars[i]) clearAt(i);
      else if (i > 0) { clearAt(i - 1); focusAt(i - 1); }
      return;
    }
    if (e.key === 'Delete') { e.preventDefault(); if (chars[i]) clearAt(i); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); focusAt(i - 1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); focusAt(i + 1); return; }
    if (e.key === 'Home') { e.preventDefault(); focusAt(0); return; }
    if (e.key === 'End') { e.preventDefault(); focusAt(length - 1); return; }
    // одиночная буква с клавиатуры — заменяем содержимое ячейки (в т.ч. уже заполненной)
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (LETTER.test(e.key)) put(i, e.key.toLowerCase());
    }
  };

  // запасной путь для мобильных клавиатур/автозаполнения, где keydown не несёт буквы
  const onInput = (i: number) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = onlyLetters(e.target.value);
    const old = chars[i];
    const letters = raw.length > 1 && old && raw.startsWith(old) ? raw.slice(1) : raw;
    if (!letters) { if (old) clearAt(i); return; }
    put(i, letters);
  };

  const onPaste = (i: number) => (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const letters = onlyLetters(e.clipboardData.getData('text'));
    if (letters) put(letters.length >= length ? 0 : i, letters);
  };

  return (
    <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
      {chars.map((c, i) => (
        <Box
          as="input"
          key={i}
          ref={(el: HTMLInputElement | null) => { refs.current[i] = el; }}
          value={c}
          disabled={disabled}
          inputMode="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label={`Буква ${i + 1}`}
          onChange={onInput(i)}
          onKeyDown={onKeyDown(i)}
          onPaste={onPaste(i)}
          onFocus={(e: React.FocusEvent<HTMLInputElement>) => e.target.select()}
          sx={{
            width: size, height: size, p: 0, flexShrink: 0, textAlign: 'center',
            fontSize: '22px', fontWeight: 600, fontFamily: 'inherit', textTransform: 'uppercase',
            color: 'fg.default', bg: 'canvas.default', caretColor: 'transparent',
            border: '1px solid', borderColor: 'border.default', borderRadius: 2, outline: 'none',
            transition: 'border-color .12s, box-shadow .12s',
            '&:focus': { borderColor: 'accent.emphasis', boxShadow: (t: any) => `inset 0 0 0 1px ${t.colors.accent.emphasis}` },
            '&::selection': { bg: 'transparent' },
            '&:disabled': { opacity: 0.6, cursor: 'not-allowed' },
          }}
        />
      ))}
    </Box>
  );
}
