# 기능·테이블 CRUD와 트랜잭션

기본 웹 앱은 legacy Store, DB_SCHEMA=model 명시 선택은 [ModelStore](../../lib/model-store.mjs)를 사용한다. 아래 model 열은 기본 스키마와 관리자 이력을 포함한 [물리 모델](../data-model/physical.md)에 대응한다. 상태 전이·정합성·입장권은 [API 계약](api.md)을 따른다.

C=INSERT, R=SELECT, U=UPDATE, D=DELETE다. health/readiness를 제외한 API의 세션 조회(users/sessions R), 관리자 역할 조회(users R)는 공통이다. IP 제한은 세션 조회 전, 회원 제한은 인증 뒤 메모리만 변경한다. 공연/좌석/관리자 조회는 읽기 스냅샷이며 expire는 선점·확정·차단과 주기 정리에 남긴다. 예매 이력의 D는 일반 기능에 두지 않는다. [제한/폴링 경계](api.md)를 참조한다.

| 기능·operationId | 권한 | legacy CRUD | model CRUD | 경계 |
| --- | --- | --- | --- | --- |
| signup | 익명/기존 세션 CSRF | users CR; sessions CD | users CR; sessions CD | 비밀번호 해시는 await 후 회원 INSERT, 세션 교체는 별도 짧은 트랜잭션. 전체 가입+로그인이 한 트랜잭션인 것은 아님 |
| login | 익명/기존 세션 CSRF | users R; sessions CD | users R; sessions CD | 해시 검증은 트랜잭션 밖. 기존 삭제·만료 정리·새 세션 발급은 짧은 트랜잭션 |
| getSession | 공개/선택 쿠키 | users R; sessions R | users R; sessions R | 만료 세션은 응답에서 익명. 이 조회가 만료 세션을 삭제하는 것은 아님 |
| withdrawAccount | 로그인·본인·CSRF·비밀번호·동의 | users RU; sessions RD; holds RU; seats U; bookings RU; performances R | users RU; sessions RD; holds RU; current_holds D; bookings RU; performances R | 짧은 트랜잭션에서 시작 전 확정 예매 거부·전체 선점/세션 해제·회원/예매자 비식별화. 커밋 후 전체 본인 큐 제거. 금액·항목·결제 이력 보존 |
| logout | 로그인·CSRF | sessions D | sessions D | 현재 쿠키의 세션만 삭제 |
| listConcerts | 공개 | concerts R; performances R; seats R; holds R; performance_sales_events R | concerts R; performances R; venues R; inventory R; holds R; current_holds R; current_bookings R; performance_sales_events R | BEGIN + SELECT, 유효 선점만 잔여석 계산. 물리 만료 정리 없음 |
| getSeats | 공개/본인 표시 | performances R; concerts R; holds R; seats R; performance_sales_events R | performances R; concerts R; venues R; physical_seats R; inventory R; holds R; current_holds R; current_bookings R; performance_sales_events R | BEGIN + SELECT의 한 시각/스냅샷. 만료된 연결은 논리적으로 제외, 판매는 쓰기에서 재검증 |
| replaceHold | 로그인·본인·CSRF | holds CRU; seats RU; bookings R; booking_seats R; performances R; concerts R; member_booking_restrictions R; performance_sales_events R | holds CRU; current_holds CRD; inventory R; bookings R; booking_items R; current_bookings R; performances R; concerts R; venues R; physical_seats R; member_booking_restrictions R; performance_sales_events R | 비어 있지 않은 요청은 예매 오픈·제한 여부·입장권 검사. 빈 배열은 입장권 없이 해제, 커밋 뒤 메모리 pin 갱신 |
| expire / timer | 서버 내부 | holds RU; seats U | holds RU; current_holds RD | 5초 배치 또는 쓰기 트랜잭션 안. 기준 시각 한 번·연결 해제 후 만료·전체 롤백 |
| createBooking | 로그인·본인 hold·CSRF | holds RU; seats RU; bookings CR; booking_seats CR; performances R; concerts R; admin_booking_cancellations R; member_booking_restrictions R; performance_sales_events R; performance_cancelled_bookings R | holds RU; current_holds RD; inventory R; bookings CR; booking_items CR; current_bookings C; payment_attempts CR; performances R; physical_seats R; concerts R; venues R; admin_booking_cancellations R; member_booking_restrictions R; performance_sales_events R; performance_cancelled_bookings R | 신규 확정은 같은 트랜잭션에서 매수·회차·예매 오픈·입장권·제한 여부 검사. 완료된 결과는 큐 밖 재반환. model 키의 성공/업무 실패 보존 유지 |
| listBookings | 로그인·본인 | bookings R; booking_seats R; performances R; concerts R; admin_booking_cancellations R; performance_sales_events R; performance_cancelled_bookings R | bookings R; holds R; booking_items R; inventory R; physical_seats R; performances R; concerts R; venues R; admin_booking_cancellations R; performance_sales_events R; performance_cancelled_bookings R | 예매 내역과 관리자 취소 사유 조회 |
| cancelBooking | 로그인·본인·CSRF | bookings RU; seats U; performances R; concerts R; booking_seats R; admin_booking_cancellations R; performance_sales_events R; performance_cancelled_bookings R | bookings RU; holds R; current_bookings RD; performances R; booking_items R; inventory R; physical_seats R; concerts R; venues R; admin_booking_cancellations R; performance_sales_events R; performance_cancelled_bookings R | 시작 전 전체 취소. 현재 연결만 해제하고 이력 보존. 반복은 R만 |
| adminSummary | 관리자 | users R; bookings R; performances R; concerts R; seats R; audit R; holds R; admin_booking_cancellations R; member_booking_restrictions R; performance_sales_events R | users R; bookings R; booking_items R; holds R; current_holds R; current_bookings R; inventory R; performances R; concerts R; audit_events R; admin_booking_cancellations R; member_booking_restrictions R; performance_sales_events R | 읽기 스냅샷에서 만료된 선점 제외·집계/감사 조회. DB 변경 없음 |
| adminChangePerformanceSales | 관리자·CSRF | users R; performances R; concerts R; holds RU; seats U; bookings RU; booking_seats R; performance_sales_events CR; performance_cancelled_bookings C | users R; performances R; concerts R; venues R; holds RU; current_holds D; bookings RU; current_bookings D; booking_items R; inventory R; physical_seats R; performance_sales_events CR; performance_cancelled_bookings C | 회차 상태와 기록을 커밋한다. 판매 중단·최종 취소는 같은 트랜잭션에서 선점을 해제하고 커밋 후 대기열을 제거한다. 최종 취소는 확정 예매 건수를 확인하고 예매를 일괄 취소한다. |
| adminGetBooking | 관리자 | bookings R; holds R; booking_seats R; performances R; concerts R; admin_booking_cancellations R; performance_sales_events R; performance_cancelled_bookings R | bookings R; holds R; booking_items R; inventory R; physical_seats R; performances R; concerts R; venues R; admin_booking_cancellations R; performance_sales_events R; performance_cancelled_bookings R | 예매번호로 조회하고 처리에 필요한 필드만 반환 |
| adminCancelBooking | 관리자·CSRF·확인 | bookings RU; holds R; seats U; performances R; concerts R; booking_seats R; admin_booking_cancellations CR; performance_sales_events R; performance_cancelled_bookings R | bookings RU; holds R; current_bookings RD; performances R; booking_items R; inventory R; physical_seats R; concerts R; venues R; admin_booking_cancellations CR; performance_sales_events R; performance_cancelled_bookings R | 시작 전 고객 요청에 따른 전체 취소. 좌석 해제·상태 갱신·취소 기록을 함께 커밋 |
| adminLookupMemberRestriction | 관리자·CSRF | users R; member_booking_restrictions R | users R; member_booking_restrictions R | 이메일이 일치하는 일반 회원과 최근 상태 조회 |
| adminSetMemberRestriction | 관리자·CSRF | users R; holds RU; seats U; member_booking_restrictions CR | users R; holds RU; current_holds D; member_booking_restrictions CR | 상태 변경 이력을 추가하고 제한 시 모든 선점을 해제. 커밋 후 그 회원의 대기열을 제거 |
| createConcert | 관리자·CSRF | concerts CR; performances CR; seats CR; audit C; performance_sales_events R | concerts CR; venues CR; physical_seats C; performances CR; inventory CR; audit_events C; performance_sales_events R | 모든 회차의 24시간 기준, 첫 회차 전 예매 오픈 시각, 중복 여부를 확인한 뒤 공연·장소·회차·좌석·감사를 같은 트랜잭션에서 생성 |
| adminGetSeatOccupant | 관리자 | seats R; bookings R; holds R; users R; performances R | inventory R; physical_seats R; current_holds R; current_bookings R; bookings R; holds R; users R; performances R | 한 좌석의 현재 점유만 읽기 스냅샷에서 확인. 만료 선점 제외, 회원 이름·이메일만 반환 |
| blockSeats | 관리자·CSRF | seats RU; holds RU; performances R; concerts R; audit C | inventory RU; holds RU; current_holds RD; current_bookings R; performances R; audit_events C | 만료 정리 후 전 좌석 검증·차단/해제·감사를 한 트랜잭션 |
| enterQueue | 로그인·본인·CSRF | performances R; concerts R; holds R; seats R; member_booking_restrictions R; performance_sales_events R | performances R; concerts R; venues R; holds R; current_holds R; member_booking_restrictions R; performance_sales_events R | 제한 여부·회차·예매 오픈·마감·유효 hold 확인 뒤 메모리 진입/복구. DB 쓰기 없음 |
| getQueue | 로그인·현재 세션 | member_booking_restrictions R; performance_sales_events R | member_booking_restrictions R; performance_sales_events R | 제한 여부 확인 후 메모리 상태를 반환. 다른 회원 식별/토큰 노출 안 함 |
| leaveQueue | 로그인·본인·CSRF | performances R; holds R; seats R | performances R; holds R; current_holds R | 본인 유효 hold 조회 뒤 메모리 이탈. DB 선점은 취소하지 않고 복구 정원 유지 |
| 내부 PerformanceQueue | 서버 내부 검증된 회차/회원만 | 업무 테이블 접근 없음 | 업무 테이블 접근 없음, 메모리 Map C/R/U/D | 순서·정원·입장률·토큰·pin 변경은 동기 처리. AdmissionService가 DB 조회/커밋과 연결 |
| health | 공개 | 없음 | 없음 | 세션·DB·일반 요청 예산을 사용하지 않고 생존만 확인 |
| readiness | 공개 | users R | users R | 읽기 스냅샷의 user_version·foreign_keys·users 조회. 종료 중/실패 503. 쓰기/전체 무결성 검사 없음 |
| 오프라인 migrate | 운영자 CLI·새 대상만 | legacy 전체 R, 원본 쓰기 없음 | 업무 전체 C; legacy_booking_imports C | 읽기 전용 원본 스냅샷 + 새 대상 데이터/최종 검증 트랜잭션. 기존 파일 덮어쓰기 금지 |

## 테이블별 보존·노출 정책

| model 테이블 | 생성·변경 주체 / 삭제 정책 |
| --- | --- |
| users | 가입·오프라인 이관. 역할은 초기 관리자 설정, 일반 body.role로 승격 불가. 본인 탈퇴는 정보 비식별화 U, ID/FK 이력은 보존. 관리자/시작 전 확정 예매는 거부. 일반 수정 API 없음 |
| sessions | 로그인/가입 시 발급·회전, 로그아웃/만료 시 D 허용. 탈퇴는 본인의 모든 세션 D. 외부 목록 API 없음 |
| venues | 관리자 공연 등록·이관. 일반 공개 CRUD 없음; 같은 이름 자동 병합 금지 |
| physical_seats | 관리자 등록·이관. 참조된 좌석 ID/코드/배치는 불변, 일반 D 없음 |
| concerts | 관리자 생성·공개 조회. 일반 수정/삭제 API 없음 |
| performances | 관리자 생성·공개 조회. 참조된 회차 식별/장소 불변, 일반 D 없음 |
| inventory | 관리자 생성·차단/해제, 회원은 조회/관계로 점유. 회차·물리 좌석 식별 불변 |
| holds | 본인 선택·서버 만료·확정으로 C/U, 이력은 D 금지. 외부 임의 상태 UPDATE 없음 |
| bookings | 본인 확정 C·전체 취소 U, D 금지. 금액/항목은 불변. 탈퇴 회원의 예매자 이름/전화만 지정 비식별 값으로 U 허용 |
| booking_items | 확정 시 C, 이후 U/D 금지. 재고 전체 이력 UNIQUE 금지 |
| current_holds | 선점 시 C, 변경·해제·만료·확정 시 D. UPDATE 대신 검증된 삭제/삽입 |
| current_bookings | 확정 시 C, 취소 시 D. 해당 예매 항목 복합 FK·재고 PK |
| payment_attempts | model 확정 성공 C/R, 선택 키가 있는 업무 실패는 롤백 뒤 별도 C. 키/해시 재반환·충돌 R, DB 장애는 실패 기록 안 함. 이력 U/D 금지 |
| audit_events | 관리자 변경과 함께 C, 관리자 요약 R. 이력 U/D 금지 |
| admin_booking_cancellations | 관리자 취소와 함께 C, 회원 예매·관리자 요약 R. 예매당 한 건, 일반 수정/삭제 API 없음 |
| member_booking_restrictions | 관리자 제한·해제 시 C. 최신 이력이 현재 상태. 사유는 관리자만 조회, 일반 수정/삭제 API 없음 |
| performance_sales_events | 회차 판매 중단·재개·최종 취소 기록. 회차별 최신 이력이 현재 상태 |
| performance_cancelled_bookings | 최종 공연 취소 때 취소된 예매와 그 회차의 처리 이력을 연결. 예매당 한 건 |
| legacy_booking_imports | 이관 도구만 C, 무결성 검사 R. 일반 API에서 생성/수정/삭제/노출 금지 |

DB 제약과 API 권한은 서로 대체하지 않는다. raw SQL로 current 관계만 지우고 COMMIT하는 경로는 안전한 API가 아니다. modelTransaction의 전체 스캔 검사는 오프라인 도구용이며 실제 요청마다 실행하지 않는다. 요청별 검증·원자성·제한 BUSY·큐/입장권은 [API 명세](api.md)를 따른다.
