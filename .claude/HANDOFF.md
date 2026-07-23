---
updated: 2026-07-23T13:38:07+0900
branch: main
session_by: claude
---

# Handoff — cc-deck

## 지금 어디?

멀티에이전트 리뷰로 **최근 개선 arc + 남은 개선점 15건(검증통과)**을 뽑고, 그중 추천했던
**웹 3종 묶음을 적용·검증·커밋**했다. 이어 "Claude 버전업 시 cc-deck도 손봐야 하나?"를 분석 —
**버전 결합 지점 2건**(VERIFIED 상수, SUMMARY_MODEL)이 지금 손볼 값어치가 있음을 확인했다(미착수).
작업 트리 클린 예정, 라이브 서버는 여전히 병합 전 옛 코드(재시작 미룸).

## 다음 할 일

1. **웹 3종 라이브 체감(재시작 불필요)** — `http://127.0.0.1:4317/` + `Ctrl+Shift+R`.
   세션을 여러 개 띄우고 한 세션 상태 변화/선택/닫기 시 **다른 세션들의 완료·응답·승인 깜빡임이
   더 이상 끊기지 않는지** 눈으로 확인(이번 수정의 핵심).
2. **(선택) 버전 결합 2건** — 둘 다 `server/*`라 `npm run restart` 필요(외부 터미널):
   - `server/util.ts:116` `VERIFIED_CLAUDE_VERSION` = 2.1.212 인데 설치본 **2.1.207** → 불일치.
     현재 CLI에서 권한 문구(`PERMISSION_RE`) 재검증 후 상수를 설치 버전에 맞춰 갱신.
   - `server/reports.ts:9,208` `SUMMARY_MODEL = "claude-sonnet-4-6"` (리포트 생성에 `--model`로 사용)
     → Sonnet 4.6 폐기 시 리포트 실패. `claude-sonnet-5`로 갱신 후보.
3. **(선택) 서버 고우선 누수·견고성 2건** — `npm run restart` 필요:
   - `server/sessions.ts` onExit: exited 엔트리 evict 정책 없음(느린 누수) → TTL/개수 상한.
   - `server/usage.ts` OAuth fetch: `AbortSignal.timeout()` + refreshNow 재진입 가드.
4. **(참고) 남은 low들** — notePtyOutput 키에코 done→working, client.attached 미정리,
   config.host/SessionStatus.idle 데드코드, trimScrollback UTF-8 경계, WS 백오프/끊김표시,
   reduced-motion pulse LED, 사용량 게이지 100%초과 텍스트. (효과 대비 낮음, 여유 시)

## 결정사항

- **웹 3종 = renderAll in-place reconcile + 누수정리 + 접근성.** renderAll의 `innerHTML=""`
  전체 재빌드가 매 tick마다 모든 행의 CSS 깜빡임을 0%로 리셋하던 것이 최근 추가한 acknowledge/blink
  기능을 스스로 깎았음 → **DOM 노드 유지 + 바뀐 것만 in-place 갱신**(`updateRow`)으로 교체, patchRow도
  `replaceWith`→in-place. 사라진 행은 **루프 전에 먼저 제거**(리뷰 지적: 중간행 제거 시 뒤 행 이동→리셋 방지).
  텍스트를 `textContent`/`title`로 써서 `esc()` 제거(따옴표 미이스케이프 이슈까지 해소).
- **접근성:** `role=listbox/option` + `aria-selected` + `aria-activedescendant`(현존 커서일 때만 — dangling 방지).
- **모델→컨텍스트 윈도우 매핑은 이미 최신**(opus-4-[678]/sonnet-4-6·5/fable·mythos-5/haiku) — 손댈 것 없음.
- **적대적 리뷰 통과:** 회귀 렌즈 0건, reconcile·접근성 low 2건은 이번에 반영 완료.

## 주의사항

- **라이브 서버(4317)는 병합 전 옛 코드.** 서버 변경(2·3번)을 반영하려면 재시작해야 하고,
  재시작은 **외부 터미널에서만**(cc-deck가 연 세션은 다 죽음 — 메모리 `cc-deck-restart-kills-hosting-session`).
  웹 변경은 rebuild+새로고침으로 이미 반영 가능.
- **VERIFIED_CLAUDE_VERSION은 단일 상수** — Windows(2.1.207)·mac 협업자가 서로 다른 CLI면 어느 쪽이든
  토스트가 뜸(구조적 한계). 재검증 시 최신 기준으로 올리는 게 합리적.
- 관찰된 실패 없음: `npm run typecheck` ✓ · `npm run build` ✓.

## 수정된 파일

(이번 세션 커밋에 포함 — web/src/sessions.ts, web/src/main.ts. web/dist는 재빌드됨 = gitignore)

## 이어받는 법

```bash
# 웹 3종 체감 — 재시작 불필요
#   브라우저 http://127.0.0.1:4317/ + Ctrl+Shift+R

# 서버 변경(2·3번) 반영 — 반드시 외부 터미널에서
npm run restart

# 검증
npm run typecheck && npm run build
```
