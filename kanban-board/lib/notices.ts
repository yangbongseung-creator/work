import { tomorrowOf } from './dates';
import type { Board, Card, Column, Dismissal, NotifyKind } from './types';

export type Notice = { cardId: string; boardId: string; boardName: string; title: string; kind: NotifyKind; dueDate: string };

export const NOTICE_TEXT: Record<NotifyKind, string> = { dayBefore: '하루 전', today: '당일', overdue: '마감 지남' };

/** 모든 보드의 마감 알림. 카드마다 현재 시점에 맞는 알림 하나만, 닫은 것은 제외한다. */
export function computeNotices(
  s: { boards: Board[]; columns: Column[]; cards: Card[]; dismissals: Dismissal[] },
  today: string,
): Notice[] {
  const tomorrow = tomorrowOf(today);
  const colById = new Map(s.columns.map((c) => [c.id, c]));
  const boardById = new Map(s.boards.map((b) => [b.id, b]));
  const dismissed = new Set(s.dismissals.map((d) => `${d.cardId}|${d.kind}|${d.dueDate}`));
  const out: Notice[] = [];
  for (const c of s.cards) {
    if (c.archived || !c.dueDate) continue;
    const col = colById.get(c.columnId);
    if (!col || col.isDone) continue;
    const board = boardById.get(col.boardId);
    if (!board) continue;
    let kind: NotifyKind | null = null;
    if (c.dueDate < today) kind = 'overdue';
    else if (c.dueDate === today) kind = 'today';
    else if (c.dueDate === tomorrow) kind = 'dayBefore';
    if (!kind) continue;
    if (dismissed.has(`${c.id}|${kind}|${c.dueDate}`)) continue;
    out.push({ cardId: c.id, boardId: board.id, boardName: board.name, title: c.title, kind, dueDate: c.dueDate });
  }
  return out.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
}
