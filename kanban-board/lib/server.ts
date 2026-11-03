import path from 'node:path';
import { PgBoardRepository } from './repository';
import { checkRequest } from './guard';
import { authenticate } from './auth';
import { LocalChangeFeed, type ChangeFeed } from './feed';
import { LocalStorageAdapter, cleanupStorage, type StorageAdapter } from './storage';
import { AppError } from './types';

type Globals = { repo?: Promise<PgBoardRepository>; storage?: StorageAdapter; feed?: ChangeFeed; signals?: boolean };
const g = globalThis as unknown as { __kanban?: Globals };
const state = (g.__kanban ??= {});

export function getFeed(): ChangeFeed {
  if (!state.feed) {
    const feed = new LocalChangeFeed();
    state.feed = feed;
    if (!state.signals) {
      state.signals = true;
      // 열려 있는 실시간 연결이 있으면 서버가 Ctrl+C로 꺼지지 않으므로, 종료 신호를 받으면 먼저 연결을 닫는다
      for (const sig of ['SIGINT', 'SIGTERM'] as const) {
        const onSignal = () => {
          feed.shutdown();
          // 우리 말고 이 신호를 처리하는 곳이 없으면 원래 동작(종료)을 되살린다
          if (process.listenerCount(sig) <= 1) {
            process.removeListener(sig, onSignal);
            process.kill(process.pid, sig);
          }
        };
        process.on(sig, onSignal);
      }
    }
  }
  return state.feed;
}

export function getStorage(): StorageAdapter {
  if (!state.storage) {
    const dir = process.env.KANBAN_UPLOADS ?? path.join(process.cwd(), 'data', 'uploads');
    state.storage = new LocalStorageAdapter(dir);
  }
  return state.storage;
}

/** DB 연결은 한 번만 만들고 모두가 나눠 쓴다. 처음 부를 때 표를 만들고 시작 정리를 한다. */
export function getRepo(): Promise<PgBoardRepository> {
  if (!state.repo) {
    const promise = (async () => {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        throw new AppError('CONFIG', 'DB 연결 설정이 없어요. .env 파일에 DATABASE_URL을 적어 주세요. (README 참고)', 500);
      }
      const storage = getStorage();
      const feed = getFeed();
      let repo: PgBoardRepository;
      try {
        repo = await PgBoardRepository.create({
          connectionString,
          schema: process.env.DATABASE_SCHEMA || undefined,
          fileExists: (k) => storage.exists(k),
          onCommit: (rev) => feed.publish(rev),
        });
      } catch (e) {
        // 자세한 원인은 서버 로그에만 남기고(주소·비밀번호는 찍지 않는다), 화면에는 알아보기 쉬운 안내만 보낸다
        const err = e as { code?: string; message?: string };
        console.error(`DB 연결 실패 (${err.code ?? 'unknown'}): ${err.message ?? e}`);
        throw new AppError('DB_CONNECT', 'DB에 연결하지 못했어요. .env의 DATABASE_URL(주소·사용자·비밀번호)과 PostgreSQL이 켜져 있는지 확인해 주세요.', 503);
      }
      await repo.ensureFirstBoard();
      await repo.purgeOrphanDismissals();
      // 앱 시작 시 정리: 보관 기간이 지난 첨부, 어디에서도 쓰지 않는 고아 파일
      cleanupStorage(repo, storage).catch((e) => console.error('첨부 정리 실패', e));
      return repo;
    })();
    // 연결에 실패하면 다음 요청에서 다시 시도할 수 있게 비워 둔다
    promise.catch(() => {
      if (state.repo === promise) state.repo = undefined;
    });
    state.repo = promise;
  }
  return state.repo;
}

/** 로컬 서버 보호 → 인증(자리만). 통과하면 null, 막히면 응답을 돌려준다 */
export async function guardRequest(req: Request): Promise<Response | null> {
  // 종료 중인 서버는 요청을 받지 않고 연결을 끊게 한다.
  // (브라우저가 열어 둔 연결을 재사용해 계속 붙으면 서버가 안 꺼지고, 새 서버로도 못 가기 때문)
  if (getFeed().isShuttingDown()) {
    return new Response(JSON.stringify({ error: '서버가 종료되는 중이에요.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', Connection: 'close', 'Retry-After': '2' },
    });
  }
  const guard = checkRequest({ method: req.method, headers: req.headers });
  if (!guard.ok) return Response.json({ error: guard.reason }, { status: guard.status });
  if (!(await authenticate(req))) return Response.json({ error: '인증이 필요해요.' }, { status: 401 });
  return null;
}

export function errorResponse(e: unknown): Response {
  if (e instanceof AppError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
  console.error(e);
  return Response.json({ error: '서버에서 문제가 생겼어요.' }, { status: 500 });
}

/** JSON을 돌려주는 API가 거치는 앞단 */
export async function handle(req: Request, fn: () => Promise<unknown> | unknown): Promise<Response> {
  const blocked = await guardRequest(req);
  if (blocked) return blocked;
  try {
    return Response.json(await fn());
  } catch (e) {
    return errorResponse(e);
  }
}
