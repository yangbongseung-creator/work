#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 칸반 보드 백업
#   데이터베이스와 첨부 파일을 "같은 시각"의 짝으로 backups 폴더에 저장한다.
#     backups/db-날짜-시각.sql          (데이터베이스)
#     backups/uploads-날짜-시각.tar.gz  (첨부 파일)
#   앱이 켜져 있어도 백업할 수 있다. 예전 백업은 지우지 않는다.
#
# 사용법 (kanban 사용자로):   bash ~/deploy/backup.sh
# 복원:                       bash ~/deploy/restore.sh 날짜-시각
# ─────────────────────────────────────────────────────────────────────────────
#
# 하는 일 (순서)
#   1) root가 아닌지, pg_dump 프로그램이 있는지 확인
#   2) .env 의 DATABASE_URL 을 앱과 같은 방법으로 읽어, 비밀번호가 화면·명령줄에 드러나지 않게
#      PostgreSQL 프로그램용 환경 변수(PGHOST, PGUSER, PGPASSWORD …)로 넘긴다 (pgenv.cjs)
#   3) pg_dump 로 데이터베이스 전체를 backups/db-날짜-시각.sql 에 저장하고, 끝까지 저장됐는지 확인
#   4) 첨부 폴더(data/uploads)를 backups/uploads-날짜-시각.tar.gz 로 묶음
#   5) 두 파일의 크기를 보여 주고, 서버 밖으로도 복사하라고 안내
#
# 백업 파일은 나(kanban)만 읽을 수 있게 만든다 (폴더 700, 파일 600). 백업에는 개인 데이터가 들어 있다.
#
# sh(dash)로 실행하면 아래의 bash 문법이 깨지므로 가장 먼저 막는다
if [ -z "${BASH_VERSION:-}" ]; then
  echo "bash로 실행해 주세요:  bash ~/deploy/backup.sh"
  exit 1
fi

# 모든 내용을 main 함수 안에 두고 맨 마지막 줄에서 실행한 뒤 바로 끝낸다.
# (bash는 스크립트를 읽어 가면서 실행하므로, 실행 도중 이 파일이 새 버전으로 바뀌어도 엉뚱한 줄을 실행하지 않게)
main() {
  set -euo pipefail
  local DIR APP STAMP DBF UPF ENVS
  # 이 스크립트가 있는 deploy 폴더의 한 칸 위 = 앱 폴더. 어느 폴더에서 실행해도 앱 폴더를 정확히 찾는다
  DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APP="$(dirname "$DIR")"

  # ── 1) 안전 확인 ─────────────────────────────────────────────────
  if [ "$(id -u)" = "0" ]; then
    echo "중단: root로 실행하면 안 돼요. 먼저  sudo -iu kanban  으로 앱 사용자로 바꾼 뒤 다시 실행하세요."
    exit 1
  fi
  if ! command -v pg_dump >/dev/null 2>&1; then
    echo "중단: pg_dump 프로그램이 없어요. 관리자 계정에서  sudo apt install -y postgresql-client  를 실행해 주세요."
    exit 1
  fi
  # ── 2) .env 의 데이터베이스 설정 읽기 ────────────────────────────
  # pgenv.cjs 가 'export PGHOST=…' 같은 줄을 만들어 주고, eval 이 그 줄을 실행해 환경 변수로 만든다
  if ! ENVS="$(node "$DIR/pgenv.cjs")"; then
    echo "중단: .env의 데이터베이스 설정을 읽지 못했어요."
    exit 1
  fi
  eval "$ENVS"

  # 백업 폴더는 나만 들어갈 수 있게(700) 만들고, 두 파일 이름에 같은 날짜-시각(STAMP)을 붙여 짝을 맞춘다.
  # umask 077 : 이 뒤로 새로 만드는 파일은 나만 읽고 쓸 수 있다
  mkdir -p "$APP/backups"
  chmod 700 "$APP/backups"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  DBF="$APP/backups/db-$STAMP.sql"
  UPF="$APP/backups/uploads-$STAMP.tar.gz"
  umask 077

  # ── 3) 데이터베이스 백업 ─────────────────────────────────────────
  # --no-owner --no-privileges : 다른 계정 이름으로 복원해도 되도록 주인·권한 정보는 빼고 저장한다
  echo "1/2 데이터베이스를 백업하는 중…"
  # --clean --if-exists: 복원할 때 지금 표를 지우고 백업 내용으로 다시 만들게 한다 (겹쳐 쓰기·중복 방지)
  if ! pg_dump --clean --if-exists --no-owner --no-privileges -f "$DBF"; then
    rm -f "$DBF"
    echo "중단: 데이터베이스 백업에 실패했어요. 위의 오류 메시지를 확인해 주세요. (PostgreSQL이 켜져 있는지, .env가 맞는지)"
    exit 1
  fi
  # pg_dump 가 끝까지 썼으면 파일 끝에 이 문장이 있다. 없으면 중간에 끊긴 파일이다
  if ! grep -q 'PostgreSQL database dump complete' "$DBF"; then
    echo "중단: 데이터베이스 백업 파일이 완전하지 않아요: $DBF"
    exit 1
  fi

  # ── 4) 첨부 파일 백업 ────────────────────────────────────────────
  # data/uploads 폴더를 통째로 묶는다 (복원할 때 같은 자리에 그대로 풀린다)
  echo "2/2 첨부 파일을 백업하는 중…"
  if [ -d "$APP/data/uploads" ]; then
    tar czf "$UPF" -C "$APP" data/uploads
  else
    tar czf "$UPF" -T /dev/null # 아직 첨부가 없어도 짝을 맞추기 위해 빈 묶음을 만든다
  fi

  echo ""
  # ── 5) 결과 알리기 ───────────────────────────────────────────────
  echo "백업 완료 (이름: $STAMP)"
  ls -lh "$DBF" "$UPF" | awk '{print "  " $5 "\t" $9}'
  echo ""
  echo "이 두 파일을 서버 밖(내 PC 등)에도 꼭 복사해 두세요. 방법은 설치 안내서 '백업' 부분에 있어요."
  echo "복원하려면:  bash ~/deploy/restore.sh $STAMP"
}
main "$@"; exit $?
