import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Pool, types, type PoolClient } from 'pg';
import { isYmd, nextDueDate } from './dates';
import { assertValidPatch } from './patchcheck';
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

// PostgreSQL의 bigint(COUNT, 삭제 시각 등)를 문자열이 아니라 숫자로 받는다 (우리 값은 모두 2^53 아래)
types.setTypeParser(20, (v: string) => parseInt(v, 10));

/** 데이터 읽기·저장 창구. 다른 저장소(예: Supabase)로 갈아 끼울 수 있게 인터페이스로 둔다. */
export interface BoardRepository {
  snapshot(): Promise<Snapshot>;
  ensureFirstBoard(): Promise<void>;
  createBoard(name: string): Promise<Outcome>;
  renameBoard(id: string, name: string): Promise<Outcome>;
  deleteBoard(id: string): Promise<Outcome>;
  duplicateBoard(id: string): Promise<Outcome>;
  addColumn(boardId: string, name: string): Promise<Outcome>;
  renameColumn(id: string, name: string): Promise<Outcome>;
  deleteColumn(id: string): Promise<Outcome>;
  moveColumn(id: string, dir: -1 | 1): Promise<Outcome>;
  setColumnDone(id: string, done: boolean): Promise<Outcome>;
  addCard(columnId: string, title: string): Promise<Outcome>;
  updateCard(id: string, fields: CardFields): Promise<Outcome>;
  moveCard(id: string, toColumnId: string, index: number, today?: string): Promise<Outcome>;
  deleteCard(id: string): Promise<Outcome>;
  duplicateCard(id: string): Promise<Outcome>;
  setArchived(ids: string[], archived: boolean): Promise<Outcome>;
  bulkMove(ids: string[], toColumnId: string, today?: string): Promise<Outcome>;
  bulkDelete(ids: string[]): Promise<Outcome>;
  addCheck(cardId: string, text: string): Promise<Outcome>;
  updateCheck(id: string, f: { text?: string; done?: boolean }): Promise<Outcome>;
  deleteCheck(id: string): Promise<Outcome>;
  addComment(cardId: string, body: string): Promise<Outcome>;
  updateComment(id: string, body: string): Promise<Outcome>;
  deleteComment(id: string): Promise<Outcome>;
  addAttachment(cardId: string, meta: AttachmentMeta): Promise<Outcome>;
  deleteAttachment(id: string): Promise<Outcome>;
  dismiss(cardId: string, kind: NotifyKind, dueDate: string): Promise<Outcome>;
  applyPatch(patch: Patch, expect: Expect): Promise<ApplyResult>;
  changesSince(revision: number): Promise<Changes>;
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
  /** 변경이 저장(커밋)된 뒤마다 호출 (실시간 알림용) */
  onCommit?: (revision: number) => void;
  changeLogLimit?: number;
};

export type PgOptions = RepoOptions & {
  connectionString: string;
  /** 표를 만들 스키마 이름. 기본은 public. 시험이나 한 DB를 나눠 쓸 때 사용 */
  schema?: string;
  poolSize?: number;
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

const pgCache = new Map<string, string>();
/** SQL 안의 ? 를 PostgreSQL의 $1, $2 … 로 바꾼다 */
function toPg(sql: string): string {
  let out = pgCache.get(sql);
  if (!out) {
    let i = 0;
    out = sql.replace(/\?/g, () => `$${++i}`);
    pgCache.set(sql, out);
  }
  return out;
}

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
const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

const MAX_BULK = 5000;
function capIds(ids: string[]) {
  if (ids.length > MAX_BULK) throw new AppError('INVALID', `한 번에 ${MAX_BULK}개까지만 처리할 수 있어요.`);
}

type Plan = { cardId: string; newId: string; checkIds: string[]; colId: string; due: string; repeat: Repeat };
type Ctx = { client: PoolClient; after: (() => void)[] };

const DDL = `
  CREATE TABLE IF NOT EXISTS app_settings (key text PRIMARY KEY, value text NOT NULL);
  CREATE TABLE IF NOT EXISTS meta (id integer PRIMARY KEY CHECK (id = 1), revision integer NOT NULL);
  INSERT INTO meta (id, revision) VALUES (1, 0) ON CONFLICT DO NOTHING;
  CREATE TABLE IF NOT EXISTS boards (
    id text PRIMARY KEY, name text NOT NULL, position integer NOT NULL, rev integer NOT NULL
  );
  CREATE TABLE IF NOT EXISTS board_columns (
    id text PRIMARY KEY, board_id text NOT NULL, name text NOT NULL, position integer NOT NULL,
    is_done boolean NOT NULL DEFAULT false, rev integer NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cards (
    id text PRIMARY KEY, column_id text NOT NULL, title text NOT NULL,
    description text NOT NULL DEFAULT '', assignee text NOT NULL DEFAULT '',
    due_date text, repeat text NOT NULL DEFAULT 'none', labels jsonb NOT NULL DEFAULT '[]',
    archived boolean NOT NULL DEFAULT false, position integer NOT NULL, followup_id text, rev integer NOT NULL
  );
  CREATE TABLE IF NOT EXISTS check_items (
    id text PRIMARY KEY, card_id text NOT NULL, text text NOT NULL, done boolean NOT NULL DEFAULT false,
    position integer NOT NULL, rev integer NOT NULL
  );
  CREATE TABLE IF NOT EXISTS comments (
    id text PRIMARY KEY, card_id text NOT NULL, body text NOT NULL,
    created_at text NOT NULL, updated_at text NOT NULL, rev integer NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attachments (
    id text PRIMARY KEY, seq bigserial, card_id text NOT NULL, name text NOT NULL, size integer NOT NULL,
    mime text NOT NULL, storage_key text NOT NULL, deleted_at bigint, rev integer NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dismissals (
    seq bigserial, card_id text NOT NULL, kind text NOT NULL, due_date text NOT NULL,
    PRIMARY KEY (card_id, kind, due_date)
  );
  CREATE TABLE IF NOT EXISTS changes (
    revision integer NOT NULL, kind text NOT NULL, entity_id text NOT NULL, action text NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_columns_board ON board_columns(board_id);
  CREATE INDEX IF NOT EXISTS idx_cards_column ON cards(column_id);
  CREATE INDEX IF NOT EXISTS idx_checks_card ON check_items(card_id);
  CREATE INDEX IF NOT EXISTS idx_comments_card ON comments(card_id);
  CREATE INDEX IF NOT EXISTS idx_att_card ON attachments(card_id);
  CREATE INDEX IF NOT EXISTS idx_changes_rev ON changes(revision);
`;

export class PgBoardRepository implements BoardRepository {
  /** 지금 실행 중인 트랜잭션(있으면 모든 질의가 그 연결로 간다) */
  private als = new AsyncLocalStorage<Ctx>();
  private now: () => number;
  private fileExists?: (k: string) => boolean;
  private onCommit?: (rev: number) => void;
  private logLimit: number;

  private constructor(
    private pool: Pool,
    opts: RepoOptions,
    readonly schema: string,
  ) {
    this.now = opts.now ?? Date.now;
    this.fileExists = opts.fileExists;
    this.onCommit = opts.onCommit;
    this.logLimit = opts.changeLogLimit ?? LIMITS.changeLog;
  }

  /** DB에 연결하고 표를 만든다 (이미 있으면 그대로 둔다) */
  static async create(opts: PgOptions): Promise<PgBoardRepository> {
    const schema = opts.schema ?? 'public';
    if (!SCHEMA_RE.test(schema)) throw new AppError('CONFIG', `스키마 이름이 올바르지 않아요: ${schema}`, 500);
    if (schema !== 'public') {
      const admin = new Pool({ connectionString: opts.connectionString, max: 1 });
      try {
        await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      } finally {
        await admin.end();
      }
    }
    const pool = new Pool({ connectionString: opts.connectionString, max: opts.poolSize ?? 8, options: `-c search_path=${schema}` });
    pool.on('error', (e) => console.error('DB 연결 오류(놀고 있던 연결)', e.message));
    const repo = new PgBoardRepository(pool, opts, schema);
    try {
      await repo.init();
    } catch (e) {
      await pool.end().catch(() => {});
      throw e;
    }
    return repo;
  }

  /** 시험용: 스키마를 통째로 지운다 */
  static async dropSchema(connectionString: string, schema: string) {
    if (!SCHEMA_RE.test(schema) || schema === 'public') throw new Error('지울 수 없는 스키마');
    const admin = new Pool({ connectionString, max: 1 });
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  }

  private async init() {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(7241901)'); // 서버가 동시에 시작해도 표 만들기가 겹치지 않게
      await c.query(DDL);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  async close() {
    await this.pool.end();
  }

  // ───────── 질의 도우미 ─────────

  private q(text: string, params: unknown[] = []) {
    const exec = this.als.getStore()?.client ?? this.pool;
    return exec.query(toPg(text), params as any[]);
  }
  private async rows<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
    return (await this.q(text, params)).rows as T[];
  }
  private async one<T = any>(text: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.rows<T>(text, params))[0];
  }

  /**
   * 쓰기 작업 한 건 = 트랜잭션 하나.
   * 시작하자마자 meta 행을 잠가서 변경이 한 번에 하나씩 순서대로 처리되게 한다.
   * (그래서 "후속 카드를 이미 만들었는지 확인 → 기록"이 같은 트랜잭션 안에서 안전하게 이루어진다)
   */
  private async write<T>(body: () => Promise<T>): Promise<T> {
    if (this.als.getStore()) return body();
    const client = await this.pool.connect();
    const ctx: Ctx = { client, after: [] };
    let broken = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT revision FROM meta WHERE id = 1 FOR UPDATE');
      const result = await this.als.run(ctx, body);
      await client.query('COMMIT');
      for (const f of ctx.after) {
        try {
          f();
        } catch {
          /* 알림 실패가 저장을 되돌리지 않는다 */
        }
      }
      return result;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      throw e;
    } finally {
      client.release(broken);
    }
  }

  /** 읽기 여러 번을 같은 시점의 데이터로 맞춘다 */
  private async read<T>(body: () => Promise<T>): Promise<T> {
    if (this.als.getStore()) return body();
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await this.als.run({ client, after: [] }, body);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      throw e;
    } finally {
      client.release(broken);
    }
  }

  // ───────── 읽기 ─────────

  async snapshot(): Promise<Snapshot> {
    return this.read(async () => {
      const q = (sql: string) => this.rows(sql);
      const revision = (await this.one<{ revision: number }>('SELECT revision FROM meta WHERE id = 1'))!.revision;
      return {
        revision,
        boards: (await q('SELECT * FROM boards ORDER BY position, id')).map(toBoard),
        columns: (await q('SELECT * FROM board_columns ORDER BY position, id')).map(toColumn),
        cards: (await q('SELECT * FROM cards ORDER BY position, id')).map(toCard),
        checks: (await q('SELECT * FROM check_items ORDER BY position, id')).map(toCheck),
        comments: (await q('SELECT * FROM comments ORDER BY created_at, id')).map(toComment),
        attachments: (await q('SELECT * FROM attachments WHERE deleted_at IS NULL ORDER BY seq')).map(toAttachment),
        dismissals: (await q('SELECT * FROM dismissals ORDER BY seq')).map((r) => ({ cardId: r.card_id, kind: r.kind, dueDate: r.due_date })),
      };
    });
  }

  /** 여러 항목을 종류별로 묶어 한꺼번에 읽는다 (항목마다 따로 읽으면 PostgreSQL 왕복이 너무 많아진다) */
  private async loadMany(keys: string[]): Promise<Map<string, Row>> {
    const byKind = new Map<Kind, string[]>();
    for (const k of keys) {
      const { kind, id } = parseKey(k);
      const list = byKind.get(kind) ?? [];
      list.push(id);
      byKind.set(kind, list);
    }
    const out = new Map<string, Row>();
    for (const [kind, ids] of byKind) {
      const extra = kind === 'attachment' ? ' AND deleted_at IS NULL' : '';
      for (const r of await this.rows(`SELECT * FROM ${TABLE[kind]} WHERE id = ANY(?::text[])${extra}`, [ids])) {
        out.set(key(kind, r.id), MAP[kind](r));
      }
    }
    return out;
  }
  private async load(k: string): Promise<Row | undefined> {
    return (await this.loadMany([k])).get(k);
  }

  private async columnsOf(boardId: string): Promise<Column[]> {
    return (await this.rows('SELECT * FROM board_columns WHERE board_id = ? ORDER BY position, id', [boardId])).map(toColumn);
  }
  /** 보관 카드까지 포함한 열의 모든 카드 */
  private async cardsOf(columnId: string): Promise<Card[]> {
    return (await this.rows('SELECT * FROM cards WHERE column_id = ? ORDER BY position, id', [columnId])).map(toCard);
  }
  private async visibleIds(columnId: string): Promise<string[]> {
    return (await this.rows<{ id: string }>('SELECT id FROM cards WHERE column_id = ? AND archived = false ORDER BY position, id', [columnId])).map((r) => r.id);
  }
  private async checksOf(cardId: string): Promise<CheckItem[]> {
    return (await this.rows('SELECT * FROM check_items WHERE card_id = ? ORDER BY position, id', [cardId])).map(toCheck);
  }
  private async mustBoard(id: string): Promise<Board> {
    const b = (await this.load(key('board', id))) as Board | undefined;
    if (!b) throw new AppError('NOT_FOUND', '보드를 찾을 수 없어요. 다른 탭에서 지웠을 수 있어요.', 404);
    return b;
  }
  private async mustColumn(id: string): Promise<Column> {
    const c = (await this.load(key('column', id))) as Column | undefined;
    if (!c) throw new AppError('NOT_FOUND', '열을 찾을 수 없어요. 다른 탭에서 지웠을 수 있어요.', 404);
    return c;
  }
  private async mustCard(id: string): Promise<Card> {
    const c = (await this.load(key('card', id))) as Card | undefined;
    if (!c) throw new AppError('NOT_FOUND', '카드를 찾을 수 없어요. 다른 탭에서 지웠을 수 있어요.', 404);
    return c;
  }
  private async must<T extends Row>(kind: Kind, id: string, label: string): Promise<T> {
    const r = (await this.load(key(kind, id))) as T | undefined;
    if (!r) throw new AppError('NOT_FOUND', `${label}을(를) 찾을 수 없어요. 다른 탭에서 지웠을 수 있어요.`, 404);
    return r;
  }
  private async boardOfColumn(columnId: string): Promise<string> {
    return (await this.mustColumn(columnId)).boardId;
  }

  // ───────── 설정 ─────────

  private async getSetting(k: string): Promise<string | undefined> {
    return (await this.one<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [k]))?.value;
  }
  private async setSetting(k: string, v: string) {
    await this.q('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, v]);
  }
  async ensureFirstBoard(): Promise<void> {
    await this.write(async () => {
      if ((await this.getSetting('first_board_created')) === '1') return;
      await this.createBoard('내 첫 보드');
      await this.setSetting('first_board_created', '1');
    });
  }

  // ───────── 핵심: 변경을 한 묶음으로 처리 ─────────

  /**
   * 바뀔 수 있는 항목(cands)의 앞/뒤 상태를 비교해 바뀐 것만 저장하고,
   * 전역 revision과 항목별 변경 번호를 올린 뒤, 되돌리기용 patch를 만든다.
   * 반드시 write() 안에서 불러야 한다.
   */
  private async mutate(label: string, cands: string[], fn: () => Promise<void>): Promise<Outcome> {
    const ctx = this.als.getStore();
    if (!ctx) throw new Error('mutate는 write() 안에서만 부를 수 있어요');
    const uniq = [...new Set(cands)];
    const before = await this.loadMany(uniq);
    await fn();
    const after = await this.loadMany(uniq);
    const changed: { k: string; a: Row | undefined; b: Row | undefined }[] = [];
    for (const k of uniq) {
      const a = after.get(k);
      const b = before.get(k);
      if (!sameIgnoringRev(a, b)) changed.push({ k, a, b });
    }
    if (changed.length === 0) return { snapshot: await this.snapshot(), entry: null };

    const revision = await this.bumpRevision();
    const forward: Patch = { upsert: [], remove: [] };
    const inverse: Patch = { upsert: [], remove: [] };
    const expect: Expect = [];
    const revByKind = new Map<Kind, string[]>();
    for (const { k, a, b } of changed) {
      const { kind, id } = parseKey(k);
      if (a) {
        a.rev = revision;
        forward.upsert.push({ kind, row: a });
        revByKind.set(kind, [...(revByKind.get(kind) ?? []), id]);
      } else {
        forward.remove.push({ kind, id });
      }
      if (b) inverse.upsert.push({ kind, row: b });
      else inverse.remove.push({ kind, id });
      expect.push({ key: k, rev: a ? revision : null });
    }
    for (const [kind, ids] of revByKind) {
      await this.q(`UPDATE ${TABLE[kind]} SET rev = ? WHERE id = ANY(?::text[])`, [revision, ids]);
    }
    await this.q(
      `INSERT INTO changes (revision, kind, entity_id, action)
       SELECT ?::int, t.kind, t.id, t.action FROM unnest(?::text[], ?::text[], ?::text[]) AS t(kind, id, action)`,
      [
        revision,
        changed.map((c) => parseKey(c.k).kind),
        changed.map((c) => parseKey(c.k).id),
        changed.map((c) => (c.a ? (c.b ? 'update' : 'create') : 'delete')),
      ],
    );
    await this.q('DELETE FROM changes WHERE revision <= ?', [revision - this.logLimit]);
    ctx.after.push(() => this.onCommit?.(revision));
    return { snapshot: await this.snapshot(), entry: { label, forward, inverse, expect } };
  }

  private async bumpRevision(): Promise<number> {
    return (await this.one<{ revision: number }>('UPDATE meta SET revision = revision + 1 WHERE id = 1 RETURNING revision'))!.revision;
  }

  // ───────── 카드 아래 딸린 것들 ─────────

  private async childKeys(cardIds: string[]): Promise<string[]> {
    if (!cardIds.length) return [];
    const get = async (table: string, kind: Kind, extra = '') =>
      (await this.rows<{ id: string }>(`SELECT id FROM ${table} WHERE card_id = ANY(?::text[])${extra}`, [cardIds])).map((r) => key(kind, r.id));
    return [...(await get('check_items', 'check')), ...(await get('comments', 'comment')), ...(await get('attachments', 'attachment', ' AND deleted_at IS NULL'))];
  }

  /** 카드와 딸린 항목을 지운다. 첨부는 파일을 바로 지우지 않고 삭제 표시만 한다. */
  private async removeCardsSql(cardIds: string[]) {
    if (!cardIds.length) return;
    await this.q('DELETE FROM check_items WHERE card_id = ANY(?::text[])', [cardIds]);
    await this.q('DELETE FROM comments WHERE card_id = ANY(?::text[])', [cardIds]);
    await this.q('UPDATE attachments SET deleted_at = ? WHERE card_id = ANY(?::text[]) AND deleted_at IS NULL', [this.now(), cardIds]);
    await this.q('DELETE FROM cards WHERE id = ANY(?::text[])', [cardIds]);
  }

  /** 주어진 순서대로 위치 번호를 0부터 매긴다 */
  private async setPositions(table: 'cards' | 'board_columns' | 'boards', ids: string[]) {
    if (!ids.length) return;
    await this.q(`UPDATE ${table} SET position = t.ord - 1 FROM unnest(?::text[]) WITH ORDINALITY AS t(id, ord) WHERE ${table}.id = t.id`, [ids]);
  }

  /** 열 안의 위치를 정리한다: 보이는 카드(주어진 순서) 뒤에 보관 카드를 둔다 */
  private async layoutColumn(colId: string, visibleOrder: string[]) {
    const archived = (await this.rows<{ id: string }>('SELECT id FROM cards WHERE column_id = ? AND archived = true ORDER BY position, id', [colId]))
      .map((r) => r.id)
      .filter((id) => !visibleOrder.includes(id));
    await this.setPositions('cards', [...visibleOrder, ...archived]);
  }

  private async insertCardRow(c: Card) {
    await this.q(
      `INSERT INTO cards (id, column_id, title, description, assignee, due_date, repeat, labels, archived, position, followup_id, rev)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [c.id, c.columnId, c.title, c.description, c.assignee, c.dueDate, c.repeat, JSON.stringify(c.labels), c.archived, c.position, c.followupId],
    );
  }
  private async insertCheckRow(c: { id: string; cardId: string; text: string; done: boolean; position: number }) {
    await this.q('INSERT INTO check_items (id, card_id, text, done, position, rev) VALUES (?, ?, ?, ?, ?, 0)', [c.id, c.cardId, c.text, c.done, c.position]);
  }
  private async nextPosition(table: string, where: string, arg?: string): Promise<number> {
    const sql = `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM ${table}${where ? ` WHERE ${where}` : ''}`;
    return (await this.one<{ p: number }>(sql, arg === undefined ? [] : [arg]))!.p;
  }

  // ───────── 보드 ─────────

  createBoard(rawName: string): Promise<Outcome> {
    return this.write(async () => {
      const name = cleanName(rawName, LIMITS.boardName, '보드 이름');
      const boardId = randomUUID();
      const colIds = [randomUUID(), randomUUID(), randomUUID()];
      return this.mutate('보드 만들기', [key('board', boardId), ...colIds.map((c) => key('column', c))], async () => {
        const pos = await this.nextPosition('boards', '');
        await this.q('INSERT INTO boards (id, name, position, rev) VALUES (?, ?, ?, 0)', [boardId, name, pos]);
        const names = ['할 일', '진행 중', '완료'];
        for (let i = 0; i < 3; i++) {
          await this.q('INSERT INTO board_columns (id, board_id, name, position, is_done, rev) VALUES (?, ?, ?, ?, ?, 0)', [colIds[i], boardId, names[i], i, i === 2]);
        }
      });
    });
  }

  renameBoard(id: string, rawName: string): Promise<Outcome> {
    return this.write(async () => {
      const name = cleanName(rawName, LIMITS.boardName, '보드 이름');
      await this.mustBoard(id);
      return this.mutate('보드 이름 변경', [key('board', id)], async () => {
        await this.q('UPDATE boards SET name = ? WHERE id = ?', [name, id]);
      });
    });
  }

  deleteBoard(id: string): Promise<Outcome> {
    return this.write(async () => {
      await this.mustBoard(id);
      const cols = await this.columnsOf(id);
      const cardIds = (await this.rows<{ id: string }>('SELECT id FROM cards WHERE column_id = ANY(?::text[])', [cols.map((c) => c.id)])).map((r) => r.id);
      const cands = [key('board', id), ...cols.map((c) => key('column', c.id)), ...cardIds.map((c) => key('card', c)), ...(await this.childKeys(cardIds))];
      return this.mutate('보드 삭제', cands, async () => {
        await this.removeCardsSql(cardIds);
        await this.q('DELETE FROM board_columns WHERE board_id = ?', [id]);
        await this.q('DELETE FROM boards WHERE id = ?', [id]);
      });
    });
  }

  duplicateBoard(id: string): Promise<Outcome> {
    return this.write(async () => {
      const src = await this.mustBoard(id);
      const name = copyName(src.name, LIMITS.boardName);
      const newBoard = randomUUID();
      const cols = await this.columnsOf(id);
      const colMap = new Map(cols.map((c) => [c.id, randomUUID()]));
      const cardPlans: { card: Card; newId: string; checks: { src: CheckItem; id: string }[] }[] = [];
      for (const c of cols) {
        for (const card of (await this.cardsOf(c.id)).filter((x) => !x.archived)) {
          cardPlans.push({ card, newId: randomUUID(), checks: (await this.checksOf(card.id)).map((s) => ({ src: s, id: randomUUID() })) });
        }
      }
      const cands = [
        key('board', newBoard),
        ...[...colMap.values()].map((c) => key('column', c)),
        ...cardPlans.flatMap((p) => [key('card', p.newId), ...p.checks.map((c) => key('check', c.id))]),
      ];
      return this.mutate('보드 복제', cands, async () => {
        const pos = await this.nextPosition('boards', '');
        await this.q('INSERT INTO boards (id, name, position, rev) VALUES (?, ?, ?, 0)', [newBoard, name, pos]);
        for (let i = 0; i < cols.length; i++) {
          await this.q('INSERT INTO board_columns (id, board_id, name, position, is_done, rev) VALUES (?, ?, ?, ?, ?, 0)', [colMap.get(cols[i].id), newBoard, cols[i].name, i, cols[i].isDone]);
        }
        const counters = new Map<string, number>();
        for (const p of cardPlans) {
          const col = colMap.get(p.card.columnId)!;
          const position = counters.get(col) ?? 0;
          counters.set(col, position + 1);
          await this.insertCardRow({ ...p.card, id: p.newId, columnId: col, position, followupId: null, archived: false });
          for (let i = 0; i < p.checks.length; i++) {
            await this.insertCheckRow({ id: p.checks[i].id, cardId: p.newId, text: p.checks[i].src.text, done: p.checks[i].src.done, position: i });
          }
        }
      });
    });
  }

  // ───────── 열 ─────────

  addColumn(boardId: string, rawName: string): Promise<Outcome> {
    return this.write(async () => {
      const name = cleanName(rawName, LIMITS.columnName, '열 이름');
      await this.mustBoard(boardId);
      const id = randomUUID();
      return this.mutate('열 추가', [key('column', id)], async () => {
        const pos = await this.nextPosition('board_columns', 'board_id = ?', boardId);
        await this.q('INSERT INTO board_columns (id, board_id, name, position, is_done, rev) VALUES (?, ?, ?, ?, false, 0)', [id, boardId, name, pos]);
      });
    });
  }

  renameColumn(id: string, rawName: string): Promise<Outcome> {
    return this.write(async () => {
      const name = cleanName(rawName, LIMITS.columnName, '열 이름');
      await this.mustColumn(id);
      return this.mutate('열 이름 변경', [key('column', id)], async () => {
        await this.q('UPDATE board_columns SET name = ? WHERE id = ?', [name, id]);
      });
    });
  }

  deleteColumn(id: string): Promise<Outcome> {
    return this.write(async () => {
      const col = await this.mustColumn(id);
      if ((await this.columnsOf(col.boardId)).length <= 1) throw new AppError('LAST_COLUMN', '마지막 남은 열은 삭제할 수 없어요.');
      const cardIds = (await this.cardsOf(id)).map((c) => c.id); // 보관 카드 포함
      const cands = [key('column', id), ...cardIds.map((c) => key('card', c)), ...(await this.childKeys(cardIds))];
      return this.mutate('열 삭제', cands, async () => {
        await this.removeCardsSql(cardIds);
        await this.q('DELETE FROM board_columns WHERE id = ?', [id]);
      });
    });
  }

  moveColumn(id: string, dir: -1 | 1): Promise<Outcome> {
    return this.write(async () => {
      const col = await this.mustColumn(id);
      const cols = await this.columnsOf(col.boardId);
      return this.mutate('열 이동', cols.map((c) => key('column', c.id)), async () => {
        const i = cols.findIndex((c) => c.id === id);
        const j = i + dir;
        if (j < 0 || j >= cols.length) return;
        const ids = cols.map((c) => c.id);
        [ids[i], ids[j]] = [ids[j], ids[i]];
        await this.setPositions('board_columns', ids);
      });
    });
  }

  setColumnDone(id: string, done: boolean): Promise<Outcome> {
    return this.write(async () => {
      await this.mustColumn(id);
      return this.mutate(done ? '완료 열 지정' : '완료 열 해제', [key('column', id)], async () => {
        await this.q('UPDATE board_columns SET is_done = ? WHERE id = ?', [done, id]);
      });
    });
  }

  // ───────── 카드 ─────────

  addCard(columnId: string, rawTitle: string): Promise<Outcome> {
    return this.write(async () => {
      const title = cleanName(rawTitle, LIMITS.cardTitle, '카드 제목');
      await this.mustColumn(columnId);
      const id = randomUUID();
      return this.mutate('카드 추가', [key('card', id)], async () => {
        const pos = await this.nextPosition('cards', 'column_id = ?', columnId);
        await this.insertCardRow({ id, columnId, title, description: '', assignee: '', dueDate: null, repeat: 'none', labels: [], archived: false, position: pos, followupId: null, rev: 0 });
      });
    });
  }

  private async firstOpenColumn(boardId: string): Promise<Column | undefined> {
    return (await this.columnsOf(boardId)).find((c) => !c.isDone);
  }

  updateCard(id: string, f: CardFields): Promise<Outcome> {
    return this.write(async () => {
      const card = await this.mustCard(id);
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
        next.assignee = [...f.assignee.trim()].slice(0, 50).join('');
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
          if (!(await this.firstOpenColumn(await this.boardOfColumn(card.columnId)))) {
            throw new AppError('NO_OPEN_COLUMN', '미완료 열이 없어서 반복을 설정할 수 없어요. 완료 열이 아닌 열이 하나는 있어야 해요.');
          }
        }
        next.repeat = f.repeat;
      }
      return this.mutate('카드 수정', [key('card', id)], async () => {
        await this.q('UPDATE cards SET title = ?, description = ?, assignee = ?, due_date = ?, repeat = ?, labels = ? WHERE id = ?', [
          next.title,
          next.description,
          next.assignee,
          next.dueDate,
          next.repeat,
          JSON.stringify(next.labels),
          id,
        ]);
      });
    });
  }

  /** 미완료 열 → 완료 열로 가는 반복 카드의 후속 카드 계획. 만들 수 없으면 작업 전체를 막는다. */
  private async planFollowup(card: Card, from: Column, to: Column, today: string | undefined): Promise<Plan | null> {
    if (!to.isDone || from.isDone) return null;
    if (card.repeat === 'none' || !card.dueDate || card.followupId) return null;
    if (!today || !isYmd(today)) throw new AppError('INVALID', '완료한 날짜를 알 수 없어 반복 카드를 만들 수 없어요.');
    const open = await this.firstOpenColumn(to.boardId);
    if (!open) throw new AppError('NO_OPEN_COLUMN', '미완료 열이 없어서 반복 카드를 만들 수 없어요.');
    return {
      cardId: card.id,
      newId: randomUUID(),
      checkIds: (await this.checksOf(card.id)).map(() => randomUUID()),
      colId: open.id,
      due: nextDueDate(today, card.repeat),
      repeat: card.repeat,
    };
  }
  private planKeys(p: Plan): string[] {
    return [key('card', p.newId), ...p.checkIds.map((c) => key('check', c))];
  }
  private async execFollowup(p: Plan) {
    const orig = await this.mustCard(p.cardId);
    const pos = await this.nextPosition('cards', 'column_id = ?', p.colId);
    await this.insertCardRow({ ...orig, id: p.newId, columnId: p.colId, dueDate: p.due, repeat: p.repeat, archived: false, position: pos, followupId: null });
    const checks = await this.checksOf(p.cardId);
    for (let i = 0; i < checks.length; i++) {
      await this.insertCheckRow({ id: p.checkIds[i], cardId: p.newId, text: checks[i].text, done: false, position: i });
    }
    await this.q('UPDATE cards SET followup_id = ? WHERE id = ?', [p.newId, p.cardId]);
  }

  moveCard(id: string, toColumnId: string, index: number, today?: string): Promise<Outcome> {
    return this.write(async () => {
      const card = await this.mustCard(id);
      if (card.archived) throw new AppError('INVALID', '보관된 카드는 먼저 복원해 주세요.');
      const from = await this.mustColumn(card.columnId);
      const to = await this.mustColumn(toColumnId);
      if (from.boardId !== to.boardId) throw new AppError('INVALID', '다른 보드로는 카드를 옮길 수 없어요.');
      const plan = await this.planFollowup(card, from, to, today);
      const involved = from.id === to.id ? await this.cardsOf(from.id) : [...(await this.cardsOf(from.id)), ...(await this.cardsOf(to.id))];
      const cands = [...involved.map((c) => key('card', c.id)), ...(plan ? this.planKeys(plan) : [])];
      return this.mutate('카드 이동', cands, async () => {
        const dst = (await this.visibleIds(to.id)).filter((x) => x !== id);
        const at = Math.max(0, Math.min(Number.isFinite(index) ? Math.trunc(index) : dst.length, dst.length));
        dst.splice(at, 0, id);
        await this.q('UPDATE cards SET column_id = ? WHERE id = ?', [to.id, id]);
        await this.layoutColumn(to.id, dst);
        if (from.id !== to.id) await this.layoutColumn(from.id, await this.visibleIds(from.id));
        if (plan) await this.execFollowup(plan);
      });
    });
  }

  deleteCard(id: string): Promise<Outcome> {
    return this.write(async () => {
      await this.mustCard(id);
      return this.mutate('카드 삭제', [key('card', id), ...(await this.childKeys([id]))], () => this.removeCardsSql([id]));
    });
  }

  duplicateCard(id: string): Promise<Outcome> {
    return this.write(async () => {
      const card = await this.mustCard(id);
      if (card.archived) throw new AppError('INVALID', '보관된 카드는 먼저 복원한 뒤 복제해 주세요.');
      const newId = randomUUID();
      const checks = (await this.checksOf(id)).map((s) => ({ src: s, id: randomUUID() }));
      const cands = [...(await this.cardsOf(card.columnId)).map((c) => key('card', c.id)), key('card', newId), ...checks.map((c) => key('check', c.id))];
      return this.mutate('카드 복제', cands, async () => {
        await this.insertCardRow({ ...card, id: newId, title: copyName(card.title, LIMITS.cardTitle), followupId: null, archived: false, position: 9999 });
        for (let i = 0; i < checks.length; i++) {
          await this.insertCheckRow({ id: checks[i].id, cardId: newId, text: checks[i].src.text, done: checks[i].src.done, position: i });
        }
        const order = (await this.visibleIds(card.columnId)).filter((x) => x !== newId);
        order.splice(order.indexOf(id) + 1, 0, newId);
        await this.layoutColumn(card.columnId, order);
      });
    });
  }

  setArchived(ids: string[], archived: boolean): Promise<Outcome> {
    return this.write(async () => {
      capIds(ids);
      const cards: Card[] = [];
      for (const i of new Set(ids)) cards.push(await this.mustCard(i));
      const target = cards.filter((c) => c.archived !== archived);
      const cols = [...new Set(target.map((c) => c.columnId))];
      const cands: string[] = [];
      for (const c of cols) cands.push(...(await this.cardsOf(c)).map((x) => key('card', x.id)));
      return this.mutate(archived ? '카드 보관' : '카드 복원', cands, async () => {
        for (const colId of cols) {
          const group = target.filter((c) => c.columnId === colId).sort((a, b) => a.position - b.position);
          const visible = await this.visibleIds(colId);
          await this.q('UPDATE cards SET archived = ? WHERE id = ANY(?::text[])', [archived, group.map((c) => c.id)]);
          if (archived) await this.layoutColumn(colId, visible.filter((v) => !group.some((g) => g.id === v)));
          else await this.layoutColumn(colId, [...visible, ...group.map((g) => g.id)]); // 원래 열의 맨 아래
        }
      });
    });
  }

  bulkMove(ids: string[], toColumnId: string, today?: string): Promise<Outcome> {
    return this.write(async () => {
      capIds(ids);
      const to = await this.mustColumn(toColumnId);
      const colPos = new Map((await this.columnsOf(to.boardId)).map((c) => [c.id, c]));
      const cards: Card[] = [];
      for (const i of new Set(ids)) cards.push(await this.mustCard(i));
      for (const c of cards) {
        if (!colPos.has(c.columnId)) throw new AppError('INVALID', '다른 보드로는 카드를 옮길 수 없어요.');
      }
      const moving = cards
        .filter((c) => !c.archived && c.columnId !== to.id)
        .sort((a, b) => colPos.get(a.columnId)!.position - colPos.get(b.columnId)!.position || a.position - b.position);
      if (moving.length === 0) return { snapshot: await this.snapshot(), entry: null };
      const plans: Plan[] = [];
      for (const c of moving) {
        const p = await this.planFollowup(c, colPos.get(c.columnId)!, to, today);
        if (p) plans.push(p);
      }
      const srcCols = [...new Set(moving.map((c) => c.columnId))];
      const cands: string[] = [];
      for (const c of [to.id, ...srcCols]) cands.push(...(await this.cardsOf(c)).map((x) => key('card', x.id)));
      cands.push(...plans.flatMap((p) => this.planKeys(p)));
      return this.mutate('카드 일괄 이동', cands, async () => {
        const existing = await this.visibleIds(to.id);
        await this.q('UPDATE cards SET column_id = ? WHERE id = ANY(?::text[])', [to.id, moving.map((c) => c.id)]);
        await this.layoutColumn(to.id, [...existing, ...moving.map((c) => c.id)]);
        for (const s of srcCols) await this.layoutColumn(s, await this.visibleIds(s));
        for (const p of plans) await this.execFollowup(p);
      });
    });
  }

  bulkDelete(ids: string[]): Promise<Outcome> {
    return this.write(async () => {
      capIds(ids);
      const found = await this.loadMany([...new Set(ids)].map((i) => key('card', i)));
      const cardIds = [...found.values()].map((c) => c.id);
      if (cardIds.length === 0) throw new AppError('NOT_FOUND', '카드를 찾을 수 없어요. 다른 탭에서 지웠을 수 있어요.', 404);
      return this.mutate('카드 일괄 삭제', [...cardIds.map((c) => key('card', c)), ...(await this.childKeys(cardIds))], () => this.removeCardsSql(cardIds));
    });
  }

  // ───────── 체크리스트 ─────────

  addCheck(cardId: string, rawText: string): Promise<Outcome> {
    return this.write(async () => {
      const text = cleanName(rawText, LIMITS.checkText, '체크리스트 내용');
      await this.mustCard(cardId);
      const id = randomUUID();
      return this.mutate('체크리스트 추가', [key('check', id)], async () => {
        const pos = await this.nextPosition('check_items', 'card_id = ?', cardId);
        await this.insertCheckRow({ id, cardId, text, done: false, position: pos });
      });
    });
  }
  updateCheck(id: string, f: { text?: string; done?: boolean }): Promise<Outcome> {
    return this.write(async () => {
      const cur = await this.must<CheckItem>('check', id, '체크리스트 항목');
      const text = f.text !== undefined ? cleanName(f.text, LIMITS.checkText, '체크리스트 내용') : cur.text;
      const done = f.done !== undefined ? !!f.done : cur.done;
      return this.mutate('체크리스트 수정', [key('check', id)], async () => {
        await this.q('UPDATE check_items SET text = ?, done = ? WHERE id = ?', [text, done, id]);
      });
    });
  }
  deleteCheck(id: string): Promise<Outcome> {
    return this.write(async () => {
      await this.must<CheckItem>('check', id, '체크리스트 항목');
      return this.mutate('체크리스트 삭제', [key('check', id)], async () => {
        await this.q('DELETE FROM check_items WHERE id = ?', [id]);
      });
    });
  }

  // ───────── 댓글 ─────────

  addComment(cardId: string, rawBody: string): Promise<Outcome> {
    return this.write(async () => {
      const body = cleanName(rawBody, LIMITS.commentBody, '댓글');
      await this.mustCard(cardId);
      const id = randomUUID();
      const ts = new Date(this.now()).toISOString();
      return this.mutate('댓글 작성', [key('comment', id)], async () => {
        await this.q('INSERT INTO comments (id, card_id, body, created_at, updated_at, rev) VALUES (?, ?, ?, ?, ?, 0)', [id, cardId, body, ts, ts]);
      });
    });
  }
  updateComment(id: string, rawBody: string): Promise<Outcome> {
    return this.write(async () => {
      const body = cleanName(rawBody, LIMITS.commentBody, '댓글');
      await this.must<Comment>('comment', id, '댓글');
      const ts = new Date(this.now()).toISOString();
      return this.mutate('댓글 수정', [key('comment', id)], async () => {
        await this.q('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?', [body, ts, id]);
      });
    });
  }
  deleteComment(id: string): Promise<Outcome> {
    return this.write(async () => {
      await this.must<Comment>('comment', id, '댓글');
      return this.mutate('댓글 삭제', [key('comment', id)], async () => {
        await this.q('DELETE FROM comments WHERE id = ?', [id]);
      });
    });
  }

  // ───────── 첨부 ─────────

  addAttachment(cardId: string, meta: AttachmentMeta): Promise<Outcome> {
    return this.write(async () => {
      await this.mustCard(cardId);
      if ((await this.attachmentCount(cardId)) >= LIMITS.attachmentsPerCard) {
        throw new AppError('LIMIT', `첨부파일은 카드당 ${LIMITS.attachmentsPerCard}개까지 올릴 수 있어요.`);
      }
      const id = randomUUID();
      return this.mutate('첨부 추가', [key('attachment', id)], async () => {
        await this.q('INSERT INTO attachments (id, card_id, name, size, mime, storage_key, deleted_at, rev) VALUES (?, ?, ?, ?, ?, ?, NULL, 0)', [
          id,
          cardId,
          meta.name,
          meta.size,
          meta.mime,
          meta.storageKey,
        ]);
      });
    });
  }
  async attachmentCount(cardId: string): Promise<number> {
    return (await this.one<{ n: number }>('SELECT COUNT(*) AS n FROM attachments WHERE card_id = ? AND deleted_at IS NULL', [cardId]))!.n;
  }
  async getAttachment(id: string): Promise<Attachment | undefined> {
    return (await this.load(key('attachment', id))) as Attachment | undefined;
  }
  deleteAttachment(id: string): Promise<Outcome> {
    return this.write(async () => {
      await this.must<Attachment>('attachment', id, '첨부파일');
      return this.mutate('첨부 삭제', [key('attachment', id)], async () => {
        await this.q('UPDATE attachments SET deleted_at = ? WHERE id = ?', [this.now(), id]);
      });
    });
  }

  /** 삭제 표시 후 보관 기간이 지난 첨부 기록을 지우고, 디스크에서 지울 파일 키를 돌려준다 */
  async purgeExpiredAttachments(): Promise<string[]> {
    const cutoff = this.now() - LIMITS.retentionDays * 24 * 60 * 60 * 1000;
    return (await this.rows<{ storage_key: string }>('DELETE FROM attachments WHERE deleted_at IS NOT NULL AND deleted_at <= ? RETURNING storage_key', [cutoff])).map((r) => r.storage_key);
  }
  async referencedStorageKeys(): Promise<Set<string>> {
    return new Set((await this.rows<{ storage_key: string }>('SELECT storage_key FROM attachments')).map((r) => r.storage_key));
  }

  // ───────── 알림 닫기 ─────────

  /** 사라진 카드의 알림 닫기 기록을 지운다. 되돌리기 이력이 없는 앱 시작 때만 부른다. */
  async purgeOrphanDismissals(): Promise<number> {
    return (await this.q('DELETE FROM dismissals WHERE card_id NOT IN (SELECT id FROM cards)')).rowCount ?? 0;
  }

  dismiss(cardId: string, kind: NotifyKind, dueDate: string): Promise<Outcome> {
    return this.write(async () => {
      if (!NOTIFY.includes(kind) || !isYmd(dueDate)) throw new AppError('INVALID', '알림 정보가 올바르지 않아요.');
      await this.mustCard(cardId);
      const r = await this.q('INSERT INTO dismissals (card_id, kind, due_date) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [cardId, kind, dueDate]);
      if ((r.rowCount ?? 0) > 0) {
        const revision = await this.bumpRevision();
        await this.q('INSERT INTO changes (revision, kind, entity_id, action) VALUES (?, ?, ?, ?)', [revision, 'dismissal', `${cardId}|${kind}|${dueDate}`, 'create']);
        await this.q('DELETE FROM changes WHERE revision <= ?', [revision - this.logLimit]);
        this.als.getStore()!.after.push(() => this.onCommit?.(revision));
      }
      return { snapshot: await this.snapshot(), entry: null };
    });
  }

  // ───────── 되돌리기·다시 실행 ─────────

  /** 이 항목이 기대하는 부모의 키 (보드는 없음) */
  private parentKey(kind: Kind, row: Row): string | null {
    if (kind === 'column') return key('board', (row as Column).boardId);
    if (kind === 'card') return key('column', (row as Card).columnId);
    if (kind === 'check' || kind === 'comment' || kind === 'attachment') return key('card', (row as CheckItem).cardId);
    return null;
  }
  /** 지금 DB에 있는 직접 딸린 항목들의 키 */
  private async childKeysOf(kind: Kind, id: string): Promise<string[]> {
    const ids = async (sql: string, k: Kind) => (await this.rows<{ id: string }>(sql, [id])).map((r) => key(k, r.id));
    if (kind === 'board') return ids('SELECT id FROM board_columns WHERE board_id = ?', 'column');
    if (kind === 'column') return ids('SELECT id FROM cards WHERE column_id = ?', 'card');
    if (kind === 'card') {
      return [
        ...(await ids('SELECT id FROM check_items WHERE card_id = ?', 'check')),
        ...(await ids('SELECT id FROM comments WHERE card_id = ?', 'comment')),
        ...(await ids('SELECT id FROM attachments WHERE card_id = ? AND deleted_at IS NULL', 'attachment')),
      ];
    }
    return [];
  }

  async applyPatch(patch: Patch, expect: Expect): Promise<ApplyResult> {
    assertValidPatch(patch, expect);
    return this.write(async (): Promise<ApplyResult> => {
      const conflict = async (reason: 'changed' | 'file'): Promise<ApplyResult> => ({ conflict: true, reason, snapshot: await this.snapshot() });
      const current = await this.loadMany(expect.map((e) => e.key));
      for (const e of expect) {
        const cur = current.get(e.key);
        if ((cur ? cur.rev : null) !== e.rev) return conflict('changed');
      }
      // 다른 탭이 부모를 먼저 지웠거나 자식을 새로 달았다면, 고아 데이터가 생기므로 이 단계를 통째로 건너뛴다
      const upKeys = new Set(patch.upsert.map((u) => key(u.kind, (u.row as { id: string }).id)));
      const rmKeys = new Set(patch.remove.map((r) => key(r.kind, r.id)));
      const parents = new Set<string>();
      for (const u of patch.upsert) {
        const parent = this.parentKey(u.kind, u.row);
        if (parent && rmKeys.has(parent)) return conflict('changed');
        if (parent && !upKeys.has(parent)) parents.add(parent);
      }
      if (parents.size) {
        const found = await this.loadMany([...parents]);
        for (const p of parents) if (!found.has(p)) return conflict('changed');
      }
      for (const r of patch.remove) {
        if ((await this.childKeysOf(r.kind, r.id)).some((c) => !rmKeys.has(c))) return conflict('changed');
      }
      if (this.fileExists) {
        for (const u of patch.upsert) {
          if (u.kind === 'attachment' && !this.fileExists((u.row as Attachment).storageKey)) return conflict('file');
        }
      }
      // 되돌린 항목이 들어가는 열·보드는 다른 탭 때문에 위치 번호가 겹칠 수 있다.
      // 겹쳤을 때만 정리하는데, 정리로 바뀌는 형제 항목도 변경 기록에 남도록 후보에 미리 넣어 둔다.
      const cardCols = [...new Set(patch.upsert.filter((u) => u.kind === 'card').map((u) => (u.row as Card).columnId))];
      const colBoards = [...new Set(patch.upsert.filter((u) => u.kind === 'column').map((u) => (u.row as Column).boardId))];
      const touchBoards = patch.upsert.some((u) => u.kind === 'board');
      const cands = [...patch.upsert.map((u) => key(u.kind, (u.row as { id: string }).id)), ...patch.remove.map((r) => key(r.kind, r.id))];
      for (const c of cardCols) cands.push(...(await this.cardsOf(c)).map((x) => key('card', x.id)));
      for (const b of colBoards) cands.push(...(await this.columnsOf(b)).map((x) => key('column', x.id)));
      if (touchBoards) cands.push(...(await this.rows<{ id: string }>('SELECT id FROM boards')).map((r) => key('board', r.id)));
      const out = await this.mutate('되돌리기/다시 실행', cands, async () => {
        for (const r of patch.remove) await this.removeRow(r.kind, r.id);
        for (const u of patch.upsert) await this.writeRow(u.kind, u.row);
        for (const c of cardCols) await this.fixDuplicatePositions('cards', 'column_id', c);
        for (const b of colBoards) await this.fixDuplicatePositions('board_columns', 'board_id', b);
        if (touchBoards) await this.fixDuplicatePositions('boards', null, null);
      });
      const after = await this.loadMany([...new Set(cands)]);
      const touched: Record<string, number | null> = {};
      for (const k of new Set(cands)) touched[k] = after.get(k)?.rev ?? null;
      return { conflict: false, snapshot: out.snapshot, touched, entry: out.entry };
    });
  }

  /** 같은 묶음 안에서 위치 번호가 겹친 경우에만, 지금 순서(위치 → id)를 유지한 채 0부터 다시 매긴다. 보관 카드는 보이는 카드 뒤로. */
  private async fixDuplicatePositions(table: 'cards' | 'board_columns' | 'boards', groupCol: string | null, groupId: string | null) {
    const where = groupCol ? `WHERE ${groupCol} = ?` : '';
    const args = groupCol ? [groupId] : [];
    const d = (await this.one<{ n: number; u: number }>(`SELECT COUNT(*) AS n, COUNT(DISTINCT position) AS u FROM ${table} ${where}`, args))!;
    if (d.n === d.u) return;
    if (table === 'cards') return this.layoutColumn(groupId!, await this.visibleIds(groupId!));
    const ids = (await this.rows<{ id: string }>(`SELECT id FROM ${table} ${where} ORDER BY position, id`, args)).map((r) => r.id);
    await this.setPositions(table, ids);
  }

  private async removeRow(kind: Kind, id: string) {
    if (kind === 'attachment') {
      await this.q('UPDATE attachments SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', [this.now(), id]);
    } else {
      await this.q(`DELETE FROM ${TABLE[kind]} WHERE id = ?`, [id]);
    }
  }
  private async upsert(table: string, cols: Record<string, unknown>) {
    const names = Object.keys(cols);
    const sets = names.filter((n) => n !== 'id').map((n) => `${n} = EXCLUDED.${n}`).join(', ');
    await this.q(
      `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')}) ON CONFLICT (id) DO UPDATE SET ${sets}`,
      names.map((n) => cols[n]),
    );
  }
  private async writeRow(kind: Kind, row: Row) {
    if (kind === 'board') {
      const b = row as Board;
      await this.upsert('boards', { id: b.id, name: b.name, position: b.position, rev: b.rev });
    } else if (kind === 'column') {
      const c = row as Column;
      await this.upsert('board_columns', { id: c.id, board_id: c.boardId, name: c.name, position: c.position, is_done: c.isDone, rev: c.rev });
    } else if (kind === 'card') {
      const c = row as Card;
      await this.upsert('cards', {
        id: c.id,
        column_id: c.columnId,
        title: c.title,
        description: c.description,
        assignee: c.assignee,
        due_date: c.dueDate,
        repeat: c.repeat,
        labels: JSON.stringify(c.labels),
        archived: c.archived,
        position: c.position,
        followup_id: c.followupId,
        rev: c.rev,
      });
    } else if (kind === 'check') {
      const c = row as CheckItem;
      await this.upsert('check_items', { id: c.id, card_id: c.cardId, text: c.text, done: c.done, position: c.position, rev: c.rev });
    } else if (kind === 'comment') {
      const c = row as Comment;
      await this.upsert('comments', { id: c.id, card_id: c.cardId, body: c.body, created_at: c.createdAt, updated_at: c.updatedAt, rev: c.rev });
    } else {
      const a = row as Attachment;
      await this.upsert('attachments', { id: a.id, card_id: a.cardId, name: a.name, size: a.size, mime: a.mime, storage_key: a.storageKey, deleted_at: null, rev: a.rev });
    }
  }

  // ───────── 다른 탭 동기화 ─────────

  async changesSince(since: number): Promise<Changes> {
    return this.read(async () => {
      const revision = (await this.one<{ revision: number }>('SELECT revision FROM meta WHERE id = 1'))!.revision;
      if (since >= revision) return { revision, upsert: [], remove: [] };
      const min = (await this.one<{ m: number | null }>('SELECT MIN(revision) AS m FROM changes'))!.m;
      if (!Number.isFinite(since) || since < 0 || min === null || since < min - 1) {
        return { revision, full: await this.snapshot(), upsert: [], remove: [] };
      }
      const rows = await this.rows<{ kind: string; entity_id: string }>('SELECT DISTINCT kind, entity_id FROM changes WHERE revision > ?', [since]);
      const out: Changes = { revision, upsert: [], remove: [] };
      const keys = rows.filter((r) => r.kind !== 'dismissal').map((r) => key(r.kind as Kind, r.entity_id));
      const loaded = await this.loadMany(keys);
      for (const r of rows) {
        if (r.kind === 'dismissal') {
          const [cardId, kind, dueDate] = r.entity_id.split('|');
          const ex = await this.one('SELECT 1 AS x FROM dismissals WHERE card_id = ? AND kind = ? AND due_date = ?', [cardId, kind, dueDate]);
          if (ex) out.upsert.push({ kind: 'dismissal', row: { cardId, kind, dueDate } });
          else out.remove.push({ kind: 'dismissal', id: r.entity_id });
          continue;
        }
        const row = loaded.get(key(r.kind as Kind, r.entity_id));
        if (row) out.upsert.push({ kind: r.kind as Kind, row });
        else out.remove.push({ kind: r.kind as Kind, id: r.entity_id });
      }
      return out;
    });
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
  labels: Array.isArray(r.labels) ? r.labels : JSON.parse(r.labels ?? '[]'),
  archived: !!r.archived,
  position: r.position,
  followupId: r.followup_id,
  rev: r.rev,
});
const toCheck = (r: any): CheckItem => ({ id: r.id, cardId: r.card_id, text: r.text, done: !!r.done, position: r.position, rev: r.rev });
const toComment = (r: any): Comment => ({ id: r.id, cardId: r.card_id, body: r.body, createdAt: r.created_at, updatedAt: r.updated_at, rev: r.rev });
const toAttachment = (r: any): Attachment => ({ id: r.id, cardId: r.card_id, name: r.name, size: r.size, mime: r.mime, storageKey: r.storage_key, rev: r.rev });
const MAP: Record<Kind, (r: any) => Row> = { board: toBoard, column: toColumn, card: toCard, check: toCheck, comment: toComment, attachment: toAttachment };
