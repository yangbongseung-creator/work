import type { Card, Column, LabelColor } from './types';

/** noAssignee는 "담당자 없음" 선택지. 실제 담당자 이름과 섞이지 않게 별도 칸으로 둔다. */
export type Filters = { query: string; labels: LabelColor[]; assignees: string[]; noAssignee: boolean };
export const emptyFilters: Filters = { query: '', labels: [], assignees: [], noAssignee: false };

export function hasFilters(f: Filters): boolean {
  return f.query.trim() !== '' || f.labels.length > 0 || f.assignees.length > 0 || f.noAssignee;
}

/** 검색 AND 라벨(하나라도) AND 담당자(하나라도) */
export function matchCard(card: Card, f: Filters): boolean {
  const q = f.query.trim().toLowerCase();
  if (q && !card.title.toLowerCase().includes(q) && !card.description.toLowerCase().includes(q)) return false;
  if (f.labels.length > 0 && !f.labels.some((l) => card.labels.includes(l))) return false;
  if (f.assignees.length > 0 || f.noAssignee) {
    const ok = (f.noAssignee && card.assignee === '') || f.assignees.includes(card.assignee);
    if (!ok) return false;
  }
  return true;
}

export type DueGroupKey = 'overdue' | 'today' | 'upcoming' | 'none';
export const DUE_GROUP_TITLES: Record<DueGroupKey, string> = {
  overdue: '지남',
  today: '오늘',
  upcoming: '예정',
  none: '마감일 없음',
};

/** 마감일순 보기: 지남 → 오늘 → 예정 → 마감일 없음. 완료 열 카드는 기본적으로 숨긴다. */
export function groupByDue(
  cards: Card[],
  columns: Column[],
  today: string,
  includeDone: boolean,
): { key: DueGroupKey; cards: Card[] }[] {
  const colById = new Map(columns.map((c) => [c.id, c]));
  const visible = cards.filter((c) => {
    if (c.archived) return false;
    const col = colById.get(c.columnId);
    if (!col) return false;
    return includeDone || !col.isDone;
  });
  const order = (a: Card, b: Card) =>
    (colById.get(a.columnId)!.position - colById.get(b.columnId)!.position) || a.position - b.position;
  const byDate = (a: Card, b: Card) => (a.dueDate! < b.dueDate! ? -1 : a.dueDate! > b.dueDate! ? 1 : order(a, b));
  const groups: Record<DueGroupKey, Card[]> = { overdue: [], today: [], upcoming: [], none: [] };
  for (const c of visible) {
    if (!c.dueDate) groups.none.push(c);
    else if (c.dueDate < today) groups.overdue.push(c);
    else if (c.dueDate === today) groups.today.push(c);
    else groups.upcoming.push(c);
  }
  groups.overdue.sort(byDate);
  groups.today.sort(byDate);
  groups.upcoming.sort(byDate);
  groups.none.sort(order);
  return (['overdue', 'today', 'upcoming', 'none'] as DueGroupKey[]).map((key) => ({ key, cards: groups[key] }));
}
