import type { Entry } from './types';

/**
 * 되돌리기·다시 실행 이력 (탭 메모리에만 저장).
 * 각 항목은 "지금 대상의 변경 번호가 이래야 실행한다"는 기억값(expect)을 들고 있고,
 * 실행 후에는 같은 대상을 가리키는 모든 항목의 기억값을 새 번호로 갱신한다.
 */
export class History {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  constructor(private max = 50) {}

  push(entry: Entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.max) this.undoStack.shift();
    this.redoStack = [];
  }
  canUndo() {
    return this.undoStack.length > 0;
  }
  canRedo() {
    return this.redoStack.length > 0;
  }
  peekUndo() {
    return this.undoStack[this.undoStack.length - 1];
  }
  peekRedo() {
    return this.redoStack[this.redoStack.length - 1];
  }
  /** 충돌로 건너뛸 때: 실행하지 않고 이력에서만 뺀다 */
  dropUndo() {
    this.undoStack.pop();
  }
  dropRedo() {
    this.redoStack.pop();
  }
  commitUndo(touched: Record<string, number | null>) {
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push(e);
    this.refresh(touched); // 방금 실행한 항목 자신도 새 번호로 갱신
  }
  commitRedo(touched: Record<string, number | null>) {
    const e = this.redoStack.pop();
    if (!e) return;
    this.undoStack.push(e);
    this.refresh(touched);
  }
  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
  private refresh(touched: Record<string, number | null>) {
    for (const e of [...this.undoStack, ...this.redoStack]) {
      for (const x of e.expect) {
        if (x.key in touched) x.rev = touched[x.key];
      }
    }
  }
}
