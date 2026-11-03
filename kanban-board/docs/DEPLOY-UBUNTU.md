# 우분투 서버에 설치하기 (/home/kanban-board, PostgreSQL, SSH 터널 접속)

이 안내서는 **우분투에 아무것도 설치되어 있지 않은 상태**에서 시작합니다.
앱은 서버 안에서만(127.0.0.1) 열리고, 내 PC에서는 **SSH 터널**로 접속합니다. 그래서 로그인 기능이 없어도 안전합니다.

> 명령어는 위에서 아래로 **한 줄(또는 한 덩어리)씩** 실행하세요.
> `sudo`가 붙은 줄은 관리자 권한이 필요합니다. 비밀번호를 물으면 서버 계정 비밀번호를 입력합니다.

## 전체 그림

| 구분 | 내용 |
|---|---|
| 앱 위치 | `/home/kanban-board/work/kanban-board` |
| 실행하는 사용자 | `kanban` (관리자가 아닌 전용 사용자) |
| 데이터베이스 | 같은 서버의 PostgreSQL (`kanban` 데이터베이스) |
| 첨부 파일 | `/home/kanban-board/work/kanban-board/data/uploads` (디스크에 저장, 앱이 처음 실행할 때 알아서 만듦) |
| 접속 방법 | 내 PC → SSH 터널 → 서버의 `127.0.0.1:3000` |
| 실행 방식 | 직접 실행 (`tmux`로 켜 두기) |

## 1단계. 우분투 버전 확인

```bash
lsb_release -a
psql --version
```

**제가 직접 시험해 본 환경**

| 항목 | 시험한 것 | 시험하지 못한 것 |
|---|---|---|
| 우분투 | 24.04 (설치 안내서를 `kanban` 사용자로 글자 그대로 따라 해 봄) | **26.04** (이 안내서가 만들어질 때 확인할 수 없었어요) |
| PostgreSQL | **16**, **18.6** (자동 테스트와 브라우저 시험 모두 통과) | 14 |
| Node.js | 22 | 20, 24 |

우분투 26.04에서는 2단계의 `apt` 패키지 이름이나 Node.js 설치 방법이 다를 수 있어요. 막히면 오류 메시지를 알려 주세요.

## 2단계. 필요한 프로그램 설치

```bash
sudo apt update
```

```bash
sudo apt install -y git curl ca-certificates build-essential tmux postgresql
```

| 설치되는 것 | 용도 |
|---|---|
| `git` | GitHub에서 코드 받기 |
| `curl`, `ca-certificates` | 인터넷에서 파일 받기 |
| `build-essential` | 일부 부품 설치용 도구 (이 앱은 직접 필요 없지만 npm이 가끔 씁니다) |
| `tmux` | SSH를 끊어도 앱이 계속 돌게 하는 도구 |
| `postgresql` | 데이터베이스 (우분투 22.04는 14, 24.04는 16 버전) |

> **PostgreSQL이 이미 설치되어 있다면**(`psql --version`이 나온다면) 위 명령에서 `postgresql`은 빼도 됩니다.
> 켜져 있는지는 `sudo systemctl status postgresql`로 확인하세요(`active`면 정상).

**Node.js 22 설치** (우분투 기본 저장소의 Node는 버전이 낮을 수 있어 별도로 설치합니다)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
```

```bash
sudo apt install -y nodejs
```

```bash
node -v
npm -v
psql --version
```

`node -v`가 `v22.`로 시작하면 성공입니다. (NodeSource 안내가 바뀌었다면 https://github.com/nodesource/distributions 를 확인하세요.)

> **NodeSource가 내 우분투 버전을 지원하지 않아 실패하면** 두 가지 방법이 있어요.
> 1. `apt-cache policy nodejs`로 우분투 기본 저장소의 Node 버전을 확인하고, **20 이상**이면 `sudo apt install -y nodejs npm`으로 설치합니다. (제가 시험한 건 22뿐이라, 22가 아니면 7단계 `npm run build`가 끝까지 되는지 꼭 확인하세요.)
> 2. `nvm`(Node 버전 관리 도구)으로 `nvm install 22`를 합니다. 설치 명령은 https://github.com/nvm-sh/nvm 의 최신 안내를 따르세요. 이때는 `kanban` 사용자로 설치해야 합니다.

## 3단계. 전용 사용자와 폴더 만들기

```bash
sudo useradd -m -d /home/kanban-board -s /bin/bash kanban
```

이렇게 하면 `kanban` 사용자가 만들어지고 `/home/kanban-board`가 그 사용자의 폴더가 됩니다.
(다른 사용자 이름을 쓰고 싶으면 `kanban` 부분만 바꾸세요.)

## 4단계. PostgreSQL 준비

데이터베이스 사용자와 데이터베이스를 만듭니다. **비밀번호는 직접 정해서 기억해 두세요.** (이 대화창에는 쓰지 마세요.)

```bash
sudo -u postgres psql
```

`postgres=#` 모양의 입력창이 뜨면 아래를 입력합니다. `여기에_비밀번호`를 원하는 비밀번호로 바꾸세요.

```sql
CREATE USER kanban WITH PASSWORD '여기에_비밀번호';
CREATE DATABASE kanban OWNER kanban;
\q
```

연결이 되는지 확인합니다. 비밀번호를 물으면 방금 정한 비밀번호를 입력하세요.

```bash
psql -h 127.0.0.1 -U kanban -d kanban -c "select 'DB 연결 OK' as 결과;"
```

`DB 연결 OK`가 나오면 성공입니다.

> **보안:** PostgreSQL은 기본으로 서버 안에서만 접속을 받습니다. 바깥에서 접속하게 설정을 바꾸지 마세요.

## 5단계. 코드 받기

```bash
sudo -u kanban -H bash
```

위 명령으로 `kanban` 사용자로 바뀝니다. (이후 줄은 모두 이 상태에서 실행합니다. 나가려면 `exit`)

```bash
cd /home/kanban-board
git clone --branch claude/kanban-board-stage1-2 https://github.com/yangbongseung-creator/work
cd work/kanban-board
```

> 저장소는 공개라서 비밀번호 없이 받아집니다.

## 6단계. 설정 파일 만들기

```bash
cp .env.example .env
nano .env
```

`DATABASE_URL` 줄에서 `여기에_비밀번호`를 4단계에서 정한 비밀번호로 바꿉니다. 저장은 `Ctrl+O`, `Enter`, 나가기는 `Ctrl+X`.

```bash
DATABASE_URL=postgres://kanban:내비밀번호@127.0.0.1:5432/kanban
```

> 비밀번호에 `@ : / # ?` 같은 특수문자가 있으면 연결 주소가 깨집니다. 영문과 숫자로만 정하는 게 가장 쉽습니다.

파일을 나만 읽도록 잠급니다.

```bash
chmod 600 .env
```

## 7단계. 설치하고 빌드하기

```bash
npm ci
npm run build
```

몇 분 걸릴 수 있습니다. `npm run build`가 오류 없이 끝나야 합니다.

## 8단계. 실행하기 (tmux로 켜 두기)

```bash
tmux new -s kanban
```

```bash
npm start
```

`Ready` 비슷한 문구가 나오면 실행 중입니다. 처음 실행할 때 데이터베이스 표가 자동으로 만들어집니다.

| 하고 싶은 것 | 방법 |
|---|---|
| 켜 둔 채 화면에서 빠져나오기 | `Ctrl+B` 누른 뒤 `D` |
| 다시 들어가서 보기 | `tmux attach -t kanban` |
| 끄기 | tmux 안에서 `Ctrl+C` |

서버를 재부팅하면 앱도 꺼지므로, 재부팅 후에는 8단계를 다시 하세요.

## 9단계. 내 PC에서 접속하기 (SSH 터널)

**내 PC**의 터미널(Windows는 PowerShell)에서 실행합니다. `서버주소`와 `내사용자`는 서버에 SSH로 접속할 때 쓰는 값입니다.

```bash
ssh -L 3000:127.0.0.1:3000 내사용자@서버주소
```

이 창을 **열어 둔 채로**, 내 PC 브라우저에서 아래 주소를 엽니다.

```
http://127.0.0.1:3000
```

| 상황 | 해결 |
|---|---|
| 내 PC의 3000번 포트를 다른 프로그램이 쓰는 중 | `ssh -L 8080:127.0.0.1:3000 ...`로 바꾸고, 서버 `.env`에 `KANBAN_ALLOWED_PORTS=3000,8080`을 추가한 뒤 앱을 다시 시작하고, 브라우저에서 `http://127.0.0.1:8080`으로 접속 |
| 주소에 서버 IP를 넣었더니 "허용되지 않은 주소" | 정상입니다. 보안상 `127.0.0.1` 또는 `localhost`로만 접속됩니다 |

## 업데이트하는 방법

```bash
sudo -u kanban -H bash
cd /home/kanban-board/work/kanban-board
git pull
npm ci
npm run build
```

그다음 tmux 안의 앱을 `Ctrl+C`로 끄고 `npm start`로 다시 켭니다.

## 백업 (사양서에서는 제외했지만 꼭 해 두세요)

데이터는 두 군데에 있습니다. **둘 다** 백업해야 합니다.

```bash
# 1) 데이터베이스 (비밀번호를 물으면 입력)
pg_dump -h 127.0.0.1 -U kanban kanban > /home/kanban-board/backup-$(date +%F).sql

# 2) 첨부 파일
tar czf /home/kanban-board/uploads-$(date +%F).tar.gz -C /home/kanban-board/work/kanban-board data/uploads
```

복원은 `psql -h 127.0.0.1 -U kanban kanban < backup-날짜.sql` 입니다. 백업 파일은 **다른 곳(내 PC 등)에도 복사해 두세요.** 서버 디스크가 고장 나면 같이 사라집니다.

## 문제 해결

| 증상 | 확인할 것 |
|---|---|
| 화면에 "DB 연결 설정이 없어요" | `.env`가 앱 폴더(`work/kanban-board`)에 있는지, `DATABASE_URL`이 적혀 있는지 |
| `password authentication failed` | `.env`의 비밀번호가 4단계에서 정한 것과 같은지 |
| `connection refused` | `sudo systemctl status postgresql`로 PostgreSQL이 켜져 있는지 |
| `npm ci`가 실패 | Node 버전이 22인지(`node -v`), 인터넷이 되는지 |
| 접속이 안 됨 | SSH 터널 창이 열려 있는지, 앱이 켜져 있는지(`tmux attach -t kanban`) |
| 실시간 연결이 끊김 | 터널을 껐다 켜도 자동으로 다시 연결됩니다. 그래도 안 되면 새로고침 |

## 보안 체크

- 앱 포트(3000)와 PostgreSQL 포트(5432)를 **방화벽에서 열지 마세요.** 둘 다 서버 안에서만 쓰입니다.
- `ufw`를 쓴다면 SSH(22번)만 허용하면 충분합니다: `sudo ufw allow OpenSSH && sudo ufw enable`
  (켜기 전에 SSH 허용을 먼저 넣지 않으면 서버에 접속할 수 없게 됩니다.)
- `.env` 파일과 백업 파일에는 비밀번호나 개인 데이터가 있으니 남에게 보내지 마세요.
