# 기능·테이블 CRUD와 트랜잭션

기본 웹 앱은 legacy 9개 테이블, DB_SCHEMA=model 명시 선택은 [ModelStore](../../lib/model-store.mjs)를 사용한다. 아래 model 열은 [물리 DDL](../../db/migrations/001_model.sql) 대응이다. model 키·BUSY·큐 HTTP/입장권·health/readiness를 연결했다. 상태 전이·정합성·입장권은 [API 계약](api.md)을 따른다.

C=INSERT, R=SELECT, U=UPDATE, D=DELETE다. health/readiness를 제외한 API의 세션 조회(users/sessions R), 관리자 역할 조회(users R)는 공통이다. IP 제한은 세션 조회 전, 회원 제한은 인증 뒤 메모리만 변경한다. 공연/좌석/관리자 조회는 읽기 스냅샷이며 expire는 선점·확정·차단과 주기 정리에 남긴다. 예매 이력의 D는 일반 기능에 두지 않는다. [제한/폴링 경계](api.md)를 참조한다.

| 기능·operationId | 권한 | legacy CRUD | model CRUD | 경계 |
| --- | --- | --- | --- | --- |
| signup | 익명/기존 세션 CSRF | users CR; sessions CD | users CR; sessions CD | 비밀번호 해시는 await 후 회원 INSERT, 세션 교체는 별도 짧은 트랜잭션. 전체 가입+로그인이 한 트랜잭션인 것은 아님 |
| login | 익명/기존 세션 CSRF | users R; sessions CD | users R; sessions CD | 해시 검증은 트랜잭션 밖. 기존 삭제·만료 정리·새 세션 발급은 짧은 트랜잭션 |
| getSession | 공개/선택 쿠키 | users R; sessions R | users R; sessions R | 만료 세션은 응답에서 익명. 이 조회가 만료 세션을 삭제하는 것은 아님 |
| logout | 로그인·CSRF | sessions D | sessions D | 현재 쿠키의 세션만 삭제 |
| listConcerts | 공개 | concerts R; performances R; seats R; holds R | concerts R; performances R; venues R; inventory R; holds R; current_holds R; current_bookings R | BEGIN + SELECT, 유효 선점만 잔여석 계산. 물리 만료 정리 없음 |
| getSeats | 공개/본인 표시 | performances R; concerts R; holds R; seats R | performances R; concerts R; venues R; physical_seats R; inventory R; holds R; current_holds R; current_bookings R | BEGIN + SELECT의 한 시각/스냅샷. 만료된 연결은 논리적으로 제외, 판매는 쓰기에서 재검증 |
| replaceHold | 로그인·본인·CSRF | holds CRU; seats RU; bookings R; booking_seats R; performances R; concerts R | holds CRU; current_holds CRD; inventory R; bookings R; booking_items R; current_bookings R; performances R; concerts R; venues R; physical_seats R | BEGIN IMMEDIATE 안에서 만료·매수·마감·묶음·일반 입장권 검사. 빈 배열은 입장권 없이 해제, 커밋 뒤 메모리 pin 갱신 |
| expire / timer | 서버 내부 | holds RU; seats U | holds RU; current_holds RD | 5초 배치 또는 쓰기 트랜잭션 안. 기준 시각 한 번·연결 해제 후 만료·전체 롤백 |
| createBooking | 로그인·본인 hold·CSRF | holds RU; seats RU; bookings CR; booking_seats CR; performances R; concerts R | holds RU; current_holds RD; inventory R; bookings CR; booking_items CR; current_bookings C; payment_attempts CR; performances R; physical_seats R; concerts R; venues R | 신규 확정은 같은 트랜잭션에서 매수·회차·일반/해당 hold 복구 입장권 검사. 완료된 결과는 큐 밖 재반환. model 키의 성공/업무 실패 보존 유지 |
| listBookings | 로그인·본인 | bookings R; booking_seats R; performances R; concerts R | bookings R; holds R; booking_items R; inventory R; physical_seats R; performances R; concerts R; venues R | 내부 booking_totals 뷰 사용 가능. 응답에는 현재 JSON 필드만 투영 |
| cancelBooking | 로그인·본인·CSRF | bookings RU; seats U; performances R; concerts R; booking_seats R | bookings RU; holds R; current_bookings RD; performances R; booking_items R; inventory R; physical_seats R; concerts R; venues R | 시작 전 전체 취소. 현재 연결만 해제하고 이력 보존. 반복은 R만 |
| adminSummary | 관리자 | users R; bookings R; performances R; concerts R; seats R; audit R; holds R | users R; bookings R; booking_items R; holds R; current_holds R; current_bookings R; inventory R; performances R; concerts R; audit_events R | 읽기 스냅샷에서 만료된 선점 제외·집계/감사 조회. DB 변경 없음 |
| createConcert | 관리자·CSRF | concerts C; performances C; seats C; audit C | concerts C; venues C; physical_seats C; performances C; inventory C; audit_events C | 미래 일시 검증 후 공연·장소·회차·좌석·감사를 함께 생성. 현재 입력은 장소 문자열 하나 |
| blockSeats | 관리자·CSRF | seats RU; holds RU; performances R; concerts R; audit C | inventory RU; holds RU; current_holds RD; current_bookings R; performances R; audit_events C | 만료 정리 후 전 좌석 검증·차단/해제·감사를 한 트랜잭션 |
| enterQueue | 로그인·본인·CSRF | performances R; concerts R; holds R; seats R | performances R; concerts R; venues R; holds R; current_holds R | 회차/마감·본인 유효 hold 조회 뒤 메모리 진입/복구·세션 결합. DB 쓰기 없음 |
| getQueue | 로그인·현재 세션 | 없음 | 없음 | 세션 조회 외 메모리 상태/기한/승격만, 다른 회원 식별/토큰 노출 안 함 |
| leaveQueue | 로그인·본인·CSRF | performances R; holds R; seats R | performances R; holds R; current_holds R | 본인 유효 hold 조회 뒤 메모리 이탈. DB 선점은 취소하지 않고 복구 정원 유지 |
| 내부 PerformanceQueue | 서버 내부 검증된 회차/회원만 | 업무 테이블 접근 없음 | 업무 테이블 접근 없음, 메모리 Map C/R/U/D | 순서·정원·입장률·토큰·pin 변경은 동기 처리. AdmissionService가 DB 조회/커밋과 연결 |
| health | 공개 | 없음 | 없음 | 세션·DB·일반 요청 예산을 사용하지 않고 생존만 확인 |
| readiness | 공개 | users R | users R | 읽기 스냅샷의 user_version·foreign_keys·users 조회. 종료 중/실패 503. 쓰기/전체 무결성 검사 없음 |
| 오프라인 migrate | 운영자 CLI·새 대상만 | legacy 전체 R, 원본 쓰기 없음 | 업무 전체 C; legacy_booking_imports C | 읽기 전용 원본 스냅샷 + 새 대상 데이터/최종 검증 트랜잭션. 기존 파일 덮어쓰기 금지 |

## 테이블별 보존·노출 정책

| model 테이블 | 생성·변경 주체 / 삭제 정책 |
| --- | --- |
| users | 가입·오프라인 이관. 역할은 초기 관리자 설정, 일반 body.role로 승격 불가. 수정/탈퇴 API 없음 |
| sessions | 로그인/가입 시 발급·회전, 로그아웃/만료 시 D 허용. 외부 목록/일괄 삭제 API 없음 |
| venues | 관리자 공연 등록·이관. 일반 공개 CRUD 없음; 같은 이름 자동 병합 금지 |
| physical_seats | 관리자 등록·이관. 참조된 좌석 ID/코드/배치는 불변, 일반 D 없음 |
| concerts | 관리자 생성·공개 조회. 일반 수정/삭제 API 없음 |
| performances | 관리자 생성·공개 조회. 참조된 회차 식별/장소 불변, 일반 D 없음 |
| inventory | 관리자 생성·차단/해제, 회원은 조회/관계로 점유. 회차·물리 좌석 식별 불변 |
| holds | 본인 선택·서버 만료·확정으로 C/U, 이력은 D 금지. 외부 임의 상태 UPDATE 없음 |
| bookings | 본인 확정 C·전체 취소 U, D 금지. 예매자/금액 스냅샷 수정 API 없음 |
| booking_items | 확정 시 C, 이후 U/D 금지. 재고 전체 이력 UNIQUE 금지 |
| current_holds | 선점 시 C, 변경·해제·만료·확정 시 D. UPDATE 대신 검증된 삭제/삽입 |
| current_bookings | 확정 시 C, 취소 시 D. 해당 예매 항목 복합 FK·재고 PK |
| payment_attempts | model 확정 성공 C/R, 선택 키가 있는 업무 실패는 롤백 뒤 별도 C. 키/해시 재반환·충돌 R, DB 장애는 실패 기록 안 함. 이력 U/D 금지 |
| audit_events | 관리자 변경과 함께 C, 관리자 요약 R. 이력 U/D 금지 |
| legacy_booking_imports | 이관 도구만 C, 무결성 검사 R. 일반 API에서 생성/수정/삭제/노출 금지 |

DB 제약과 API 권한은 서로 대체하지 않는다. raw SQL로 current 관계만 지우고 COMMIT하는 경로는 안전한 API가 아니다. modelTransaction의 전체 스캔 검사는 오프라인 도구용이며 실제 요청마다 실행하지 않는다. 요청별 검증·원자성·제한 BUSY·큐/입장권은 [API 명세](api.md)를 따른다.
