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

/** 글자를 쓰는 칸이 아닌 input 종류 (체크박스 등에서는 Ctrl+Z가 앱의 되돌리기로 동작해야 한다) */
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image']);

/** 글을 쓰는 중인 칸인지 (그 칸에서는 Ctrl+Z를 칸 자체의 되돌리기에 맡긴다) */
export const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return !NON_TEXT_INPUTS.has((el as HTMLInputElement).type);
  return false;
};

/** 위치 숫자를 바꿔 카드 하나를 다른 카드들 사이(또는 열 끝)에 놓는다. 응답 전 화면에 먼저 보여줄 때 쓴다. */
export function placeCard(cards: Card[], id: string, columnId: string, prevId?: string, nextId?: string): Card[] {
  const posOf = (cid?: string) => (cid ? cards.find((c) => c.id === cid && c.id !== id)?.position : undefined);
  const prev = posOf(prevId);
  const next = posOf(nextId);
  let position: number;
  if (prev !== undefined && next !== undefined) position = (prev + next) / 2;
  else if (prev !== undefined) position = prev + 1;
  else if (next !== undefined) position = next - 1;
  else position = cards.reduce((m, c) => (c.columnId === columnId && c.id !== id ? Math.max(m, c.position) : m), -1) + 1;
  return cards.map((c) => (c.id === id ? { ...c, columnId, position } : c));
}

export function isOverdue(card: Card, col: Column | undefined, today: string) {
  return !!card.dueDate && card.dueDate < today && !col?.isDone && !card.archived;
}

export function fmtSize(n: number) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
