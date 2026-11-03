import type { Changes, ChangeKind, Snapshot } from './types';

const FIELD: Record<ChangeKind, keyof Omit<Snapshot, 'revision'>> = {
  board: 'boards',
  column: 'columns',
  card: 'cards',
  check: 'checks',
  comment: 'comments',
  attachment: 'attachments',
  dismissal: 'dismissals',
};
const idOf = (kind: ChangeKind, row: any): string =>
  kind === 'dismissal' ? `${row.cardId}|${row.kind}|${row.dueDate}` : row.id;

/** 다른 탭의 변경 묶음을 내 화면 데이터에 합친다 (삭제는 삭제 ID로 전달됨) */
export function applyChanges(s: Snapshot, c: Changes): Snapshot {
  if (c.full) return c.full;
  const next: Snapshot = { ...s, revision: c.revision };
  const touched = new Set<keyof Omit<Snapshot, 'revision'>>();
  const list = (k: ChangeKind) => {
    const f = FIELD[k];
    if (!touched.has(f)) {
      (next as any)[f] = [...(next as any)[f]];
      touched.add(f);
    }
    return (next as any)[f] as any[];
  };
  for (const r of c.remove) {
    const arr = list(r.kind);
    const i = arr.findIndex((x) => idOf(r.kind, x) === r.id);
    if (i >= 0) arr.splice(i, 1);
  }
  for (const u of c.upsert) {
    const arr = list(u.kind);
    const id = idOf(u.kind, u.row);
    const i = arr.findIndex((x) => idOf(u.kind, x) === id);
    if (i >= 0) arr[i] = u.row;
    else arr.push(u.row);
  }
  return next;
}
