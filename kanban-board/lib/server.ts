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

/** 첨부 저장 폴더. 값이 비어 있으면(KANBAN_UPLOADS=) 적지 않은 것으로 보고 앱 폴더 아래 data/uploads를 쓴다. */
export function uploadsDir(): string {
  return process.env.KANBAN_UPLOADS?.trim() || path.join(process.cwd(), 'data', 'uploads');
}

export function getStorage(): StorageAdapter {
  if (!state.storage) state.storage = new LocalStorageAdapter(uploadsDir());
  return state.storage;
}

/** 연결 실패 원인(오류 코드)별로 "무엇을 확인해야 하는지"를 알려준다. 주소·비밀번호 같은 값은 넣지 않는다. */
export function connectHint(code?: string): string {
  const base = 'DB에 연결하지 못했어요. ';
  if (code === '28P01' || code === '28000') return base + '사용자 이름이나 비밀번호가 틀렸어요. .env의 DATABASE_URL을 확인해 주세요.';
  if (code === '3D000') return base + '.env에 적은 데이터베이스 이름이 없어요. 설치 안내서 4단계에서 만든 이름과 같은지 확인해 주세요.';
  if (code === '42501') return base + 'DB 사용자에게 권한이 없어요. 데이터베이스를 `OWNER 사용자이름`으로 만들었는지 확인해 주세요 (설치 안내서 4단계).';
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
    return base + 'PostgreSQL에 닿지 못했어요. 켜져 있는지, .env의 주소와 포트가 맞는지 확인해 주세요.';
  }
  return base + '.env의 DATABASE_URL(주소·사용자·비밀번호)과 PostgreSQL이 켜져 있는지 확인해 주세요. 자세한 원인은 앱을 켠 화면(tmux)에 나와 있어요.';
}

/** DB 연결은 한 번만 만들고 모두가 나눠 쓴다. 처음 부를 때 표를 만들고 시작 정리를 한다. */
export function getRepo(): Promise<PgBoardRepository> {
  if (!state.repo) {
    const promise = (async () => {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        throw new AppError('CONFIG', 'DB 연결 설정이 없어요. 앱 폴더의 .env 파일에 DATABASE_URL을 적고 앱을 다시 켜 주세요. (설치 안내서 6단계)', 500);
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
        throw new AppError('DB_CONNECT', connectHint(err.code), 503);
      }
      try {
        await repo.ensureFirstBoard();
        await repo.purgeOrphanDismissals();
      } catch (e) {
        await repo.close().catch(() => {}); // 시작에 실패하면 연결을 닫아 두고, 다음 요청에서 다시 시도한다
        throw e;
      }
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
