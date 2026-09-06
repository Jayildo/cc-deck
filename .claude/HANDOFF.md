---
updated: 2026-09-06T22:11:52+0900
branch: chore/bump-verified-claude-version
session_by: claude
---

# Handoff — cc-deck

## 지금 어디?

"cc-deck에서 auto/manual/accept-edits/plan 모드가 안 먹고 승인 요청이 폭주한다(윈도우 패치 후?)"를 진단해
**cc-deck 무혐의**를 확정했다 — 원인은 전역 `~/.claude/settings.json`의 `autoMode.environment`가 socp-fs 전용이고
`$defaults`가 없던 것 + cc-deck 쪽 CLI(`%APPDATA%\npm`)만 2.1.257+로 자동 갱신된 것 + 프로젝트 로컬 autoMode를
classifier가 무시하는 것 + auto 모드가 광역 `Bash` allow를 탈락시키는 것. settings.json을 고쳤다(cc-deck 코드 변경 0).
이어서 **usage 폴러 429 백오프**(`server/usage.ts`)를 구현·검증해 이 커밋에 담았다.
**라이브 서버(4317)는 옛 코드** — 재시작 전까지 백오프 미적용.

## 다음 할 일

1. **외부 터미널에서 `npm run restart`** → `~/.cc-deck/server.log`에서 "usage degraded/recovered" 반복이 사라지고
   "usage throttled"가 시간당 1줄 이하인지 확인.
2. cc-deck에서 socp-erp / papa_01_record 세션을 **새로** 열어(기존 세션은 시작 시 판정 유지) auto 모드로
   `git status`·`npm run build`·작업 브랜치 push가 classifier에 안 막히는지, `/permissions` → Recently denied가 비었는지 확인.
   "Allow reads outside the working directories?"가 뜨면 **Keep allowing**.
3. (선택) cwd 표기 정규화 — cc-deck이 넘기는 `C:\project\x`와 터미널의 `C:/project/x`·`c:/…`가 `~/.claude.json`
   `projects` 키를 갈라 놓음(신뢰 다이얼로그 중복). (선택) fnm 셸에서 `npm i -g @anthropic-ai/claude-code@latest`로
   터미널 CLI를 2.1.260에 정렬. (선택) 이 브랜치를 main에 병합.

## 결정사항

- **usage 백오프**: `setInterval` → `setTimeout` 체인. 429/5xx/네트워크 예외 → Retry-After 준수, 없으면 ×2(상한 10분,
  ±10% 지터), 성공하면 기본 60초 복귀. 화면 숫자가 5주기(5분) 미만으로 신선하면 조용히 유지(배지 초록, 로그는
  시간당 1줄 "usage throttled"), 지속 장애만 기존대로 앰버+사유. 401/403은 백오프 제외(2-strike 빨강 판정이 늦어지지
  않게). throttle 플래그는 내부 상태로만 — AccountUsage/WS 페이로드로 안 샘. 이유: 2026-09-04 기준 37시간에 단발
  429가 ~170회, 매번 배지 깜빡임 + 로그 2줄.
- **권한 문제는 cc-deck 밖에서 해결** — 웹 터미널은 Shift+Tab을 통과시키고 서버는 권한 플래그 없이 `cmd /c claude`를
  띄우므로 손댈 곳이 없었다. 근거·경위는 memory `prompt-flood-root-cause-automode-environment`.
- **auto 모드에서 권한을 넓히는 편집은 classifier가 막는다**(스킬 호출·스크래치패드 준비까지) → 사용자에게 Shift+Tab
  manual 전환을 요청한 뒤 진행. memory `auto-mode-blocks-permission-widening-edits`.

## 주의사항

- **재시작은 외부 터미널에서만** — cc-deck이 연 세션이 전부 죽음(memory `cc-deck-restart-kills-hosting-session`).
- 테스트 스위트 없음. 백오프는 스크래치패드 시뮬레이션으로 검증(가짜 USERPROFILE로 config 경로 격리 + `fetch`/
  `setTimeout`/`Date.now` 패치, Retry-After·×2·상한·grace→앰버 전이·회복·네트워크 예외·401 경로 전부 통과).
  스크립트는 세션 스크래치패드에만 있어 사라짐 — 재검증하려면 같은 골격으로 다시 작성.
- cc-deck 쪽 CLI는 하루 여러 번 자동 갱신 — "cc-deck에서만 이상하다"는 증상은 먼저 두 CLI 버전부터 비교
  (memory `two-claude-installs-fnm-shadows-npm`).
- 관찰된 실패 없음: typecheck ✓, 시뮬레이션 ALL PASSED.

## 수정된 파일

(이 커밋에 포함)
- `server/usage.ts` — 백오프 스케줄러
- `.claude/CLAUDE.md` — "Account 5h/weekly" bullet의 429/5xx 동작 갱신
- `.claude/HANDOFF.md` — 이 파일

## 이어받는 법

```bash
# 1) 반드시 외부 터미널 — 서버 재시작(호스팅 세션 전부 종료됨)
npm run restart

# 2) 백오프 동작 확인 (한두 시간 뒤)
grep -E "usage (throttled|degraded|recovered)" ~/.cc-deck/server.log | tail -n 20

# 3) 코드 건드리기 전 타입체크
npm run typecheck
```
