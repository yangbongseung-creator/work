# 우분투 서버에 설치하기 (/home/kanban-board, PostgreSQL, SSH 터널 접속)

이 안내서는 **우분투에 아무것도 설치되어 있지 않은 상태**에서 시작합니다.
앱은 서버 안(127.0.0.1)에서만 열리고, 내 PC에서는 **SSH 터널**로 접속합니다.
그래서 로그인 기능이 없어도 바깥 인터넷에서는 앱에 닿을 수 없습니다. (단, 이 서버에 SSH로 들어올 수 있는 사람은 모두 앱을 쓸 수 있으니, 서버 계정은 믿을 수 있는 사람에게만 주세요.)

## 전체 그림

| 구분 | 내용 |
|---|---|
| 앱 위치 | `/home/kanban-board` (앱 파일이 이 폴더 바로 아래에 놓입니다) |
| 실행하는 사용자 | `kanban` (관리자가 아닌 전용 사용자) |
| 데이터베이스 | 같은 서버의 PostgreSQL (`kanban` 데이터베이스) |
| 첨부 파일 | `/home/kanban-board/data/uploads` (앱이 처음 쓸 때 알아서 만듦) |
| 접속 방법 | 내 PC → SSH 터널 → 서버의 `127.0.0.1:3000` |
| 켜고 끄기 | `bash ~/deploy/start.sh` / `bash ~/deploy/stop.sh` (tmux 안에서 계속 돌게 해 줌) |
| 업데이트 | `bash ~/deploy/update.sh` |
| 백업·복원 | `bash ~/deploy/backup.sh` / `bash ~/deploy/restore.sh` |

## 시작하기 전에 꼭 알아 둘 것

**1) 지금 내가 "누구"인지 확인하는 법**

명령을 치는 줄 맨 앞(프롬프트)을 보면 압니다. 이 안내서는 두 가지 상태를 오갑니다.

| 프롬프트 모양 | 상태 | 할 수 있는 것 |
|---|---|---|
| `내계정@서버:~$` | **관리자** (평소 SSH로 들어오는 계정) | `sudo`가 붙은 명령 (프로그램 설치, 사용자 만들기 등) |
| `kanban@서버:~$` | **kanban** (앱 전용 사용자) | 앱 받기·빌드·켜기·끄기·업데이트·백업 |

- 관리자 → kanban으로 바꾸기: `sudo -iu kanban`
- kanban → 관리자로 돌아가기: `exit`
- **kanban 상태에서는 어떤 명령에도 `sudo`를 붙이지 마세요.** 비밀번호를 물어도 답할 수 없고(kanban에는 비밀번호가 없음), 억지로 관리자 권한으로 실행하면 파일 주인이 꼬여 나중에 `Permission denied`, `EACCES`, `dubious ownership` 같은 오류가 납니다. (이미 그랬다면 [문제 해결](#문제-해결)의 첫 줄을 보세요.)

**2) 명령은 한 줄(또는 한 덩어리)씩 붙여 넣으세요.** 특히 `sudo -iu kanban`은 **반드시 그 줄만** 실행하고, 프롬프트가 `kanban@…`으로 바뀐 것을 본 뒤 다음으로 가세요. (여러 줄을 한꺼번에 붙여 넣으면 뒷줄이 비밀번호 입력으로 먹히거나 엉뚱한 계정으로 실행됩니다.)

**3) 서버 사양**: 메모리(RAM)는 빌드할 때 약 0.8GB를 씁니다. RAM이 **2GB 미만**이면 2단계의 "스왑 만들기"를 하세요. 디스크는 **2GB 이상** 비어 있어야 합니다 (부품 약 600MB + 빌드 + 백업).

## 1단계. 서버 상태 확인 (관리자)

```bash
lsb_release -a
```

```bash
free -h
```

```bash
df -h /home
```

| 확인할 것 | 기준 |
|---|---|
| 우분투 버전 (`Release:`) | 26.04, 24.04, 22.04 중 하나 |
| `free -h`의 `Mem:` 합계 | 2GB 미만이면 2단계에서 스왑 만들기 |
| `df -h /home`의 `Avail` | 2GB 이상 |

**제가 직접 시험해 본 환경**

| 항목 | 시험한 것 | 시험하지 못한 것 |
|---|---|---|
| 우분투 | **26.04** (우분투 기본 Node 22.22 + PostgreSQL 18.6으로 이 안내서를 처음부터 끝까지), 24.04 (예전 판 안내서) | 22.04 |
| PostgreSQL | **16**, **18.6** (자동 시험과 브라우저 시험 모두 통과) | 14 |
| Node.js | **22** (22.22, 22.23) | 20, 24 |
| 내 PC | Linux의 Chromium 브라우저 + OpenSSH 터널 | Windows, Mac, Firefox, Safari (화면 동작은 같을 것으로 보지만 직접 확인하지는 못했어요) |

## 2단계. 필요한 프로그램 설치 (관리자)

```bash
sudo apt update
```

```bash
sudo apt install -y git curl ca-certificates tmux nano postgresql
```

| 설치되는 것 | 용도 |
|---|---|
| `git` | GitHub에서 코드 받기 |
| `curl`, `ca-certificates` | 인터넷에서 파일 받기, 앱이 켜졌는지 확인 |
| `tmux` | SSH를 끊어도 앱이 계속 돌게 하는 도구 |
| `nano` | 설정 파일을 고치는 간단한 편집기 |
| `postgresql` | 데이터베이스 (우분투 26.04는 18, 24.04는 16, 22.04는 14 버전) |

> PostgreSQL이 이미 설치되어 있다면 위 명령을 그대로 실행해도 괜찮습니다 (이미 있으면 건너뜀).

**Node.js 설치** — 우분투 버전에 따라 방법이 다릅니다.

| 우분투 | 방법 |
|---|---|
| **26.04** | 우분투에 들어 있는 Node 22를 그대로 씁니다: 아래 ①만 |
| 24.04, 22.04 | 우분투에 들어 있는 Node가 너무 낮아서(18 이하) NodeSource에서 받습니다: 아래 ② |

① 우분투 26.04:

```bash
sudo apt install -y nodejs npm
```

② 우분투 24.04 / 22.04:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o nodesource_setup.sh
```

```bash
sudo bash nodesource_setup.sh
```

```bash
sudo apt install -y nodejs
```

확인:

```bash
node -v
```

**`v22.12` 이상**(예: `v22.22.1`)이면 성공입니다. 그보다 낮으면 7단계의 `npm ci`가 실패합니다.

**PostgreSQL 확인:**

```bash
pg_lsclusters
```

`Port`가 `5432`, `Status`가 `online`인 줄이 있어야 합니다. (`online`이 아니면 `sudo systemctl start postgresql`)
예전 버전에서 업그레이드한 서버라서 줄이 여러 개이고 5432가 옛 버전이라면, 6단계 `.env`의 포트를 새 버전의 포트(예: 5433)로 적으세요.

```bash
sudo -u postgres psql -c "SHOW listen_addresses;"
```

`localhost`가 나오면 바깥에서는 데이터베이스에 닿을 수 없는 안전한 상태입니다. (`*`이면 누군가 바꿔 둔 것이니 서버 관리자에게 확인하세요.)
`could not change directory to "/home/…": Permission denied`라는 경고가 함께 나와도 무시해도 됩니다 (4단계의 `sudo -u postgres psql`도 마찬가지).

**스왑 만들기** (1단계에서 RAM이 2GB 미만이었을 때만):

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
```

```bash
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

`free -h`의 `Swap:` 줄에 `2.0Gi`가 보이면 됩니다. (이미 `/swapfile`이 있다는 오류가 나오면 건너뛰세요.)

## 3단계. 전용 사용자와 폴더 만들기 (관리자)

```bash
sudo useradd -m -d /home/kanban-board -s /bin/bash kanban
```

```bash
sudo chown -R kanban:kanban /home/kanban-board && sudo chmod 750 /home/kanban-board
```

```bash
getent passwd kanban
```

마지막 줄이 `…:/home/kanban-board:/bin/bash`로 끝나면 성공입니다.
(두 번째 명령은 `/home/kanban-board`가 예전에 다른 계정으로 만들어져 있었어도 kanban의 것이 되게 합니다. 여러 번 실행해도 괜찮습니다.)

## 4단계. PostgreSQL 준비 (관리자)

**먼저 비밀번호를 정하세요.** 규칙: **영문 대소문자와 숫자로만, 16자 이상** (예: `Abc123xyz789Qwe45` — 이 예시는 쓰지 말고 직접 만드세요).

> 아래 글자는 쓰지 마세요. 연결 주소를 깨뜨리거나 **조용히 잘라 버려서** "비밀번호가 틀렸다"는 엉뚱한 오류가 납니다.
>
> | 글자 | 문제 |
> |---|---|
> | `$` | `.env`를 읽을 때 **그 뒤가 사라집니다** (`pa$word12` → `pa`). 가장 찾기 어려운 함정입니다 |
> | `#` | `.env`에서 **그 뒤가 메모로 취급되어 사라집니다** |
> | `% / ? @ :` | 연결 주소의 구분 글자라서 주소 해석이 깨집니다 |
> | 공백, 따옴표 `'` `"` | 값이 잘리거나 따옴표까지 비밀번호로 읽힙니다 |
>
> 비밀번호는 이 대화창이나 메신저에 적지 말고, 따로 안전한 곳에 적어 두세요.

```bash
sudo -u postgres psql
```

`postgres=#` 모양의 입력창이 뜨면 아래를 **한 줄씩** 입력합니다.

```sql
CREATE USER kanban;
```

```sql
\password kanban
```

`Enter new password`가 나오면 정한 비밀번호를 입력하고 Enter, 한 번 더 입력하고 Enter. (입력해도 화면에 글자가 보이지 않는 것이 정상입니다. 이 방법은 비밀번호가 기록에 남지 않습니다.)

```sql
CREATE DATABASE kanban OWNER kanban;
```

```sql
\q
```

연결 확인 (비밀번호를 물으면 방금 정한 비밀번호):

```bash
psql -h 127.0.0.1 -U kanban -d kanban -c "select 'DB 연결 OK' as 결과;"
```

`DB 연결 OK`가 나오면 성공입니다.

## 5단계. 코드 받기 (kanban)

```bash
sudo -iu kanban
```

↑ **이 줄만** 먼저 실행하고, 프롬프트가 `kanban@…`으로 바뀐 것을 확인하세요.

코드는 숨김 폴더 `.source`에 받아 두고, 그중 **앱 부분만** `/home/kanban-board` 바로 아래로 풀어 놓습니다.
(GitHub 저장소 안에서 앱이 `kanban-board`라는 하위 폴더에 들어 있기 때문입니다.)

```bash
cd /home/kanban-board
```

```bash
git clone --depth 1 --branch claude/kanban-board-stage1-2 https://github.com/yangbongseung-creator/work .source
```

```bash
git -C .source archive HEAD kanban-board | tar -x --strip-components=1 -C /home/kanban-board
```

```bash
ls
```

`ls` 결과에 `package.json`, `app`, `lib`, `deploy`, `docs` 등이 보이면 성공입니다.

| 이런 메시지가 나오면 | 뜻과 할 일 |
|---|---|
| `fatal: destination path '.source' already exists` | 이미 받은 적이 있어요. 5단계 대신 [업데이트](#업데이트하는-방법)를 하세요 |
| `could not create work tree dir '.source': Permission denied` | 폴더 주인이 kanban이 아니에요. `exit`로 관리자로 돌아가 3단계의 `chown` 명령을 하고 다시 오세요 |

## 6단계. 설정 파일 만들기 (kanban)

```bash
[ -f .env ] || cp .env.example .env
```

(이미 `.env`가 있으면 덮어쓰지 않습니다.)

```bash
nano .env
```

파일 안에서 `DATABASE_URL`로 시작하는 줄의 `여기에_비밀번호`를 4단계에서 정한 비밀번호로 바꿉니다.
다 바꾸면 그 줄이 **이런 모양**이어야 합니다 (명령어가 아니라 파일 안의 내용입니다):

```
DATABASE_URL=postgres://kanban:Abc123xyz789Qwe45@127.0.0.1:5432/kanban
```

저장은 `Ctrl+O` → `Enter`, 나가기는 `Ctrl+X`. 그다음 파일을 나만 읽도록 잠급니다.

```bash
chmod 600 .env
```

> `.env`의 다른 줄은 `#`으로 시작하는 설명이에요. 특별한 이유가 없으면 그대로 두세요.
> `.env`를 고친 뒤에는 앱을 **껐다 켜야**(`bash ~/deploy/stop.sh` → `bash ~/deploy/start.sh`) 반영됩니다. 다시 빌드할 필요는 없어요.

## 7단계. 설치하고 빌드하기 (kanban)

```bash
npm ci && npm run build
```

몇 분 걸립니다. 마지막에 `✓ Compiled successfully`와 표 모양의 목록이 나오면 성공입니다.

| 화면에 나오는 것 | 뜻 |
|---|---|
| `npm warn …`, `npm notice …` | 경고·안내일 뿐이에요. 무시하세요 |
| `found 0 vulnerabilities` 또는 `npm audit fix`를 하라는 안내 | **`npm audit fix`는 실행하지 마세요.** 부품 버전이 바뀌어 앱이 깨질 수 있어요 |
| `npm error …` | 실패예요. 마지막 몇 줄을 보고 [문제 해결](#문제-해결)을 확인하세요 |
| `Killed` | 메모리가 부족해요. 2단계의 "스왑 만들기"를 하고 다시 하세요 |

## 8단계. 켜기 (kanban)

```bash
bash ~/deploy/start.sh
```

앱을 tmux 창(이름: `kanban`) 안에서 켜고, 데이터베이스 연결까지 확인해서 알려 줍니다.

- `켜졌어요. 데이터베이스 연결도 정상이에요.` → 성공. 9단계로 가세요.
- `앱은 켜졌지만 문제가 있어요` → 무엇이 문제인지 한국어로 나옵니다 (대부분 `.env`의 비밀번호·이름). 고친 뒤 `bash ~/deploy/stop.sh` → `bash ~/deploy/start.sh`.
- 처음 켤 때 데이터베이스 표와 첫 보드가 자동으로 만들어집니다.

**매일 쓰는 명령** (모두 kanban 상태에서)

| 하고 싶은 것 | 명령 |
|---|---|
| 켜기 | `bash ~/deploy/start.sh` |
| 끄기 | `bash ~/deploy/stop.sh` |
| 앱 화면(기록) 보기 | `tmux attach -t kanban` |
| 앱 화면에서 빠져나오기 (앱은 계속 켜져 있음) | `Ctrl+B`를 눌렀다 뗀 뒤 **소문자 `d`** (한/영 키가 **영문** 상태여야 해요) |
| 켜져 있는지 확인 | `bash ~/deploy/start.sh` (켜져 있으면 "이미 켜져 있어요") |

**서버를 재부팅했거나 SSH로 새로 접속했을 때** — 처음에는 관리자 상태입니다. 아래 순서대로 하세요.

```bash
sudo -iu kanban
```

```bash
bash ~/deploy/start.sh
```

(서버를 재부팅하면 앱도 꺼지므로 다시 켜야 합니다. 재부팅이 아니라면 앱은 계속 켜져 있어요.)

## 9단계. 내 PC에서 접속하기 (SSH 터널)

**내 PC**의 터미널(Windows는 PowerShell)에서 실행합니다.
`내계정`과 `서버주소`는 평소 서버에 SSH로 접속할 때 쓰는 값입니다 (`kanban`이 아니에요). 평소 `-p 포트`나 `-i 키파일`을 붙인다면 똑같이 붙이세요.

```bash
ssh -o ExitOnForwardFailure=yes -o ServerAliveInterval=60 -L 3000:127.0.0.1:3000 내계정@서버주소
```

이 창을 **열어 둔 채로**, 내 PC 브라우저에서 아래 주소를 엽니다.

```
http://127.0.0.1:3000
```

> PuTTY를 쓴다면: Connection → SSH → Tunnels에서 Source port `3000`, Destination `127.0.0.1:3000`, **Add** 누른 뒤 접속.

| 상황 | 뜻과 해결 |
|---|---|
| ssh가 바로 끝나며 `cannot listen to port: 3000` / `Address already in use` | 내 PC의 3000번 포트를 다른 프로그램이 쓰는 중이에요. 아래 "다른 포트로 접속"을 하세요 (Windows에서 확인: `netstat -ano \| findstr :3000`) |
| 화면에 "허용되지 않은 주소(Host)입니다" | 브라우저 주소의 포트가 허용 목록에 없어요. 아래 "다른 포트로 접속"의 2번을 하세요 |
| 서버 IP로 `http://서버IP:3000`을 열었더니 "연결할 수 없음" | 정상이에요. 보안상 터널로만 열립니다. 터널을 열고 `http://127.0.0.1:3000` |
| "데이터를 불러오지 못했어요" | 앱이 켜져 있는지(`bash ~/deploy/start.sh`), 터널 창이 열려 있는지 확인 |

**다른 포트로 접속하기** (예: 내 PC 쪽 8080)

1. 내 PC: `ssh -o ExitOnForwardFailure=yes -L 8080:127.0.0.1:3000 내계정@서버주소`
2. 서버(kanban): `nano .env`에서 `# KANBAN_ALLOWED_PORTS=3000,8080` 줄 맨 앞의 `#`과 공백을 지워 `KANBAN_ALLOWED_PORTS=3000,8080`으로 저장 → `bash ~/deploy/stop.sh` → `bash ~/deploy/start.sh`
3. 브라우저: `http://127.0.0.1:8080`

## 업데이트하는 방법

GitHub에 새 버전이 올라오면 서버에서 아래를 **한 줄씩** 실행합니다 (kanban 상태).

```bash
bash ~/deploy/backup.sh
```

```bash
bash ~/deploy/stop.sh
```

```bash
bash ~/deploy/update.sh
```

```bash
bash ~/deploy/start.sh
```

`update.sh`가 하는 일: GitHub에서 최신 코드 받기 → **GitHub에서 지워진 옛 파일 정리** → 새 코드로 바꾸기 → `npm ci` → `npm run build`.
`.env`, `data/`(첨부), `backups/`(백업)는 건드리지 않습니다. 도중에 실패하면 원인을 고친 뒤 **같은 명령을 다시 실행**하면 이어서 마무리됩니다.
(빌드가 실패한 상태에서는 앱이 켜지지 않으니, 실패 메시지의 마지막 부분을 알려 주세요.)

> **이 안내서의 예전 판으로 설치해서 `~/deploy/update.sh`가 없다고 나오면** — 처음 한 번만 아래 두 줄로 업데이트 도구를 받은 뒤, 위 순서대로 하세요.
>
> ```bash
> git -C ~/.source fetch --depth 1 origin claude/kanban-board-stage1-2
> ```
>
> ```bash
> git -C ~/.source archive FETCH_HEAD kanban-board/deploy | tar -x --strip-components=1 -C ~
> ```

> **아주 예전 안내대로 `/home/kanban-board/work/kanban-board`에 설치했었다면** (kanban 상태, `cd /home/kanban-board` 후)
> 1. 예전 앱 끄기: `tmux attach -t kanban` → `Ctrl+C` → `exit`
> 2. 예전 설정 가져오기 (6단계 대신): `cp work/kanban-board/.env .env && chmod 600 .env`
> 3. 예전 첨부 옮기기 (있었다면): `mkdir -p data && mv work/kanban-board/data/uploads data/`
> 4. 예전 폴더 지우기: `rm -rf work`
>
> 예전 폴더를 남겨 두면 3000번 포트가 겹치거나, 엉뚱한 `.env`를 고치게 되거나, 빌드가 예전 파일 때문에 실패할 수 있어요.

## 백업과 복원

데이터는 두 군데(데이터베이스, 첨부 폴더)에 있어서 **둘을 같은 시각의 짝으로** 백업·복원해야 합니다. 스크립트가 이것을 맞춰 줍니다.

**백업** (kanban 상태, 앱이 켜져 있어도 됩니다)

```bash
bash ~/deploy/backup.sh
```

`/home/kanban-board/backups/`에 `db-날짜-시각.sql`과 `uploads-날짜-시각.tar.gz` 두 파일이 생깁니다. 예전 백업은 지우지 않으니, 가끔 오래된 것을 정리하세요.

**백업을 내 PC로 복사하기** (서버 디스크가 고장 나면 백업도 같이 사라지므로 꼭 하세요)

1. 서버, **관리자** 상태에서 (날짜-시각은 실제 이름으로):

   ```bash
   sudo cp /home/kanban-board/backups/db-날짜-시각.sql /home/kanban-board/backups/uploads-날짜-시각.tar.gz ~/ && sudo chown "$USER" ~/db-날짜-시각.sql ~/uploads-날짜-시각.tar.gz
   ```

2. 내 PC의 PowerShell에서:

   ```bash
   scp 내계정@서버주소:db-날짜-시각.sql .
   ```

   ```bash
   scp 내계정@서버주소:uploads-날짜-시각.tar.gz .
   ```

3. 4단계의 DB 비밀번호도 따로 안전한 곳에 적어 두세요. (`.env`와 백업 파일에는 개인 데이터가 있으니 남에게 보내지 마세요.)

**복원** (kanban 상태)

```bash
bash ~/deploy/stop.sh
```

```bash
bash ~/deploy/restore.sh
```

↑ 복원할 수 있는 백업 이름(날짜-시각) 목록이 나옵니다. 그중 하나를 골라:

```bash
bash ~/deploy/restore.sh 날짜-시각
```

`복원`이라고 입력하면 진행합니다. 스크립트가 알아서:
복원 직전 상태를 먼저 자동 백업 → 데이터베이스를 한 번에 복원(실패하면 하나도 안 바뀜) → 지금 첨부 폴더는 지우지 않고 `data/uploads-복원전-시각`으로 옮겨 둔 뒤 백업의 첨부를 풀어 놓습니다.

```bash
bash ~/deploy/start.sh
```

열려 있던 브라우저 화면은 새로고침하세요.

> **데이터베이스만 따로 되돌리지 마세요.** 앱은 켜질 때 "데이터베이스에 없는 첨부 파일"을 정리하기 때문에, 데이터베이스만 옛날로 돌리고 첨부 폴더를 그대로 두면 그 뒤에 올린 첨부가 지워집니다. 반드시 `restore.sh`로 짝을 함께 복원하세요.

> **새 서버로 옮길 때**: 새 서버에서 1~7단계를 마친 뒤, 두 백업 파일을 `/home/kanban-board/backups/`에 넣고 (관리자 상태에서 `sudo cp 파일 /home/kanban-board/backups/ && sudo chown -R kanban:kanban /home/kanban-board/backups`) kanban 상태에서 `bash ~/deploy/restore.sh 날짜-시각`.

## 문제 해결

| 증상 | 확인할 것 |
|---|---|
| `Permission denied`, `EACCES`, `dubious ownership`, `Build directory is not writeable`, 또는 스크립트가 "지금 사용자의 것이 아닌 파일이 있어요" | `sudo`를 붙여 실행한 적이 있으면 생겨요. 관리자 상태에서 `sudo chown -R kanban:kanban /home/kanban-board` 후 kanban 상태로 다시 |
| `tmux attach -t kanban`이 `no server running` / `can't find session` | 앱이 꺼져 있거나, 내가 지금 관리자 상태예요. `sudo -iu kanban` → `bash ~/deploy/start.sh` |
| `duplicate session: kanban` | 이미 tmux 창이 있어요. `tmux attach -t kanban`으로 들어가 보세요 |
| start.sh: "3000번 포트를 다른 프로그램이 쓰고 있어요" | 예전 방식으로 켠 앱이 남아 있을 수 있어요. [예전 설치 정리](#업데이트하는-방법)를 보세요. 확인: 관리자 상태에서 `sudo ss -tlnp \| grep :3000` |
| "DB 연결 설정이 없어요" | `.env`가 `/home/kanban-board/.env`에 있는지, `DATABASE_URL` 줄 맨 앞에 `#`이 없는지 |
| "사용자 이름이나 비밀번호가 틀렸어요" | `.env`의 비밀번호가 4단계와 같은지, 금지 글자(`$ # % @ : / ?`)가 있는지. 비밀번호를 새로 정하려면 관리자 상태에서 `sudo -u postgres psql` → `\password kanban` → `.env`도 같게 고친 뒤 껐다 켜기 |
| "데이터베이스 이름이 없어요" | `.env` 맨 끝의 이름(`…/kanban`)이 4단계에서 만든 이름과 같은지 |
| "DB 사용자에게 권한이 없어요" | 4단계에서 `CREATE DATABASE kanban OWNER kanban;`으로 만들었는지 |
| "PostgreSQL에 닿지 못했어요" / `connection refused` | 관리자 상태에서 `pg_lsclusters`로 `online`인지, `.env`의 포트가 맞는지. 앱은 DB가 잠시 꺼졌다 켜져도 **재시작 없이** 다시 연결됩니다 |
| "DB가 바쁘거나 응답이 없어요" | 잠시 뒤 다시 시도. 계속되면 관리자 상태에서 `sudo systemctl restart postgresql` |
| 여기에 없는 처음 보는 오류 | 화면의 문구와 `tmux attach -t kanban`의 마지막 부분을 알려 주세요 (비밀번호는 빼고) |
| `npm ci` 실패 | `node -v`가 v22.12 이상인지, 인터넷이 되는지. `gyp ERR`가 보이면 관리자 상태에서 `sudo apt install -y build-essential` 후 다시 |
| 빌드 중 `Killed` | 메모리 부족. 2단계 "스왑 만들기" |
| 접속이 안 됨 | 터널 창이 열려 있는지, `bash ~/deploy/start.sh`가 "이미 켜져 있어요"라고 하는지 |
| 실시간 연결이 끊김 ("다시 연결 중…") | 터널이 다시 열리면 자동으로 다시 연결됩니다. 그래도 안 되면 새로고침 |

## 보안 체크

- 앱 포트(3000)와 PostgreSQL 포트(5432)를 **방화벽에서 열지 마세요.** 둘 다 서버 안에서만 쓰입니다.
- 방화벽(`ufw`)은 필수가 아닙니다 (앱과 DB가 이미 서버 안에서만 열려 있음). 켜고 싶다면 **먼저** `sudo ss -tlnp | grep ssh`로 SSH 포트를 확인해 그 포트를 허용한 뒤 켜세요. 허용 없이 켜면 서버에 접속할 수 없게 됩니다. 이 서버에서 다른 서비스(웹사이트 등)를 운영 중이면 켜지 마세요.
- 이 서버에 SSH로 들어올 수 있는 사람은 앱도 쓸 수 있습니다. 서버 계정은 믿을 수 있는 사람에게만 주세요.
- `.env`와 백업 파일에는 비밀번호와 개인 데이터가 있으니 남에게 보내지 마세요.
