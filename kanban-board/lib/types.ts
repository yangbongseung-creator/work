export type Repeat = 'none' | 'daily' | 'weekly' | 'monthly';

export const LABEL_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];
export const LABEL_NAMES: Record<LabelColor, string> = {
  red: '빨강',
  orange: '주황',
  yellow: '노랑',
  green: '초록',
  blue: '파랑',
  purple: '보라',
};

export type Board = { id: string; name: string; position: number; rev: number };
export type Column = {
  id: string;
  boardId: string;
  name: string;
  position: number;
  isDone: boolean;
  rev: number;
};
export type Card = {
  id: string;
  columnId: string;
  title: string;
  description: string;
  assignee: string;
  dueDate: string | null; // YYYY-MM-DD
  repeat: Repeat;
  labels: LabelColor[];
  archived: boolean;
  position: number;
  followupId: string | null; // 반복 후속 카드를 이미 만들었으면 그 카드 ID
  rev: number;
};
export type CheckItem = { id: string; cardId: string; text: string; done: boolean; position: number; rev: number };
export type Comment = { id: string; cardId: string; body: string; createdAt: string; updatedAt: string; rev: number };
export type Attachment = {
  id: string;
  cardId: string;
  name: string;
  size: number;
  mime: string;
  storageKey: string;
  rev: number;
};

export type NotifyKind = 'dayBefore' | 'today' | 'overdue';
export type Dismissal = { cardId: string; kind: NotifyKind; dueDate: string };

export type Kind = 'board' | 'column' | 'card' | 'check' | 'comment' | 'attachment';
export type Row = Board | Column | Card | CheckItem | Comment | Attachment;

export type Snapshot = {
  revision: number;
  boards: Board[];
  columns: Column[];
  cards: Card[];
  checks: CheckItem[];
  comments: Comment[];
  attachments: Attachment[];
  dismissals: Dismissal[];
};

/** 되돌리기·다시 실행에 쓰는 "바뀐 내용" 묶음 */
export type Patch = {
  upsert: { kind: Kind; row: Row }[];
  remove: { kind: Kind; id: string }[];
};

/** 항목 키("card:UUID")와 그 항목이 가져야 할 변경 번호. null이면 "없어야 함" */
export type Expect = { key: string; rev: number | null }[];

export type Entry = {
  label: string;
  forward: Patch;
  inverse: Patch;
  expect: Expect;
};

export type Outcome = { snapshot: Snapshot; entry: Entry | null };

export type ApplyResult =
  | { conflict: true; reason: 'changed' | 'file'; snapshot: Snapshot }
  | { conflict: false; snapshot: Snapshot; touched: Record<string, number | null>; entry: Entry | null };

/** 다른 탭의 변경을 이어받을 때 쓰는 변경 묶음 */
export type ChangeKind = Kind | 'dismissal';
export type Changes = {
  revision: number;
  full?: Snapshot; // 이어받을 수 없을 만큼 오래됐으면 전체 데이터
  upsert: { kind: ChangeKind; row: unknown }[];
  remove: { kind: ChangeKind; id: string }[];
};

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export const LIMITS = {
  boardName: 50,
  columnName: 50,
  cardTitle: 100,
  cardDescription: 2000,
  checkText: 500,
  commentBody: 1000,
  attachmentsPerCard: 5,
  fileBytes: 10 * 1024 * 1024,
  undoSteps: 50,
  changeLog: 5000,
  retentionDays: 7,
} as const;

export const copySuffix = ' (복사본)';
/** 이름 + " (복사본)"이 한도를 넘으면 원래 이름의 끝을 잘라 맞춘다 */
export function copyName(name: string, max: number): string {
  const room = max - [...copySuffix].length;
  return [...name].slice(0, room).join('') + copySuffix;
}
