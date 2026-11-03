'use client';

import { useEffect, useRef, useState, type CompositionEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
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
  return (
    <span
      className="menu"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Esc로 메뉴를 닫고, 메뉴를 열었던 버튼으로 돌아간다
        if (e.key === 'Escape' && isOpen) {
          e.stopPropagation();
          props.setOpen(null);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        className="icon-btn"
        aria-label={props.label}
        aria-expanded={isOpen}
        onClick={() => props.setOpen(isOpen ? null : props.id)}
      >
        {props.icon ?? '⋯'}
      </button>
      {isOpen && (
        <div className={`menu-pop ${props.align === 'left' ? 'left' : ''}`} role="group" aria-label={props.label} onClick={() => props.setOpen(null)}>
          {props.children}
        </div>
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
