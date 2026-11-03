/** 변경 알림 창구. 지금은 한 서버 프로세스 안에서만 전달한다(SSE). 서버를 여러 대로 늘릴 때는 이 부분을 공용 알림 방식으로 갈아 끼운다. */
export interface ChangeFeed {
  /** onShutdown은 서버가 꺼질 때 연결을 닫기 위해 호출된다 */
  subscribe(listener: (revision: number) => void, onShutdown?: () => void): () => void;
  publish(revision: number): void;
  /** 서버를 끄기 전에 열려 있는 실시간 연결을 모두 닫는다 */
  shutdown(): void;
  isShuttingDown(): boolean;
}

export class LocalChangeFeed implements ChangeFeed {
  private listeners = new Set<(rev: number) => void>();
  private closers = new Set<() => void>();
  private closed = false;
  subscribe(listener: (revision: number) => void, onShutdown?: () => void) {
    if (this.closed) {
      // 이미 종료 중인 서버는 새 연결을 붙잡지 않는다 (브라우저가 곧 새 서버에 다시 붙게)
      queueMicrotask(() => onShutdown?.());
      return () => {};
    }
    this.listeners.add(listener);
    if (onShutdown) this.closers.add(onShutdown);
    return () => {
      this.listeners.delete(listener);
      if (onShutdown) this.closers.delete(onShutdown);
    };
  }
  isShuttingDown() {
    return this.closed;
  }
  shutdown() {
    this.closed = true;
    for (const c of [...this.closers]) {
      try {
        c();
      } catch {
        /* 이미 닫힌 연결 */
      }
    }
    this.closers.clear();
    this.listeners.clear();
  }
  publish(revision: number) {
    for (const l of [...this.listeners]) {
      try {
        l(revision);
      } catch {
        /* 한 연결의 오류가 다른 연결을 막지 않게 한다 */
      }
    }
  }
}
