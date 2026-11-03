import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  AppError,
  LIMITS,
  type ApplyResult,
  type Board,
  type Card,
  type Column,
  type Entry,
  type Expect,
  type Kind,
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
  addColumn(boardId: string, name: string): Outcome;
  renameColumn(id: string, name: string): Outcome;
  deleteColumn(id: string): Outcome;
  moveColumn(id: string, dir: -1 | 1): Outcome;
  setColumnDone(id: string, done: boolean): Outcome;
  addCard(columnId: string, title: string): Outcome;
  updateCard(id: string, fields: CardFields): Outcome;
  moveCard(id: string, toColumnId: string, index: number): Outcome;
  deleteCard(id: string): Outcome;
  applyPatch(patch: Patch, expect: Expect): ApplyResult;
}

export type CardFields = Partial<{
  title: string;
  description: string;
  assignee: string;
  dueDate: string | null;
  repeat: Repeat;
}>;

const TABLE: Record<Kind, string> = { board: 'boards', column: 'board_columns', card: 'cards' };
const key = (kind: Kind, id: string) => `${kind}:${id}`;
const parseKey = (k: string): { kind: Kind; id: string } => {
  const i = k.indexOf(':');
  return { kind: k.slice(0, i) as Kind, id: k.slice(i + 1) };
};

function cleanName(raw: unknown, max: number, label: string): string {
  if (typeof raw !== 'string') throw new AppError('INVALID', `${label}을(를) 입력해 주세요.`);
  const v = raw.trim();
  if (!v) throw new AppError('INVALID', `${label}을(를) 입력해 주세요.`);
  if ([...v].length > max) throw new AppError('INVALID', `${label}은(는) ${max}자까지 쓸 수 있어요.`);
  return v;
}

function cleanDate(raw: unknown): string | null {
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new AppError('INVALID', '날짜는 YYYY-MM-DD 형식이어야 해요.');
  }
  const [y, m, d] = raw.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new AppError('INVALID', '존재하지 않는 날짜예요.');
  }
  return raw;
}

const REPEATS: Repeat[] = ['none', 'daily', 'weekly', 'monthly'];

export class SqliteBoardRepository implements BoardRepository {
  private db: Database.Database;

  constructor(file: string) {
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
      CREATE INDEX IF NOT EXISTS idx_columns_board ON board_columns(board_id);
      CREATE INDEX IF NOT EXISTS idx_cards_column ON cards(column_id);
      CREATE TABLE IF NOT EXISTS changes (
        revision INTEGER NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_changes_rev ON changes(revision);
    `);
  }

  // ───────── 읽기 ─────────

  snapshot(): Snapshot {
    const revision = (this.db.prepare('SELECT revision FROM meta WHERE id = 1').get() as { revision: number }).revision;
    const boards = (this.db.prepare('SELECT * FROM boards ORDER BY position, id').all() as any[]).map(toBoard);
    const columns = (this.db.prepare('SELECT * FROM board_columns ORDER BY position, id').all() as any[]).map(toColumn);
    const cards = (this.db.prepare('SELECT * FROM cards ORDER BY position, id').all() as any[]).map(toCard);
    return { revision, boards, columns, cards };
  }

  private load(k: string): Row | undefined {
    const { kind, id } = parseKey(k);
    const r = this.db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE id = ?`).get(id) as any;
    if (!r) return undefined;
    return kind === 'board' ? toBoard(r) : kind === 'column' ? toColumn(r) : toCard(r);
  }

  private columnsOf(boardId: string): Column[] {
    return (this.db.prepare('SELECT * FROM board_columns WHERE board_id = ? ORDER BY position, id').all(boardId) as any[]).map(toColumn);
  }
  private cardsOf(columnId: string): Card[] {
    return (this.db.prepare('SELECT * FROM cards WHERE column_id = ? ORDER BY position, id').all(columnId) as any[]).map(toCard);
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
    const run = this.db.transaction((): Entry | null => {
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
      const forward = emptyPatch();
      const inverse = emptyPatch();
      const expect: Expect = [];
      const log = this.db.prepare('INSERT INTO changes (revision, kind, entity_id, action) VALUES (?, ?, ?, ?)');
      for (const { k, a, b } of changed) {
        const { kind, id } = parseKey(k);
        if (a) {
          this.db.prepare(`UPDATE ${TABLE[kind]} SET rev = ? WHERE id = ?`).run(revision, id);
          a.rev = revision;
          addUpsert(forward, kind, a);
        } else {
          addRemove(forward, kind, id);
        }
        if (b) addUpsert(inverse, kind, b);
        else addRemove(inverse, kind, id);
        expect.push({ key: k, rev: a ? revision : null });
        log.run(revision, kind, id, a ? (b ? 'update' : 'create') : 'delete');
      }
      this.db.prepare('DELETE FROM changes WHERE revision <= ?').run(revision - LIMITS.changeLog);
      return { label, forward, inverse, expect };
    });
    const entry = run();
    return { snapshot: this.snapshot(), entry };
  }

  private bumpRevision(): number {
    this.db.prepare('UPDATE meta SET revision = revision + 1 WHERE id = 1').run();
    return (this.db.prepare('SELECT revision FROM meta WHERE id = 1').get() as { revision: number }).revision;
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
    const cands = [key('board', id), ...cols.map((c) => key('column', c.id)), ...cards.map((c) => key('card', c.id))];
    return this.mutate('보드 삭제', cands, () => {
      for (const c of cols) this.db.prepare('DELETE FROM cards WHERE column_id = ?').run(c.id);
      this.db.prepare('DELETE FROM board_columns WHERE board_id = ?').run(id);
      this.db.prepare('DELETE FROM boards WHERE id = ?').run(id);
    });
  }

  // ───────── 열 ─────────

  addColumn(boardId: string, rawName: string): Outcome {
    const name = cleanName(rawName, LIMITS.columnName, '열 이름');
    this.mustBoard(boardId);
    const id = randomUUID();
    return this.mutate('열 추가', [key('column', id)], () => {
      const pos = (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM board_columns WHERE board_id = ?').get(boardId) as { p: number }).p;
      this.db
        .prepare('INSERT INTO board_columns (id, board_id, name, position, is_done, rev) VALUES (?, ?, ?, ?, 0, 0)')
        .run(id, boardId, name, pos);
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
    if (this.columnsOf(col.boardId).length <= 1) {
      throw new AppError('LAST_COLUMN', '마지막 남은 열은 삭제할 수 없어요.');
    }
    const cards = this.cardsOf(id);
    return this.mutate('열 삭제', [key('column', id), ...cards.map((c) => key('card', c.id))], () => {
      this.db.prepare('DELETE FROM cards WHERE column_id = ?').run(id);
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
      this.db
        .prepare(
          `INSERT INTO cards (id, column_id, title, description, assignee, due_date, repeat, archived, position, followup_id, rev)
           VALUES (?, ?, ?, '', '', NULL, 'none', 0, ?, NULL, 0)`,
        )
        .run(id, columnId, title, pos);
    });
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
    if (f.dueDate !== undefined) {
      next.dueDate = cleanDate(f.dueDate);
      if (next.dueDate === null) next.repeat = 'none'; // 마감일을 지우면 반복도 해제
    }
    if (f.repeat !== undefined) {
      if (!REPEATS.includes(f.repeat)) throw new AppError('INVALID', '반복 주기가 올바르지 않아요.');
      if (f.repeat !== 'none' && next.dueDate === null) {
        throw new AppError('INVALID', '반복을 설정하려면 마감일이 있어야 해요.');
      }
      next.repeat = f.repeat;
    }
    return this.mutate('카드 수정', [key('card', id)], () => {
      this.db
        .prepare('UPDATE cards SET title = ?, description = ?, assignee = ?, due_date = ?, repeat = ? WHERE id = ?')
        .run(next.title, next.description, next.assignee, next.dueDate, next.repeat, id);
    });
  }

  moveCard(id: string, toColumnId: string, index: number): Outcome {
    const card = this.mustCard(id);
    const from = this.mustColumn(card.columnId);
    const to = this.mustColumn(toColumnId);
    if (from.boardId !== to.boardId) {
      throw new AppError('INVALID', '다른 보드로는 카드를 옮길 수 없어요.');
    }
    const src = this.cardsOf(from.id);
    const dst = from.id === to.id ? src : this.cardsOf(to.id);
    const cands = [...new Set([...src, ...dst].map((c) => key('card', c.id)))];
    return this.mutate('카드 이동', cands, () => {
      const dstIds = dst.map((c) => c.id).filter((x) => x !== id);
      const at = Math.max(0, Math.min(Number.isFinite(index) ? Math.trunc(index) : dstIds.length, dstIds.length));
      dstIds.splice(at, 0, id);
      dstIds.forEach((cid, p) => this.db.prepare('UPDATE cards SET column_id = ?, position = ? WHERE id = ?').run(to.id, p, cid));
      if (from.id !== to.id) {
        src
          .map((c) => c.id)
          .filter((x) => x !== id)
          .forEach((cid, p) => this.db.prepare('UPDATE cards SET position = ? WHERE id = ?').run(p, cid));
      }
    });
  }

  deleteCard(id: string): Outcome {
    this.mustCard(id);
    return this.mutate('카드 삭제', [key('card', id)], () => {
      this.db.prepare('DELETE FROM cards WHERE id = ?').run(id);
    });
  }

  // ───────── 되돌리기·다시 실행 ─────────

  applyPatch(patch: Patch, expect: Expect): ApplyResult {
    const run = this.db.transaction((): ApplyResult => {
      for (const e of expect) {
        const cur = this.load(e.key);
        if ((cur ? cur.rev : null) !== e.rev) return { conflict: true, snapshot: this.snapshot() };
      }
      const cands = [
        ...patch.upsert.boards.map((r) => key('board', r.id)),
        ...patch.upsert.columns.map((r) => key('column', r.id)),
        ...patch.upsert.cards.map((r) => key('card', r.id)),
        ...patch.remove.boards.map((id) => key('board', id)),
        ...patch.remove.columns.map((id) => key('column', id)),
        ...patch.remove.cards.map((id) => key('card', id)),
      ];
      const out = this.mutate('되돌리기/다시 실행', cands, () => {
        for (const id of patch.remove.cards) this.db.prepare('DELETE FROM cards WHERE id = ?').run(id);
        for (const id of patch.remove.columns) this.db.prepare('DELETE FROM board_columns WHERE id = ?').run(id);
        for (const id of patch.remove.boards) this.db.prepare('DELETE FROM boards WHERE id = ?').run(id);
        for (const b of patch.upsert.boards) {
          this.db.prepare('INSERT OR REPLACE INTO boards (id, name, position, rev) VALUES (?, ?, ?, ?)').run(b.id, b.name, b.position, b.rev);
        }
        for (const c of patch.upsert.columns) {
          this.db
            .prepare('INSERT OR REPLACE INTO board_columns (id, board_id, name, position, is_done, rev) VALUES (?, ?, ?, ?, ?, ?)')
            .run(c.id, c.boardId, c.name, c.position, c.isDone ? 1 : 0, c.rev);
        }
        for (const c of patch.upsert.cards) {
          this.db
            .prepare(
              `INSERT OR REPLACE INTO cards (id, column_id, title, description, assignee, due_date, repeat, archived, position, followup_id, rev)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(c.id, c.columnId, c.title, c.description, c.assignee, c.dueDate, c.repeat, c.archived ? 1 : 0, c.position, c.followupId, c.rev);
        }
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
}

// ───────── 보조 함수 ─────────

function emptyPatch(): Patch {
  return {
    upsert: { boards: [], columns: [], cards: [] },
    remove: { boards: [], columns: [], cards: [] },
  };
}
function addUpsert(p: Patch, kind: Kind, row: Row) {
  if (kind === 'board') p.upsert.boards.push(row as Board);
  else if (kind === 'column') p.upsert.columns.push(row as Column);
  else p.upsert.cards.push(row as Card);
}
function addRemove(p: Patch, kind: Kind, id: string) {
  if (kind === 'board') p.remove.boards.push(id);
  else if (kind === 'column') p.remove.columns.push(id);
  else p.remove.cards.push(id);
}
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
  archived: !!r.archived,
  position: r.position,
  followupId: r.followup_id,
  rev: r.rev,
});
