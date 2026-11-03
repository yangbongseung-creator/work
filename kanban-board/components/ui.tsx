'use client';

import { useEffect, useLayoutEffect, useRef, useState, type CompositionEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { LABEL_NAMES, type LabelColor } from '../lib/types';

export function Menu(props: {
  id: string;
  open: string | null;
  setOpen: (v: string | null) => void;
  label: string;
  children: ReactNode;
  icon?: string;
  align?: 'left' | 'right';
}) {
  const isOpen = props.open === props.id;
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const { setOpen, align } = props;

  // 메뉴는 화면 맨 위층(body)에 띄운다. 스크롤되는 카드 목록 안에 두면 열의 아래쪽 카드에서 메뉴가 잘린다.
  useLayoutEffect(() => {
    if (!isOpen) {
      setPos(null);
      return;
    }
    const b = trigger.current?.getBoundingClientRect();
    const el = pop.current;
    if (!b || !el) return;
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    const below = b.bottom + 4;
    // 아래 공간이 모자라면 위쪽으로 연다
    const top = below + h > window.innerHeight - 8 && b.top - h - 4 >= 8 ? b.top - h - 4 : Math.max(8, Math.min(below, window.innerHeight - h - 8));
    const left = align === 'left' ? Math.min(b.left, window.innerWidth - w - 8) : Math.max(8, b.right - w);
    setPos({ top, left: Math.max(8, left) });
    // 화면이 움직이면 메뉴 자리가 어긋나므로 닫는다
    const close = (e: Event) => {
      if (e.type === 'scroll' && e.target instanceof Node && el.contains(e.target)) return;
      setOpen(null);
    };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [isOpen, align, setOpen]);

  // 자리를 잡아 보이게 된 뒤 첫 항목에 초점을 둔다 (키보드로도 바로 고를 수 있게)
  useEffect(() => {
    if (isOpen && pos) pop.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
  }, [isOpen, pos]);

  const closeAndReturn = () => {
    setOpen(null);
    trigger.current?.focus();
  };
  return (
    <span
      className="menu"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (!isOpen) return;
        // Esc: 메뉴를 닫고 메뉴를 열었던 버튼으로 돌아간다. Tab: 메뉴를 닫고 버튼으로 돌아간 뒤 다음 칸으로
        if (e.key === 'Escape' || (e.key === 'Tab' && pop.current?.contains(e.target as Node))) {
          if (e.key === 'Escape') e.preventDefault();
          e.stopPropagation();
          closeAndReturn();
        }
      }}
    >
      <button
        ref={trigger}
        className="icon-btn"
        aria-label={props.label}
        aria-expanded={isOpen}
        onClick={() => setOpen(isOpen ? null : props.id)}
      >
        {props.icon ?? '⋯'}
      </button>
      {isOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={pop}
            className="menu-pop floating"
            role="group"
            aria-label={props.label}
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
            onClick={() => setOpen(null)}
          >
            {props.children}
          </div>,
          document.body,
        )}
    </span>
  );
}


/** 한글 같은 IME로 글자를 "조합하는 중"인지. 조합 중의 Enter는 글자를 확정하는 키라서 제출로 보면 안 된다. */
export function isComposingKey(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

type TextEl = HTMLInputElement | HTMLTextAreaElement;

/**
 * Enter로 제출하는 입력칸에 쓰는 도우미.
 * - 조합 중 Enter는 무시하고, 조합이 끝난 뒤의 Enter로 한 번만 제출한다 (한글 마지막 글자 중복·카드 두 번 생성 방지)
 * - 브라우저에 따라 "조합 중 Enter"만 오고 그 뒤 Enter가 오지 않을 수도 있어서, 그때는 조합이 끝나면 한 번 제출한다
 * - 제출할 값은 화면의 입력칸에서 직접 읽는다 (조합이 막 끝난 순간에도 정확한 값)
 * 같은 Enter로 두 번 불려도, 첫 제출 뒤 입력칸이 비므로 두 번째는 빈 값이라 무시된다.
 */
export function useEnterSubmit(submit: (value: string) => void, opts: { shiftForNewline?: boolean } = {}) {
  const pending = useRef(false);
  const onKeyDown = (e: KeyboardEvent<TextEl>): boolean => {
    if (e.key !== 'Enter' || (opts.shiftForNewline && e.shiftKey)) return false;
    if (isComposingKey(e)) {
      pending.current = true; // 조합을 확정하는 Enter: 지금은 제출하지 않는다
      return true;
    }
    e.preventDefault();
    pending.current = false;
    submit(e.currentTarget.value);
    return true;
  };
  const onCompositionEnd = (e: CompositionEvent<TextEl>) => {
    if (!pending.current) return;
    const el = e.currentTarget;
    setTimeout(() => {
      if (!pending.current) return; // 그 사이 일반 Enter가 와서 이미 제출됐다
      pending.current = false;
      submit(el.value);
    }, 30);
  };
  return { onKeyDown, onCompositionEnd };
}

/**
 * 한 줄 이름 고치기 칸.
 * onSave가 false를 돌려주면(저장 실패) 쓴 내용을 그대로 둔 채 다시 고칠 수 있게 남겨 둔다.
 * 저장이 끝나 부모가 이 칸을 닫을 때까지는 읽기 전용으로 둔다 (그 사이 쓴 글자가 사라지지 않게).
 */
export function InlineEdit(props: {
  initial: string;
  max: number;
  label: string;
  onSave: (v: string) => Promise<boolean> | boolean | void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(props.initial);
  const [busy, setBusy] = useState(false);
  const done = useRef(false);
  const finish = async (save: boolean, value: string = v) => {
    if (done.current) return;
    done.current = true;
    const t = value.trim();
    if (!save || !t) {
      props.onCancel();
      return;
    }
    setBusy(true);
    const ok = await props.onSave(t);
    if (ok === false) {
      done.current = false;
      setBusy(false);
      setV(value);
    }
  };
  const enter = useEnterSubmit((value) => void finish(true, value));
  return (
    <input
      className="inline-edit"
      autoFocus
      aria-label={props.label}
      aria-busy={busy}
      placeholder={props.label}
      maxLength={props.max}
      readOnly={busy}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (busy) return;
        if (enter.onKeyDown(e)) return;
        if (e.key === 'Escape' && !isComposingKey(e)) void finish(false);
      }}
      onCompositionEnd={enter.onCompositionEnd}
      onBlur={(e) => void finish(true, e.currentTarget.value)}
    />
  );
}

export function LabelDot({ color }: { color: LabelColor }) {
  return <span className={`lbl lbl-${color}`} role="img" aria-label={`${LABEL_NAMES[color]} 라벨`} title={`${LABEL_NAMES[color]} 라벨`} />;
}

/** 대화상자 바깥(어두운 배경)을 직접 눌렀는지. 배경의 스크롤바를 누른 것은 제외한다. */
export function isBackdropPress(e: MouseEvent<HTMLElement>): boolean {
  if (e.target !== e.currentTarget) return false;
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  return e.clientX - r.left < el.clientWidth && e.clientY - r.top < el.clientHeight;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 대화상자(aria-modal) 안에 키보드 초점을 가둔다.
 * Tab/Shift+Tab은 대화상자 안에서만 돌고, 바깥으로 나간 초점은 다시 안으로 데려온다.
 * 닫히면 열기 전에 초점이 있던 곳으로 돌려준다.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const list = () => {
      const node = ref.current;
      if (!node) return [];
      return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      const node = ref.current;
      if (e.key !== 'Tab' || !node) return;
      const items = list();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !node.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !node.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      const node = ref.current;
      if (node && e.target instanceof Node && !node.contains(e.target)) list()[0]?.focus();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
      if (before && before.isConnected) before.focus();
    };
  }, [ref]);
}
