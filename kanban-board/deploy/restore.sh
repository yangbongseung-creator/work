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
#
# 하는 일 (순서)
#   1) root가 아닌지 확인. 날짜-시각을 주지 않으면 복원할 수 있는 백업 목록만 보여 주고 끝냄
#   2) 그 날짜-시각의 두 파일(db-….sql, uploads-….tar.gz)이 모두 있고 온전한지 확인
#   3) 앱이 꺼져 있는지, psql 프로그램이 있는지 확인
#   4) "복원"이라고 입력해야 진행 (실수로 실행하는 것을 막기 위해)
#   5) 지금 상태를 먼저 자동 백업 (잘못 복원해도 되돌릴 수 있게)
#   6) 데이터베이스 복원: 백업 파일을 한 트랜잭션으로 실행 → 전부 되거나, 실패하면 하나도 안 바뀜
#   7) 첨부 복원: 지금 첨부 폴더는 data/uploads-복원전-시각 으로 옮겨 두고, 백업의 첨부를 풀어 놓음
#
# 데이터베이스와 첨부를 꼭 "같은 시각의 짝"으로 복원해야 하는 이유:
#   앱은 켜질 때 데이터베이스에 없는 첨부 파일을 정리한다. 데이터베이스만 옛날로 돌리면
#   그 뒤에 올린 첨부 파일이 "주인 없는 파일"로 보여 지워질 수 있다.
#
# sh(dash)로 실행하면 아래의 bash 문법이 깨지므로 가장 먼저 막는다
if [ -z "${BASH_VERSION:-}" ]; then
  echo "bash로 실행해 주세요:  bash ~/deploy/restore.sh"
  exit 1
fi

# 모든 내용을 main 함수 안에 두고 맨 마지막 줄에서 실행한 뒤 바로 끝낸다.
# (bash는 스크립트를 읽어 가면서 실행하므로, 실행 도중 이 파일이 새 버전으로 바뀌어도 엉뚱한 줄을 실행하지 않게)
main() {
  set -euo pipefail
  local DIR APP STAMP DBF UPF ENVS ANSWER NOW f
  # 이 스크립트가 있는 deploy 폴더의 한 칸 위 = 앱 폴더. 어느 폴더에서 실행해도 앱 폴더를 정확히 찾는다
  DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APP="$(dirname "$DIR")"

  # ── 1) 안전 확인 ─────────────────────────────────────────────────
  if [ "$(id -u)" = "0" ]; then
    echo "중단: root로 실행하면 안 돼요. 먼저  sudo -iu kanban  으로 앱 사용자로 바꾼 뒤 다시 실행하세요."
    exit 1
  fi
  # 날짜-시각을 주지 않았으면: db-….sql 과 uploads-….tar.gz 가 둘 다 있는 백업만 골라 목록으로 보여 준다
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
  # ── 2) 고른 백업 파일 확인 ───────────────────────────────────────
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
  # pg_dump 가 끝까지 쓴 파일이면 끝에 이 문장이 있다 (중간에 끊긴 백업으로 복원하지 않게)
  if ! grep -q 'PostgreSQL database dump complete' "$DBF"; then
    echo "중단: 데이터베이스 백업 파일이 완전하지 않아요: $DBF"
    exit 1
  fi
  # 첨부 묶음 파일을 끝까지 읽을 수 있는지 (손상 확인)
  if ! tar tzf "$UPF" >/dev/null 2>&1; then
    echo "중단: 첨부 백업 파일이 손상됐어요: $UPF"
    exit 1
  fi
  # ── 3) 앱이 꺼져 있어야 한다 ─────────────────────────────────────
  # 켜진 채로 데이터를 바꾸면 화면과 데이터가 어긋나고, 앱이 복원 중인 첨부를 정리할 수도 있다
  if pgrep -u "$(id -u)" -f 'next-server' >/dev/null 2>&1; then
    echo "중단: 앱이 켜져 있어요. 먼저  bash ~/deploy/stop.sh  로 앱을 꺼 주세요."
    exit 1
  fi
  if ! command -v psql >/dev/null 2>&1; then
    echo "중단: psql 프로그램이 없어요. 관리자 계정에서  sudo apt install -y postgresql-client  를 실행해 주세요."
    exit 1
  fi

  # ── 4) 정말 복원할지 묻기 ────────────────────────────────────────
  echo "지금 데이터가 $STAMP 백업 때의 상태로 바뀝니다. 그 뒤에 만든 카드와 첨부는 사라져요."
  echo "(안전을 위해 지금 상태를 먼저 자동으로 백업해 둡니다.)"
  read -r -p "계속하려면  복원  이라고 입력하세요: " ANSWER || true
  if [ "$ANSWER" != "복원" ]; then
    echo "취소했어요. 아무것도 바뀌지 않았어요."
    exit 1
  fi

  echo ""
  # ── 5) 지금 상태를 먼저 백업 ─────────────────────────────────────
  # backup.sh 가 실패하면 (set -e 때문에) 복원하지 않고 여기서 멈춘다
  echo "[복원 전 자동 백업]"
  bash "$DIR/backup.sh"
  echo ""

  # ── 6) 데이터베이스 복원 ─────────────────────────────────────────
  # .env 의 설정을 읽어 psql 이 쓸 환경 변수로 만든다 (backup.sh 와 같은 방법)
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

  # ── 7) 첨부 복원 ─────────────────────────────────────────────────
  # 지금 첨부 폴더는 지우지 않고 이름을 바꿔 옮겨 둔 뒤, 백업 묶음을 앱 폴더에 풀면 data/uploads 가 생긴다
  echo "2/2 첨부 파일을 복원하는 중…"
  NOW="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$APP/data"
  if [ -d "$APP/data/uploads" ]; then
    mv "$APP/data/uploads" "$APP/data/uploads-복원전-$NOW"
  fi
  tar xzf "$UPF" -C "$APP"
  # 백업 때 첨부가 하나도 없었어도 폴더는 있어야 한다
  mkdir -p "$APP/data/uploads"

  echo ""
  echo "복원 완료: $STAMP 백업 상태로 되돌렸어요."
  if [ -d "$APP/data/uploads-복원전-$NOW" ]; then
    echo "복원 전 첨부 폴더는  data/uploads-복원전-$NOW  에 남겨 두었어요. 확인 뒤 필요 없으면 지워도 돼요."
  fi
  echo "이제  bash ~/deploy/start.sh  로 앱을 켜 주세요. 열려 있던 브라우저 화면은 새로고침해 주세요."
}
main "$@"; exit $?
