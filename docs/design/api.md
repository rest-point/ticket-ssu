# HTTP API 명세

[현재 OpenAPI](../openapi.yaml)는15경로/18작업의 실행 계약이다. 파라미터·요청/응답 예시·필드 스키마·상태코드는 이 파일을 Postman 등에서 읽어 확인한다. [CRUD](crud-matrix.md)·[물리 모델](../data-model/physical.md)과 함께 사용한다. 기본 legacy와 별도 DB_SCHEMA=model은 같은 현재 경로/공개 ID/JSON을 제공하며 기존 DB를 자동 이관하지 않는다.

## 공통 계약

- 기본 출처는 http://127.0.0.1:3000이다. 모든 API JSON은 Cache-Control: no-store를 사용한다. 금액은 원 단위 정수, 시각은 UTC epoch milliseconds이고 화면은 Asia/Seoul이다.
- temp_session 쿠키로 인증한다. GET /api/session의 user·csrf는 익명이면 null이다. 쿠키는 HttpOnly·SameSite=Lax·Path=/·7일이며 production에서는 Secure를 추가한다. 재로그인은 기존 세션을 교체하고 로그아웃은 해당 세션과 쿠키를 만료시킨다.
- 유효한 세션의 모든 변경 요청은 X-CSRF-Token을 요구한다. 로그인한 상태의 가입/로그인도 포함한다. 변경 Origin은 현재 출처와 같아야 하고 Sec-Fetch-Site: cross-site는 거부한다. Origin 없는 클라이언트도 CSRF를 검사한다.
- 공개 모드는 PUBLIC_ORIGIN·정확한 loopback peer·비밀 PROXY_TOKEN·Host를 검사한다. 표준 전달 헤더는 신뢰하지 않는다. Quick Tunnel 중계는 외부 전달 헤더를 제거하고 실행 중 발급 출처/토큰을 연결한다. 실제 사용자 IP를 검증하지 않아 모든 터널 사용자가 공유 IP 예산을 쓴다.
- JSON 본문은 application/json의 객체이며 최대16KiB다. 정상 입력의 스키마와 달리 현재 서버에는 일부 타입 변환/추가 속성 무시가 남아 있다. 클라이언트 금액이나 role은 가격/권한을 결정하지 않는다. 명세를 런타임 검증 미들웨어로 사용하지 않는다.
- ID는 문자열이다. 경로 값은 URL 인코딩하되 현재 라우터는 임의 구분자/특수문자 ID의 왕복을 보장하지 않는다. 전화번호 구분자 제거 등 입력 정규화는 서버가 수행한다.

## 회원·공연·예매·관리자

| operationId | Method / URL | 권한·소유권 | 성공·핵심 검증 |
| --- | --- | --- | --- |
| getSession | GET /api/session | 공개, 쿠키 선택 | 200. user / csrf / demo |
| signup | POST /api/auth/signup | 익명 가능; 기존 세션이면 CSRF | 201. 이메일 trim/소문자·중복, 이름 2~40자, 전화 형식, 비밀번호 10~128자, terms/ageConfirmed=true |
| login | POST /api/auth/login | 익명 가능; 기존 세션이면 CSRF | 200. scrypt 검증, 기존 쿠키 세션 삭제 후 새 쿠키/CSRF |
| logout | POST /api/auth/logout | 로그인·CSRF | 200 {ok:true}. 해당 세션 삭제·쿠키 만료 |
| listConcerts | GET /api/concerts | 공개 | 200. 회차·잔여석·최저가. 검색/지역/정렬은 브라우저 수행 |
| getSeats | GET /api/performances/{performanceId}/seats | 공개, 본인 선점 표시만 세션 사용 | 200. performance / seats / hold / server_now / max_tickets=4. 회차 없음 404 |
| replaceHold | PUT /api/performances/{performanceId}/hold | 로그인·CSRF·본인 | 200. 중복 없는 문자열 0~4개, 확정 포함 4매, 마감·충돌 검사. 빈 배열은 해제 |
| createBooking | POST /api/bookings | 로그인·CSRF·본인 hold | 201. 이름·전화·수령 방식·동의·demo 검증. 유효 선점·마감·서버 금액. 기존 결과 재반환도 201 |
| listBookings | GET /api/bookings | 로그인·본인 내역 | 200. 확정·취소 포함. 개별 GET /api/bookings/{id}는 없음 |
| cancelBooking | POST /api/bookings/{bookingId}/cancel | 로그인·CSRF·본인 예매 | 200. 최초 취소는 시작 전, 전액·이력 보존. 반복 취소도 기존 결과 |
| adminSummary | GET /api/admin/summary | 관리자 | 200. confirmed 판매 합계·회원 수·회차 상태·최근 감사 15개 |
| createConcert | POST /api/admin/concerts | 관리자·CSRF | 201 {id}. 필수 문자열·1~10개 다른 미래 일시(시간대 명시)·S 가격 정수 1,000~1,000,000원. 회차별 96석 원자 생성 |
| blockSeats | PATCH /api/admin/performances/{performanceId}/seats | 관리자·CSRF | 200 {updated}. 1~96개 중복 없는 좌석·boolean blocked. 선점/예매 좌석 거부·묶음 롤백 |

## 큐·상태 확인

| operationId | Method / URL | 인증·검증·응답 |
| --- | --- | --- |
| enterQueue | POST /api/v1/performances/{performanceId}/queue | 로그인·CSRF. 본문 생략 또는 {}로 일반 진입, {resumeHoldId}로 본인 유효 hold 복구. 200 본인 QueueStatus, 404 회차 없음, 409 복구 불가, 429 상한/요청 제한 |
| getQueue | GET /api/v1/performances/{performanceId}/queue | 로그인·본인 항목. 200 상태·순번·앞선 인원·추정 시간·입장권, 404 항목 없음. 메모리 조회이며 다른 회원 상태는 노출하지 않음 |
| leaveQueue | DELETE /api/v1/performances/{performanceId}/queue | 로그인·CSRF·본인 항목. 200 {ok:true}, 반복 성공. 유효 DB hold를 자동 취소하지 않음 |
| health | GET /api/v1/health | 공개. 200 {status:"ok"}. 프로세스 생존만 확인, DB 쓰기/상세 경로 노출 없음 |
| readiness | GET /api/v1/readiness | 공개. 초기화 후 선택 스키마(legacy=0/model=1)·FK 설정·users 읽기 가능 시 200 {status:"ready",schema_version}. 종료 중/실패 503 {error,code:"NOT_READY"}·Retry-After: 1. 쓰기·전체 integrity_check 없음 |

health/readiness GET은 세션·일반 예산·CSRF·입장권과 독립적이다. readiness는 선택 스키마 버전·FK 설정·users 읽기를 확인하며 매 요청의 전체 무결성 검사나 쓰기 가능/디스크 여유를 보장하지 않는다.

## 예매 정책·상태·원자성

선점은7분이며 선택 변경으로 만료가 연장되지 않는다. 현재 PUT은 같은 좌석 집합에도 새 hold ID를 반환한다. 이전 hold는 released, 만료는 expired, 확정은 converted로 전환하고 본인 조회의 selected는 held 좌석 표시다. 응답을 잃으면 결제 전에 최신 본인 hold를 조회한다.

확정 예매와 유효 선점을 합해 회원/회차당 최대4매다. 장당 수수료2,000원과 좌석 가격은 서버가 계산한다. confirmed 예매는 공연 시작 전 전체 취소만 가능하며 cancelled 뒤 재결제해 되살리지 않는다. 취소 시 현재 점유를 해제하고 항목·원래 가격/등급/수수료·취소 시각은 보존한다. 반복 취소는 기존 결과이며 판매 집계는 confirmed만 포함한다. 최초 선점/확정/취소는 공연 시작 시각 이상이면 거부한다.

선점·확정·취소·차단은 짧은 BEGIN IMMEDIATE에서 소유권·현재 시각·회차/공연장·가용 좌석·확정 포함4매를 재검증한다. 묶음은 전부 성공하거나 전부 롤백한다. SQLite가 판매의 최종 원본이며 큐/화면 상태로 DB 검사를 대체하지 않는다. 현재 재고의 소유자만 하나이고 취소/재판매의 과거 항목은 여러 건 보존할 수 있다. 관리자 차단은 가용 좌석만 허용한다.

공연/좌석/관리자 읽기는 BEGIN+SELECT 스냅샷에서 만료를 논리적으로 제외한다. 물리 만료는5초 배치와 쓰기 트랜잭션에서 수행한다. API의 busy_timeout은25ms이며 BUSY에만 최초 포함 최대4회, 20/40/80ms+0~9ms jitter의 비동기 백오프를 적용한다. 매 시도에 세션/CSRF·시각·입장권·DB 상태를 재검증하고 연결 중단 때 늦은 쓰기를 막는다. 350ms는 재시도 중단 판단 기준이며 동기 native 호출·OS/루프 지연을 포함한 HTTP 상한이 아니다. 소진하면503/Retry-After: 1이다. 한 Node 프로세스의 동기 DB 구간은 직렬이며 다중 API/장시간 용량을 보장하지 않는다.

## 중복 확정과 model 선택 키

헤더 없는 기존 호출은 hold_id UNIQUE로 같은 예매를 재사용하고201을 반환한다. 취소 후 재시도도 cancelled인 기존 예매/원본 금액을 반환하며 추가 점유/청구를 만들지 않는다. 이 호환 호출은 변경된 유효 예매자 본문에도 기존 결과를 반환할 수 있다.

model의 POST /api/bookings만 선택 Idempotency-Key를 지원한다. 공백 없는 ASCII1~128자이며 legacy-checkout은 예약한다. legacy 모드에 키를 보내면400이다. 키는 본인 hold 범위의 (hold_id,request_key)로 묶인다.

1. 유효 입력을 [holdId, buyerName.trim(), 하이픈/공백을 제거한 buyerPhone, delivery, "demo", true] 순서 JSON의 UTF-8 SHA-256으로 정규화한다. 원문 본문은 저장하지 않는다.
2. 같은 키/해시는 예매의 현재 상태 또는 영속 업무 실패를 재사용한다. 같은 키/다른 해시는409이고 기록을 덮어쓰지 않는다. 다른 키/같은 hold도 기존 성공 해시와 같아야 재사용한다.
3. 신규 성공은 hold 전환·예매/항목·현재 점유·성공 시도를 함께 커밋한다. 업무 실패는 예매 변경을 롤백한 뒤 별도 짧은 트랜잭션으로 failed를 기록한다. 인증/입력/BUSY/DB 장애는 결제 실패 이력으로 저장하지 않는다. succeeded/failed 시도는 변경/삭제하지 않으며 별도 processing 행이나 TTL은 없다.
4. 이관 예매는 원래 없던 해시/시도를 만들지 않고 보존된 예매자·수령 필드를 비교한다. 데이터 보관 동안 키/결과를 보존하고 재시작 뒤에도 재사용한다.

## FIFO·입장권·폴링

회차별 FIFO 큐는 메모리 상태다. 같은 회원의 재진입은 항목/순번을 유지하고 새 세션에 재결합할 때 이전 토큰을 무효화한다. 활성 정원과 최근1초 입장률은 서로 다른 제한이다. 항목/회차 버킷 상한을 넘는 새 진입은429로 거부한다.

비어 있지 않은 좌석 PUT과 신규 확정은 해당 회원/회차/현재 세션의 X-Admission-Token을 트랜잭션 안에서 요구한다. 일반 기한 뒤 유효 hold가 남으면 hold-recovery로 전환해 그 hold의 확정/전체 해제만 허용한다. 새 선택/부분 변경·7분 연장은 불가하다. 본인 조회/전체 해제/취소·관리자는 큐 밖에서 권한 검사 후 사용한다. 큐 이탈/로그아웃 자체는 DB 선점을 취소하지 않는다.

재시작하면 일반 큐·순번·토큰·요청 예산은 사라진다. 유효 DB hold의 정원을 먼저 복구하고 해당 회원은 복구 전용으로 재진입한다. 기존 hold를 담지 못하는 설정은 DB를 보존한 채 시작을 거부한다. 큐는 백업/영속 판매 원본이 아니다.

브라우저는 약3초+jitter, 응답 뒤 다음 조회 예약·숨겨진 탭 중지·오류 백오프(로컬 최대30초)를 적용한다. 서버의 더 긴 Retry-After를 존중한다. GET 큐는 본인 메모리 상태만 반환하고 다른 회원 정보를 노출하지 않는다. position은 대기 시1이상/입장 시0이며 추정 시간이 없으면 estimated_wait_ms는 null이다.

### 큐 설정

| 환경변수 | 기본값 | 허용 범위 | 의미 |
| --- | --- | --- | --- |
| QUEUE_ACTIVE_LIMIT | 50 | 1~10000 | 회차별 활성 정원 |
| QUEUE_ADMIT_PER_SECOND | 5 | 1~10000 | 회차별 최근 1초 입장 한도 |
| QUEUE_MAX_WAITING | 1000 | 1~100000 | 회차별 대기 항목 상한 |
| QUEUE_MAX_TOTAL | 10000 | 1~100000 | 모든 회차 대기+활성 항목 상한 |
| QUEUE_MAX_PERFORMANCES | 100 | 1~10000 | 입장률 기록만 남은 빈 회차까지 포함한 버킷 상한 |
| QUEUE_WAIT_IDLE_MS | 30000 | 1~3600000 | 본인 waiting 비활성 기한 |
| QUEUE_ADMISSION_MS | 120000 | 1~3600000 | admitted 정원 보유 기한 |

### 요청 제한 설정

| 환경변수 | 기본값 | 의미 |
| --- | --- | --- |
| LIMIT_IP_BURST | 120 | 연결 IP의 최대 적립 토큰 |
| LIMIT_IP_PER_SECOND | 30 | IP 초당 충전 |
| LIMIT_USER_BURST | 60 | 회원의 최대 적립 토큰 |
| LIMIT_USER_PER_SECOND | 15 | 회원 초당 충전 |
| LIMIT_AUTH_ATTEMPTS | 30 | 로그인/가입 합산 인증 창 횟수 |
| LIMIT_AUTH_WINDOW_MS | 600000 | 고정 인증 창(ms) |
| LIMIT_MAX_IPS | 10000 | IP 버킷 Map의 키 상한 |
| LIMIT_MAX_USERS | 10000 | 회원 버킷 Map의 키 상한 |
| LIMIT_MAX_AUTH_IPS | 10000 | 인증 창 Map의 키 상한 |
| LIMIT_IDLE_MS | 600000 | 버킷 회수 판단의 최소 비활성 시간(ms) |

회원 예산은 세션/경로를 합산한다. 인증 창은 IP별 가입/로그인 합산이며 잘못된 JSON/Content-Type도 인증 단계에 도달하면 포함한다. IP 제한은 출처/세션 DB 조회보다 먼저 검사한다. 키 회수는 충분한 유휴 시간과 예산 보충을 함께 고려해 재진입 burst 우회를 막고 상한에서 기존 키를 임의 축출하지 않는다. 초과는429와 Retry-After 초를 반환한다.

## 오류와 구현 범위

기존 /api 오류는 {error}, 큐/probes는 {error,code}다. 경계/IP 검사 뒤 출처→세션→CSRF→회원 예산→라우트/권한/본문/업무 검증 순서가 적용된다. 타인 hold/예매는404, 세션 부재401, 출처/CSRF/권한403, 충돌/만료/매수/마감409, JSON400·본문 크기413·미디어415, 제한429, BUSY503, 기타 예기치 않은 DB 오류500이다. 미지원 Method/경로는 일반적으로404이며 잘못된 출처/CSRF가 있으면 먼저403일 수 있다.

기존13작업의 /api/v1 별칭·필수 멱등성 키·재반환200·엄격한 본문/통일 오류 code는 구현하지 않았다. 실제 PG·부분 취소·실제 본인인증/QR 발권도 없다. 실행 계약의 원본은 현재 OpenAPI이며, [테스트](../../tests/api-contract.test.mjs)는 두 Store의 현재 성공/오류 응답과 미지원 별칭을 확인한다.
