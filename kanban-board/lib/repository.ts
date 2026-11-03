import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { isYmd, nextDueDate } from './dates';
import {
  AppError,
  LABEL_COLORS,
  LIMITS,
  copyName,
  type ApplyResult,
  type Attachment,
  type Board,
  type Card,
  type Changes,
  type CheckItem,
  type Column,
  type Comment,
  type Entry,
  type Expect,
  type Kind,
  type LabelColor,
  type NotifyKind,
  type Outcome,
  type Patch,
  type Repeat,
  type Row,
  type Snapshot,
} from './types';

/** 데이터 읽기·저장 창구. 나중에 Supabase 구현으로 갈아 끼운다. */
export interface BoardRepository {
  snapshot(): Snapshot;
  ensureFirstBoard(): void;
  createBoard(name: string): Outcome;
  renameBoard(id: string, name: string): Outcome;
  deleteBoard(id: string): Outcome;
  duplicateBoard(id: string): Outcome;
  addColumn(boardId: string, name: string): Outcome;
  renameColumn(id: string, name: string): Outcome;
  deleteColumn(id: string): Outcome;
  moveColumn(id: string, dir: -1 | 1): Outcome;
  setColumnDone(id: string, done: boolean): Outcome;
  addCard(columnId: string, title: string): Outcome;
  updateCard(id: string, fields: CardFields): Outcome;
  moveCard(id: string, toColumnId: string, index: number, today?: string): Outcome;
  deleteCard(id: string): Outcome;
  duplicateCard(id: string): Outcome;
  setArchived(ids: string[], archived: boolean): Outcome;
  bulkMove(ids: string[], toColumnId: string, today?: string): Outcome;
  bulkDelete(ids: string[]): Outcome;
  addCheck(cardId: string, text: string): Outcome;
  updateCheck(id: string, f: { text?: string; done?: boolean }): Outcome;
  deleteCheck(id: string): Outcome;
  addComment(cardId: string, body: string): Outcome;
  updateComment(id: string, body: string): Outcome;
  deleteComment(id: string): Outcome;
  addAttachment(cardId: string, meta: AttachmentMeta): Outcome;
  deleteAttachment(id: string): Outcome;
  dismiss(cardId: string, kind: NotifyKind, dueDate: string): Outcome;
  applyPatch(patch: Patch, expect: Expect): ApplyResult;
  changesSince(revision: number): Changes;
}

export type CardFields = Partial<{
  title: string;
  description: string;
  assignee: string;
  dueDate: string | null;
  repeat: Repeat;
  labels: LabelColor[];
}>;
export type AttachmentMeta = { name: string; size: number; mime: string; storageKey: string };

export type RepoOptions = {
  now?: () => number;
  /** 첨부파일이 실제로 남아 있는지 확인 (삭제 되돌리기 때 사용) */
  fileExists?: (storageKey: string) => boolean;
  /** 변경이 저장될 때마다 호출 (실시간 알림용) */
  onCommit?: (revision: number) => void;
  changeLogLimit?: number;
};

const TABLE: Record<Kind, string> = {
  board: 'boards',
  column: 'board_columns',
  card: 'cards',
  check: 'check_items',
  comment: 'comments',
  attachment: 'attachments',
};
const key = (kind: Kind, id: string) => `${kind}:${id}`;
const parseKey = (k: string): { kind: Kind; id: string } => {
  const i = k.indexOf(':');
  return { kind: k.slice(0, i) as Kind, id: k.slice(i + 1) };
};
const marks = (n: number) => Array(n).fill('?').join(',');

function cleanName(raw: unknown, max: number, label: string): string {
  if (typeof raw !== 'string') throw new AppError('INVALID', `${label}을(를) 입력해 주세요.`);
  const v = raw.trim();
  if (!v) throw new AppError('INVALID', `${label}을(를) 입력해 주세요.`);
  if ([...v].length > max) throw new AppError('INVALID', `${label}은(는) ${max}자까지 쓸 수 있어요.`);
  return v;
}
function cleanDate(raw: unknown): string | null {
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new AppError('INVALID', '날짜는 YYYY-MM-DD 형식이어야 해요.');
  if (!isYmd(raw)) throw new AppError('INVALID', '존재하지 않는 날짜예요.');
  return raw;
}
const REPEATS: Repeat[] = ['none', 'daily', 'weekly', 'monthly'];
const NOTIFY: NotifyKind[] = ['dayBefore', 'today', 'overdue'];

type Plan = { cardId: string; newId: string; checkIds: string[]; colId: string; due: string; repeat: Repeat };

export class SqliteBoardRepository implements BoardRepository {
  private db: Database.Database;
  private now: () => number;
  private fileExists?: (k: string) => boolean;
  private onCommit?: (rev: number) => void;
  private logLimit: number;

  constructor(file: string, opts: RepoOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.fileExists = opts.fileExists;
    this.onCommit = opts.onCommit;
    this.logLimit = opts.changeLogLimit ?? LIMITS.changeLog;
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta (id, revision) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS boards (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL, rev INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS board_columns (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL,
        is_done INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY, column_id TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', assignee TEXT NOT NULL DEFAULT '',
        due_date TEXT, repeat TEXT NOT NULL DEFAULT 'none', archived INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL, followup_id TEXT, rev INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS check_items (
        id TEXT PRIMARY KEY, card_id TEXT NOT NULL, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL, rev INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY, card_id TEXT NOT NULL, body TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, rev INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY, card_id TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL,
        mime TEXT NOT NULL, storage_key TEXT NOT NULL, deleted_at INTEGER, rev INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dismissals (
        card_id TEXT NOT NULL, kind TEXT NOT NULL, due_date TEXT NOT NULL,
        PRIMARY KEY (card_id, kind, due_date)
      );
      CREATE INDEX IF NOT EXISTS idx_columns_board ON board_columns(board_id);
      CREATE INDEX IF NOT EXISTS idx_cards_column ON cards(column_id);
      CREATE INDEX IF NOT EXISTS idx_checks_card ON check_items(card_id);
      CREATE INDEX IF NOT EXISTS idx_comments_card ON comments(card_id);
      CREATE INDEX IF NOT EXISTS idx_att_card ON attachments(card_id);
      CREATE TABLE IF NOT EXISTS changes (
        revision INTEGER NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_changes_rev ON changes(revision);
    `);
    // 1~2단계에서 만든 DB를 이어 쓸 수 있게 라벨 칸을 덧붙인다
    const cardCols = this.db.prepare('PRAGMA table_info(cards)').all() as { name: string }[];
    if (!cardCols.some((c) => c.name === 'labels')) {
      this.db.exec(`ALTER TABLE cards ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'`);
    }
  }

  // ───────── 읽기 ─────────

  snapshot(): Snapshot {
    const q = (sql: string) => this.db.prepare(sql).all() as any[];
    const revision = (this.db.prepare('SELECT revision FROM meta WHERE id = 1').get() as { revision: number }).revision;
    return {
      revision,
      boards: q('SELECT * FROM boards ORDER BY position, id').map(toBoard),
      columns: q('SELECT * FROM board_columns ORDER BY position, id').map(toColumn),
      cards: q('SELECT * FROM cards ORDER BY position, id').map(toCard),
      checks: q('SELECT * FROM check_items ORDER BY position, id').map(toCheck),
      comments: q('SELECT * FROM comments ORDER BY created_at, id').map(toComment),
      attachments: q('SELECT * FROM attachments WHERE deleted_at IS NULL ORDER BY rowid').map(toAttachment),
      dismissals: q('SELECT * FROM dismissals ORDER BY rowid').map((r) => ({ cardId: r.card_id, kind: r.kind, dueDate: r.due_date })),
    };
  }

  private load(k: string): Row | undefined {
    const { kind, id } = parseKey(k);
    const extra = kind === 'attachment' ? ' AND deleted_at IS NULL' : '';
    const r = this.db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE id = ?${extra}`).get(id) as any;
    return r ? MAP[kind](r) : undefined;
  }

  private columnsOf(boardId: string): Column[] {
    return (this.db.prepare('SELECT * FROM board_columns WHERE board_id = ? ORDER BY position, id').all(boardId) as any[]).map(toColumn);
  }
  /** 보관 카드까지 포함한 열의 모든 카드 */
  private cardsOf(columnId: string): Card[] {
    return (this.db.prepare('SELECT * FROM cards WHERE column_id = ? ORDER BY position, id').all(columnId) as any[]).map(toCard);
  }
  private visibleIds(columnId: string): string[] {
    return (this.db.prepare('SELECT id FROM cards WHERE column_id = ? AND archived = 0 ORDER BY position, id').all(columnId) as { id: string }[]).map((r) => r.id);
  }
  private checksOf(cardId: string): CheckItem[] {
    return (this.db.prepare('SELECT * FROM check_items WHERE card_id = ? ORDER BY position, id').all(cardId) as any[]).map(toCheck);
  }
  private mustBoard(id: string): Board {
    const b = this.load(key('board', id)) as Board | undefined;
    if (!b) throw new AppError('NOT_FOUND', '보드를 찾을 수 없어요. 다른 탭에서 지웠을 수 있어요.', 404);
    return b;
  }
  private mustColumn(id: string): Column {
    const c = this.load(key('column', id)) as Column | undefined;
    if (!c) throw new AppError('NOT_FOUND', '열을 찾을 수 없어요. 다른 탭에서 지웠을 수 있어요.', 404);
    return c;
  }
  private mustCard(id: string): Card {
    const c = this.load(key('card', id)) as Card | undefined;
    if (!c) throw new AppError('NOT_FOUND', '카드를 찾을 수 없어요. 다른 탭에서 지웠을 수 있어요.', 404);
    return c;
  }
  private must<T extends Row>(kind: Kind, id: string, label: string): T {
    const r = this.load(key(kind, id)) as T | undefined;
    if (!r) throw new AppError('NOT_FOUND', `${label}을(를) 찾을 수 없어요. 다른 탭에서 지웠을 수 있어요.`, 404);
    return r;
  }
  private boardOfColumn(columnId: string): string {
    return this.mustColumn(columnId).boardId;
  }

  // ───────── 설정 ─────────

  private getSetting(k: string): string | undefined {
    return (this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(k) as { value: string } | undefined)?.value;
  }
  private setSetting(k: string, v: string) {
    this.db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(k, v);
  }
  ensureFirstBoard(): void {
    if (this.getSetting('first_board_created') === '1') return;
    this.createBoard('내 첫 보드');
    this.setSetting('first_board_created', '1');
  }

  // ───────── 핵심: 변경을 한 묶음으로 처리 ─────────

  /**
   * 바뀔 수 있는 항목(cands)의 앞/뒤 상태를 비교해 바뀐 것만 저장하고,
   * 전역 revision과 항목별 변경 번호를 올린 뒤, 되돌리기용 patch를 만든다.
   */
  private mutate(label: string, cands: string[], fn: () => void): Outcome {
    const run = this.db.transaction((): { entry: Entry; revision: number } | null => {
      const uniq = [...new Set(cands)];
      const before = new Map<string, Row | undefined>(uniq.map((k) => [k, this.load(k)]));
      fn();
      const changed: { k: string; a: Row | undefined; b: Row | undefined }[] = [];
      for (const k of uniq) {
        const a = this.load(k);
        const b = before.get(k);
        if (!sameIgnoringRev(a, b)) changed.push({ k, a, b });
      }
      if (changed.length === 0) return null;

      const revision = this.bumpRevision();
      const forward: Patch = { upsert: [], remove: [] };
      const inverse: Patch = { upsert: [], remove: [] };
      const expect: Expect = [];
      const log = this.db.prepare('INSERT INTO changes (revision, kind, entity_id, action) VALUES (?, ?, ?, ?)');
      for (const { k, a, b } of changed) {
        const { kind, id } = parseKey(k);
        if (a) {
          this.db.prepare(`UPDATE ${TABLE[kind]} SET rev = ? WHERE id = ?`).run(revision, id);
          a.rev = revision;
          forward.upsert.push({ kind, row: a });
        } else {
          forward.remove.push({ kind, id });
        }
        if (b) inverse.upsert.push({ kind, row: b });
        else inverse.remove.push({ kind, id });
        expect.push({ key: k, rev: a ? revision : null });
        log.run(revision, kind, id, a ? (b ? 'update' : 'create') : 'delete');
      }
      this.db.prepare('DELETE FROM changes WHERE revision <= ?').run(revision - this.logLimit);
      return { entry: { label, forward, inverse, expect }, revision };
    });
    const res = run();
    if (res) this.onCommit?.(res.revision);
    return { snapshot: this.snapshot(), entry: res?.entry ?? null };
  }

  private bumpRevision(): number {
    this.db.prepare('UPDATE meta SET revision = revision + 1 WHERE id = 1').run();
    return (this.db.prepare('SELECT revision FROM meta WHERE id = 1').get() as { revision: number }).revision;
  }

  // ───────── 카드 아래 딸린 것들 ─────────

  private childKeys(cardIds: string[]): string[] {
    if (!cardIds.length) return [];
    const q = marks(cardIds.length);
    const get = (table: string, kind: Kind, extra = '') =>
      (this.db.prepare(`SELECT id FROM ${table} WHERE card_id IN (${q})${extra}`).all(...cardIds) as { id: string }[]).map((r) => key(kind, r.id));
    return [...get('check_items', 'check'), ...get('comments', 'comment'), ...get('attachments', 'attachment', ' AND deleted_at IS NULL')];
  }

  /** 카드와 딸린 항목을 지운다. 첨부는 파일을 바로 지우지 않고 삭제 표시만 한다. */
  private removeCardsSql(cardIds: string[]) {
    if (!cardIds.length) return;
    const q = marks(cardIds.length);
    this.db.prepare(`DELETE FROM check_items WHERE card_id IN (${q})`).run(...cardIds);
    this.db.prepare(`DELETE FROM comments WHERE card_id IN (${q})`).run(...cardIds);
    this.db.prepare(`UPDATE attachments SET deleted_at = ? WHERE card_id IN (${q}) AND deleted_at IS NULL`).run(this.now(), ...cardIds);
    this.db.prepare(`DELETE FROM dismissals WHERE card_id IN (${q})`).run(...cardIds);
    this.db.prepare(`DELETE FROM cards WHERE id IN (${q})`).run(...cardIds);
  }

  /** 열 안의 위치를 정리한다: 보이는 카드(주어진 순서) 뒤에 보관 카드를 둔다 */
  private layoutColumn(colId: string, visibleOrder: string[]) {
    const upd = this.db.prepare('UPDATE cards SET position = ? WHERE id = ?');
    const archived = (this.db.prepare('SELECT id FROM cards WHERE column_id = ? AND archived = 1 ORDER BY position, id').all(colId) as { id: string }[])
      .map((r) => r.id)
      .filter((id) => !visibleOrder.includes(id));
    [...visibleOrder, ...archived].forEach((id, p) => upd.run(p, id));
  }

  private insertCardRow(c: Card) {
    this.db
      .prepare(
        `INSERT INTO cards (id, column_id, title, description, assignee, due_date, repeat, labels, archived, position, followup_id, rev)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(c.id, c.columnId, c.title, c.description, c.assignee, c.dueDate, c.repeat, JSON.stringify(c.labels), c.archived ? 1 : 0, c.position, c.followupId);
  }
  private insertCheckRow(c: { id: string; cardId: string; text: string; done: boolean; position: number }) {
    this.db.prepare('INSERT INTO check_items (id, card_id, text, done, position, rev) VALUES (?, ?, ?, ?, ?, 0)').run(c.id, c.cardId, c.text, c.done ? 1 : 0, c.position);
  }

  // ───────── 보드 ─────────

  createBoard(rawName: string): Outcome {
    const name = cleanName(rawName, LIMITS.boardName, '보드 이름');
    const boardId = randomUUID();
    const colIds = [randomUUID(), randomUUID(), randomUUID()];
    return this.mutate('보드 만들기', [key('board', boardId), ...colIds.map((c) => key('column', c))], () => {
      const pos = (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM boards').get() as { p: number }).p;
      this.db.prepare('INSERT INTO boards (id, name, position, rev) VALUES (?, ?, ?, 0)').run(boardId, name, pos);
      ['할 일', '진행 중', '완료'].forEach((n, i) => {
        this.db
          .prepare('INSERT INTO board_columns (id, board_id, name, position, is_done, rev) VALUES (?, ?, ?, ?, ?, 0)')
          .run(colIds[i], boardId, n, i, i === 2 ? 1 : 0);
      });
    });
  }

  renameBoard(id: string, rawName: string): Outcome {
    const name = cleanName(rawName, LIMITS.boardName, '보드 이름');
    this.mustBoard(id);
    return this.mutate('보드 이름 변경', [key('board', id)], () => {
      this.db.prepare('UPDATE boards SET name = ? WHERE id = ?').run(name, id);
    });
  }

  deleteBoard(id: string): Outcome {
    this.mustBoard(id);
    const cols = this.columnsOf(id);
    const cards = cols.flatMap((c) => this.cardsOf(c.id));
    const cardIds = cards.map((c) => c.id);
    const cands = [key('board', id), ...cols.map((c) => key('column', c.id)), ...cardIds.map((c) => key('card', c)), ...this.childKeys(cardIds)];
    return this.mutate('보드 삭제', cands, () => {
      this.removeCardsSql(cardIds);
      this.db.prepare('DELETE FROM board_columns WHERE board_id = ?').run(id);
      this.db.prepare('DELETE FROM boards WHERE id = ?').run(id);
    });
  }

  duplicateBoard(id: string): Outcome {
    const src = this.mustBoard(id);
    const name = copyName(src.name, LIMITS.boardName);
    const newBoard = randomUUID();
    const cols = this.columnsOf(id);
    const colMap = new Map(cols.map((c) => [c.id, randomUUID()]));
    const cardPlans: { card: Card; newId: string; checks: { src: CheckItem; id: string }[] }[] = [];
    for (const c of cols) {
      for (const card of this.cardsOf(c.id).filter((x) => !x.archived)) {
        cardPlans.push({ card, newId: randomUUID(), checks: this.checksOf(card.id).map((s) => ({ src: s, id: randomUUID() })) });
      }
    }
    const cands = [
      key('board', newBoard),
      ...[...colMap.values()].map((c) => key('column', c)),
      ...cardPlans.flatMap((p) => [key('card', p.newId), ...p.checks.map((c) => key('check', c.id))]),
    ];
    return this.mutate('보드 복제', cands, () => {
      const pos = (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM boards').get() as { p: number }).p;
      this.db.prepare('INSERT INTO boards (id, name, position, rev) VALUES (?, ?, ?, 0)').run(newBoard, name, pos);
      cols.forEach((c, i) => {
        this.db
          .prepare('INSERT INTO board_columns (id, board_id, name, position, is_done, rev) VALUES (?, ?, ?, ?, ?, 0)')
          .run(colMap.get(c.id), newBoard, c.name, i, c.isDone ? 1 : 0);
      });
      const counters = new Map<string, number>();
      for (const p of cardPlans) {
        const col = colMap.get(p.card.columnId)!;
        const position = counters.get(col) ?? 0;
        counters.set(col, position + 1);
        this.insertCardRow({ ...p.card, id: p.newId, columnId: col, position, followupId: null, archived: false });
        p.checks.forEach((ch, i) => this.insertCheckRow({ id: ch.id, cardId: p.newId, text: ch.src.text, done: ch.src.done, position: i }));
      }
    });
  }

  // ───────── 열 ─────────

  addColumn(boardId: string, rawName: string): Outcome {
    const name = cleanName(rawName, LIMITS.columnName, '열 이름');
    this.mustBoard(boardId);
    const id = randomUUID();
    return this.mutate('열 추가', [key('column', id)], () => {
      const pos = (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM board_columns WHERE board_id = ?').get(boardId) as { p: number }).p;
      this.db.prepare('INSERT INTO board_columns (id, board_id, name, position, is_done, rev) VALUES (?, ?, ?, ?, 0, 0)').run(id, boardId, name, pos);
    });
  }

  renameColumn(id: string, rawName: string): Outcome {
    const name = cleanName(rawName, LIMITS.columnName, '열 이름');
    this.mustColumn(id);
    return this.mutate('열 이름 변경', [key('column', id)], () => {
      this.db.prepare('UPDATE board_columns SET name = ? WHERE id = ?').run(name, id);
    });
  }

  deleteColumn(id: string): Outcome {
    const col = this.mustColumn(id);
    if (this.columnsOf(col.boardId).length <= 1) throw new AppError('LAST_COLUMN', '마지막 남은 열은 삭제할 수 없어요.');
    const cardIds = this.cardsOf(id).map((c) => c.id); // 보관 카드 포함
    const cands = [key('column', id), ...cardIds.map((c) => key('card', c)), ...this.childKeys(cardIds)];
    return this.mutate('열 삭제', cands, () => {
      this.removeCardsSql(cardIds);
      this.db.prepare('DELETE FROM board_columns WHERE id = ?').run(id);
    });
  }

  moveColumn(id: string, dir: -1 | 1): Outcome {
    const col = this.mustColumn(id);
    const cols = this.columnsOf(col.boardId);
    return this.mutate('열 이동', cols.map((c) => key('column', c.id)), () => {
      const i = cols.findIndex((c) => c.id === id);
      const j = i + dir;
      if (j < 0 || j >= cols.length) return;
      const ids = cols.map((c) => c.id);
      [ids[i], ids[j]] = [ids[j], ids[i]];
      ids.forEach((cid, p) => this.db.prepare('UPDATE board_columns SET position = ? WHERE id = ?').run(p, cid));
    });
  }

  setColumnDone(id: string, done: boolean): Outcome {
    this.mustColumn(id);
    return this.mutate(done ? '완료 열 지정' : '완료 열 해제', [key('column', id)], () => {
      this.db.prepare('UPDATE board_columns SET is_done = ? WHERE id = ?').run(done ? 1 : 0, id);
    });
  }

  // ───────── 카드 ─────────

  addCard(columnId: string, rawTitle: string): Outcome {
    const title = cleanName(rawTitle, LIMITS.cardTitle, '카드 제목');
    this.mustColumn(columnId);
    const id = randomUUID();
    return this.mutate('카드 추가', [key('card', id)], () => {
      const pos = (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM cards WHERE column_id = ?').get(columnId) as { p: number }).p;
      this.insertCardRow({ id, columnId, title, description: '', assignee: '', dueDate: null, repeat: 'none', labels: [], archived: false, position: pos, followupId: null, rev: 0 });
    });
  }

  private firstOpenColumn(boardId: string): Column | undefined {
    return this.columnsOf(boardId).find((c) => !c.isDone);
  }

  updateCard(id: string, f: CardFields): Outcome {
    const card = this.mustCard(id);
    const next = { ...card };
    if (f.title !== undefined) next.title = cleanName(f.title, LIMITS.cardTitle, '카드 제목');
    if (f.description !== undefined) {
      if (typeof f.description !== 'string' || [...f.description].length > LIMITS.cardDescription) {
        throw new AppError('INVALID', `설명은 ${LIMITS.cardDescription}자까지 쓸 수 있어요.`);
      }
      next.description = f.description;
    }
    if (f.assignee !== undefined) {
      if (typeof f.assignee !== 'string') throw new AppError('INVALID', '담당자 형식이 올바르지 않아요.');
      next.assignee = f.assignee.trim().slice(0, 50);
    }
    if (f.labels !== undefined) {
      if (!Array.isArray(f.labels) || f.labels.some((l) => !LABEL_COLORS.includes(l))) throw new AppError('INVALID', '라벨 색이 올바르지 않아요.');
      next.labels = [...new Set(f.labels)];
    }
    if (f.dueDate !== undefined) {
      next.dueDate = cleanDate(f.dueDate);
      if (next.dueDate === null) next.repeat = 'none'; // 마감일을 지우면 반복도 해제
    }
    if (f.repeat !== undefined) {
      if (!REPEATS.includes(f.repeat)) throw new AppError('INVALID', '반복 주기가 올바르지 않아요.');
      if (f.repeat !== 'none') {
        if (next.dueDate === null) throw new AppError('INVALID', '반복을 설정하려면 마감일이 있어야 해요.');
        if (!this.firstOpenColumn(this.boardOfColumn(card.columnId))) {
          throw new AppError('NO_OPEN_COLUMN', '미완료 열이 없어서 반복을 설정할 수 없어요. 완료 열이 아닌 열이 하나는 있어야 해요.');
        }
      }
      next.repeat = f.repeat;
    }
    return this.mutate('카드 수정', [key('card', id)], () => {
      this.db
        .prepare('UPDATE cards SET title = ?, description = ?, assignee = ?, due_date = ?, repeat = ?, labels = ? WHERE id = ?')
        .run(next.title, next.description, next.assignee, next.dueDate, next.repeat, JSON.stringify(next.labels), id);
    });
  }

  /** 미완료 열 → 완료 열로 가는 반복 카드의 후속 카드 계획. 만들 수 없으면 작업 전체를 막는다. */
  private planFollowup(card: Card, from: Column, to: Column, today: string | undefined): Plan | null {
    if (!to.isDone || from.isDone) return null;
    if (card.repeat === 'none' || !card.dueDate || card.followupId) return null;
    if (!today || !isYmd(today)) throw new AppError('INVALID', '완료한 날짜를 알 수 없어 반복 카드를 만들 수 없어요.');
    const open = this.firstOpenColumn(to.boardId);
    if (!open) throw new AppError('NO_OPEN_COLUMN', '미완료 열이 없어서 반복 카드를 만들 수 없어요.');
    return {
      cardId: card.id,
      newId: randomUUID(),
      checkIds: this.checksOf(card.id).map(() => randomUUID()),
      colId: open.id,
      due: nextDueDate(today, card.repeat),
      repeat: card.repeat,
    };
  }
  private planKeys(p: Plan): string[] {
    return [key('card', p.newId), ...p.checkIds.map((c) => key('check', c))];
  }
  private execFollowup(p: Plan) {
    const orig = this.mustCard(p.cardId);
    const pos = (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS q FROM cards WHERE column_id = ?').get(p.colId) as { q: number }).q;
    this.insertCardRow({ ...orig, id: p.newId, columnId: p.colId, dueDate: p.due, repeat: p.repeat, archived: false, position: pos, followupId: null });
    this.checksOf(p.cardId).forEach((ch, i) =>
      this.insertCheckRow({ id: p.checkIds[i], cardId: p.newId, text: ch.text, done: false, position: i }),
    );
    this.db.prepare('UPDATE cards SET followup_id = ? WHERE id = ?').run(p.newId, p.cardId);
  }

  moveCard(id: string, toColumnId: string, index: number, today?: string): Outcome {
    const card = this.mustCard(id);
    if (card.archived) throw new AppError('INVALID', '보관된 카드는 먼저 복원해 주세요.');
    const from = this.mustColumn(card.columnId);
    const to = this.mustColumn(toColumnId);
    if (from.boardId !== to.boardId) throw new AppError('INVALID', '다른 보드로는 카드를 옮길 수 없어요.');
    const plan = this.planFollowup(card, from, to, today);
    const involved = from.id === to.id ? this.cardsOf(from.id) : [...this.cardsOf(from.id), ...this.cardsOf(to.id)];
    const cands = [...involved.map((c) => key('card', c.id)), ...(plan ? this.planKeys(plan) : [])];
    return this.mutate('카드 이동', cands, () => {
      const dst = this.visibleIds(to.id).filter((x) => x !== id);
      const at = Math.max(0, Math.min(Number.isFinite(index) ? Math.trunc(index) : dst.length, dst.length));
      dst.splice(at, 0, id);
      this.db.prepare('UPDATE cards SET column_id = ? WHERE id = ?').run(to.id, id);
      this.layoutColumn(to.id, dst);
      if (from.id !== to.id) this.layoutColumn(from.id, this.visibleIds(from.id));
      if (plan) this.execFollowup(plan);
    });
  }

  deleteCard(id: string): Outcome {
    this.mustCard(id);
    return this.mutate('카드 삭제', [key('card', id), ...this.childKeys([id])], () => this.removeCardsSql([id]));
  }

  duplicateCard(id: string): Outcome {
    const card = this.mustCard(id);
    if (card.archived) throw new AppError('INVALID', '보관된 카드는 먼저 복원한 뒤 복제해 주세요.');
    const newId = randomUUID();
    const checks = this.checksOf(id).map((s) => ({ src: s, id: randomUUID() }));
    const cands = [...this.cardsOf(card.columnId).map((c) => key('card', c.id)), key('card', newId), ...checks.map((c) => key('check', c.id))];
    return this.mutate('카드 복제', cands, () => {
      this.insertCardRow({ ...card, id: newId, title: copyName(card.title, LIMITS.cardTitle), followupId: null, archived: false, position: 9999 });
      checks.forEach((ch, i) => this.insertCheckRow({ id: ch.id, cardId: newId, text: ch.src.text, done: ch.src.done, position: i }));
      const order = this.visibleIds(card.columnId).filter((x) => x !== newId);
      order.splice(order.indexOf(id) + 1, 0, newId);
      this.layoutColumn(card.columnId, order);
    });
  }

  setArchived(ids: string[], archived: boolean): Outcome {
    const cards = [...new Set(ids)].map((i) => this.mustCard(i)).filter((c) => c.archived !== archived);
    const cols = [...new Set(cards.map((c) => c.columnId))];
    const cands = cols.flatMap((c) => this.cardsOf(c).map((x) => key('card', x.id)));
    return this.mutate(archived ? '카드 보관' : '카드 복원', cands, () => {
      for (const colId of cols) {
        const group = cards.filter((c) => c.columnId === colId).sort((a, b) => a.position - b.position);
        const visible = this.visibleIds(colId);
        const set = this.db.prepare('UPDATE cards SET archived = ? WHERE id = ?');
        group.forEach((c) => set.run(archived ? 1 : 0, c.id));
        if (archived) this.layoutColumn(colId, visible.filter((v) => !group.some((g) => g.id === v)));
        else this.layoutColumn(colId, [...visible, ...group.map((g) => g.id)]); // 원래 열의 맨 아래
      }
    });
  }

  bulkMove(ids: string[], toColumnId: string, today?: string): Outcome {
    const to = this.mustColumn(toColumnId);
    const colPos = new Map(this.columnsOf(to.boardId).map((c) => [c.id, c]));
    const cards = [...new Set(ids)].map((i) => this.mustCard(i));
    for (const c of cards) {
      if (!colPos.has(c.columnId)) throw new AppError('INVALID', '다른 보드로는 카드를 옮길 수 없어요.');
    }
    const moving = cards
      .filter((c) => !c.archived && c.columnId !== to.id)
      .sort((a, b) => colPos.get(a.columnId)!.position - colPos.get(b.columnId)!.position || a.position - b.position);
    if (moving.length === 0) return { snapshot: this.snapshot(), entry: null };
    const plans = moving.map((c) => this.planFollowup(c, colPos.get(c.columnId)!, to, today)).filter((p): p is Plan => !!p);
    const srcCols = [...new Set(moving.map((c) => c.columnId))];
    const cands = [
      ...[to.id, ...srcCols].flatMap((c) => this.cardsOf(c).map((x) => key('card', x.id))),
      ...plans.flatMap((p) => this.planKeys(p)),
    ];
    return this.mutate('카드 일괄 이동', cands, () => {
      const existing = this.visibleIds(to.id);
      const set = this.db.prepare('UPDATE cards SET column_id = ? WHERE id = ?');
      moving.forEach((c) => set.run(to.id, c.id));
      this.layoutColumn(to.id, [...existing, ...moving.map((c) => c.id)]);
      srcCols.forEach((s) => this.layoutColumn(s, this.visibleIds(s)));
      plans.forEach((p) => this.execFollowup(p));
    });
  }

  bulkDelete(ids: string[]): Outcome {
    const cards = [...new Set(ids)].map((i) => this.load(key('card', i)) as Card | undefined).filter((c): c is Card => !!c);
    if (cards.length === 0) throw new AppError('NOT_FOUND', '카드를 찾을 수 없어요. 다른 탭에서 지웠을 수 있어요.', 404);
    const cardIds = cards.map((c) => c.id);
    return this.mutate('카드 일괄 삭제', [...cardIds.map((c) => key('card', c)), ...this.childKeys(cardIds)], () => this.removeCardsSql(cardIds));
  }

  // ───────── 체크리스트 ─────────

  addCheck(cardId: string, rawText: string): Outcome {
    const text = cleanName(rawText, LIMITS.checkText, '체크리스트 내용');
    this.mustCard(cardId);
    const id = randomUUID();
    return this.mutate('체크리스트 추가', [key('check', id)], () => {
      const pos = (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM check_items WHERE card_id = ?').get(cardId) as { p: number }).p;
      this.insertCheckRow({ id, cardId, text, done: false, position: pos });
    });
  }
  updateCheck(id: string, f: { text?: string; done?: boolean }): Outcome {
    const cur = this.must<CheckItem>('check', id, '체크리스트 항목');
    const text = f.text !== undefined ? cleanName(f.text, LIMITS.checkText, '체크리스트 내용') : cur.text;
    const done = f.done !== undefined ? !!f.done : cur.done;
    return this.mutate('체크리스트 수정', [key('check', id)], () => {
      this.db.prepare('UPDATE check_items SET text = ?, done = ? WHERE id = ?').run(text, done ? 1 : 0, id);
    });
  }
  deleteCheck(id: string): Outcome {
    this.must<CheckItem>('check', id, '체크리스트 항목');
    return this.mutate('체크리스트 삭제', [key('check', id)], () => {
      this.db.prepare('DELETE FROM check_items WHERE id = ?').run(id);
    });
  }

  // ───────── 댓글 ─────────

  addComment(cardId: string, rawBody: string): Outcome {
    const body = cleanName(rawBody, LIMITS.commentBody, '댓글');
    this.mustCard(cardId);
    const id = randomUUID();
    const ts = new Date(this.now()).toISOString();
    return this.mutate('댓글 작성', [key('comment', id)], () => {
      this.db.prepare('INSERT INTO comments (id, card_id, body, created_at, updated_at, rev) VALUES (?, ?, ?, ?, ?, 0)').run(id, cardId, body, ts, ts);
    });
  }
  updateComment(id: string, rawBody: string): Outcome {
    const body = cleanName(rawBody, LIMITS.commentBody, '댓글');
    this.must<Comment>('comment', id, '댓글');
    const ts = new Date(this.now()).toISOString();
    return this.mutate('댓글 수정', [key('comment', id)], () => {
      this.db.prepare('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?').run(body, ts, id);
    });
  }
  deleteComment(id: string): Outcome {
    this.must<Comment>('comment', id, '댓글');
    return this.mutate('댓글 삭제', [key('comment', id)], () => {
      this.db.prepare('DELETE FROM comments WHERE id = ?').run(id);
    });
  }

  // ───────── 첨부 ─────────

  addAttachment(cardId: string, meta: AttachmentMeta): Outcome {
    this.mustCard(cardId);
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE card_id = ? AND deleted_at IS NULL').get(cardId) as { n: number }).n;
    if (n >= LIMITS.attachmentsPerCard) throw new AppError('LIMIT', `첨부파일은 카드당 ${LIMITS.attachmentsPerCard}개까지 올릴 수 있어요.`);
    const id = randomUUID();
    return this.mutate('첨부 추가', [key('attachment', id)], () => {
      this.db
        .prepare('INSERT INTO attachments (id, card_id, name, size, mime, storage_key, deleted_at, rev) VALUES (?, ?, ?, ?, ?, ?, NULL, 0)')
        .run(id, cardId, meta.name, meta.size, meta.mime, meta.storageKey);
    });
  }
  attachmentCount(cardId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE card_id = ? AND deleted_at IS NULL').get(cardId) as { n: number }).n;
  }
  getAttachment(id: string): Attachment | undefined {
    return this.load(key('attachment', id)) as Attachment | undefined;
  }
  deleteAttachment(id: string): Outcome {
    this.must<Attachment>('attachment', id, '첨부파일');
    return this.mutate('첨부 삭제', [key('attachment', id)], () => {
      this.db.prepare('UPDATE attachments SET deleted_at = ? WHERE id = ?').run(this.now(), id);
    });
  }

  /** 삭제 표시 후 보관 기간이 지난 첨부 기록을 지우고, 디스크에서 지울 파일 키를 돌려준다 */
  purgeExpiredAttachments(): string[] {
    const cutoff = this.now() - LIMITS.retentionDays * 24 * 60 * 60 * 1000;
    const rows = this.db.prepare('SELECT storage_key FROM attachments WHERE deleted_at IS NOT NULL AND deleted_at <= ?').all(cutoff) as { storage_key: string }[];
    this.db.prepare('DELETE FROM attachments WHERE deleted_at IS NOT NULL AND deleted_at <= ?').run(cutoff);
    return rows.map((r) => r.storage_key);
  }
  referencedStorageKeys(): Set<string> {
    return new Set((this.db.prepare('SELECT storage_key FROM attachments').all() as { storage_key: string }[]).map((r) => r.storage_key));
  }

  // ───────── 알림 닫기 ─────────

  dismiss(cardId: string, kind: NotifyKind, dueDate: string): Outcome {
    if (!NOTIFY.includes(kind) || !isYmd(dueDate)) throw new AppError('INVALID', '알림 정보가 올바르지 않아요.');
    this.mustCard(cardId);
    const tx = this.db.transaction((): number | null => {
      const r = this.db.prepare('INSERT OR IGNORE INTO dismissals (card_id, kind, due_date) VALUES (?, ?, ?)').run(cardId, kind, dueDate);
      if (r.changes === 0) return null;
      const revision = this.bumpRevision();
      this.db.prepare('INSERT INTO changes (revision, kind, entity_id, action) VALUES (?, ?, ?, ?)').run(revision, 'dismissal', `${cardId}|${kind}|${dueDate}`, 'create');
      this.db.prepare('DELETE FROM changes WHERE revision <= ?').run(revision - this.logLimit);
      return revision;
    });
    const rev = tx();
    if (rev !== null) this.onCommit?.(rev);
    return { snapshot: this.snapshot(), entry: null };
  }

  // ───────── 되돌리기·다시 실행 ─────────

  applyPatch(patch: Patch, expect: Expect): ApplyResult {
    const run = this.db.transaction((): ApplyResult => {
      for (const e of expect) {
        const cur = this.load(e.key);
        if ((cur ? cur.rev : null) !== e.rev) return { conflict: true, reason: 'changed', snapshot: this.snapshot() };
      }
      if (this.fileExists) {
        for (const u of patch.upsert) {
          if (u.kind === 'attachment' && !this.fileExists((u.row as Attachment).storageKey)) {
            return { conflict: true, reason: 'file', snapshot: this.snapshot() };
          }
        }
      }
      const cands = [...patch.upsert.map((u) => key(u.kind, (u.row as { id: string }).id)), ...patch.remove.map((r) => key(r.kind, r.id))];
      const out = this.mutate('되돌리기/다시 실행', cands, () => {
        for (const r of patch.remove) this.removeRow(r.kind, r.id);
        for (const u of patch.upsert) this.writeRow(u.kind, u.row);
      });
      const touched: Record<string, number | null> = {};
      for (const k of new Set(cands)) {
        const r = this.load(k);
        touched[k] = r ? r.rev : null;
      }
      return { conflict: false, snapshot: out.snapshot, touched, entry: out.entry };
    });
    return run();
  }

  private removeRow(kind: Kind, id: string) {
    if (kind === 'attachment') {
      this.db.prepare('UPDATE attachments SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(this.now(), id);
    } else {
      this.db.prepare(`DELETE FROM ${TABLE[kind]} WHERE id = ?`).run(id);
    }
  }
  private writeRow(kind: Kind, row: Row) {
    if (kind === 'board') {
      const b = row as Board;
      this.db.prepare('INSERT OR REPLACE INTO boards (id, name, position, rev) VALUES (?, ?, ?, ?)').run(b.id, b.name, b.position, b.rev);
    } else if (kind === 'column') {
      const c = row as Column;
      this.db
        .prepare('INSERT OR REPLACE INTO board_columns (id, board_id, name, position, is_done, rev) VALUES (?, ?, ?, ?, ?, ?)')
        .run(c.id, c.boardId, c.name, c.position, c.isDone ? 1 : 0, c.rev);
    } else if (kind === 'card') {
      const c = row as Card;
      this.db
        .prepare(
          `INSERT OR REPLACE INTO cards (id, column_id, title, description, assignee, due_date, repeat, labels, archived, position, followup_id, rev)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(c.id, c.columnId, c.title, c.description, c.assignee, c.dueDate, c.repeat, JSON.stringify(c.labels), c.archived ? 1 : 0, c.position, c.followupId, c.rev);
    } else if (kind === 'check') {
      const c = row as CheckItem;
      this.db.prepare('INSERT OR REPLACE INTO check_items (id, card_id, text, done, position, rev) VALUES (?, ?, ?, ?, ?, ?)').run(c.id, c.cardId, c.text, c.done ? 1 : 0, c.position, c.rev);
    } else if (kind === 'comment') {
      const c = row as Comment;
      this.db.prepare('INSERT OR REPLACE INTO comments (id, card_id, body, created_at, updated_at, rev) VALUES (?, ?, ?, ?, ?, ?)').run(c.id, c.cardId, c.body, c.createdAt, c.updatedAt, c.rev);
    } else {
      const a = row as Attachment;
      this.db
        .prepare('INSERT OR REPLACE INTO attachments (id, card_id, name, size, mime, storage_key, deleted_at, rev) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
        .run(a.id, a.cardId, a.name, a.size, a.mime, a.storageKey, a.rev);
    }
  }

  // ───────── 다른 탭 동기화 ─────────

  changesSince(since: number): Changes {
    const revision = (this.db.prepare('SELECT revision FROM meta WHERE id = 1').get() as { revision: number }).revision;
    if (since >= revision) return { revision, upsert: [], remove: [] };
    const min = (this.db.prepare('SELECT MIN(revision) AS m FROM changes').get() as { m: number | null }).m;
    if (!Number.isFinite(since) || since < 0 || min === null || since < min - 1) {
      return { revision, full: this.snapshot(), upsert: [], remove: [] };
    }
    const rows = this.db.prepare('SELECT DISTINCT kind, entity_id FROM changes WHERE revision > ?').all(since) as { kind: string; entity_id: string }[];
    const out: Changes = { revision, upsert: [], remove: [] };
    for (const r of rows) {
      if (r.kind === 'dismissal') {
        const [cardId, kind, dueDate] = r.entity_id.split('|');
        const ex = this.db.prepare('SELECT 1 FROM dismissals WHERE card_id = ? AND kind = ? AND due_date = ?').get(cardId, kind, dueDate);
        if (ex) out.upsert.push({ kind: 'dismissal', row: { cardId, kind, dueDate } });
        else out.remove.push({ kind: 'dismissal', id: r.entity_id });
        continue;
      }
      const row = this.load(key(r.kind as Kind, r.entity_id));
      if (row) out.upsert.push({ kind: r.kind as Kind, row });
      else out.remove.push({ kind: r.kind as Kind, id: r.entity_id });
    }
    return out;
  }
}

// ───────── 보조 함수 ─────────

function sameIgnoringRev(a: Row | undefined, b: Row | undefined): boolean {
  if (!a || !b) return !a && !b;
  return JSON.stringify({ ...a, rev: 0 }) === JSON.stringify({ ...b, rev: 0 });
}
const toBoard = (r: any): Board => ({ id: r.id, name: r.name, position: r.position, rev: r.rev });
const toColumn = (r: any): Column => ({ id: r.id, boardId: r.board_id, name: r.name, position: r.position, isDone: !!r.is_done, rev: r.rev });
const toCard = (r: any): Card => ({
  id: r.id,
  columnId: r.column_id,
  title: r.title,
  description: r.description,
  assignee: r.assignee,
  dueDate: r.due_date,
  repeat: r.repeat,
  labels: JSON.parse(r.labels ?? '[]'),
  archived: !!r.archived,
  position: r.position,
  followupId: r.followup_id,
  rev: r.rev,
});
const toCheck = (r: any): CheckItem => ({ id: r.id, cardId: r.card_id, text: r.text, done: !!r.done, position: r.position, rev: r.rev });
const toComment = (r: any): Comment => ({ id: r.id, cardId: r.card_id, body: r.body, createdAt: r.created_at, updatedAt: r.updated_at, rev: r.rev });
const toAttachment = (r: any): Attachment => ({ id: r.id, cardId: r.card_id, name: r.name, size: r.size, mime: r.mime, storageKey: r.storage_key, rev: r.rev });
const MAP: Record<Kind, (r: any) => Row> = { board: toBoard, column: toColumn, card: toCard, check: toCheck, comment: toComment, attachment: toAttachment };
