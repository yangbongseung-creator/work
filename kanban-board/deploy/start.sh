#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 칸반 보드 켜기
#   앱을 tmux 창(이름: kanban) 안에서 켜 두어 SSH 접속을 끊어도 계속 돌게 하고,
#   켜진 뒤 데이터베이스 연결까지 확인해서 결과를 알려 준다.
#
# 사용법 (kanban 사용자로):   bash ~/deploy/start.sh
# 앱 화면 보기:               tmux attach -t kanban   (빠져나오기: Ctrl+B 를 눌렀다 떼고 d)
# 끄기:                       bash ~/deploy/stop.sh
# ─────────────────────────────────────────────────────────────────────────────
#
# 하는 일 (순서)
#   1) 안전 확인: root가 아닌지, 필요한 프로그램(tmux·curl·node·npm·pgrep)이 있는지,
#      설정 파일(.env)과 빌드 결과(.next)가 있는지, 이미 켜져 있지 않은지, 3000번 포트가 비어 있는지
#   2) 예전 tmux 창(kanban)이 남아 있으면 정리하고, 새 tmux 창 안에서 npm start
#   3) 최대 60초 동안 1초마다 앱에 /api/state 를 물어보며 대답을 기다림
#      (/api/state 는 데이터베이스를 읽어야 대답할 수 있어서, DB 연결까지 함께 확인된다)
#   4) 대답에 따라 결과를 한국어로 알려 줌
#
# 화면에 나오는 결과
#   "켜졌어요. 데이터베이스 연결도 정상이에요."  → 정상
#   "앱은 켜졌지만 문제가 있어요 (응답 …)"     → 앱은 돌지만 DB 설정 등에 문제. 이유가 함께 나옴
#   "앱이 켜지지 않았어요"                      → 앱이 켜지다 멈춤. 앱 화면의 마지막 줄들을 보여 줌
#   "이미 켜져 있어요"                          → 아무것도 하지 않고 끝냄
#
# sh(dash)로 실행하면 아래의 bash 문법이 깨지므로 가장 먼저 막는다
if [ -z "${BASH_VERSION:-}" ]; then
  echo "bash로 실행해 주세요:  bash ~/deploy/start.sh"
  exit 1
fi

# 모든 내용을 main 함수 안에 두고 맨 마지막 줄에서 실행한 뒤 바로 끝낸다.
# (bash는 스크립트를 읽어 가면서 실행하므로, 실행 도중 이 파일이 새 버전으로 바뀌어도 엉뚱한 줄을 실행하지 않게)
main() {
  set -uo pipefail
  local DIR APP CODE MSG i cmd
  # 이 스크립트가 있는 deploy 폴더의 한 칸 위 = 앱 폴더. 어느 폴더에서 실행해도 앱 폴더를 정확히 찾는다
  DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APP="$(dirname "$DIR")"

  # ── 1) 안전 확인 ─────────────────────────────────────────────────
  # root로 켜면 앱이 만드는 파일의 주인이 root가 되어, 나중에 kanban 계정이 고치지 못하므로 막는다
  if [ "$(id -u)" = "0" ]; then
    echo "중단: root로 실행하면 안 돼요. 먼저  sudo -iu kanban  으로 앱 사용자로 바꾼 뒤 다시 실행하세요."
    exit 1
  fi
  # 필요한 프로그램이 모두 설치되어 있는지 (설치 안내서 2단계)
  for cmd in tmux curl node npm pgrep; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "중단: '$cmd' 프로그램이 없어요. 설치 안내서 2단계를 확인해 주세요."
      exit 1
    fi
  done
  # 설정 파일이 없으면 앱이 데이터베이스 주소를 모른다 (설치 안내서 6단계)
  if [ ! -f "$APP/.env" ]; then
    echo "중단: 설정 파일($APP/.env)이 없어요. 설치 안내서 6단계를 해 주세요."
    exit 1
  fi
  # 빌드(npm run build)를 하지 않았으면 npm start 가 실패한다. BUILD_ID 는 빌드가 끝나면 생기는 파일
  if [ ! -f "$APP/.next/BUILD_ID" ]; then
    echo "중단: 빌드된 앱이 없어요. 먼저  cd $APP && npm ci && npm run build  를 실행해 주세요. (설치 안내서 7단계)"
    exit 1
  fi
  # 이미 켜져 있으면 두 번 켜지 않는다 (앱 프로그램은 실행되면 이름이 next-server 로 보인다)
  if pgrep -u "$(id -u)" -f 'next-server' >/dev/null 2>&1; then
    echo "이미 켜져 있어요. 앱 화면 보기:  tmux attach -t kanban"
    exit 0
  fi
  # (서버에 프록시 설정이 있어도 이 서버 안의 앱으로 바로 가도록 --noproxy)
  if curl -s --noproxy '*' -o /dev/null --max-time 3 http://127.0.0.1:3000/; then
    echo "중단: 3000번 포트를 다른 프로그램이 쓰고 있어요. (다른 계정으로 켠 칸반 앱일 수도 있어요)"
    echo "      sudo ss -tlnp | grep :3000   으로 어떤 프로그램인지 확인해 주세요."
    exit 1
  fi

  # ── 2) tmux 창 안에서 켜기 ───────────────────────────────────────
  # tmux 안에서 켜면 SSH 접속을 끊어도 앱이 계속 돈다.
  # 앱이 꺼지면 창이 바로 닫히지 않고 마지막 메시지를 보여 준 채 기다린다 (꺼진 이유를 볼 수 있게)
  # 앱이 꺼진 채 남아 있는 예전 tmux 창은 정리하고 새로 켠다
  tmux kill-session -t kanban 2>/dev/null || true
  if ! tmux new-session -d -s kanban -c "$APP" "npm start; echo; echo '앱이 꺼졌어요. 위쪽 메시지를 확인해 주세요. (Enter를 누르면 이 창이 닫혀요)'; read -r _"; then
    echo "중단: tmux 창을 만들지 못했어요."
    exit 1
  fi

  # ── 3) 켜질 때까지 기다리며 데이터베이스 연결까지 확인 ────────────
  # CODE 는 앱의 대답 번호: 200 = 정상, 403 = 주소 검사에 막힘, 500·503 = 설정·DB 문제, 000 = 아직 대답 없음
  echo "앱을 켜는 중… (최대 60초)"
  TMP="$(mktemp)" # 끝날 때 지우도록 함수 밖에서도 보이는 이름으로 둔다
  trap 'rm -f "$TMP"' EXIT
  CODE=000
  for i in $(seq 1 60); do
    sleep 1
    CODE="$(curl -s --noproxy '*' -o "$TMP" -w '%{http_code}' --max-time 15 http://127.0.0.1:3000/api/state || true)"
    [ "$CODE" != "000" ] && break
    # 몇 초가 지나도 앱 프로그램이 없으면 켜지다 멈춘 것이다
    if [ "$i" -ge 8 ] && ! pgrep -u "$(id -u)" -f 'next-server' >/dev/null 2>&1; then break; fi
  done

  # ── 4) 결과 알리기 ───────────────────────────────────────────────
  # 앱이 돌려준 대답(JSON)에서 한국어 오류 문구(error)만 꺼낸다
  MSG="$(node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{console.log(JSON.parse(s).error||"")}catch{console.log("")}})' < "$TMP" 2>/dev/null || true)"
  case "$CODE" in
    # 앱과 데이터베이스 모두 정상
    200)
      echo ""
      echo "켜졌어요. 데이터베이스 연결도 정상이에요."
      echo "  - 내 PC에서 SSH 터널을 연 뒤 브라우저에서  http://127.0.0.1:3000"
      echo "  - 앱 화면 보기:  tmux attach -t kanban   (빠져나오기: Ctrl+B 를 눌렀다 떼고 d)"
      echo "  - 끄기:          bash ~/deploy/stop.sh"
      exit 0
      ;;
    # .env 의 KANBAN_ALLOWED_PORTS 에 3000이 없으면 이 확인 요청이 주소 검사에 막힌다 (앱 자체는 켜짐)
    403)
      echo ""
      echo "켜졌어요. (.env의 KANBAN_ALLOWED_PORTS에 3000이 없어서 데이터베이스 확인은 건너뛰었어요)"
      echo "  브라우저로 접속해 화면이 잘 나오는지 확인해 주세요."
      exit 0
      ;;
    # 60초가 지나도 대답이 없거나, 앱 프로그램이 켜지다 멈춤
    000)
      echo ""
      echo "앱이 켜지지 않았어요. 아래는 앱 화면의 마지막 부분이에요:"
      echo "────────────────────────────────────────"
      tmux capture-pane -p -t kanban 2>/dev/null | grep -v '^$' | tail -n 15
      echo "────────────────────────────────────────"
      echo "원인을 고친 뒤 다시  bash ~/deploy/start.sh  를 실행해 주세요."
      exit 1
      ;;
    # 앱은 대답했지만 오류 (대부분 .env 의 데이터베이스 주소·비밀번호·이름 문제)
    *)
      echo ""
      echo "앱은 켜졌지만 문제가 있어요 (응답 $CODE):"
      echo "  ${MSG:-알 수 없는 오류예요. tmux attach -t kanban 으로 앱 화면을 확인해 주세요.}"
      echo "고친 뒤에는  bash ~/deploy/stop.sh  를 하고 다시  bash ~/deploy/start.sh  를 실행해 주세요."
      exit 1
      ;;
  esac
}
main "$@"; exit $?
