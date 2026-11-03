import { describe, it, expect, beforeEach } from 'vitest';
import type { PgBoardRepository } from '../lib/repository';
import { newRepo } from './helpers';
import { History } from '../lib/history';
import type { Entry } from '../lib/types';

let repo: PgBoardRepository;
let history: History;
beforeEach(async () => {
  repo = await newRepo();
  history = new History(50);
  await repo.ensureFirstBoard();
});

function record(entry: Entry | null) {
  if (entry) history.push(entry);
}
async function undo() {
  const e = history.peekUndo()!;
  const r = await repo.applyPatch(e.inverse, e.expect);
  if (r.conflict) {
    history.dropUndo();
    return 'conflict';
  }
  history.commitUndo(r.touched);
  return 'ok';
}
async function redo() {
  const e = history.peekRedo()!;
  const r = await repo.applyPatch(e.forward, e.expect);
  if (r.conflict) {
    history.dropRedo();
    return 'conflict';
  }
  history.commitRedo(r.touched);
  return 'ok';
}

describe('되돌리기 이력', () => {
  it('같은 카드를 여러 번 수정한 뒤 연속으로 되돌려도 충돌로 오인하지 않는다', async () => {
    const col = (await repo.snapshot()).columns[0];
    record((await repo.addCard(col.id, 'v0')).entry);
    const id = (await repo.snapshot()).cards[0].id;
    record((await repo.updateCard(id, { title: 'v1' })).entry);
    record((await repo.updateCard(id, { title: 'v2' })).entry);
    record((await repo.updateCard(id, { title: 'v3' })).entry);

    expect(await undo()).toBe('ok');
    expect((await repo.snapshot()).cards[0].title).toBe('v2');
    expect(await undo()).toBe('ok');
    expect((await repo.snapshot()).cards[0].title).toBe('v1');
    expect(await undo()).toBe('ok');
    expect((await repo.snapshot()).cards[0].title).toBe('v0');
    expect(await undo()).toBe('ok'); // 카드 생성 취소
    expect((await repo.snapshot()).cards).toHaveLength(0);

    // 다시 실행도 끝까지 이어진다
    expect(await redo()).toBe('ok');
    expect(await redo()).toBe('ok');
    expect(await redo()).toBe('ok');
    expect(await redo()).toBe('ok');
    expect((await repo.snapshot()).cards[0].title).toBe('v3');
    expect((await repo.snapshot()).cards[0].id).toBe(id);
  });

  it('다른 탭이 바꾼 항목은 건너뛰고 덮어쓰지 않는다', async () => {
    const col = (await repo.snapshot()).columns[0];
    record((await repo.addCard(col.id, 'v0')).entry);
    const id = (await repo.snapshot()).cards[0].id;
    record((await repo.updateCard(id, { title: 'mine' })).entry);
    await repo.updateCard(id, { title: 'other-tab' }); // 이력에 안 남는 외부 변경
    expect(await undo()).toBe('conflict');
    expect((await repo.snapshot()).cards[0].title).toBe('other-tab');
  });

  it('새 작업을 하면 다시 실행 이력이 지워진다', async () => {
    const col = (await repo.snapshot()).columns[0];
    record((await repo.addCard(col.id, 'a')).entry);
    await undo();
    expect(history.canRedo()).toBe(true);
    record((await repo.addCard(col.id, 'b')).entry);
    expect(history.canRedo()).toBe(false);
  });

  it('최대 50단계까지만 기억한다', async () => {
    const col = (await repo.snapshot()).columns[0];
    for (let i = 0; i < 60; i++) record((await repo.addCard(col.id, `c${i}`)).entry);
    let n = 0;
    while (history.canUndo()) {
      await undo();
      n++;
    }
    expect(n).toBe(50);
  });
});
