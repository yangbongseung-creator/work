'use client';

import { useEffect, useRef, useState } from 'react';
import { DUE_GROUP_TITLES, groupByDue } from '../lib/filter';
import { NOTICE_TEXT, type Notice } from '../lib/notices';
import type { Board, Card, Column } from '../lib/types';
import { CardFace, noMeta, type CardMeta } from './Board';
import { isBackdropPress, useFocusTrap } from './ui';
import { isOverdue } from './util';

/** 마감일순 보기: 지남 · 오늘 · 예정 · 마감일 없음 */
export function DueView(props: {
  cards: Card[];
  columns: Column[];
  today: string;
  includeDone: boolean;
  metaOf: (id: string) => CardMeta;
  selecting: boolean;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const groups = groupByDue(props.cards, props.columns, props.today, props.includeDone);
  const colById = new Map(props.columns.map((c) => [c.id, c]));
  return (
    <div className="due-view">
      {groups.map((g) => (
        <section key={g.key} className={`due-group due-${g.key}`} aria-label={`${DUE_GROUP_TITLES[g.key]} 묶음`}>
          <h3>
            {DUE_GROUP_TITLES[g.key]} <span className="muted">{g.cards.length}</span>
          </h3>
          {g.cards.length === 0 && <p className="muted small">카드가 없어요.</p>}
          {g.cards.map((c) => (
            <div
              key={c.id}
              role="button"
              tabIndex={0}
              className="due-row"
              data-card-id={c.id}
              onClick={() => (props.selecting ? props.onToggleSelect(c.id) : props.onOpen(c.id))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (props.selecting) props.onToggleSelect(c.id);
                  else props.onOpen(c.id);
                }
              }}
            >
              <CardFace card={c} overdue={isOverdue(c, colById.get(c.columnId), props.today)} meta={props.metaOf(c.id)} selecting={props.selecting} selected={props.selected.has(c.id)} />
              <span className="muted small col-name">{colById.get(c.columnId)?.name}</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/** 모든 보드 검색 결과 (보드별로 묶음) */
export function AllSearchResults(props: {
  boards: Board[];
  columns: Column[];
  cards: Card[]; // 조건에 맞는 카드만
  hasFilter: boolean;
  today: string;
  metaOf: (id: string) => CardMeta;
  onPick: (card: Card, boardId: string) => void;
}) {
  const colById = new Map(props.columns.map((c) => [c.id, c]));
  if (!props.hasFilter) return <div className="center muted">검색어를 쓰거나 라벨·담당자 필터를 골라 주세요.</div>;
  const groups = props.boards
    .map((b) => ({ board: b, cards: props.cards.filter((c) => colById.get(c.columnId)?.boardId === b.id) }))
    .filter((g) => g.cards.length > 0);
  if (groups.length === 0) return <div className="center muted">조건에 맞는 카드가 없어요.</div>;
  return (
    <div className="results">
      {groups.map((g) => (
        <section key={g.board.id} aria-label={`${g.board.name} 검색 결과`}>
          <h3>
            {g.board.name} <span className="muted">{g.cards.length}</span>
          </h3>
          {g.cards.map((c) => (
            <button key={c.id} className="result-row" onClick={() => props.onPick(c, g.board.id)}>
              <CardFace card={c} overdue={isOverdue(c, colById.get(c.columnId), props.today)} meta={props.metaOf(c.id) ?? noMeta} />
              <span className="muted small col-name">{colById.get(c.columnId)?.name}</span>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}

/** 보관함: 현재 보드의 보관 카드를 검색·복원·영구 삭제 */
export function ArchiveModal(props: {
  cards: Card[];
  columns: Column[];
  onRestore: (c: Card) => void;
  onDelete: (c: Card) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  useFocusTrap(dialog);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.isComposing && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const colById = new Map(props.columns.map((c) => [c.id, c]));
  const query = q.trim().toLowerCase();
  const list = props.cards.filter((c) => !query || c.title.toLowerCase().includes(query) || c.description.toLowerCase().includes(query));
  return (
    <div className="backdrop" onMouseDown={(e) => isBackdropPress(e) && props.onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="보관함" ref={dialog}>
        <div className="modal-head">
          <h3 style={{ margin: 0 }}>보관함 <span className="muted">{props.cards.length}</span></h3>
          <div className="spacer" />
          <button className="icon-btn" aria-label="닫기" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <input autoFocus placeholder="보관함 검색" aria-label="보관함 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        {list.length === 0 && <p className="muted">{props.cards.length === 0 ? '보관된 카드가 없어요.' : '조건에 맞는 카드가 없어요.'}</p>}
        {list.map((c) => (
          <div key={c.id} className="archive-row">
            <div className="grow">
              <div>{c.title}</div>
              <div className="muted small">
                {colById.get(c.columnId)?.name}
                {c.dueDate ? ` · ${c.dueDate}` : ''}
              </div>
            </div>
            <button onClick={() => props.onRestore(c)}>복원</button>
            <button className="danger" onClick={() => props.onDelete(c)}>
              영구 삭제
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 마감 알림 벨 */
export function Bell(props: {
  notices: Notice[];
  menu: string | null;
  setMenu: (v: string | null) => void;
  browserOn: boolean;
  browserSupported: boolean;
  onToggleBrowser: () => void;
  onOpen: (n: Notice) => void;
  onDismiss: (n: Notice) => void;
}) {
  const open = props.menu === 'bell';
  return (
    <span className="menu" onClick={(e) => e.stopPropagation()}>
      <button
        className="icon-btn bell-btn"
        aria-label={`마감 알림 ${props.notices.length}개`}
        aria-expanded={open}
        onClick={() => props.setMenu(open ? null : 'bell')}
      >
        🔔{props.notices.length > 0 && <span className="badge">{props.notices.length}</span>}
      </button>
      {open && (
        <div className="menu-pop bell-pop" role="dialog" aria-label="마감 알림 목록">
          {props.notices.length === 0 && <p className="muted pad">새 알림이 없어요.</p>}
          {props.notices.map((n) => (
            <div key={`${n.cardId}|${n.kind}|${n.dueDate}`} className="notice">
              <button className="notice-main" onClick={() => props.onOpen(n)}>
                <span className={`notice-kind k-${n.kind}`}>{NOTICE_TEXT[n.kind]}</span>
                <span className="notice-title">{n.title}</span>
                <span className="muted small">
                  {n.boardName} · {n.dueDate}
                </span>
              </button>
              <button className="icon-btn" aria-label={`${n.title} 알림 닫기`} onClick={() => props.onDismiss(n)}>
                ✕
              </button>
            </div>
          ))}
          <hr />
          {props.browserSupported ? (
            <button className="pad-btn" onClick={props.onToggleBrowser}>
              {props.browserOn ? '브라우저 알림 끄기' : '브라우저 알림 켜기'}
            </button>
          ) : (
            <p className="muted small pad">이 브라우저는 알림을 지원하지 않아요.</p>
          )}
        </div>
      )}
    </span>
  );
}
