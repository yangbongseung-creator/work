'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { History } from '../lib/history';
import { LIMITS, type Card, type Column, type Patch, type Snapshot } from '../lib/types';
import { fetchState, mutate } from './api';

type Status = 'idle' | 'saving' | 'saved' | 'error';
type Items = Record<string, string[]>;

const LAST_BOARD_KEY = 'kanban:lastBoard';

function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_BOARD_KEY);
  } catch {
    return null;
  }
}
function writeLast(id: string) {
  try {
    localStorage.setItem(LAST_BOARD_KEY, id);
  } catch {
    /* 저장소를 못 써도 앱은 동작한다 */
  }
}
const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [toast, setToast] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [dragItems, setDragItems] = useState<Items | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [renamingBoard, setRenamingBoard] = useState<string | null>(null);
  const [creatingBoard, setCreatingBoard] = useState(false);
  const [, bump] = useState(0);

  const snapRef = useRef<Snapshot | null>(null);
  snapRef.current = snap;
  const history = useRef(new History(LIMITS.undoSteps));
  const dragOrigin = useRef<{ columnId: string; index: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const today = useMemo(localToday, []);

  const showToast = useCallback((m: string) => {
    setToast(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  // 처음 불러오기
  const load = useCallback(async () => {
    try {
      const s = await fetchState();
      setSnap(s);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // 보고 있는 보드 정하기 (마지막으로 연 보드 → 없으면 첫 보드)
  useEffect(() => {
    if (!snap) return;
    if (boardId && snap.boards.some((b) => b.id === boardId)) return;
    const last = readLast();
    const pick = snap.boards.find((b) => b.id === last) ?? snap.boards[0] ?? null;
    setBoardId(pick ? pick.id : null);
  }, [snap, boardId]);
  useEffect(() => {
    if (boardId) writeLast(boardId);
  }, [boardId]);

  // 메뉴 바깥을 누르면 닫기
  useEffect(() => {
    const close = (e: MouseEvent) => {
      // 메뉴 안쪽을 누른 경우는 메뉴 자신이 열고 닫는다
      if ((e.target as HTMLElement | null)?.closest?.('.menu')) return;
      setMenu(null);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  // ───────── 서버에 변경 보내기 ─────────

  const run = useCallback(
    async (body: Record<string, unknown>, optimistic?: (s: Snapshot) => Snapshot): Promise<boolean> => {
      const prev = snapRef.current;
      setStatus('saving');
      if (optimistic && prev) setSnap(optimistic(prev));
      try {
        const res = await mutate(body);
        setSnap(res.snapshot);
        if (res.entry) history.current.push(res.entry);
        setStatus('saved');
        bump((n) => n + 1);
        return true;
      } catch (e) {
        if (prev) setSnap(prev);
        setStatus('error');
        showToast((e as Error).message);
        return false;
      }
    },
    [showToast],
  );

  const boardOfPatch = (p: Patch, s: Snapshot): string | null => {
    if (p.upsert.boards[0]) return p.upsert.boards[0].id;
    if (p.upsert.columns[0]) return p.upsert.columns[0].boardId;
    if (p.upsert.cards[0]) return s.columns.find((c) => c.id === p.upsert.cards[0].columnId)?.boardId ?? null;
    return null;
  };

  const step = useCallback(
    async (dir: 'undo' | 'redo') => {
      const h = history.current;
      const e = dir === 'undo' ? h.peekUndo() : h.peekRedo();
      if (!e) return;
      setStatus('saving');
      try {
        const patch = dir === 'undo' ? e.inverse : e.forward;
        const res: any = await mutate({ op: 'patch', patch, expect: e.expect });
        setSnap(res.snapshot);
        if (res.conflict) {
          if (dir === 'undo') h.dropUndo();
          else h.dropRedo();
          showToast('다른 탭에서 바뀐 내용이라 이 단계는 건너뛰었어요.');
          setStatus('idle');
        } else {
          if (dir === 'undo') h.commitUndo(res.touched);
          else h.commitRedo(res.touched);
          const target = boardOfPatch(patch, res.snapshot);
          if (target && (res.snapshot as Snapshot).boards.some((b) => b.id === target)) setBoardId(target);
          setStatus('saved');
        }
      } catch (err) {
        setStatus('error');
        showToast((err as Error).message);
      }
      bump((n) => n + 1);
    },
    [showToast],
  );

  // Ctrl+Z / Ctrl+Shift+Z (글을 쓰는 중에는 입력창 자체 기능을 쓴다)
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== 'z') return;
      if (isTyping(ev.target)) return;
      ev.preventDefault();
      step(ev.shiftKey ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  // ───────── 화면용 데이터 ─────────

  const board = snap?.boards.find((b) => b.id === boardId) ?? null;
  const columns = useMemo(() => (snap && board ? snap.columns.filter((c) => c.boardId === board.id) : []), [snap, board]);
  const baseItems: Items = useMemo(() => {
    const m: Items = {};
    for (const c of columns) {
      m[c.id] = (snap?.cards ?? [])
        .filter((k) => k.columnId === c.id && !k.archived)
        .sort((a, b) => a.position - b.position)
        .map((k) => k.id);
    }
    return m;
  }, [snap, columns]);
  const items = dragItems ?? baseItems;
  const cardById = useMemo(() => new Map((snap?.cards ?? []).map((c) => [c.id, c])), [snap]);
  const assignees = useMemo(() => {
    const set = new Set<string>();
    for (const c of snap?.cards ?? []) {
      const col = snap?.columns.find((x) => x.id === c.columnId);
      if (c.assignee && col?.boardId === boardId) set.add(c.assignee);
    }
    return [...set].sort();
  }, [snap, boardId]);

  // ───────── 드래그 ─────────

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const findContainer = (id: string, it: Items) =>
    id.startsWith('col:') ? id.slice(4) : Object.keys(it).find((k) => it[k].includes(id));

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    const col = findContainer(id, baseItems);
    if (col) dragOrigin.current = { columnId: col, index: baseItems[col].indexOf(id) };
    setActiveId(id);
    setDragItems(baseItems);
  };
  const onDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (!over) return;
    const aid = String(active.id);
    const oid = String(over.id);
    setDragItems((prev) => {
      if (!prev) return prev;
      const ac = findContainer(aid, prev);
      const oc = findContainer(oid, prev);
      if (!ac || !oc || ac === oc) return prev;
      const from = prev[ac].filter((x) => x !== aid);
      const to = [...prev[oc]];
      let idx = to.length;
      if (!oid.startsWith('col:')) {
        const oi = to.indexOf(oid);
        const t = active.rect.current.translated;
        const below = !!t && t.top > over.rect.top + over.rect.height / 2;
        idx = oi + (below ? 1 : 0);
      }
      to.splice(idx, 0, aid);
      return { ...prev, [ac]: from, [oc]: to };
    });
  };
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    const cur = dragItems;
    const origin = dragOrigin.current;
    setDragItems(null);
    setActiveId(null);
    dragOrigin.current = null;
    if (!over || !cur || !origin) return;
    const aid = String(active.id);
    const oid = String(over.id);
    let final = cur;
    const ac = findContainer(aid, cur);
    if (!ac) return;
    if (!oid.startsWith('col:') && findContainer(oid, cur) === ac) {
      const ai = cur[ac].indexOf(aid);
      const oi = cur[ac].indexOf(oid);
      if (ai !== oi) final = { ...cur, [ac]: arrayMove(cur[ac], ai, oi) };
    }
    const index = final[ac].indexOf(aid);
    if (origin.columnId === ac && origin.index === index) return;
    run({ op: 'moveCard', id: aid, toColumnId: ac, index }, (s) => ({
      ...s,
      cards: s.cards.map((c) => {
        for (const colId of Object.keys(final)) {
          const i = final[colId].indexOf(c.id);
          if (i >= 0) return { ...c, columnId: colId, position: i };
        }
        return c;
      }),
    }));
  };
  const onDragCancel = () => {
    setDragItems(null);
    setActiveId(null);
    dragOrigin.current = null;
  };

  // ───────── 동작 모음 ─────────

  const confirmDeleteColumn = (col: Column) => {
    const n = (snap?.cards ?? []).filter((c) => c.columnId === col.id).length;
    const msg =
      n > 0
        ? `"${col.name}" 열을 삭제하면 카드 ${n}개(보관된 카드 포함)도 함께 삭제돼요.\n삭제할까요? (되돌리기로 복원할 수 있어요)`
        : `"${col.name}" 열을 삭제할까요? (되돌리기로 복원할 수 있어요)`;
    if (window.confirm(msg)) run({ op: 'deleteColumn', id: col.id });
  };
  const confirmDeleteBoard = (id: string) => {
    const b = snap?.boards.find((x) => x.id === id);
    if (!b || !snap) return;
    const colIds = new Set(snap.columns.filter((c) => c.boardId === id).map((c) => c.id));
    const n = snap.cards.filter((c) => colIds.has(c.columnId)).length;
    const msg = `"${b.name}" 보드를 삭제할까요?\n열 ${colIds.size}개와 카드 ${n}개도 함께 삭제돼요. (되돌리기로 복원할 수 있어요)`;
    if (window.confirm(msg)) run({ op: 'deleteBoard', id });
  };
  const confirmDeleteCard = (c: Card) => {
    if (window.confirm(`"${c.title}" 카드를 삭제할까요? (되돌리기로 복원할 수 있어요)`)) {
      if (openCardId === c.id) setOpenCardId(null);
      run({ op: 'deleteCard', id: c.id });
    }
  };

  // ───────── 그리기 ─────────

  if (loadError) {
    return (
      <div className="center">
        <p>데이터를 불러오지 못했어요.</p>
        <p className="muted">{loadError}</p>
        <button onClick={load}>다시 시도</button>
      </div>
    );
  }
  if (!snap) return <div className="center muted">불러오는 중…</div>;

  const openCard = openCardId ? cardById.get(openCardId) ?? null : null;
  const activeCard = activeId ? cardById.get(activeId) ?? null : null;
  const h = history.current;

  return (
    <div className="app">
      <aside className="sidebar" aria-label="보드 목록">
        <h1 className="brand">칸반 보드</h1>
        <ul className="boards">
          {snap.boards.map((b) => (
            <li key={b.id} className={b.id === boardId ? 'active' : ''}>
              {renamingBoard === b.id ? (
                <InlineEdit
                  initial={b.name}
                  max={LIMITS.boardName}
                  label="보드 이름"
                  onSave={(v) => {
                    setRenamingBoard(null);
                    if (v !== b.name) run({ op: 'renameBoard', id: b.id, name: v });
                  }}
                  onCancel={() => setRenamingBoard(null)}
                />
              ) : (
                <>
                  <button className="board-btn" onClick={() => setBoardId(b.id)}>
                    {b.name}
                  </button>
                  <Menu id={`board:${b.id}`} open={menu} setOpen={setMenu} label={`${b.name} 보드 메뉴`}>
                    <button onClick={() => setRenamingBoard(b.id)}>이름 변경</button>
                    <button className="danger" onClick={() => confirmDeleteBoard(b.id)}>
                      삭제
                    </button>
                  </Menu>
                </>
              )}
            </li>
          ))}
        </ul>
        {creatingBoard ? (
          <InlineEdit
            initial=""
            max={LIMITS.boardName}
            label="새 보드 이름"
            onSave={async (v) => {
              setCreatingBoard(false);
              const ok = await run({ op: 'createBoard', name: v });
              if (ok) {
                const s = snapRef.current;
                const newest = s?.boards[s.boards.length - 1];
                if (newest) setBoardId(newest.id);
              }
            }}
            onCancel={() => setCreatingBoard(false)}
          />
        ) : (
          <button className="add-board" onClick={() => setCreatingBoard(true)}>
            + 새 보드
          </button>
        )}
      </aside>

      <main className="main">
        <header className="topbar">
          <h2 className="board-title">{board ? board.name : ''}</h2>
          <div className="spacer" />
          <span className={`status ${status}`} role="status">
            {status === 'saving' && '저장 중…'}
            {status === 'saved' && '저장됨'}
            {status === 'error' && '저장 실패'}
          </span>
          <button onClick={() => step('undo')} disabled={!h.canUndo()} title="되돌리기 (Ctrl+Z)" aria-label="되돌리기">
            ↶ 되돌리기
          </button>
          <button onClick={() => step('redo')} disabled={!h.canRedo()} title="다시 실행 (Ctrl+Shift+Z)" aria-label="다시 실행">
            ↷ 다시 실행
          </button>
        </header>

        {!board ? (
          <div className="center">
            <p>첫 보드를 만들어 보세요.</p>
            <button className="primary" onClick={() => setCreatingBoard(true)}>
              + 새 보드
            </button>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
            onDragCancel={onDragCancel}
          >
            <div className="columns">
              {columns.map((col, i) => (
                <ColumnView
                  key={col.id}
                  col={col}
                  index={i}
                  total={columns.length}
                  cardIds={items[col.id] ?? []}
                  cardById={cardById}
                  today={today}
                  menu={menu}
                  setMenu={setMenu}
                  columns={columns}
                  onRename={(name) => run({ op: 'renameColumn', id: col.id, name })}
                  onDelete={() => confirmDeleteColumn(col)}
                  onMove={(dir) => run({ op: 'moveColumn', id: col.id, dir })}
                  onToggleDone={() => run({ op: 'setColumnDone', id: col.id, done: !col.isDone })}
                  onAddCard={(title) => run({ op: 'addCard', columnId: col.id, title })}
                  onOpenCard={setOpenCardId}
                  onMoveCardTo={(cardId, toColumnId) => run({ op: 'moveCard', id: cardId, toColumnId, index: 9999 })}
                  onDeleteCard={confirmDeleteCard}
                />
              ))}
              <AddColumn onAdd={(name) => run({ op: 'addColumn', boardId: board.id, name })} />
            </div>
            <DragOverlay>
              {activeCard ? (
                <CardFace
                  card={activeCard}
                  overdue={isOverdue(activeCard, columns.find((c) => c.id === activeCard.columnId), today)}
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </main>

      {openCard && (
        <CardModal
          key={openCard.id}
          card={openCard}
          columns={columns}
          assignees={assignees}
          status={status}
          onSave={(fields) => run({ op: 'updateCard', id: openCard.id, fields })}
          onMoveTo={(toColumnId) => run({ op: 'moveCard', id: openCard.id, toColumnId, index: 9999 })}
          onDelete={() => confirmDeleteCard(openCard)}
          onClose={() => {
            const id = openCard.id;
            setOpenCardId(null);
            setTimeout(() => document.querySelector<HTMLElement>(`[data-card-id="${id}"]`)?.focus(), 0);
          }}
        />
      )}

      {toast && (
        <div className="toast" role="alert">
          {toast}
        </div>
      )}
    </div>
  );
}

// ───────── 작은 부품들 ─────────

function isOverdue(card: Card, col: Column | undefined, today: string) {
  return !!card.dueDate && card.dueDate < today && !col?.isDone && !card.archived;
}

function Menu(props: {
  id: string;
  open: string | null;
  setOpen: (v: string | null) => void;
  label: string;
  children: React.ReactNode;
}) {
  const isOpen = props.open === props.id;
  return (
    <span className="menu" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <button
        className="icon-btn"
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => props.setOpen(isOpen ? null : props.id)}
      >
        ⋯
      </button>
      {isOpen && (
        <div className="menu-pop" role="menu" onClick={() => props.setOpen(null)}>
          {props.children}
        </div>
      )}
    </span>
  );
}

function InlineEdit(props: {
  initial: string;
  max: number;
  label: string;
  onSave: (v: string) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(props.initial);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const t = v.trim();
    if (save && t) props.onSave(t);
    else props.onCancel();
  };
  return (
    <input
      className="inline-edit"
      autoFocus
      aria-label={props.label}
      placeholder={props.label}
      maxLength={props.max}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

function AddColumn({ onAdd }: { onAdd: (name: string) => void }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="add-column">
      {adding ? (
        <InlineEdit
          initial=""
          max={LIMITS.columnName}
          label="열 이름"
          onSave={(v) => {
            setAdding(false);
            onAdd(v);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button onClick={() => setAdding(true)}>+ 열 추가</button>
      )}
    </div>
  );
}

function ColumnView(props: {
  col: Column;
  index: number;
  total: number;
  cardIds: string[];
  cardById: Map<string, Card>;
  today: string;
  menu: string | null;
  setMenu: (v: string | null) => void;
  columns: Column[];
  onRename: (name: string) => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
  onToggleDone: () => void;
  onAddCard: (title: string) => Promise<boolean>;
  onOpenCard: (id: string) => void;
  onMoveCardTo: (cardId: string, toColumnId: string) => void;
  onDeleteCard: (c: Card) => void;
}) {
  const { col } = props;
  const { setNodeRef, isOver } = useDroppable({ id: `col:${col.id}` });
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');

  const submit = async () => {
    const t = title.trim();
    if (!t) return;
    setTitle('');
    await props.onAddCard(t);
  };

  return (
    <section className={`column ${col.isDone ? 'done' : ''} ${isOver ? 'over' : ''}`} aria-label={`${col.name} 열`}>
      <header className="column-head">
        {renaming ? (
          <InlineEdit
            initial={col.name}
            max={LIMITS.columnName}
            label="열 이름"
            onSave={(v) => {
              setRenaming(false);
              if (v !== col.name) props.onRename(v);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <h3 onDoubleClick={() => setRenaming(true)} title="더블클릭하면 이름을 바꿀 수 있어요">
            {col.name}
            {col.isDone && <span className="done-badge">완료 열</span>}
            <span className="count">{props.cardIds.length}</span>
          </h3>
        )}
        <Menu id={`col:${col.id}`} open={props.menu} setOpen={props.setMenu} label={`${col.name} 열 메뉴`}>
          <button onClick={() => setRenaming(true)}>이름 변경</button>
          <button onClick={props.onToggleDone}>{col.isDone ? '완료 열 해제' : '완료 열로 지정'}</button>
          <button disabled={props.index === 0} onClick={() => props.onMove(-1)}>
            ← 왼쪽으로 이동
          </button>
          <button disabled={props.index === props.total - 1} onClick={() => props.onMove(1)}>
            오른쪽으로 이동 →
          </button>
          <button className="danger" onClick={props.onDelete}>
            열 삭제
          </button>
        </Menu>
      </header>

      <div ref={setNodeRef} className="cards">
        <SortableContext items={props.cardIds} strategy={verticalListSortingStrategy}>
          {props.cardIds.map((id) => {
            const card = props.cardById.get(id);
            if (!card) return null;
            return (
              <SortableCard
                key={id}
                card={card}
                overdue={isOverdue(card, col, props.today)}
                menu={props.menu}
                setMenu={props.setMenu}
                columns={props.columns}
                onOpen={() => props.onOpenCard(id)}
                onMoveTo={(to) => props.onMoveCardTo(id, to)}
                onDelete={() => props.onDeleteCard(card)}
              />
            );
          })}
        </SortableContext>
      </div>

      {adding ? (
        <div className="add-card-form">
          <textarea
            autoFocus
            rows={2}
            maxLength={LIMITS.cardTitle}
            placeholder="카드 제목을 쓰고 Enter"
            aria-label="카드 제목"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
              if (e.key === 'Escape') {
                setAdding(false);
                setTitle('');
              }
            }}
            onBlur={() => {
              if (!title.trim()) setAdding(false);
            }}
          />
        </div>
      ) : (
        <button className="add-card" onClick={() => setAdding(true)}>
          + 카드 추가
        </button>
      )}
    </section>
  );
}

function CardFace({ card, overdue }: { card: Card; overdue: boolean }) {
  return (
    <div className={`card ${overdue ? 'overdue' : ''}`}>
      <div className="card-title">{card.title}</div>
      {(card.dueDate || card.assignee) && (
        <div className="card-meta">
          {card.dueDate && <span className={`due ${overdue ? 'late' : ''}`}>{card.dueDate}</span>}
          <span className="grow" />
          {card.assignee && (
            <span className="avatar" title={card.assignee}>
              {[...card.assignee][0]}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function SortableCard(props: {
  card: Card;
  overdue: boolean;
  menu: string | null;
  setMenu: (v: string | null) => void;
  columns: Column[];
  onOpen: () => void;
  onMoveTo: (columnId: string) => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.card.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  return (
    <div ref={setNodeRef} style={style} className="card-wrap">
      <div
        {...attributes}
        {...listeners}
        data-card-id={props.card.id}
        className="card-hit"
        onClick={props.onOpen}
        aria-label={`카드: ${props.card.title}`}
      >
        <CardFace card={props.card} overdue={props.overdue} />
      </div>
      <div className="card-menu">
        <Menu id={`card:${props.card.id}`} open={props.menu} setOpen={props.setMenu} label={`${props.card.title} 카드 메뉴`}>
          <button onClick={props.onOpen}>열기</button>
          {props.columns
            .filter((c) => c.id !== props.card.columnId)
            .map((c) => (
              <button key={c.id} onClick={() => props.onMoveTo(c.id)}>
                “{c.name}”(으)로 이동
              </button>
            ))}
          <button className="danger" onClick={props.onDelete}>
            카드 삭제
          </button>
        </Menu>
      </div>
    </div>
  );
}

function CardModal(props: {
  card: Card;
  columns: Column[];
  assignees: string[];
  status: Status;
  onSave: (fields: Record<string, unknown>) => Promise<boolean>;
  onMoveTo: (columnId: string) => Promise<boolean>;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { card } = props;
  const [title, setTitle] = useState(card.title);
  const [desc, setDesc] = useState(card.description);
  const [assignee, setAssignee] = useState(card.assignee);
  const [due, setDue] = useState(card.dueDate ?? '');
  const [titleError, setTitleError] = useState(false);
  const [failed, setFailed] = useState(false);

  const flush = async (): Promise<boolean> => {
    const fields: Record<string, unknown> = {};
    if (title.trim() && title.trim() !== card.title) fields.title = title;
    if (desc !== card.description) fields.description = desc;
    if (assignee.trim() !== card.assignee) fields.assignee = assignee;
    if (due !== (card.dueDate ?? '')) fields.dueDate = due || null;
    setTitleError(!title.trim());
    if (!title.trim()) {
      setTitle(card.title);
    }
    if (Object.keys(fields).length === 0) {
      setFailed(false);
      return true;
    }
    const ok = await props.onSave(fields);
    setFailed(!ok);
    return ok;
  };
  const close = async () => {
    if (await flush()) props.onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="카드 편집">
        <div className="modal-head">
          <span className={`status ${failed ? 'error' : props.status}`} role="status">
            {failed ? '저장 실패' : props.status === 'saving' ? '저장 중…' : props.status === 'saved' ? '저장됨' : ''}
          </span>
          {failed && <button onClick={flush}>다시 시도</button>}
          <div className="spacer" />
          <button className="icon-btn" aria-label="닫기" onClick={close}>
            ✕
          </button>
        </div>

        <label>
          제목
          <input
            autoFocus
            maxLength={LIMITS.cardTitle}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={flush}
            aria-invalid={titleError}
          />
        </label>
        {titleError && <p className="field-error">제목은 비워둘 수 없어요.</p>}

        <label>
          설명
          <textarea rows={5} maxLength={LIMITS.cardDescription} value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={flush} />
        </label>

        <div className="row">
          <label>
            담당자
            <input
              list="assignee-list"
              maxLength={50}
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              onBlur={flush}
            />
            <datalist id="assignee-list">
              {props.assignees.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </label>
          <label>
            마감일
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} onBlur={flush} />
          </label>
        </div>

        <label>
          소속 열
          <select
            value={card.columnId}
            onChange={async (e) => {
              if (await flush()) props.onMoveTo(e.target.value);
            }}
          >
            {props.columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <div className="modal-foot">
          <button className="danger" onClick={props.onDelete}>
            카드 삭제
          </button>
        </div>
      </div>
    </div>
  );
}
