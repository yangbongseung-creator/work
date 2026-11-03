export type Repeat = 'none' | 'daily' | 'weekly' | 'monthly';

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
  archived: boolean;
  position: number;
  followupId: string | null; // 반복 후속 카드 (5단계에서 사용)
  rev: number;
};

export type Kind = 'board' | 'column' | 'card';
export type Row = Board | Column | Card;

export type Snapshot = {
  revision: number;
  boards: Board[];
  columns: Column[];
  cards: Card[];
};

/** 되돌리기·다시 실행에 쓰는 "바뀐 내용" 묶음 */
export type Patch = {
  upsert: { boards: Board[]; columns: Column[]; cards: Card[] };
  remove: { boards: string[]; columns: string[]; cards: string[] };
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
  | { conflict: true; snapshot: Snapshot }
  | { conflict: false; snapshot: Snapshot; touched: Record<string, number | null>; entry: Entry | null };

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
  undoSteps: 50,
  changeLog: 5000,
} as const;
