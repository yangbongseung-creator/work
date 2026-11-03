import type { Card, Column } from '../lib/types';

export function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function store(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function storeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 저장소를 못 써도 앱은 동작한다 */
  }
}

export const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

export function isOverdue(card: Card, col: Column | undefined, today: string) {
  return !!card.dueDate && card.dueDate < today && !col?.isDone && !card.archived;
}

export function fmtSize(n: number) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
