import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteBoardRepository } from '../lib/repository';
import { History } from '../lib/history';
import type { Entry } from '../lib/types';

let repo: SqliteBoardRepository;
let history: History;
beforeEach(() => {
  repo = new SqliteBoardRepository(':memory:');
  history = new History(50);
  repo.ensureFirstBoard();
});

function record(entry: Entry | null) {
  if (entry) history.push(entry);
}
function undo() {
  const e = history.peekUndo()!;
  const r = repo.applyPatch(e.inverse, e.expect);
  if (r.conflict) {
    history.dropUndo();
    return 'conflict';
  }
  history.commitUndo(r.touched);
  return 'ok';
}
function redo() {
  const e = history.peekRedo()!;
  const r = repo.applyPatch(e.forward, e.expect);
  if (r.conflict) {
    history.dropRedo();
    return 'conflict';
  }
  history.commitRedo(r.touched);
  return 'ok';
}

describe('되돌리기 이력', () => {
  it('같은 카드를 여러 번 수정한 뒤 연속으로 되돌려도 충돌로 오인하지 않는다', () => {
    const col = repo.snapshot().columns[0];
    record(repo.addCard(col.id, 'v0').entry);
    const id = repo.snapshot().cards[0].id;
    record(repo.updateCard(id, { title: 'v1' }).entry);
    record(repo.updateCard(id, { title: 'v2' }).entry);
    record(repo.updateCard(id, { title: 'v3' }).entry);

    expect(undo()).toBe('ok');
    expect(repo.snapshot().cards[0].title).toBe('v2');
    expect(undo()).toBe('ok');
    expect(repo.snapshot().cards[0].title).toBe('v1');
    expect(undo()).toBe('ok');
    expect(repo.snapshot().cards[0].title).toBe('v0');
    expect(undo()).toBe('ok'); // 카드 생성 취소
    expect(repo.snapshot().cards).toHaveLength(0);

    // 다시 실행도 끝까지 이어진다
    expect(redo()).toBe('ok');
    expect(redo()).toBe('ok');
    expect(redo()).toBe('ok');
    expect(redo()).toBe('ok');
    expect(repo.snapshot().cards[0].title).toBe('v3');
    expect(repo.snapshot().cards[0].id).toBe(id);
  });

  it('다른 탭이 바꾼 항목은 건너뛰고 덮어쓰지 않는다', () => {
    const col = repo.snapshot().columns[0];
    record(repo.addCard(col.id, 'v0').entry);
    const id = repo.snapshot().cards[0].id;
    record(repo.updateCard(id, { title: 'mine' }).entry);
    repo.updateCard(id, { title: 'other-tab' }); // 이력에 안 남는 외부 변경
    expect(undo()).toBe('conflict');
    expect(repo.snapshot().cards[0].title).toBe('other-tab');
  });

  it('새 작업을 하면 다시 실행 이력이 지워진다', () => {
    const col = repo.snapshot().columns[0];
    record(repo.addCard(col.id, 'a').entry);
    undo();
    expect(history.canRedo()).toBe(true);
    record(repo.addCard(col.id, 'b').entry);
    expect(history.canRedo()).toBe(false);
  });

  it('최대 50단계까지만 기억한다', () => {
    const col = repo.snapshot().columns[0];
    for (let i = 0; i < 60; i++) record(repo.addCard(col.id, `c${i}`).entry);
    let n = 0;
    while (history.canUndo()) {
      undo();
      n++;
    }
    expect(n).toBe(50);
  });
});
