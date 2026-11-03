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
if [ -z "${BASH_VERSION:-}" ]; then
  echo "bash로 실행해 주세요:  bash ~/deploy/backup.sh"
  exit 1
fi

main() {
  set -euo pipefail
  local DIR APP STAMP DBF UPF ENVS
  DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APP="$(dirname "$DIR")"

  if [ "$(id -u)" = "0" ]; then
    echo "중단: root로 실행하면 안 돼요. 먼저  sudo -iu kanban  으로 앱 사용자로 바꾼 뒤 다시 실행하세요."
    exit 1
  fi
  if ! command -v pg_dump >/dev/null 2>&1; then
    echo "중단: pg_dump 프로그램이 없어요. 관리자 계정에서  sudo apt install -y postgresql-client  를 실행해 주세요."
    exit 1
  fi
  if ! ENVS="$(node "$DIR/pgenv.cjs")"; then
    echo "중단: .env의 데이터베이스 설정을 읽지 못했어요."
    exit 1
  fi
  eval "$ENVS"

  mkdir -p "$APP/backups"
  chmod 700 "$APP/backups"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  DBF="$APP/backups/db-$STAMP.sql"
  UPF="$APP/backups/uploads-$STAMP.tar.gz"
  umask 077

  echo "1/2 데이터베이스를 백업하는 중…"
  # --clean --if-exists: 복원할 때 지금 표를 지우고 백업 내용으로 다시 만들게 한다 (겹쳐 쓰기·중복 방지)
  if ! pg_dump --clean --if-exists --no-owner --no-privileges -f "$DBF"; then
    rm -f "$DBF"
    echo "중단: 데이터베이스 백업에 실패했어요. 위의 오류 메시지를 확인해 주세요. (PostgreSQL이 켜져 있는지, .env가 맞는지)"
    exit 1
  fi
  if ! grep -q 'PostgreSQL database dump complete' "$DBF"; then
    echo "중단: 데이터베이스 백업 파일이 완전하지 않아요: $DBF"
    exit 1
  fi

  echo "2/2 첨부 파일을 백업하는 중…"
  if [ -d "$APP/data/uploads" ]; then
    tar czf "$UPF" -C "$APP" data/uploads
  else
    tar czf "$UPF" -T /dev/null # 아직 첨부가 없어도 짝을 맞추기 위해 빈 묶음을 만든다
  fi

  echo ""
  echo "백업 완료 (이름: $STAMP)"
  ls -lh "$DBF" "$UPF" | awk '{print "  " $5 "\t" $9}'
  echo ""
  echo "이 두 파일을 서버 밖(내 PC 등)에도 꼭 복사해 두세요. 방법은 설치 안내서 '백업' 부분에 있어요."
  echo "복원하려면:  bash ~/deploy/restore.sh $STAMP"
}
main "$@"; exit $?
