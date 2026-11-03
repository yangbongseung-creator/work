// .env의 DATABASE_URL을 앱과 똑같은 방법으로 읽어, PostgreSQL 프로그램(pg_dump, psql)용 환경변수 줄로 바꿔 출력한다.
// 비밀번호가 화면이나 명령줄(다른 사용자가 볼 수 있는 곳)에 드러나지 않게 하기 위해 쓴다.
// 사용: eval "$(node deploy/pgenv.cjs)"   (backup.sh, restore.sh가 쓴다)
const path = require('node:path');

const app = path.resolve(__dirname, '..');
let loadEnvConfig;
try {
  ({ loadEnvConfig } = require(require.resolve('@next/env', { paths: [app] })));
} catch {
  console.error('앱 부품을 찾지 못했어요. 앱 폴더에서 npm ci 를 먼저 해 주세요.');
  process.exit(1);
}
loadEnvConfig(app, false, { info: () => {}, error: console.error });

const raw = process.env.DATABASE_URL;
if (!raw) {
  console.error('.env에 DATABASE_URL이 없어요. (설치 안내서 6단계)');
  process.exit(1);
}
let u;
try {
  u = new URL(raw);
} catch {
  console.error('.env의 DATABASE_URL 모양이 올바르지 않아요. postgres://사용자:비밀번호@127.0.0.1:5432/kanban 모양이어야 해요.');
  process.exit(1);
}
const quote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const vars = {
  PGHOST: u.hostname.replace(/^\[|\]$/g, '') || '127.0.0.1',
  PGPORT: u.port || '5432',
  PGUSER: decodeURIComponent(u.username),
  PGPASSWORD: decodeURIComponent(u.password),
  PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
};
const sslmode = u.searchParams.get('sslmode');
if (sslmode) vars.PGSSLMODE = sslmode;
for (const [k, v] of Object.entries(vars)) console.log(`export ${k}=${quote(v)}`);
