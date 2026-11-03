'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { History } from '../lib/history';
import { emptyFilters, groupByDue, hasFilters, matchCard, type Filters } from '../lib/filter';
import { computeNotices, NOTICE_TEXT, type Notice } from '../lib/notices';
import { applyChanges } from '../lib/sync';
import { LABEL_COLORS, LABEL_NAMES, LIMITS, type Card, type Column, type LabelColor, type Patch, type Snapshot } from '../lib/types';
import { fetchChanges, fetchState, mutate, uploadFile } from './api';
import { AddColumn, CardFace, ColumnView, noMeta, type CardMeta } from './Board';
import { CardModal } from './CardModal';
import { InlineEdit, Menu } from './ui';
import { isOverdue, isTyping, localToday, store, storeSet } from './util';
import { AllSearchResults, ArchiveModal, Bell, DueView } from './Views';

type Status = 'idle' | 'saving' | 'saved' | 'error';
type Items = Record<string, string[]>;
type Theme = 'system' | 'light' | 'dark';

const LAST_BOARD_KEY = 'kanban:lastBoard';
const THEME_KEY = 'kanban:theme';
const NOTIFY_ON_KEY = 'kanban:browserNotify';
const NOTIFIED_KEY = 'kanban:notified';

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [conn, setConn] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [toast, setToast] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [dragItems, setDragItems] = useState<Items | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [renamingBoard, setRenamingBoard] = useState<string | null>(null);
  const [creatingBoard, setCreatingBoard] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [scope, setScope] = useState<'board' | 'all'>('board');
  const [view, setView] = useState<'kanban' | 'due'>('kanban');
  const [showDone, setShowDone] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [theme, setTheme] = useState<Theme>('system');
  const [today, setToday] = useState(localToday);
  const [browserOn, setBrowserOn] = useState(false);
  const [, bump] = useState(0);

  const snapRef = useRef<Snapshot | null>(null);
  snapRef.current = snap;
  const history = useRef(new History(LIMITS.undoSteps));
  const dragOrigin = useRef<{ columnId: string; index: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncing = useRef(false);

  /** 새 데이터를 받으면 화면 갱신을 기다리지 않고 ref도 바로 맞춘다 (직후 코드가 최신 값을 보게) */
  const commit = useCallback((s: Snapshot) => {
    // 늦게 도착한 옛 응답이 이미 반영된 최신 상태(다른 탭의 변경 포함)를 덮어쓰지 않게 한다.
    // 서버의 번호가 클수록 더 많은 변경을 담고 있으므로, 같거나 더 큰 번호만 받아들인다.
    const cur = snapRef.current;
    if (cur && s.revision < cur.revision) return;
    snapRef.current = s;
    setSnap(s);
  }, []);

  const showToast = useCallback((m: string) => {
    setToast(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  // ───────── 불러오기 · 설정 복원 ─────────

  const load = useCallback(async () => {
    try {
      commit(await fetchState());
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [commit]);
  useEffect(() => {
    load();
    const t = store(THEME_KEY);
    if (t === 'light' || t === 'dark') setTheme(t);
    setBrowserOn(store(NOTIFY_ON_KEY) === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted');
  }, [load]);

  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    storeSet(THEME_KEY, theme);
  }, [theme]);

  // 오늘 날짜는 자정이 지나거나 탭을 다시 열면 다시 계산한다
  useEffect(() => {
    const tick = () => setToday((prev) => (localToday() !== prev ? localToday() : prev));
    const id = setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);

  // 보고 있는 보드 정하기
  const boards = useMemo(() => [...(snap?.boards ?? [])].sort((a, b) => a.position - b.position), [snap]);
  useEffect(() => {
    if (!snap) return;
    if (boardId && snap.boards.some((b) => b.id === boardId)) return;
    const last = store(LAST_BOARD_KEY);
    const pick = snap.boards.find((b) => b.id === last) ?? boards[0] ?? null;
    setBoardId(pick ? pick.id : null);
  }, [snap, boardId, boards]);
  useEffect(() => {
    if (boardId) storeSet(LAST_BOARD_KEY, boardId);
  }, [boardId]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('.menu')) return;
      setMenu(null);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  // ───────── 여러 탭 동기화 (SSE + 재연결 시 이어받기) ─────────

  const catchUpAgain = useRef(false);
  const catchUp = useCallback(async () => {
    // 이미 가져오는 중에 새 알림이 오면 버리지 않고, 끝난 뒤 한 번 더 확인한다
    if (syncing.current) {
      catchUpAgain.current = true;
      return;
    }
    syncing.current = true;
    try {
      do {
        catchUpAgain.current = false;
        const cur = snapRef.current;
        if (!cur) break;
        const ch = await fetchChanges(cur.revision);
        const latest = snapRef.current;
        if (latest && ch.full && ch.revision < latest.revision) {
          // 서버가 내 화면보다 옛 상태다(예: DB를 백업으로 되돌림). 낡은 화면을 버리고 새로 불러온다.
          window.location.reload();
          return;
        }
        if (latest && latest.revision < ch.revision) commit(applyChanges(latest, ch));
      } while (catchUpAgain.current);
    } catch {
      /* 다음 알림이나 재연결 때 다시 시도 */
    } finally {
      syncing.current = false;
    }
  }, [commit]);
  const hasSnap = snap !== null;
  useEffect(() => {
    if (!hasSnap) return;
    let es: EventSource | null = null;
    let stopped = false;
    let lastMsg = Date.now();
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (stopped) return;
      es?.close();
      const src = new EventSource('/api/events');
      es = src;
      lastMsg = Date.now();
      src.onopen = () => {
        lastMsg = Date.now();
        setConn('connected');
        catchUp(); // 끊긴 동안 놓친 변경을 마지막 번호 이후로 가져온다
      };
      src.addEventListener('ping', () => {
        lastMsg = Date.now();
      });
      src.addEventListener('change', (ev) => {
        lastMsg = Date.now();
        const rev = Number((ev as MessageEvent).data);
        // 내가 보낸 변경이 돌아온 것(이미 반영된 번호)은 무시한다
        if (Number.isFinite(rev) && snapRef.current && rev > snapRef.current.revision) catchUp();
      });
      src.onerror = () => {
        setConn('reconnecting');
        // 브라우저가 재시도를 포기한 경우(CLOSED)에는 직접 다시 연결한다
        if (src.readyState === EventSource.CLOSED && !retry) {
          retry = setTimeout(() => {
            retry = null;
            connect();
          }, 2000);
        }
      };
    };
    connect();

    // 신호가 40초 넘게 없으면 끊긴 연결로 보고 새로 붙는다
    const watchdog = setInterval(() => {
      if (Date.now() - lastMsg > 40_000) {
        setConn('reconnecting');
        connect();
      }
    }, 10_000);

    return () => {
      stopped = true;
      clearInterval(watchdog);
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, [hasSnap, catchUp]);

  // ───────── 서버에 변경 보내기 ─────────

  const run = useCallback(
    async (body: Record<string, unknown>, optimistic?: (s: Snapshot) => Snapshot): Promise<boolean> => {
      const prev = snapRef.current;
      setStatus('saving');
      if (optimistic && prev) commit(optimistic(prev));
      try {
        const res = await mutate({ ...body, today: localToday() }); // 완료한 날짜는 브라우저의 로컬 날짜
        commit(res.snapshot);
        if (res.entry) history.current.push(res.entry);
        setStatus('saved');
        bump((n) => n + 1);
        return true;
      } catch (e) {
        // 그 사이 다른 탭의 변경이 반영되어 번호가 앞서갔다면, 옛 상태로 되돌리면 최신 내용을 잃으므로 서버에서 다시 받는다
        if (prev && snapRef.current && snapRef.current.revision === prev.revision) commit(prev);
        else void load();
        setStatus('error');
        showToast((e as Error).message);
        return false;
      }
    },
    [showToast, commit, load],
  );

  const doUpload = useCallback(async (cardId: string, file: File) => {
    setStatus('saving');
    try {
      const res = await uploadFile(cardId, file);
      commit(res.snapshot);
      if (res.entry) history.current.push(res.entry);
      setStatus('saved');
      bump((n) => n + 1);
    } catch (e) {
      setStatus('error');
      throw e;
    }
  }, [commit]);

  const boardOfPatch = (p: Patch, s: Snapshot): string | null => {
    const colBoard = (colId: string) => s.columns.find((c) => c.id === colId)?.boardId ?? null;
    for (const u of p.upsert) {
      const r = u.row as any;
      if (u.kind === 'board') return r.id;
      if (u.kind === 'column') return r.boardId;
      if (u.kind === 'card') return colBoard(r.columnId);
      const card = s.cards.find((c) => c.id === r.cardId);
      if (card) return colBoard(card.columnId);
    }
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
        commit(res.snapshot);
        if (res.conflict) {
          if (dir === 'undo') h.dropUndo();
          else h.dropRedo();
          showToast(
            res.reason === 'file'
              ? '보관 기간이 지나 파일이 정리되어 복원할 수 없어요. 이 단계는 건너뛰었어요.'
              : '다른 탭에서 바뀐 내용이라 덮어쓰지 않고 이 단계를 건너뛰었어요.',
          );
          setStatus('idle');
        } else {
          if (dir === 'undo') h.commitUndo(res.touched);
          else h.commitRedo(res.touched);
          const target = boardOfPatch(patch, res.snapshot as Snapshot);
          if (target && (res.snapshot as Snapshot).boards.some((b) => b.id === target)) setBoardId(target);
          setStatus('saved');
        }
      } catch (err) {
        setStatus('error');
        showToast((err as Error).message);
      }
      bump((n) => n + 1);
    },
    [showToast, commit],
  );

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== 'z') return;
      if (isTyping(ev.target)) return; // 글 입력 중에는 입력창 자체의 되돌리기를 쓴다
      ev.preventDefault();
      step(ev.shiftKey ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  // ───────── 화면용 데이터 ─────────

  const board = boards.find((b) => b.id === boardId) ?? null;
  const columns = useMemo(
    () => (snap && board ? snap.columns.filter((c) => c.boardId === board.id).sort((a, b) => a.position - b.position) : []),
    [snap, board],
  );
  const colIds = useMemo(() => new Set(columns.map((c) => c.id)), [columns]);
  const cardById = useMemo(() => new Map((snap?.cards ?? []).map((c) => [c.id, c])), [snap]);
  const metaMap = useMemo(() => {
    const m = new Map<string, CardMeta>();
    const get = (id: string) => m.get(id) ?? (m.set(id, { ...noMeta }), m.get(id)!);
    for (const c of snap?.checks ?? []) {
      get(c.cardId).checkTotal++;
      if (c.done) get(c.cardId).checkDone++;
    }
    for (const c of snap?.comments ?? []) get(c.cardId).comments++;
    for (const a of snap?.attachments ?? []) get(a.cardId).attachments++;
    return m;
  }, [snap]);
  const metaOf = useCallback((id: string) => metaMap.get(id) ?? noMeta, [metaMap]);

  const filtered = hasFilters(filters);
  const dragDisabled = filtered || view === 'due' || selectMode || scope === 'all';
  const boardCards = useMemo(() => (snap?.cards ?? []).filter((c) => colIds.has(c.columnId)), [snap, colIds]);
  const archivedCards = useMemo(() => boardCards.filter((c) => c.archived).sort((a, b) => a.position - b.position), [boardCards]);

  const allBase: Items = useMemo(() => {
    const m: Items = {};
    for (const c of columns) {
      m[c.id] = boardCards
        .filter((k) => k.columnId === c.id && !k.archived)
        .sort((a, b) => a.position - b.position)
        .map((k) => k.id);
    }
    return m;
  }, [boardCards, columns]);
  const shownBase: Items = useMemo(() => {
    if (!filtered) return allBase;
    const m: Items = {};
    for (const c of columns) m[c.id] = allBase[c.id].filter((id) => matchCard(cardById.get(id)!, filters));
    return m;
  }, [allBase, filtered, columns, cardById, filters]);
  const items = dragItems ?? shownBase;

  const dueCards = useMemo(() => boardCards.filter((c) => matchCard(c, filters)), [boardCards, filters]);
  const dueVisibleIds = useMemo(
    () => groupByDue(dueCards, columns, today, showDone).flatMap((g) => g.cards.map((c) => c.id)),
    [dueCards, columns, today, showDone],
  );
  const visibleIds = view === 'due' ? dueVisibleIds : Object.values(shownBase).flat();

  const allMatches = useMemo(
    () => (scope === 'all' ? (snap?.cards ?? []).filter((c) => !c.archived && filtered && matchCard(c, filters)) : []),
    [scope, snap, filtered, filters],
  );

  const assignees = useMemo(() => {
    const set = new Set<string>();
    for (const c of snap?.cards ?? []) {
      if (!c.assignee) continue;
      if (scope === 'all' || colIds.has(c.columnId)) set.add(c.assignee);
    }
    return [...set].sort();
  }, [snap, scope, colIds]);

  const notices = useMemo(() => (snap ? computeNotices(snap, today) : []), [snap, today]);

  // 보드·검색·필터·보기 방식이 바뀌면 선택을 해제한다
  useEffect(() => {
    setSelected(new Set());
  }, [boardId, filters, scope, view]);
  // 사라진 카드는 선택에서 뺀다
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => cardById.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [cardById]);
  // 다른 탭에서 지운 카드를 열어 두고 있었다면 안내하고 닫는다
  useEffect(() => {
    if (openCardId && snap && !cardById.has(openCardId)) {
      setOpenCardId(null);
      showToast('이 카드는 다른 탭에서 삭제되었어요.');
    }
  }, [openCardId, snap, cardById, showToast]);

  // ───────── 브라우저 알림 ─────────

  const browserSupported = typeof Notification !== 'undefined';
  useEffect(() => {
    if (!browserOn || !browserSupported || Notification.permission !== 'granted') return;
    const read = (): string[] => {
      try {
        return (JSON.parse(store(NOTIFIED_KEY) ?? '[]') as string[]).filter((k) => k.endsWith(`|${today}`));
      } catch {
        return [];
      }
    };
    for (const n of notices) {
      const k = `${n.cardId}|${n.kind}|${n.dueDate}|${today}`;
      const cur = read(); // 표시 직전에 다시 확인 (다른 탭이 먼저 보여줬을 수 있다)
      if (cur.includes(k)) continue;
      storeSet(NOTIFIED_KEY, JSON.stringify([...cur, k]));
      try {
        new Notification(`${NOTICE_TEXT[n.kind]}: ${n.title}`, { body: `${n.boardName} · 마감 ${n.dueDate}` });
      } catch {
        /* 알림을 못 띄워도 앱은 계속 동작한다 */
      }
    }
  }, [notices, browserOn, browserSupported, today]);

  const toggleBrowser = async () => {
    if (browserOn) {
      setBrowserOn(false);
      storeSet(NOTIFY_ON_KEY, '0');
      return;
    }
    const p = await Notification.requestPermission();
    if (p === 'granted') {
      setBrowserOn(true);
      storeSet(NOTIFY_ON_KEY, '1');
    } else showToast('브라우저에서 알림 권한을 허용해야 켤 수 있어요.');
  };

  // ───────── 드래그 ─────────

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const findContainer = (id: string, it: Items) => (id.startsWith('col:') ? id.slice(4) : Object.keys(it).find((k) => it[k].includes(id)));

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    const col = findContainer(id, shownBase);
    if (col) dragOrigin.current = { columnId: col, index: shownBase[col].indexOf(id) };
    setActiveId(id);
    setDragItems(shownBase);
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
    const cols = new Set(snap.columns.filter((c) => c.boardId === id).map((c) => c.id));
    const n = snap.cards.filter((c) => cols.has(c.columnId)).length;
    if (window.confirm(`"${b.name}" 보드를 삭제할까요?\n열 ${cols.size}개와 카드 ${n}개(보관 카드 포함)도 함께 삭제돼요. (되돌리기로 복원할 수 있어요)`)) {
      run({ op: 'deleteBoard', id });
    }
  };
  const confirmDeleteCard = (c: Card, permanent = false) => {
    const msg = permanent ? `"${c.title}" 카드를 영구 삭제할까요? (되돌리기로 복원할 수 있어요)` : `"${c.title}" 카드를 삭제할까요? (되돌리기로 복원할 수 있어요)`;
    if (window.confirm(msg)) {
      if (openCardId === c.id) setOpenCardId(null);
      run({ op: 'deleteCard', id: c.id });
    }
  };
  const selectedIds = [...selected].filter((id) => visibleIds.includes(id));
  const bulk = async (body: Record<string, unknown>) => {
    if (await run({ ...body, ids: selectedIds })) setSelected(new Set());
  };

  const newestBoard = () => {
    const s = snapRef.current;
    return s ? [...s.boards].sort((a, b) => a.position - b.position).at(-1) : undefined;
  };

  const cardActions = {
    onOpen: setOpenCardId,
    onMoveTo: (cardId: string, toColumnId: string) => run({ op: 'moveCard', id: cardId, toColumnId, index: 9999 }),
    onDelete: (c: Card) => confirmDeleteCard(c),
    onDuplicate: (c: Card) => run({ op: 'duplicateCard', id: c.id }),
    onArchive: (c: Card) => run({ op: 'setArchived', ids: [c.id], archived: true }),
  };

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleLabelFilter = (c: LabelColor) =>
    setFilters((f) => ({ ...f, labels: f.labels.includes(c) ? f.labels.filter((x) => x !== c) : [...f.labels, c] }));
  const toggleAssigneeFilter = (a: string) =>
    setFilters((f) => ({ ...f, assignees: f.assignees.includes(a) ? f.assignees.filter((x) => x !== a) : [...f.assignees, a] }));

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
  const modalAssignees = (() => {
    const set = new Set<string>();
    for (const c of snap.cards) if (c.assignee && colIds.has(c.columnId)) set.add(c.assignee);
    return [...set].sort();
  })();

  return (
    <div className="app">
      <aside className="sidebar" aria-label="보드 목록">
        <h1 className="brand">칸반 보드</h1>
        <ul className="boards">
          {boards.map((b) => (
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
                    <button
                      onClick={async () => {
                        if (await run({ op: 'duplicateBoard', id: b.id })) {
                          const nb = newestBoard();
                          if (nb) setBoardId(nb.id);
                        }
                      }}
                    >
                      복제
                    </button>
                    <button
                      onClick={() => {
                        setBoardId(b.id);
                        setArchiveOpen(true);
                      }}
                    >
                      보관함
                    </button>
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
              if (await run({ op: 'createBoard', name: v })) {
                const nb = newestBoard();
                if (nb) setBoardId(nb.id);
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
          <span className={`conn ${conn}`} role="status" title="다른 탭과 실시간 연결 상태">
            {conn === 'connected' ? '● 연결됨' : conn === 'reconnecting' ? '○ 다시 연결 중…' : '○ 연결 중…'}
          </span>
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
          <Bell
            notices={notices}
            menu={menu}
            setMenu={setMenu}
            browserOn={browserOn}
            browserSupported={browserSupported}
            onToggleBrowser={toggleBrowser}
            onOpen={(n: Notice) => {
              setScope('board');
              setFilters(emptyFilters);
              setBoardId(n.boardId);
              setOpenCardId(n.cardId);
              setMenu(null);
            }}
            onDismiss={(n: Notice) => run({ op: 'dismiss', cardId: n.cardId, kind: n.kind, dueDate: n.dueDate })}
          />
          <select className="theme-select" aria-label="테마" value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
            <option value="system">시스템</option>
            <option value="light">밝게</option>
            <option value="dark">어둡게</option>
          </select>
        </header>

        <div className="filterbar">
          <select aria-label="검색 범위" value={scope} onChange={(e) => setScope(e.target.value as 'board' | 'all')}>
            <option value="board">현재 보드</option>
            <option value="all">모든 보드</option>
          </select>
          <input
            className="search"
            type="search"
            aria-label="카드 검색"
            placeholder="제목·설명 검색"
            value={filters.query}
            onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
          />
          <div className="chips" role="group" aria-label="라벨 필터">
            {LABEL_COLORS.map((c) => (
              <button
                key={c}
                className={`lbl-btn lbl-${c} ${filters.labels.includes(c) ? 'on' : ''}`}
                aria-pressed={filters.labels.includes(c)}
                aria-label={`${LABEL_NAMES[c]} 라벨 필터`}
                title={`${LABEL_NAMES[c]} 라벨만 보기`}
                onClick={() => toggleLabelFilter(c)}
              >
                {filters.labels.includes(c) ? '✓' : ''}
              </button>
            ))}
          </div>
          <span className="menu" onClick={(e) => e.stopPropagation()}>
            <button aria-haspopup="true" aria-expanded={menu === 'assignee'} onClick={() => setMenu(menu === 'assignee' ? null : 'assignee')}>
              담당자{filters.assignees.length + (filters.noAssignee ? 1 : 0) > 0 ? ` (${filters.assignees.length + (filters.noAssignee ? 1 : 0)})` : ''} ▾
            </button>
            {menu === 'assignee' && (
              <div className="menu-pop left" role="group" aria-label="담당자 필터">
                <label className="check-opt">
                  <input type="checkbox" checked={filters.noAssignee} onChange={(e) => setFilters((f) => ({ ...f, noAssignee: e.target.checked }))} />
                  담당자 없음
                </label>
                {assignees.map((a) => (
                  <label key={a} className="check-opt">
                    <input type="checkbox" checked={filters.assignees.includes(a)} onChange={() => toggleAssigneeFilter(a)} />
                    {a}
                  </label>
                ))}
              </div>
            )}
          </span>
          {filtered && (
            <button className="link" onClick={() => setFilters(emptyFilters)}>
              필터 지우기
            </button>
          )}
          <div className="spacer" />
          {scope === 'board' && (
            <>
              <div className="seg" role="group" aria-label="보기 방식">
                <button className={view === 'kanban' ? 'on' : ''} aria-pressed={view === 'kanban'} onClick={() => setView('kanban')}>
                  칸반
                </button>
                <button className={view === 'due' ? 'on' : ''} aria-pressed={view === 'due'} onClick={() => setView('due')}>
                  마감일
                </button>
              </div>
              {view === 'due' && (
                <label className="inline-check">
                  <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
                  완료 포함
                </label>
              )}
              <button
                aria-pressed={selectMode}
                className={selectMode ? 'on' : ''}
                onClick={() => {
                  setSelectMode((m) => !m);
                  setSelected(new Set());
                }}
              >
                {selectMode ? '선택 끝내기' : '선택'}
              </button>
              <button onClick={() => setArchiveOpen(true)} disabled={!board}>
                보관함{archivedCards.length > 0 ? ` (${archivedCards.length})` : ''}
              </button>
            </>
          )}
        </div>

        {!board && scope === 'board' ? (
          <div className="center">
            <p>첫 보드를 만들어 보세요.</p>
            <button className="primary" onClick={() => setCreatingBoard(true)}>
              + 새 보드
            </button>
          </div>
        ) : scope === 'all' ? (
          <AllSearchResults
            boards={boards}
            columns={snap.columns}
            cards={allMatches}
            hasFilter={filtered}
            today={today}
            metaOf={metaOf}
            onPick={(card, bId) => {
              setFilters(emptyFilters);
              setScope('board');
              setView('kanban');
              setBoardId(bId);
              setOpenCardId(card.id);
            }}
          />
        ) : view === 'due' ? (
          <DueView
            cards={dueCards}
            columns={columns}
            today={today}
            includeDone={showDone}
            metaOf={metaOf}
            selecting={selectMode}
            selected={selected}
            onToggleSelect={toggleSelect}
            onOpen={setOpenCardId}
          />
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
            <div className="columns">
              {filtered && <div className="filter-note" role="status">필터를 쓰는 동안에는 카드를 끌어서 옮길 수 없어요. 카드 메뉴(⋯)나 카드 안의 ‘소속 열’로 옮겨 주세요.</div>}
              {columns.map((col, i) => (
                <ColumnView
                  key={col.id}
                  col={col}
                  index={i}
                  total={columns.length}
                  cardIds={items[col.id] ?? []}
                  hiddenCount={filtered ? (allBase[col.id]?.length ?? 0) - (items[col.id]?.length ?? 0) : 0}
                  cardById={cardById}
                  metaOf={metaOf}
                  today={today}
                  menu={menu}
                  setMenu={setMenu}
                  columns={columns}
                  dragDisabled={dragDisabled}
                  selecting={selectMode}
                  selected={selected}
                  onToggleSelect={toggleSelect}
                  onRename={(name) => run({ op: 'renameColumn', id: col.id, name })}
                  onDelete={() => confirmDeleteColumn(col)}
                  onMove={(dir) => run({ op: 'moveColumn', id: col.id, dir })}
                  onToggleDone={() => run({ op: 'setColumnDone', id: col.id, done: !col.isDone })}
                  onAddCard={(title) => run({ op: 'addCard', columnId: col.id, title })}
                  actions={cardActions}
                />
              ))}
              <AddColumn onAdd={(name) => board && run({ op: 'addColumn', boardId: board.id, name })} />
            </div>
            <DragOverlay>
              {activeCard ? <CardFace card={activeCard} overdue={isOverdue(activeCard, columns.find((c) => c.id === activeCard.columnId), today)} meta={metaOf(activeCard.id)} /> : null}
            </DragOverlay>
          </DndContext>
        )}
      </main>

      {selectMode && scope === 'board' && (
        <div className="bulkbar" role="toolbar" aria-label="선택한 카드 작업">
          <strong>{selectedIds.length}개 선택</strong>
          <button onClick={() => setSelected(new Set(visibleIds))}>보이는 카드 전체 선택</button>
          <select
            aria-label="선택한 카드를 열로 이동"
            disabled={selectedIds.length === 0}
            value=""
            onChange={(e) => e.target.value && bulk({ op: 'bulkMove', toColumnId: e.target.value })}
          >
            <option value="">열 이동…</option>
            {columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.isDone ? ' (완료)' : ''}
              </option>
            ))}
          </select>
          <button disabled={selectedIds.length === 0} onClick={() => bulk({ op: 'setArchived', archived: true })}>
            보관
          </button>
          <button
            className="danger"
            disabled={selectedIds.length === 0}
            onClick={() => {
              if (window.confirm(`선택한 카드 ${selectedIds.length}개를 삭제할까요? (되돌리기로 복원할 수 있어요)`)) bulk({ op: 'bulkDelete' });
            }}
          >
            삭제
          </button>
          <button onClick={() => setSelected(new Set())}>선택 해제</button>
        </div>
      )}

      {archiveOpen && board && (
        <ArchiveModal
          cards={archivedCards}
          columns={columns}
          onRestore={(c) => run({ op: 'setArchived', ids: [c.id], archived: false })}
          onDelete={(c) => confirmDeleteCard(c, true)}
          onClose={() => setArchiveOpen(false)}
        />
      )}

      {openCard && (
        <CardModal
          key={openCard.id}
          card={openCard}
          columns={columns.length > 0 && colIds.has(openCard.columnId) ? columns : snap.columns.filter((c) => c.boardId === snap.columns.find((x) => x.id === openCard.columnId)?.boardId).sort((a, b) => a.position - b.position)}
          assignees={modalAssignees}
          checks={snap.checks.filter((c) => c.cardId === openCard.id).sort((a, b) => a.position - b.position)}
          comments={snap.comments.filter((c) => c.cardId === openCard.id)}
          attachments={snap.attachments.filter((a) => a.cardId === openCard.id)}
          status={status}
          onSave={async (fields) => {
            const ok = await run({ op: 'updateCard', id: openCard.id, fields });
            if (ok && fields.dueDate === null && openCard.repeat !== 'none') showToast('마감일이 없어서 반복을 "없음"으로 바꿨어요.');
            return ok;
          }}
          onMoveTo={(toColumnId) => run({ op: 'moveCard', id: openCard.id, toColumnId, index: 9999 })}
          act={run}
          onUpload={(file) => doUpload(openCard.id, file)}
          onDelete={() => confirmDeleteCard(openCard)}
          onDuplicate={() => run({ op: 'duplicateCard', id: openCard.id })}
          onArchive={async () => {
            if (await run({ op: 'setArchived', ids: [openCard.id], archived: true })) setOpenCardId(null);
          }}
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
