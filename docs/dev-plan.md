# cc-deck 개발 계획

## NOW
서버 견고성 묶음(종료 세션 30분 자동 정리·conhost 누수·OAuth 타임아웃·리로드 시 메트릭 즉시 표시·접속 끊김 배지)과 Claude 버전 감시를 "CLI 본체에서 승인 문구를 직접 확인"하는 자체검증으로 바꾸고, 의존성(fastify 5.12·chokidar 5 등)과 문서 7종을 전면 최신화함. 코드는 작업트리에만 있고 아직 커밋·재시작 전.

## NEXT
외부 터미널에서 `npm install --include=dev --ignore-scripts && npm run typecheck && npm run build && npm run restart` → 브라우저 하드 새로고침 후 체감 확인(종료 세션 30분 뒤 사라짐, 승인 토스트 없이 로그만, 서버 내렸을 때 빨간 배지, 리로드 직후 세션별 상태·토큰 표시, opus-5 컨텍스트% 정상). 확인되면 커밋.

## BLOCKERS
없음

---

## 프로젝트 개요
여러 Claude Code 세션을 한 브라우저 창에서 관리하는 로컬 관제 화면. 새 세션을 진짜 터미널로 열고, 세션별 진행률·컨텍스트·누적 토큰과 계정 사용량(5시간/주간)을 함께 봄. localhost 전용.

## 최근 변경 (2026-08-18)
- 세션 목록을 통째로 다시 그리지 않고 바뀐 행만 고쳐서 다른 세션이 움직여도 완료·응답·승인 깜빡임이 끊기지 않게 함, 선택하면 깜빡임 해제 (c727f2e, e21149e, 069cf3d)
- suni(macOS) 갈래 병합: PTY 잠잠해질 때까지 완료 유예, 잘린 JSONL 줄 재조립, Keychain 토큰, 드래그앤드롭·고정 탭 (b9a0f7b)
- 서버(미커밋): 종료 세션 30분 후 자동 정리 + Windows conhost 누수 수정, 종료 pty에 입력/리사이즈 차단, 스크롤백 줄 단위 트림, 접속 hello에 메트릭 스냅샷, OAuth 15초 타임아웃·중복 호출 합류, 리포트 모델 `sonnet` 별칭 + env 정리, 컨텍스트 창 세대 기반 판정(opus-5가 200K로 떨어지던 버그 수정), Claude 버전 감시가 CLI 번들에서 승인 문구를 직접 확인(VERIFIED 2.1.234)
- 웹(빌드 반영됨): 연결 끊김 배지, 리로드 시 메트릭 즉시 표시, 리포트 모달·토스트 접근성, reduced-motion 확대
- 스크립트: restart가 포트를 런처에서 읽고 Windows는 새 탭 없이 재시작(run-server.vbs), macOS는 LISTEN 소켓만 전부 종료; statusline 설치/해제 `type` 왕복 보존; scripts/*.mjs 타입체크
- 의존성: fastify 5.12·@fastify/static 10·@fastify/websocket 11.3·chokidar 5 설치, tsx/cross-env → dependencies, `.npmrc include=dev`; 9개 패키지는 lock만 갱신(재시작 창에서 실체화)
- 문서(README/CLAUDE.md/PLATFORMS/MACOS/HANDOFF/FIX-PLAN) 최신화, FIX-PLAN은 DONE 아카이브 표기
