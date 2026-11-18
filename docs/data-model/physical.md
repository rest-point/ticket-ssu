# SQLite 물리 모델·이관 절차

[논리 모델](logical.md)을 SQLite STRICT 테이블·인덱스·트리거로 구현한다. Node26.13.0의 SQLite3.54.0을 기준으로 하며 기본 legacy와 별도 model을 명시 선택한다. DB를 자동 전환하지 않는다.

## 파일과 실행 경계

| 파일 | 역할 |
| --- | --- |
| [001_model.sql](../../db/migrations/001_model.sql) | 14개 업무 STRICT 테이블·1개 기술 테이블·키·CHECK·FK·인덱스·booking_totals 뷰 |
| [001_guards.sql](../../db/migrations/001_guards.sql) | 회차·공연장·현재 점유·이력 변경을 보호하는 기본 트리거 |
| [002_withdrawal_guard.sql](../../db/migrations/002_withdrawal_guard.sql) | 탈퇴 회원의 예매자 비식별화만 허용하는 v1 트리거 개정. 기존 데이터·테이블·user_version 유지 |
| [003_booking_opens_at.sql](../../db/migrations/003_booking_opens_at.sql) | 두 스키마의 concerts에 예매 오픈 시각을 추가한다. 기존 공연은 NULL로 예매 가능 시각을 제한하지 않는다. |
| [003_admin_booking_cancellations.sql](../../db/migrations/003_admin_booking_cancellations.sql) | 두 스키마의 관리자 취소 기록 테이블을 추가한다. 앱 최초 실행 시 기존 행과 user_version을 보존한다. |
| [004_member_booking_restrictions.sql](../../db/migrations/004_member_booking_restrictions.sql) | 두 스키마의 회원 예매 제한 이력 테이블을 추가한다. 최신 revision으로 현재 상태를 판단한다. |
| [005_performance_sales.sql](../../db/migrations/005_performance_sales.sql) | 회차의 판매 중단·재개·최종 취소와 일괄 취소된 예매를 기록한다. 기존 회차는 이력이 생기기 전까지 판매 가능 상태다. |
| [model.mjs](../../db/model.mjs) | 연결 설정·빈 DB 생성·오프라인 원자 작업·완성 상태 무결성 검증·출력 경로 보호 |
| [migrate.mjs](../../db/migrate.mjs) | 기존 스키마 읽기 전용 사전 검사·새 파일 이관·VACUUM INTO 스냅샷 |
| [demo.mjs](../../db/seeds/demo.mjs) | 별도 새 모델 DB에 넣는 가상 seed |
| [cli.mjs](../../db/cli.mjs) | 기본 DB 경로 없이 명시한 파일만 처리하는 명령 |
| [model.test.mjs](../../tests/model.test.mjs) | 별도 메모리·OS 임시 DB의 적용·정합성·이관·실패·복원 검증 |
| [benchmark.mjs](../../db/benchmark.mjs) | 메모리 DB의 실행 계획·조회 시간 측정. HTTP 부하 실험과 구분 |

이관은 원본의 테이블을 DROP/재생성하지 않고 **원본 읽기 전용 → 새 대상 파일** 방식으로 수행한다. 원본과 기존 대상은 덮어쓰지 않는다. 앱의 기본 `data/ticket-ssu.sqlite` 출력은 명시적으로 거부한다. 프로젝트 내부 출력은 Git 제외 경로인 data/ 또는 test-results/만 허용하며 공개/문서/소스 경로는 거부한다. 부모 경로의 심볼릭 링크를 해석하고 새 파일은 배타적으로 생성한다. 기존 파일·링크·같은 원본 경로는 존재 검사와 배타 생성으로 거부한다.

## 버전·자료형·데이터 사전

연결마다 foreign_keys=ON, 기본 busy_timeout=5000을 설정한다. API는 seed 뒤 busy_timeout을 25ms로 낮추고 [제한 비동기 재시도](../design/api.md)를 적용한다. 새 파일 DB는 journal_mode=WAL이고 메모리 DB는 memory다. user_version=0은 legacy Store, 1은 model Store 스키마다. 별도 DDL의 초기화는 빈 DB에서 한 트랜잭션으로만 허용한다. 기본 legacy Store의 v1 오접속 거부는 유지한다. 별도 DB_PATH와 DB_SCHEMA=model을 함께 명시하면 ModelStore로 새/이관 v1 DB를 실행하며 시작 시 한 번 전체 검사를 수행한다.

model은 기본 업무 테이블 14개, 관리자 운영 이력 4개, 이관 출처 1개를 합쳐 19개의 STRICT 테이블로 구성된다. SQLite의 허용 가능한 무손실 타입 변환까지 금지하는 것은 아니므로 INTEGER 컬럼의 숫자 문자열이 항상 거부된다고 가정하지 않는다. 핵심 저장 타입·범위는 CHECK와 함께 확인한다. 금액은 원 단위 INTEGER, 시각은 UTC epoch milliseconds INTEGER(0~9,007,199,254,740,991), 화면은 Asia/Seoul이다. ID는 기존 문자열 형식을 보존하며 감사 ID만 기존 INTEGER를 유지한다.

각 컬럼의 업무 의미·길이·NULL·후보키는 [논리 사전](logical.md), 정확한 타입·기본값·제약은 SQL을 원본으로 삼는다. 다음 표는 물리 저장과 조회의 차이다.

| 테이블 | INTEGER 컬럼 | TEXT 및 선택적 컬럼·기본값 |
| --- | --- | --- |
| users | created_at | id·email·name·phone·password_hash·role. role 기본 user. 탈퇴는 ID를 보존하고 이메일/이름/전화 비식별화, password_hash는 32개 0 + 콜론 + 128개 0의 로그인 불가 예약 값 |
| sessions | expires_at | token_hash·user_id·csrf. NULL 없음 |
| venues | 없음 | id·name·region. region만 NULL 허용 |
| physical_seats | number | id·venue_id·seat_code·row_label. NULL 없음 |
| concerts | duration·created_at·booking_opens_at | id·title·artist·description·theme·age. booking_opens_at만 NULL 허용 |
| performances | starts_at | id·concert_id·venue_id. NULL 없음 |
| inventory | price·blocked | id·performance_id·physical_seat_id·grade. blocked 기본 0 |
| holds | expires_at | id·user_id·performance_id·status. NULL 없음 |
| bookings | fee·created_at·cancelled_at | id·hold_id·status·buyer_name·buyer_phone·delivery. cancelled_at만 NULL 허용 |
| booking_items | price_snapshot | booking_id·inventory_id·grade_snapshot. 복합 PK, NULL 없음 |
| current_holds | 없음 | inventory_id·hold_id. NULL 없음 |
| current_bookings | 없음 | inventory_id·booking_id. NULL 없음 |
| payment_attempts | amount·attempted_at | id·hold_id·request_key·body_hash·result·booking_id·failure_code. amount·booking_id·failure_code 조건부 NULL |
| audit_events | id·created_at | user_id·action·detail. id는 양의 INTEGER PRIMARY KEY, detail은 json_valid 검사 |
| admin_booking_cancellations | created_at | booking_id PK/FK, admin_id FK, reason은 customer_request. 관리자 취소 시에만 예매 상태 변경과 함께 생성 |
| member_booking_restrictions | revision·restricted·created_at | member_id와 revision의 복합 PK, member_id·admin_id FK, reason은 운영자 처리 사유 |
| performance_sales_events | revision·created_at | performance_id와 revision의 복합 PK, performance_id·admin_id FK, 판매 상태와 사유 |
| performance_cancelled_bookings | revision | booking_id PK/FK, performance_id와 revision은 취소 처리 이력의 복합 FK |
| legacy_booking_imports | 없음 | booking_id PK/FK. 이관된 예매라는 기술적 출처만 기록 |

legacy_booking_imports는 과거 데모 시도 기록이 없는 기존 예매를 식별한다. 결제 시도·시각·요청 키를 꾸며내는 대신 이 행이 있는 예매만 성공 시도 0개를 허용한다. 일반 예매 경로가 이 기술 테이블에 행을 넣는 것은 지원하지 않는다. 새 앱 통합에서 쓰기 권한·호출 경계를 유지해야 한다.

PK·NOT NULL·후보키 UNIQUE는 SQL에 명시한다. holds는 active 회원·회차 부분 UNIQUE, payment_attempts는 비NULL booking_id 부분 UNIQUE를 사용한다. 시간에 의존하는 부분 인덱스는 없다. 복합 FK는 current_bookings → booking_items의 복합 PK, payment_attempts → bookings의 UQ(id,hold_id), performance_cancelled_bookings → performance_sales_events의 PK(performance_id,revision)를 참조한다. 모든 FK는 즉시 검사하며 삭제에 ON DELETE RESTRICT를 적용한다. 갱신은 기본 스키마가 ON UPDATE RESTRICT, 관리자 운영 이력 4개 테이블은 기본 동작인 NO ACTION을 적용한다. FK를 끄거나 지연시켜 우회하지 않는다. [SQLite FK 문서](https://www.sqlite.org/foreignkeys.html)는 부모 유일키와 즉시/지연 검사 차이를 설명한다.

## 상태 변경 순서와 제약의 한계

| 작업 | 한 트랜잭션 안의 순서 |
| --- | --- |
| 최초 선점 | 서버 시각으로 만료 정리·공연 마감·소유권·총 4매 검사 → active hold → 1..4 current_holds |
| 선택 변경 | 이전 현재 연결 삭제 → 이전 hold released → 새 hold(이전 만료 시각 유지) → 새 현재 연결 |
| 해제·만료 | 현재 선점 연결 삭제 → hold released 또는 expired. 남은 active 좌석 0개는 완성 상태에서 금지 |
| 신규 확정 | 유효 선점·매수·시각 재검사 → 현재 선점 삭제 → hold converted → booking → 항목 → 현재 예매 → 성공 데모 시도 |
| 전체 취소 | 소유권·공연 시작 전 확인 → 현재 예매 연결 삭제 → booking cancelled·cancelled_at 갱신. 항목·금액·성공 시도는 보존 |
| 차단/해제 | 관리자 권한·공연 시각 확인 → 점유 없는 inventory.blocked 변경 → 감사 기록 |

model 생성 시 001 뒤 002 트리거를 같은 초기화 트랜잭션으로 적용한다. 기존 v1 앱 시작에서는 기본 001 booking_immutable만 002로 원자 교체하고 사용자 정의 트리거는 거부한다. 탈퇴 비식별화는 회원 해시가 예약 값일 때 예매자 이름/전화의 지정 값 치환만 허용한다. 금액·항목·시각·소유권·상태는 이 예외로 바꿀 수 없다.

트리거는 장소/회차 불일치·점유 충돌·차단 점유·좌석/선점 식별 변경·만료 연장·잘못된 상태 전환·이력 수정/삭제 등을 문장 단위로 거부한다. 스냅샷 단위 유일성·복합 FK로 현재 소유와 예매 항목도 연결한다.

SQLite에는 이 설계를 위한 일반적인 커밋 시점 집계 제약이 없다. 항목 1..4개·수수료 합계·현재 점유 완성·회원 4매·신규 성공 시도 존재 같은 최종 조건은 `modelTransaction()`이 콜백 뒤, COMMIT 전에 `validateModel()`로 확인한다. 실패하면 ROLLBACK한다. 이 함수는 오프라인 생성/이관 도구용 전체 검사이며 대기열을 포함한 API 요청마다 전체 DB를 스캔하는 운영 설계가 아니다.

DB 시간을 임의로 읽는 트리거로 요청 만료 정책을 대체하지 않는다. 현재 도구는 서버 시각 기반 만료·공연 시작·인증·CSRF·일반 멱등성의 API 구현이 아니다. 이관은 만료된 active 상태도 원본 그대로 옮긴다. 실제 앱 통합은 요청 트랜잭션에서 만료를 정리하고 시간·최대 4매를 재검사해야 한다. 현재 검사기는 정리 전 active 연결을 보수적으로 매수에 포함하므로 다음 요청에서 정리 후 검사한다.

현재 앱의 쓰기는 위 만료 정리를 유지하고, 공연/좌석/관리자 읽기는 [별도 스냅샷](../design/api.md)에서 status/기한 조건으로 만료를 제외한다. CLI의 정리 후 원시 쿼리와 HTTP 표시 SQL을 구분한다. 예매 오픈과 관리자 이력용 DDL은 model의 user_version=1을 유지하며, 실제 요청 SQL은 두 Store를 원본으로 삼는다.

임의 raw SQL, OR REPLACE, 트리거 제거, 출처 표식 직접 삽입, 검증 없는 COMMIT은 지원 경로가 아니다. 현재 프로세스가 DB 파일의 쓰기 권한을 독점한다는 전제이며 DB 소유자가 제약을 제거할 수 없는 보안 경계라고 주장하지 않는다.

## 인덱스와 주요 쿼리

| 키/인덱스 | 적용 쿼리·이유 |
| --- | --- |
| inventory UNIQUE(performance_id,physical_seat_id) | 회차 좌석 조회 및 중복 재고 방지. performance_id 선두를 이용하므로 같은 단일 인덱스를 더 만들지 않음 |
| physical_seats의 두 장소별 UNIQUE | 장소별 코드·열/번호 중복 방지, 장소 FK 참조 조회 |
| holds_user_performance | 소유 회원·회차의 예매 JOIN. active 부분 UNIQUE는 전체 이력을 대체하지 않음 |
| holds_expiry (active) | 만료 정리 대상의 expires_at 범위 검색 |
| current_holds_hold / current_bookings_booking | 선점·예매별 현재 연결 조회/일괄 해제. 재고 PK는 반대 방향 조회용 |
| booking_items_inventory | 재고의 구매·취소 이력과 FK 참조 확인 |
| performances_concert_start / performances_venue | 공연의 회차 시간순 조회·공연장 참조 확인 |
| sessions_user / sessions_expiry | 회원 세션 조회·만료 정리 |
| inventory_physical / holds_performance / audit_user | 부모 삭제/변경 검사와 참조 방향 조회. 삭제 API 구현을 뜻하지 않음 |
| bookings hold_id UNIQUE / 성공 시도 부분 UNIQUE | 같은 선점 확정 중복과 성공 시도 중복 방지. hold-key UNIQUE가 시도 키 조회를 지원 |

booking_totals 뷰는 항목 가격 SUM과 fee로 ticket_total·total을 파생하고 선점 JOIN으로 회원·회차를 반환한다. 항목이 없을 때 SUM은 NULL로 남겨 불완전 예매를 숨기지 않는다. 기존 저장 합계와 불일치하면 이관을 중단하며 임의 보정하지 않는다.

`node db/benchmark.mjs`는 가상 과거 예매 3,000개·현재 선점 96개·재고 288개의 메모리 DB에서 4개 쿼리를 예열 후 200회씩 측정한다. EXPLAIN QUERY PLAN과 실제 평균 시간은 별도 기록하며 선택한 보조 인덱스 3개를 제거한 같은 데이터와 비교한다. 측정은 같은 연결·따뜻한 캐시·고정 실행 순서이므로 큰 차이가 없는 결과나 잡음을 숨기지 않는다. 파일 I/O·HTTP 동시성·k6 부하는 측정하지 않는다.

## 이관 사전 검사와 대응

원본의 user_version=0, 기본 테이블 9개, 컬럼 배열과 허용된 인덱스를 확인한다. 기존 `concerts.booking_opens_at`과 관리자 이력 테이블 4개는 기능 적용 여부에 따라 포함될 수 있다. 회차 판매 이력과 취소 예매 연결 테이블은 두 테이블이 함께 있어야 한다. 알 수 없는 테이블·뷰·트리거·인덱스는 검토 없이 무시하지 않고 중단한다. 실제 저장 타입·안전 정수·integrity_check·foreign_key_check, 예매와 선점의 회원/회차, 항목 존재·수량·기존 합계·수수료·총액을 검사한다. 새 STRICT 도메인과 트리거 및 최종 무결성 검사에서도 실패할 수 있다.

| 기존 데이터 | 대상·보존 방식 |
| --- | --- |
| users / sessions | 모든 컬럼 값·비밀번호 해시·세션 해시·CSRF·시각을 그대로 이관 |
| concerts | venue 외 속성과 ID 유지. 원문 venue는 새 장소 name으로 보존. booking_opens_at이 있으면 유지하고 기존 컬럼이 없으면 NULL |
| performances | ID·공연·시각 유지. 회차마다 별도 legacy-venue ID를 만들어 같은 장소 이름을 자동 병합하지 않음 |
| seats | 회차별 물리 좌석·inventory로 대응. (performance_id,seat_id)를 JSON 튜플로 인코딩해 내부 ID를 만들어 경계 문자열 충돌 방지. 원래 코드·열·번호·등급·가격·차단 보존 |
| holds | ID·회원·회차·상태·만료 그대로. 현재 hold_id는 current_holds로 이관 |
| bookings / booking_seats | ID·취소·수수료·예매자·시각·스냅샷 보존. 기존 user_id/performance_id/합계는 파생 결과와 값별로 대조 |
| seats.booking_id | 해당 항목이 있는 confirmed 예매의 current_bookings로 이관. 취소 이력과 현재 소유를 분리 |
| audit | 원본 INTEGER ID·동작·상세 JSON·행위자·시각 그대로 이관 |
| 관리자 운영 이력 | 관리자 대리 취소, 회원 예매 제한·해제, 회차 판매 상태 및 최종 취소 예매 연결을 보존 |
| 과거 결제 시도 부재 | 시도 행 0개. legacy_booking_imports로만 출처 표시 |

같은 공연의 여러 회차도 물리 장소 동등성은 자동 추정하지 않는다. 중복 장소를 수동 검토해 통합하는 후속 이관은 별도 작업이다. 이는 원본의 좌석 배치가 모두 같다는 가정으로 이력을 잘못 합치는 일을 피하는 보수적 선택이다.

## 실행·백업·복구 절차

다음은 명시적으로 새 파일을 지정하는 예다. 기존 data/ticket-ssu.sqlite에 실행하지 않으며, 디렉터리는 미리 준비한다. 기본 경로·덮어쓰기 옵션은 없다.

```powershell
# 새 모델 전용 가상 DB. 재실행 시 기존 파일을 덮어쓰지 않고 실패한다.
node db/cli.mjs seed data/model-demo.sqlite
node db/cli.mjs verify data/model-demo.sqlite

# 별도로 준비한 기존 형식 DB의 일관된 스냅샷과 새 대상 후보를 만든다.
node db/cli.mjs snapshot data/offline-legacy.sqlite data/legacy-snapshot.sqlite
node db/cli.mjs migrate data/legacy-snapshot.sqlite data/model-candidate.sqlite
node db/cli.mjs verify data/model-candidate.sqlite
```

1. 실제 전환 전 단일 앱을 중지하고 쓰기를 멈춘다. 미리 테스트를 통과한 스냅샷 도구 또는 SQLite 온라인 백업을 사용한다. 실행 중 DB 본 파일만 파일 복사해서 백업으로 삼지 않는다.
2. `snapshot`은 읽기 전용 연결의 `VACUUM INTO`로 새 파일을 만들고 무결성을 확인한다. 이는 원본의 일관된 스냅샷을 만드는 방식이다. [SQLite 공식 설명](https://www.sqlite.org/lang_vacuum.html#vacuuminto)을 따른다. [배포 백업/복구 도구](../../README.md)는 두 모드의 새 후보 검증/복구를 추가했다. 운영 파일의 권한·보관·장애 복구 조건은 별도로 관리한다.
3. 이관 원본은 읽기 트랜잭션으로 스냅샷을 고정한다. 새 대상의 DDL은 원자적으로 적용하고 데이터 이관·완성 상태 검사는 별도 한 트랜잭션으로 실행한다. 실패하면 원본은 그대로 두고 이 실행이 배타 생성한 대상 파일과 관련 WAL/SHM만 정리한다. 다른 기존 파일은 삭제하지 않는다.
4. 원본·스냅샷·성공 후보를 보존한 채 ID·이력·세션·파생 금액과 무결성을 확인한다. 이번 테스트는 스냅샷을 재개방해 이관 입력으로 사용하는 복원도 검증했다.
5. 검증된 별도 후보는 DB_SCHEMA=model과 DB_PATH를 함께 지정해 시험할 수 있다. 요청 경합/잠금 정책은 [API 명세](../design/api.md)를 따른다. 실제 운영 전환/복구는 별도 작업이다. 원본을 자동 전환하지 않으며 후보 쓰기 전 실패라면 원본과 legacy 모드로 재개할 수 있다.
6. 향후 새 모델에서 쓰기가 발생한 뒤의 복구는 그 새 쓰기를 버리지 않는 대조/복구 계획이 필요하다. 예전 스냅샷을 자동 덮어쓰는 down migration은 제공하지 않는다. 기존 파일을 즉석에서 되돌리는 명령도 없다.

이관은 전체 원본을 메모리에 읽는 오프라인 도구다. 큰 데이터셋의 메모리·중단 시간·디스크 용량·실제 장애 복구 시간은 측정하지 않았다. 프로젝트 운영 DB와 실제 사용자 데이터는 이번 검증에 사용하지 않았다.
