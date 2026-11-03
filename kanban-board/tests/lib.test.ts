import { describe, it, expect } from 'vitest';
import { nextDueDate, addDays, isYmd } from '../lib/dates';
import { matchCard, groupByDue, hasFilters } from '../lib/filter';
import { computeNotices } from '../lib/notices';
import { validateUpload, safeDownloadName, contentDisposition, inlineMime } from '../lib/upload';
import { applyChanges } from '../lib/sync';
import { copyName } from '../lib/types';
import type { Card, Column, Snapshot } from '../lib/types';

const card = (o: Partial<Card> = {}): Card => ({
  id: 'c' + Math.random(), columnId: 'col1', title: '제목', description: '', assignee: '', dueDate: null,
  repeat: 'none', labels: [], archived: false, position: 0, followupId: null, rev: 1, ...o,
});
const col = (o: Partial<Column> = {}): Column => ({ id: 'col1', boardId: 'b1', name: '열', position: 0, isDone: false, rev: 1, ...o });

describe('반복 마감 날짜 계산', () => {
  it('매일·매주', () => {
    expect(nextDueDate('2026-11-03', 'daily')).toBe('2026-11-04');
    expect(nextDueDate('2026-11-03', 'weekly')).toBe('2026-11-10');
  });
  it('월말·연말을 넘긴다', () => {
    expect(nextDueDate('2026-12-31', 'daily')).toBe('2027-01-01');
    expect(nextDueDate('2026-12-28', 'weekly')).toBe('2027-01-04');
  });
  it('매월: 다음 달 같은 날, 없으면 그 달 마지막 날', () => {
    expect(nextDueDate('2026-11-15', 'monthly')).toBe('2026-12-15');
    expect(nextDueDate('2026-12-15', 'monthly')).toBe('2027-01-15');
    expect(nextDueDate('2026-01-31', 'monthly')).toBe('2026-02-28');
    expect(nextDueDate('2026-03-31', 'monthly')).toBe('2026-04-30');
  });
  it('윤년', () => {
    expect(nextDueDate('2028-01-31', 'monthly')).toBe('2028-02-29');
    expect(nextDueDate('2027-01-31', 'monthly')).toBe('2027-02-28');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
  });
  it('날짜 형식 검사', () => {
    expect(isYmd('2026-02-30')).toBe(false);
    expect(isYmd('2028-02-29')).toBe(true);
    expect(isYmd('내일')).toBe(false);
  });
  it('0~99년도 실제 달력대로 판단한다 (1900년대로 바뀌지 않음)', () => {
    expect(isYmd('0025-11-03')).toBe(true);
    expect(isYmd('0004-02-29')).toBe(true);
    expect(isYmd('0003-02-29')).toBe(false);
    expect(isYmd('0099-12-31')).toBe(true);
  });
});

describe('검색·필터', () => {
  const a = card({ title: 'Report 작성', description: '분기 보고', assignee: '김', labels: ['red'] });
  const b = card({ title: '디자인', assignee: '', labels: ['blue', 'red'] });
  it('제목·설명 부분 일치, 영문 대소문자 구분 없음', () => {
    expect(matchCard(a, { query: 'report', labels: [], assignees: [], noAssignee: false })).toBe(true);
    expect(matchCard(a, { query: '분기', labels: [], assignees: [], noAssignee: false })).toBe(true);
    expect(matchCard(a, { query: '없는말', labels: [], assignees: [], noAssignee: false })).toBe(false);
  });
  it('라벨은 선택한 색 중 하나라도 있으면 일치', () => {
    expect(matchCard(b, { query: '', labels: ['green', 'blue'], assignees: [], noAssignee: false })).toBe(true);
    expect(matchCard(b, { query: '', labels: ['green'], assignees: [], noAssignee: false })).toBe(false);
  });
  it('담당자 없음을 별도 선택지로 고를 수 있다', () => {
    expect(matchCard(b, { query: '', labels: [], assignees: [], noAssignee: true })).toBe(true);
    expect(matchCard(a, { query: '', labels: [], assignees: [], noAssignee: true })).toBe(false);
    expect(matchCard(a, { query: '', labels: [], assignees: ['김'], noAssignee: true })).toBe(true);
  });
  it('담당자 이름이 "__none__"이어도 "담당자 없음"과 섞이지 않는다', () => {
    const odd = card({ assignee: '__none__' });
    expect(matchCard(odd, { query: '', labels: [], assignees: [], noAssignee: true })).toBe(false);
    expect(matchCard(odd, { query: '', labels: [], assignees: ['__none__'], noAssignee: false })).toBe(true);
    expect(matchCard(card({ assignee: '' }), { query: '', labels: [], assignees: ['__none__'], noAssignee: false })).toBe(false);
  });
  it('조건은 AND로 결합한다', () => {
    expect(matchCard(a, { query: 'report', labels: ['blue'], assignees: [], noAssignee: false })).toBe(false);
    expect(matchCard(a, { query: 'report', labels: ['red'], assignees: ['김'], noAssignee: false })).toBe(true);
  });
  it('검색어 없이 필터만 써도 된다', () => {
    expect(hasFilters({ query: '  ', labels: [], assignees: [], noAssignee: false })).toBe(false);
    expect(hasFilters({ query: '', labels: ['red'], assignees: [], noAssignee: false })).toBe(true);
    expect(hasFilters({ query: '', labels: [], assignees: [], noAssignee: true })).toBe(true);
  });
});

describe('마감일순 보기', () => {
  const cols = [col({ id: 'todo', position: 0 }), col({ id: 'done', position: 1, isDone: true })];
  const today = '2026-11-03';
  it('지남 → 오늘 → 예정 → 없음 순서, 날짜 빠른 순, 완료 열은 기본 숨김', () => {
    const cards = [
      card({ id: 'up2', columnId: 'todo', dueDate: '2026-12-01' }),
      card({ id: 'up1', columnId: 'todo', dueDate: '2026-11-05' }),
      card({ id: 'late', columnId: 'todo', dueDate: '2026-10-01' }),
      card({ id: 'now', columnId: 'todo', dueDate: today }),
      card({ id: 'none', columnId: 'todo' }),
      card({ id: 'finished', columnId: 'done', dueDate: '2026-10-01' }),
      card({ id: 'arch', columnId: 'todo', dueDate: today, archived: true }),
    ];
    const g = groupByDue(cards, cols, today, false);
    expect(g.map((x) => x.key)).toEqual(['overdue', 'today', 'upcoming', 'none']);
    expect(g[0].cards.map((c) => c.id)).toEqual(['late']);
    expect(g[1].cards.map((c) => c.id)).toEqual(['now']);
    expect(g[2].cards.map((c) => c.id)).toEqual(['up1', 'up2']);
    expect(g[3].cards.map((c) => c.id)).toEqual(['none']);
    const withDone = groupByDue(cards, cols, today, true);
    expect(withDone[0].cards.map((c) => c.id)).toEqual(['late', 'finished'].sort((x, y) => (x === 'late' ? -1 : 1)));
  });
  it('같은 날짜와 마감일 없음은 열 순서·카드 순서를 따른다', () => {
    const cards = [
      card({ id: 'b', columnId: 'done', dueDate: '2026-11-10', position: 0 }),
      card({ id: 'a2', columnId: 'todo', dueDate: '2026-11-10', position: 1 }),
      card({ id: 'a1', columnId: 'todo', dueDate: '2026-11-10', position: 0 }),
    ];
    expect(groupByDue(cards, cols, today, true)[2].cards.map((c) => c.id)).toEqual(['a1', 'a2', 'b']);
  });
});

describe('마감 알림 계산', () => {
  const boards = [{ id: 'b1', name: '보드', position: 0, rev: 1 }];
  const cols = [col({ id: 'todo' }), col({ id: 'done', isDone: true, position: 1 })];
  const today = '2026-11-03';
  const mk = (cards: Card[], dismissals: any[] = []) => computeNotices({ boards, columns: cols, cards, dismissals }, today);
  it('내일=하루 전, 오늘=당일, 이전=지남, 모레 이후는 없음', () => {
    const r = mk([
      card({ id: '1', columnId: 'todo', dueDate: '2026-11-04' }),
      card({ id: '2', columnId: 'todo', dueDate: '2026-11-03' }),
      card({ id: '3', columnId: 'todo', dueDate: '2026-10-01' }),
      card({ id: '4', columnId: 'todo', dueDate: '2026-11-05' }),
    ]);
    expect(Object.fromEntries(r.map((n) => [n.cardId, n.kind]))).toEqual({ '1': 'dayBefore', '2': 'today', '3': 'overdue' });
  });
  it('완료 열·보관 카드·마감일 없음은 제외', () => {
    expect(mk([
      card({ columnId: 'done', dueDate: today }),
      card({ columnId: 'todo', dueDate: today, archived: true }),
      card({ columnId: 'todo' }),
    ])).toHaveLength(0);
  });
  it('닫은 알림은 제외하고, 마감일이 바뀌면 새 알림으로 본다', () => {
    const c = card({ id: 'x', columnId: 'todo', dueDate: today });
    expect(mk([c], [{ cardId: 'x', kind: 'today', dueDate: today }])).toHaveLength(0);
    expect(mk([{ ...c, dueDate: '2026-11-04' }], [{ cardId: 'x', kind: 'today', dueDate: today }])).toHaveLength(1);
  });
});

describe('첨부 파일 검사', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const html = new TextEncoder().encode('<script>alert(1)</script>');
  it('허용된 확장자와 맞는 내용은 통과', () => {
    expect(validateUpload('a.png', png).ext).toBe('png');
    expect(validateUpload('메모.txt', html).ext).toBe('txt');
    expect(validateUpload('a.PDF', new TextEncoder().encode('%PDF-1.4')).mime).toBe('application/pdf');
  });
  it('SVG·HTML·실행 파일·확장자 없음은 거부', () => {
    for (const n of ['a.svg', 'a.html', 'a.htm', 'a.js', 'a.exe', 'a.bat', 'a.sh', 'noext']) {
      expect(() => validateUpload(n, png)).toThrow();
    }
  });
  it('표시된 확장자와 내용이 어긋난 이미지·PDF는 거부', () => {
    expect(() => validateUpload('fake.png', html)).toThrow(/내용/);
    expect(() => validateUpload('fake.pdf', png)).toThrow(/내용/);
    expect(() => validateUpload('fake.jpg', png)).toThrow(/내용/);
  });
  it('빈 파일과 10MB 초과는 거부', () => {
    expect(() => validateUpload('a.txt', new Uint8Array(0))).toThrow();
    expect(() => validateUpload('a.zip', new Uint8Array(10 * 1024 * 1024 + 1))).toThrow(/10MB/);
    expect(() => validateUpload('a.zip', new Uint8Array(10 * 1024 * 1024))).not.toThrow();
  });
  it('다운로드 파일명에서 경로·특수문자를 지운다', () => {
    expect(safeDownloadName('../../etc/passwd')).toBe('etcpasswd');
    expect(safeDownloadName('a"b<c>.txt')).toBe('abc.txt');
    expect(safeDownloadName('   ')).toBe('download');
    expect(contentDisposition('보고서.pdf', false)).toMatch(/^attachment; filename="___\.pdf"; filename\*=UTF-8''/);
  });
  it('이미지·PDF만 화면에서 바로 열 수 있다', () => {
    expect(inlineMime('png')).toBe('image/png');
    expect(inlineMime('zip')).toBeNull();
    expect(inlineMime('txt')).toBeNull();
  });
});

describe('복사본 이름', () => {
  it('한도를 넘으면 원래 이름 끝을 자른다', () => {
    expect(copyName('보드', 50)).toBe('보드 (복사본)');
    const r = copyName('가'.repeat(100), 100);
    expect([...r]).toHaveLength(100);
    expect(r.endsWith(' (복사본)')).toBe(true);
  });
});

describe('다른 탭 변경 합치기', () => {
  const base: Snapshot = {
    revision: 5, boards: [], columns: [], cards: [card({ id: 'k1', title: '옛' })], checks: [], comments: [], attachments: [], dismissals: [],
  };
  it('수정·추가·삭제를 합치고 번호를 올린다', () => {
    const out = applyChanges(base, {
      revision: 7,
      upsert: [{ kind: 'card', row: card({ id: 'k1', title: '새' }) }, { kind: 'card', row: card({ id: 'k2' }) }],
      remove: [],
    });
    expect(out.revision).toBe(7);
    expect(out.cards.map((c) => c.id).sort()).toEqual(['k1', 'k2']);
    expect(out.cards.find((c) => c.id === 'k1')!.title).toBe('새');
    expect(base.cards).toHaveLength(1); // 원본은 건드리지 않는다
    const del = applyChanges(out, { revision: 8, upsert: [], remove: [{ kind: 'card', id: 'k1' }] });
    expect(del.cards.map((c) => c.id)).toEqual(['k2']);
  });
  it('알림 닫기 기록도 합친다', () => {
    const d = { cardId: 'k1', kind: 'today', dueDate: '2026-11-03' };
    const out = applyChanges(base, { revision: 6, upsert: [{ kind: 'dismissal', row: d }], remove: [] });
    expect(out.dismissals).toHaveLength(1);
    const again = applyChanges(out, { revision: 7, upsert: [{ kind: 'dismissal', row: d }], remove: [] });
    expect(again.dismissals).toHaveLength(1);
  });
  it('이어받을 수 없으면 전체 데이터로 교체한다', () => {
    const full = { ...base, revision: 99, cards: [] };
    expect(applyChanges(base, { revision: 99, full, upsert: [], remove: [] }).revision).toBe(99);
  });
});
