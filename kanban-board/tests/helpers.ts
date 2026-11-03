import { randomUUID } from 'node:crypto';
import { PgBoardRepository, type RepoOptions } from '../lib/repository';

/** 시험용 PostgreSQL 주소. 직접 시험하려면 TEST_DATABASE_URL 환경변수로 바꿀 수 있다. */
export const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://kanban:kanban_test_pw@127.0.0.1:5432/kanban_test';

const open: { repo: PgBoardRepository; schema: string }[] = [];

/** 시험마다 독립된 스키마(칸막이)를 만들어 서로 영향을 주지 않게 한다. 끝나면 setup.ts가 지운다. */
export async function newRepo(opts: RepoOptions = {}): Promise<PgBoardRepository> {
  const schema = 't_' + randomUUID().replace(/-/g, '').slice(0, 24);
  const repo = await PgBoardRepository.create({ connectionString: TEST_URL, schema, poolSize: 3, ...opts });
  open.push({ repo, schema });
  return repo;
}

export async function disposeRepo(repo: PgBoardRepository) {
  const i = open.findIndex((o) => o.repo === repo);
  if (i < 0) return;
  const [o] = open.splice(i, 1);
  await o.repo.close().catch(() => {});
  await PgBoardRepository.dropSchema(TEST_URL, o.schema).catch(() => {});
}

export async function closeAll() {
  for (const o of [...open]) await disposeRepo(o.repo);
}
