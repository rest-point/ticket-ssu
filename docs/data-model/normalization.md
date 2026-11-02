# 함수 종속성과 정규화 근거

[논리 모델](logical.md)의 속성·후보키·도메인을 기준으로 정규화 근거를 설명한다. SQLite 실행 제약은 [물리 모델](physical.md)을 따른다.

## 함수 종속성의 범위

`X → Y`는 같은 X를 가진 두 행이 같은 Y를 가진다는 규칙이다. 현재 샘플 데이터에서 우연히 값이 같다는 이유로 종속성을 만들지 않는다. `R − K`는 릴레이션의 전체 속성에서 K를 뺀 집합이다. 후보키는 모든 속성을 결정하는 최소 집합이다.

아래 표는 각 릴레이션에서 사용하는 비자명한 키 기반 FD를 제시한다. PK 외 후보키도 빠뜨리지 않고 평가한다. 서로 다른 표의 동일한 컬럼명이 아니라, 그 릴레이션 안의 속성을 뜻한다.

| 릴레이션 | 후보키 K (각 집합) | FD |
| --- | --- | --- |
| users | id / email | 각 K → R − K |
| sessions | token_hash | K → R − K |
| venues | id | K → R − K |
| physical_seats | id / (venue_id, seat_code) / (venue_id, row_label, number) | 각 K → R − K |
| concerts | id | K → R − K |
| performances | id | K → R − K |
| inventory | id / (performance_id, physical_seat_id) | 각 K → R − K |
| holds | id | K → R − K |
| bookings | id / hold_id | 각 K → R − K |
| booking_items | (booking_id, inventory_id) | K → R − K |
| current_holds | inventory_id | K → hold_id |
| current_bookings | inventory_id | K → booking_id |
| payment_attempts | id / (hold_id, request_key) | 각 K → R − K |
| audit_events | id | K → R − K |

실제 속성으로 표현한 예:

```text
users: email -> id, name, phone, password_hash, role, created_at
physical_seats: venue_id, seat_code -> id, row_label, number
physical_seats: venue_id, row_label, number -> id, seat_code
inventory: performance_id, physical_seat_id -> id, grade, price, blocked
holds: id -> user_id, performance_id, expires_at, status
bookings: hold_id -> id, status, fee, buyer_name, buyer_phone, delivery, created_at, cancelled_at
booking_items: booking_id, inventory_id -> grade_snapshot, price_snapshot
payment_attempts: hold_id, request_key -> id, body_hash, result, amount, booking_id, failure_code, attempted_at
```

유일성이 전체 행의 규칙인지 부분집합의 규칙인지 구분한다. 다음은 무조건 성립하는 전체 FD·후보키로 취급하지 않는다.

- `holds.(user_id, performance_id)`는 active 부분집합의 UNIQUE이며 released/expired/converted 이력을 포함하면 한 회원·회차에 여러 행이 있다.
- `payment_attempts.booking_id`는 성공·비NULL 부분집합에서만 UNIQUE다. 실패는 booking_id가 NULL이므로 모든 행의 후보키가 아니다. 성공 부분집합에서는 booking_id가 그 부분집합의 키이며 hold·amount 등도 결정한다.
- `grade → price`, `seat_code → venue_id`, `name → user_id`, `buyer_phone → user_id`, `concert_id → venue_id`는 성립하지 않는다.
- `inventory_id → price_snapshot`이나 `inventory_id → grade_snapshot`를 항목 이력 전체의 불변 규칙으로 두지 않는다. 스냅샷은 해당 예매 확정 시점 값이다. 현재 API에 가격 변경 기능이 없다는 사실은 판매 이력의 영구 함수 종속성 근거가 아니다.

일반 FD 이론은 NULL이 없는 관계를 전제로 한다. 이 설계에서는 키는 모두 NOT NULL이며 nullable 속성은 선택적 사실로 해석한다. NULL 비교를 SQL의 등호처럼 취급해 증명하지 않는다. nullable UNIQUE는 조건부 유일성으로 별도 적었고 일반 후보키 증명에 사용하지 않았다. 결과별 CHECK·시각 범위·참조 일치 같은 조건 제약도 FD만으로 증명하지 않는다.

## 1NF: 좌석 목록을 행으로 표현

예매 한 행에 `seat1/seat2/seat3/seat4` 또는 판매 좌석 배열을 넣으면 반복 그룹과 좌석별 스냅샷·참조 검증이 어려워진다. 예매 항목을 `(booking_id, inventory_id, grade_snapshot, price_snapshot)`의 한 좌석 한 행으로 둔다. 전체 키는 `(booking_id, inventory_id)`이며 예매 전체의 1..4매 제한은 별도 집계 제약이다.

모든 스칼라 업무 속성은 한 도메인 값을 가진다. audit_events.detail은 판매 좌석 관계가 아닌 불변 사건 원문의 JSON 문서 값이다. 원문 내부의 배열을 예매 수량이나 FK로 사용하지 않는 범위에서 불투명 도메인 값으로 취급한다. 내부 대상별 관계 조회가 요구되면 감사 대상 릴레이션을 분해해야 하며, JSON을 쓴다는 이유만으로 그 내부까지 정규화됐다고 주장하지 않는다.

## 2NF: 복합 키 일부에만 의존하는 정보를 분리

반복을 제거한 예시 판매 명세를 다음과 같이 생각할 수 있다. 실제 새 테이블을 만드는 SQL은 아니다.

```text
sale_lines(booking_id, inventory_id, hold_id, booking_status, fee,
           buyer_name, buyer_phone, delivery, booked_at, cancelled_at,
           performance_id, physical_seat_id, grade, price, blocked,
           grade_snapshot, price_snapshot)
```

복합 키 `(booking_id, inventory_id)`에서 다음 부분 종속성을 분리한다.

- `booking_id → hold_id, booking_status, fee, buyer_name, buyer_phone, delivery, booked_at, cancelled_at`는 bookings로 분리한다.
- `inventory_id → performance_id, physical_seat_id, grade, price, blocked`는 inventory로 분리한다.
- 확정 시점 `grade_snapshot, price_snapshot`만 booking_items의 두 키 전체에 의존한다. 재고의 현재 price와 항목 가격을 섞지 않는다.

physical_seats의 복합 후보키도 점검한다. venue_id 하나는 여러 좌석을, seat_code 하나는 여러 공연장의 좌석을 가리킬 수 있다. `(venue_id, row_label, number)`의 어떤 진부분집합도 물리 좌석을 유일하게 결정하지 않는다. inventory의 `(performance_id, physical_seat_id)`도 회차 하나나 물리 좌석 하나만으로는 재고의 등급·가격을 결정하지 않는다.

재고에 venue_id를 복사하면 `performance_id → venue_id`가 복합 후보키 일부에서 비주요 속성으로 향하는 부분 종속성이 된다. 따라서 논리 모델은 venue_id를 inventory에 넣지 않고 부모 조인의 장소 일치를 X-01로 검증한다. 복합 FK를 만들기 위해 무조건 중복 컬럼을 추가하고 3NF라고 부르지 않는다.

## 3NF: 비키 속성을 거치는 전이 종속성 분리

회차·공연·장소·좌석 표시를 재고 명세에 같이 저장하면 다음 경로가 생긴다.

```text
inventory_id -> performance_id -> concert_id -> title, artist, description, theme, duration, age
inventory_id -> performance_id -> venue_id -> venue_name, region
inventory_id -> physical_seat_id -> seat_venue_id, seat_code, row_label, number
```

performances·concerts·venues·physical_seats로 분리하고 inventory에는 두 부모의 ID만 남긴다. seat_venue_id와 venue_name은 설명용 이름이며 실제 컬럼은 각각 physical_seats.venue_id와 venues.name이다. 두 venue_id가 같은지는 FD 분해가 아니라 X-01 참조 일치 제약이다.

현재 bookings.user_id / performance_id는 hold_id에서 구할 수 있다. 목표 bookings는 이 두 속성을 중복 저장하지 않고 holds를 정본으로 둔다. 현행 hold_id가 후보키라서 현행 bookings 하나만 보면 이 중복 자체가 3NF 위반이라고 단정할 수는 없다. 이번 분리는 여러 릴레이션에 같은 소유권 사실을 저장하는 갱신 위험과 일치 검사를 줄이기 위한 선택이다.

마찬가지로 inventory의 nullable hold_id / booking_id를 현재 관계 두 개로 분리한다. current_holds는 `inventory_id → hold_id`, current_bookings는 `inventory_id → booking_id`로 각 결정자가 키다. 상태별 참조 조건은 정규화가 자동 해결하지 않으므로 두 연결의 상호 배타성·회차·예매 상태를 X-02~X-05에서 강제한다.

3NF는 모든 비자명 FD `X → A`에서 X가 슈퍼키이거나 A가 어떤 후보키에 속하는 주요 속성이어야 한다. 표에 제시한 무조건 FD에서는 결정자가 모두 후보키이므로 14개 릴레이션은 이 FD 집합에 대해 3NF를 만족하며 BCNF 조건도 만족한다. 이는 완성된 SQL이 모든 의미 제약을 강제한다는 증명이 아니다. 새 업무 FD가 확인되면 정규형 판정을 다시 해야 한다.

## 스냅샷과 계산값 저장의 경계

| 값 | 논리 모델 결정·정합성 근거 |
| --- | --- |
| 예매자 이름·전화 | bookings에 저장. 현재 회원 프로필의 복사본이 아니라 해당 주문에 입력한 사실. user_id → buyer_name 같은 FD는 없음 |
| 판매 당시 등급·가격 | booking_items에 저장. `(booking_id, inventory_id)`로 결정. 확정 시 서버가 재고에서 읽어 복사하고 이후 불변 |
| 좌석 코드 | 이력이 참조하는 물리 좌석의 코드가 불변이므로 JOIN으로 구함. 별도 snapshot 컬럼을 추가하면 이 정책하에서 inventory_id만으로 결정되는 중복이므로 저장하지 않음 |
| 수수료 합계 | bookings.fee로 저장. 장당 2,000원 정책의 당시 합계 보존. 키로 결정되는 스냅샷이며 취소 후 원본 금액 유지 |
| ticket_total | 항목 가격 합계로 계산. 별도 저장하면 자식 집계와의 중복 일치 조건이 필요하므로 제거 |
| total | 파생 ticket_total + fee로 계산. 두 값을 함께 저장하면 `(ticket_total, fee) → total`이 키가 아닌 결정자에서 생기는 FD이므로 모두 저장하고 무조건 3NF라고 하지 않음 |
| 결제 시도 amount | 데모 요청 결과 당시 서버가 계산한 금액. 성공 시 예매 합계와 일치, 실패 시 NULL 가능. 단순 현재 예매 total 캐시가 아닌 시도 사실이며 성공 연결의 일치는 별도 제약 |

SUM·COUNT와 fee 정책은 한 릴레이션의 FD가 아니라 여러 행·릴레이션에 걸친 집계 조건이다. X-06~X-09와 짧은 확정 트랜잭션으로 검증한다. 같은 가격인 좌석이 많다는 사실은 스냅샷 가격이 키라는 뜻이 아니다. 취소 시 스냅샷을 0원으로 바꾸거나 최신 가격으로 덮어쓰지 않는다.

## 무손실 분해

이항 분해 `R → R1, R2`에서 공통 속성 `R1 ∩ R2`가 FD 폐포상 R1 또는 R2 전체를 결정하면 분해는 무손실이다. 아래는 실제 업무 속성으로 같은 기준을 적용한 예다. 오른쪽 속성 집합에 공통 키가 포함된다.

| 예시 분해 | 공통 속성 | 공통 속성이 결정하는 쪽 |
| --- | --- | --- |
| sale_lines → bookings 정보 / 나머지 판매 명세 | booking_id | 예매 헤더 전체 |
| 나머지 명세 → inventory 정보 / booking_items | inventory_id | 재고 속성 전체 |
| 확장 회차 명세 → performances / concerts 정보 | concert_id | 공연 속성 전체 |
| 확장 회차 명세 → performances / venues 정보 | venue_id | 공연장 속성 전체 |
| 확장 재고 명세 → inventory / physical_seats 정보 | physical_seat_id | 물리 좌석 속성 전체 |
| 확장 예매 명세 → bookings / holds 정보 | hold_id | 선점·회원·회차 정보 전체 |

각 단계가 이 기준을 만족하므로 해당 판매 명세의 순차 분해는 무손실이다. 이는 명세에 참여한 행의 재조합에 관한 설명이다. 예매 없는 회원·좌석이나 실패 결제 시도까지 모든 테이블을 INNER JOIN하면 보존된다는 주장은 하지 않는다. 선택적 관계는 LEFT JOIN 또는 개별 조회가 필요하고 원래부터 별도 생성 가능한 부모 데이터는 별도로 보존한다.

원래 inventory의 두 nullable 점유 포인터를 제거하는 분리는 위 필수 부모 조인과 다르다. 각 비NULL 포인터를 해당 current 행으로 사상하고 없는 관계는 행 부재로 표현한다. inventory를 기준으로 두 current 관계를 LEFT JOIN하면 원래 포인터를 복원할 수 있다. 각 current.inventory_id의 PK가 중복 행 확장을 막고 X-02가 원래 상호 배타성을 유지한다. 단순 INNER JOIN에 대한 무손실 증명으로 대신하지 않는다.

## 종속성 보존과 별도 의미 제약

각 릴레이션의 후보키 FD는 그 릴레이션 안에 모두 남아 PK·UNIQUE로 검증할 수 있다. 공연 ID가 공연 속성을, 회차 ID가 공연·공연장·시작을, 물리 좌석 ID가 장소·코드를 결정하는 FD도 각 부모 안에 남는다. 공통 키를 통해 원래 판매 명세의 전이 FD를 추론할 수 있으므로 제시한 키 기반 FD 분해는 종속성을 보존한다.

다만 일반 정규화만으로 다음 제약이 보존·강제되는 것은 아니다. 부모 존재는 FK로, 나머지는 논리 모델의 X 규칙과 트리거·트랜잭션으로 보완한다.

- 회차의 공연장과 물리 좌석 공연장이 같아야 한다는 두 경로 일치.
- 선점·예매 항목·현재 점유·데모 성공 시도가 같은 회차·원본 선점을 가리키는 제약.
- confirmed 예매의 1..4항목, 회원·회차별 4매, fee·항목·시도 금액의 합계 일치.
- 선점 7분·시각 경계·선택 변경 만료 유지·마감·취소 원자성.
- 모든 이력의 보존, 현재 관계 두 개의 상호 배타성, 신규 예매의 성공 시도 존재.

audit_events.detail 내부를 정규화하거나 일반 FK로 만들었다고 가정하지 않는다. 현행 감사 원문 보존이라는 한정된 목적의 문서 도메인이며 내부 관계 종속성은 이 증명의 대상이 아니다.

## 정규화 검사 범위

[검사기](../../scripts/check-model.mjs)는 문서의 FD·후보키 표를 읽어 폐포/최소성·3NF·부모 유일키·6개 분해의 공통 속성 결정 조건을 검사한다. npm run check:model로 실행하며 DB에 연결하지 않는다.

계산은 선언된 FD 집합 안의 기호 검증이다. 모든 업무 FD의 완전성·NULL의 일반 이론·실제 DB 정합성을 증명하지 않는다. partial/nullable UNIQUE는 전체 후보키로 세지 않으며 감사 JSON 내부는 범위 밖이다. 같은 공연장/회차·현재 점유 상호 배타성·금액/시도 일치는 X-01~X-09와 트리거·트랜잭션으로 보완한다.
