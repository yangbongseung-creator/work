'use client';

import { useRef, useState, type ReactNode } from 'react';
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
  return (
    <span className="menu" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <button
        className="icon-btn"
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => props.setOpen(isOpen ? null : props.id)}
      >
        {props.icon ?? '⋯'}
      </button>
      {isOpen && (
        <div className={`menu-pop ${props.align === 'left' ? 'left' : ''}`} role="menu" onClick={() => props.setOpen(null)}>
          {props.children}
        </div>
      )}
    </span>
  );
}

export function InlineEdit(props: {
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

export function LabelDot({ color }: { color: LabelColor }) {
  return <span className={`lbl lbl-${color}`} role="img" aria-label={`${LABEL_NAMES[color]} 라벨`} title={`${LABEL_NAMES[color]} 라벨`} />;
}
