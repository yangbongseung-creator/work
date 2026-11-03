#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 칸반 보드 복원
#   backup.sh로 만든 같은 시각의 짝(데이터베이스 + 첨부 파일)을 함께 되살린다.
#   - 앱이 꺼져 있어야 한다 (bash ~/deploy/stop.sh)
#   - 복원 직전 상태를 먼저 자동으로 백업해 둔다 (잘못 복원해도 되돌릴 수 있게)
#   - 데이터베이스는 한 번에(전부 되거나, 실패하면 하나도 안 바뀌게) 복원한다
#   - 지금 첨부 폴더는 지우지 않고 data/uploads-복원전-시각 으로 옮겨 둔다
#
# 사용법 (kanban 사용자로):   bash ~/deploy/restore.sh            ← 백업 목록 보기
#                             bash ~/deploy/restore.sh 날짜-시각  ← 그 백업으로 복원
# ─────────────────────────────────────────────────────────────────────────────
if [ -z "${BASH_VERSION:-}" ]; then
  echo "bash로 실행해 주세요:  bash ~/deploy/restore.sh"
  exit 1
fi

main() {
  set -euo pipefail
  local DIR APP STAMP DBF UPF ENVS ANSWER NOW f
  DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APP="$(dirname "$DIR")"

  if [ "$(id -u)" = "0" ]; then
    echo "중단: root로 실행하면 안 돼요. 먼저  sudo -iu kanban  으로 앱 사용자로 바꾼 뒤 다시 실행하세요."
    exit 1
  fi
  if [ "$#" -eq 0 ]; then
    echo "사용법:  bash ~/deploy/restore.sh 날짜-시각"
    echo ""
    echo "복원할 수 있는 백업 (데이터베이스와 첨부가 모두 있는 것):"
    local found=0
    for f in "$APP"/backups/db-*.sql; do
      [ -e "$f" ] || continue
      STAMP="$(basename "$f" .sql)"
      STAMP="${STAMP#db-}"
      if [ -f "$APP/backups/uploads-$STAMP.tar.gz" ]; then
        echo "  $STAMP"
        found=1
      fi
    done
    [ "$found" = 1 ] || echo "  (없음)  먼저  bash ~/deploy/backup.sh  로 백업을 만들어 주세요."
    exit 1
  fi
  STAMP="$1"
  DBF="$APP/backups/db-$STAMP.sql"
  UPF="$APP/backups/uploads-$STAMP.tar.gz"
  if [ ! -f "$DBF" ] || [ ! -f "$UPF" ]; then
    echo "중단: $STAMP 백업의 두 파일이 모두 있어야 해요."
    echo "      $DBF"
    echo "      $UPF"
    echo "      목록 보기:  bash ~/deploy/restore.sh"
    exit 1
  fi
  if ! grep -q 'PostgreSQL database dump complete' "$DBF"; then
    echo "중단: 데이터베이스 백업 파일이 완전하지 않아요: $DBF"
    exit 1
  fi
  if ! tar tzf "$UPF" >/dev/null 2>&1; then
    echo "중단: 첨부 백업 파일이 손상됐어요: $UPF"
    exit 1
  fi
  if pgrep -u "$(id -u)" -f 'next-server' >/dev/null 2>&1; then
    echo "중단: 앱이 켜져 있어요. 먼저  bash ~/deploy/stop.sh  로 앱을 꺼 주세요."
    exit 1
  fi
  if ! command -v psql >/dev/null 2>&1; then
    echo "중단: psql 프로그램이 없어요. 관리자 계정에서  sudo apt install -y postgresql-client  를 실행해 주세요."
    exit 1
  fi

  echo "지금 데이터가 $STAMP 백업 때의 상태로 바뀝니다. 그 뒤에 만든 카드와 첨부는 사라져요."
  echo "(안전을 위해 지금 상태를 먼저 자동으로 백업해 둡니다.)"
  read -r -p "계속하려면  복원  이라고 입력하세요: " ANSWER || true
  if [ "$ANSWER" != "복원" ]; then
    echo "취소했어요. 아무것도 바뀌지 않았어요."
    exit 1
  fi

  echo ""
  echo "[복원 전 자동 백업]"
  bash "$DIR/backup.sh"
  echo ""

  if ! ENVS="$(node "$DIR/pgenv.cjs")"; then
    echo "중단: .env의 데이터베이스 설정을 읽지 못했어요."
    exit 1
  fi
  eval "$ENVS"

  echo "1/2 데이터베이스를 복원하는 중…"
  # 한 번에 처리: 중간에 오류가 나면 아무것도 바뀌지 않는다
  # (빈 데이터베이스에 복원할 때 나오는 "없어서 건너뜀" 같은 안내 문구는 숨기고, 경고와 오류만 보여 준다)
  if ! PGOPTIONS='-c client_min_messages=warning' psql -X -q -v ON_ERROR_STOP=1 --single-transaction -f "$DBF" >/dev/null; then
    echo "중단: 데이터베이스 복원에 실패했어요. 데이터베이스는 바뀌지 않았어요. 위의 오류 메시지를 확인해 주세요."
    exit 1
  fi

  echo "2/2 첨부 파일을 복원하는 중…"
  NOW="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$APP/data"
  if [ -d "$APP/data/uploads" ]; then
    mv "$APP/data/uploads" "$APP/data/uploads-복원전-$NOW"
  fi
  tar xzf "$UPF" -C "$APP"
  mkdir -p "$APP/data/uploads"

  echo ""
  echo "복원 완료: $STAMP 백업 상태로 되돌렸어요."
  if [ -d "$APP/data/uploads-복원전-$NOW" ]; then
    echo "복원 전 첨부 폴더는  data/uploads-복원전-$NOW  에 남겨 두었어요. 확인 뒤 필요 없으면 지워도 돼요."
  fi
  echo "이제  bash ~/deploy/start.sh  로 앱을 켜 주세요. 열려 있던 브라우저 화면은 새로고침해 주세요."
}
main "$@"; exit $?
