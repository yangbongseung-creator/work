#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 칸반 보드 업데이트 스크립트
#   GitHub의 최신 코드를 받아 앱 폴더(/home/kanban-board)를 바꾸고, 부품 설치와 빌드까지 한다.
#   GitHub에서 지워진 파일은 앱 폴더에서도 지운다 (옛 파일이 남아 빌드가 깨지는 일을 막기 위해).
#   .env, data(첨부), backups(백업), node_modules 처럼 GitHub에 없는 내 파일은 절대 건드리지 않는다.
#
# 사용법 (kanban 사용자로, 앱을 먼저 끈 뒤):
#   bash ~/deploy/update.sh
#
# 이 파일은 실행 도중 새 버전으로 바뀔 수 있으므로, 모든 내용을 main 함수 안에 두고
# 마지막 한 줄에서 실행한 뒤 바로 끝낸다 (bash가 바뀐 파일의 나머지를 읽지 않게).
# ─────────────────────────────────────────────────────────────────────────────
if [ -z "${BASH_VERSION:-}" ]; then
  echo "bash로 실행해 주세요:  bash ~/deploy/update.sh"
  exit 1
fi

main() {
  set -euo pipefail
  local DIR APP SRC BRANCH OLD NEW BAD ME
  DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APP="$(dirname "$DIR")"
  SRC="$APP/.source"
  ME="$(id -un)"

  if [ "$(id -u)" = "0" ]; then
    echo "중단: root로 실행하면 안 돼요. 먼저  sudo -iu kanban  으로 앱 사용자로 바꾼 뒤 다시 실행하세요."
    exit 1
  fi
  if [ ! -d "$SRC/.git" ]; then
    echo "중단: 원본 코드 폴더($SRC)가 없어요. 설치 안내서 5단계를 먼저 해 주세요."
    exit 1
  fi
  if [ ! -f "$APP/package.json" ]; then
    echo "중단: 앱 폴더($APP)에 package.json이 없어요. 설치 안내서 5단계를 먼저 해 주세요."
    exit 1
  fi
  BAD="$(find "$APP" -maxdepth 2 ! -user "$(id -u)" -print -quit 2>/dev/null || true)"
  if [ -n "$BAD" ]; then
    echo "중단: 앱 폴더 안에 지금 사용자($ME)의 것이 아닌 파일이 있어요: $BAD"
    echo "      (root로 명령을 실행했을 때 생겨요.) 관리자 계정에서 아래를 실행한 뒤 다시 해 주세요."
    echo "      sudo chown -R $ME:$(id -gn) $APP"
    exit 1
  fi
  if pgrep -u "$(id -u)" -f 'next-server' >/dev/null 2>&1; then
    echo "중단: 앱이 켜져 있어요. tmux 안에서 Ctrl+C 로 앱을 끈 뒤 다시 실행하세요."
    exit 1
  fi

  BRANCH="$(git -C "$SRC" rev-parse --abbrev-ref HEAD)"
  if [ "$BRANCH" = "HEAD" ]; then
    echo "중단: 원본 코드 폴더($SRC)가 가지(branch)에 연결되어 있지 않아요. 아무것도 바꾸지 않았어요."
    exit 1
  fi
  OLD="$(git -C "$SRC" rev-parse HEAD)"

  echo "1/5 GitHub에서 최신 코드를 받는 중… (가지: $BRANCH)"
  if ! git -C "$SRC" fetch --depth 1 origin "$BRANCH"; then
    echo "중단: GitHub에서 코드를 받지 못했어요. 인터넷 연결과, GitHub에 가지($BRANCH)가 아직 있는지 확인해 주세요."
    echo "      앱 폴더는 아무것도 바뀌지 않았어요."
    exit 1
  fi
  NEW="$(git -C "$SRC" rev-parse FETCH_HEAD)"
  if ! git -C "$SRC" cat-file -e "$NEW:kanban-board/package.json" 2>/dev/null; then
    echo "중단: 받은 코드에 앱(kanban-board 폴더)이 없어요. 앱 폴더는 아무것도 바뀌지 않았어요."
    exit 1
  fi
  if [ "$OLD" = "$NEW" ]; then
    echo "    이미 최신 버전이에요 ($(git -C "$SRC" rev-parse --short "$NEW")). 부품 설치와 빌드만 다시 해요."
  fi

  # 여기부터는 중간에 실패해도 같은 명령을 다시 실행하면 이어서 마무리된다.
  trap 'echo ""; echo "업데이트가 중간에 멈췄어요. 위쪽의 오류 메시지를 확인해 주세요."; echo "원인을 해결한 뒤 같은 명령(bash ~/deploy/update.sh)을 다시 실행하면 이어서 마무리돼요."' ERR

  echo "2/5 GitHub에서 지워진 파일을 정리하는 중…"
  git -C "$SRC" diff --no-renames --name-only --diff-filter=D "$OLD" "$NEW" -- kanban-board \
    | sed -n 's#^kanban-board/##p' \
    | while IFS= read -r f; do
        case "$f" in
          '' | /* | *..* | .env | .env.* | data | data/* | backups | backups/* | node_modules | node_modules/* | .source | .source/* | .next | .next/*)
            echo "    건너뜀(보호): $f"; continue ;;
        esac
        if [ -e "$APP/$f" ] || [ -L "$APP/$f" ]; then rm -f -- "$APP/$f" && echo "    지움: $f"; fi
      done

  echo "3/5 새 코드로 바꾸는 중…"
  git -C "$SRC" reset -q --hard "$NEW"
  git -C "$SRC" archive HEAD kanban-board | tar -x --strip-components=1 -C "$APP"

  echo "4/5 부품을 설치하는 중… (npm ci)"
  cd "$APP"
  npm ci

  echo "5/5 빌드하는 중… (npm run build)"
  npm run build

  trap - ERR
  echo ""
  echo "업데이트 완료: 지금 버전 $(git -C "$SRC" rev-parse --short HEAD)"
  echo "tmux 안에서  npm start  로 앱을 다시 켜 주세요."
}
main "$@"; exit $?
