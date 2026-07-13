---
updated: 2026-07-13T09:24:02+0900
branch: main
session_by: claude
---

# Handoff — cc-deck

## 지금 어디?

세션 사이드바에 **3상태 활동 표시**(🟠작동중 / 🔵선택요청 / 🟢완료, 트랜스크립트 기반)를 추가하고 기존 context-% 바를 대체했다. **macOS 완전 패리티**(경로 정규화 크로스플랫폼화, POSIX reap, launchd autostart·lsof restart 포팅, MACOS.md)와 **5종 테마 스위처**(Midnight·Nord·Solarized Dark·Gruvbox·Solarized Light — 앱 크롬 + xterm 터미널, localStorage) + UI 폴리시까지 완료. 저장소를 **public + MIT**로 전환하고 공개용 README 정비. 전부 커밋·push됨(HEAD `88c30b6`), 워킹트리 클린, origin 동기화.

## 다음 할 일

1. **라이브 확인 = 서버 재시작 필요.** 활동 표시·테마는 서버가 새 코드여야 보인다. 프로덕션 서버는 자동리로드 없음 → **cc-deck 밖 별도 터미널**에서 `npm run restart` (안에서 하면 자기 자신을 죽여 서버가 안 살아남 — [[cc-deck-restart-kills-hosting-session]] 참조).
2. **mac 전달** — repo가 public이니 상대방은 clone → `MACOS.md`대로 install/build/start (각자 자기 Claude Code 로그인 필요). 협업자 추가 불필요.
3. **mac 실제 스모크 테스트** — 여기(Windows)선 mac 런타임 미검증(코드 정합성 + tsc 기준으로만 통과). 세션 열기·메트릭·테마·autostart를 mac에서 한 번 돌려볼 것.

## 결정사항

- **활동 감지 = 트랜스크립트 기반, 구조화 선택지만.** 마지막 main-chain assistant 레코드가 tool_use면 working(AskUserQuestion/ExitPlanMode면 awaiting-choice), text면 done. 타이머·PTY 스크래핑 없이 트랜스크립트 append마다 자동 갱신. **권한 프롬프트·산문 1/2/3은 의도적 미감지**(터미널 텍스트 긁기는 취약).
- **크로스플랫폼 = `process.platform` 분기, Windows 무손상.** projects.ts/reports.ts는 비-win에서 소문자화 없이 슬래시만 정규화(대소문자 구분 FS).
- **테마 = CSS 변수 + `data-theme` + xterm ITheme 별도 맵**(themes.ts 단일 진실원천), anti-flash `<head>` 스크립트. hue 묶인 rgba overlay는 color-mix로 전환(테마별 재틴팅).

## 주의사항

- 서버 재시작 시 **실행 중인 모든 cc-deck 세션 종료**(자식 PTY). 안전한 지점에서 할 것.
- **상태 점(dot) 로직은 여전히 미완**(범위 밖으로 남김): 첫 출력 후 `active` 고정, `idle` 복귀 없음. 이제 활동 신호는 pill이 담당하니 dot은 lifecycle(시작중/종료) 용도로만 의미. 원하면 정리 가능.
- mac autostart/restart 스크립트(launchd/lsof)는 **mac에서 미실행 검증** — 코드 리뷰만 통과.

## 수정된 파일

(없음 — 전부 커밋·push 완료, 워킹트리 클린)

## 이어받는 법

```
git pull                       # 이미 최신
# 라이브 확인(활동 표시·테마)은 cc-deck 밖 별도 터미널에서:
npm run restart                # → http://localhost:4317
```
