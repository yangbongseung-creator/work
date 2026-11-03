#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 칸반 보드 끄기
#   tmux 창(이름: kanban) 안의 앱에 Ctrl+C를 보내 깔끔하게 끄고, 창도 정리한다.
#
# 사용법 (kanban 사용자로):   bash ~/deploy/stop.sh
# ─────────────────────────────────────────────────────────────────────────────
if [ -z "${BASH_VERSION:-}" ]; then
  echo "bash로 실행해 주세요:  bash ~/deploy/stop.sh"
  exit 1
fi

main() {
  set -uo pipefail
  local ME i
  ME="$(id -u)"
  if [ "$ME" = "0" ]; then
    echo "중단: root로 실행하면 안 돼요. 먼저  sudo -iu kanban  으로 앱 사용자로 바꾼 뒤 다시 실행하세요."
    exit 1
  fi
  running() { pgrep -u "$ME" -f 'next-server' >/dev/null 2>&1; }

  if ! running; then
    tmux kill-session -t kanban 2>/dev/null || true
    echo "앱은 이미 꺼져 있어요."
    exit 0
  fi

  echo "앱을 끄는 중…"
  tmux send-keys -t kanban C-c 2>/dev/null || true
  for i in $(seq 1 15); do
    running || break
    sleep 1
  done
  # tmux 밖에서 켠 경우 등: 앱 프로그램에 직접 끄라고 알린다 (이 계정의 앱만)
  if running; then
    pkill -TERM -u "$ME" -f 'next-server' 2>/dev/null || true
    for i in $(seq 1 10); do
      running || break
      sleep 1
    done
  fi
  if running; then
    echo "앱이 꺼지지 않았어요.  tmux attach -t kanban  으로 들어가 Ctrl+C 를 눌러 주세요."
    exit 1
  fi
  tmux kill-session -t kanban 2>/dev/null || true
  echo "앱을 껐어요."
}
main "$@"; exit $?
