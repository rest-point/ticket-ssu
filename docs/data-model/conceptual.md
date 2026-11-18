# 개념 데이터 모델

개념 ERD·업무 규칙·카디널리티를 정의한다. 단일 Node API·로컬 SQLite를 사용한다.

이 문서는 별도 model 저장 모델을 설명한다. 기본 legacy는 기존9개 테이블을 유지하며 model은 별도 DB_PATH/DB_SCHEMA로 명시 선택한다. 실제 저장 제약은 [논리 모델](logical.md)·[정규화](normalization.md)·[물리 모델](physical.md)을 따른다.

## 업무 범위와 용어

단일 호스트·단일 Node.js API 프로세스·로컬 SQLite에서 회원 인증, 공연·회차·좌석 관리, 선점, 데모 예매 확정, 전체 취소, 관리자 변경 이력을 다룬다. PostgreSQL·Redis·대체 외부 DB·캐시·메시지 브로커·다중 API 배포는 도입하지 않는다. 실제 PG 청구·환불·본인인증·실제 입장용 발권은 범위 밖이다.

| 용어 | 의미 |
| --- | --- |
| 회원 (USER) | 예매 주체. 관리자는 별도 사람이 아니라 관리자 역할을 가진 회원 |
| 세션 (SESSION) | 로그인 인증 상태. 한 회원이 여러 기기·탭에서 사용할 수 있음 |
| 공연 (CONCERT) | 제목·아티스트·소개 등 콘텐츠. 관람 일시를 가진 회차와 구분 |
| 회차 (PERFORMANCE) | 특정 공연을 특정 공연장에서 특정 시각에 진행하는 판매 단위 |
| 공연장 (VENUE) | 물리 좌석 배치가 속한 장소. 이름 문자열만으로 동일 장소임을 자동 단정하지 않음 |
| 물리 좌석 (PHYSICAL_SEAT) | 공연장의 열·번호·표시 코드로 식별하는 실제 위치. A-01 같은 코드는 공연장 안에서만 유일 |
| 회차별 좌석 재고 (INVENTORY) | 한 회차에서 한 물리 좌석을 판매하는 단위. 가격·등급·차단·현재 점유 관계를 가짐 |
| 선점 (HOLD) | 회원이 한 회차의 좌석 묶음을 제한 시간 동안 확보하는 행위와 상태 |
| 예매 (BOOKING) | 한 회원·한 회차의 데모 확정 거래와 취소 이력. 회원 정보와 별개로 예매자 정보를 보존 |
| 예매 항목 (BOOKING_ITEM) | 예매에 포함된 좌석 한 장과 확정 당시 등급·가격 스냅샷 |
| 데모 결제 시도 (PAYMENT_ATTEMPT) | 유효한 회원·선점에 연결된 데모 확정 시도의 결과. 실제 금전 이동을 뜻하지 않음 |
| 감사 기록 (AUDIT_EVENT) | 관리자 좌석 차단·해제·공연 등록 등의 행위자·대상·시각 기록 |
| 입장권 | 회차 대기열의 API 접근 권한. 예매 항목이나 실제 입장용 티켓과 구분 |

회원·공연·회차·장소·좌석·선점·예매·결제 시도·감사 기록은 영속 데이터다. 대기열·입장권·제한 카운터는 단일 프로세스의 메모리 상태이며 ERD에 큐 테이블을 추가하지 않는다. 재시작 때 DB 유효 선점/예매는 보존하고 일반 큐는 재진입한다. 보호 API와 복구 정책은 [API 명세](../design/api.md)를 따른다.

## 엔터티와 주요 속성

속성은 업무상 필요한 정보의 개념이며 실제 컬럼명·타입·저장 여부를 확정하지 않는다. 그림의 string/int는 읽기 편의를 위한 표기다. 금액은 원 단위 정수, 저장 시각은 UTC epoch milliseconds, 화면 표시는 Asia/Seoul 원칙을 이어간다.

| 엔터티 | 식별 개념 | 주요 정보·생명주기 |
| --- | --- | --- |
| USER | 회원 ID, 정규화된 이메일 | 이름·전화번호·비밀번호 해시·역할·가입 시각. 탈퇴는 개인 정보를 비식별화하고 로그인 불가 처리. 이력을 참조하는 회원 ID와 예매는 보존 |
| SESSION | 세션 토큰 해시 | 회원·CSRF 값·만료 시각. 원문 인증 토큰은 DB에 저장하지 않으며 로그아웃·만료로 제거 가능 |
| CONCERT | 공연 ID | 제목·아티스트·소개·테마·관람 시간·관람 등급. 장소는 회차를 통해 결정 |
| VENUE | 공연장 ID | 명칭·표시용 지역. 초기에는 기존 장소 문자열을 보존하며 실제 동일 장소의 통합은 검토 후 결정 |
| PHYSICAL_SEAT | 공연장과 좌석 코드 | 열·번호·표시 코드. 판매 가격이나 점유 상태를 갖지 않음 |
| PERFORMANCE | 회차 ID | 공연·공연장·시작 시각. 재고가 생성된 뒤 장소를 바꿔 기존 좌석 연결을 무효화하지 않음 |
| INVENTORY | 회차와 물리 좌석 | 등급·원 단위 가격·판매 차단 여부·현재 선점 또는 현재 예매. 회차 안에서 같은 좌석은 한 번만 존재 |
| HOLD | 선점 ID | 회원·회차·만료 시각·상태. 선택 변경 시 ID 교체와 기존 만료 시각 유지 |
| BOOKING | 예매 ID와 원본 선점 | 회원·회차·확정/취소 상태·티켓 합계·수수료·총액·예매자 이름/전화·수령 방식·생성/취소 시각 |
| BOOKING_ITEM | 예매와 좌석 재고 | 불변 좌석 코드 연결·확정 당시 등급·가격. 취소 후에도 보존하며 재고의 새 가격으로 덮어쓰지 않음 |
| PAYMENT_ATTEMPT | 데모 시도 ID | 선점·결과·시도 시각·서버 계산 금액(계산 가능 시)·성공한 예매 연결. request_key·body_hash·succeeded/failed·failure_code를 저장하고 키/결과를 보존 |
| AUDIT_EVENT | 감사 기록 ID | 관리자 회원·동작·대상 식별 정보·상세·발생 시각. 비밀번호·토큰·불필요한 개인정보는 기록하지 않음 |

## 개념 ERD

`||`는 정확히 1, `o|`/`|o`는 0 또는 1, `o{`는 0 이상, `|{`는 1 이상이다. 최대 4개, 상태별 참여 조건, 회차·공연장 일치 같은 제약은 뒤의 표와 업무 규칙으로 보완한다. 선점과 예매에서 재고로 향하는 current 관계는 **현재 점유**이며 영구적인 구매 이력은 BOOKING_ITEM으로 나타낸다.

```mermaid
erDiagram
    USER {
        string user_id
        string email
        string role
    }
    SESSION {
        string token_hash
        int expires_at
    }
    CONCERT {
        string concert_id
        string title
        string artist
    }
    VENUE {
        string venue_id
        string name
    }
    PHYSICAL_SEAT {
        string seat_code
        string row_label
        int number
    }
    PERFORMANCE {
        string performance_id
        int starts_at
    }
    INVENTORY {
        string inventory_identity
        string grade
        int price
        int blocked
    }
    HOLD {
        string hold_id
        string status
        int expires_at
    }
    BOOKING {
        string booking_id
        string status
        int ticket_total
        int fee
        int total
        int cancelled_at
    }
    BOOKING_ITEM {
        string item_identity
        string seat_display
        string grade_snapshot
        int price_snapshot
    }
    PAYMENT_ATTEMPT {
        string attempt_id
        string result
        int attempted_at
        int amount
    }
    AUDIT_EVENT {
        string event_id
        string action
        string target
        int created_at
    }

    USER ||--o{ SESSION : authenticates
    CONCERT ||--|{ PERFORMANCE : schedules
    VENUE ||--o{ PERFORMANCE : hosts
    VENUE ||--o{ PHYSICAL_SEAT : contains
    PERFORMANCE ||--|{ INVENTORY : offers
    PHYSICAL_SEAT ||--o{ INVENTORY : offered_in
    USER ||--o{ HOLD : owns
    PERFORMANCE ||--o{ HOLD : scopes
    HOLD |o--o{ INVENTORY : currently_holds
    USER ||--o{ BOOKING : purchases
    PERFORMANCE ||--o{ BOOKING : scopes
    HOLD ||--o| BOOKING : converts_to
    BOOKING ||--|{ BOOKING_ITEM : includes
    INVENTORY ||--o{ BOOKING_ITEM : history_of
    BOOKING |o--o{ INVENTORY : currently_owns
    HOLD ||--o{ PAYMENT_ATTEMPT : attempted_for
    BOOKING |o--o| PAYMENT_ATTEMPT : completed_by
    USER ||--o{ AUDIT_EVENT : performs
```

## 관계의 카디널리티와 선택성

| 관계 | 한쪽에서 본 참여 수 | 반대쪽의 필수성·추가 제약 |
| --- | --- | --- |
| USER → SESSION | 회원당 0..N 세션 | 세션은 정확히 1명에 속함. 로그아웃해도 회원은 남음 |
| CONCERT → PERFORMANCE | 공연당 1..N 회차 | 회차는 정확히 1개 공연. 현재처럼 공연 등록과 회차 생성을 함께 완료하며 임시 초안 공연은 이번 모델에서 다루지 않음 |
| VENUE → PERFORMANCE | 공연장당 0..N 회차 | 회차는 정확히 1개 공연장에서 진행 |
| VENUE → PHYSICAL_SEAT | 공연장당 0..N 좌석 | 물리 좌석은 정확히 1개 공연장. 판매 회차 등록에는 좌석이 있어야 함 |
| PERFORMANCE → INVENTORY | 회차당 1..N 재고 | 재고는 정확히 1개 회차. 현재 생성 규칙은 96개 |
| PHYSICAL_SEAT → INVENTORY | 물리 좌석당 0..N 재고 | 재고는 정확히 1개 물리 좌석. 서로 다른 회차에서 같은 위치를 판매할 수 있음 |
| USER → HOLD | 회원당 이력 포함 0..N 선점 | 선점은 정확히 1명. 회원·회차별 유효한 active 선점은 최대 1개 |
| PERFORMANCE → HOLD | 회차당 0..N 선점 | 선점은 정확히 1개 회차 |
| HOLD → INVENTORY (current) | 선점당 0..4개 재고 | 재고의 현재 선점은 0..1개. 유효한 active는 1..4개, released/expired/converted는 0개 |
| USER → BOOKING | 회원당 이력 포함 0..N 예매 | 예매는 정확히 1명 소유. 예매자 이름이 소유 회원과 달라도 권한은 소유 회원 기준 |
| PERFORMANCE → BOOKING | 회차당 0..N 예매 | 예매는 정확히 1개 회차. 다른 회차 항목 혼합 금지 |
| HOLD → BOOKING | 선점당 0..1 예매 | 예매는 정확히 1개 원본 선점. 취소해도 같은 선점으로 새 예매를 생성하지 않음 |
| BOOKING → BOOKING_ITEM | 예매당 1..4 항목 | 항목은 정확히 1개 예매. 한 예매에서 같은 재고 중복 금지 |
| INVENTORY → BOOKING_ITEM (history) | 재고당 이력 포함 0..N 항목 | 항목은 정확히 1개 재고. 취소 후 다른 예매의 항목으로 다시 등장 가능 |
| BOOKING → INVENTORY (current) | 예매당 0..4 재고 | 재고의 현재 예매는 0..1개. confirmed는 본인 항목 1..4개를 점유하고 cancelled는 0개 |
| HOLD → PAYMENT_ATTEMPT | 선점당 0..N 데모 시도 | 시도는 정확히 1개 선점에 속함. 회원·회차는 선점으로 결정; 타인 선점·존재하지 않는 선점 요청은 이 관계를 만들지 않음 |
| BOOKING ↔ PAYMENT_ATTEMPT | 양쪽 모두 0..1 연결 | 새 예매에는 성공 시도 1개, 성공 시도에는 예매 1개. 실패 시도는 예매 없음. 기존 예매는 결제 시도 기록 부재로 연결이 없을 수 있음 |
| USER → AUDIT_EVENT | 회원당 0..N 기록 | 현재 범위의 감사 기록은 정확히 1명의 관리자 행위자. 대상은 action별 detail JSON의 공연·회차/좌석 식별 정보. user_id는 회원 FK이고 대상 전체를 포괄하는 범용 FK는 없음 |

0..N 이력과 현재 점유 0..1을 혼동하지 않는다. 재고를 동시에 선점과 확정 예매가 점유할 수 없고 차단 재고는 어느 쪽도 점유할 수 없다. active 상태가 DB에 남아 있어도 `expires_at <= server_now`이면 유효 선점이 아니며 변경 트랜잭션에서 만료를 정리한다.

## 업무 규칙과 구현 대조

| ID | 현재 업무 규칙 | 구현 근거·legacy/model 차이 |
| --- | --- | --- |
| BR-01 | 회차·선점·예매 항목의 회차가 일치하고 물리 좌석은 회차 공연장에 속함 | model은 venues/physical_seats/inventory와 복합 FK·트리거로 검사. legacy는 회차별 seats를 사용 |
| BR-02 | 재고의 현재 소유자는 선점1개 또는 예매1개이며 blocked이면 점유 없음 | legacy seats CHECK, model current_holds/current_bookings PK·상호 배타 트리거와 요청 검증 |
| BR-03 | 최초 선점7분, 선택 변경 시 새 ID·기존 만료 유지·옛 ID released | 두 Store의 setHold가 같은 트랜잭션에서 교체. 시각 경계는 서버 기준으로 재검사 |
| BR-04 | 회원/회차의 확정 좌석+유효 선점 합계는 최대4매 | 두 Store의 setHold와 checkout 모두 짧은 쓰기 트랜잭션 안에서 한도/회차 재검사 |
| BR-05 | 묶음 선점·만료·확정·전체 취소는 전부 성공하거나 롤백 | BEGIN IMMEDIATE·동기 거래 콜백. model은 조건부 변경 행 수도 검사하고 실패 시 롤백 |
| BR-06 | 신규 선점/확정·최초 취소·차단 변경은 공연 시작 전만 허용 | openPerformance와 요청 시각 재검사. 완료된 확정/취소 재시도는 기존 결과를 반환할 수 있음 |
| BR-07 | 좌석 가격과 장당2,000원 수수료는 서버 계산, 합계는 항목 합+수수료 | model은 항목 스냅샷/fee 보존·booking_totals 파생 조회, legacy는 당시 합계/수수료와 항목 가격 보존 |
| BR-08 | 한 hold당 예매는 최대1개, 재시도는 기존 결과이며 취소를 되살리지 않음 | bookings.hold_id UNIQUE. model 선택 키는 본문 해시/충돌/영속 결과를 검사하고 legacy는 키 헤더를 거부 |
| BR-09 | 시작 전 전체·전액 데모 취소, 항목/금액/취소 시각 보존 | 두 Store의 cancel이 현재 점유만 해제. 부분 취소·실제 외부 환불은 없음 |
| BR-10 | 취소/재판매 이력은 여러 건 가능하되 현재 중복 판매는 금지 | model booking_items는 예매+재고 PK, current_bookings는 재고 PK. legacy는 booking_seats 이력과 seats.booking_id 분리 |
| BR-11 | 신규 model 예매·성공 시도·선점·항목/재고 전환은 같은 소유/회차로 원자 처리 | checkout은 succeeded를 같은 거래에 저장. 업무 실패는 롤백 뒤 별도 failed 기록, 입력/인증/DB 장애는 제외. legacy에는 별도 시도 테이블 없음 |
| BR-12 | 판매/이력과 연결된 회차·좌석 식별을 바꾸거나 이력을 연쇄 삭제하지 않음 | model RESTRICT FK·불변 식별/이력 트리거, 보존 이관은 ID/금액/취소/세션을 유지하며 없는 과거 사실을 만들지 않음 |
| BR-13 | 관리자만 공연 등록·가용 좌석 차단/해제, 변경과 감사를 함께 저장 | requireAdmin·createConcert/blockSeats·recordAudit를 같은 거래에 연결. 시스템 행위자/범용 대상 FK는 제공하지 않음 |
| BR-14 | SQLite가 판매 최종 원본이며 큐 입장/화면 표시가 좌석 확보를 보장하지 않음 | PerformanceQueue·AdmissionService의 FIFO/세션 입장권·재시작 복구를 HTTP와 연결. 새 쓰기는 DB에서 재검증하고 단일 writer 한계 유지 |
| BR-15 | 각 회차는 등록부터 최소 24시간 뒤 시작한다. 동일한 기존 공연의 모든 회차가 최종 취소된 경우에는 재등록할 수 있다. | 두 모드가 공연명·아티스트·장소·소개·S석 기본가와 전체 회차 시각을 비교한다. 예매 오픈 시각만 바꿔도 중복이며, 오픈 시각이 되기 전에는 신규 예매를 차단한다. |
| BR-16 | 관리자는 점유 회원 조회, 예매 대리 취소, 회원 예매 제한·해제를 수행 | 대리 취소는 예매 전체에 적용하고 이력을 보존한다. 제한 시 새 예매를 차단하고 대기열·선점을 정리한다. |
| BR-17 | 일시 중단만 재개할 수 있으며 최종 취소한 회차는 공개 목록에서 숨김 | 회차별 판매 이력으로 상태를 결정한다. 최종 취소 시 확정 예매를 일괄 취소하고 원래 거래 기록을 보존한다. |

## legacy 테이블과 model 개념의 대응

| legacy 테이블 | model 개념 | 보존·호환 방식 |
| --- | --- | --- |
| users / sessions | USER / SESSION | 회원 ID·비밀번호 해시·세션을 보존. 세션과 큐 입장권은 서로 다른 개념 |
| concerts | CONCERT + VENUE | 공연 ID·속성 유지. 기존 venue 문자열을 잃지 않고 회차의 장소로 대응. 동일 문자열만 보고 다른 공연의 좌석을 자동 병합하지 않음 |
| performances | PERFORMANCE | 회차 ID·공연·시작 시각 유지, 회차별 공연장 연결 추가 |
| seats | PHYSICAL_SEAT + INVENTORY | `(performance_id,id)` 기존 좌석 식별과 코드 유지. 같은 공연장임을 확인한 좌석만 공유 물리 좌석에 대응. 현재 API의 A-01 등 seatIds는 내부 ID와 분리해 호환 |
| holds | HOLD | 기존 상태·소유자·회차·만료 시각 보존. 현재 재고 연결이 사라진 released/expired 선점의 과거 좌석 목록은 복원할 수 없으며 만들지 않음 |
| bookings | BOOKING | 예매 ID·원본 hold·상태·총액·수수료·예매자·시각 유지. 과거 예매의 결제 시도 연결은 선택적 |
| booking_seats | BOOKING_ITEM | 기존 예매·좌석 코드·등급·가격 스냅샷 유지. 회차는 예매를 통해 식별, 대응 재고를 검증한 뒤 연결. 확정 당시 좌석 표시는 기존 코드로 보존 |
| 별도 테이블 없음 | PAYMENT_ATTEMPT | model 신규 데모 확정에서 기록. 이관한 기존 예매의 과거 시각·요청 키·실패 내역은 추측해 생성하지 않음 |
| audit | AUDIT_EVENT | 관리자 회원·동작·상세·시각 유지. 기존 detail JSON과 행위자/동작/시각을 그대로 보존 |

model 스키마는 회차별 venue_id/재고 가격을 표현한다. 현재 createConcert는 공연마다 새 venue와 물리 좌석96개를 만들고 입력한 장소를 그 공연의 모든 신규 회차에 연결한다. 기존 UI/JSON의 단일 장소·가격 표시를 유지하며, 회차별 서로 다른 장소를 입력하는 기능은 제공하지 않는다.

현재 생성 좌석은 A~H열 × 12석이며 VIP 24석 / R 36석 / S 36석이다. 현재 가격은 S 기본가, R +20,000원, VIP +40,000원이다. 이 규칙은 회차 재고 생성 규칙으로 두며 물리 좌석의 고정 가격이나 공연장 전체의 영구 등급으로 옮기지 않는다.

## 모델의 정합성 사례

| 사례 | 모델상 기대 결과 |
| --- | --- |
| 같은 공연장 A-01을 금요일·토요일 회차에서 판매 | 물리 좌석은 공유 가능하지만 재고는 회차별 2개. 서로의 선점·예매에 영향 없음 |
| 다른 공연장에도 A-01 존재 | 물리 좌석과 재고는 서로 별개. 좌석 코드만으로 연결하지 않음 |
| 확정 3매인 회원이 같은 회차에서 2석 선택 | BR-04에 따라 전체 거부. 한 석만 임의 성공시키지 않음 |
| 선택 1분 뒤 다른 좌석으로 교체 | 새 hold ID, 최초 만료 시각 유지. 이전 ID 주문은 거부 |
| 공연 시작 시각에 도달한 유효 hold로 신규 확정 | BR-06에 따라 거부. 이미 완료된 예매 재시도만 기존 결과 반환 |
| 예매 A 취소 후 같은 재고를 예매 B로 재판매 | 이력 항목은 A·B 두 개, 현재 재고 소유는 B 하나. A는 취소 상태로 보존 |
| 같은 hold의 확정 응답 유실 후 재시도 | 예매와 성공 결제 시도 재사용. 추가 성공 시도나 신규 예매를 만들지 않음 |
| 기존 예매를 데이터 보존 마이그레이션 | 항목·금액·소유권·취소 상태 보존. 결제 시도 연결 0개 허용, 가짜 과거 시도 생성 금지 |

위 사례는 업무 규칙의 설계 설명이다. 실제 예매·대기열·권한 계약은 [API 명세](../design/api.md)를 따른다.

이 그림의 12개 기본 업무 엔터티는 현재 점유를 두 연결 릴레이션으로 분리한 14개 기본 업무 릴레이션으로 구체화된다. 실제 model은 관리자 운영 이력 4개와 이관 출처 1개를 포함해 총 19개 테이블이다. 그림의 seat_display는 이력이 참조하는 불변 물리 좌석 코드에서 구하는 파생 표시다. ticket_total과 total도 보존된 항목 가격·수수료에서 구하는 파생 값이며, 현재 API는 기존 공개 ID/JSON을 유지하며 model의 보존된 항목/수수료에서 금액을 계산한다.

ModelStore의 현재 점유·이력·성공 시도 일치는 FK만으로 해결되지 않는다. X-01~X-09·트리거·짧은 트랜잭션을 함께 적용한다.
