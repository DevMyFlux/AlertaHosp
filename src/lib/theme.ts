import { useEffect, useState } from 'react';
import { UNIT_META, type UnitCode } from '../../core/unitMeta';

export type ThemeChoice = 'light' | 'dark' | 'system';
const KEY = 'tema';

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* armazenamento indisponível */
  }
  return 'system';
}

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

export function useTheme(): { choice: ThemeChoice; resolved: 'light' | 'dark'; setChoice: (c: ThemeChoice) => void } {
  const [choice, setChoiceState] = useState<ThemeChoice>(read);
  const [dark, setDark] = useState(systemDark);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const resolved = choice === 'system' ? (dark ? 'dark' : 'light') : choice;
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
  }, [resolved]);

  const setChoice = (c: ThemeChoice) => {
    setChoiceState(c);
    try {
      localStorage.setItem(KEY, c);
    } catch {
      /* ignora */
    }
  };
  return { choice, resolved, setChoice };
}

/** Aplica a cor da unidade em toda a interface (variável CSS --unit). */
export function useUnitAccent(unit: UnitCode, theme: 'light' | 'dark'): void {
  useEffect(() => {
    const meta = UNIT_META[unit];
    document.documentElement.style.setProperty('--unit', theme === 'dark' ? meta.accentDark : meta.accent);
    document.documentElement.style.setProperty('--unit-ink', theme === 'dark' ? '#06121a' : '#ffffff');
    document.documentElement.setAttribute('data-unit', unit);
    document.title = `${unit} · Monitor de Energia`;
  }, [unit, theme]);
}
