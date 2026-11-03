import fs from 'node:fs';
import path from 'node:path';
import { SqliteBoardRepository } from './repository';
import { checkRequest } from './guard';
import { authenticate } from './auth';
import { AppError } from './types';

const g = globalThis as unknown as { __kanbanRepo?: SqliteBoardRepository };

export function getRepo(): SqliteBoardRepository {
  if (!g.__kanbanRepo) {
    const file = process.env.KANBAN_DB ?? path.join(process.cwd(), 'data', 'kanban.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const repo = new SqliteBoardRepository(file);
    repo.ensureFirstBoard();
    g.__kanbanRepo = repo;
  }
  return g.__kanbanRepo;
}

/** 모든 API가 거치는 앞단: 로컬 서버 보호 → 인증(자리만) → 처리 → 오류 변환 */
export async function handle(req: Request, fn: () => Promise<unknown> | unknown): Promise<Response> {
  const guard = checkRequest({ method: req.method, headers: req.headers });
  if (!guard.ok) return Response.json({ error: guard.reason }, { status: guard.status });
  if (!(await authenticate(req))) return Response.json({ error: '인증이 필요해요.' }, { status: 401 });
  try {
    return Response.json(await fn());
  } catch (e) {
    if (e instanceof AppError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error(e);
    return Response.json({ error: '서버에서 문제가 생겼어요.' }, { status: 500 });
  }
}
