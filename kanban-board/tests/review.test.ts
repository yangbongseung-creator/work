import { describe, it, expect, beforeEach } from 'vitest';
import type { PgBoardRepository } from '../lib/repository';
import { newRepo } from './helpers';
import { cleanupStorage, type StorageAdapter } from '../lib/storage';
import { extOf, inlineMime, normalizeUploadName, validateUpload } from '../lib/upload';
import { AppError, type Outcome } from '../lib/types';

let repo: PgBoardRepository;
let files: Set<string>;
let cols: { id: string }[];
let board: string;
beforeEach(async () => {
  files = new Set();
  repo = await newRepo({ fileExists: (k) => files.has(k) });
  await repo.ensureFirstBoard();
  const s = await repo.snapshot();
  board = s.boards[0].id;
  cols = s.columns.filter((c) => c.boardId === board);
});
const mk = async (t: string, i = 0) => {
  const b = new Set((await repo.snapshot()).cards.map((c) => c.id));
  return (await repo.addCard(cols[i].id, t)).snapshot.cards.find((c) => !b.has(c.id))!.id;
};
const undo = async (o: Outcome) => await repo.applyPatch(o.entry!.inverse, o.entry!.expect);
const redo = async (o: Outcome) => await repo.applyPatch(o.entry!.forward, o.entry!.expect);

describe('독립 검토 1: 다른 탭이 부모를 먼저 지웠다면 되돌리기가 고아 데이터를 만들면 안 된다', () => {
  it('댓글 삭제를 되돌리려는데 카드가 이미 지워졌다 → 건너뜀', async () => {
    const card = await mk('A');
    const cm = (await repo.addComment(card, '댓글')).snapshot.comments[0].id;
    const del = await repo.deleteComment(cm);
    await repo.deleteCard(card); // 다른 탭
    expect((await undo(del)).conflict).toBe(true);
    expect((await repo.snapshot()).comments).toHaveLength(0);
  });
  it('카드 삭제를 되돌리려는데 열이 이미 지워졌다 → 건너뜀', async () => {
    const card = await mk('A');
    const del = await repo.deleteCard(card);
    await repo.deleteColumn(cols[0].id); // 다른 탭
    expect((await undo(del)).conflict).toBe(true);
    expect((await repo.snapshot()).cards).toHaveLength(0);
  });
  it('체크리스트·첨부 삭제를 되돌리려는데 카드가 이미 없다 → 건너뜀', async () => {
    const card = await mk('A');
    const ck = (await repo.addCheck(card, '항목')).snapshot.checks[0].id;
    files.add('k');
    const at = (await repo.addAttachment(card, { name: 'a.txt', size: 1, mime: 'x', storageKey: 'k' })).snapshot.attachments[0].id;
    const d1 = await repo.deleteCheck(ck);
    const d2 = await repo.deleteAttachment(at);
    await repo.deleteCard(card);
    expect((await undo(d1)).conflict).toBe(true);
    expect((await undo(d2)).conflict).toBe(true);
    const s = await repo.snapshot();
    expect(s.checks).toHaveLength(0);
    expect(s.attachments).toHaveLength(0);
  });
  it('열 삭제를 되돌리려는데 보드가 이미 지워졌다 → 건너뜀', async () => {
    const del = await repo.deleteColumn(cols[0].id);
    await repo.deleteBoard(board);
    expect((await undo(del)).conflict).toBe(true);
    expect((await repo.snapshot()).columns).toHaveLength(0);
  });
  it('(같은 종류) 카드 생성을 되돌리려는데 다른 탭이 그 카드에 댓글을 달았다 → 댓글만 남기지 않고 건너뜀', async () => {
    const out = await repo.addCard(cols[0].id, '새 카드');
    const id = out.snapshot.cards[0].id;
    await repo.addComment(id, '다른 탭의 댓글');
    expect((await undo(out)).conflict).toBe(true);
    expect((await repo.snapshot()).cards).toHaveLength(1);
    expect((await repo.snapshot()).comments).toHaveLength(1);
  });
  it('(같은 종류) 열 생성·보드 생성을 되돌리려는데 안에 다른 탭이 만든 카드가 있다 → 건너뜀', async () => {
    const colOut = await repo.addColumn(board, '새 열');
    const newCol = colOut.snapshot.columns.find((c) => c.name === '새 열')!.id;
    await repo.addCard(newCol, '남의 카드');
    expect((await undo(colOut)).conflict).toBe(true);
    const bOut = await repo.createBoard('새 보드');
    const nb = bOut.snapshot.boards.find((b) => b.name === '새 보드')!;
    const nc = bOut.snapshot.columns.find((c) => c.boardId === nb.id)!.id;
    await repo.addCard(nc, '남의 카드2');
    expect((await undo(bOut)).conflict).toBe(true);
    const s = await repo.snapshot();
    expect(s.cards.every((c) => s.columns.some((x) => x.id === c.columnId))).toBe(true);
  });
  it('정상 흐름(부모가 그대로)에서는 여전히 되돌려진다', async () => {
    const card = await mk('A');
    const cm = (await repo.addComment(card, '댓글')).snapshot.comments[0].id;
    expect((await undo(await repo.deleteComment(cm))).conflict).toBe(false);
    expect((await repo.snapshot()).comments).toHaveLength(1);
    const out = await repo.addCard(cols[0].id, 'B');
    expect((await undo(out)).conflict).toBe(false);
    expect((await redo(out)).conflict).toBe(true); // 번호가 바뀌어 건너뜀(이력 갱신 없이 직접 호출했으므로)
  });
});

describe('독립 검토 2: 카드를 지웠다 되돌려도 닫아 둔 알림은 되살아나지 않는다', () => {
  it('삭제 → 되돌리기 후에도 닫은 기록이 남아 있다', async () => {
    const id = await mk('A');
    await repo.updateCard(id, { dueDate: '2026-11-03' });
    await repo.dismiss(id, 'today', '2026-11-03');
    const del = await repo.deleteCard(id);
    expect((await undo(del)).conflict).toBe(false);
    expect((await repo.snapshot()).dismissals).toHaveLength(1);
  });
  it('실제로 사라진 카드의 기록은 앱 시작 시 정리된다', async () => {
    const id = await mk('A');
    await repo.updateCard(id, { dueDate: '2026-11-03' });
    await repo.dismiss(id, 'today', '2026-11-03');
    await repo.deleteCard(id);
    expect(await repo.purgeOrphanDismissals()).toBe(1);
    expect((await repo.snapshot()).dismissals).toHaveLength(0);
  });
});

describe('독립 검토 3: 긴 파일명으로 확장자 검사를 피할 수 없다', () => {
  it('저장될 이름(200자 제한)을 기준으로 검사하므로, 잘린 뒤의 확장자와 검사한 확장자가 항상 같다', async () => {
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    const evil = 'A'.repeat(196) + '.pdf.txt'; // 예전에는 200자로 잘리며 끝이 ".pdf"가 되어 PDF처럼 내려갔다
    const stored = normalizeUploadName(evil);
    expect([...stored].length).toBeLessThanOrEqual(200);
    expect(extOf(stored)).toBe('txt'); // 확장자는 보존된다
    expect(inlineMime(extOf(stored))).toBeNull(); // 화면에서 바로 열리는 종류가 아니다
    expect(validateUpload(stored, html).mime).toBe('application/octet-stream');
    // 확장자 없이 아주 긴 이름도 안전하게 자른다
    expect([...normalizeUploadName('B'.repeat(500))]).toHaveLength(200);
    // 이모지 같은 문자를 반으로 쪼개지 않는다
    expect(encodeURIComponent(normalizeUploadName('😀'.repeat(300) + '.png'))).toBeTruthy();
  });
});

describe('독립 검토 4: 이상한 되돌리기 요청은 500이 아니라 정상 거부(AppError)', () => {
  const bad: [string, any, any][] = [
    ['row가 null', { upsert: [{ kind: 'card', row: null }], remove: [] }, []],
    ['kind가 __proto__', { upsert: [{ kind: '__proto__', row: { id: 'x' } }], remove: [] }, []],
    ['kind가 없는 종류', { upsert: [{ kind: 'dismissal', row: { id: 'x' } }], remove: [] }, []],
    ['remove의 id가 숫자', { upsert: [], remove: [{ kind: 'card', id: 5 }] }, []],
    ['expect 키에 콜론 없음', { upsert: [], remove: [] }, [{ key: 'nocolon', rev: 1 }]],
    ['expect 키 종류가 이상함', { upsert: [], remove: [] }, [{ key: 'xxx:1', rev: 1 }]],
    ['expect rev가 문자열', { upsert: [], remove: [] }, [{ key: 'card:1', rev: 'a' }]],
    ['카드 제목이 너무 김', { upsert: [{ kind: 'card', row: { id: 'k', columnId: 'c', title: 'a'.repeat(101), description: '', assignee: '', dueDate: null, repeat: 'none', labels: [], archived: false, position: 0, followupId: null, rev: 1 } }], remove: [] }, []],
    ['라벨 색이 이상함', { upsert: [{ kind: 'card', row: { id: 'k', columnId: 'c', title: 't', description: '', assignee: '', dueDate: null, repeat: 'none', labels: ['pink'], archived: false, position: 0, followupId: null, rev: 1 } }], remove: [] }, []],
    ['날짜가 이상함', { upsert: [{ kind: 'card', row: { id: 'k', columnId: 'c', title: 't', description: '', assignee: '', dueDate: '2026-13-45', repeat: 'none', labels: [], archived: false, position: 0, followupId: null, rev: 1 } }], remove: [] }, []],
    ['마감일 없는 반복', { upsert: [{ kind: 'card', row: { id: 'k', columnId: 'c', title: 't', description: '', assignee: '', dueDate: null, repeat: 'daily', labels: [], archived: false, position: 0, followupId: null, rev: 1 } }], remove: [] }, []],
    ['첨부 저장 키가 경로 이동', { upsert: [{ kind: 'attachment', row: { id: 'a', cardId: 'c', name: 'x', size: 1, mime: 'x', storageKey: '../../etc/passwd', rev: 1 } }], remove: [] }, []],
    ['upsert가 배열 아님', { upsert: 'x', remove: [] }, []],
    ['patch 자체가 null', null, []],
    ['항목이 너무 많음', { upsert: [], remove: Array.from({ length: 30000 }, (_, i) => ({ kind: 'card', id: 'i' + i })) }, []],
  ];
  for (const [name, patch, expectList] of bad) {
    it(name, async () => {
      const before = JSON.stringify(await repo.snapshot());
      let err: unknown;
      try {
        await repo.applyPatch(patch, expectList);
      } catch (e) {
        err = e;
      }
      expect(err, '거부되어야 함').toBeInstanceOf(AppError);
      expect(JSON.stringify(await repo.snapshot())).toBe(before);
    });
  }
  it('올바른 모양의 되돌리기 요청은 그대로 통과한다 (과하게 막지 않는다)', async () => {
    const del = await repo.deleteCard(await mk('A'));
    // 서버를 거치듯 JSON으로 한 번 오간 모양
    const wire = JSON.parse(JSON.stringify({ patch: del.entry!.inverse, expect: del.entry!.expect }));
    expect((await repo.applyPatch(wire.patch, wire.expect)).conflict).toBe(false);
  });
});

describe('독립 검토 5: 담당자 이름 자르기·일괄 작업 크기 제한', () => {
  it('담당자를 50자로 줄일 때 이모지 같은 문자를 반으로 쪼개지 않는다', async () => {
    const id = await mk('A');
    await repo.updateCard(id, { assignee: '😀'.repeat(60) });
    const a = (await repo.snapshot()).cards[0].assignee;
    expect([...a]).toHaveLength(50);
    expect(a).toBe('😀'.repeat(50));
    expect(encodeURIComponent(a)).toBeTruthy(); // 짝 잃은 문자가 있으면 여기서 오류
  });
  it('한 번에 너무 많은 카드를 처리하라는 요청은 정상 거부한다', async () => {
    const big = Array.from({ length: 6000 }, (_, i) => 'id' + i);
    for (const f of [() => repo.bulkDelete(big), () => repo.bulkMove(big, cols[0].id, '2026-11-03'), () => repo.setArchived(big, true)]) {
      await expect(f()).rejects.toBeInstanceOf(AppError);
    }
  });
});

describe('독립 검토 6: 시작 정리가 방금 올라온 파일을 고아로 오해해 지우지 않는다', () => {
  it('최근에 만들어진 파일은 DB에 아직 없어도 지우지 않는다', async () => {
    const age: Record<string, number> = { young: 5_000, old: 3_600_000 };
    const present = new Set(['young', 'old']);
    const storage: StorageAdapter & { ageMs: (k: string) => number } = {
      async put() {},
      async read() { return Buffer.alloc(0); },
      async remove(k) { present.delete(k); },
      exists: (k) => present.has(k),
      list: () => [...present],
      ageMs: (k) => age[k],
    };
    const removed = await cleanupStorage(repo, storage);
    expect(removed).toEqual(['old']);
    expect([...present]).toEqual(['young']);
  });
});

describe('퍼징이 찾은 문제: 다른 탭이 끼어들어도 되돌린 뒤 위치 번호가 겹치지 않는다', () => {
  const dupInColumn = async (colId: string) => {
    const pos = (await repo.snapshot()).cards.filter((c) => c.columnId === colId).map((c) => c.position);
    return new Set(pos).size !== pos.length;
  };
  it('카드 이동을 되돌릴 때, 그 사이 다른 탭이 같은 열에 카드를 만들었다', async () => {
    const x = await mk('X');
    await mk('Z');
    const move = await repo.moveCard(x, cols[1].id, 0, '2026-11-03'); // X를 옆 열로 (Z는 0번으로 당겨짐)
    await repo.addCard(cols[0].id, 'Y'); // 다른 탭
    expect((await undo(move)).conflict).toBe(false);
    expect(await dupInColumn(cols[0].id)).toBe(false);
    // 순서는 X, Z, Y 이거나 적어도 X가 Z보다 앞 (원래 순서 유지)
    const order = (await repo.snapshot()).cards.filter((c) => c.columnId === cols[0].id).sort((a, b) => a.position - b.position).map((c) => c.title);
    expect(order.indexOf('X')).toBeLessThan(order.indexOf('Z'));
    expect(order).toHaveLength(3);
  });
  it('열 삭제를 되돌릴 때, 그 사이 다른 탭이 같은 보드에 열을 만들었다', async () => {
    const del = await repo.deleteColumn(cols[0].id);
    await repo.addColumn(board, '새 열'); // 다른 탭
    await repo.moveColumn(cols[2].id, -1);
    expect((await undo(del)).conflict).toBe(false);
    const pos = (await repo.snapshot()).columns.filter((c) => c.boardId === board).map((c) => c.position);
    expect(new Set(pos).size).toBe(pos.length);
  });
  it('보드 삭제를 되돌릴 때 보드 위치 번호도 겹치지 않는다', async () => {
    const b2 = (await repo.createBoard('둘째')).snapshot.boards.find((b) => b.name === '둘째')!.id;
    const del = await repo.deleteBoard(b2);
    await repo.createBoard('셋째'); // 다른 탭: 같은 번호를 쓰게 됨
    expect((await undo(del)).conflict).toBe(false);
    const pos = (await repo.snapshot()).boards.map((b) => b.position);
    expect(new Set(pos).size).toBe(pos.length);
  });
  it('정상 흐름에서는 되돌리기가 위치 번호를 그대로 복원한다 (불필요하게 다시 매기지 않는다)', async () => {
    const a = await mk('A');
    await mk('B');
    await mk('C');
    const before = JSON.stringify((await repo.snapshot()).cards.map((c) => [c.id, c.columnId, c.position]));
    const move = await repo.moveCard(a, cols[1].id, 0, '2026-11-03');
    expect((await undo(move)).conflict).toBe(false);
    expect(JSON.stringify((await repo.snapshot()).cards.map((c) => [c.id, c.columnId, c.position]))).toBe(before);
  });
});
