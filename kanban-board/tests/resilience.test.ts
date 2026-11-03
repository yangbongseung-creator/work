import { describe, it, expect, beforeEach } from 'vitest';
import pg from 'pg';
import type { PgBoardRepository } from '../lib/repository';
import { AppError } from '../lib/types';
import { newRepo, TEST_URL } from './helpers';

/**
 * 서버에서는 PostgreSQL이 재시작되거나 연결이 끊기는 일이 실제로 생긴다.
 * 그럴 때 앱이 죽지 않고, 멈추지 않고, 다시 살아나는지 확인한다.
 * (연결은 application_name으로 구분해서 이 시험의 연결만 끊는다)
 */
let repo: PgBoardRepository;
let schema: string;
let cols: string[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const admin = () => new pg.Pool({ connectionString: TEST_URL, max: 1 });

async function terminateMine(onlyActive = false): Promise<number> {
  const a = admin();
  try {
    const r = await a.query(
      `SELECT pg_terminate_backend(pid) AS t FROM pg_stat_activity
       WHERE application_name = $1 AND pid <> pg_backend_pid() ${onlyActive ? "AND state = 'active'" : ''}`,
      [`kanban-${schema}`],
    );
    return r.rowCount ?? 0;
  } finally {
    await a.end();
  }
}

beforeEach(async () => {
  repo = await newRepo();
  schema = (repo as any).schema;
  await repo.ensureFirstBoard();
  const s = await repo.snapshot();
  cols = s.columns.filter((c) => c.boardId === s.boards[0].id).map((c) => c.id);
});

describe('DB 연결이 끊겨도 앱이 죽지 않고 다시 살아난다', () => {
  it('놀고 있는 연결이 모두 끊겨도 (DB 재시작과 같은 상황) 곧 다시 동작한다', async () => {
    await Promise.all([repo.snapshot(), repo.snapshot(), repo.snapshot()]); // 연결 여러 개를 열어 둔다
    expect(await terminateMine()).toBeGreaterThan(0);
    await sleep(300);
    let ok = false;
    for (let i = 0; i < 4 && !ok; i++) {
      try {
        await repo.addCard(cols[0], '끊긴 뒤');
        ok = true;
      } catch (e) {
        expect(e).toBeInstanceOf(AppError); // 실패해도 알아볼 수 있는 오류여야 한다
        await sleep(200);
      }
    }
    expect(ok).toBe(true);
    expect((await repo.snapshot()).cards.map((c) => c.title)).toEqual(['끊긴 뒤']);
  });

  it('저장 도중(트랜잭션 중) 연결이 끊기면 멈추지 않고 실패하며, 반쯤 저장되지 않고, 이후 정상 동작한다', async () => {
    const before = JSON.stringify((await repo.snapshot()).cards);
    const slow = (repo as any).write(async () => {
      await repo.addCard(cols[0], '반쯤 저장될 카드');
      await (repo as any).q('SELECT pg_sleep(2)'); // 이 사이에 연결을 끊는다
    });
    await sleep(500);
    expect(await terminateMine(true)).toBeGreaterThan(0);
    const started = Date.now();
    await expect(slow).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(5000); // 멈추지 않는다
    await sleep(200);
    let snap = '';
    for (let i = 0; i < 4; i++) {
      try {
        snap = JSON.stringify((await repo.snapshot()).cards);
        break;
      } catch {
        await sleep(200);
      }
    }
    expect(snap).toBe(before); // 반쯤 저장된 카드가 없다
    await repo.addCard(cols[0], '이후 정상'); // 잠금이 남아 있지 않다
    expect((await repo.snapshot()).cards.map((c) => c.title)).toEqual(['이후 정상']);
  });

  it('연결 오류는 알아볼 수 있는 안내 메시지(503)로 나온다', async () => {
    const bad = await (await import('../lib/repository')).PgBoardRepository.create({ connectionString: TEST_URL, schema: 'res_tmp', poolSize: 1 });
    await bad.close(); // 풀을 닫으면 이후 요청은 연결할 수 없다
    let err: unknown;
    try {
      await bad.snapshot();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(503);
    expect((err as AppError).message).toMatch(/DB/);
    const { PgBoardRepository } = await import('../lib/repository');
    await PgBoardRepository.dropSchema(TEST_URL, 'res_tmp');
  });
});

describe('멈춤 방지', () => {
  it('다른 곳이 잠금을 오래 쥐고 있으면 영원히 기다리지 않고 알아볼 수 있는 오류로 끝난다', async () => {
    const { PgBoardRepository } = await import('../lib/repository');
    const quick = await PgBoardRepository.create({ connectionString: TEST_URL, schema, poolSize: 2, timeouts: { lockMs: 600 } });
    const holder = new pg.Client({ connectionString: TEST_URL, options: `-c search_path=${schema}` });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT revision FROM meta WHERE id = 1 FOR UPDATE'); // 쓰기 잠금을 쥔다
    const t0 = Date.now();
    let err: unknown;
    try {
      await quick.addCard(cols[0], '기다리는 카드');
    } catch (e) {
      err = e;
    }
    const waited = Date.now() - t0;
    await holder.query('ROLLBACK');
    await holder.end();
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(503);
    expect(waited).toBeGreaterThanOrEqual(500);
    expect(waited).toBeLessThan(4000);
    await quick.addCard(cols[0], '잠금이 풀린 뒤'); // 풀린 뒤에는 정상
    await quick.close();
  });

  it('오래 걸리는 쿼리는 제한 시간에 끊긴다', async () => {
    const { PgBoardRepository } = await import('../lib/repository');
    const quick = await PgBoardRepository.create({ connectionString: TEST_URL, schema, poolSize: 2, timeouts: { statementMs: 400 } });
    const t0 = Date.now();
    await expect((quick as any).write(async () => (quick as any).q('SELECT pg_sleep(5)'))).rejects.toBeInstanceOf(AppError);
    expect(Date.now() - t0).toBeLessThan(3000);
    await quick.addCard(cols[0], '이후 정상');
    await quick.close();
  });

  it('트랜잭션을 열어 두고 멈춰 있으면 DB가 알아서 정리해서 잠금이 풀린다', async () => {
    const { PgBoardRepository } = await import('../lib/repository');
    const quick = await PgBoardRepository.create({ connectionString: TEST_URL, schema, poolSize: 2, timeouts: { idleTxMs: 500 } });
    // 일부러 트랜잭션 안에서 JS가 멈춰 있는 상황
    const stuck = (quick as any).write(async () => {
      await (quick as any).q('SELECT 1');
      await sleep(1500);
      await (quick as any).q('SELECT 1');
    });
    await sleep(900);
    await quick.addCard(cols[0], '다른 요청은 기다리다 진행'); // 멈춘 트랜잭션이 정리된 뒤 진행된다
    await expect(stuck).rejects.toBeDefined();
    await quick.close();
  });
});
