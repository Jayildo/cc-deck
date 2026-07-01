---
updated: 2026-07-01T09:58:58+0900
branch: main
session_by: claude
---

# Handoff — cc-deck

## 지금 어디?

로컬 Claude Code 멀티세션 매니저 **v0.1 완성**. 세션 터미널 + 세션별 진행/컨텍스트%/누적토큰 + 계정 5h·주간 사용량 대시보드에, 오늘 즐겨찾기/최근 피커·X닫기 수정·localhost 접속·Windows 자동시작·토큰 툴팁·**데일리 업무일지 리포트**까지 추가. 커밋 12개(로컬), 미커밋 없음. **숨김 자동시작 서버가 `http://localhost:4317`에 가동 중**(사용자 `npm run restart`로 최신 코드 반영됨).

## 다음 할 일

1. **GitHub private repo 생성 + push** — 아직 remote 없음(백업 미완). `gh repo create cc-deck --private --source . --push` 제안 → 사용자 승인 후 실행. (보안 기본값: private, 사용자 [[feedback_platform_security_defaults]] 참조)
2. **데일리 리포트 `claude -p` PATH 재검증** — 재부팅 후 Startup .vbs가 clean 로그인 env에서 뜰 때 `claude`가 PATH에 잡히는지 확인. 안 잡히면 `server/reports.ts summarize()`에서 claude.cmd 절대경로(`%APPDATA%\npm\claude.cmd`) resolve.
3. (선택) 리포트 모달 **마크다운 렌더**(현재 `<pre>` raw), UI 폴리시(사용량 바 여백/사이드바 위계).

## 결정사항

- **node-pty = `@lydell/node-pty`** (N-API 프리빌드). homebridge 변종은 Node24 프리빌드 없어 크래시.
- **ConPTY는 `claude.cmd` 직접 실행 불가**(error 193) → `cmd.exe /d /s /c claude`로 래핑. child_env에서 `CLAUDE_CODE*` 스트립(중첩 세션 방지).
- **localhost**: 서버는 `::` dual-stack 바인딩 + onRequest 루프백 가드(비-루프백 403) → localhost·127.0.0.1 둘 다 되면서 로컬 전용 유지.
- **토큰 dedup**: `message.id:requestId` 키(레코드 2× 기록됨). 세션행 total은 대부분 컨텍스트 로드분(캐시) — 툴팁으로 breakdown 노출.
- **계정 사용량**: 비공식 OAuth `GET /api/oauth/usage`(unofficial, 깨질 수 있음) 주력 + statusline tee 폴백.
- **데일리 리포트**: 트랜스크립트 통째 X → git커밋+프롬프트+파일변경 다이제스트만 프로젝트별 `claude -p`(Sonnet) 요약 (싸고·굵고·환각↓).

## 주의사항

- **숨김 서버는 자동리로드 없음** → 서버 코드 바꾸면 반드시 `npm run restart`. 프론트만 바꾸면 `vite build` + 브라우저 하드새로고침.
- **Startup 폴더 쓰기는 에이전트 샌드박스가 막음** → `install:autostart`는 사용자가 직접 실행해야 함.
- 계정 사용량 OAuth 엔드포인트는 **비공식** — 깨지면 stale/reauth 뱃지로 degrade.
- 리포트는 **프로젝트 디렉터리에서 연 세션**(cwd) 기준으로 묶임 — 홈/cc-deck 자체 세션은 제외.

## 수정된 파일

(없음 — 전부 커밋됨. `git log --oneline -12` 참조)

## 이어받는 법

```bash
cd C:\project\cc-deck
npm run restart          # 숨김 서버 최신 코드로 재시작 → http://localhost:4317
# GitHub 백업하려면:
gh repo create cc-deck --private --source . --push
```
