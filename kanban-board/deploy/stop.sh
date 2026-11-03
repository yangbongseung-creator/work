#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 칸반 보드 끄기
#   tmux 창(이름: kanban) 안의 앱에 Ctrl+C를 보내 깔끔하게 끄고, 창도 정리한다.
#
# 사용법 (kanban 사용자로):   bash ~/deploy/stop.sh
# ─────────────────────────────────────────────────────────────────────────────
#
# 하는 일 (순서)
#   1) root가 아닌지 확인
#   2) 앱이 이미 꺼져 있으면 남은 tmux 창만 정리하고 끝냄
#   3) tmux 창(kanban)에 Ctrl+C 를 보내 앱이 스스로 깔끔하게 꺼지게 함 (최대 15초 기다림)
#      앱은 Ctrl+C 를 받으면 열려 있는 실시간 연결을 닫고 꺼진다
#   4) 그래도 안 꺼지면(tmux 밖에서 켠 경우 등) 이 계정의 앱 프로그램에만 종료 신호를 보냄 (최대 10초)
#   5) 꺼졌으면 tmux 창을 닫고 "앱을 껐어요"
#
# sh(dash)로 실행하면 아래의 bash 문법이 깨지므로 가장 먼저 막는다
if [ -z "${BASH_VERSION:-}" ]; then
  echo "bash로 실행해 주세요:  bash ~/deploy/stop.sh"
  exit 1
fi

# 모든 내용을 main 함수 안에 두고 맨 마지막 줄에서 실행한 뒤 바로 끝낸다.
# (bash는 스크립트를 읽어 가면서 실행하므로, 실행 도중 이 파일이 새 버전으로 바뀌어도 엉뚱한 줄을 실행하지 않게)
main() {
  set -uo pipefail
  local ME i
  # 지금 계정의 번호. 다른 계정이 켠 프로그램은 건드리지 않도록 이 번호로만 찾는다
  ME="$(id -u)"
  if [ "$ME" = "0" ]; then
    echo "중단: root로 실행하면 안 돼요. 먼저  sudo -iu kanban  으로 앱 사용자로 바꾼 뒤 다시 실행하세요."
    exit 1
  fi
  # 이 계정의 앱 프로그램(next-server)이 돌고 있는지 확인하는 작은 함수
  running() { pgrep -u "$ME" -f 'next-server' >/dev/null 2>&1; }

  if ! running; then
    tmux kill-session -t kanban 2>/dev/null || true
    echo "앱은 이미 꺼져 있어요."
    exit 0
  fi

  # tmux 창에 Ctrl+C 를 보내면 그 안의 npm start 가 멈추고, 앱은 정리를 마친 뒤 꺼진다
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
  # 다 꺼졌으면 tmux 창도 닫는다
  tmux kill-session -t kanban 2>/dev/null || true
  echo "앱을 껐어요."
}
main "$@"; exit $?
