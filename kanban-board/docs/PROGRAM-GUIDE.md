# 칸반 보드 프로그램 설명서

이 설명서는 칸반 보드가 **어떻게 만들어져 있고 어떻게 움직이는지**를 설명합니다.
앱을 고치거나 운영할 사람을 위한 문서이지만, 개발자가 아니어도 흐름을 이해할 수 있게 그림과 표를 많이 넣었습니다.

- 앱 쓰는 법: [사용자 설명서](USER-GUIDE.md)
- 서버에 설치·업데이트·백업하는 법: [설치 안내서](DEPLOY-UBUNTU.md)

## 목차

1. [한눈에 보기](#1-한눈에-보기)
2. [사용한 기술](#2-사용한-기술)
3. [폴더와 파일 지도](#3-폴더와-파일-지도)
4. [데이터 구조](#4-데이터-구조)
5. [서버 API](#5-서버-api)
6. [동작 원리](#6-동작-원리)
7. [설정 (.env)](#7-설정-env)
8. [운영 스크립트 (deploy/)](#8-운영-스크립트-deploy)
9. [개발하기](#9-개발하기)
10. [시험 (테스트)](#10-시험-테스트)
11. [바꿔 끼울 수 있게 만든 곳](#11-바꿔-끼울-수-있게-만든-곳)
12. [알려진 한계](#12-알려진-한계)

---

## 1. 한눈에 보기

```mermaid
flowchart LR
  subgraph PC["내 PC"]
    T1["브라우저 탭 1<br/>(대표 탭)"]
    T2["브라우저 탭 2, 3 …"]
  end
  subgraph SV["우분투 서버"]
    APP["칸반 앱 (Next.js)<br/>127.0.0.1:3000"]
    DB[("PostgreSQL<br/>데이터베이스 kanbandb")]
    FS[("첨부 파일<br/>data/uploads")]
  end
  T1 -- "SSH 터널" --> APP
  T2 -- "SSH 터널" --> APP
  T1 -. "실시간 소식 나눠 주기<br/>(BroadcastChannel)" .-> T2
  APP --> DB
  APP --> FS
```

| 부분 | 하는 일 |
|---|---|
| 브라우저 화면 | 보드·카드를 그리고, 사용자가 한 일을 서버에 보냄. 응답을 기다리지 않고 화면에 먼저 보여 줌 |
| 칸반 앱 (서버) | 요청을 검사하고(보안), 데이터베이스에 저장하고, 바뀐 것을 실시간으로 알림 |
| PostgreSQL | 보드·열·카드·체크리스트·댓글·첨부 정보·변경 기록을 저장 |
| 첨부 폴더 | 첨부 파일 자체를 저장 (파일 이름은 무작위 ID, 원래 이름은 DB에) |

- 앱은 서버 안(`127.0.0.1`)에서만 열리고, 사용자는 **SSH 터널**로 접속합니다. 그래서 로그인 기능이 없습니다.
- 앱은 **프로세스 하나**로만 실행합니다 (실시간 알림이 그 프로세스 안에서만 전달되기 때문).

## 2. 사용한 기술

| 구분 | 기술 | 버전 |
|---|---|---|
| 웹 프레임워크 | Next.js (App Router, 서버 라우트) | 15.5 |
| 화면 | React | 19 |
| 언어 | TypeScript | 6 |
| 끌어서 놓기 | @dnd-kit (core, sortable) | 6 / 10 |
| 데이터베이스 | PostgreSQL (`pg` 드라이버) | 16·18에서 시험 |
| 실행 환경 | Node.js | 22.12 이상 |
| 시험 도구 | Vitest | 5 |

## 3. 폴더와 파일 지도

```
kanban-board/
├─ app/                 화면 진입점과 서버 API
│  ├─ layout.tsx        HTML 뼈대, 저장된 테마를 먼저 적용
│  ├─ page.tsx          첫 화면 (App 컴포넌트를 띄움)
│  ├─ globals.css       모든 화면 스타일 (밝게·어둡게 테마 포함)
│  └─ api/              서버 API (5장)
├─ components/          브라우저 화면 부품
├─ lib/                 서버·공용 로직
├─ deploy/              서버 운영 스크립트 (8장)
├─ docs/                설명서 (이 파일 포함)
├─ sql/                 데이터베이스 구조 스크립트 (schema.sql: 표·칸마다 한국어 설명)
├─ tests/               자동 시험 (10장)
├─ .env.example         설정 파일 견본
└─ package.json         부품 목록과 명령 (dev, build, start, test)
```

**화면 부품 (`components/`)**

| 파일 | 하는 일 |
|---|---|
| `App.tsx` | 화면 전체의 두뇌. 데이터 불러오기, 변경 요청 보내기(요청 줄 세우기·먼저 보여 주기), 되돌리기, 실시간 동기화(대표 탭), 필터, 선택, 알림, 테마, 끌어서 놓기 처리 |
| `Board.tsx` | 열(`ColumnView`), 카드(`SortableCard`, `CardFace`), `+ 열 추가` |
| `CardModal.tsx` | 카드 창: 제목·설명·담당자·마감일·반복·소속 열, 체크리스트, 댓글, 첨부 |
| `Views.tsx` | 마감일 보기, 모든 보드 검색 결과, 보관함 창, 알림(🔔) |
| `ui.tsx` | 공용 부품: 메뉴(화면 맨 위층에 띄움), 이름 고치기 칸, 한글 입력 중 Enter 처리, 창 안에 키보드 초점 가두기 |
| `api.ts` | 서버 API를 부르는 함수들 |
| `util.ts` | 오늘 날짜, 브라우저 저장소, "글 쓰는 칸인지" 판별, 카드 자리 계산 |

**서버·공용 로직 (`lib/`)**

| 파일 | 하는 일 |
|---|---|
| `repository.ts` | **데이터 저장의 중심.** 표 만들기, 모든 변경 작업, 변경 번호·기록, 되돌리기 묶음 만들기·적용, 반복 카드, 정리 작업 |
| `server.ts` | DB 연결을 한 번만 만들어 나눠 쓰기, 시작할 때 정리, 요청 검사 → 처리 → 오류 응답, 종료 신호 처리 |
| `guard.ts` | 보안 검사 (주소·출처·요청 형식) |
| `auth.ts` | 로그인이 들어갈 자리 (지금은 항상 통과) |
| `feed.ts` | 실시간 알림 창구 (서버 프로세스 안에서 전달) |
| `storage.ts` | 첨부 파일 저장 창구와 정리(오래된 삭제 파일, 주인 없는 파일) |
| `upload.ts` | 첨부 검사: 허용 확장자, 크기, 파일 내용 확인, 내려받기 이름 |
| `history.ts` | 되돌리기·다시 실행 기록 (탭 메모리) |
| `sync.ts` | 다른 탭의 변경 묶음을 내 화면 데이터에 합치기 |
| `patchcheck.ts` | 되돌리기 요청이 올바른 모양인지 검사 |
| `filter.ts` | 검색·필터 규칙, 마감일 보기 묶음 |
| `notices.ts` | 마감 알림 계산 (하루 전·당일·마감 지남) |
| `dates.ts` | 날짜 검사, 다음 마감일 계산 |
| `types.ts` | 데이터 모양, 한도(`LIMITS`), 라벨 색, 오류 종류 |

## 4. 데이터 구조

```mermaid
erDiagram
  boards ||--o{ board_columns : "열"
  board_columns ||--o{ cards : "카드"
  cards ||--o{ check_items : "체크리스트"
  cards ||--o{ comments : "댓글"
  cards ||--o{ attachments : "첨부"
  cards ||--o{ dismissals : "닫은 알림"
```

| 표 | 주요 칸 | 설명 |
|---|---|---|
| `boards` | id, name, position | 보드. position은 왼쪽 목록의 순서 |
| `board_columns` | id, board_id, name, position, is_done | 열. is_done = 완료 열 |
| `cards` | id, column_id, title, description, assignee, due_date, repeat, labels, archived, position, followup_id | 카드. labels는 JSON 배열, followup_id는 이미 만든 다음 회차 카드 |
| `check_items` | id, card_id, text, done, position | 체크리스트 항목 |
| `comments` | id, card_id, body, created_at, updated_at | 댓글 |
| `attachments` | id, card_id, name, size, mime, storage_key, deleted_at | 첨부 정보. 파일은 storage_key 이름으로 디스크에. deleted_at이 있으면 "삭제 표시" 상태 |
| `dismissals` | card_id, kind, due_date | 닫은 마감 알림 |
| `meta` | revision | 데이터 전체의 **변경 번호** (무엇이든 바뀔 때마다 1씩 증가) |
| `changes` | revision, kind, entity_id, action | 변경 기록. 다른 탭이 "몇 번 이후 무엇이 바뀌었나"를 물을 때 씀. 최근 5,000건만 남김 |
| `app_settings` | key, value | 앱 설정 (예: 첫 보드를 만들었는지) |

- 모든 행에는 `rev`(그 행의 변경 번호)가 있어서, 되돌리기가 "그 사이 누가 바꿨는지"를 알아볼 수 있습니다.
- 날짜는 `YYYY-MM-DD` 글자로 저장합니다 (시간대 영향을 받지 않게).
- 표와 인덱스는 앱이 처음 DB에 붙을 때 **자동으로 만듭니다** (이미 있으면 그대로 둠). `DATABASE_SCHEMA`로 다른 스키마를 쓸 수 있습니다.
- 모든 칸의 자세한 설명은 **[`sql/schema.sql`](../sql/schema.sql)** 에 있습니다. 이 스크립트를 `kanban` 계정으로 한 번 실행하면 데이터베이스 안에도 표·칸 설명이 기록되어, DBeaver 같은 프로그램에서 표나 칸을 누르면 한국어 설명이 보입니다 (데이터는 바뀌지 않고, 여러 번 실행해도 안전).
- 표 구조를 바꿀 때는 `lib/repository.ts`와 `sql/schema.sql`을 함께 고칩니다. `tests/sql-schema.test.ts`가 두 구조가 똑같은지 확인합니다.

## 5. 서버 API

| 주소 | 방식 | 하는 일 |
|---|---|---|
| `/api/state` | GET | 전체 데이터(스냅숏)와 변경 번호 |
| `/api/changes?since=번호` | GET | 그 번호 이후 바뀐 행들. 너무 오래됐거나 서버가 더 옛날 상태면 전체 데이터 |
| `/api/events` | GET (SSE) | 실시간 알림 통로. 변경 번호(`change`)와 15초마다 살아 있음 신호(`ping`)를 보냄 |
| `/api/mutate` | POST (JSON) | 모든 변경 작업 (아래 표). 응답: 새 전체 데이터 + 되돌리기 묶음 |
| `/api/upload` | POST (JSON) | 첨부 올리기 (파일 내용은 base64 글자로) |
| `/api/files/{id}` | GET | 첨부 내려받기 |

**`/api/mutate`의 작업(`op`)**

| 분류 | 작업 |
|---|---|
| 보드 | `createBoard` `renameBoard` `deleteBoard` `duplicateBoard` |
| 열 | `addColumn` `renameColumn` `deleteColumn` `moveColumn`(dir: -1/1) `setColumnDone` |
| 카드 | `addCard` `updateCard`(fields: title, description, assignee, dueDate, repeat, labels) `moveCard`(toColumnId, index) `deleteCard` `duplicateCard` |
| 여러 카드 | `setArchived`(ids, archived) `bulkMove` `bulkDelete` |
| 체크리스트 | `addCheck` `updateCheck`(fields: text, done) `deleteCheck` |
| 댓글 | `addComment` `updateComment` `deleteComment` |
| 첨부 | `deleteAttachment` |
| 알림 | `dismiss`(cardId, kind, dueDate) |
| 되돌리기 | `patch`(patch, expect) |

- 오류는 `{ "error": "한국어 안내", "code": "INVALID" 등 }`과 상태 번호로 돌려줍니다 (잘못된 값 400, 없는 항목 404, DB 연결 문제 503 등).
- 변경 요청에는 화면의 `today`(브라우저 기준 오늘 날짜)가 함께 갑니다. 반복 카드의 "완료한 날"로 씁니다.

## 6. 동작 원리

### 6-1. 저장 한 번의 흐름

```mermaid
sequenceDiagram
  participant U as 사용자
  participant A as 화면 (App.tsx)
  participant S as 서버 (/api/mutate)
  participant D as PostgreSQL
  participant O as 다른 탭들
  U->>A: 카드를 옮김
  A->>A: 화면에 먼저 보여 줌 (낙관적 표시)
  A->>S: 요청 (요청 줄의 차례가 되면)
  S->>S: 보안 검사 (guard.ts)
  S->>D: BEGIN + meta 행 잠금 (쓰기는 한 번에 하나씩)
  S->>D: 변경 + 변경 번호 +1 + 변경 기록 + 행 번호
  S->>D: COMMIT
  S-->>A: 새 전체 데이터 + 되돌리기 묶음
  S-->>O: 실시간 알림 (변경 번호)
  O->>S: /api/changes?since=내 번호
  S-->>O: 바뀐 행들 → 화면에 합침
```

- **쓰기는 한 번에 하나씩**: 모든 변경은 `meta` 행을 잠근 트랜잭션 안에서 일어나서, 동시에 요청이 와도 순서가 꼬이지 않습니다 (예: 반복 카드가 두 번 생기지 않음).
- 읽기는 `REPEATABLE READ READ ONLY` 트랜잭션으로 한순간의 일관된 모습을 읽습니다.

### 6-2. 화면: 요청 줄 세우기와 먼저 보여 주기

- 한 탭의 변경 요청은 **줄을 세워 보낸 순서대로 하나씩** 처리합니다. 그래서 빠르게 여러 번 누르거나 연결이 느려도 결과·되돌리기 기록이 꼬이지 않습니다. (첨부 올리기만 오래 걸릴 수 있어 줄 밖에서 따로 처리)
- 화면 데이터는 **서버가 확인한 상태 + 아직 응답을 기다리는 변경**으로 계산합니다. 요청이 실패하면 그 변경만 걷어 내고, 다른 변경과 다른 탭의 변경은 그대로 둡니다.
- 늦게 도착한 옛 응답이 더 최신 화면을 덮지 않도록, 변경 번호가 같거나 큰 데이터만 받아들입니다.

### 6-3. 실시간 동기화

| 단계 | 설명 |
|---|---|
| 대표 탭 | 같은 브라우저의 탭들 중 **하나만** 서버와 실시간 연결(`/api/events`)을 맺습니다 (Web Locks로 정함). 브라우저는 주소 하나에 동시 연결을 6개까지만 열기 때문에, 탭마다 연결하면 탭 6개부터 앱이 멈춥니다 |
| 나눠 주기 | 대표 탭은 받은 소식을 `BroadcastChannel`로 다른 탭에 전합니다. 대표 탭을 닫으면 기다리던 다른 탭이 자동으로 대표를 이어받습니다 |
| 이어받기 | 소식을 받은 탭은 `/api/changes?since=내 번호`로 바뀐 것만 가져와 합칩니다 |
| 끊김 대비 | 서버는 15초마다 신호를 보내고, 40초 넘게 소식이 없으면 다시 연결하거나 각 탭이 직접 확인합니다. 탭을 다시 볼 때도 한 번 확인합니다 |
| 서버가 더 옛날일 때 | DB를 백업으로 되돌린 경우처럼 서버 번호가 화면보다 작으면 화면을 새로 불러옵니다 |
| 옛 브라우저 | Web Locks·BroadcastChannel이 없으면 탭마다 직접 연결합니다 |

### 6-4. 되돌리기와 다시 실행

```mermaid
flowchart LR
  A["변경 작업"] --> B["서버가 되돌리기 묶음을 만듦<br/>forward(다시 실행용) · inverse(되돌리기용)<br/>expect(그때의 행 번호)"]
  B --> C["탭의 기록(history.ts)에 쌓음<br/>최대 50개"]
  C -->|Ctrl+Z| D{"지금 행 번호가<br/>expect와 같은가?"}
  D -->|같음| E["inverse 적용 → 다시 실행 목록으로"]
  D -->|다름: 다른 탭이 바꿈| F["덮어쓰지 않고 건너뜀 + 안내"]
```

- 되돌리기 요청(`patch`)은 서버가 모양·한도를 검사하고(`patchcheck.ts`), 부모가 사라진 고아 데이터가 생기지 않는지, 첨부 파일이 아직 있는지 확인한 뒤 적용합니다.
- 기록은 탭 메모리에만 있어서 새로고침하면 사라집니다 (사양).

### 6-5. 반복 카드

- `moveCard`·`bulkMove`로 반복 카드(`repeat`가 `none`이 아니고 마감일이 있음)를 **완료 열이 아닌 열 → 완료 열**로 옮길 때, 같은 트랜잭션 안에서 다음 회차 카드를 만듭니다.
- 새 카드: 보드의 첫 번째 완료 열이 아닌 열 맨 끝, 마감일 = `today` + 1일/7일/1달(그 달에 같은 날이 없으면 마지막 날), 체크리스트는 체크 해제 상태로 복사. 원래 카드의 `followup_id`에 새 카드를 적어 두어 두 번 생기지 않게 합니다.

### 6-6. 첨부 파일

| 단계 | 내용 |
|---|---|
| 올리기 | 화면에서 종류·크기·개수를 먼저 검사 → JSON(base64)으로 전송 → 서버가 다시 검사 |
| 서버 검사 | 허용 확장자, 빈 파일·10MB 초과 거부, 카드당 5개, **이미지·PDF는 파일 앞부분으로 진짜인지 확인** |
| 저장 | 디스크에는 무작위 ID 이름으로 저장, 원래 이름은 DB에. DB 저장이 실패하면 파일도 지움 |
| 내려받기 | 이미지·PDF만 브라우저에서 바로 열고 나머지는 내려받기. `nosniff`, 한글 이름은 표준 방식(`filename*`)으로 |
| 삭제 | 바로 지우지 않고 "삭제 표시" → 7일이 지나면 **앱을 켤 때** 정리 (그 사이 되돌리기로 복원 가능) |
| 주인 없는 파일 | 앱을 켤 때, DB 어디에도 없는 파일 중 ID 모양이고 5분 넘게 지난 것을 지움 |

### 6-7. 보안

| 대책 | 내용 |
|---|---|
| 서버 안에서만 열기 | `next start -H 127.0.0.1`. 바깥에서는 SSH 터널로만 접속 |
| 주소 검사 | 모든 요청의 `Host`가 `localhost`·`127.0.0.1`·`[::1]`과 허용 포트(`KANBAN_ALLOWED_PORTS`, 기본 3000)여야 함. 다른 사이트가 내 서버 주소를 흉내 내는 공격(DNS 리바인딩) 방지 |
| 출처 검사 | 변경 요청은 `Origin`이 로컬이어야 하고, `Sec-Fetch-Site`가 다른 사이트면 거부. `Content-Type`은 JSON만 |
| 입력 검사 | 모든 SQL은 값 자리표시(`?`)로 전달, 글자 수·형식 검사, NUL 문자 거부, 되돌리기 묶음 검사 |
| 파일 | 위험한 종류(SVG, 실행 파일) 거부, 내려받기 이름 정리 |
| 로그인 | 없음. 서버 SSH 계정이 있는 사람은 누구나 쓸 수 있음 (`auth.ts`에 붙일 자리) |

### 6-8. 오류와 회복

| 상황 | 앱의 동작 |
|---|---|
| DB 연결 설정이 틀림 | 원인별 한국어 안내(비밀번호, DB 이름, 권한, 연결 안 됨)를 503으로 돌려줌. `start.sh`가 이 안내를 그대로 보여 줌 |
| DB가 잠시 꺼짐 | 앱은 죽지 않고, DB가 다시 켜지면 **재시작 없이** 다시 연결 |
| 오래 걸리는 작업 | 문장 30초, 잠금 대기 15초, 열린 트랜잭션 방치 60초, 연결 대기 15초에서 끊고 안내 |
| 앱 종료 (`Ctrl+C`, `stop.sh`) | 실시간 연결을 모두 닫고, 종료 중에는 새 요청에 503 + `Connection: close` |

### 6-9. 앱을 켤 때 하는 일

1. DB에 연결하고 표·인덱스를 만듦 (이미 있으면 그대로)
2. 처음이면 `내 첫 보드`를 한 번 만듦
3. 주인 없는 "닫은 알림" 기록 정리
4. 첨부 정리 (7일 지난 삭제 표시 파일, 주인 없는 파일)

> 이 작업들은 앱이 켜진 뒤 **첫 요청이 올 때** 실행됩니다. `start.sh`는 켜자마자 한 번 요청해서 DB 연결까지 확인합니다.

## 7. 설정 (.env)

| 이름 | 꼭 필요? | 설명 | 예 |
|---|---|---|---|
| `DATABASE_URL` | 예 | PostgreSQL 연결 주소 | `postgres://kanban:비밀번호@127.0.0.1:5432/kanbandb` |
| `DATABASE_SCHEMA` | 아니오 | 표를 만들 스키마 (기본 `public`) | `kanban_app` |
| `KANBAN_UPLOADS` | 아니오 | 첨부 폴더 (기본: 앱 폴더 아래 `data/uploads`) | `/srv/kanban/uploads` |
| `KANBAN_ALLOWED_PORTS` | 아니오 | 터널의 PC 쪽 포트가 3000이 아닐 때 허용할 포트 (기본 `3000`) | `3000,8080` |

- `.env`는 앱을 켤 때 한 번 읽습니다. 고친 뒤에는 앱을 껐다 켜야 합니다 (빌드는 다시 하지 않아도 됨).
- 값이 비어 있으면(`KANBAN_UPLOADS=`) 적지 않은 것으로 봅니다.
- 비밀번호에 `$ # % / ? @ :`나 공백을 쓰면 연결 주소가 깨질 수 있습니다 ([설치 안내서 4단계](DEPLOY-UBUNTU.md#4단계-postgresql-준비-관리자)).
- 앱의 주소와 포트(`127.0.0.1:3000`)는 `package.json`의 `start` 명령에 정해져 있습니다.

## 8. 운영 스크립트 (deploy/)

모두 **kanban 사용자**로 실행하고, root로 실행하면 거부합니다. 자세한 쓰는 법은 [설치 안내서](DEPLOY-UBUNTU.md)에 있습니다.

| 스크립트 | 하는 일 | 미리 확인하는 것 |
|---|---|---|
| `start.sh` | tmux 창(`kanban`) 안에서 `npm start` → 최대 60초 동안 `/api/state`로 DB 연결까지 확인 → 결과를 한국어로 | `.env`·빌드가 있는지, 이미 켜져 있는지, 3000번을 다른 프로그램이 쓰는지 |
| `stop.sh` | tmux 창에 `Ctrl+C` → 안 꺼지면 이 계정의 앱에 종료 신호 → 창 정리 | — |
| `update.sh` | GitHub에서 받기 → **GitHub에서 지워진 파일 정리** → 새 코드로 바꾸기 → `npm ci` → `npm run build` | 앱이 꺼져 있는지, 파일 주인, 받은 코드에 앱 폴더가 있는지. `.env`·`data`·`backups`·`node_modules`는 보호 |
| `backup.sh` | `pg_dump`(다시 넣을 때 기존 표를 지우고 만드는 형식) + 첨부 폴더 묶음을 **같은 시각 이름**으로 `backups/`에 | 백업 파일이 완전한지 |
| `restore.sh` | 복원 전 자동 백업 → DB를 **한 트랜잭션으로** 복원 → 지금 첨부 폴더는 옮겨 두고 백업의 첨부를 풀기 | 앱이 꺼져 있는지, 두 파일이 다 있고 온전한지, `복원`이라고 입력했는지 |
| `pgenv.cjs` | `.env`의 `DATABASE_URL`을 앱과 똑같이 읽어 `pg_dump`·`psql`용 환경 변수로 바꿈 (비밀번호가 화면·명령줄에 드러나지 않게) | — |

- 스크립트는 모두 `main` 함수 안에 있고 마지막 줄에서 실행 후 바로 끝납니다. `update.sh`가 실행 도중 자기 자신을 새 버전으로 바꿔도 안전하게 하기 위해서입니다.

## 9. 개발하기

```bash
npm ci
```

```bash
npm run dev
```

`npm run dev`는 개발용 서버(`127.0.0.1:3000`, 고치면 바로 반영)입니다. 배포용은 `npm run build` 후 `npm start`.

| 이런 것을 바꾸려면 | 이 파일 |
|---|---|
| 화면 모양·색 | `app/globals.css` |
| 보드·열·카드 화면 | `components/Board.tsx` |
| 카드 창 | `components/CardModal.tsx` |
| 화면 동작 전체 (요청, 되돌리기, 실시간, 필터) | `components/App.tsx` |
| 저장 규칙·새 작업 추가 | `lib/repository.ts` + `app/api/mutate/route.ts` |
| 글자 수 등 한도 | `lib/types.ts`의 `LIMITS` (서버·화면이 함께 씀) |
| 첨부 허용 종류 | `lib/upload.ts`의 `ALLOWED_EXT` |
| 보안 규칙 | `lib/guard.ts` |

**고칠 때 지킬 것**

- 데이터를 바꾸는 작업은 `repository.ts`의 `write()`와 `mutate()`를 거치게 하세요. 그래야 변경 번호·변경 기록·되돌리기 묶음이 함께 만들어집니다.
- 한도나 규칙은 화면과 서버가 **둘 다** 검사합니다. 하나만 고치지 마세요.
- 앱은 프로세스 하나로만 실행합니다. 여러 개로 늘리려면 `feed.ts`부터 바꿔야 합니다 (11장).

## 10. 시험 (테스트)

```bash
export TEST_DATABASE_URL=postgres://사용자:비밀번호@127.0.0.1:5432/시험용DB
```

```bash
npm test
```

시험은 매번 무작위 이름의 스키마를 만들었다가 지우므로 다른 데이터에 영향을 주지 않습니다. 시험용 DB는 운영 DB(`kanbandb`)와 **따로** 만드세요.

| 시험 파일 | 개수 | 확인하는 것 |
|---|---|---|
| `repository.test.ts` | 19 | 첫 보드, 변경 번호, 카드 이동·삭제, 열 규칙, 이름·제목·날짜 검사, 되돌리기 충돌, 삭제 되돌리기 |
| `features.test.ts` | 43 | 라벨, 체크리스트, 댓글, 보관함, 카드·보드 복제, 여러 카드 작업, 반복 카드, 첨부, 알림 닫기, 변경 이어받기, 도중 실패 시 전부 취소 |
| `history.test.ts` | 4 | 되돌리기 기록 (50단계, 다른 탭 변경은 건너뜀) |
| `concurrency.test.ts` | 11 | 동시에 요청이 와도 올바른지 (반복 카드는 한 번만, 위치 번호 겹침 없음 등) |
| `resilience.test.ts` | 6 | DB 연결이 끊기거나 잠금이 오래가도 멈추지 않고 다시 살아나는지 |
| `hardening.test.ts` | 6 | 이상한 글자·숫자·연도, 연결 대기 시간 제한, 이상한 파일이 있을 때의 첨부 정리 |
| `review.test.ts` | 33 | 독립 검토와 무작위 시험에서 찾았던 문제들이 다시 생기지 않는지 |
| `guard.test.ts` | 15 | 보안 검사, 설정 값(`KANBAN_ALLOWED_PORTS`, `KANBAN_UPLOADS`) 읽기 |
| `lib.test.ts` | 27 | 날짜 계산, 검색·필터, 마감일 보기, 알림 계산, 첨부 검사, 변경 합치기 |
| `fuzz.test.ts` | 1 | 무작위 작업을 섞어 실행해도 데이터가 망가지지 않고, 전부 되돌리면 처음으로 돌아오는지 |
| `sql-schema.test.ts` | 3 | `sql/schema.sql`이 앱이 만드는 표 구조와 똑같은지, 모든 표·칸에 설명이 들어가는지, 쓰던 DB에 실행해도 데이터가 그대로인지 |

모두 168개입니다.

더 크게 무작위 시험을 하려면:

```bash
FUZZ_SEEDS=300 FUZZ_STEPS=100 npm test
```

> 개발 중에는 실제 브라우저(Chromium)로 화면을 조작하는 시험 10종(228개 항목)도 돌렸습니다. 이 브라우저 시험 스크립트는 아직 저장소에 넣지 않았습니다.

## 11. 바꿔 끼울 수 있게 만든 곳

| 창구 | 지금 | 바꾸는 경우 |
|---|---|---|
| `lib/auth.ts` | 항상 통과 | 로그인을 붙일 때 |
| `lib/storage.ts` (`StorageAdapter`) | 서버 디스크 | 첨부를 다른 저장소에 둘 때 |
| `lib/feed.ts` (`ChangeFeed`) | 한 프로세스 안에서 전달 | 서버를 여러 대·여러 프로세스로 늘릴 때 (예: PostgreSQL LISTEN/NOTIFY) |
| `lib/repository.ts` (`BoardRepository`) | PostgreSQL | 다른 데이터베이스를 쓸 때 |

## 12. 알려진 한계

| 한계 | 설명 |
|---|---|
| 프로세스 하나 | 실시간 알림이 프로세스 안에서만 전달됨 |
| 로그인·작성자 기록 없음 | 누가 바꿨는지 남지 않음 |
| 매 변경마다 전체 데이터 응답 | 카드가 아주 많으면(예: 1,700장에 약 0.5MB) 느린 연결에서 부담. 앱이 압축해서 보내지 않으므로 SSH 터널에 `-C`(압축)를 쓰면 약 1/8로 줄어듦 |
| 되돌리기 기록 | 탭 메모리에만, 새로고침하면 사라짐 (사양) |
| 삭제한 첨부 정리 시점 | 앱을 켤 때만 정리. 오래 켜 두면 7일이 지나도 디스크에 남음 |
| 자동 시작·자동 백업 없음 | 재부팅 후 `start.sh`, 백업은 `backup.sh`를 직접 실행 |
| 확인한 환경 | Linux의 Chromium 브라우저. Windows·Mac, Firefox·Safari는 직접 확인하지 못함 |
