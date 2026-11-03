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
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { History } from '../lib/history';
import { emptyFilters, groupByDue, hasFilters, matchCard, type Filters } from '../lib/filter';
import { computeNotices, NOTICE_TEXT, type Notice } from '../lib/notices';
import { applyChanges } from '../lib/sync';
import { LABEL_COLORS, LABEL_NAMES, LIMITS, type Card, type Column, type Kind, type LabelColor, type Patch, type Snapshot } from '../lib/types';
import { fetchChanges, fetchState, mutate, uploadFile, type Act, type Body } from './api';
import { AddColumn, CardFace, ColumnView, noMeta, type CardMeta } from './Board';
import { CardModal } from './CardModal';
import { InlineEdit, Menu } from './ui';
import { isOverdue, isTyping, localToday, placeCard, store, storeSet } from './util';
import { AllSearchResults, ArchiveModal, Bell, DueView } from './Views';

type Status = 'idle' | 'saving' | 'saved' | 'error';
type Items = Record<string, string[]>;
type Theme = 'system' | 'light' | 'dark';

const LAST_BOARD_KEY = 'kanban:lastBoard';
const THEME_KEY = 'kanban:theme';
const NOTIFY_ON_KEY = 'kanban:browserNotify';
const NOTIFIED_KEY = 'kanban:notified';
const DRAG_HELP =
  '카드를 열려면 Enter, 옮기려면 스페이스를 누르세요. 옮기는 중에는 화살표 키로 움직이고 스페이스나 Enter로 놓아요. Esc를 누르면 취소돼요.';

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

  /** 화면에 보이는 상태 = 서버가 확인해 준 상태(baseRef) + 아직 응답을 기다리는 낙관적 변경들 */
  const snapRef = useRef<Snapshot | null>(null);
  const baseRef = useRef<Snapshot | null>(null);
  const optimistic = useRef(new Map<number, (s: Snapshot) => Snapshot>());
  const opSeq = useRef(0);
  /** 이 탭의 변경 요청은 한 줄로 세워 보낸 순서대로 하나씩 처리한다 (응답 순서·되돌리기 이력이 꼬이지 않게) */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pendingOps = useRef(0);
  const lastResult = useRef<Status>('idle');
  const history = useRef(new History(LIMITS.undoSteps));
  const dragOrigin = useRef<{ columnId: string; index: number } | null>(null);
  const dragItemsRef = useRef<Items | null>(null);
  dragItemsRef.current = dragItems;
  const dragMoved = useRef(false); // 끌기 시작 뒤 실제로 움직였는지 (화면 읽기 안내용)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncing = useRef(false);

  const render = useCallback(() => {
    let s = baseRef.current;
    if (!s) return;
    for (const f of optimistic.current.values()) s = f(s);
    snapRef.current = s; // 화면 갱신을 기다리지 않고 ref도 바로 맞춘다 (직후 코드가 최신 값을 보게)
    setSnap(s);
  }, []);

  const commit = useCallback(
    (s: Snapshot) => {
      // 늦게 도착한 옛 응답이 이미 반영된 최신 상태(다른 탭의 변경 포함)를 덮어쓰지 않게 한다.
      // 서버의 번호가 클수록 더 많은 변경을 담고 있으므로, 같거나 더 큰 번호만 받아들인다.
      const cur = baseRef.current;
      if (!cur || s.revision >= cur.revision) baseRef.current = s;
      render();
    },
    [render],
  );

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
      // 이미 화면에 데이터가 있으면 화면(열어 둔 카드 포함)을 지우지 않고 안내만 한다
      if (baseRef.current) showToast((e as Error).message);
      else setLoadError((e as Error).message);
    }
  }, [commit, showToast]);
  useEffect(() => {
    load();
    const t = store(THEME_KEY);
    if (t === 'light' || t === 'dark') setTheme(t);
    setBrowserOn(store(NOTIFY_ON_KEY) === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted');
  }, [load]);

  const themeReady = useRef(false);
  useEffect(() => {
    // 처음 한 번은 건너뛴다: 저장된 테마를 읽기 전의 기본값('system')으로 저장값을 덮어쓰지 않게
    if (!themeReady.current) {
      themeReady.current = true;
      return;
    }
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null); // 알림·담당자 등 열린 작은 창을 Esc로 닫는다
    };
    document.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
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
        const cur = baseRef.current;
        if (!cur) break;
        const ch = await fetchChanges(cur.revision);
        const latest = baseRef.current;
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
    // 브라우저는 주소 하나에 동시 연결을 6개까지만 연다. 탭마다 실시간 연결을 붙잡으면 탭 6개부터 앱이 멈춘다.
    // 그래서 실시간 연결은 "대표 탭" 하나만 맺고, 받은 소식을 같은 브라우저의 다른 탭에 나눠 준다.
    // 대표 탭이 닫히면 기다리던 다른 탭이 자동으로 대표를 이어받는다 (Web Locks).
    let stopped = false;
    let es: EventSource | null = null;
    let up = false; // 대표 탭의 실시간 연결이 지금 살아 있는지
    let heardUp = false; // 다른 탭: 대표 탭이 연결됐다고 알려 왔는지
    let lastMsg = Date.now(); // 대표: 서버 신호를 마지막으로 받은 때 / 다른 탭: 대표 소식을 마지막으로 받은 때
    let retry: ReturnType<typeof setTimeout> | null = null;
    let leaderTimer: ReturnType<typeof setInterval> | null = null;
    const abort = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('kanban:sync') : null;
    const locks = (navigator as Navigator & { locks?: { request: (name: string, opts: { signal?: AbortSignal }, cb: () => Promise<void>) => Promise<unknown> } }).locks;
    const shared = !!(bc && locks?.request);
    const tell = (m: Record<string, unknown>) => {
      try {
        bc?.postMessage(m);
      } catch {
        /* 탭끼리 소식을 못 나눠도 각 탭은 아래의 주기 확인으로 따라온다 */
      }
    };
    const onChange = (rev: number) => {
      // 내가 보낸 변경이 돌아온 것(이미 반영된 번호)은 무시한다
      if (Number.isFinite(rev) && baseRef.current && rev > baseRef.current.revision) catchUp();
    };

    const lead = () => {
      const connect = () => {
        if (stopped) return;
        es?.close();
        const src = new EventSource('/api/events');
        es = src;
        lastMsg = Date.now();
        src.onopen = () => {
          lastMsg = Date.now();
          up = true;
          setConn('connected');
          tell({ t: 'up' });
          catchUp(); // 끊긴 동안 놓친 변경을 마지막 번호 이후로 가져온다
        };
        src.addEventListener('ping', () => {
          lastMsg = Date.now();
          tell({ t: up ? 'up' : 'down' });
        });
        src.addEventListener('change', (ev) => {
          lastMsg = Date.now();
          const rev = Number((ev as MessageEvent).data);
          tell({ t: 'change', rev });
          onChange(rev);
        });
        src.onerror = () => {
          up = false;
          setConn('reconnecting');
          tell({ t: 'down' });
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
      leaderTimer = setInterval(() => {
        if (Date.now() - lastMsg > 40_000) {
          up = false;
          setConn('reconnecting');
          tell({ t: 'down' });
          connect();
        }
      }, 10_000);
    };

    if (bc) {
      bc.onmessage = (e: MessageEvent) => {
        const m = e.data as { t?: string; rev?: number } | null;
        if (!m || !m.t) return;
        if (es) {
          // 나는 대표 탭: 새로 열린 탭이 지금 상태를 물으면 알려 준다
          if (m.t === 'hello') tell({ t: up ? 'up' : 'down' });
          return;
        }
        lastMsg = Date.now();
        if (m.t === 'change') onChange(Number(m.rev));
        else if (m.t === 'up') {
          if (!heardUp) {
            heardUp = true;
            setConn('connected');
            catchUp(); // 연결된 직후: 놓친 변경을 가져온다
          }
        } else if (m.t === 'down') {
          heardUp = false;
          setConn('reconnecting');
        }
      };
    }

    let followerTimer: ReturnType<typeof setInterval> | null = null;
    if (shared) {
      locks!
        .request('kanban:live', { signal: abort?.signal }, () => {
          if (stopped) return Promise.resolve();
          lead();
          return new Promise<void>((resolve) => abort?.signal.addEventListener('abort', () => resolve()));
        })
        .catch(() => {
          /* 탭을 닫으면 기다리던 요청이 취소된다 */
        });
      tell({ t: 'hello' });
      // 대표 탭의 소식이 한동안 없으면(대표 탭이 멈췄거나 바뀌는 중) 이 탭이 직접 변경을 확인한다
      followerTimer = setInterval(() => {
        if (es) return;
        if (Date.now() - lastMsg > 40_000) {
          heardUp = false;
          setConn('reconnecting');
          catchUp();
          tell({ t: 'hello' });
        }
      }, 10_000);
    } else {
      lead(); // 탭끼리 소식을 나눌 수 없는 오래된 브라우저: 탭마다 직접 연결
    }

    // 탭을 다시 볼 때 놓친 변경이 없는지 한 번 확인한다
    const onVisible = () => {
      if (document.visibilityState === 'visible') catchUp();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (leaderTimer) clearInterval(leaderTimer);
      if (followerTimer) clearInterval(followerTimer);
      if (retry) clearTimeout(retry);
      es?.close();
      es = null;
      abort?.abort(); // 대표였다면 대표 자리를 내놓고, 기다리던 중이면 기다림을 취소한다
      bc?.close();
    };
  }, [hasSnap, catchUp]);

  // ───────── 서버에 변경 보내기 ─────────

  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const p = queue.current.then(task);
    queue.current = p.catch(() => undefined);
    return p;
  }, []);

  /** 요청 하나가 끝났을 때 상단의 저장 상태를 정한다 (아직 남은 요청이 있으면 '저장 중') */
  const settle = useCallback((result: Status) => {
    pendingOps.current = Math.max(0, pendingOps.current - 1);
    if (result !== 'idle') lastResult.current = result;
    setStatus(result === 'error' ? 'error' : pendingOps.current > 0 ? 'saving' : lastResult.current);
    bump((n) => n + 1);
  }, []);

  const run: Act = useCallback(
    (body, optimisticFn) => {
      const id = ++opSeq.current;
      pendingOps.current++;
      setStatus('saving');
      if (optimisticFn) {
        optimistic.current.set(id, optimisticFn);
        render();
      }
      return enqueue(async () => {
        try {
          const base = baseRef.current;
          const b: Body | null = typeof body === 'function' ? (base ? body(base) : null) : body;
          if (!b) {
            // 보낼 것이 없어졌다 (예: 이미 그 상태이거나 카드가 사라짐)
            optimistic.current.delete(id);
            render();
            settle('idle');
            return true;
          }
          const res = await mutate({ ...b, today: localToday() }); // 완료한 날짜는 브라우저의 로컬 날짜
          optimistic.current.delete(id);
          commit(res.snapshot);
          if (res.entry) history.current.push(res.entry);
          settle('saved');
          return true;
        } catch (e) {
          // 실패한 변경만 화면에서 걷어 낸다 (다른 요청의 변경이나 다른 탭의 변경은 그대로)
          optimistic.current.delete(id);
          render();
          settle('error');
          showToast((e as Error).message);
          return false;
        }
      });
    },
    [enqueue, render, commit, settle, showToast],
  );

  // 첨부 업로드는 오래 걸릴 수 있어 줄을 세우지 않는다 (그동안 다른 작업이 막히지 않게)
  const doUpload = useCallback(
    async (cardId: string, file: File) => {
      pendingOps.current++;
      setStatus('saving');
      try {
        const res = await uploadFile(cardId, file);
        commit(res.snapshot);
        if (res.entry) history.current.push(res.entry);
        settle('saved');
      } catch (e) {
        settle('error');
        throw e;
      }
    },
    [commit, settle],
  );

  /** 바뀐 내용이 어느 보드의 것인지: 새로 생기거나 바뀐 것은 실행 뒤 상태에서, 지워진 것은 실행 전 상태에서 찾는다 */
  const boardOfPatch = (p: Patch, before: Snapshot | null, after: Snapshot): string | null => {
    const find = (s: Snapshot | null, kind: Kind, id: string): string | null => {
      if (!s) return null;
      const colBoard = (colId: string) => s.columns.find((c) => c.id === colId)?.boardId ?? null;
      const cardBoard = (cardId: string) => {
        const c = s.cards.find((x) => x.id === cardId);
        return c ? colBoard(c.columnId) : null;
      };
      const byCard = (rows: { id: string; cardId: string }[]) => {
        const r = rows.find((x) => x.id === id);
        return r ? cardBoard(r.cardId) : null;
      };
      if (kind === 'board') return s.boards.some((b) => b.id === id) ? id : null;
      if (kind === 'column') return colBoard(id);
      if (kind === 'card') return cardBoard(id);
      if (kind === 'check') return byCard(s.checks);
      if (kind === 'comment') return byCard(s.comments);
      return byCard(s.attachments);
    };
    for (const u of p.upsert) {
      const b = find(after, u.kind, (u.row as { id: string }).id);
      if (b) return b;
    }
    for (const r of p.remove) {
      const b = find(before, r.kind, r.id);
      if (b) return b;
    }
    return null;
  };

  const step = useCallback(
    (dir: 'undo' | 'redo'): Promise<void> => {
      const h = history.current;
      // 되돌릴 것도 없고 처리 중인 요청도 없으면 할 일이 없다
      if (!(dir === 'undo' ? h.canUndo() : h.canRedo()) && pendingOps.current === 0) return Promise.resolve();
      pendingOps.current++;
      setStatus('saving');
      return enqueue(async () => {
        // 앞선 요청이 모두 끝난 "내 차례"에 이력의 맨 위 항목을 고른다 (빠르게 여러 번 눌러도 하나씩 차례로)
        const e = dir === 'undo' ? h.peekUndo() : h.peekRedo();
        if (!e) {
          settle('idle');
          return;
        }
        const before = baseRef.current;
        try {
          const patch = dir === 'undo' ? e.inverse : e.forward;
          const res: any = await mutate({ op: 'patch', patch, expect: e.expect });
          commit(res.snapshot);
          if (res.conflict) {
            if (dir === 'undo') h.dropUndo(e);
            else h.dropRedo(e);
            showToast(
              res.reason === 'file'
                ? '보관 기간이 지나 파일이 정리되어 복원할 수 없어요. 이 단계는 건너뛰었어요.'
                : '다른 탭에서 바뀐 내용이라 덮어쓰지 않고 이 단계를 건너뛰었어요.',
            );
            settle('idle');
          } else {
            if (dir === 'undo') h.commitUndo(res.touched, e);
            else h.commitRedo(res.touched, e);
            const after = res.snapshot as Snapshot;
            const target = boardOfPatch(patch, before, after);
            if (target && after.boards.some((b) => b.id === target)) setBoardId(target);
            settle('saved');
          }
        } catch (err) {
          settle('error');
          showToast((err as Error).message);
        }
      });
    },
    [enqueue, commit, settle, showToast],
  );

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      // 한글 입력 상태에서는 key 값이 'ㅋ'처럼 올 수 있어 실제 키 위치(code)도 함께 본다
      if (!(ev.ctrlKey || ev.metaKey) || (ev.key.toLowerCase() !== 'z' && ev.code !== 'KeyZ')) return;
      if (isTyping(ev.target)) return; // 글 입력 중에는 입력창 자체의 되돌리기를 쓴다
      ev.preventDefault();
      void step(ev.shiftKey ? 'redo' : 'undo');
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
    // 다른 보드에서 고른 담당자도 목록에 남겨 둔다 (여기서도 체크를 풀 수 있게)
    for (const a of filters.assignees) set.add(a);
    return [...set].sort();
  }, [snap, scope, colIds, filters.assignees]);

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
      showToast('열어 둔 카드가 삭제되어 창을 닫았어요.');
    }
  }, [openCardId, snap, cardById, showToast]);

  // ───────── 브라우저 알림 ─────────

  const browserSupported = typeof Notification !== 'undefined';
  useEffect(() => {
    if (!browserOn || !browserSupported || Notification.permission !== 'granted' || notices.length === 0) return;
    const show = () => {
      let shown: string[];
      try {
        shown = (JSON.parse(store(NOTIFIED_KEY) ?? '[]') as string[]).filter((k) => k.endsWith(`|${today}`));
      } catch {
        shown = [];
      }
      for (const n of notices) {
        const k = `${n.cardId}|${n.kind}|${n.dueDate}|${today}`;
        if (shown.includes(k)) continue;
        shown = [...shown, k];
        storeSet(NOTIFIED_KEY, JSON.stringify(shown));
        try {
          new Notification(`${NOTICE_TEXT[n.kind]}: ${n.title}`, { body: `${n.boardName} · 마감 ${n.dueDate}` });
        } catch {
          /* 알림을 못 띄워도 앱은 계속 동작한다 */
        }
      }
    };
    // 여러 탭이 같은 변경을 동시에 받아도 한 번만 알리도록, 탭끼리 차례를 정하는 잠금 안에서 확인·기록·표시한다
    const locks = (navigator as Navigator & { locks?: { request: (name: string, cb: () => unknown) => Promise<unknown> } }).locks;
    if (locks?.request) locks.request('kanban:notify', show).catch(show);
    else show();
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
    // 스페이스로 끌기 시작, Enter는 카드 열기에 쓴다 (끄는 중에는 스페이스·Enter로 놓기, Esc로 취소)
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter', 'Tab'] },
    }),
  );
  const findContainer = (id: string, it: Items) => (id.startsWith('col:') ? id.slice(4) : Object.keys(it).find((k) => it[k].includes(id)));

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    const col = findContainer(id, shownBase);
    if (col) dragOrigin.current = { columnId: col, index: shownBase[col].indexOf(id) };
    dragMoved.current = false;
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
    const order = final[ac];
    // 응답이 올 때까지 옮긴 카드 하나만 새 자리에 보여 준다 (실패하면 이 카드만 제자리로 돌아감)
    void run({ op: 'moveCard', id: aid, toColumnId: ac, index }, (s) => ({ ...s, cards: placeCard(s.cards, aid, ac, order[index - 1], order[index + 1]) }));
  };
  const onDragCancel = () => {
    setDragItems(null);
    setActiveId(null);
    dragOrigin.current = null;
  };

  // 화면 읽기 프로그램용 안내 (카드 제목과 열 이름으로 알려 준다)
  const titleOf = (id: UniqueIdentifier) => cardById.get(String(id))?.title ?? '카드';
  const colNameOf = (id: UniqueIdentifier | undefined) => {
    if (id === undefined) return null;
    const key = String(id);
    const colId = key.startsWith('col:') ? key.slice(4) : findContainer(key, dragItemsRef.current ?? shownBase);
    return columns.find((c) => c.id === colId)?.name ?? null;
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => `"${titleOf(active.id)}" 카드를 집었어요.`,
    onDragOver: ({ active, over }) => {
      // 막 집은 순간(자기 자리 위)에는 "집었어요" 안내를 덮어쓰지 않는다
      if (over && String(over.id) === String(active.id) && !dragMoved.current) return undefined;
      dragMoved.current = true;
      const c = colNameOf(over?.id);
      return c ? `"${titleOf(active.id)}" 카드가 "${c}" 열 위에 있어요.` : `"${titleOf(active.id)}" 카드가 놓을 수 있는 곳 밖에 있어요.`;
    },
    onDragEnd: ({ active, over }) => {
      const c = colNameOf(over?.id);
      return c ? `"${titleOf(active.id)}" 카드를 "${c}" 열에 놓았어요.` : `"${titleOf(active.id)}" 카드를 제자리에 두었어요.`;
    },
    onDragCancel: ({ active }) => `"${titleOf(active.id)}" 카드 옮기기를 취소했어요.`,
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

  /** 카드를 다른 열의 맨 끝으로 옮긴다 (응답 전에도 화면에서 바로 옮겨 보인다) */
  const moveToEnd = (cardId: string, toColumnId: string) =>
    run({ op: 'moveCard', id: cardId, toColumnId, index: 9999 }, (s) => ({ ...s, cards: placeCard(s.cards, cardId, toColumnId) }));

  const cardActions = {
    onOpen: setOpenCardId,
    onMoveTo: (cardId: string, toColumnId: string) => void moveToEnd(cardId, toColumnId),
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

  if (loadError && !snap) {
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
                  onSave={async (v) => {
                    if (v === b.name) {
                      setRenamingBoard(null);
                      return true;
                    }
                    const ok = await run({ op: 'renameBoard', id: b.id, name: v });
                    if (ok) setRenamingBoard(null);
                    return ok; // 실패하면 쓴 이름을 남겨 두고 다시 고칠 수 있게 한다
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
              const ok = await run({ op: 'createBoard', name: v });
              if (ok) {
                setCreatingBoard(false);
                const nb = newestBoard();
                if (nb) setBoardId(nb.id);
              }
              return ok;
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
          <button onClick={() => void step('undo')} disabled={!h.canUndo()} title="되돌리기 (Ctrl+Z)" aria-label="되돌리기">
            ↶ 되돌리기
          </button>
          <button onClick={() => void step('redo')} disabled={!h.canRedo()} title="다시 실행 (Ctrl+Shift+Z)" aria-label="다시 실행">
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
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
            onDragCancel={onDragCancel}
            accessibility={{ announcements, screenReaderInstructions: { draggable: DRAG_HELP } }}
          >
            {filtered && (
              <div className="filter-note" role="status">
                필터를 쓰는 동안에는 카드를 끌어서 옮길 수 없어요. 카드 메뉴(⋯)나 카드 안의 ‘소속 열’로 옮겨 주세요.
              </div>
            )}
            <div className="columns">
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
              <AddColumn onAdd={(name) => (board ? run({ op: 'addColumn', boardId: board.id, name }) : Promise.resolve(false))} />
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
          onMoveTo={(toColumnId) => moveToEnd(openCard.id, toColumnId)}
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
