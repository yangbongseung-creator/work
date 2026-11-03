-- =============================================================================
-- 칸반 보드 데이터베이스 구조 (표 10개 + 찾기용 인덱스 6개)
-- =============================================================================
--
-- 이 파일은 무엇인가요?
--   칸반 앱이 쓰는 표(테이블)를 만드는 스크립트입니다. 표마다·칸(컬럼)마다 설명을 붙였습니다.
--   설명은 두 가지로 들어 있어요.
--     1) 이 파일 안의 주석 ( -- 로 시작하는 줄 )  → 파일을 읽는 사람을 위한 설명
--     2) COMMENT ON 문                            → 실행하면 데이터베이스 안에 설명이 기록되어,
--                                                  DBeaver 같은 프로그램에서 표·칸을 누르면 설명이 보여요
--
-- 꼭 실행해야 하나요?
--   아니요. 앱은 처음 켜질 때 표를 스스로 만듭니다. 이 스크립트는
--     - 데이터베이스 안에 한국어 설명을 넣고 싶을 때
--     - 표 구조를 한눈에 보고 싶을 때
--   쓰면 됩니다.
--
-- 이미 쓰고 있는 데이터베이스(kanbandb)에 실행해도 되나요?
--   네. 여러 번 실행해도 안전합니다.
--     - 표·인덱스는 "없을 때만" 만들고(IF NOT EXISTS), 이미 있으면 건드리지 않아요.
--     - 데이터(보드·카드 등)는 바꾸지도 지우지도 않아요.
--     - COMMENT ON 은 설명만 덮어써요.
--
-- 실행하는 방법 (DBeaver)
--   1) kanbandb 에 "kanban" 계정으로 연결합니다. (표의 주인만 설명을 넣을 수 있어요)
--   2) 그 연결을 "읽기 전용(Read-only connection)"으로 해 두었다면 잠깐 끕니다.
--   3) SQL 편집기에 이 파일 내용을 열고 "스크립트 실행" (Alt+X) 을 누릅니다.
--   4) 끝나면 읽기 전용을 다시 켭니다.
--   psql로 실행하려면:  psql -h 127.0.0.1 -U kanban -d kanbandb -f sql/schema.sql
--
-- 표들의 관계 (외래 키 제약은 걸지 않았어요. 연결 관계는 앱이 직접 지킵니다)
--
--   boards (보드)
--     └─ board_columns (열)              board_columns.board_id → boards.id
--          └─ cards (카드)               cards.column_id      → board_columns.id
--               ├─ check_items (체크리스트)   check_items.card_id → cards.id
--               ├─ comments (댓글)          comments.card_id    → cards.id
--               ├─ attachments (첨부 정보)   attachments.card_id → cards.id
--               └─ dismissals (닫은 알림)    dismissals.card_id  → cards.id
--   meta (변경 번호 1개) · changes (변경 기록) · app_settings (앱 설정)
--
-- 모든 id 는 무작위 ID(UUID) 글자입니다. 날짜는 'YYYY-MM-DD' 글자로 저장합니다.
-- 표를 만드는 곳(스키마)은 지금 연결의 기본 스키마(보통 public)입니다.
--
-- ※ 앱의 표 구조를 바꾸면 이 파일도 함께 고쳐야 합니다.
--   (tests/sql-schema.test.ts 가 앱이 만드는 구조와 이 파일이 같은지 자동으로 확인합니다)
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. app_settings : 앱 설정
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  key   text PRIMARY KEY,   -- 설정 이름 (예: first_board_created)
  value text NOT NULL       -- 설정 값 (글자)
);
COMMENT ON TABLE  app_settings       IS '앱 설정. 이름-값 짝으로 저장한다. 예: first_board_created = 1 (첫 보드를 이미 만들었음 → 보드를 다 지워도 다시 만들지 않음)';
COMMENT ON COLUMN app_settings.key   IS '설정 이름 (예: first_board_created)';
COMMENT ON COLUMN app_settings.value IS '설정 값 (글자)';


-- -----------------------------------------------------------------------------
-- 2. meta : 데이터 전체의 변경 번호 (항상 1줄)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  id       integer PRIMARY KEY CHECK (id = 1),   -- 항상 1 (이 표에는 한 줄만 있음)
  revision integer NOT NULL                       -- 전체 변경 번호. 무엇이든 바뀔 때마다 1씩 늘어남
);
INSERT INTO meta (id, revision) VALUES (1, 0) ON CONFLICT DO NOTHING;   -- 없을 때만 0으로 시작 (있으면 그대로)
COMMENT ON TABLE  meta          IS '데이터 전체의 변경 번호(한 줄만 있음). 보드·카드 등 무엇이든 바뀔 때마다 1씩 늘어난다. 다른 탭이 "몇 번 이후 무엇이 바뀌었나"를 물을 때 기준이 된다. 저장할 때 이 줄을 잠가서 쓰기를 한 번에 하나씩 처리한다';
COMMENT ON COLUMN meta.id       IS '항상 1 (한 줄만 있도록 막아 둠)';
COMMENT ON COLUMN meta.revision IS '전체 변경 번호. 0에서 시작해 변경할 때마다 1씩 증가';


-- -----------------------------------------------------------------------------
-- 3. boards : 보드
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS boards (
  id       text PRIMARY KEY,   -- 보드 ID
  name     text NOT NULL,      -- 보드 이름 (1~50자)
  position integer NOT NULL,   -- 왼쪽 보드 목록에서의 순서 (작을수록 위)
  rev      integer NOT NULL    -- 이 행이 마지막으로 바뀐 때의 전체 변경 번호
);
COMMENT ON TABLE  boards          IS '보드. 카드를 모아 두는 큰 판. 왼쪽 목록에 position 순서로 보인다';
COMMENT ON COLUMN boards.id       IS '보드 ID (무작위 UUID 글자)';
COMMENT ON COLUMN boards.name     IS '보드 이름 (1~50자, 같은 이름도 허용)';
COMMENT ON COLUMN boards.position IS '왼쪽 보드 목록에서의 순서 (작을수록 위)';
COMMENT ON COLUMN boards.rev      IS '이 행이 마지막으로 바뀐 때의 전체 변경 번호(meta.revision). 되돌리기가 그 사이 다른 곳에서 바뀌었는지 알아보는 데 쓴다';


-- -----------------------------------------------------------------------------
-- 4. board_columns : 열 (보드 안의 세로 칸)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS board_columns (
  id       text PRIMARY KEY,                -- 열 ID
  board_id text NOT NULL,                   -- 이 열이 속한 보드 (boards.id)
  name     text NOT NULL,                   -- 열 이름 (1~50자)
  position integer NOT NULL,                -- 보드 안에서 왼쪽부터의 순서
  is_done  boolean NOT NULL DEFAULT false,  -- 완료 열이면 true
  rev      integer NOT NULL                 -- 이 행이 마지막으로 바뀐 때의 전체 변경 번호
);
COMMENT ON TABLE  board_columns          IS '열(보드 안의 세로 칸). 새 보드는 할 일·진행 중·완료(완료 열) 세 열로 시작한다. 보드마다 열이 적어도 하나는 남아 있어야 한다';
COMMENT ON COLUMN board_columns.id       IS '열 ID (무작위 UUID 글자)';
COMMENT ON COLUMN board_columns.board_id IS '이 열이 속한 보드 (boards.id)';
COMMENT ON COLUMN board_columns.name     IS '열 이름 (1~50자)';
COMMENT ON COLUMN board_columns.position IS '보드 안에서 왼쪽부터의 순서 (작을수록 왼쪽)';
COMMENT ON COLUMN board_columns.is_done  IS '완료 열이면 true. 완료 열의 카드는 마감 알림·마감 지남 표시에서 빠지고, 반복 카드를 이 열로 옮기면 다음 회차 카드가 생긴다. 한 보드에 여러 개 가능';
COMMENT ON COLUMN board_columns.rev      IS '이 행이 마지막으로 바뀐 때의 전체 변경 번호(meta.revision)';


-- -----------------------------------------------------------------------------
-- 5. cards : 카드 (일 하나)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cards (
  id          text PRIMARY KEY,                -- 카드 ID
  column_id   text NOT NULL,                   -- 이 카드가 있는 열 (board_columns.id)
  title       text NOT NULL,                   -- 제목 (1~100자)
  description text NOT NULL DEFAULT '',        -- 설명 (0~2000자)
  assignee    text NOT NULL DEFAULT '',        -- 담당자 이름 (없으면 빈 글자, 50자까지)
  due_date    text,                            -- 마감일 'YYYY-MM-DD' (없으면 NULL)
  repeat      text NOT NULL DEFAULT 'none',    -- 반복: none / daily / weekly / monthly
  labels      jsonb NOT NULL DEFAULT '[]',     -- 라벨 색 목록 (예: ["red","blue"])
  archived    boolean NOT NULL DEFAULT false,  -- 보관했으면 true
  position    integer NOT NULL,                -- 열 안에서 위부터의 순서
  followup_id text,                            -- 이 카드로 만든 다음 회차 카드의 ID (반복 카드)
  rev         integer NOT NULL                 -- 이 행이 마지막으로 바뀐 때의 전체 변경 번호
);
COMMENT ON TABLE  cards             IS '카드(일 하나). 열 안에 position 순서로 쌓인다. 체크리스트·댓글·첨부·닫은 알림이 이 카드에 딸려 있다';
COMMENT ON COLUMN cards.id          IS '카드 ID (무작위 UUID 글자)';
COMMENT ON COLUMN cards.column_id   IS '이 카드가 있는 열 (board_columns.id). 카드는 다른 보드의 열로는 옮길 수 없다';
COMMENT ON COLUMN cards.title       IS '제목 (1~100자, 비울 수 없음)';
COMMENT ON COLUMN cards.description IS '설명 (0~2000자). 없으면 빈 글자';
COMMENT ON COLUMN cards.assignee    IS '담당자 이름 (0~50자). 없으면 빈 글자. 별도 사용자 표 없이 이름만 적는다';
COMMENT ON COLUMN cards.due_date    IS '마감일 YYYY-MM-DD 글자 (1900~2999년). 없으면 NULL. 시간대 영향을 받지 않게 글자로 저장한다';
COMMENT ON COLUMN cards.repeat      IS '반복 주기: none(없음) / daily(매일) / weekly(매주) / monthly(매월). 마감일이 없으면 none이어야 한다';
COMMENT ON COLUMN cards.labels      IS '라벨 색 목록 JSON 배열. 쓸 수 있는 색: red, orange, yellow, green, blue, purple (같은 색은 한 번만)';
COMMENT ON COLUMN cards.archived    IS '보관했으면 true. 보관한 카드는 보드에 안 보이고 보관함에서 복원·영구 삭제할 수 있다';
COMMENT ON COLUMN cards.position    IS '열 안에서 위부터의 순서 (작을수록 위). 같은 열 안에서 겹치지 않게 앱이 관리한다';
COMMENT ON COLUMN cards.followup_id IS '반복 카드를 완료 열로 옮겨 다음 회차 카드를 만들었다면 그 카드의 ID. 값이 있으면 다시 만들지 않는다(한 번만). 없으면 NULL';
COMMENT ON COLUMN cards.rev         IS '이 행이 마지막으로 바뀐 때의 전체 변경 번호(meta.revision)';


-- -----------------------------------------------------------------------------
-- 6. check_items : 체크리스트 항목
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS check_items (
  id       text PRIMARY KEY,                -- 항목 ID
  card_id  text NOT NULL,                   -- 이 항목이 딸린 카드 (cards.id)
  text     text NOT NULL,                   -- 항목 글 (1~500자)
  done     boolean NOT NULL DEFAULT false,  -- 끝냈으면 true
  position integer NOT NULL,                -- 카드 안에서 위부터의 순서
  rev      integer NOT NULL                 -- 이 행이 마지막으로 바뀐 때의 전체 변경 번호
);
COMMENT ON TABLE  check_items          IS '카드의 체크리스트 항목. 카드에는 끝낸 항목 수/전체 항목 수(예: 2/4)로 보인다';
COMMENT ON COLUMN check_items.id       IS '항목 ID (무작위 UUID 글자)';
COMMENT ON COLUMN check_items.card_id  IS '이 항목이 딸린 카드 (cards.id)';
COMMENT ON COLUMN check_items.text     IS '항목 글 (1~500자)';
COMMENT ON COLUMN check_items.done     IS '끝냈으면 true';
COMMENT ON COLUMN check_items.position IS '카드 안에서 위부터의 순서';
COMMENT ON COLUMN check_items.rev      IS '이 행이 마지막으로 바뀐 때의 전체 변경 번호(meta.revision)';


-- -----------------------------------------------------------------------------
-- 7. comments : 댓글
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comments (
  id         text PRIMARY KEY,   -- 댓글 ID
  card_id    text NOT NULL,      -- 이 댓글이 달린 카드 (cards.id)
  body       text NOT NULL,      -- 댓글 내용 (1~1000자)
  created_at text NOT NULL,      -- 쓴 시각 (예: 2026-11-03T09:52:42.123Z)
  updated_at text NOT NULL,      -- 마지막으로 고친 시각
  rev        integer NOT NULL    -- 이 행이 마지막으로 바뀐 때의 전체 변경 번호
);
COMMENT ON TABLE  comments            IS '카드의 댓글. 쓴 시각 순서로 보인다';
COMMENT ON COLUMN comments.id         IS '댓글 ID (무작위 UUID 글자)';
COMMENT ON COLUMN comments.card_id    IS '이 댓글이 달린 카드 (cards.id)';
COMMENT ON COLUMN comments.body       IS '댓글 내용 (1~1000자, 줄바꿈 가능)';
COMMENT ON COLUMN comments.created_at IS '쓴 시각. ISO 8601 형식의 세계 표준시(UTC) 글자 (예: 2026-11-03T09:52:42.123Z). 화면에서는 한국 시각으로 바꿔 보여 준다';
COMMENT ON COLUMN comments.updated_at IS '마지막으로 고친 시각 (형식은 created_at과 같음). created_at보다 나중이면 화면에 (수정됨)이 붙는다';
COMMENT ON COLUMN comments.rev        IS '이 행이 마지막으로 바뀐 때의 전체 변경 번호(meta.revision)';


-- -----------------------------------------------------------------------------
-- 8. attachments : 첨부 파일 정보 (파일 자체는 서버 디스크의 data/uploads 폴더에)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachments (
  id          text PRIMARY KEY,   -- 첨부 ID
  seq         bigserial,          -- 올린 순서 번호 (자동으로 1씩 증가)
  card_id     text NOT NULL,      -- 이 첨부가 딸린 카드 (cards.id)
  name        text NOT NULL,      -- 원래 파일 이름 (화면·내려받기에 쓰는 이름)
  size        integer NOT NULL,   -- 파일 크기 (바이트)
  mime        text NOT NULL,      -- 파일 종류 (예: image/png, application/octet-stream)
  storage_key text NOT NULL,      -- 디스크에 저장된 파일 이름 (무작위 UUID)
  deleted_at  bigint,             -- 삭제 표시를 한 시각 (밀리초). 삭제 전이면 NULL
  rev         integer NOT NULL    -- 이 행이 마지막으로 바뀐 때의 전체 변경 번호
);
COMMENT ON TABLE  attachments             IS '카드의 첨부 파일 정보. 파일 자체는 서버 디스크의 첨부 폴더(기본: 앱 폴더 아래 data/uploads)에 storage_key 이름으로 저장한다. 카드당 5개, 파일당 10MB까지';
COMMENT ON COLUMN attachments.id          IS '첨부 ID (무작위 UUID 글자). 내려받기 주소 /api/files/{id} 에 쓰인다';
COMMENT ON COLUMN attachments.seq         IS '올린 순서 번호 (자동 증가)';
COMMENT ON COLUMN attachments.card_id     IS '이 첨부가 딸린 카드 (cards.id)';
COMMENT ON COLUMN attachments.name        IS '사용자가 올린 원래 파일 이름 (200자까지). 화면과 내려받을 때 이 이름을 쓴다';
COMMENT ON COLUMN attachments.size        IS '파일 크기 (바이트)';
COMMENT ON COLUMN attachments.mime        IS '파일 종류. 이미지(png jpg gif webp)와 PDF는 해당 종류(예: image/png), 나머지는 application/octet-stream(내려받기용)';
COMMENT ON COLUMN attachments.storage_key IS '서버 디스크에 저장된 파일 이름 (무작위 UUID). 원래 이름과 다르게 저장해 위험한 이름을 피한다';
COMMENT ON COLUMN attachments.deleted_at  IS '삭제 표시를 한 시각 (1970-01-01부터의 밀리초). 삭제 전이면 NULL. 삭제 표시 후 7일이 지나면 앱을 켤 때 행과 파일을 함께 지운다 (그 전에는 되돌리기로 복원 가능)';
COMMENT ON COLUMN attachments.rev         IS '이 행이 마지막으로 바뀐 때의 전체 변경 번호(meta.revision)';


-- -----------------------------------------------------------------------------
-- 9. dismissals : 닫은 마감 알림
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dismissals (
  seq      bigserial,       -- 닫은 순서 번호 (자동으로 1씩 증가)
  card_id  text NOT NULL,   -- 알림의 카드 (cards.id)
  kind     text NOT NULL,   -- 알림 종류: dayBefore / today / overdue
  due_date text NOT NULL,   -- 닫을 때의 마감일 'YYYY-MM-DD'
  PRIMARY KEY (card_id, kind, due_date)
);
COMMENT ON TABLE  dismissals          IS '사용자가 알림(🔔)에서 X로 닫은 마감 알림. 같은 카드·종류·마감일의 알림은 다시 보여 주지 않는다. 마감일이 바뀌면 새 알림으로 본다. 카드가 지워진 기록은 앱을 켤 때 정리한다';
COMMENT ON COLUMN dismissals.seq      IS '닫은 순서 번호 (자동 증가)';
COMMENT ON COLUMN dismissals.card_id  IS '알림의 카드 (cards.id)';
COMMENT ON COLUMN dismissals.kind     IS '알림 종류: dayBefore(하루 전) / today(당일) / overdue(마감 지남)';
COMMENT ON COLUMN dismissals.due_date IS '알림을 닫을 때의 카드 마감일 (YYYY-MM-DD)';


-- -----------------------------------------------------------------------------
-- 10. changes : 변경 기록 (다른 탭이 바뀐 것만 가져갈 때 쓰는 기록)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS changes (
  revision  integer NOT NULL,   -- 그 변경의 전체 변경 번호 (meta.revision)
  kind      text NOT NULL,      -- 바뀐 것의 종류: board / column / card / check / comment / attachment / dismissal
  entity_id text NOT NULL,      -- 바뀐 행의 ID (닫은 알림은 '카드ID|종류|마감일')
  action    text NOT NULL       -- create(생김) / update(바뀜) / delete(지워짐)
);
COMMENT ON TABLE  changes           IS '변경 기록. 다른 탭이 "내가 가진 번호 이후에 무엇이 바뀌었나"를 물을 때 이 표를 본다. 최근 5000번의 변경까지만 남기고 오래된 것은 지운다 (그보다 오래되면 전체 데이터를 다시 보낸다)';
COMMENT ON COLUMN changes.revision  IS '그 변경의 전체 변경 번호 (meta.revision 값). 한 번의 작업으로 여러 행이 바뀌면 같은 번호가 여러 줄';
COMMENT ON COLUMN changes.kind      IS '바뀐 것의 종류: board(보드) / column(열) / card(카드) / check(체크리스트) / comment(댓글) / attachment(첨부) / dismissal(닫은 알림)';
COMMENT ON COLUMN changes.entity_id IS '바뀐 행의 ID. 닫은 알림(dismissal)은 카드ID|종류|마감일 모양';
COMMENT ON COLUMN changes.action    IS '어떻게 바뀌었나: create(새로 생김) / update(내용이 바뀜) / delete(지워짐)';


-- -----------------------------------------------------------------------------
-- 찾기용 인덱스 : "어떤 보드의 열", "어떤 열의 카드"처럼 자주 찾는 것을 빠르게
-- (이미 있으면 그대로 둠. 인덱스를 만들려면 표의 주인 계정이어야 함)
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_columns_board ON board_columns (board_id);   -- 보드의 열 찾기
CREATE INDEX IF NOT EXISTS idx_cards_column  ON cards (column_id);          -- 열의 카드 찾기
CREATE INDEX IF NOT EXISTS idx_checks_card   ON check_items (card_id);      -- 카드의 체크리스트 찾기
CREATE INDEX IF NOT EXISTS idx_comments_card ON comments (card_id);         -- 카드의 댓글 찾기
CREATE INDEX IF NOT EXISTS idx_att_card      ON attachments (card_id);      -- 카드의 첨부 찾기
CREATE INDEX IF NOT EXISTS idx_changes_rev   ON changes (revision);         -- 몇 번 이후의 변경 기록 찾기

COMMENT ON INDEX idx_columns_board IS '보드의 열을 빠르게 찾기 위한 인덱스 (board_columns.board_id)';
COMMENT ON INDEX idx_cards_column  IS '열의 카드를 빠르게 찾기 위한 인덱스 (cards.column_id)';
COMMENT ON INDEX idx_checks_card   IS '카드의 체크리스트를 빠르게 찾기 위한 인덱스 (check_items.card_id)';
COMMENT ON INDEX idx_comments_card IS '카드의 댓글을 빠르게 찾기 위한 인덱스 (comments.card_id)';
COMMENT ON INDEX idx_att_card      IS '카드의 첨부를 빠르게 찾기 위한 인덱스 (attachments.card_id)';
COMMENT ON INDEX idx_changes_rev   IS '몇 번 이후의 변경 기록을 빠르게 찾기 위한 인덱스 (changes.revision)';

-- 끝. DBeaver에서는 표나 칸을 누르면 아래쪽 속성(Properties)의 Comment/설명에서 위 설명을 볼 수 있습니다.
