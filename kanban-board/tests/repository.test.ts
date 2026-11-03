import { describe, it, expect, beforeEach } from 'vitest';
import type { PgBoardRepository } from '../lib/repository';
import { newRepo } from './helpers';

let repo: PgBoardRepository;
beforeEach(async () => {
  repo = await newRepo();
});

async function firstBoard() {
  await repo.ensureFirstBoard();
  const s = await repo.snapshot();
  return { s, board: s.boards[0], cols: s.columns.filter((c) => c.boardId === s.boards[0].id) };
}

describe('첫 보드', () => {
  it('처음 실행하면 "내 첫 보드"와 기본 3열을 만들고 마지막 열이 완료 열이다', async () => {
    const { s, board, cols } = await firstBoard();
    expect(board.name).toBe('내 첫 보드');
    expect(cols.map((c) => c.name)).toEqual(['할 일', '진행 중', '완료']);
    expect(cols.map((c) => c.isDone)).toEqual([false, false, true]);
    expect(s.cards).toHaveLength(0);
  });

  it('두 번 불러도 한 번만 만들고, 보드를 다 지워도 다시 만들지 않는다', async () => {
    await repo.ensureFirstBoard();
    await repo.ensureFirstBoard();
    expect((await repo.snapshot()).boards).toHaveLength(1);
    await repo.deleteBoard((await repo.snapshot()).boards[0].id);
    await repo.ensureFirstBoard();
    expect((await repo.snapshot()).boards).toHaveLength(0);
  });
});

describe('이름·제목 검사', () => {
  it('보드 이름 앞뒤 공백을 지우고, 빈 값과 50자 초과는 거부한다', async () => {
    await repo.createBoard('  업무  ');
    expect((await repo.snapshot()).boards[0].name).toBe('업무');
    await expect(repo.createBoard('   ')).rejects.toThrow();
    await expect(repo.createBoard('가'.repeat(51))).rejects.toThrow();
    await expect(repo.createBoard('가'.repeat(50))).resolves.toBeDefined();
  });

  it('같은 이름의 보드는 허용한다', async () => {
    await repo.createBoard('같은 이름');
    await repo.createBoard('같은 이름');
    expect((await repo.snapshot()).boards).toHaveLength(2);
  });

  it('카드 제목은 필수이고 100자까지, 설명은 2000자까지', async () => {
    const { cols } = await firstBoard();
    await expect(repo.addCard(cols[0].id, '   ')).rejects.toThrow();
    await expect(repo.addCard(cols[0].id, 'a'.repeat(101))).rejects.toThrow();
    const { snapshot } = await repo.addCard(cols[0].id, '  할 일 1  ');
    const card = snapshot.cards[0];
    expect(card.title).toBe('할 일 1');
    await expect(repo.updateCard(card.id, { description: 'a'.repeat(2001) })).rejects.toThrow();
    await expect(repo.updateCard(card.id, { title: '  ' })).rejects.toThrow();
  });

  it('마감일을 지우면 반복 주기가 "없음"으로 돌아간다', async () => {
    const { cols } = await firstBoard();
    const id = (await repo.addCard(cols[0].id, 'x')).snapshot.cards[0].id;
    await repo.updateCard(id, { dueDate: '2026-11-30', repeat: 'weekly' });
    expect((await repo.snapshot()).cards[0].repeat).toBe('weekly');
    await repo.updateCard(id, { dueDate: null });
    expect((await repo.snapshot()).cards[0].repeat).toBe('none');
    await expect(repo.updateCard(id, { repeat: 'daily' })).rejects.toThrow();
  });

  it('잘못된 날짜 형식은 거부한다', async () => {
    const { cols } = await firstBoard();
    const id = (await repo.addCard(cols[0].id, 'x')).snapshot.cards[0].id;
    await expect(repo.updateCard(id, { dueDate: '2026-13-01' })).rejects.toThrow();
    await expect(repo.updateCard(id, { dueDate: '내일' })).rejects.toThrow();
  });
});

describe('열', () => {
  it('마지막 남은 열은 삭제할 수 없다', async () => {
    const { cols } = await firstBoard();
    await repo.deleteColumn(cols[0].id);
    await repo.deleteColumn(cols[1].id);
    await expect(repo.deleteColumn(cols[2].id)).rejects.toThrow(/마지막/);
  });

  it('좌우 이동과 완료 열 지정·해제가 된다 (완료 열은 여러 개 가능)', async () => {
    const { cols } = await firstBoard();
    await repo.moveColumn(cols[2].id, -1);
    const names = (await repo.snapshot()).columns.filter((c) => c.boardId === cols[0].boardId).map((c) => c.name);
    expect(names).toEqual(['할 일', '완료', '진행 중']);
    await repo.setColumnDone(cols[0].id, true);
    const done = (await repo.snapshot()).columns.filter((c) => c.isDone).map((c) => c.name);
    expect(done.sort()).toEqual(['완료', '할 일']);
    await repo.setColumnDone(cols[0].id, false);
    expect((await repo.snapshot()).columns.find((c) => c.id === cols[0].id)!.isDone).toBe(false);
  });
});

describe('카드 이동', () => {
  it('같은 열 안 순서 변경과 다른 열로 이동 후 순서가 빈틈없이 정리된다', async () => {
    const { cols } = await firstBoard();
    const add = async (t: string) => (await repo.addCard(cols[0].id, t)).snapshot.cards.find((x) => x.title === t)!;
    const a = await add('A');
    const b = await add('B');
    const c = await add('C');
    await repo.moveCard(c.id, cols[0].id, 0);
    let list = (await repo.snapshot()).cards.filter((x) => x.columnId === cols[0].id).sort((x, y) => x.position - y.position);
    expect(list.map((x) => x.title)).toEqual(['C', 'A', 'B']);
    expect(list.map((x) => x.position)).toEqual([0, 1, 2]);

    await repo.moveCard(a.id, cols[1].id, 0);
    const src = (await repo.snapshot()).cards.filter((x) => x.columnId === cols[0].id).sort((x, y) => x.position - y.position);
    const dst = (await repo.snapshot()).cards.filter((x) => x.columnId === cols[1].id);
    expect(src.map((x) => x.title)).toEqual(['C', 'B']);
    expect(src.map((x) => x.position)).toEqual([0, 1]);
    expect(dst.map((x) => x.title)).toEqual(['A']);
    list = [];
    expect(b.id).toBeTruthy();
  });

  it('다른 보드의 열로는 옮길 수 없다', async () => {
    const { cols } = await firstBoard();
    const other = (await repo.createBoard('다른')).snapshot;
    const otherCol = other.columns.find((c) => c.boardId !== cols[0].boardId)!;
    const id = (await repo.addCard(cols[0].id, 'x')).snapshot.cards[0].id;
    await expect(repo.moveCard(id, otherCol.id, 0)).rejects.toThrow();
  });
});

describe('변경 번호(revision)', () => {
  it('변경할 때마다 전역 번호가 1씩 늘고, 바뀐 항목의 번호도 갱신된다', async () => {
    const { cols } = await firstBoard();
    const r0 = (await repo.snapshot()).revision;
    const r1 = (await repo.addCard(cols[0].id, 'x')).snapshot;
    expect(r1.revision).toBe(r0 + 1);
    const card = r1.cards[0];
    expect(card.rev).toBe(r1.revision);
    const r2 = (await repo.updateCard(card.id, { title: 'y' })).snapshot;
    expect(r2.revision).toBe(r1.revision + 1);
    expect(r2.cards[0].rev).toBe(r2.revision);
  });

  it('바뀐 게 없으면 번호를 올리지 않고 기록도 만들지 않는다', async () => {
    const { cols } = await firstBoard();
    const id = (await repo.addCard(cols[0].id, 'x')).snapshot.cards[0].id;
    const before = (await repo.snapshot()).revision;
    const out = await repo.updateCard(id, { title: 'x' });
    expect(out.entry).toBeNull();
    expect(out.snapshot.revision).toBe(before);
  });
});

describe('삭제 되돌리기 (같은 ID로 복원)', () => {
  it('열을 지우면 소속 카드도 지워지고, 되돌리면 같은 ID로 돌아온다', async () => {
    const { cols } = await firstBoard();
    const cardId = (await repo.addCard(cols[0].id, '카드')).snapshot.cards[0].id;
    const before = await repo.snapshot();
    const out = await repo.deleteColumn(cols[0].id);
    expect(out.snapshot.cards).toHaveLength(0);
    expect(out.snapshot.columns.find((c) => c.id === cols[0].id)).toBeUndefined();
    const undo = await repo.applyPatch(out.entry!.inverse, out.entry!.expect);
    expect(undo.conflict).toBe(false);
    expect((await repo.snapshot()).columns.map((c) => c.id).sort()).toEqual(before.columns.map((c) => c.id).sort());
    expect((await repo.snapshot()).cards[0].id).toBe(cardId);
  });

  it('보드를 지우면 열·카드까지 지워지고, 되돌리면 모두 같은 ID로 돌아온다', async () => {
    const { cols, board } = await firstBoard();
    const cardId = (await repo.addCard(cols[1].id, '카드')).snapshot.cards[0].id;
    const out = await repo.deleteBoard(board.id);
    expect(out.snapshot.boards).toHaveLength(0);
    expect(out.snapshot.columns).toHaveLength(0);
    expect(out.snapshot.cards).toHaveLength(0);
    const undo = await repo.applyPatch(out.entry!.inverse, out.entry!.expect);
    expect(undo.conflict).toBe(false);
    const s = await repo.snapshot();
    expect(s.boards[0].id).toBe(board.id);
    expect(s.columns.map((c) => c.id).sort()).toEqual(cols.map((c) => c.id).sort());
    expect(s.cards[0].id).toBe(cardId);
  });

  it('카드 생성을 되돌리면 사라지고, 다시 실행하면 같은 ID로 돌아온다', async () => {
    const { cols } = await firstBoard();
    const out = await repo.addCard(cols[0].id, '새 카드');
    const id = out.snapshot.cards[0].id;
    const undo = await repo.applyPatch(out.entry!.inverse, out.entry!.expect);
    expect(undo.conflict).toBe(false);
    if (undo.conflict) return;
    expect((await repo.snapshot()).cards).toHaveLength(0);
    const redo = await repo.applyPatch(out.entry!.forward, expectFrom(out.entry!.expect, undo.touched));
    expect(redo.conflict).toBe(false);
    expect((await repo.snapshot()).cards[0].id).toBe(id);
  });
});

describe('카드 삭제', () => {
  it('카드를 지우면 사라지고, 되돌리면 같은 ID·내용으로 돌아온다', async () => {
    const { cols } = await firstBoard();
    const id = (await repo.addCard(cols[0].id, '지울 카드')).snapshot.cards[0].id;
    await repo.updateCard(id, { description: '설명', assignee: '홍길동', dueDate: '2026-12-25' });
    const before = (await repo.snapshot()).cards[0];
    const out = await repo.deleteCard(id);
    expect(out.snapshot.cards).toHaveLength(0);
    const undo = await repo.applyPatch(out.entry!.inverse, out.entry!.expect);
    expect(undo.conflict).toBe(false);
    const after = (await repo.snapshot()).cards[0];
    expect({ ...after, rev: 0 }).toEqual({ ...before, rev: 0 });
  });
});

describe('되돌리기 충돌 확인', () => {
  it('다른 탭이 먼저 바꾼 카드는 되돌리기로 덮어쓰지 않는다', async () => {
    const { cols } = await firstBoard();
    const id = (await repo.addCard(cols[0].id, '원래')).snapshot.cards[0].id;
    const mine = await repo.updateCard(id, { title: '내가 바꿈' });
    await repo.updateCard(id, { title: '다른 탭이 바꿈' }); // 다른 탭
    const res = await repo.applyPatch(mine.entry!.inverse, mine.entry!.expect);
    expect(res.conflict).toBe(true);
    expect((await repo.snapshot()).cards[0].title).toBe('다른 탭이 바꿈');
  });

  it('여러 항목 작업은 일부만 취소하지 않고 전체를 건너뛴다', async () => {
    const { cols } = await firstBoard();
    const a = (await repo.addCard(cols[0].id, 'A')).snapshot.cards[0].id;
    const b = (await repo.addCard(cols[0].id, 'B')).snapshot.cards.find((c) => c.title === 'B')!.id;
    const moved = await repo.moveCard(b, cols[0].id, 0); // A, B 둘 다 위치가 바뀜
    await repo.updateCard(a, { title: 'A2' }); // 다른 탭이 A를 바꿈
    const res = await repo.applyPatch(moved.entry!.inverse, moved.entry!.expect);
    expect(res.conflict).toBe(true);
    const list = (await repo.snapshot()).cards.sort((x, y) => x.position - y.position).map((c) => c.title);
    expect(list).toEqual(['B', 'A2']);
  });
});

function expectFrom(expect: { key: string; rev: number | null }[], touched: Record<string, number | null>) {
  return expect.map((e) => ({ key: e.key, rev: touched[e.key] ?? null }));
}
