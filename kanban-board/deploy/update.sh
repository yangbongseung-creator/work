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
#
# 하는 일 (순서)
#   1) 안전 확인: root가 아닌지, 원본 코드 폴더(.source)와 앱 폴더가 있는지,
#      앱 폴더에 다른 계정(root 등)의 파일이 섞여 있지 않은지, 앱이 꺼져 있는지
#   2) GitHub에서 같은 가지(branch)의 최신 코드를 받음 (받은 코드에 앱이 없으면 아무것도 바꾸지 않고 멈춤)
#   3) 예전 버전과 새 버전을 비교해, GitHub에서 지워진 파일을 앱 폴더에서도 지움
#      (.env, data, backups, node_modules, .source, .next 같은 보호 대상은 절대 지우지 않음)
#   4) 원본 코드 폴더를 새 버전으로 바꾸고, 그중 앱 부분(kanban-board 폴더)을 앱 폴더에 풀어 놓음
#   5) npm ci        : package-lock.json 에 적힌 버전 그대로 부품을 새로 설치
#   6) npm run build : 앱을 실행할 수 있는 형태로 빌드
#
# 중간에 실패하면? 원인을 고친 뒤 같은 명령을 다시 실행하면 이어서 마무리된다.
#
# sh(dash)로 실행하면 아래의 bash 문법이 깨지므로 가장 먼저 막는다
if [ -z "${BASH_VERSION:-}" ]; then
  echo "bash로 실행해 주세요:  bash ~/deploy/update.sh"
  exit 1
fi

# 모든 내용을 main 함수 안에 두고 맨 마지막 줄에서 실행한 뒤 바로 끝낸다.
# (bash는 스크립트를 읽어 가면서 실행하므로, 실행 도중 이 파일이 새 버전으로 바뀌어도 엉뚱한 줄을 실행하지 않게)
main() {
  set -euo pipefail
  local DIR APP SRC BRANCH OLD NEW BAD ME
  # 이 스크립트가 있는 deploy 폴더의 한 칸 위 = 앱 폴더. 어느 폴더에서 실행해도 앱 폴더를 정확히 찾는다
  # SRC = GitHub에서 받은 원본 코드(git 저장소). 앱 폴더 안의 숨김 폴더 .source
  DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APP="$(dirname "$DIR")"
  SRC="$APP/.source"
  ME="$(id -un)"

  # ── 1) 안전 확인 ─────────────────────────────────────────────────
  # root로 하면 새로 생기는 파일의 주인이 root가 되어 나중에 kanban 계정이 고치지 못하므로 막는다
  if [ "$(id -u)" = "0" ]; then
    echo "중단: root로 실행하면 안 돼요. 먼저  sudo -iu kanban  으로 앱 사용자로 바꾼 뒤 다시 실행하세요."
    exit 1
  fi
  # 원본 코드 폴더는 설치 안내서 5단계의 git clone 으로 만든다
  if [ ! -d "$SRC/.git" ]; then
    echo "중단: 원본 코드 폴더($SRC)가 없어요. 설치 안내서 5단계를 먼저 해 주세요."
    exit 1
  fi
  if [ ! -f "$APP/package.json" ]; then
    echo "중단: 앱 폴더($APP)에 package.json이 없어요. 설치 안내서 5단계를 먼저 해 주세요."
    exit 1
  fi
  # 앱 폴더(두 단계 깊이까지)에 다른 계정의 파일이 있으면 나중에 지우거나 덮어쓰지 못해
  # 중간에 실패하므로 미리 찾아서 알려 준다
  BAD="$(find "$APP" -maxdepth 2 ! -user "$(id -u)" -print -quit 2>/dev/null || true)"
  if [ -n "$BAD" ]; then
    echo "중단: 앱 폴더 안에 지금 사용자($ME)의 것이 아닌 파일이 있어요: $BAD"
    echo "      (root로 명령을 실행했을 때 생겨요.) 관리자 계정에서 아래를 실행한 뒤 다시 해 주세요."
    echo "      sudo chown -R $ME:$(id -gn) $APP"
    exit 1
  fi
  # 앱이 켜진 채로 부품(node_modules)과 빌드(.next)를 바꾸면 켜져 있던 앱이 망가지므로 꺼야 한다
  if pgrep -u "$(id -u)" -f 'next-server' >/dev/null 2>&1; then
    echo "중단: 앱이 켜져 있어요. 먼저  bash ~/deploy/stop.sh  로 앱을 끈 뒤 다시 실행하세요."
    exit 1
  fi

  # ── 2) GitHub에서 최신 코드 받기 ─────────────────────────────────
  # 지금 받아 둔 가지(branch) 이름과 지금 버전(OLD)을 기억해 둔다
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
  # NEW = 방금 받은 최신 버전. 그 안에 앱(kanban-board/package.json)이 없으면
  # 잘못 받은 것이므로 아무것도 바꾸지 않고 멈춘다 (앱 파일을 모두 지우는 사고를 막기 위해)
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

  # ── 3) GitHub에서 지워진 파일 정리 ───────────────────────────────
  # 예전 버전(OLD)과 새 버전(NEW)을 비교해 '지워진(D)' 파일 목록을 얻고, 앱 폴더에서도 지운다.
  # 이상한 경로('..' 등)와 보호 대상(.env, data, backups, node_modules, .source, .next)은 건너뛴다.
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

  # ── 4) 새 코드로 바꾸기 ──────────────────────────────────────────
  # 원본 코드 폴더를 새 버전으로 맞춘 뒤, 그중 kanban-board 폴더 내용만 앱 폴더에 풀어 놓는다
  # (--strip-components=1 : 앞의 kanban-board/ 한 단계를 떼고 앱 폴더 바로 아래에 풀기)
  echo "3/5 새 코드로 바꾸는 중…"
  git -C "$SRC" reset -q --hard "$NEW"
  git -C "$SRC" archive HEAD kanban-board | tar -x --strip-components=1 -C "$APP"

  # ── 5) 부품 설치 ─────────────────────────────────────────────────
  # npm ci 는 node_modules 를 지우고 package-lock.json 에 적힌 버전 그대로 다시 설치한다
  echo "4/5 부품을 설치하는 중… (npm ci)"
  cd "$APP"
  npm ci

  # ── 6) 빌드 ──────────────────────────────────────────────────────
  # 실행할 수 있는 형태(.next 폴더)로 만든다. 서버 메모리가 부족하면 여기서 Killed 가 날 수 있다
  echo "5/5 빌드하는 중… (npm run build)"
  npm run build

  # 끝까지 왔으니 '중간에 멈췄어요' 안내를 끈다
  trap - ERR
  echo ""
  echo "업데이트 완료: 지금 버전 $(git -C "$SRC" rev-parse --short HEAD)"
  echo "이제  bash ~/deploy/start.sh  로 앱을 다시 켜 주세요."
}
main "$@"; exit $?
