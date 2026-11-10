# 논리 데이터 모델

[개념 모델](conceptual.md)의12개 업무 엔터티를14개 릴레이션으로 구체화한다. current_holds/current_bookings는 현재 점유를 분리하며 과거 항목은 보존한다. 별도 model 모드의 저장 계약이며 기본 legacy/기존 DB를 자동 전환하지 않는다. [정규화](normalization.md)·[물리 모델](physical.md)과 함께 읽는다.

## 설계 원칙과 표기

- 공연장·물리 좌석·회차 재고를 분리한다. 같은 A-01이라도 공연장이 다르면 별개이고 같은 물리 좌석도 회차마다 별도 재고다.
- 예매의 소유 회원·회차는 원본 선점에서 구한다. 예매 항목의 회차는 재고에서 구하며 두 회차의 일치를 별도 무결성 규칙으로 강제한다.
- 예매 항목의 판매 당시 등급·가격과 예매 수수료는 불변 스냅샷이다. ticket_total과 total은 조회 계산값으로 두어 합계의 중복 저장을 줄인다.
- 관계·도메인·필수성은 아래의 model 저장 계약이다. SQLite CHECK·FK·UNIQUE·트리거·인덱스와 오프라인 검증은 물리 모델에 구체화했다. FK만으로 모든 업무 규칙이 강제된다고 가정하지 않는다. 서버 시각·권한·상태는 현재 API의 짧은 요청 트랜잭션에서 재검사한다.
- `PK`는 기본키, `CK`는 최소 후보키, `UQ`는 참조에 필요한 추가 유일성이다. 모든 CK는 NOT NULL이다. nullable UNIQUE는 전체 릴레이션의 CK로 세지 않는다. 각 속성의 도메인은 공통 표와 릴레이션별 표를 함께 적용한다.

## 공통 도메인

| 도메인 | 논리 값·검증 규칙 |
| --- | --- |
| ID | 공백이 아닌 TEXT 식별자. 기존 ID 형식을 보존하고 UUID만 강요하지 않음. 신규 ID는 서버 발급, 다른 릴레이션 참조는 같은 도메인 |
| TIME | UTC epoch milliseconds INTEGER, 0 이상, JavaScript 안전 정수 범위. API는 정수, 화면은 Asia/Seoul |
| MONEY | 원 단위 INTEGER, 0 이상, JavaScript 안전 정수 범위. 서버 계산과 저장 전 범위 검사 |
| EMAIL | trim·소문자 정규화, 최대 254자, 현재 가입 API 이메일 형식 검사. UNIQUE는 정규화 저장값 기준 |
| PERSON_NAME / PHONE | 이름 2~40자, 전화번호는 구분자 제거 후 현재 `01[016789]` + 7~8자리 규칙. 본인인증 완료를 뜻하지 않음 |
| TOKEN_HASH / BODY_HASH | SHA-256 소문자 hex 64자. 원문 세션 토큰·비밀번호·요청 개인정보 본문을 저장하지 않음 |
| PASSWORD_HASH / CSRF | 현재 scrypt salt:key 인코딩 문자열 / 서버 발급 48자리 hex. 임의 일반 문자열을 허용하지 않음 |
| LABEL | trim한 1~120자 표시명. 상세 길이는 아래에서 좁힘 |
| SEAT_CODE / ROW_LABEL | 공연장 내 1~32자 좌석 코드 / 1~16자 열 표시. 기존 A-01·A 등 표시를 유지 |
| REQUEST_KEY | 공백이 아닌 1~128자 클라이언트 멱등성 키. 로그에 원문 요청 본문을 남기지 않음 |
| ROLE / GRADE / BOOL | user 또는 admin / VIP·R·S / 정수 0 또는 1 |

길이·문자 정규화는 API와 DDL에서 나눠 적용한다. 새로운 길이 제한에 기존 값이 부합하는지는 실제 DB를 추측하지 않고 마이그레이션 사전 검사로 확인한다. 도메인 제약 위반 시 기존 데이터를 자르거나 새 값으로 바꾸지 않고 중단한다.

## 릴레이션 명세

각 절의 스키마 한 줄은 전체 속성 집합이다. nullable에 없는 모든 속성은 NOT NULL이다. FK의 모든 구성 속성이 NULL이 아닌 경우 부모 행이 존재해야 한다. 이력 참조는 원칙적으로 ON DELETE RESTRICT / ON UPDATE RESTRICT이며 아래 생명주기 정책을 따른다.

### users

```text
users(id, email, name, phone, password_hash, role, created_at)
```

| 항목 | 규칙 |
| --- | --- |
| PK / CK | PK id; CK id / email |
| 속성 도메인 | id: ID; email: EMAIL; name: PERSON_NAME; phone: PHONE; password_hash: PASSWORD_HASH; role: ROLE; created_at: TIME |
| nullable / FK | 없음 / 없음 |
| 유일성·보존 | 이메일 UNIQUE. 이름·전화번호는 후보키가 아님. 관리자도 이 테이블의 역할로 표현. 본인 탈퇴는 ID와 FK 이력을 보존하고 이메일·이름·전화 비식별화 및 비밀번호 해시 예약 값으로 로그인 차단. 같은 이메일 재가입은 새 ID |

### sessions

```text
sessions(token_hash, user_id, csrf, expires_at)
```

| 항목 | 규칙 |
| --- | --- |
| PK / CK | PK token_hash; CK token_hash |
| 속성 도메인 | token_hash: TOKEN_HASH; user_id: ID; csrf: CSRF; expires_at: TIME |
| nullable / FK | 없음 / user_id → users.id |
| 유일성·보존 | 회원당 여러 세션 허용. csrf와 user_id는 유일키가 아님. 기본 세션 수명 7일; 로그아웃·만료 시 세션 행만 삭제 가능 |

### venues

```text
venues(id, name, region)
```

| 항목 | 규칙 |
| --- | --- |
| PK / CK | PK id; CK id |
| 속성 도메인 | id: ID; name: LABEL; region: 1~40자 지역 표시 문자열 또는 NULL |
| nullable / FK | region / 없음 |
| 유일성·보존 | 공연장 이름은 UNIQUE가 아님. 이름이 같다는 이유만으로 기존 장소를 병합하지 않음. 알 수 없는 지역은 NULL |

### physical_seats

```text
physical_seats(id, venue_id, seat_code, row_label, number)
```

| 항목 | 규칙 |
| --- | --- |
| PK / CK | PK id; CK id / (venue_id, seat_code) / (venue_id, row_label, number) |
| 속성 도메인 | id·venue_id: ID; seat_code: SEAT_CODE; row_label: ROW_LABEL; number: 1~9999 정수 |
| nullable / FK | 없음 / venue_id → venues.id |
| 유일성·보존 | 장소 안의 코드 및 열·번호 각각 UNIQUE. seat_code 단독은 유일하지 않음. 재고나 이력이 있으면 id·공연장·코드·열·번호를 바꾸지 않음 |

### concerts

```text
concerts(id, title, artist, description, theme, duration, age, created_at, booking_opens_at)
```

| 항목 | 규칙 |
| --- | --- |
| PK / CK | PK id; CK id |
| 속성 도메인 | id: ID; title·artist: LABEL; description: 1~2000자; theme: teal·purple·orange·blue; duration: 양의 분 단위 정수; age: 1~120자 관람등급 안내; created_at: TIME; booking_opens_at: TIME 또는 NULL |
| nullable / FK | booking_opens_at / 없음 |
| 유일성·보존 | 제목·아티스트는 키가 아님. 공연장 문자열은 제거하고 회차의 장소로 구함. 현재 등록 기본값 duration=120, age=8세 이상. booking_opens_at은 공연 단위 예매 오픈 시각으로 첫 회차 시작보다 앞서야 함. 등록 시 생략하면 등록 시각, NULL은 이 속성 추가 전 공연(제한 없음) |

### performances

```text
performances(id, concert_id, venue_id, starts_at)
```

| 항목 | 규칙 |
| --- | --- |
| PK / CK | PK id; CK id |
| 속성 도메인 | id·concert_id·venue_id: ID; starts_at: TIME |
| nullable / FK | 없음 / concert_id → concerts.id; venue_id → venues.id |
| 유일성·보존 | (concert_id, starts_at)는 현행 등록 요청 내 중복을 막지만 전체 모델의 후보키로 강요하지 않음. 생성 시 미래 시각을 API에서 검사; now에 의존한 CHECK/인덱스로 표현하지 않음 |

### inventory

```text
inventory(id, performance_id, physical_seat_id, grade, price, blocked)
```

| 항목 | 규칙 |
| --- | --- |
| PK / CK | PK id; CK id / (performance_id, physical_seat_id) |
| 속성 도메인 | id·performance_id·physical_seat_id: ID; grade: GRADE; price: MONEY이며 현재 생성 범위 1,000~1,040,000원; blocked: BOOL |
| nullable / FK | 없음 / performance_id → performances.id; physical_seat_id → physical_seats.id |
| 유일성·보존 | (performance_id, physical_seat_id) UNIQUE. 가격·등급은 회차 속성이며 물리 좌석에 옮기지 않음. 재고의 회차·좌석 식별은 생성 후 불변 |

현재 좌석 생성은 회차당 96석, VIP 24 / R 36 / S 36이고 S 기본가에 R 20,000원·VIP 40,000원을 더한다. 이는 생성 규칙이며 `grade → price`라는 전역 함수 종속성은 아니다. 재고에 공연장 ID를 중복 보관하지 않으며 아래 X-01로 두 부모의 장소를 대조한다.

### holds

```text
holds(id, user_id, performance_id, expires_at, status)
```

| 항목 | 규칙 |
| --- | --- |
| PK / CK | PK id; CK id |
| 속성 도메인 | id·user_id·performance_id: ID; expires_at: TIME; status: active·expired·released·converted |
| nullable / FK | 없음 / user_id → users.id; performance_id → performances.id |
| 유일성·보존 | (user_id, performance_id)는 전체 이력의 CK가 아님. status=active 부분집합에 대해서만 회원·회차 UNIQUE. 만료 시각에 의존한 부분 인덱스는 사용하지 않음 |

active 선점의 유효성은 `expires_at > server_now`와 공연 시작 전 조건을 함께 확인한다. 최초 7분, 선택 변경 시 새 ID와 기존 만료 시각 유지, 빈 선택은 해제한다. 물리 모델에서 만료 정리와 부분 UNIQUE가 충돌하지 않도록 순서를 정한다.

### bookings

```text
bookings(id, hold_id, status, fee, buyer_name, buyer_phone, delivery, created_at, cancelled_at)
```

| 항목 | 규칙 |
| --- | --- |
| PK / CK | PK id; CK id / hold_id |
| 속성 도메인 | id·hold_id: ID; status: confirmed·cancelled; fee: MONEY; buyer_name: PERSON_NAME; buyer_phone: PHONE; delivery: mobile·onsite; created_at·cancelled_at: TIME |
| nullable / FK | cancelled_at / hold_id → holds.id |
| 유일성·보존 | hold_id UNIQUE. confirmed이면 cancelled_at=NULL, cancelled이면 cancelled_at>=created_at. 기존 ID와 취소 이력 보존 |

소유 회원·회차는 `bookings.hold_id → holds.(user_id, performance_id)`로 구한다. buyer_name·buyer_phone은 예매자 스냅샷이므로 회원 프로필과 달라도 허용하며 권한에는 사용하지 않는다. 취소해도 fee와 항목 가격은 바꾸지 않는다. 원본 예매금액은 이력으로 남고 cancelled라는 상태가 유효 판매액 0원을 나타낸다. 실제 환불 API는 없다.

`ticket_total = SUM(booking_items.price_snapshot)`, `total = ticket_total + bookings.fee`를 조회에서 계산해 기존 API 필드로 반환한다. 항목은 1..4개가 필수다. 행이 없는 예매를 0원으로 숨기지 않고 무결성 오류로 판별한다. fee는 확정 당시 장당 2,000원 합계를 보존하는 저장 스냅샷이며 현재 설정으로 재계산해 덮어쓰지 않는다.

### booking_items

```text
booking_items(booking_id, inventory_id, grade_snapshot, price_snapshot)
```

| 항목 | 규칙 |
| --- | --- |
| PK / CK | PK (booking_id, inventory_id); CK (booking_id, inventory_id) |
| 속성 도메인 | booking_id·inventory_id: ID; grade_snapshot: GRADE; price_snapshot: MONEY |
| nullable / FK | 없음 / booking_id → bookings.id; inventory_id → inventory.id |
| 유일성·보존 | 예매 안의 재고만 UNIQUE. inventory_id 단독 UNIQUE 및 회차·좌석 전체 이력 UNIQUE는 금지. 취소 후에도 스냅샷 보존 |

좌석 표시는 inventory → physical_seats의 불변 seat_code로 구한다. 개념도의 seat_label_snapshot은 같은 불변 코드를 중복 저장하지 않는 파생 표시로 구체화한다. 기존 booking_seats.seat_id를 이 코드와 대조하여 보존하고, 대응이 안 되면 중단한다. 등급·가격 스냅샷은 그 재고의 현재 값과 별개의 확정 시점 값이며 이후 덮어쓰지 않는다.

### current_holds

```text
current_holds(inventory_id, hold_id)
```

| 항목 | 규칙 |
| --- | --- |
| PK / CK | PK inventory_id; CK inventory_id |
| 속성 도메인 | inventory_id·hold_id: ID |
| nullable / FK | 없음 / inventory_id → inventory.id; hold_id → holds.id |
| 유일성·보존 | 재고당 현재 선점은 최대 1개. hold_id는 여러 좌석을 묶으므로 UNIQUE 아님. 해제·만료·확정 시 연결 행만 삭제 |

### current_bookings

```text
current_bookings(inventory_id, booking_id)
```

| 항목 | 규칙 |
| --- | --- |
| PK / CK | PK inventory_id; CK inventory_id |
| 속성 도메인 | inventory_id·booking_id: ID |
| nullable / FK | 없음 / (booking_id, inventory_id) → booking_items.(booking_id, inventory_id) |
| 유일성·보존 | 재고당 현재 예매는 최대 1개. 복합 FK로 해당 예매의 항목인 재고만 연결. 취소 시 이 연결만 삭제하고 booking_items는 보존 |

두 current 릴레이션은 INVENTORY의 선택적 현재 소유 관계를 표현한다. 하나의 nullable 컬럼에 선점 ID 또는 예매 ID를 혼합하지 않는다. 두 릴레이션에 같은 inventory_id가 함께 존재하지 않는 규칙은 PK 하나로 해결되지 않으므로 X-02를 따로 강제한다. 기존 표시 available / selected / held / booked / blocked는 이 관계와 조회 회원을 바탕으로 구한다.

### payment_attempts

```text
payment_attempts(id, hold_id, request_key, body_hash, result, amount, booking_id, failure_code, attempted_at)
```

| 항목 | 규칙 |
| --- | --- |
| PK / CK | PK id; CK id / (hold_id, request_key) |
| 속성 도메인 | id·hold_id·booking_id: ID; request_key: REQUEST_KEY; body_hash: BODY_HASH; result: succeeded·failed; amount: MONEY; failure_code: 1~64자 허용된 오류 코드; attempted_at: TIME |
| nullable / FK | amount·booking_id·failure_code / hold_id → holds.id; (booking_id, hold_id) → bookings.(id, hold_id) |
| 유일성·보존 | booking_id IS NOT NULL 부분 UNIQUE로 예매당 성공 시도 최대 1개. 부모 bookings에 FK 참조용 UQ(id, hold_id)를 추가하며 이는 최소 CK가 아닌 슈퍼키 |

성공이면 booking_id·amount 필수이고 failure_code는 NULL이다. 실패이면 booking_id는 NULL, failure_code는 필수이고 amount는 서버 계산이 가능했을 때만 있다. 유효한 회원이 소유한 실제 선점의 데모 확정만 기록 대상이며 익명·타인·없는 선점 요청을 가짜 부모로 저장하지 않는다. method는 항상 demo이므로 상수 컬럼은 저장하지 않는다.

키 범위는 한 선점의 데모 확정 `(hold_id, request_key)`다. 동일 키·동일 정규화 본문은 결과 재사용, 다른 본문은 충돌이다. 현재 model API의 선택 키 정규화·보존 기간·결과 재반환은 [API 명세](../design/api.md)를 따른다. legacy는 키 헤더를 지원하지 않으며 기존 hold_id 기반 재시도는 두 모드에서 유지한다.

동기식 데모 확정의 성공 결과·예매·항목·현재 재고 전환은 한 트랜잭션으로 커밋한다. 영속 processing 상태는 이 모델에 두지 않는다. 실패 결과를 기록하려면 예매 변경 롤백 후 별도 짧은 트랜잭션에서 기록한다. DB 장애 시 실패 기록까지 성공한다고 보장하지 않는다. 이미 확정된 hold의 재시도는 기존 성공 기록을 반환하며 새 성공 행을 만들지 않는다. 기존 예매에 없는 과거 시도는 생성하지 않는다.

### audit_events

```text
audit_events(id, user_id, action, detail, created_at)
```

| 항목 | 규칙 |
| --- | --- |
| PK / CK | PK id; CK id |
| 속성 도메인 | id: 양의 INTEGER 사건 ID(기존 INTEGER 감사 ID 보존); user_id: ID; action: block·unblock·create-concert; detail: 유효한 JSON 문자열; created_at: TIME |
| nullable / FK | 없음 / user_id → users.id |
| 유일성·보존 | 동작·대상은 유일키 아님. 관리자가 나중에 역할이 바뀌어도 기록을 보존. 입력 당시 권한 검사. 시스템 사용자 생성은 이번 범위 아님 |

detail은 동작의 불변 사건 자료다. 현재처럼 create-concert의 id/title, block/unblock의 performanceId/ids를 보존한다. 좌석 목록은 판매 관계를 저장하는 컬럼이 아니라 감사 사건의 원문 상세다. 관계 조회·FK 검증·매수 집계에 detail을 사용하지 않는다. 범용 target_id를 여러 테이블에 거짓 FK로 연결하지 않으며 감사 대상 FK가 필요해지면 별도 대상 관계를 설계한다.

## 관리자 기능 이력

다음 이력은 model과 legacy에 공통으로 추가된다. 현재 상태를 결정하는 최신 revision과 기존 예매의 연결을 보존한다. 자료형·FK 삭제 정책은 [물리 모델](physical.md)을 따른다.

| 릴레이션 | 키 | 보존 내용 |
| --- | --- | --- |
| admin_booking_cancellations | booking_id | 예매당 대리 취소 한 건. 처리 관리자·사유·시각을 보존한다. |
| member_booking_restrictions | (member_id, revision) | 회원별 제한·해제 이력. 최신 revision을 현재 상태로 사용한다. |
| performance_sales_events | (performance_id, revision) | 회차별 판매 중단·재개·최종 취소 이력. 최신 revision을 현재 상태로 사용한다. |
| performance_cancelled_bookings | booking_id | 최종 취소된 예매를 해당 (performance_id, revision)의 판매 이력에 연결한다. |

## 릴레이션 간 무결성 계약

아래는 model의 필수 무결성 계약이다. “FK로 직접 표현”과 “트리거·트랜잭션으로 보완”을 구분하며 물리 DDL/요청 처리에 적용한다. 참조되는 부모의 식별 정보는 기존 데이터 보존 이후 불변으로 두어 자식 검증을 부모 갱신으로 우회하지 못하게 한다.

| ID | 불변식 | 강제 경계 |
| --- | --- | --- |
| X-01 | inventory의 performance.venue_id = physical_seat.venue_id | 개별 FK + 재고 INSERT/식별 변경 방지 트리거. 재고 있는 회차의 venue_id 및 좌석의 venue_id 변경 거부. 중복 venue_id를 재고에 넣어 2NF를 깨지 않음 |
| X-02 | 두 current 릴레이션은 같은 재고에 공존 불가. blocked 재고에는 어느 점유도 없음 | 양쪽 연결 INSERT/UPDATE 및 inventory.blocked 변경을 확인하는 트리거 + 같은 쓰기 트랜잭션 |
| X-03 | current_holds의 hold.performance_id = inventory.performance_id; active이며 요청 기준 만료 전 | 두 FK + 관계 삽입/변경 시 회차·상태 검증. 서버 기준 만료·공연 시각 검사는 트랜잭션에서 수행. hold 회원·회차는 불변 |
| X-04 | booking_items의 booking→hold.performance_id = inventory.performance_id | 두 FK + 항목 생성 시 회차 대조 트리거. 예매의 hold_id와 재고 회차는 생성 후 불변 |
| X-05 | current_bookings는 그 예매 항목이며 예매 status=confirmed | 항목에 대한 복합 FK + 상태 트리거/변경 순서. 예매 취소 전에 현재 연결을 해제하고 같은 트랜잭션에서 취소 이력 갱신 |
| X-06 | payment_attempts가 연결한 예매는 같은 hold이며 성공 금액은 파생 booking.total과 같음 | (booking_id, hold_id) 복합 FK + 결과별 CHECK + 성공 금액/항목 합계 확인 |
| X-07 | 회원·회차별 확정 항목 수 + 유효 current_holds 수 <=4; active 선점별 현재 좌석 1..4; 예매별 항목 1..4 | 짧은 BEGIN IMMEDIATE 트랜잭션에서 검사·조건부 갱신·변경 행 수 확인. FK나 부분 UNIQUE만으로 집계 제약을 보장하지 않음 |
| X-08 | 확정 항목·수수료·시각·소유권은 취소 후에도 보존. 새 예매 fee = 항목 수 ×2,000원 | 생성 시 스냅샷·집계 확인. 항목/예매 불변 정보 수정·삭제 차단. 취소는 연결 해제·status/cancelled_at 갱신만 허용. 별도 탈퇴 트랜잭션은 탈퇴 회원의 예매자 이름/전화 비식별화만 예외 |
| X-09 | 새 예매에는 성공 결제 시도 정확히 1개, 기존 마이그레이션 예매에는 0개 허용 | 성공 시도 부분 UNIQUE로 최대 1개, 신규 확정 트랜잭션으로 최소 1개. 과거 기록 부재는 마이그레이션 경계에서 구분; 가짜 과거 시도 생성 금지 |

SQLite FK를 쓸 때 참조 부모의 동일 컬럼 조합에 PK 또는 명시적 UNIQUE가 필요하다. 위 두 복합 FK는 각각 booking_items의 복합 PK와 bookings의 추가 UQ를 참조한다. current_holds에는 회차 중복 컬럼이 없으므로 단일 FK만으로 회차 일치를 보장한다고 쓰지 않는다. 트리거·CHECK의 구체적 SQL과 예매 생성/취소 중간 상태 처리 순서는 물리 모델에서 검증해야 한다.

## 금액·취소·식별 보존

| 항목 | model 동작 |
| --- | --- |
| 선택·확정 | 7분·4매·서버 금액 계산 정책 유지. selected는 조회 회원의 선점 표시이며 DB의 별도 판매 상태 아님 |
| 취소 후 재판매 | 예매 A의 항목 보존, current_bookings에서 A 연결 삭제, 예매 B의 새 항목·현재 연결 생성. 같은 재고의 항목 이력은 여러 개일 수 있지만 현재 소유자는 하나 |
| 기존 API | user_id / performance_id는 선점 JOIN으로, seat_id는 불변 물리 코드로, ticket_total / total은 항목 집계로 반환. 공개 ID·상태·응답 필드를 유지하는 어댑터가 필요 |
| 기존 금액 검증 | 기존 bookings.ticket_total = 기존 항목 가격 합계, total = ticket_total + fee를 사전 대조. 불일치·항목 부재·회차 혼합은 자동 재계산해 덮어쓰지 않고 마이그레이션 중단 |
| 수수료 | 기존 fee를 그대로 옮기며 현재 기본 정책과 맞는지도 검증. 불일치하면 사용자 데이터 수정 없이 중단. 취소 후에도 원본 금액은 보존 |
| 좌석 연결 | 기존 (performance_id, seat_id)를 새 inventory.id로 대응. 공연장 문자열이나 A-01 코드만으로 공연장·재고를 잘못 합치지 않음 |
| 과거 정보 부재 | 원본에 없는 선점의 과거 좌석 목록·데모 시도·시간·요청 키를 추측해 추가하지 않음 |

운영 DB 전환은 원본 보존·일관 백업·새 파일 이관·회귀/복구 확인을 전제로 한다. 이력 테이블을 삭제하는 일반 CRUD는 제공하지 않으며 물리 FK 삭제 정책도 연쇄 이력 삭제를 허용하지 않는다.
