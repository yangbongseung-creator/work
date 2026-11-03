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
if [ -z "${BASH_VERSION:-}" ]; then
  echo "bash로 실행해 주세요:  bash ~/deploy/start.sh"
  exit 1
fi

main() {
  set -uo pipefail
  local DIR APP CODE MSG i cmd
  DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  APP="$(dirname "$DIR")"

  if [ "$(id -u)" = "0" ]; then
    echo "중단: root로 실행하면 안 돼요. 먼저  sudo -iu kanban  으로 앱 사용자로 바꾼 뒤 다시 실행하세요."
    exit 1
  fi
  for cmd in tmux curl node npm pgrep; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "중단: '$cmd' 프로그램이 없어요. 설치 안내서 2단계를 확인해 주세요."
      exit 1
    fi
  done
  if [ ! -f "$APP/.env" ]; then
    echo "중단: 설정 파일($APP/.env)이 없어요. 설치 안내서 6단계를 해 주세요."
    exit 1
  fi
  if [ ! -f "$APP/.next/BUILD_ID" ]; then
    echo "중단: 빌드된 앱이 없어요. 먼저  cd $APP && npm ci && npm run build  를 실행해 주세요. (설치 안내서 7단계)"
    exit 1
  fi
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

  # 앱이 꺼진 채 남아 있는 예전 tmux 창은 정리하고 새로 켠다
  tmux kill-session -t kanban 2>/dev/null || true
  if ! tmux new-session -d -s kanban -c "$APP" "npm start; echo; echo '앱이 꺼졌어요. 위쪽 메시지를 확인해 주세요. (Enter를 누르면 이 창이 닫혀요)'; read -r _"; then
    echo "중단: tmux 창을 만들지 못했어요."
    exit 1
  fi

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

  MSG="$(node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{console.log(JSON.parse(s).error||"")}catch{console.log("")}})' < "$TMP" 2>/dev/null || true)"
  case "$CODE" in
    200)
      echo ""
      echo "켜졌어요. 데이터베이스 연결도 정상이에요."
      echo "  - 내 PC에서 SSH 터널을 연 뒤 브라우저에서  http://127.0.0.1:3000"
      echo "  - 앱 화면 보기:  tmux attach -t kanban   (빠져나오기: Ctrl+B 를 눌렀다 떼고 d)"
      echo "  - 끄기:          bash ~/deploy/stop.sh"
      exit 0
      ;;
    403)
      echo ""
      echo "켜졌어요. (.env의 KANBAN_ALLOWED_PORTS에 3000이 없어서 데이터베이스 확인은 건너뛰었어요)"
      echo "  브라우저로 접속해 화면이 잘 나오는지 확인해 주세요."
      exit 0
      ;;
    000)
      echo ""
      echo "앱이 켜지지 않았어요. 아래는 앱 화면의 마지막 부분이에요:"
      echo "────────────────────────────────────────"
      tmux capture-pane -p -t kanban 2>/dev/null | grep -v '^$' | tail -n 15
      echo "────────────────────────────────────────"
      echo "원인을 고친 뒤 다시  bash ~/deploy/start.sh  를 실행해 주세요."
      exit 1
      ;;
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
