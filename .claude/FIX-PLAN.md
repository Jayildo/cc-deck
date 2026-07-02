# FIX-PLAN — 2026-07-02 멀티에이전트 리뷰 확정 버그 수정 계획

> 출처: 44-에이전트 워크플로우 리뷰 (리더 6 + 적대 검증 38). 56건 발견 → 26건 검증 →
> **15건 확정**(중복 1건 제외), 10건 기각. 아래는 검증 통과분만 수록.
> 실행 주체: Opus 오케스트레이터 + Sonnet 구현 서브에이전트 (C:\project\CLAUDE.md 멀티모델 전략 준수).

## 시작 전 필수

- [ ] 워킹트리에 미커밋 변경 8파일 있음 (server/config.ts, index.ts, util.ts, shared/types.ts,
      web/src/{main,sessions,terminal}.ts, web/style.css). **수정 전 현재 WIP를 먼저 커밋**해서
      리뷰 수정분과 섞이지 않게 할 것.
- [ ] 수정 완료 후 배포: `npm run build` → `npm run restart` (restart는 재빌드 안 함 — 의도된 동작).

---

## 테마 1 — sessions.ts 디스커버리/바인딩 (근본 원인: one-shot 디스커버리 + one-shot 바인딩)

**핵심 파일**: `server/sessions.ts`, `server/metrics.ts` · **담당 1명에게 묶어서 배정** (서로 얽혀 있음)

### 1.1 [HIGH] 25초 후 디스커버리 영구 포기 → 메트릭 영구 0
- `server/sessions.ts:13` `POLL_TIMEOUT_MS=25_000`, `:149-155`에서 elapsed 초과 시 clearInterval.
- 트랜스크립트는 **첫 프롬프트 제출 시** 생성(.claude/CLAUDE.md 하드원 팩트)이므로 25초 넘겨 첫
  프롬프트 치면 `claudeSessionId`(유일한 setter는 `:185`)가 영영 안 잡힘 → `metrics.ts:203` 게이트에
  막혀 테일러 미바인딩.
- **수정**: 타임아웃으로 죽이지 말 것. 최초 25초는 400ms 폴링 유지, 이후 **3–5초 슬로우 폴로 백오프**
  하여 discovered/exit/close까지 지속. (대안: input()에서 CR 감지 시 fast poll 재가동 — 백오프안 권장)

### 1.2 [MED] `Math.max(birthtime, mtime)` 신선도 판정 → 남의 활성 트랜스크립트 탈취
- `server/sessions.ts:179-180`. mtime은 append마다 갱신 → 같은 cwd의 남의(또는 1.1로 고아가 된)
  .jsonl이 항상 `fileTime >= spawnTime - 2s`를 통과.
- **수정**: `birthtimeMs > 0`이면 birthtime만 사용(NTFS에서 신뢰 가능), 0일 때만 mtime 폴백.
  보조 가드: 디스커버리 시점 파일 크기 작음(< 수 KB) 요구 — 새 트랜스크립트는 거의 빈 파일.

### 1.3 [MED] claimed-set이 await 사이에 낡음 → 같은 cwd 2세션이 동일 트랜스크립트 이중 바인딩/스왑
- claimed-set 계산 `:165-168` → `await fsp.stat` `:177` → 할당 `:185`. await 사이에 다른 세션
  폴러가 끼어들 수 있음.
- **수정**: **할당 직전에 claimed-set 동기 재확인** (Node 단일스레드라 동기 recheck로 창 닫힘).
  스왑 방지: 통과 후보를 모두 모아 **birthtime이 자기 spawnTime에 가장 가까운 것**을 할당.
  (또는 projectDir별 디스커버리 직렬화)

### 1.4 [MED] `/clear` 시 새 세션 id + 새 .jsonl → 메트릭이 옛 파일에 동결
- `metrics.ts:203` — `s.filePath === null`일 때만 바인딩(1회성). 1.1 수정으로 슬로우 폴이 계속 살면
  새 .jsonl 발견 가능해짐.
- **수정**: (a) sessions.ts — 바인딩 후에도 슬로우 폴 유지, 더 새로운 unclaimed .jsonl 발견 시
  `claudeSessionId` 갱신 + onSessions 브로드캐스트. (b) metrics.ts — `track()`에서
  `meta.claudeSessionId`가 현재 `s.filePath`의 stem과 다르면 **리바인드**: 기존 watcher 닫고,
  cumulative 토큰 totals는 보존, byteOffset/seen은 리셋.

**검증**: ① 세션 열고 40초 뒤 첫 프롬프트 → 토큰 잡히는지 ② 같은 cwd 세션 2개 순차 오픈 후 각각
프롬프트 → 메트릭이 각자 것인지 ③ /clear 후 프롬프트 → 토큰 계속 누적되는지.

---

## 테마 2 — 프론트 WS 수명주기 (4곳 소수정, HIGH 3건)

**핵심 파일**: `web/src/ws.ts`, `web/src/main.ts`, `web/src/terminal.ts` · 담당 1명

### 2.1 [HIGH] 토큰 fetch 실패 시 재연결 체인 영구 사망
- `web/src/ws.ts` — 유일한 재시도 트리거가 WS `close` 이벤트. `open()`이 `fetch("/api/token")`에서
  reject하면(서버 재시작 창 = `npm run restart`가 매번 만드는 상황) 소켓 자체가 안 생겨 close 미발생,
  `void open()`이 rejection 삼킴 → 영구 동결. `main.ts:190` 초기 connect()도 동일.
- **수정**: `open()` 본문 전체를 try/catch로 감싸고 실패 시 `setTimeout(() => void open(), 3000)`
  재스케줄. **타이머 중복 스택 방지 가드** 필수. 초기 connect()에도 동일 적용.

### 2.2 [HIGH] 재연결 후 re-attach 없음 → 화면 동결 + 블라인드 타이핑 (안전 문제)
- 서버는 재연결 시 빈 `attached` set의 새 Client 생성(`server/index.ts:126`). 프론트 `hello` 핸들러
  (`main.ts:118`)는 attach 재전송 안 함. 그런데 `input`은 attach 무관하게 살아있는 PTY로 들어감 —
  **안 보이는 셸에 Enter가 들어갈 수 있음**.
- **수정**: `hello` 핸들러에서 살아있는 `terminalIds()` 전체(최소한 활성 세션)에
  `{t:"attach", id}` 재전송. 2.3의 reset과 함께 동작해야 중복 없이 복원됨.

### 2.3 [HIGH] scrollback 재생을 리셋 없이 append → X→Y→X 전환마다 내용 중복 누적
- `main.ts:140` — 'scrollback'과 'pty'가 한 핸들러에서 plain-append. 서버는 attach마다 전체 버퍼
  (최대 256KB) 재전송, `attached` set은 줄어들지 않아 히든 터미널도 이미 같은 내용 보유.
- **수정**: 'scrollback'을 **별도 case로 분리**해 대상 터미널에 `term.reset()` 후 write.
  (이 방식이 2.2의 재연결-재생 경로까지 같이 고침)

### 2.4 [MED] ~12MB 초과 이미지 붙여넣기 → WS maxPayload(16MB) 초과 → 대시보드 전체 끊김
- `web/src/terminal.ts:59` — base64 ×1.33 무검사 단일 프레임 전송. ws는 1009로 연결 종료.
- **수정**: 전송 전 `blob.size > 11 * 1024 * 1024`면 토스트("이미지가 너무 큽니다")로 거부.
  (v2 대안: HTTP POST 업로드 엔드포인트)

**검증**: ① `npm run restart` 하고 대시보드 방치 → 자동 복구 + 터미널 출력 재개 확인
② 세션 A→B→A 전환 반복 → 스크롤백 중복 없는지 ③ 15MB급 이미지 붙여넣기 → 토스트만 뜨고 연결 유지.

---

## 테마 3 — 스크립트/리포트 (독립 수정, 담당 1명)

### 3.1 [MED] reports.ts 타임아웃 kill이 cmd.exe 래퍼만 죽임 → `claude -p` 본체가 쿼터 계속 소진
- `server/reports.ts:198` `shell:true` 스폰, `:205` `child.kill()`. 라이브 실험으로 확인됨.
- **수정**: 타임아웃 시 `sessions.ts:62-65` 패턴 그대로 —
  `execFile('taskkill', ['/T','/F','/PID', String(child.pid)])`. 비-win32는 `child.kill('SIGKILL')`.
  보조: `child.stdin.on('error', () => {})` 추가 (`:221` write의 EPIPE 방어).

### 3.2 [MED] statusline 설치: statusLine 없던 유저에게 `type:"command"` 누락 → tee 미실행
- `scripts/install-statusline-tee.mjs:82` — `{}` 생성 후 `.command`만 설정. Claude Code 스키마는
  `type:"command"` 필수(실 바이너리 대조 확인).
- **수정**: `settings.statusLine = { type: "command", command: TEE_CMD }`.
  statusline-original.json에 "원래 없었음"을 기록해 uninstall이 객체 전체를 삭제하게.
  `:67`의 `cat` 폴백 제거 → 아무것도 출력 안 하는 커맨드로 (`:` 등).

### 3.3 [MED] statusline 설치: 경로 무인용부호 → 공백 포함 홈 경로 전파괴
- `:73-75` 생성 bash의 `>> ${FEED_JSONL_GB}`, `tail ... ${FEED_TMP_GB}`, `:29` `bash ${TEE_SH_GB}`.
  라이브 재현 확인됨.
- **수정**: 생성 스크립트 내 모든 경로 + TEE_CMD의 스크립트 경로를 큰따옴표로 감쌀 것.

### 3.4 [MED] statusline 언인스톨: 현재 값 확인 없이 낡은 백업으로 덮어씀 (+백업 미삭제로 재발)
- `scripts/uninstall-statusline-tee.mjs:64-72`.
- **수정**: 설치기와 같은 로직으로 TEE_CMD 재계산 → `settings.statusLine?.command !== TEE_CMD`면
  "cc-deck tee가 아님 — 복원 생략" 출력 후 무변경 종료. 복원 성공 시 statusline-original.json과
  settings.json.bak을 삭제(또는 `.restored`로 rename).

### 3.5 [MED] autostart: web/dist 미확인 설치 → 로그인마다 404 대시보드
- `scripts/install-autostart.mjs:52` 부근. health는 통과하므로 원인 힌트 0.
- **수정**: 설치 시 `web/dist/index.html` 존재 확인 → 없으면 `npm run build` 실행하거나
  "run npm run build first"로 중단.

### 3.6 [LOW(검증자 강등)] CC_DECK_PORT가 opener엔 박히고 run-server.cmd엔 없음
- `install-autostart.mjs:31,47,61`. 커스텀 포트 설치 시 서버는 4317, opener는 커스텀 포트 폴링.
- **수정**: run-server.cmd에 `set CC_DECK_PORT=${PORT}` 추가. (선택: ~/.cc-deck에 포트 영속화해
  restart.mjs도 동일 값 읽게)

### 3.7 [선택] /api/token Host 헤더 검증 (DNS 리바인딩 심층방어)
- 기각된 발견(WS Origin 체크가 최종 방어로 유효)이지만 한 줄짜리 보강 권장:
  `req.headers.host`가 `localhost:PORT`/`127.0.0.1:PORT`/`[::1]:PORT`가 아니면 403.

**검증**: 스크립트는 설치→언인스톨 왕복 후 settings.json diff가 0인지, 공백 경로 시뮬레이션
(임시 디렉터리)으로 tee 동작 확인.

---

## 기각된 발견 (재발굴 방지용 — 수정하지 말 것)

| 주장 | 기각 사유 |
|------|-----------|
| `::` 바인딩 LAN 노출 | 의도된 설계(index.ts:88-91 주석) + loopback 가드 실효 확인 |
| restart가 무관 프로세스 substring-kill | netstat 정렬/매칭상 실제 재현 불가 |
| restart 1.5s 고정 sleep 불충분 | 현실 시나리오 재현 실패 (commit e1874e3 의도 반영) |
| restart가 dist 재빌드 안 함 | 문서화된 의도(서버 코드 전용 스크립트) |
| 테일러 부분 JSONL 라인 유실 | .claude/CLAUDE.md v2 유예 명시 + 실제 복구됨 |
| gatherToday 메모리/이벤트루프 | 실측 최대 트랜스크립트 9.3MB — 임계 미달 |
| write() 좀비 xterm 누수 | 부활 메커니즘은 있으나 누수는 미재현 |
| WS 리스너 await 후 등록 leak | @fastify/websocket이 자체 error 핸들링 — 심각도 미달 |
| claude 트리 고아화(서버 사망 시) | 경험적으로 반증됨 |
| DNS 리바인딩 토큰 탈취 → 셸 | WS Origin 체크가 차단 (3.7 보강만 권장) |

## 부록 — 미검증 low 아이디어 30건 (별도 회차)

pasteDir 무한 증식/파일명 충돌 · 'idle' 상태 미구현(항상 active) · exited 세션에 input/resize 시 죽은
pty 접근 · 스크롤백 트림이 UTF-8/ANSI 시퀀스 중간 절단 · favorites.json 비원자 쓰기 ·
OAuth fetch 타임아웃 없음/폴 겹침 · 만료 토큰 시 statusline 폴백 건너뜀 · 테일러 fd 누수 가능성 ·
트랜스크립트 축소(truncate) 미처리 · getClaudeVersion execSync 5s 블로킹 · statusline 피드 무회전 ·
리포트에 사이드체인 프롬프트 혼입 · 슬립 시 리포트 스케줄 미스 · summarize()가 CLAUDE_CODE* env 미제거 ·
esc()가 쌍따옴표 미이스케이프 · metricsMap 미정리 · 리포트 버튼 영구 disabled 가능 ·
uninstall 후 빈 statusLine:{} 잔존 · .feed.tmp 동시 접근 레이스 · server.log 매 기동 truncate ·
재시작마다 새 Chrome 탭 · tsx/cross-env가 devDependencies · README 스테일 · resize NaN 미검증 ·
getReport 미스 시 무응답 · 멀티유저 loopback 신뢰 가정 · config.host 데드 코드 · paste 파일 미청소 등.

## 실행 메모

- 팀 구성 제안: Sonnet 3명 (테마 1 / 테마 2 / 테마 3), 파일 겹침 없음 → 병렬 가능.
  단 1.4가 metrics.ts와 sessions.ts 양쪽을 건드리므로 테마 1 담당에게 두 파일 모두 배정.
- 원 리뷰 전체 출력(검증 투표 원문 포함):
  `C:\Users\JWG\AppData\Local\Temp\claude\C--project-cc-deck\874f3575-1cd9-4048-83e0-fc2fe219f0d6\tasks\wqktnstbr.output`
  (세션 임시 디렉터리라 소멸 가능 — 이 문서가 자립본)
