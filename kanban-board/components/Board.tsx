'use client';

import { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { LIMITS, type Card, type Column } from '../lib/types';
import { InlineEdit, LabelDot, Menu, isComposingKey, useEnterSubmit } from './ui';
import { isOverdue } from './util';

export type CardMeta = { checkDone: number; checkTotal: number; comments: number; attachments: number };
export const noMeta: CardMeta = { checkDone: 0, checkTotal: 0, comments: 0, attachments: 0 };

export function CardFace({ card, overdue, meta, selecting, selected }: { card: Card; overdue: boolean; meta: CardMeta; selecting?: boolean; selected?: boolean }) {
  const hasMeta = card.dueDate || card.assignee || meta.checkTotal > 0 || meta.comments > 0 || meta.attachments > 0;
  return (
    <div className={`card ${overdue ? 'overdue' : ''} ${selected ? 'selected' : ''}`}>
      {card.labels.length > 0 && (
        <div className="card-labels">
          {card.labels.map((l) => (
            <LabelDot key={l} color={l} />
          ))}
        </div>
      )}
      <div className="card-title">
        {selecting && <input type="checkbox" readOnly checked={!!selected} aria-label="카드 선택" tabIndex={-1} className="sel-box" />}
        {card.title}
      </div>
      {hasMeta && (
        <div className="card-meta">
          {card.dueDate && <span className={`due ${overdue ? 'late' : ''}`}>{card.dueDate}</span>}
          {card.repeat !== 'none' && <span title="반복">🔁</span>}
          {meta.checkTotal > 0 && <span title="체크리스트">☑ {meta.checkDone}/{meta.checkTotal}</span>}
          {meta.comments > 0 && <span title="댓글">💬 {meta.comments}</span>}
          {meta.attachments > 0 && <span title="첨부파일">📎 {meta.attachments}</span>}
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

type CardActions = {
  onOpen: (id: string) => void;
  onMoveTo: (cardId: string, columnId: string) => void;
  onDelete: (c: Card) => void;
  onDuplicate: (c: Card) => void;
  onArchive: (c: Card) => void;
};

export function SortableCard(props: {
  card: Card;
  overdue: boolean;
  meta: CardMeta;
  disabled: boolean;
  selecting: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  menu: string | null;
  setMenu: (v: string | null) => void;
  columns: Column[];
  actions: CardActions;
}) {
  const { card, actions } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id, disabled: props.disabled });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  return (
    <div ref={setNodeRef} style={style} className={`card-wrap ${isDragging ? 'dragging' : ''}`}>
      <div
        {...attributes}
        {...listeners}
        aria-disabled={undefined} // 끌기가 막혀도 카드는 눌러서 열 수 있으니 "비활성"으로 읽히지 않게 한다
        data-card-id={card.id}
        className={`card-hit ${props.disabled ? 'no-drag' : ''}`}
        onClick={() => (props.selecting ? props.onToggleSelect(card.id) : actions.onOpen(card.id))}
        onKeyDown={(e) => {
          // Enter는 카드 열기, 스페이스는 끌기 시작 (끄는 중의 Enter·스페이스는 놓기라서 열지 않는다)
          if (!props.disabled && e.key === 'Enter' && !isDragging) {
            e.preventDefault();
            actions.onOpen(card.id);
            return;
          }
          listeners?.onKeyDown?.(e as never);
          if (props.disabled && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            if (props.selecting) props.onToggleSelect(card.id);
            else actions.onOpen(card.id);
          }
        }}
        aria-pressed={props.selecting ? props.selected : undefined}
        aria-label={`카드: ${card.title}`}
      >
        <CardFace card={card} overdue={props.overdue} meta={props.meta} selecting={props.selecting} selected={props.selected} />
      </div>
      {!props.selecting && (
        <div className="card-menu">
          <Menu id={`card:${card.id}`} open={props.menu} setOpen={props.setMenu} label={`${card.title} 카드 메뉴`}>
            <button onClick={() => actions.onOpen(card.id)}>열기</button>
            {props.columns
              .filter((c) => c.id !== card.columnId)
              .map((c) => (
                <button key={c.id} onClick={() => actions.onMoveTo(card.id, c.id)}>
                  “{c.name}”(으)로 이동
                </button>
              ))}
            <button onClick={() => actions.onDuplicate(card)}>복제</button>
            <button onClick={() => actions.onArchive(card)}>보관</button>
            <button className="danger" onClick={() => actions.onDelete(card)}>
              카드 삭제
            </button>
          </Menu>
        </div>
      )}
    </div>
  );
}

export function ColumnView(props: {
  col: Column;
  index: number;
  total: number;
  cardIds: string[];
  hiddenCount: number;
  cardById: Map<string, Card>;
  metaOf: (id: string) => CardMeta;
  today: string;
  menu: string | null;
  setMenu: (v: string | null) => void;
  columns: Column[];
  dragDisabled: boolean;
  selecting: boolean;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
  onToggleDone: () => void;
  onAddCard: (title: string) => Promise<boolean>;
  actions: CardActions;
}) {
  const { col } = props;
  const { setNodeRef, isOver } = useDroppable({ id: `col:${col.id}`, disabled: props.dragDisabled });
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');

  const submit = async (value: string) => {
    const t = value.trim();
    if (!t) return;
    setTitle('');
    if (!(await props.onAddCard(t))) {
      // 저장 실패: 쓴 제목을 되살려 다시 시도할 수 있게 한다 (그 사이 새로 쓴 글이 있으면 그대로 둔다)
      setTitle((cur) => (cur.trim() ? cur : t));
      setAdding(true);
    }
  };
  const enter = useEnterSubmit((value) => void submit(value), { shiftForNewline: true });

  return (
    <section className={`column ${col.isDone ? 'done' : ''} ${isOver ? 'over' : ''}`} aria-label={`${col.name} 열`}>
      <header className="column-head">
        {renaming ? (
          <InlineEdit
            initial={col.name}
            max={LIMITS.columnName}
            label="열 이름"
            onSave={async (v) => {
              if (v === col.name) {
                setRenaming(false);
                return true;
              }
              const ok = await props.onRename(v);
              if (ok) setRenaming(false);
              return ok;
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <h3 onDoubleClick={() => setRenaming(true)} title="더블클릭하면 이름을 바꿀 수 있어요">
            {col.name}
            {col.isDone && <span className="done-badge">완료 열</span>}
            <span className="count">
              {props.cardIds.length}
              {props.hiddenCount > 0 && <span title="필터로 숨겨진 카드"> (+{props.hiddenCount} 숨김)</span>}
            </span>
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
          <button className="danger" disabled={props.total <= 1} title={props.total <= 1 ? '마지막 남은 열은 삭제할 수 없어요' : ''} onClick={props.onDelete}>
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
                meta={props.metaOf(id)}
                disabled={props.dragDisabled}
                selecting={props.selecting}
                selected={props.selected.has(id)}
                onToggleSelect={props.onToggleSelect}
                menu={props.menu}
                setMenu={props.setMenu}
                columns={props.columns}
                actions={props.actions}
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
              if (enter.onKeyDown(e)) return; // 한글 조합 중 Enter는 확정용이라 제출하지 않는다
              if (e.key === 'Escape' && !isComposingKey(e)) {
                setAdding(false);
                setTitle('');
              }
            }}
            onCompositionEnd={enter.onCompositionEnd}
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

export function AddColumn({ onAdd }: { onAdd: (name: string) => Promise<boolean> }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="add-column">
      {adding ? (
        <InlineEdit
          initial=""
          max={LIMITS.columnName}
          label="열 이름"
          onSave={async (v) => {
            const ok = await onAdd(v);
            if (ok) setAdding(false);
            return ok;
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button onClick={() => setAdding(true)}>+ 열 추가</button>
      )}
    </div>
  );
}
