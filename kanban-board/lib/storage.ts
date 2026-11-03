import fs from 'node:fs';
import path from 'node:path';
import { LIMITS } from './types';

/** 첨부파일 저장 창구. 지금은 서버 디스크(data/uploads)에 저장한다. 다른 저장소를 쓰려면 이 모양대로 새로 구현해 갈아 끼운다. */
export interface StorageAdapter {
  put(key: string, data: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  exists(key: string): boolean;
  list(): string[];
  /** 파일이 만들어진 지 몇 ms 지났는지 (없으면 알 수 없음) */
  ageMs?(key: string): number;
}

/** 서버 디스크의 첨부 폴더(기본: 앱 폴더 아래 data/uploads)에 저장 */
export class LocalStorageAdapter implements StorageAdapter {
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }
  private file(key: string) {
    if (!/^[0-9a-f-]{36}(\.tmp)?$/.test(key)) throw new Error('잘못된 저장 키');
    return path.join(this.dir, key);
  }
  async put(key: string, data: Buffer) {
    const tmp = this.file(key) + '.tmp';
    try {
      await fs.promises.writeFile(tmp, data);
      await fs.promises.rename(tmp, this.file(key));
    } catch (e) {
      await fs.promises.rm(tmp, { force: true }); // 업로드가 끊기면 임시 파일을 지운다
      throw e;
    }
  }
  async read(key: string) {
    return fs.promises.readFile(this.file(key));
  }
  async remove(key: string) {
    await fs.promises.rm(this.file(key), { force: true });
  }
  exists(key: string) {
    try {
      return fs.existsSync(this.file(key));
    } catch {
      return false;
    }
  }
  list() {
    return fs.readdirSync(this.dir);
  }
  ageMs(key: string) {
    try {
      return Date.now() - fs.statSync(this.file(key)).mtimeMs;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }
}

/** 앱이 만드는 저장 파일 이름: UUID, 업로드 도중에는 뒤에 .tmp */
export const isStorageKey = (name: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.tmp)?$/i.test(name);

export interface CleanupRepo {
  purgeExpiredAttachments(): Promise<string[]>;
  referencedStorageKeys(): Promise<Set<string>>;
}

/**
 * 앱 시작 시 정리:
 *  1) 삭제 표시 후 보관 기간(7일)이 지난 첨부를 DB와 디스크에서 지운다
 *  2) DB 어디에서도 쓰지 않는 고아 파일(업로드 중단 등)을 지운다
 */
export async function cleanupStorage(repo: CleanupRepo, storage: StorageAdapter): Promise<string[]> {
  const removed: string[] = [];
  for (const key of await repo.purgeExpiredAttachments()) {
    await storage.remove(key);
    removed.push(key);
  }
  const referenced = await repo.referencedStorageKeys();
  for (const key of storage.list()) {
    // 우리가 만든 파일 이름(UUID, 업로드 중 임시 .tmp)이 아닌 것은 건드리지 않는다 (사용자가 넣어 둔 파일일 수 있다)
    if (!isStorageKey(key)) continue;
    if (!referenced.has(key)) {
      // 방금 올라온 파일은 아직 DB에 기록되기 전일 수 있으니 건드리지 않는다
      if (storage.ageMs && storage.ageMs(key) < YOUNG_FILE_MS) continue;
      try {
        await storage.remove(key);
        removed.push(key);
      } catch (e) {
        console.error('첨부 파일 정리 실패(건너뜀)', key, (e as Error).message); // 하나가 실패해도 나머지는 계속한다
      }
    }
  }
  return removed;
}
const YOUNG_FILE_MS = 5 * 60 * 1000;
export const RETENTION_MS = LIMITS.retentionDays * 24 * 60 * 60 * 1000;
