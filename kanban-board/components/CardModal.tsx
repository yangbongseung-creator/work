'use client';

import { useEffect, useRef, useState } from 'react';
import {
  LABEL_COLORS,
  LABEL_NAMES,
  LIMITS,
  type Attachment,
  type Card,
  type CheckItem,
  type Column,
  type Comment,
  type LabelColor,
  type Repeat,
} from '../lib/types';
import { ALLOWED_EXT, extOf } from '../lib/upload';
import { fmtSize } from './util';

type Status = 'idle' | 'saving' | 'saved' | 'error';
type Pending = { id: number; file: File; state: 'uploading' | 'error'; error?: string };

const ALL_EXT = new Set(Object.values(ALLOWED_EXT).flat());
const IMG_EXT = new Set(ALLOWED_EXT['이미지']);

export function CardModal(props: {
  card: Card;
  columns: Column[];
  assignees: string[];
  checks: CheckItem[];
  comments: Comment[];
  attachments: Attachment[];
  status: Status;
  onSave: (fields: Record<string, unknown>) => Promise<boolean>;
  onMoveTo: (columnId: string) => Promise<boolean>;
  act: (body: Record<string, unknown>) => Promise<boolean>;
  onUpload: (file: File) => Promise<void>;
  onDelete: () => void;
  onDuplicate: () => void;
  onArchive: () => void;
  onClose: () => void;
}) {
  const { card } = props;
  // 값이 null이면 "내가 고치는 중이 아님" → 서버에서 온 최신 값을 보여준다 (다른 탭 변경이 입력 중인 내용을 덮지 않게)
  const [title, setTitle] = useState<string | null>(null);
  const [desc, setDesc] = useState<string | null>(null);
  const [assignee, setAssignee] = useState<string | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [titleError, setTitleError] = useState(false);
  const [failed, setFailed] = useState(false);
  const [newCheck, setNewCheck] = useState('');
  const [newComment, setNewComment] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [fileMsg, setFileMsg] = useState('');
  const seq = useRef(0);

  const shownTitle = title ?? card.title;
  const shownDesc = desc ?? card.description;
  const shownAssignee = assignee ?? card.assignee;
  const shownDue = due ?? card.dueDate ?? '';

  const flush = async (): Promise<boolean> => {
    const fields: Record<string, unknown> = {};
    if (title !== null) {
      if (!title.trim()) {
        setTitleError(true);
        setTitle(null);
      } else if (title.trim() !== card.title) fields.title = title;
      else setTitle(null);
    }
    if (desc !== null) {
      if (desc !== card.description) fields.description = desc;
      else setDesc(null);
    }
    if (assignee !== null) {
      if (assignee.trim() !== card.assignee) fields.assignee = assignee;
      else setAssignee(null);
    }
    if (due !== null) {
      if (due !== (card.dueDate ?? '')) fields.dueDate = due || null;
      else setDue(null);
    }
    if (Object.keys(fields).length === 0) {
      setFailed(false);
      return true;
    }
    const ok = await props.onSave(fields);
    setFailed(!ok);
    if (ok) {
      if ('title' in fields) setTitle(null);
      if ('description' in fields) setDesc(null);
      if ('assignee' in fields) setAssignee(null);
      if ('dueDate' in fields) setDue(null);
      setTitleError(false);
    }
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

  const toggleLabel = (c: LabelColor) => {
    const has = card.labels.includes(c);
    props.onSave({ labels: has ? card.labels.filter((x) => x !== c) : [...card.labels, c] });
  };

  const upload = async (file: File, id?: number) => {
    const pid = id ?? ++seq.current;
    setPending((p) => (id ? p.map((x) => (x.id === pid ? { ...x, state: 'uploading', error: undefined } : x)) : [...p, { id: pid, file, state: 'uploading' }]));
    try {
      await props.onUpload(file);
      setPending((p) => p.filter((x) => x.id !== pid));
    } catch (e) {
      setPending((p) => p.map((x) => (x.id === pid ? { ...x, state: 'error', error: (e as Error).message } : x)));
    }
  };
  const pick = (files: FileList | null) => {
    setFileMsg('');
    if (!files) return;
    let count = props.attachments.length + pending.length;
    for (const f of Array.from(files)) {
      if (count >= LIMITS.attachmentsPerCard) return setFileMsg(`첨부파일은 카드당 ${LIMITS.attachmentsPerCard}개까지 올릴 수 있어요.`);
      if (!ALL_EXT.has(extOf(f.name))) return setFileMsg(`"${f.name}"은(는) 허용되지 않는 파일 종류예요.`);
      if (f.size > LIMITS.fileBytes) return setFileMsg(`"${f.name}"은(는) 10MB를 넘어요.`);
      count++;
      upload(f);
    }
  };

  const done = props.checks.filter((c) => c.done).length;

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="카드 편집">
        <div className="modal-head">
          <span className={`status ${failed ? 'error' : props.status}`} role="status">
            {failed ? '저장 실패' : props.status === 'saving' ? '저장 중…' : props.status === 'saved' ? '저장됨' : ''}
          </span>
          {failed && <button onClick={flush}>다시 시도</button>}
          <div className="spacer" />
          <button onClick={props.onDuplicate}>복제</button>
          <button onClick={props.onArchive}>보관</button>
          <button className="icon-btn" aria-label="닫기" onClick={close}>
            ✕
          </button>
        </div>

        <label>
          제목
          <input autoFocus maxLength={LIMITS.cardTitle} value={shownTitle} onChange={(e) => setTitle(e.target.value)} onBlur={flush} aria-invalid={titleError} />
        </label>
        {titleError && <p className="field-error">제목은 비워둘 수 없어요.</p>}

        <div className="label-picker" role="group" aria-label="라벨">
          {LABEL_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`lbl-btn lbl-${c} ${card.labels.includes(c) ? 'on' : ''}`}
              aria-pressed={card.labels.includes(c)}
              aria-label={`${LABEL_NAMES[c]} 라벨`}
              title={`${LABEL_NAMES[c]} 라벨`}
              onClick={() => toggleLabel(c)}
            >
              {card.labels.includes(c) ? '✓' : ''}
            </button>
          ))}
        </div>

        <label>
          설명
          <textarea rows={4} maxLength={LIMITS.cardDescription} value={shownDesc} onChange={(e) => setDesc(e.target.value)} onBlur={flush} />
        </label>

        <div className="row">
          <label>
            담당자
            <input list="assignee-list" maxLength={50} value={shownAssignee} onChange={(e) => setAssignee(e.target.value)} onBlur={flush} />
            <datalist id="assignee-list">
              {props.assignees.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </label>
          <label>
            마감일
            <input type="date" value={shownDue} onChange={(e) => setDue(e.target.value)} onBlur={flush} />
          </label>
        </div>

        <div className="row">
          <label>
            반복
            <select
              value={card.repeat}
              disabled={!card.dueDate}
              onChange={(e) => props.onSave({ repeat: e.target.value as Repeat })}
              title={card.dueDate ? '' : '반복하려면 마감일이 필요해요'}
            >
              <option value="none">없음</option>
              <option value="daily">매일</option>
              <option value="weekly">매주</option>
              <option value="monthly">매월</option>
            </select>
          </label>
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
                  {c.isDone ? ' (완료)' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>

        <section aria-label="체크리스트">
          <h4>
            체크리스트 {props.checks.length > 0 && <span className="muted">{done}/{props.checks.length}</span>}
          </h4>
          {props.checks.map((ch) => (
            <CheckRow key={ch.id} item={ch} act={props.act} />
          ))}
          <input
            placeholder="항목을 쓰고 Enter"
            aria-label="체크리스트 항목 추가"
            maxLength={LIMITS.checkText}
            value={newCheck}
            onChange={(e) => setNewCheck(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && newCheck.trim()) {
                const t = newCheck;
                setNewCheck('');
                if (!(await props.act({ op: 'addCheck', cardId: card.id, text: t }))) setNewCheck(t);
              }
            }}
          />
        </section>

        <section aria-label="댓글">
          <h4>댓글 {props.comments.length > 0 && <span className="muted">{props.comments.length}</span>}</h4>
          {props.comments.map((c) => (
            <CommentRow key={c.id} item={c} act={props.act} />
          ))}
          <textarea
            rows={2}
            placeholder="댓글을 쓰세요"
            aria-label="댓글 쓰기"
            maxLength={LIMITS.commentBody}
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
          />
          <div>
            <button
              disabled={!newComment.trim()}
              onClick={async () => {
                const t = newComment;
                setNewComment('');
                if (!(await props.act({ op: 'addComment', cardId: card.id, body: t }))) setNewComment(t);
              }}
            >
              댓글 등록
            </button>
          </div>
        </section>

        <section aria-label="첨부파일">
          <h4>
            첨부파일 <span className="muted">{props.attachments.length}/{LIMITS.attachmentsPerCard}</span>
          </h4>
          <ul className="attach-list">
            {props.attachments.map((a) => (
              <li key={a.id}>
                {IMG_EXT.has(extOf(a.name)) && <img className="thumb" src={`/api/files/${a.id}`} alt={a.name} />}
                <a href={`/api/files/${a.id}`} target="_blank" rel="noopener noreferrer" download={IMG_EXT.has(extOf(a.name)) || extOf(a.name) === 'pdf' ? undefined : a.name}>
                  {a.name}
                </a>
                <span className="muted">{fmtSize(a.size)}</span>
                <button className="icon-btn danger" aria-label={`${a.name} 삭제`} onClick={() => props.act({ op: 'deleteAttachment', id: a.id })}>
                  ✕
                </button>
              </li>
            ))}
            {pending.map((p) => (
              <li key={p.id}>
                <span>{p.file.name}</span>
                {p.state === 'uploading' ? (
                  <span className="muted">올리는 중…</span>
                ) : (
                  <>
                    <span className="field-error">{p.error}</span>
                    <button onClick={() => upload(p.file, p.id)}>다시 시도</button>
                    <button className="icon-btn" aria-label="취소" onClick={() => setPending((x) => x.filter((y) => y.id !== p.id))}>
                      ✕
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          <input
            type="file"
            multiple
            aria-label="파일 첨부"
            onChange={(e) => {
              pick(e.target.files);
              e.target.value = '';
            }}
          />
          {fileMsg && <p className="field-error">{fileMsg}</p>}
          <p className="muted small">이미지·PDF·문서·압축 파일, 파일당 10MB 이하, 카드당 5개까지</p>
        </section>

        <div className="modal-foot">
          <button className="danger" onClick={props.onDelete}>
            카드 삭제
          </button>
        </div>
      </div>
    </div>
  );
}

function CheckRow({ item, act }: { item: CheckItem; act: (b: Record<string, unknown>) => Promise<boolean> }) {
  const [text, setText] = useState<string | null>(null);
  const [pendingDone, setPendingDone] = useState<boolean | null>(null); // 눌렀을 때 바로 바뀌어 보이게
  return (
    <div className="check-row">
      <input
        type="checkbox"
        aria-label="완료"
        checked={pendingDone ?? item.done}
        onChange={async (e) => {
          setPendingDone(e.target.checked);
          await act({ op: 'updateCheck', id: item.id, fields: { done: e.target.checked } });
          setPendingDone(null);
        }}
      />
      <input
        className={item.done ? 'done-text' : ''}
        aria-label="체크리스트 내용"
        maxLength={LIMITS.checkText}
        value={text ?? item.text}
        onChange={(e) => setText(e.target.value)}
        onBlur={async () => {
          if (text === null) return;
          if (!text.trim() || text.trim() === item.text) return setText(null);
          if (await act({ op: 'updateCheck', id: item.id, fields: { text } })) setText(null);
        }}
      />
      <button className="icon-btn danger" aria-label="항목 삭제" onClick={() => act({ op: 'deleteCheck', id: item.id })}>
        ✕
      </button>
    </div>
  );
}

function CommentRow({ item, act }: { item: Comment; act: (b: Record<string, unknown>) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.body);
  const edited = item.updatedAt > item.createdAt;
  return (
    <div className="comment">
      <div className="comment-meta muted small">
        {new Date(item.createdAt).toLocaleString('ko-KR')}
        {edited && ' (수정됨)'}
      </div>
      {editing ? (
        <>
          <textarea rows={2} maxLength={LIMITS.commentBody} value={text} onChange={(e) => setText(e.target.value)} aria-label="댓글 수정" />
          <div className="row-btns">
            <button
              disabled={!text.trim()}
              onClick={async () => {
                if (await act({ op: 'updateComment', id: item.id, body: text })) setEditing(false);
              }}
            >
              저장
            </button>
            <button
              onClick={() => {
                setText(item.body);
                setEditing(false);
              }}
            >
              취소
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="comment-body">{item.body}</div>
          <div className="row-btns">
            <button
              className="link"
              onClick={() => {
                setText(item.body);
                setEditing(true);
              }}
            >
              수정
            </button>
            <button className="link danger" onClick={() => act({ op: 'deleteComment', id: item.id })}>
              삭제
            </button>
          </div>
        </>
      )}
    </div>
  );
}
