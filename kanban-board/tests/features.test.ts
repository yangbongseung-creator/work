import { describe, it, expect, beforeEach } from 'vitest';
import type { PgBoardRepository } from '../lib/repository';
import { newRepo } from './helpers';
import { History } from '../lib/history';
import { cleanupStorage, type StorageAdapter } from '../lib/storage';
import type { Entry, Outcome } from '../lib/types';

const DAY = 24 * 60 * 60 * 1000;
let now: number;
let files: Set<string>;
let repo: PgBoardRepository;
let board: string;
let cols: { id: string; name: string }[];

beforeEach(async () => {
  now = Date.parse('2026-11-03T03:00:00Z');
  files = new Set();
  repo = await newRepo({ now: () => now, fileExists: (k) => files.has(k) });
  await repo.ensureFirstBoard();
  const s = await repo.snapshot();
  board = s.boards[0].id;
  cols = s.columns.filter((c) => c.boardId === board);
});

const mk = async (title: string, colIdx = 0) => {
  const before = new Set((await repo.snapshot()).cards.map((c) => c.id));
  const s = (await repo.addCard(cols[colIdx].id, title)).snapshot;
  return s.cards.find((c) => !before.has(c.id))!.id;
};
const card = async (id: string) => (await repo.snapshot()).cards.find((c) => c.id === id)!;
const inCol = async (colIdx: number) =>
  (await repo.snapshot()).cards.filter((c) => c.columnId === cols[colIdx].id && !c.archived).sort((a, b) => a.position - b.position);
const undo = async (o: Outcome) => await repo.applyPatch(o.entry!.inverse, o.entry!.expect);
const TODAY = '2026-11-03';

describe('라벨', () => {
  it('색만 고르고 같은 색은 한 번만, 정해진 6색만 허용', async () => {
    const id = await mk('a');
    await repo.updateCard(id, { labels: ['red', 'blue', 'red'] });
    expect((await card(id)).labels).toEqual(['red', 'blue']);
    await expect(repo.updateCard(id, { labels: ['pink' as any] })).rejects.toThrow();
  });
});

describe('체크리스트', () => {
  it('추가·수정·체크·삭제, 빈 항목과 500자 초과는 거부', async () => {
    const id = await mk('a');
    const s = (await repo.addCheck(id, '  우유 사기  ')).snapshot;
    const item = s.checks[0];
    expect(item.text).toBe('우유 사기');
    expect(item.done).toBe(false);
    await expect(repo.addCheck(id, '  ')).rejects.toThrow();
    await expect(repo.addCheck(id, 'a'.repeat(501))).rejects.toThrow();
    await repo.updateCheck(item.id, { done: true });
    expect((await repo.snapshot()).checks[0].done).toBe(true);
    await repo.updateCheck(item.id, { text: '두유 사기' });
    expect((await repo.snapshot()).checks[0].text).toBe('두유 사기');
    await expect(repo.updateCheck(item.id, { text: ' ' })).rejects.toThrow();
    await repo.addCheck(id, '둘째');
    expect((await repo.snapshot()).checks.map((c) => c.position)).toEqual([0, 1]);
    const del = await repo.deleteCheck(item.id);
    expect((await repo.snapshot()).checks).toHaveLength(1);
    expect((await undo(del)).conflict).toBe(false);
    expect((await repo.snapshot()).checks.find((c) => c.id === item.id)!.text).toBe('두유 사기');
  });
});

describe('댓글', () => {
  it('빈 댓글·1000자 초과 거부, 수정하면 수정 시각이 바뀐다', async () => {
    const id = await mk('a');
    await expect(repo.addComment(id, '   ')).rejects.toThrow();
    await expect(repo.addComment(id, 'a'.repeat(1001))).rejects.toThrow();
    const c = (await repo.addComment(id, '첫 댓글\n둘째 줄')).snapshot.comments[0];
    expect(c.body).toBe('첫 댓글\n둘째 줄');
    expect(c.createdAt).toBe('2026-11-03T03:00:00.000Z');
    expect(c.updatedAt).toBe(c.createdAt);
    now += 60_000;
    await repo.updateComment(c.id, '고친 댓글');
    const u = (await repo.snapshot()).comments[0];
    expect(u.body).toBe('고친 댓글');
    expect(u.updatedAt > u.createdAt).toBe(true);
    const del = await repo.deleteComment(c.id);
    expect((await repo.snapshot()).comments).toHaveLength(0);
    expect((await undo(del)).conflict).toBe(false);
    expect((await repo.snapshot()).comments).toHaveLength(1);
  });
});

describe('보관함', () => {
  it('보관·복원: 복원하면 원래 열의 맨 아래로 들어간다', async () => {
    const a = await mk('A');
    const b = await mk('B');
    await mk('C');
    await repo.setArchived([a], true);
    expect((await card(a)).archived).toBe(true);
    expect((await inCol(0)).map((c) => c.title)).toEqual(['B', 'C']);
    await repo.setArchived([a], false);
    expect((await inCol(0)).map((c) => c.title)).toEqual(['B', 'C', 'A']);
    expect((await card(b)).columnId).toBe(cols[0].id);
  });
  it('열을 지우면 보관된 카드도 함께 삭제되고, 되돌리면 모두 돌아온다', async () => {
    const a = await mk('A');
    await mk('B');
    await repo.setArchived([a], true);
    const del = await repo.deleteColumn(cols[0].id);
    expect(del.snapshot.cards).toHaveLength(0);
    expect((await undo(del)).conflict).toBe(false);
    expect((await repo.snapshot()).cards).toHaveLength(2);
    expect((await card(a)).archived).toBe(true);
  });
  it('카드 이동 위치(index)는 보이는 카드 기준이고 보관 카드는 뒤에 남는다', async () => {
    const a = await mk('A');
    const b = await mk('B');
    const c = await mk('C');
    await repo.setArchived([b], true);
    await repo.moveCard(c, cols[0].id, 0);
    expect((await inCol(0)).map((x) => x.title)).toEqual(['C', 'A']);
    expect((await card(b)).archived).toBe(true);
    expect(a).toBeTruthy();
  });
});

describe('카드 복제', () => {
  it('내용·라벨·체크리스트(완료 상태 포함)는 복사하고 댓글·첨부·후속 기록은 복사하지 않는다', async () => {
    const id = await mk('원본');
    await repo.updateCard(id, { description: '설명', assignee: '김', dueDate: '2026-12-01', repeat: 'weekly', labels: ['red'] });
    const ck = (await repo.addCheck(id, '할 것')).snapshot.checks[0];
    await repo.updateCheck(ck.id, { done: true });
    await repo.addComment(id, '댓글');
    files.add('k1');
    await repo.addAttachment(id, { name: 'a.txt', size: 3, mime: 'application/octet-stream', storageKey: 'k1' });
    await mk('다음');
    const out = await repo.duplicateCard(id);
    const copy = out.snapshot.cards.find((c) => c.title === '원본 (복사본)')!;
    expect(copy.id).not.toBe(id);
    expect(copy).toMatchObject({ description: '설명', assignee: '김', dueDate: '2026-12-01', repeat: 'weekly', labels: ['red'], followupId: null, archived: false });
    const copyChecks = out.snapshot.checks.filter((c) => c.cardId === copy.id);
    expect(copyChecks).toHaveLength(1);
    expect(copyChecks[0]).toMatchObject({ text: '할 것', done: true });
    expect(copyChecks[0].id).not.toBe(ck.id);
    expect(out.snapshot.comments.filter((c) => c.cardId === copy.id)).toHaveLength(0);
    expect(out.snapshot.attachments.filter((c) => c.cardId === copy.id)).toHaveLength(0);
    expect((await inCol(0)).map((c) => c.title)).toEqual(['원본', '원본 (복사본)', '다음']);
    expect((await undo(out)).conflict).toBe(false);
    expect((await inCol(0)).map((c) => c.title)).toEqual(['원본', '다음']);
    expect((await repo.snapshot()).checks).toHaveLength(1);
  });
  it('제목이 100자를 넘으면 원래 제목 끝을 자른다', async () => {
    const id = await mk('가'.repeat(100));
    const copy = (await repo.duplicateCard(id)).snapshot.cards.find((c) => c.id !== id)!;
    expect([...copy.title]).toHaveLength(100);
    expect(copy.title.endsWith(' (복사본)')).toBe(true);
  });
});

describe('보드 복제', () => {
  it('열(완료 열 지정 포함)과 보관되지 않은 카드·체크리스트를 새 ID로 복사한다', async () => {
    const a = await mk('A');
    const b = await mk('B', 1);
    await repo.setArchived([b], true);
    await repo.updateCard(a, { labels: ['green'], assignee: '박' });
    await repo.addCheck(a, '항목');
    await repo.addComment(a, '댓글은 복사 안 함');
    const out = await repo.duplicateBoard(board);
    const nb = out.snapshot.boards.find((x) => x.name === '내 첫 보드 (복사본)')!;
    expect(nb).toBeTruthy();
    expect(nb.position).toBeGreaterThan(out.snapshot.boards.find((x) => x.id === board)!.position);
    const ncols = out.snapshot.columns.filter((c) => c.boardId === nb.id).sort((x, y) => x.position - y.position);
    expect(ncols.map((c) => [c.name, c.isDone])).toEqual([['할 일', false], ['진행 중', false], ['완료', true]]);
    const ncards = out.snapshot.cards.filter((c) => ncols.some((n) => n.id === c.columnId));
    expect(ncards.map((c) => c.title)).toEqual(['A']);
    expect(ncards[0]).toMatchObject({ labels: ['green'], assignee: '박' });
    expect(ncards[0].id).not.toBe(a);
    expect(out.snapshot.checks.filter((c) => c.cardId === ncards[0].id)).toHaveLength(1);
    expect(out.snapshot.comments.filter((c) => c.cardId === ncards[0].id)).toHaveLength(0);
    expect((await undo(out)).conflict).toBe(false);
    expect((await repo.snapshot()).boards).toHaveLength(1);
  });
  it('이름이 50자를 넘으면 원래 이름 끝을 자른다', async () => {
    const id = (await repo.createBoard('가'.repeat(50))).snapshot.boards.find((b) => b.name.length === 50)!.id;
    const copy = (await repo.duplicateBoard(id)).snapshot.boards.find((b) => b.name.endsWith('(복사본)'))!;
    expect([...copy.name]).toHaveLength(50);
  });
});

describe('여러 카드 일괄 작업', () => {
  it('열 이동: 열 순서→카드 순서를 유지해 대상 열 맨 아래에 붙이고, 이미 있는 카드는 건너뛴다', async () => {
    const a = await mk('A', 0);
    const b = await mk('B', 0);
    const c = await mk('C', 1);
    const d = await mk('D', 2);
    const out = await repo.bulkMove([d, c, b, a], cols[2].id, TODAY);
    expect((await inCol(2)).map((x) => x.title)).toEqual(['D', 'A', 'B', 'C']);
    expect(await inCol(0)).toHaveLength(0);
    expect(await inCol(1)).toHaveLength(0);
    expect((await undo(out)).conflict).toBe(false);
    expect((await inCol(0)).map((x) => x.title)).toEqual(['A', 'B']);
    expect((await inCol(1)).map((x) => x.title)).toEqual(['C']);
    expect((await inCol(2)).map((x) => x.title)).toEqual(['D']);
  });
  it('일괄 삭제는 한 번의 되돌리기로 모두 복원된다', async () => {
    const a = await mk('A');
    const b = await mk('B');
    await repo.addComment(a, '댓글');
    const out = await repo.bulkDelete([a, b]);
    expect(out.snapshot.cards).toHaveLength(0);
    expect(out.snapshot.comments).toHaveLength(0);
    expect((await undo(out)).conflict).toBe(false);
    expect((await repo.snapshot()).cards).toHaveLength(2);
    expect((await repo.snapshot()).comments).toHaveLength(1);
  });
  it('일괄 보관·복원', async () => {
    const a = await mk('A');
    const b = await mk('B');
    await repo.setArchived([a, b], true);
    expect(await inCol(0)).toHaveLength(0);
    await repo.setArchived([a, b], false);
    expect(await inCol(0)).toHaveLength(2);
  });
  it('다른 보드의 열로는 일괄 이동할 수 없다', async () => {
    const a = await mk('A');
    const other = (await repo.createBoard('다른')).snapshot;
    const oc = other.columns.find((c) => c.boardId !== board)!;
    await expect(repo.bulkMove([a], oc.id, TODAY)).rejects.toThrow();
  });
});

describe('반복 마감', () => {
  const setup = async (repeat: 'daily' | 'weekly' | 'monthly' = 'weekly') => {
    const id = await mk('주간 보고');
    await repo.updateCard(id, { description: '설명', assignee: '김', labels: ['blue'], dueDate: '2026-11-01', repeat });
    const ck = (await repo.addCheck(id, '항목')).snapshot.checks[0];
    await repo.updateCheck(ck.id, { done: true });
    await repo.addComment(id, '복사 안 됨');
    return id;
  };
  const all = async () => (await repo.snapshot()).cards;

  it('완료 열로 옮기면 완료한 날짜 기준으로 첫 미완료 열에 후속 카드가 생긴다', async () => {
    const id = await setup('weekly');
    const out = await repo.moveCard(id, cols[2].id, 0, TODAY);
    const original = await card(id);
    expect(original.columnId).toBe(cols[2].id);
    expect(original.followupId).toBeTruthy();
    const next = (await all()).find((c) => c.id === original.followupId)!;
    expect(next.columnId).toBe(cols[0].id);
    expect(next).toMatchObject({ title: '주간 보고', description: '설명', assignee: '김', labels: ['blue'], repeat: 'weekly', dueDate: '2026-11-10', followupId: null });
    const nChecks = (await repo.snapshot()).checks.filter((c) => c.cardId === next.id);
    expect(nChecks).toHaveLength(1);
    expect(nChecks[0].done).toBe(false); // 체크리스트는 미완료로 초기화
    expect((await repo.snapshot()).comments.filter((c) => c.cardId === next.id)).toHaveLength(0);
    expect(out.entry).toBeTruthy();
  });

  it('마감을 넘겨 늦게 완료해도 기준은 완료한 날짜다', async () => {
    const id = await setup('daily');
    await repo.moveCard(id, cols[2].id, 0, '2026-11-20');
    const followupId = (await card(id)).followupId;
    expect((await all()).find((c) => c.id === followupId)!.dueDate).toBe('2026-11-21');
  });

  it('완료와 후속 카드 생성은 한 번의 되돌리기로 함께 취소되고, 생성 기록도 지워진다', async () => {
    const id = await setup();
    const out = await repo.moveCard(id, cols[2].id, 0, TODAY);
    expect(await all()).toHaveLength(2);
    const r = await undo(out);
    expect(r.conflict).toBe(false);
    expect(await all()).toHaveLength(1);
    expect((await card(id)).columnId).toBe(cols[0].id);
    expect((await card(id)).followupId).toBeNull();
    await repo.moveCard(id, cols[2].id, 0, TODAY); // 다시 완료하면 새로 생성
    expect(await all()).toHaveLength(2);
  });

  it('다시 실행하면 같은 ID의 후속 카드가 복원된다', async () => {
    const h = new History(50);
    const id = await setup();
    const out = await repo.moveCard(id, cols[2].id, 0, TODAY);
    h.push(out.entry as Entry);
    const followupId = (await card(id)).followupId!;
    const e = h.peekUndo()!;
    const u = await repo.applyPatch(e.inverse, e.expect);
    if (u.conflict) throw new Error('conflict');
    h.commitUndo(u.touched);
    const e2 = h.peekRedo()!;
    const r = await repo.applyPatch(e2.forward, e2.expect);
    expect(r.conflict).toBe(false);
    expect((await card(id)).followupId).toBe(followupId);
    expect((await all()).some((c) => c.id === followupId)).toBe(true);
  });

  it('원본을 미완료로 되돌렸다가 다시 완료해도 중복 생성하지 않는다', async () => {
    const id = await setup();
    await repo.moveCard(id, cols[2].id, 0, TODAY);
    await repo.moveCard(id, cols[0].id, 0, TODAY);
    await repo.moveCard(id, cols[2].id, 0, TODAY);
    expect(await all()).toHaveLength(2);
  });

  it('같은 요청이 재시도·중복으로 두 번 와도 후속 카드는 하나만 생긴다', async () => {
    const id = await setup();
    await repo.moveCard(id, cols[2].id, 0, TODAY);
    await repo.moveCard(id, cols[2].id, 0, TODAY); // 재시도
    await repo.bulkMove([id], cols[2].id, TODAY); // 일괄 이동으로 다시 와도 이미 완료 열이라 건너뜀
    expect(await all()).toHaveLength(2);
    // 같은 카드를 미완료에서 두 요청이 연달아 보내도 한 번만
    const id2 = await setup('daily');
    await repo.moveCard(id2, cols[2].id, 0, TODAY);
    await expect(repo.moveCard(id2, cols[2].id, 0, TODAY)).resolves.toBeDefined();
    expect((await all()).filter((c) => c.title === '주간 보고' && c.columnId === cols[0].id && c.id !== id2)).toHaveLength(2); // 두 카드의 후속이 각각 1개씩
  });

  it('후속 카드를 사용자가 지워도 다시 만들지 않는다', async () => {
    const id = await setup();
    await repo.moveCard(id, cols[2].id, 0, TODAY);
    await repo.deleteCard((await card(id)).followupId!);
    await repo.moveCard(id, cols[0].id, 0, TODAY);
    await repo.moveCard(id, cols[2].id, 0, TODAY);
    expect(await all()).toHaveLength(1);
  });

  it('후속 카드가 완료되면 그 카드가 다음 원본이 되어 이어진다', async () => {
    const id = await setup('daily');
    await repo.moveCard(id, cols[2].id, 0, '2026-11-03');
    const second = (await card(id)).followupId!;
    await repo.moveCard(second, cols[2].id, 0, '2026-11-04');
    const third = (await card(second)).followupId!;
    expect((await all()).find((c) => c.id === third)!.dueDate).toBe('2026-11-05');
  });

  it('완료 열끼리 옮기거나 완료 열 지정만 바꾸는 것은 후속 카드를 만들지 않는다', async () => {
    const id = await setup();
    await repo.setColumnDone(cols[1].id, true);
    await repo.moveCard(id, cols[2].id, 0, TODAY); // 미완료 → 완료: 여기서 1번 생성
    const n = (await all()).length;
    expect(n).toBe(2);
    await repo.moveCard(id, cols[1].id, 0, TODAY); // 완료 열 → 완료 열: 생성 없음
    expect(await all()).toHaveLength(n);
    // 반복 카드가 있는 열을 완료 열로 "지정"만 해도 생성되지 않는다
    const keep = (await all()).length;
    const other = await mk('다른 반복', 0);
    await repo.updateCard(other, { dueDate: '2026-11-09', repeat: 'daily' });
    expect(await all()).toHaveLength(keep + 1);
    await repo.setColumnDone(cols[0].id, true);
    expect(await all()).toHaveLength(keep + 1);
    expect((await card(other)).followupId).toBeNull();
  });

  it('완료한 날짜(today)가 없으면 거부한다 (서버 시계를 쓰지 않음)', async () => {
    const id = await setup();
    await expect(repo.moveCard(id, cols[2].id, 0)).rejects.toThrow(/날짜/);
    expect((await card(id)).columnId).toBe(cols[0].id);
  });

  it('첫 번째 미완료 열이 없으면 완료 이동과 반복 설정을 막는다', async () => {
    const id = await setup();
    await repo.moveCard(id, cols[1].id, 0, TODAY);
    await repo.setColumnDone(cols[0].id, true);
    await repo.setColumnDone(cols[1].id, false);
    // 미완료 열은 '진행 중'뿐. 반복 카드가 거기서 완료 열로 갈 때, '진행 중'이 첫 미완료 열이므로 생성은 가능하다.
    // 미완료 열이 없어지면 막힌다: 진행 중도 완료 열로 지정
    await repo.setColumnDone(cols[1].id, true);
    const id3 = await mk('다른 반복', 1);
    expect((await card(id3)).columnId).toBe(cols[1].id);
    await expect(repo.updateCard(id3, { dueDate: '2026-11-09', repeat: 'daily' })).rejects.toThrow(/미완료/);
  });

  it('일괄 이동에서 하나라도 후속 카드를 못 만들면 전체가 취소된다', async () => {
    const a = await setup();
    const b = await mk('일반');
    const before = JSON.stringify((await repo.snapshot()).cards.map((c) => [c.id, c.columnId, c.position]));
    // today 없이 반복 카드를 포함해 일괄 이동 → 거부, 아무것도 안 바뀜
    await expect(repo.bulkMove([a, b], cols[2].id)).rejects.toThrow();
    expect(JSON.stringify((await repo.snapshot()).cards.map((c) => [c.id, c.columnId, c.position]))).toBe(before);
  });

  it('일괄 이동으로 완료 열에 보내면 반복 카드 생성도 한 번의 작업으로 묶인다', async () => {
    const a = await setup('daily');
    const b = await mk('일반');
    const out = await repo.bulkMove([a, b], cols[2].id, TODAY);
    expect((await card(a)).followupId).toBeTruthy();
    expect(await all()).toHaveLength(3);
    expect((await undo(out)).conflict).toBe(false);
    expect(await all()).toHaveLength(2);
    expect((await card(a)).followupId).toBeNull();
  });
});

describe('중간에 실패해도 일부만 저장되지 않는다 (일부러 실패시켜 확인)', () => {
  const snap = async () => JSON.stringify({ ...repo.snapshot() });
  it('일괄 이동: 두 번째 후속 카드를 만드는 도중 오류가 나면 전체가 원래대로 돌아간다', async () => {
    const a = await mk('A');
    const b = await mk('B');
    for (const id of [a, b]) await repo.updateCard(id, { dueDate: '2026-11-05', repeat: 'daily' });
    const before = await snap();
    let calls = 0;
    const real = (repo as any).execFollowup.bind(repo);
    (repo as any).execFollowup = async (p: unknown) => {
      if (++calls === 2) throw new Error('일부러 낸 오류');
      return real(p);
    };
    await expect(repo.bulkMove([a, b], cols[2].id, TODAY)).rejects.toThrow('일부러 낸 오류');
    (repo as any).execFollowup = real;
    expect(await snap()).toBe(before); // 카드 위치·후속 카드·번호 모두 그대로
  });
  it('열 삭제·보드 삭제·복제: 도중 오류가 나면 아무것도 바뀌지 않는다', async () => {
    await mk('A');
    await repo.addComment((await repo.snapshot()).cards[0].id, '댓글');
    const before = await snap();
    const real = (repo as any).removeCardsSql.bind(repo);
    (repo as any).removeCardsSql = async (ids: string[]) => {
      await real(ids);
      throw new Error('삭제 도중 오류');
    };
    await expect(repo.deleteBoard(board)).rejects.toThrow('삭제 도중 오류');
    await expect(repo.deleteColumn(cols[0].id)).rejects.toThrow('삭제 도중 오류');
    (repo as any).removeCardsSql = real;
    expect(await snap()).toBe(before);
    const realInsert = (repo as any).insertCardRow.bind(repo);
    (repo as any).insertCardRow = async () => {
      throw new Error('복제 도중 오류');
    };
    await expect(repo.duplicateBoard(board)).rejects.toThrow('복제 도중 오류');
    await expect(repo.duplicateCard((await repo.snapshot()).cards[0].id)).rejects.toThrow('복제 도중 오류');
    (repo as any).insertCardRow = realInsert;
    expect(await snap()).toBe(before);
  });
  it('되돌리기 적용 도중 오류가 나도 일부만 적용되지 않는다', async () => {
    const id = await mk('A');
    await repo.addCheck(id, '항목');
    const del = await repo.deleteCard(id);
    const before = await snap();
    const real = (repo as any).writeRow.bind(repo);
    let n = 0;
    (repo as any).writeRow = async (k: any, row: any) => {
      if (++n === 2) throw new Error('복원 도중 오류');
      return real(k, row);
    };
    await expect(repo.applyPatch(del.entry!.inverse, del.entry!.expect)).rejects.toThrow('복원 도중 오류');
    (repo as any).writeRow = real;
    expect(await snap()).toBe(before);
    expect((await repo.applyPatch(del.entry!.inverse, del.entry!.expect)).conflict).toBe(false); // 이후 정상 복원 가능
  });
});

describe('첨부 파일', () => {
  const att = async (cardId: string, key: string, name = 'a.txt') => {
    files.add(key);
    return await repo.addAttachment(cardId, { name, size: 10, mime: 'application/octet-stream', storageKey: key });
  };
  it('카드당 5개까지', async () => {
    const id = await mk('a');
    for (let i = 0; i < 5; i++) await att(id, 'k' + i);
    await expect(att(id, 'k5')).rejects.toThrow(/5개/);
    expect((await repo.snapshot()).attachments).toHaveLength(5);
  });
  it('삭제는 삭제 표시만 하고 파일은 남으며, 되돌리면 복원된다', async () => {
    const id = await mk('a');
    await att(id, 'k1');
    const aid = (await repo.snapshot()).attachments[0].id;
    const del = await repo.deleteAttachment(aid);
    expect((await repo.snapshot()).attachments).toHaveLength(0);
    expect((await repo.referencedStorageKeys()).has('k1')).toBe(true);
    expect((await undo(del)).conflict).toBe(false);
    expect((await repo.snapshot()).attachments[0].id).toBe(aid);
  });
  it('보관 기간이 지나 파일이 정리됐으면 복원하지 않고 파일 문제로 건너뛴다', async () => {
    const id = await mk('a');
    await att(id, 'k1');
    const del = await repo.deleteAttachment((await repo.snapshot()).attachments[0].id);
    now += 8 * DAY;
    const keys = await repo.purgeExpiredAttachments();
    expect(keys).toEqual(['k1']);
    files.delete('k1');
    const r = await undo(del);
    expect(r.conflict).toBe(true);
    if (r.conflict) expect(r.reason).toBe('file');
    expect((await repo.snapshot()).attachments).toHaveLength(0);
  });
  it('7일 안에는 정리하지 않는다', async () => {
    const id = await mk('a');
    await att(id, 'k1');
    await repo.deleteAttachment((await repo.snapshot()).attachments[0].id);
    now += 6 * DAY;
    expect(await repo.purgeExpiredAttachments()).toEqual([]);
  });
  it('첨부가 달린 카드·열·보드를 지워도 파일은 남고, 삭제를 되돌리면 첨부도 돌아온다', async () => {
    const id = await mk('a');
    await att(id, 'k1');
    const delCard = await repo.deleteCard(id);
    expect((await repo.snapshot()).attachments).toHaveLength(0);
    expect((await repo.referencedStorageKeys()).has('k1')).toBe(true);
    expect((await undo(delCard)).conflict).toBe(false);
    expect((await repo.snapshot()).attachments).toHaveLength(1);
    const delCol = await repo.deleteColumn(cols[0].id);
    expect((await repo.snapshot()).attachments).toHaveLength(0);
    expect((await undo(delCol)).conflict).toBe(false);
    expect((await repo.snapshot()).attachments).toHaveLength(1);
    const delBoard = await repo.deleteBoard(board);
    expect((await repo.snapshot()).attachments).toHaveLength(0);
    expect((await undo(delBoard)).conflict).toBe(false);
    expect((await repo.snapshot()).attachments).toHaveLength(1);
  });
  it('보관함 카드의 첨부는 삭제된 것이 아니므로 정리 대상이 아니다', async () => {
    const id = await mk('a');
    await att(id, 'k1');
    await repo.setArchived([id], true);
    now += 30 * DAY;
    expect(await repo.purgeExpiredAttachments()).toEqual([]);
    expect((await repo.snapshot()).attachments).toHaveLength(1);
  });
  it('시작 시 정리: 기간 지난 파일과 DB가 모르는 고아 파일을 지운다', async () => {
    const id = await mk('a');
    await att(id, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    await att(id, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    await repo.deleteAttachment((await repo.snapshot()).attachments.find((a) => a.storageKey === 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')!.id);
    files.add('cccccccc-cccc-cccc-cccc-cccccccccccc');
    const storage: StorageAdapter = {
      async put() {},
      async read() { return Buffer.alloc(0); },
      async remove(k) { files.delete(k); },
      exists: (k) => files.has(k),
      list: () => [...files],
    };
    now += 8 * DAY;
    const removed = await cleanupStorage(repo, storage);
    expect(removed.sort()).toEqual(['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cccccccc-cccc-cccc-cccc-cccccccccccc']);
    expect([...files].sort()).toEqual(['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']);
  });
});

describe('알림 닫기 기록', () => {
  it('같은 알림은 한 번만 기록하고, 카드를 지우면 기록은 시작 때 정리된다', async () => {
    const id = await mk('a');
    await repo.updateCard(id, { dueDate: '2026-11-03' });
    const r0 = (await repo.snapshot()).revision;
    await repo.dismiss(id, 'today', '2026-11-03');
    await repo.dismiss(id, 'today', '2026-11-03');
    expect((await repo.snapshot()).dismissals).toEqual([{ cardId: id, kind: 'today', dueDate: '2026-11-03' }]);
    expect((await repo.snapshot()).revision).toBe(r0 + 1);
    await repo.deleteCard(id);
    // 되돌리기로 카드가 돌아와도 닫은 알림이 되살아나지 않게, 기록은 바로 지우지 않고 앱 시작 때 정리한다
    expect((await repo.snapshot()).dismissals).toHaveLength(1);
    expect(await repo.purgeOrphanDismissals()).toBe(1);
    expect((await repo.snapshot()).dismissals).toHaveLength(0);
  });
});

describe('변경 이어받기 (동기화)', () => {
  it('마지막으로 받은 번호 이후의 수정·삭제를 돌려준다', async () => {
    const a = await mk('A');
    const b = await mk('B');
    const since = (await repo.snapshot()).revision;
    await repo.updateCard(a, { title: 'A2' });
    await repo.deleteCard(b);
    const ch = await repo.changesSince(since);
    expect(ch.full).toBeUndefined();
    expect(ch.revision).toBe((await repo.snapshot()).revision);
    expect(ch.upsert.some((u) => u.kind === 'card' && (u.row as any).title === 'A2')).toBe(true);
    expect(ch.remove).toContainEqual({ kind: 'card', id: b });
  });
  it('이미 최신이면 빈 묶음', async () => {
    const ch = await repo.changesSince((await repo.snapshot()).revision);
    expect(ch.upsert).toHaveLength(0);
    expect(ch.remove).toHaveLength(0);
  });
  it('삭제된 첨부와 닫은 알림도 전달한다', async () => {
    const id = await mk('a');
    await repo.updateCard(id, { dueDate: '2026-11-03' });
    files.add('k');
    await repo.addAttachment(id, { name: 'a.txt', size: 1, mime: 'x', storageKey: 'k' });
    const since = (await repo.snapshot()).revision;
    await repo.deleteAttachment((await repo.snapshot()).attachments[0].id);
    await repo.dismiss(id, 'today', '2026-11-03');
    const ch = await repo.changesSince(since);
    expect(ch.remove.some((r) => r.kind === 'attachment')).toBe(true);
    expect(ch.upsert.some((u) => u.kind === 'dismissal')).toBe(true);
  });
  it('변경 기록이 정리돼 이어받을 수 없으면 전체 데이터를 돌려준다', async () => {
    const small = await newRepo({ changeLogLimit: 5 });
    await small.ensureFirstBoard();
    const col = (await small.snapshot()).columns[0].id;
    for (let i = 0; i < 12; i++) await small.addCard(col, 'c' + i);
    const rev = (await small.snapshot()).revision;
    expect((await small.changesSince(1)).full?.revision).toBe(rev);
    expect((await small.changesSince(rev - 2)).full).toBeUndefined();
  });
  it('변경이 일어날 때마다 알려준다 (실시간 연결용)', async () => {
    const seen: number[] = [];
    const r = await newRepo({ onCommit: (rev) => seen.push(rev) });
    await r.ensureFirstBoard();
    const col = (await r.snapshot()).columns[0].id;
    await r.addCard(col, 'x');
    expect(seen).toEqual([1, 2]);
  });
});
