---
updated: 2026-08-18T11:15:00+0900
branch: main
session_by: claude
---

# Handoff — cc-deck

## 지금 어디?

7/23 핸드오프의 "버전 결합 2건 + 서버 누수·견고성 2건 + 남은 low들"을 한 번에 처리했다.
**서버 견고성 묶음**(종료 세션 30분 TTL·conhost 누수·OAuth 타임아웃/합류·hello 메트릭 스냅샷·
컨텍스트 창 세대 판정), **Claude 버전 감시의 자체검증**(CLI 번들에서 승인 문구 직접 확인),
**웹 UX/접근성**(연결 끊김 배지·리로드 즉시 메트릭·모달 포커스), **스크립트/의존성/문서 최신화**.
21개 코드 파일 + 문서 7종이 **작업트리에만 있고 아직 커밋 안 됨**. 라이브 서버(4317)는 옛 코드.

## 다음 할 일

1. **외부 터미널에서 deps 실체화 + 검증 + 재시작** (하나의 재시작 창으로 처리):
   ```bash
   npm install --include=dev --ignore-scripts && npm run typecheck && npm run build && npm run restart
   ```
   package-lock은 갱신됐지만 9개 패키지(tsx, @types/node, undici-types, concurrently, fast-uri,
   find-my-way, nanoid, postcss, shell-quote)가 아직 node_modules에 없음(`node_modules/.package-lock.json`
   지워둬서 npm이 알아챔). fastify 5.12·@fastify/static 10.1.3·@fastify/websocket 11.3·chokidar 5.0은
   이미 설치됨(순수 JS). 통과하면 커밋.
2. **재시작 후 체감 확인** — 브라우저 `Ctrl+Shift+R`:
   - 세션 하나 `/exit` → 30분 뒤 목록에서 사라짐(EXITED_TTL_MS), 그 사이 입력/리사이즈해도 토스트 없음
   - 서버 로그에 `permission phrases still present in …` 한 줄, 승인 토스트 **미발생**
     (설치 CLI ≠ 2.1.234여도 문구가 있으면 조용)
   - 서버 내리면 헤더에 빨간 "연결 끊김" 배지 + 터미널 흐려짐, 올리면 자동 복구
   - 리로드 직후 선택 안 한 세션도 상태/토큰이 바로 채워짐(hello.metrics)
   - opus-5 계열 세션의 컨텍스트%가 1M 기준으로 표시(이전엔 200K로 떨어졌음)
   - 리포트 📋 "오늘 생성"이 `--model sonnet`으로 정상 생성
3. **(선택) node-pty beta.15** — 네이티브라 재시작 창에서만:
   `npm install @lydell/node-pty@1.2.0-beta.15` 후 restart (beta.14/15에 Windows spawn/UAF/데드락 수정).

## 결정사항

- **SUMMARY_MODEL = `"sonnet"`(CLI 별칭)** — `claude -p --model sonnet`은 최신 Sonnet으로 해석되므로
  모델 교체마다 손댈 필요 없음. 날짜 박힌 id로 되돌리지 말 것.
- **버전 감시는 자체검증** — `VERIFIED_CLAUDE_VERSION`(2.1.234)과 설치본이 다르면 CLI 번들
  (npm shim → `node_modules/@anthropic-ai/claude-code/bin/claude.exe`, 또는 `~/.local/bin/claude`)을
  스트리밍해 PERMISSION_RE 원문 조각 4개를 찾음. 전부 있으면 로그만, 없거나 못 찾으면 토스트.
  → **상수 bump은 선택적 위생**이지 필수 아님. CLI는 주 몇 회 자동 업데이트(오늘 2.1.234; fnm 셸 shim은
  2.1.222로 보이니 서버 env 기준 `cmd /d /s /c claude --version`으로 볼 것).
- **종료 세션 30분 TTL** — × 와 같은 teardown. win32는 exit 시 conin 소켓 해제 + `_innerPid=0`
  (conhost 누수·PID 재사용 kill 스윕 방지). exited pty엔 input/resize 무시, cols/rows 검증.
- **tsx·cross-env → dependencies + `.npmrc include=dev`** — `npm start`/autostart가 `node --import tsx`로
  돌아서 런타임 의존성이 맞고, 이 머신 전역 npm이 `omit=dev`라 devDependencies가 조용히 prune되던 것을
  막음. 호스팅 셸에는 `NODE_ENV=production`(그 값만) 안 넘김.
- **contextWindowFor 세대 기반** — opus/sonnet major≥5 또는 4.≥6 → 1M, fable/mythos-N → 1M, haiku → 200K.
  기존 allow-list가 `claude-opus-5`를 200K로 떨어뜨리던 실제 버그 수정.
- **기각(재발굴 금지)** — client.attached 증가, ~~만료 토큰 시 statusline 폴백 생략~~ **번복(2026-08-31,
  server/usage.ts §4.1 진단/데이터 분리 — FIX-PLAN.md 참조)**, 슬립 후 리포트 catch-up(날짜 인지 리포트가
  먼저 — v2), 리로드 시 기존 완료/승인 재깜빡임. FIX-PLAN 기각표도 유효.

## 주의사항

- **라이브 서버(4317)는 옛 코드** — 서버 변경은 전부 재시작 후 반영. 웹 변경(web/dist 재빌드됨)은
  하드 리로드로 이미 반영 가능.
- **재시작은 외부 터미널에서만** — cc-deck가 연 세션이 다 죽음(메모리 `cc-deck-restart-kills-hosting-session`).
- **npm 전역 `omit=dev`** — 이 머신 특성. 리포 `.npmrc`가 덮지만 `npm install`을 다른 cwd/방식으로
  돌리면 devDependencies가 빠질 수 있음. `--include=dev` 명시 권장.
- **하위 에이전트의 권한 프롬프트는 메인 세션이 idle일 때만 뜸** — 서브에이전트에게 파일 수정을 맡기고
  메인이 계속 뭔가 하고 있으면 승인창이 안 보여 멈춘 것처럼 보임.
- FIX-PLAN.md는 DONE/아카이브 표기(3.7 Host 헤더만 미적용). 관찰된 실패 없음: typecheck ✓ · build ✓
  (재시작 창에서 deps 실체화 후 다시 확인).

## 수정된 파일

(모두 **미커밋**, 작업트리)
- 서버: `server/{config,index,metrics,reports,sessions,usage,util}.ts`, `shared/types.ts`
- 웹: `web/index.html`, `web/style.css`, `web/src/{main,reports,sessions,ws}.ts` (web/dist 재빌드 = gitignore)
- 스크립트/설정: `scripts/{install-autostart,install-statusline-tee,uninstall-statusline-tee,restart}.mjs`,
  `tsconfig.json`(allowJs+checkJs), `package.json`, `package-lock.json`, `.npmrc`(신규)
- 문서: `README.md`, `.claude/CLAUDE.md`, `PLATFORMS.md`, `MACOS.md`, `.claude/FIX-PLAN.md`,
  `docs/dev-plan.md`(+ `docs/dev-plan-history/2026-08-18-1113.md`), 이 파일

## 이어받는 법

```bash
# 1) 반드시 외부 터미널 — deps 실체화 + 검증 + 재시작(호스팅 세션 전부 종료됨)
npm install --include=dev --ignore-scripts && npm run typecheck && npm run build && npm run restart

# 2) 브라우저 http://127.0.0.1:4317/ + Ctrl+Shift+R → 위 "체감 확인" 목록

# 3) 통과하면 커밋 (아직 아무것도 커밋 안 됨)
git add -A && git commit

# (선택) node-pty beta.15 — 재시작 창에서만
npm install @lydell/node-pty@1.2.0-beta.15 && npm run restart
```
