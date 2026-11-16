# ticket-ssu — 콘서트 예매·좌석 관리

Node.js 내장 HTTP 서버·HTML/CSS/JavaScript·로컬 SQLite로 만든 팀프로젝트다. 회원 가입/로그인/탈퇴·공연/회차·좌석 선점·데모 예매/취소·관리자·FIFO 대기열을 단일 API 프로세스로 제공한다. 실제 PG/청구/환불·본인인증·유효한 입장권 발권은 연결하지 않는다.

## 과제 표준 실행 — model 모드

검증 기준은 .node-version의 Node26.13.0이며 최소24.15가 필요하다. 앱 실행에는 외부 패키지 설치나 빌드가 필요 없다. 프로젝트 루트에서 실행한다.

팀원은 초대받은 GitHub 계정으로 비공개 저장소 초대를 수락한 뒤, PC의 원하는 상위 폴더에서 처음 한 번 가져온다. 계정 암호·토큰을 clone URL이나 채팅에 넣지 않는다.

```powershell
git clone https://github.com/rest-point/ticket-ssu.git
cd ticket-ssu
node --version
```

이미 clone한 폴더는 로컬 변경을 확인하고 `git pull --ff-only`로 갱신한다. 각 PC는 예시 환경 파일로 자신의 DB를 생성한다. 다른 PC의 실제 .env·DB·WAL/SHM을 복사해 공유하지 않는다.

```powershell
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
npm run start:local
```

[http://127.0.0.1:3000](http://127.0.0.1:3000)에서 공연→회차→로그인→좌석 선택→데모 결제→나의 티켓→취소를 이용한다. 로컬 데모는 로그인 화면의 일반 회원/관리자 자동 입력을 제공한다. 정상 종료는 Ctrl+C다.

로컬 기본 계정은 일반 회원 `demo@ticket-ssu.local` / `TicketSsuDemo123!`, 관리자 `admin@ticket-ssu.local` / `TicketSsuAdmin123!`다. 프로젝트명 변경 전 데모 계정은 같은 회원 ID로 새 주소로 전환한다. 기존 기본 비밀번호만 새 기본값으로 바꾸며 사용자가 지정한 비밀번호와 이름은 유지한다. 예매·결제·선점·회원 ID는 보존한다. 쿠키 이름이 ticket_ssu_session으로 바뀌었으므로 브라우저/Postman에서 다시 로그인한다. 새 이름과 이전 이름 계정이 동시에 있으면 병합하지 않고 시작을 중단한다.

일반 회원은 상단 계정 관리에서 현재 비밀번호와 동의 확인 후 탈퇴한다. 시작 전 확정 예매는 먼저 취소해야 하며 관리자는 탈퇴할 수 없다. 모든 세션·대기열·선점을 해제하고 회원/예매자 정보를 비식별화한다. 예매·결제 이력은 보존하며 같은 이메일 재가입은 새 회원이다. 직접 가입한 가상 회원으로 검증한다. 로컬 기본 데모 계정은 재시작 시 없으면 다시 생성된다.

팀원은 같은 .env.example을 사용한다. 이미 .env가 있다면 덮어쓰지 말고 아래 설정을 대조한다. model 모드에서 기존 legacy DB를 그대로 지정하지 않는다.

```powershell
# 서버를 실행한 채 별도 터미널에서:
npm run status
```

status의 schema_version=1이 과제 ERD와 같은 model 모드다. 0이면 legacy 실행이므로 종료 후 설정을 확인한다. POSIX에서는 test -e .env || cp .env.example .env 후 같은 npm 명령을 쓴다. 셸 환경변수가 파일보다 우선하므로 이전 DB_SCHEMA/DB_PATH/NODE_ENV 등이 남아 있으면 정리한다.

다른 PC의 실행 확인은 Node 버전·schema_version=1·브라우저 로그인→선점→데모 예매→조회→취소·Ctrl+C 종료까지 수행한다. 실패를 공유할 때는 OS/Node 버전·실행 명령·민감값을 제거한 오류만 전달한다. 원격 CI 통과와 팀원 PC의 실제 실행 완료는 구분한다.

| 설정 | 기본값/용도 |
| --- | --- |
| HOST / PORT | 127.0.0.1 / 3000 |
| DB_PATH / DB_SCHEMA | 과제 표준 .env: data/team-local.sqlite / model. 기존 DB를 복사/초기화하지 않음 |
| DEMO_MODE | 기본 true. false이면 공개 데모 계정 생성/자동 입력을 사용하지 않음 |
| NODE_ENV | production이면 Secure 쿠키·DEMO_MODE=false·HTTPS/인증 프록시 필수 |
| TICKET_SSU_ADMIN_EMAIL / TICKET_SSU_ADMIN_PASSWORD | 전용 관리자 쌍. 신규 생성/기존 계정 보호, 재사용하지 않는10~128자 암호 |
| SHUTDOWN_TIMEOUT_MS | 기본10000ms. 종료 시 기존 요청 대기 예산 |
| QUEUE_* / LIMIT_* | [API 명세](docs/design/api.md)의 정원·입장률·IP/회원/인증 예산과 상한 |

legacy는 기존 저장 모델, model은 별도의 새/이관 DB에 명시적으로 선택하는 정규화 모델이다. 잘못된 모드/버전 조합과 model의 기본 운영 경로는 거부한다. 모드 변경으로 기존 DB를 자동 이관하지 않는다. 파일 DB는 로컬 디스크에 두고 DB/WAL/SHM·기존 계정/예매를 보존한다. 네트워크 공유 DB나 다중 API 배포는 지원하지 않는다.

환경변수 없는 npm start/node server.mjs는 호환용 legacy(data/ticket-ssu.sqlite) 기본값이다. npm run dev도 .env를 읽지 않는다. 과제 개발 중 자동 재시작은 `node --watch --env-file=.env server.mjs`를 사용한다. 기존 .env.tunnel과 외부 시연 DB는 로컬 표준 환경과 별도로 유지한다.

## 업무 정책

선점7분·선택 변경으로 만료 연장 없음·확정 포함 회차당4매·장당 수수료2,000원·서버 금액 계산을 적용한다. 공연 시작 전 전액 취소하고 이력은 보존한다. 묶음 선점/확정/취소는 SQLite 트랜잭션에서 전부 성공하거나 롤백한다. 모델/현재 API의 상세 계약은 아래 문서에 둔다.

관리자가 공연을 등록할 때는 모든 회차가 서버의 등록 시점부터 최소 24시간 뒤에 시작해야 한다. 한 회차라도 기준에 미달하거나 공연 정보와 전체 회차가 동일하면 등록을 거부한다. 예매 오픈 일시는 첫 회차 시작 전으로 지정하며, 비우면 등록 즉시 오픈한다. 오픈 전에는 대기열 진입·신규 선점·예매 확정을 막는다.

## HTTPS 시연

Windows x64에서 고정 cloudflared를 프로젝트 전용 .tools에 설치한다. 계정·도메인·공유기 포트 개방 없이 시연 중에만 임시 URL을 발급한다.

```powershell
npm run setup:tunnel
if (-not (Test-Path -LiteralPath .env.tunnel)) { Copy-Item -LiteralPath .env.tunnel.example -Destination .env.tunnel }
# 로컬 편집기로 전용 관리자 이메일/암호를 채운 뒤:
npm run start:tunnel
```

tunnel-ready의 origin으로 접속한다. .env.tunnel.example은 production·DEMO_MODE=false·별도 model DB·loopback API3000/중계3001을 사용한다. 실제 환경/암호는 출력하거나 커밋하지 않는다. PUBLIC_ORIGIN/PROXY_TOKEN은 실행기가 매번 메모리에서 생성하므로 직접 설정하지 않는다. 실제 .env.tunnel과 전용 DB는 재실행에도 보존한다.

같은 작업 폴더에서 새로 시작하면 로컬과 터널 모두 현재 소스의 예매·관리자 기능을 사용한다. 터널 주소에서는 터널용 관리자 계정으로 로그인한다. 두 기본 설정이 API 포트 3000을 사용하므로 동시에 실행하려면 API 포트를 분리한다.

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
| [docs/design/api.md](docs/design/api.md) | 현재 25작업·인증/입출력/오류·정합성·상태·멱등성·대기열/요청 제한 |
| [docs/design/crud-matrix.md](docs/design/crud-matrix.md) | API별 테이블 CRUD·권한·트랜잭션 경계 |
| [docs/design/service-improvements.md](docs/design/service-improvements.md) | 서비스 문제·개선 구현·장단점·통제 실험·한계·Notion 팀 논의 방식 |

기계 명세는 [docs/openapi.yaml](docs/openapi.yaml)에 있다. 예매 오픈·관리자 대리 취소·회원 제한·회차 판매 상태를 포함한 DDL 목록은 [물리 데이터 모델](docs/data-model/physical.md)의 마이그레이션 표에서 확인할 수 있다.

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

Postman 앱에는 아래 JSON 2개를 import한다. 사용자가 업로드한 New Collection/New Environment와 같은 **폴더 없는 평면 목록**이며 기존 요청 이름·순서를 유지하고 회차 판매 관리를 목록 끝에 추가했다. API 25개가 각각 한 번씩 있고, Method·URL 객체·Headers·raw JSON·예시 응답을 채웠다.

| import할 파일 | 용도 |
| --- | --- |
| [postman/ticket-ssu.team.postman_collection.json](postman/ticket-ssu.team.postman_collection.json) | 원본 양식의 API 요청 25개 |
| [postman/environments/team.local.postman_environment.json](postman/environments/team.local.postman_environment.json) | baseUrl·email/password·토큰/ID 변수 |

1. 평소처럼 npm run start:local로 서버를 실행하고 두 파일을 Import한다. 환경은 **ticket-ssu local**, baseUrl은 **http://127.0.0.1:3000**이다. Cookie Jar를 켠다. 별도 데모 DB에서 테스트하려면 npm run start:postman을 실행하고 baseUrl만 http://127.0.0.1:3100으로 바꾼다.
2. 개인 환경의 email/password에 테스트 계정을 입력한다. 신규 가입은 중복되지 않는 가상 정보를 넣고 signup을 Send한다. 기존 계정은 login을 Send한다. 로그인 상태가 남아 있으면 login state로 CSRF를 먼저 받는다. 계정 값은 공유 JSON에 넣지 않는다.
3. concert list → seat search로 회차·좌석을 확인한다. performanceId/seatId가 비어 있으면 응답에서 자동 저장하며 원하는 값을 직접 지정해도 된다.
4. 예매는 queue enter → queue state(admitted 확인) → seat preempt → booking confirm → booking list 순서로 Send한다. CSRF·입장권·holdId·bookingId는 응답 스크립트가 저장한다. 429는 Retry-After 뒤 다시 시도한다.
5. booking cancel로 취소하고 queue out으로 이탈한다. 선점만 해제하려면 seat preempt의 seatIds를 빈 배열로 바꾼다. queue out은 선점을 취소하지 않으므로 선점/결제 전에 호출하지 않는다.
6. 관리자는 logout 후 개인 환경의 email/password를 관리자 계정으로 바꾸고 같은 login을 Send한다. `concert add`의 `futureDate`는 비어 있으면 30일 뒤로 채워진다. 예약 오픈을 확인하려면 `bookingOpensAt`에 시간대를 포함한 ISO 8601 시각을 입력한다. 비워 두면 즉시 오픈한다. 생성 후 `concert list`로 회차를 선택한다. `seat block`에서 `blocked: false`는 좌석 차단 해제다.
7. 회원 탈퇴는 본인 일반 회원으로 로그인한 상태에서 account delete를 Send한다. 시작 전 확정 예매는 먼저 취소한다. 관리자는 탈퇴할 수 없다.
8. 고객 요청에 따른 대리 취소는 관리자 화면의 **회원 예매 취소**에서 예매번호로 조회한 뒤 공연·회차·좌석을 확인하고 진행한다. Postman에서는 관리자 로그인 후 `bookingId`를 설정하고 `admin booking lookup` → `admin booking cancel`을 Send한다. 실제 고객 요청을 확인했을 때만 시작 전 예매 건 전체를 취소한다. 회원은 **나의 티켓**에서 취소 사유를 확인한다.
9. 관리자 화면의 **회원 예매 제한**에서 대상 이메일과 처리 사유를 확인해 제한하거나 해제한다. 적용하면 대기열·선점이 해제되고 새 예매가 막힌다. 기존 확정 예매의 조회·본인 취소는 가능하다. Postman에서는 `restrictionEmail`을 채워 `admin member lookup`을 Send한 뒤 `restrictionReason`을 입력하고 `admin member restriction`을 Send한다. 해제할 때는 본문의 `restricted`를 `false`로 바꾼다.
10. 관리자 **좌석 판매 관리**에서 선점·예매 좌석을 누르면 점유 회원을 확인할 수 있다. 확정 좌석은 **취소 화면에서 예매 확인**으로 연결된다. Postman에서는 `performanceId`와 `seatId`를 설정한 뒤 `admin seat occupant`를 Send한다.
11. 관리자 **공연 판매 및 취소**에서 대상 회차, 처리 방식, 사유를 선택한다. 판매 중단은 확정 예매를 유지하고 판매 재개가 가능하다. 최종 취소는 회차를 공개 목록에서 숨기고 기존 예매를 모두 취소한다. Postman에서 `admin search`로 최신 값을 조회한 뒤 `admin performance sales`의 `targets`에 회차 ID를 `performance_id`로, `sale_revision`을 `revision`으로, 확정 예매 건수를 `booking_count`로 입력한다. `action`에는 `pause`, `resume`, `cancel` 중 하나를 선택하고 `reason`을 입력한다. 최종 취소는 전용 테스트 회차에서 확인한다.

목록은 원본 배치이므로 전체 Run 순서가 아니다. 요청을 골라 Send한다. URL은 요청 상단, 입력은 Body → raw → JSON, 출력 예시는 요청의 Examples에서 확인한다. 자동 회원 생성·추가 관리자 로그인 요청·중복 검증용 요청·폴더 분류는 공유판에서 제외했다. 실제 계정/쿠키가 채워진 개인 환경을 export해 공유하지 않는다. 수정 시 postman/team-build.mjs를 바꾸고 npm run build:postman을 실행한다.
자동 회귀/외부 소수 요청 smoke용은 [postman/ticket-ssu.postman_collection.json](postman/ticket-ssu.postman_collection.json)이다. 전체 회귀는 25개 API를 64개 요청으로 검증한다. 로컬 전용 시나리오에는 좌석 점유 조회, 대리 취소, 회원 제한·해제, 중복 등록·24시간 기준, 예약 오픈 전 차단, 회차 판매 중단·재개·최종 취소가 포함된다. staging에서는 이미 예매가 열린 미래 회차와 전용 일반 회원·빈 좌석을 지정해 Booking smoke 폴더만 실행한다. 본인 전용 가상 환경에만 `allowWrite=dedicated-demo`를 설정하고, 실제 자격증명은 공유 파일에서 제외한다.

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

팀 작업은 기능별 브랜치에서 커밋하고 PR로 검토한다. PR에는 변경 기능·실행한 검증·미검증 사항을 적고 CI가 성공한 상태에서 병합한다. 초대 수락·저장소 접근·실행 결과는 각 팀원의 계정과 PC에서 확인한다.

DB·WAL/SHM·백업·실제 .env/비밀값·설치 도구·node_modules·개인 실행 결과는 Git 제외 대상이다. 단일 서버·로컬 SQLite 범위를 유지하며 Docker·외부 DB/캐시/브로커·다중 API·실제 결제는 포함하지 않는다. UI 전면 접근성·장시간 운영 용량·실제 장애 복구 시간은 보장하지 않는다.

## Postman API 테스트와 팀 논의

팀원은 아래 팀원용 컬렉션과 로컬 환경 JSON을 함께 Import해 API 동작을 확인합니다. 서비스 문제와 개선 내용은 Notion에서 함께 정리합니다.

- [팀원용 컬렉션 JSON — 평면 25개 요청](postman/ticket-ssu.team.postman_collection.json)
- [로컬 환경 JSON](postman/environments/team.local.postman_environment.json)
- [자동 회귀용 컬렉션 JSON — 64개 요청](postman/ticket-ssu.postman_collection.json)

1. 팀원용 컬렉션과 로컬 환경 파일의 GitHub 화면에서 **Download raw file**을 눌러 JSON 파일을 다운로드합니다.
2. Postman 앱에서 **Import → Files**를 선택하고 컬렉션과 환경 JSON을 함께 가져옵니다.
3. 오른쪽 위 환경 선택에서 **ticket-ssu local**을 선택합니다. 로컬 서버를 실행하고 `baseUrl`이 `http://127.0.0.1:3000`인지 확인합니다.
4. 개인 환경의 `email`과 `password`를 입력하고 `signup` 또는 `login` 요청을 **Send**합니다. Cookie Jar를 켜 두면 로그인 쿠키가 유지되며, CSRF·입장권·선점/예매 ID는 응답에서 자동 저장됩니다.
5. 예매 확인은 `concert list` → `seat search` → `queue enter` → `queue state`에서 `admitted` 확인 → `seat preempt` → `booking confirm` 순서로 진행합니다. 취소는 `booking cancel`입니다. 목록 전체를 Run하기보다 필요한 요청을 순서대로 골라 Send합니다.

서비스에서 예상되는 문제와 대응 방법은 [Notion 문제 처리 보드](https://app.notion.com/p/ticket-ssu-40e4f5bda5d381e3b27fff9ec95f7997#ba7b123123ec46f5b5e14dc6d08e2257)에서 확인하고 논의합니다.
