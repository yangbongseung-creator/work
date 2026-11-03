import { describe, it, expect, beforeEach } from 'vitest';
import type { PgBoardRepository } from '../lib/repository';
import { AppError } from '../lib/types';
import { newRepo } from './helpers';

/**
 * PostgreSQL은 요청을 진짜로 동시에 처리한다. 그래서 "동시에 와도 결과가 올바른가"를 따로 시험한다.
 * (저장소는 연결을 여러 개 쓰므로, Promise.all로 보내면 서로 다른 연결에서 동시에 실행된다)
 */
let repo: PgBoardRepository;
let cols: { id: string }[];
const TODAY = '2026-11-03';
beforeEach(async () => {
  repo = await newRepo({ changeLogLimit: 100000 });
  await repo.ensureFirstBoard();
  const s = await repo.snapshot();
  cols = s.columns.filter((c) => c.boardId === s.boards[0].id);
});
const mk = async (title: string, i = 0) => {
  const before = new Set((await repo.snapshot()).cards.map((c) => c.id));
  return (await repo.addCard(cols[i].id, title)).snapshot.cards.find((c) => !before.has(c.id))!.id;
};

describe('동시에 요청이 와도 올바르다', () => {
  it('같은 반복 카드를 동시에 완료로 옮겨도 후속 카드는 하나만 생긴다', async () => {
    const id = await mk('주간 보고');
    await repo.updateCard(id, { dueDate: '2026-11-01', repeat: 'weekly' });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => repo.moveCard(id, cols[2].id, 0, TODAY)));
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const cards = (await repo.snapshot()).cards;
    expect(cards.filter((c) => c.title === '주간 보고')).toHaveLength(2); // 원본 + 후속 1개
    expect(cards.find((c) => c.id === id)!.followupId).toBeTruthy();
  });

  it('여러 반복 카드를 일괄 이동과 개별 이동으로 동시에 완료해도 카드마다 후속은 하나', async () => {
    const ids = [await mk('A'), await mk('B'), await mk('C')]; // 도우미는 동시에 부르면 서로 혼동하므로 순서대로 만든다
    for (const id of ids) await repo.updateCard(id, { dueDate: '2026-11-05', repeat: 'daily' });
    await Promise.all([
      repo.bulkMove(ids, cols[2].id, TODAY),
      repo.moveCard(ids[0], cols[2].id, 0, TODAY),
      repo.bulkMove([ids[1], ids[2]], cols[2].id, TODAY),
    ]);
    const cards = (await repo.snapshot()).cards;
    expect(cards).toHaveLength(6); // 원본 3 + 후속 3
    expect(new Set(cards.map((c) => c.followupId).filter(Boolean)).size).toBe(3);
  });

  it('카드를 동시에 30개 만들어도 위치 번호가 겹치지 않고, 변경 번호는 정확히 30 늘어난다', async () => {
    const r0 = (await repo.snapshot()).revision;
    await Promise.all(Array.from({ length: 30 }, (_, i) => repo.addCard(cols[0].id, `c${i}`)));
    const s = await repo.snapshot();
    expect(s.cards).toHaveLength(30);
    const pos = s.cards.map((c) => c.position);
    expect(new Set(pos).size).toBe(30);
    expect(s.revision).toBe(r0 + 30);
    expect(new Set(s.cards.map((c) => c.rev)).size).toBe(30); // 변경마다 서로 다른 번호
  });

  it('같은 카드를 동시에 수정·이동·삭제해도 고아가 생기지 않는다', async () => {
    for (let round = 0; round < 15; round++) {
      const id = await mk('경쟁' + round);
      await repo.addComment(id, '댓글');
      await Promise.allSettled([
        repo.updateCard(id, { title: '수정' + round }),
        repo.moveCard(id, cols[1].id, 0, TODAY),
        repo.deleteCard(id),
        repo.addCheck(id, '항목'),
        repo.duplicateCard(id),
        repo.setArchived([id], true),
      ]);
    }
    const s = await repo.snapshot();
    const cardIds = new Set(s.cards.map((c) => c.id));
    expect(s.cards.every((c) => s.columns.some((x) => x.id === c.columnId))).toBe(true);
    expect(s.comments.every((c) => cardIds.has(c.cardId))).toBe(true);
    expect(s.checks.every((c) => cardIds.has(c.cardId))).toBe(true);
    // 같은 열 안 위치 번호는 겹치지 않는다
    const seen = new Set<string>();
    for (const c of s.cards) {
      const k = `${c.columnId}:${c.position}`;
      expect(seen.has(k), k).toBe(false);
      seen.add(k);
    }
  });

  it('동시에 같은 보드를 지우고 복제해도 어긋나지 않는다', async () => {
    const board = (await repo.snapshot()).boards[0].id;
    await mk('카드');
    await Promise.allSettled([repo.deleteBoard(board), repo.duplicateBoard(board), repo.renameBoard(board, '새 이름'), repo.addColumn(board, '열')]);
    const s = await repo.snapshot();
    for (const c of s.columns) expect(s.boards.some((b) => b.id === c.boardId)).toBe(true);
    for (const c of s.cards) expect(s.columns.some((x) => x.id === c.columnId)).toBe(true);
  });

  it('동시에 되돌리기를 같은 항목에 두 번 보내도 한 번만 적용된다', async () => {
    const id = await mk('A');
    const del = await repo.deleteCard(id);
    const results = await Promise.all([repo.applyPatch(del.entry!.inverse, del.entry!.expect), repo.applyPatch(del.entry!.inverse, del.entry!.expect)]);
    expect(results.filter((r) => !r.conflict)).toHaveLength(1);
    expect(results.filter((r) => r.conflict)).toHaveLength(1);
    expect((await repo.snapshot()).cards.filter((c) => c.id === id)).toHaveLength(1);
  });

  it('한 요청이 실패해도 다른 동시 요청은 영향을 받지 않는다', async () => {
    const jobs = await Promise.allSettled([
      repo.addCard(cols[0].id, '정상1'),
      repo.addCard(cols[0].id, '   '), // 실패
      repo.addCard('없는열', '실패2'), // 실패
      repo.addCard(cols[1].id, '정상2'),
    ]);
    expect(jobs.map((j) => j.status)).toEqual(['fulfilled', 'rejected', 'rejected', 'fulfilled']);
    for (const j of jobs) if (j.status === 'rejected') expect(j.reason).toBeInstanceOf(AppError);
    expect((await repo.snapshot()).cards.map((c) => c.title).sort()).toEqual(['정상1', '정상2']);
  });

  it('읽기는 쓰기 도중에도 항상 일관된 모습을 본다 (중간 상태가 섞이지 않음)', async () => {
    const id = await mk('카드');
    let stop = false;
    const writer = (async () => {
      for (let i = 0; i < 25 && !stop; i++) {
        await repo.moveCard(id, cols[i % 2 === 0 ? 1 : 0].id, 0, TODAY);
        await repo.addComment(id, 'x' + i);
      }
    })();
    const bad: string[] = [];
    for (let i = 0; i < 40; i++) {
      const s = await repo.snapshot();
      const ids = new Set(s.cards.map((c) => c.id));
      if (s.comments.some((c) => !ids.has(c.cardId))) bad.push('댓글만 있고 카드 없음');
      if (s.cards.some((c) => !s.columns.some((x) => x.id === c.columnId))) bad.push('열 없는 카드');
    }
    stop = true;
    await writer;
    expect(bad).toEqual([]);
  });
});

describe('연결·시작', () => {
  it('표 만들기는 여러 번, 동시에 해도 안전하다 (서버가 동시에 시작해도)', async () => {
    const { PgBoardRepository } = await import('../lib/repository');
    const { TEST_URL } = await import('./helpers');
    const schema = (repo as any).schema as string;
    const extra = await Promise.all(Array.from({ length: 4 }, () => PgBoardRepository.create({ connectionString: TEST_URL, schema, poolSize: 1 })));
    expect((await extra[0].snapshot()).boards).toHaveLength(1); // 기존 데이터가 그대로
    await Promise.all(extra.map((e) => e.close()));
  });

  it('틀린 연결 정보면 알아볼 수 있는 오류로 실패한다 (비밀번호가 오류 메시지에 새지 않음)', async () => {
    const { PgBoardRepository } = await import('../lib/repository');
    const secret = 'super_secret_pw_123';
    let err: Error | undefined;
    try {
      await PgBoardRepository.create({ connectionString: `postgres://kanban:${secret}@127.0.0.1:5432/kanban_test`, schema: 'x_wrong' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(String(err!.message)).not.toContain(secret);
  });

  it('스키마 이름에 이상한 글자가 있으면 거부한다 (SQL 주입 방지)', async () => {
    const { PgBoardRepository } = await import('../lib/repository');
    const { TEST_URL } = await import('./helpers');
    for (const bad of ['a"; DROP TABLE x;--', 'A', '1abc', 'a b', 'a'.repeat(70), '']) {
      if (bad === '') continue;
      await expect(PgBoardRepository.create({ connectionString: TEST_URL, schema: bad })).rejects.toBeInstanceOf(AppError);
    }
  });
});
