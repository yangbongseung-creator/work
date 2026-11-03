import type { Entry } from './types';

/**
 * 되돌리기·다시 실행 이력 (탭 메모리에만 저장).
 * 각 항목은 "지금 대상의 변경 번호가 이래야 실행한다"는 기억값(expect)을 들고 있고,
 * 실행 후에는 같은 대상을 가리키는 모든 항목의 기억값을 새 번호로 갱신한다.
 *
 * 실행할 항목(entry)을 넘기면 "맨 위"가 아니라 그 항목을 정확히 옮긴다.
 * (되돌리기를 보내 둔 사이에 첨부 업로드 같은 다른 변경이 끝나 맨 위가 바뀌어도 이력이 꼬이지 않게)
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
  dropUndo(entry?: Entry) {
    take(this.undoStack, entry);
  }
  dropRedo(entry?: Entry) {
    take(this.redoStack, entry);
  }
  commitUndo(touched: Record<string, number | null>, entry?: Entry) {
    const e = take(this.undoStack, entry);
    if (!e) return;
    this.redoStack.push(e);
    this.refresh(touched); // 방금 실행한 항목 자신도 새 번호로 갱신
  }
  commitRedo(touched: Record<string, number | null>, entry?: Entry) {
    const e = take(this.redoStack, entry);
    if (!e) return;
    this.undoStack.push(e);
    if (this.undoStack.length > this.max) this.undoStack.shift();
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

/** entry가 있으면 그 항목을, 없으면 맨 위 항목을 꺼낸다. 이미 없으면 undefined */
function take(stack: Entry[], entry?: Entry): Entry | undefined {
  if (!entry) return stack.pop();
  const i = stack.lastIndexOf(entry);
  if (i < 0) return undefined;
  return stack.splice(i, 1)[0];
}
