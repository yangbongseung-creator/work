# agent-team — 앱을 만드는 AI 에이전트 팀

기획 → 개발 → 검수 → QA → 기록까지, 여러 AI 에이전트가 일을 나눠 맡아 앱을 만드는 시스템을 설계하는 프로젝트입니다.

## 현재 상태

- 분석·계획 단계 (아직 코드 없음)
- 계획서: [docs/agent-system-plan.md](docs/agent-system-plan.md)

## 핵심 결정

| 항목 | 결정 |
| --- | --- |
| 구조 | 마스터 AI 1개 + 하위 에이전트 5개 (기획·개발·검수·QA·위키) |
| 교차 검증 | 개발은 Codex, 검수는 Claude (읽기 전용 리뷰) |
| 만들 앱 | 웹(Next.js + React) + 모바일(React Native + Expo, 앱스토어용) |
| 요금 방식 | 구독 요금제 |
| 연습용 첫 앱 | 일주일 식단 관리 웹앱 |

## 다음 단계

0단계: 도구 설치 확인 — 스크립트에서 Claude Code CLI(`claude -p`)와 Codex CLI(`codex exec`)를 각각 불러 답을 받으면 통과.
