import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgBoardRepository } from '../lib/repository';
import { TEST_URL } from './helpers';

const SQL = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
const name = (p: string) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

/** 한 스키마의 표 구조(칸 이름·종류·빈 값 허용·기본값, 기본 키, 검사 조건, 인덱스)를 비교하기 쉬운 글로 만든다 */
async function structure(c: pg.Client, schema: string) {
  const strip = (v: string | null) => (v ?? '').split(`${schema}.`).join('').split(`"${schema}".`).join('');
  const cols = await c.query(
    `SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
    [schema],
  );
  const cons = await c.query(
    `SELECT t.relname AS table_name, con.contype, pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con JOIN pg_class t ON t.oid = con.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 ORDER BY 1, 2, 3`,
    [schema],
  );
  const idx = await c.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY 1`, [schema]);
  return {
    columns: cols.rows.map((r) => `${r.table_name}.${r.column_name} #${r.ordinal_position} ${r.data_type} null=${r.is_nullable} default=${strip(r.column_default)}`),
    constraints: cons.rows.map((r) => `${r.table_name} ${r.contype} ${strip(r.def)}`),
    indexes: idx.rows.map((r) => `${r.indexname}: ${strip(r.indexdef).replace(/ON [^ ]+\./, 'ON ')}`),
  };
}

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: TEST_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const runScript = (c: pg.Client, schema: string) => c.query(`SET search_path TO ${schema}`).then(() => c.query(SQL));

describe('sql/schema.sql (표 만들기 스크립트)', () => {
  it('스크립트로 만든 표 구조가 앱이 만드는 표 구조와 똑같다 (칸·종류·기본값·키·인덱스)', async () => {
    const appSchema = name('t_app');
    const sqlSchema = name('t_sql');
    const repo = await PgBoardRepository.create({ connectionString: TEST_URL, schema: appSchema, poolSize: 2 });
    try {
      await withClient(async (c) => {
        await c.query(`CREATE SCHEMA ${sqlSchema}`);
        await runScript(c, sqlSchema);
        const a = await structure(c, appSchema);
        const b = await structure(c, sqlSchema);
        expect(b.columns.length).toBeGreaterThan(40);
        expect(b.columns).toEqual(a.columns);
        expect(b.constraints).toEqual(a.constraints);
        expect(b.indexes).toEqual(a.indexes);
        const meta = await c.query(`SELECT id, revision FROM ${sqlSchema}.meta`);
        expect(meta.rows).toEqual([{ id: 1, revision: 0 }]);
      });
    } finally {
      await repo.close();
      await PgBoardRepository.dropSchema(TEST_URL, appSchema);
      await PgBoardRepository.dropSchema(TEST_URL, sqlSchema);
    }
  });

  it('모든 표(10개)·칸·인덱스(6개)에 한국어 설명이 들어간다', async () => {
    const s = name('t_sql');
    try {
      await withClient(async (c) => {
        await c.query(`CREATE SCHEMA ${s}`);
        await runScript(c, s);
        const tables = await c.query(
          `SELECT c.relname, obj_description(c.oid, 'pg_class') AS d FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY 1`,
          [s],
        );
        expect(tables.rows.map((r) => r.relname)).toEqual(['app_settings', 'attachments', 'board_columns', 'boards', 'cards', 'changes', 'check_items', 'comments', 'dismissals', 'meta']);
        expect(tables.rows.filter((r) => !r.d || !/[가-힣]/.test(r.d)).map((r) => r.relname)).toEqual([]);
        const cols = await c.query(
          `SELECT c.relname || '.' || a.attname AS col, col_description(c.oid, a.attnum) AS d
             FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped`,
          [s],
        );
        expect(cols.rows.length).toBeGreaterThan(40);
        expect(cols.rows.filter((r) => !r.d || !/[가-힣]/.test(r.d)).map((r) => r.col)).toEqual([]);
        const idx = await c.query(
          `SELECT c.relname, obj_description(c.oid, 'pg_class') AS d FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind = 'i' AND c.relname LIKE 'idx_%' ORDER BY 1`,
          [s],
        );
        expect(idx.rows.length).toBe(6);
        expect(idx.rows.filter((r) => !r.d).map((r) => r.relname)).toEqual([]);
      });
    } finally {
      await PgBoardRepository.dropSchema(TEST_URL, s);
    }
  });

  it('이미 쓰고 있는 데이터베이스에 여러 번 실행해도 데이터는 그대로이고 설명만 들어간다', async () => {
    const s = name('t_app');
    const repo = await PgBoardRepository.create({ connectionString: TEST_URL, schema: s, poolSize: 2 });
    try {
      await repo.ensureFirstBoard();
      const col = (await repo.snapshot()).columns[0].id;
      const card = (await repo.addCard(col, '실행 전부터 있던 카드')).snapshot.cards[0];
      await repo.updateCard(card.id, { labels: ['red'], dueDate: '2026-11-30', assignee: '김민지' });
      await repo.addCheck(card.id, '항목 하나');
      await repo.addComment(card.id, '댓글 하나');
      const before = await repo.snapshot();
      await withClient(async (c) => {
        await runScript(c, s);
        await runScript(c, s); // 두 번 실행해도 오류 없음
        const d = await c.query(`SELECT obj_description('${s}.cards'::regclass, 'pg_class') AS d`);
        expect(d.rows[0].d).toContain('카드');
      });
      const after = await repo.snapshot();
      expect(after).toEqual(before);
      // 실행 뒤에도 앱이 평소처럼 동작한다
      const more = await repo.addCard(col, '실행 뒤 카드');
      expect(more.snapshot.revision).toBe(before.revision + 1);
    } finally {
      await repo.close();
      await PgBoardRepository.dropSchema(TEST_URL, s);
    }
  });
});
