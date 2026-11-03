import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { PgBoardRepository } from '../lib/repository';
import { cleanupStorage, LocalStorageAdapter } from '../lib/storage';
import { AppError } from '../lib/types';
import { newRepo, TEST_URL } from './helpers';

let repo: PgBoardRepository;
let col: string;
beforeEach(async () => {
  repo = await newRepo();
  await repo.ensureFirstBoard();
  col = (await repo.snapshot()).columns[0].id;
});
const card = async () => (await repo.addCard(col, '카드')).snapshot.cards[0].id;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('이상한 글자·숫자는 서버 오류(500)가 아니라 정상 거부(INVALID)', () => {
  it('NUL 문자(\\u0000)가 들어간 글은 거부한다', async () => {
    const id = await card();
    const bad = 'a\u0000b';
    for (const f of [
      () => repo.addCard(col, bad),
      () => repo.createBoard(bad),
      () => repo.addColumn(col, bad),
      () => repo.addComment(id, bad),
      () => repo.addCheck(id, bad),
      () => repo.updateCard(id, { description: bad }),
      () => repo.updateCard(id, { assignee: bad }),
      () => repo.updateCard(id, { title: bad }),
    ]) {
      await expect(f()).rejects.toMatchObject({ code: 'INVALID', status: 400 });
    }
  });

  it('되돌리기 요청의 숫자가 DB 정수 범위를 넘으면 거부한다', async () => {
    const del = await repo.deleteCard(await card());
    const row = JSON.parse(JSON.stringify(del.entry!.inverse.upsert[0].row));
    for (const field of ['position', 'rev']) {
      const patch = JSON.parse(JSON.stringify(del.entry!.inverse));
      patch.upsert[0].row[field] = 3_000_000_000;
      await expect(repo.applyPatch(patch, [])).rejects.toBeInstanceOf(AppError);
    }
    expect(row).toBeTruthy();
    // 정상 값은 그대로 통과한다
    expect((await repo.applyPatch(del.entry!.inverse, del.entry!.expect)).conflict).toBe(false);
  });

  it('변경 이어받기(since)에 소수·음수·너무 큰 값·문자가 와도 오류 없이 처리한다', async () => {
    await card();
    const rev = (await repo.snapshot()).revision;
    for (const since of [1.5, -5, 1e10, Number.NaN, Number.POSITIVE_INFINITY, rev + 100]) {
      const ch = await repo.changesSince(since);
      expect(ch.revision).toBe(rev);
    }
    // 서버보다 앞선 번호(DB를 옛 백업으로 되돌린 경우)는 전체 데이터로 다시 받게 한다
    expect((await repo.changesSince(rev + 100)).full?.revision).toBe(rev);
    expect((await repo.changesSince(rev)).full).toBeUndefined();
  });
});

describe('멈춤 방지: 연결 기다림도 시간 제한이 있다', () => {
  it('쓰기가 막혀 연결이 바닥나도 읽기가 영원히 기다리지 않고 알아볼 수 있는 오류로 끝난다', async () => {
    const { PgBoardRepository } = await import('../lib/repository');
    const schema = (repo as any).schema as string;
    const small = await PgBoardRepository.create({
      connectionString: TEST_URL,
      schema,
      poolSize: 3,
      timeouts: { lockMs: 20_000 },
      connectionTimeoutMs: 700,
    });
    const holder = new pg.Client({ connectionString: TEST_URL, options: `-c search_path=${schema}` });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT revision FROM meta WHERE id = 1 FOR UPDATE');
    const writers = Array.from({ length: 4 }, (_, i) => small.addCard(col, 'w' + i).catch((e) => e));
    await sleep(300); // 쓰기 3개가 연결 3개를 모두 쥔 채 기다리는 상태
    const t0 = Date.now();
    let err: unknown;
    try {
      await small.snapshot();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(503);
    expect(Date.now() - t0).toBeLessThan(3000);
    await holder.query('ROLLBACK');
    await holder.end();
    await Promise.all(writers);
    await small.close();
  });
});

describe('마감일 연도 검사', () => {
  it('1900~2999년 밖의 연도(0025년 같은 오타)는 이유를 알려 주며 거부하고, 경계값은 받는다', async () => {
    const id = await card();
    for (const bad of ['0025-11-03', '1899-12-31', '3000-01-01']) {
      await expect(repo.updateCard(id, { dueDate: bad }), bad).rejects.toThrow('연도를 확인해 주세요');
    }
    for (const okDate of ['1900-01-01', '2999-12-31']) {
      const r = await repo.updateCard(id, { dueDate: okDate });
      expect(r.snapshot.cards.find((c) => c.id === id)?.dueDate).toBe(okDate);
    }
  });
});

describe('첨부 정리: 이상한 파일이 있어도 중단되지 않는다', () => {
  it('저장 키 모양이 아닌 파일은 건드리지 않고, 오래된 고아 파일은 지운다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-up-'));
    const storage = new LocalStorageAdapter(dir);
    const old = Date.now() - 3600_000;
    const make = (name: string) => {
      fs.writeFileSync(path.join(dir, name), 'x');
      fs.utimesSync(path.join(dir, name), old / 1000, old / 1000);
    };
    const orphans = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333.tmp'];
    orphans.forEach(make);
    ['.gitkeep', 'README.txt', 'notes', '.DS_Store'].forEach(make);
    const removed = await cleanupStorage(repo, storage);
    expect(removed.sort()).toEqual([...orphans].sort());
    expect(fs.readdirSync(dir).sort()).toEqual(['.DS_Store', '.gitkeep', 'README.txt', 'notes']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
