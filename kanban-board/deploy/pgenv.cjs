// .env의 DATABASE_URL을 앱과 똑같은 방법으로 읽어, PostgreSQL 프로그램(pg_dump, psql)용 환경변수 줄로 바꿔 출력한다.
// 비밀번호가 화면이나 명령줄(다른 사용자가 볼 수 있는 곳)에 드러나지 않게 하기 위해 쓴다.
// 사용: eval "$(node deploy/pgenv.cjs)"   (backup.sh, restore.sh가 쓴다)
//
// 출력 예 (한 줄에 하나씩):
//   export PGHOST='127.0.0.1'
//   export PGPORT='5432'
//   export PGUSER='kanban'
//   export PGPASSWORD='…'
//   export PGDATABASE='kanbandb'
// pg_dump·psql 은 이 환경 변수를 보고 알아서 접속한다 (명령에 주소·비밀번호를 쓰지 않아도 됨).
// 환경 변수는 같은 계정(과 root)만 볼 수 있어서, 명령줄에 비밀번호를 쓰는 것보다 안전하다.

const path = require('node:path');

// 이 파일은 deploy 폴더에 있으므로 한 칸 위가 앱 폴더
const app = path.resolve(__dirname, '..');
// 앱(Next.js)이 .env 를 읽는 것과 똑같은 부품(@next/env)으로 읽는다 (규칙이 달라 생기는 차이를 없애기 위해)
let loadEnvConfig;
try {
  ({ loadEnvConfig } = require(require.resolve('@next/env', { paths: [app] })));
} catch {
  console.error('앱 부품을 찾지 못했어요. 앱 폴더에서 npm ci 를 먼저 해 주세요.');
  process.exit(1);
}
// 읽은 값은 process.env 에 들어간다. 안내 문구(info)는 출력하지 않는다 (이 파일의 출력은 그대로 eval 로 실행되므로)
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
  console.error('.env의 DATABASE_URL 모양이 올바르지 않아요. postgres://kanban:비밀번호@127.0.0.1:5432/kanbandb 모양이어야 해요.');
  process.exit(1);
}
// 셸에 안전하게 넘기도록 작은따옴표로 감싼다 (값 안의 작은따옴표는 '\'' 로 바꾼다)
const quote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
// 연결 주소를 나눠서 PostgreSQL 프로그램이 아는 이름의 환경 변수로 만든다. 주소 안의 %XX 글자는 원래 글자로 되돌린다
const vars = {
  PGHOST: u.hostname.replace(/^\[|\]$/g, '') || '127.0.0.1',
  PGPORT: u.port || '5432',
  PGUSER: decodeURIComponent(u.username),
  PGPASSWORD: decodeURIComponent(u.password),
  PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
};
// 주소에 ?sslmode=… 가 있으면 그대로 넘긴다 (같은 서버 안에서 접속할 때는 보통 없음)
const sslmode = u.searchParams.get('sslmode');
if (sslmode) vars.PGSSLMODE = sslmode;
for (const [k, v] of Object.entries(vars)) console.log(`export ${k}=${quote(v)}`);
