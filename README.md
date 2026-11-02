# Temp — 콘서트 예매·좌석 관리

Node.js 내장 HTTP 서버·HTML/CSS/JavaScript·로컬 SQLite로 만든 팀프로젝트다. 회원·공연/회차·좌석 선점·데모 예매/취소·관리자·FIFO 대기열을 단일 API 프로세스로 제공한다. 실제 PG/청구/환불·본인인증·유효한 입장권 발권은 연결하지 않는다.

## 실행

검증 기준은 .node-version의 Node26.13.0이며 최소24.15가 필요하다. 앱 실행에는 외부 패키지 설치나 빌드가 필요 없다. 프로젝트 루트에서 실행한다.

```powershell
npm start
```

[http://127.0.0.1:3000](http://127.0.0.1:3000)에서 공연→회차→로그인→좌석 선택→데모 결제→나의 티켓→취소를 이용한다. 로컬 데모는 로그인 화면의 일반 회원/관리자 자동 입력을 제공한다. 개발은 npm run dev, 정상 종료는 Ctrl+C다.

npm start는 .env를 읽지 않는다. 팀원 환경은 기존 파일을 덮어쓰지 않고 예시를 준비한다.

```powershell
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
npm run start:local
# 별도 터미널:
npm run status
```

POSIX에서는 test -e .env || cp .env.example .env 후 같은 npm 명령을 쓴다. 셸 환경변수가 환경 파일보다 우선한다.

| 설정 | 기본값/용도 |
| --- | --- |
| HOST / PORT | 127.0.0.1 / 3000 |
| DB_PATH / DB_SCHEMA | data/temp.sqlite / legacy. .env.example은 별도 data/team-local.sqlite / model |
| DEMO_MODE | 기본 true. false이면 공개 데모 계정 생성/자동 입력을 사용하지 않음 |
| NODE_ENV | production이면 Secure 쿠키·DEMO_MODE=false·HTTPS/인증 프록시 필수 |
| TEMP_ADMIN_EMAIL / TEMP_ADMIN_PASSWORD | 전용 관리자 쌍. 신규 생성/기존 계정 보호, 재사용하지 않는10~128자 암호 |
| SHUTDOWN_TIMEOUT_MS | 기본10000ms. 종료 시 기존 요청 대기 예산 |
| QUEUE_* / LIMIT_* | [API 명세](docs/design/api.md)의 정원·입장률·IP/회원/인증 예산과 상한 |

legacy는 기존 저장 모델, model은 별도의 새/이관 DB에 명시적으로 선택하는 정규화 모델이다. 잘못된 모드/버전 조합과 model의 기본 운영 경로는 거부한다. 모드 변경으로 기존 DB를 자동 이관하지 않는다. 파일 DB는 로컬 디스크에 두고 DB/WAL/SHM·기존 계정/예매를 보존한다. 네트워크 공유 DB나 다중 API 배포는 지원하지 않는다.

## 업무 정책

선점7분·선택 변경으로 만료 연장 없음·확정 포함 회차당4매·장당 수수료2,000원·서버 금액 계산을 적용한다. 공연 시작 전 전액 취소하고 이력은 보존한다. 묶음 선점/확정/취소는 SQLite 트랜잭션에서 전부 성공하거나 롤백한다. 모델/현재 API의 상세 계약은 아래 문서에 둔다.

## HTTPS 시연

Windows x64에서 고정 cloudflared를 프로젝트 전용 .tools에 설치한다. 계정·도메인·공유기 포트 개방 없이 시연 중에만 임시 URL을 발급한다.

```powershell
npm run setup:tunnel
if (-not (Test-Path -LiteralPath .env.tunnel)) { Copy-Item -LiteralPath .env.tunnel.example -Destination .env.tunnel }
# 로컬 편집기로 전용 관리자 이메일/암호를 채운 뒤:
npm run start:tunnel
```

tunnel-ready의 origin으로 접속한다. .env.tunnel.example은 production·DEMO_MODE=false·별도 model DB·loopback API3000/중계3001을 사용한다. 실제 환경/암호는 출력하거나 커밋하지 않는다. PUBLIC_ORIGIN/PROXY_TOKEN은 실행기가 매번 메모리에서 생성하므로 직접 설정하지 않는다. 실제 .env.tunnel과 전용 DB는 재실행에도 보존한다.

Cloudflare가 HTTPS를 종단하고 노트북까지 암호화된 터널로 연결한다. URL은 인터넷 공개 주소이며 같은 Wi-Fi 한정이나 중계 사업자도 볼 수 없는 암호화가 아니다. 사용자 IP는 검증하지 않아 공유 IP 예산을 유지한다. 로그인/가입은 기본 전체30회/10분, 일반 요청은 burst120/초당30이며 회원별 제한도 유지한다.429의 Retry-After를 따른다.

QUIC/http2는 외부 UDP/TCP7844를 사용하며 http2도 TCP7844가 필요하다. 종료는 Ctrl+C 후 cleanupPassed=true와 기존 URL의 API 차단을 확인한다. 정상 종료는 예매 취소나 DB 삭제가 아니다. 강제 종료/전원 장애 시 정리를 보장하지 않는다. 터널에 대량 부하를 보내지 않는다.

## 백업·복원

실행 중인 DB 본 파일만 복사하지 않고 WAL 커밋을 포함하는 온라인 스냅샷을 사용한다. 다음은 경로 예시이며 매번 새 출력 이름을 사용한다.

```powershell
New-Item -ItemType Directory -Path data/backups -Force
npm run db:backup -- backup data/tunnel-demo.sqlite data/backups/snapshot.sqlite
npm run db:backup -- verify data/backups/snapshot.sqlite
npm run db:backup -- restore data/backups/snapshot.sqlite data/restored-candidate.sqlite
```

원본/백업/기존 후보를 덮어쓰지 않는다. 복원은 새 후보를 만들며 자동 운영 전환은 하지 않는다. 실제 전환은 API 정상 종료 후 별도 DB_PATH/DB_SCHEMA로 시작해 readiness·세션/금액/예매를 확인한다. 후보에 새 쓰기가 생긴 뒤 원본으로 자동 회귀하지 않는다. 백업에는 세션/개인정보/암호 해시가 포함되므로 접근 권한과 비공개 보관을 관리한다.

## 과제 문서와 명세

| 문서 경로 | 명세·내용 |
| --- | --- |
| [docs/data-model/conceptual.md](docs/data-model/conceptual.md) | 개념 ERD·업무 엔터티/관계·카디널리티·업무 규칙 |
| [docs/data-model/logical.md](docs/data-model/logical.md) | 릴레이션·도메인·후보키/PK/FK·NULL·교차 제약 |
| [docs/data-model/normalization.md](docs/data-model/normalization.md) | FD·1NF~3NF·무손실 분해·종속성 보존 |
| [docs/data-model/physical.md](docs/data-model/physical.md) | SQLite DDL·자료형·인덱스·데이터 사전·보존 이관 |
| [docs/design/api.md](docs/design/api.md) | 현재18작업·인증/입출력/오류·정합성·상태·멱등성·대기열/요청 제한 |
| [docs/design/crud-matrix.md](docs/design/crud-matrix.md) | API별 테이블 CRUD·권한·트랜잭션 경계 |

기계 명세는 [docs/openapi.yaml](docs/openapi.yaml), 실제 DDL은 [001_model.sql](db/migrations/001_model.sql)·[001_guards.sql](db/migrations/001_guards.sql)이다. 현재 API만 명세하며 미구현 계획용 명세/작업 계획/과거 검증 보고서는 제출 문서에서 제외했다.

## 검증 명령

기본 검사와 핵심 회귀는 메모리/새 임시 DB를 사용한다.

```powershell
npm run check
npm run check:api
npm run check:model
npm test
```

Postman 도구는 앱과 분리한 postman/runner/package-lock.json에 고정한다. 현재 명세로 컬렉션을 생성하고 두 모드의 실제 요청·권한·금액·보존/정리를 검증한다.

```powershell
npm run setup:postman
npm run check:postman
npm run verify:postman
# API/컬렉션 변경 후에만:
npm run build:postman
```

GUI에서는 postman/temp-ticket.postman_collection.json과 environments 예시를 import한다. 실제 자격증명은 공유 파일에 저장하지 않고 Cookie Jar를 사용한다. staging은 전용 일반 회원/미래 회차/빈 좌석을 지정한 Booking smoke 폴더만 실행한다. 본인 전용 가상 환경에만 allowWrite=dedicated-demo를 설정한다. 리다이렉트/인증서 검증을 우회하지 않는다.

실제 HTTPS의 소수 요청 smoke는 .env.smoke.example을 기존 파일을 보존하며 준비하고 새 SMOKE_ORIGIN·전용 일반 회원/회차/좌석을 로컬에서 채운 뒤 npm run verify:external:env로 실행한다. 관리자/공개 데모 계정·기존 선점/확정 예매/큐를 거부한다. 수동 시연과 같은 계정을 동시에 사용하지 않는다. manualReviewRequired이면 본인 내역을 확인하고 새로 만든 상태만 정리한다. 자동 보고서의 externalNetworkVerified=false는 별도 망 접속 증명이 아니다.

Windows x64의 실제 부하는 별도 k6 프로세스와 새 SQLite·단일 loopback API를 사용한다.

```powershell
npm run setup:k6
node load-tests/k6-runner.mjs --schema model --profile race
# 두 모드 전체7프로필씩:
npm run verify:k6
# 같은 프로세스 HTTP/메모리 진단:
npm run verify:traffic
```

프로필은 race·ticket-cap·queue·read-control·read-current·mixed-default·busy다. 짧은 같은-PC 진단이며 실제 LAN/지속 운영 용량을 보장하지 않는다. 로그인 세션은 사전 준비한다. 결과는 Git 제외 test-results/k6/·test-results/traffic/에 배타 생성한다. docs에는 결과 파일을 다시 쌓지 않는다. DB 쿼리 계획은 node db/benchmark.mjs로 별도 재현한다.

## 저장소 구성

server.mjs·lib/는 API/SQLite/큐·보안, public/은 화면, db/는 DDL/seed/이관·백업, scripts/는 실행/명세 검사, tests/·postman/·load-tests/는 재현 가능한 검증 코드다. .github/workflows/ci.yml은 Ubuntu/Windows의 구문·API/모델·핵심·Newman 검증을 실행한다. 실제 원격 실행 여부는 GitHub의 실행 결과로 확인한다.

DB·WAL/SHM·백업·실제 .env/비밀값·설치 도구·node_modules·개인 실행 결과는 Git 제외 대상이다. 단일 서버·로컬 SQLite 범위를 유지하며 Docker·외부 DB/캐시/브로커·다중 API·실제 결제는 포함하지 않는다. UI 전면 접근성·장시간 운영 용량·실제 장애 복구 시간은 보장하지 않는다.
