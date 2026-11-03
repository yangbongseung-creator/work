import { describe, it, expect } from 'vitest';
import { disposeRepo, newRepo } from './helpers';
import { History } from '../lib/history';
import { AppError, LABEL_COLORS, type Snapshot } from '../lib/types';

/** 씨앗을 주면 같은 순서로 재현되는 난수 (실패하면 씨앗으로 그대로 다시 돌려볼 수 있다) */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TODAY = '2026-11-03';
export const stats: Record<string, number> = {};
const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);
const norm = (s: Snapshot) => {
  const strip = (rows: any[]) => rows.map(({ rev, ...r }) => r).sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''));
  return JSON.stringify({
    boards: strip(s.boards),
    columns: strip(s.columns),
    cards: strip(s.cards),
    checks: strip(s.checks),
    comments: strip(s.comments),
    attachments: strip(s.attachments),
  });
};

/** 어떤 순서로 무엇을 해도 지켜져야 하는 규칙들 */
function invariants(s: Snapshot, where: string) {
  const boardIds = new Set(s.boards.map((b) => b.id));
  const colIds = new Set(s.columns.map((c) => c.id));
  const cardIds = new Set(s.cards.map((c) => c.id));
  const fail = (m: string) => {
    throw new Error(`[규칙 위반] ${m} (${where})`);
  };
  for (const r of [...s.boards, ...s.columns, ...s.cards, ...s.checks, ...s.comments, ...s.attachments]) {
    if (r.rev > s.revision) fail(`행 번호(${r.rev})가 전체 번호(${s.revision})보다 큼`);
  }
  for (const c of s.columns) if (!boardIds.has(c.boardId)) fail('보드 없는 열');
  for (const c of s.cards) if (!colIds.has(c.columnId)) fail('열 없는 카드');
  for (const c of [...s.checks, ...s.comments, ...s.attachments]) if (!cardIds.has(c.cardId)) fail('카드 없는 딸린 항목(고아)');
  // 같은 열 안에서 위치 번호가 겹치지 않는다
  const seen = new Set<string>();
  for (const c of s.cards) {
    const k = `${c.columnId}:${c.position}`;
    if (seen.has(k)) fail(`같은 열에 같은 위치 번호 ${k}`);
    seen.add(k);
  }
  // 보드마다 열이 하나는 남아 있어야 한다
  for (const b of s.boards) if (!s.columns.some((c) => c.boardId === b.id)) fail('열이 하나도 없는 보드');
  // 같은 보드 안에서 열 위치도 겹치지 않는다
  const cs = new Set<string>();
  for (const c of s.columns) {
    const k = `${c.boardId}:${c.position}`;
    if (cs.has(k)) fail(`같은 보드에 같은 열 위치 ${k}`);
    cs.add(k);
  }
  // 후속 카드 ID는 서로 다른 카드를 가리킨다 (같은 후속을 두 원본이 갖지 않는다)
  const fu = s.cards.map((c) => c.followupId).filter(Boolean) as string[];
  if (new Set(fu).size !== fu.length) fail('두 카드가 같은 후속 카드를 가리킴');
  // 첨부는 카드당 5개 이하, 라벨은 중복 없음, 반복이 있으면 마감일이 있다
  const per = new Map<string, number>();
  for (const a of s.attachments) per.set(a.cardId, (per.get(a.cardId) ?? 0) + 1);
  for (const n of per.values()) if (n > 5) fail('첨부 6개 이상');
  for (const c of s.cards) {
    if (new Set(c.labels).size !== c.labels.length) fail('라벨 중복');
    if (c.repeat !== 'none' && !c.dueDate) fail('마감일 없는 반복');
  }
}

/** mixed=true면 "다른 탭"이 이력에 남지 않는 변경을 몰래 섞는다. 이때는 되돌리기가 충돌로 건너뛰어질 수 있지만, 규칙(고아 없음 등)은 여전히 지켜져야 한다. */
async function runSequence(seed: number, steps: number, mixed: boolean) {
  const r = rng(seed);
  const pick = <T,>(a: T[]): T | undefined => a[Math.floor(r() * a.length)];
  const now = 1_800_000_000_000;
  const repo = await newRepo({ now: () => now + seed, fileExists: () => true });
  await repo.ensureFirstBoard();
  const hist = new History(100000);
  for (const c of (await repo.snapshot()).columns.slice(0, 2)) for (let i = 0; i < 3; i++) await repo.addCard(c.id, `시작카드${i}`);
  const initial = norm(await repo.snapshot());
  const log: string[] = [];
  let keyN = 0;

  const dates = ['2026-10-30', '2026-11-03', '2026-11-04', '2026-11-30', '2028-02-29', null, null];
  const ops: Record<string, () => any> = {
    createBoard: async () => await repo.createBoard('보드' + Math.floor(r() * 5)),
    renameBoard: async () => await repo.renameBoard(pick((await repo.snapshot()).boards)?.id ?? 'x', r() < 0.1 ? '   ' : '이름' + Math.floor(r() * 9)),
    deleteBoard: async () => await repo.deleteBoard(pick((await repo.snapshot()).boards)?.id ?? 'x'),
    duplicateBoard: async () => await repo.duplicateBoard(pick((await repo.snapshot()).boards)?.id ?? 'x'),
    addColumn: async () => await repo.addColumn(pick((await repo.snapshot()).boards)?.id ?? 'x', '열' + Math.floor(r() * 9)),
    renameColumn: async () => await repo.renameColumn(pick((await repo.snapshot()).columns)?.id ?? 'x', '열이름' + Math.floor(r() * 9)),
    deleteColumn: async () => await repo.deleteColumn(pick((await repo.snapshot()).columns)?.id ?? 'x'),
    moveColumn: async () => await repo.moveColumn(pick((await repo.snapshot()).columns)?.id ?? 'x', r() < 0.5 ? -1 : 1),
    setColumnDone: async () => await repo.setColumnDone(pick((await repo.snapshot()).columns)?.id ?? 'x', r() < 0.5),
    addCard: async () => await repo.addCard(pick((await repo.snapshot()).columns)?.id ?? 'x', r() < 0.05 ? '' : '카드' + Math.floor(r() * 99)),
    updateCard: async () =>
      await repo.updateCard(pick((await repo.snapshot()).cards)?.id ?? 'x', {
        ...(r() < 0.5 ? { title: '제목' + Math.floor(r() * 99) } : {}),
        ...(r() < 0.5 ? { dueDate: pick(['2026-10-30', '2026-11-03', '2026-11-04', '2026-11-30', '2028-02-29', '2026-01-31']) as any, repeat: pick(['daily', 'weekly', 'monthly', 'monthly', 'none'] as const) } : {}),
        ...(r() < 0.1 ? { dueDate: null } : {}),
        ...(r() < 0.4 ? { labels: LABEL_COLORS.filter(() => r() < 0.4) } : {}),
        ...(r() < 0.3 ? { assignee: pick(['', '김', '이']) } : {}),
      }),
    moveCard: async () => {
      const s = await repo.snapshot();
      const card = pick(s.cards);
      const cols = card ? s.columns.filter((c) => c.boardId === s.columns.find((x) => x.id === card.columnId)?.boardId) : s.columns;
      const doneCols = cols.filter((c) => c.isDone);
      const target = r() < 0.5 && doneCols.length ? pick(doneCols) : pick(cols);
      return await repo.moveCard(card?.id ?? 'x', target?.id ?? 'x', pick([0, 1, 2, 5, 99, -3, NaN, 1.7])!, r() < 0.05 ? undefined : TODAY);
    },
    deleteCard: async () => await repo.deleteCard(pick((await repo.snapshot()).cards)?.id ?? 'x'),
    duplicateCard: async () => await repo.duplicateCard(pick((await repo.snapshot()).cards)?.id ?? 'x'),
    setArchived: async () => {
      const cards = (await repo.snapshot()).cards.filter(() => r() < 0.3);
      return await repo.setArchived(cards.map((c) => c.id), r() < 0.5);
    },
    bulkMove: async () => {
      const s = await repo.snapshot();
      const col = r() < 0.5 ? pick(s.columns.filter((c) => c.isDone)) ?? pick(s.columns) : pick(s.columns);
      const same = s.cards.filter((c) => s.columns.find((x) => x.id === c.columnId)?.boardId === col?.boardId && r() < 0.5);
      return await repo.bulkMove(same.map((c) => c.id), col?.id ?? 'x', TODAY);
    },
    bulkDelete: async () => await repo.bulkDelete((await repo.snapshot()).cards.filter(() => r() < 0.2).map((c) => c.id)),
    addCheck: async () => await repo.addCheck(pick((await repo.snapshot()).cards)?.id ?? 'x', '항목' + Math.floor(r() * 9)),
    updateCheck: async () => await repo.updateCheck(pick((await repo.snapshot()).checks)?.id ?? 'x', r() < 0.5 ? { done: r() < 0.5 } : { text: '고침' + Math.floor(r() * 9) }),
    deleteCheck: async () => await repo.deleteCheck(pick((await repo.snapshot()).checks)?.id ?? 'x'),
    addComment: async () => await repo.addComment(pick((await repo.snapshot()).cards)?.id ?? 'x', '댓글' + Math.floor(r() * 9)),
    updateComment: async () => await repo.updateComment(pick((await repo.snapshot()).comments)?.id ?? 'x', '고친댓글' + Math.floor(r() * 9)),
    deleteComment: async () => await repo.deleteComment(pick((await repo.snapshot()).comments)?.id ?? 'x'),
    addAttachment: async () => await repo.addAttachment(pick((await repo.snapshot()).cards)?.id ?? 'x', { name: 'a.txt', size: 1, mime: 'x', storageKey: 'k' + keyN++ }),
    deleteAttachment: async () => await repo.deleteAttachment(pick((await repo.snapshot()).attachments)?.id ?? 'x'),
  };
  // 실제 사용처럼 카드 작업이 대부분이고, 보드·열 삭제는 드물게
  const W: Record<string, number> = {
    createBoard: 1, renameBoard: 1, deleteBoard: 0.6, duplicateBoard: 1, addColumn: 2, renameColumn: 1, deleteColumn: 1.2, moveColumn: 1.5, setColumnDone: 2,
    addCard: 12, updateCard: 14, moveCard: 16, deleteCard: 3, duplicateCard: 3, setArchived: 4, bulkMove: 8, bulkDelete: 1.5,
    addCheck: 5, updateCheck: 3, deleteCheck: 2, addComment: 3, updateComment: 1, deleteComment: 1, addAttachment: 3, deleteAttachment: 2,
  };
  const names = Object.keys(ops).flatMap((k) => Array(Math.max(1, Math.round((W[k] ?? 1) * 4))).fill(k));
  const undoRedo = async (dir: 'undo' | 'redo') => {
    const e = dir === 'undo' ? hist.peekUndo() : hist.peekRedo();
    if (!e) return;
    const res = await repo.applyPatch(dir === 'undo' ? e.inverse : e.forward, e.expect);
    if (res.conflict) {
      if (!mixed) throw new Error(`[규칙 위반] 혼자 쓰는데 되돌리기가 충돌로 거부됨 (${e.label}, ${res.reason})`);
      bump('충돌로 건너뜀(다른 탭 변경 감지)');
      if (dir === 'undo') hist.dropUndo();
      else hist.dropRedo();
      return;
    }
    bump(dir === 'undo' ? '되돌리기 성공' : '다시 실행 성공');
    if (dir === 'undo') hist.commitUndo(res.touched);
    else hist.commitRedo(res.touched);
  };

  for (let i = 0; i < steps; i++) {
    const roll = r();
    let label = '';
    try {
      if (roll < 0.1) {
        label = 'undo';
        await undoRedo('undo');
      } else if (roll < 0.16) {
        label = 'redo';
        await undoRedo('redo');
      } else {
        label = pick(names)!;
        const before = (await repo.snapshot()).revision;
        const external = mixed && r() < 0.25; // 다른 탭이 한 변경: 내 이력에는 남지 않는다
        const cardsBefore = (await repo.snapshot()).cards.length;
        const out = await ops[label]();
        if (out?.entry) {
          if (!external) hist.push(out.entry);
          bump('성공:' + label);
          const grew = out.snapshot.cards.length - cardsBefore;
          if ((label === 'moveCard' || label === 'bulkMove') && grew > 0) bump('★반복 후속 카드 생성(' + label + ')');
        } else bump('변화없음:' + label);
        // 바뀐 게 있으면 번호가 정확히 1 오르고, 없으면 그대로여야 한다
        const after = (await repo.snapshot()).revision;
        if (out?.entry ? after !== before + 1 : after !== before) throw new Error(`[규칙 위반] 번호 증가가 이상함 ${label}: ${before}→${after}, entry=${!!out?.entry}`);
      }
    } catch (e) {
      if (!(e instanceof AppError)) throw new Error(`seed ${seed} step ${i} ${label}: 예상하지 못한 오류 → ${(e as Error).stack}`);
      bump('정상 거부:' + (label || '?'));
    }
    log.push(label);
    try {
      invariants(await repo.snapshot(), `seed ${seed} step ${i} ${label}`);
    } catch (e) {
      throw new Error(`${(e as Error).message}\n최근 작업: ${log.slice(-8).join(' → ')}`);
    }
  }

  // 전부 되돌리면 맨 처음 상태, 다시 전부 실행하면 되돌리기 직전 상태와 정확히 같아야 한다 (혼자 쓸 때만 성립)
  // (중간에 되돌리기를 하고 끝났다면 "다시 실행" 대기열이 남아 있으니, 그걸 먼저 모두 실행한 상태를 기준으로 삼는다)
  while (hist.canRedo()) await undoRedo('redo');
  invariants(await repo.snapshot(), `seed ${seed} 남은 다시 실행을 모두 적용한 뒤`);
  const finalNorm = norm(await repo.snapshot());
  let n = 0;
  while (hist.canUndo()) {
    await undoRedo('undo');
    invariants(await repo.snapshot(), `seed ${seed} 전부 되돌리는 중 ${++n}`);
  }
  if (!mixed) {
    expect(norm(await repo.snapshot()), `seed ${seed}: 전부 되돌렸는데 처음 상태와 다름\n작업: ${log.join(',')}`).toBe(initial);
    while (hist.canRedo()) {
      await undoRedo('redo');
      invariants(await repo.snapshot(), `seed ${seed} 전부 다시 실행하는 중`);
    }
    expect(norm(await repo.snapshot()), `seed ${seed}: 전부 다시 실행했는데 되돌리기 직전 상태와 다름`).toBe(finalNorm);
  }
  await disposeRepo(repo); // 시험마다 만든 DB 칸막이를 지운다
}

describe('무작위 연산 퍼징: 어떤 순서로 해도 데이터가 망가지지 않고, 전부 되돌리면 처음으로 돌아온다', () => {
  const SEEDS = Number(process.env.FUZZ_SEEDS ?? 40);
  const STEPS = Number(process.env.FUZZ_STEPS ?? 60);
  it(`${SEEDS}가지 무작위 순서 × ${STEPS}번 작업`, async () => {
    const start = Number(process.env.FUZZ_START ?? 1);
    const mb = () => Math.round(process.memoryUsage().rss / 1048576);
    for (let seed = start; seed < start + SEEDS; seed++) {
      await runSequence(seed, STEPS, seed % 2 === 0); // 짝수 씨앗: 다른 탭의 몰래 변경을 섞음
      if (process.env.FUZZ_STATS && (seed - start) % 25 === 0) console.log(`[메모리] ${seed - start}번째 시험 후 RSS ${mb()}MB`);
      if (mb() > 4000) throw new Error(`메모리가 4GB를 넘어 중단 (seed ${seed}, ${mb()}MB)`);
    }
    if (process.env.FUZZ_STATS) console.log(Object.entries(stats).sort().map(([k, v]) => `${k}: ${v}`).join('\n'));
  }, 3_000_000);
});
