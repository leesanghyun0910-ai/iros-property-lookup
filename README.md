# IROS 부동산고유번호 조회 서비스

주소를 대량으로 입력하면 **부동산고유번호(14자리)**를 일괄 조회하고, 인터넷등기소 **일괄열람 등록양식(.xls)**을 자동 생성하는 웹 서비스. 토지·건물 관련 가격과 이용계획, 건축물대장 자료도 함께 조회해 PDF/XLSX로 묶어준다.

세무·법무 실무에서 주소를 하나씩 검색하던 반복 작업을 없애는 것이 목표다. 조회·양식 생성까지 자동화하며, 인터넷등기소 로그인·결제·열람·저장은 사용자가 직접 수행한다.


---

## 주요 기능

### 고유번호 조회
- 주소를 **줄바꿈으로 여러 건** 입력 (시·도 없이 주소만 넣어도 됨)
- 주소별 부동산고유번호 전체 수집 (페이지네이션 순회, 중복 제거)
- **매칭 품질 분류** — 각 결과에 `정확 / 관련 / 주의 / 검토` 뱃지. 정확·관련은 기본 선택
- **필터** — 유형(전체/집합건물/건물/토지) · 매칭품질 · 텍스트 검색(주소·도로명·고유번호·동/호)
- 행별 선택 체크박스, 전체선택/정확·관련선택/해제

### 내보내기
- **고유번호 엑셀** — 선택 고유번호를 일괄열람 등록양식 `.xls`(BIFF8)로. 30건 단위 분할, 여러 개면 zip
- **토지 다운로드** — 선택한 토지의 **토지이용계획서 → 개별공시지가 → 토지등급** 순서로 PDF 병합
- **건물 다운로드** — 건물·집합건물의 가격·거래 자료를 통합 XLSX/PDF로 생성. 일괄 XLSX는 물건별 파일을 zip으로 묶음
- **가격 자료 조회** — 공동주택가격, 개별주택가격, 상가/오피스 기준시가, 실거래가를 가능한 자료만 표시하고 내보내기
- **건축물대장** — 일반건축물·다가구·전유부 존재 여부를 조회하고 개별 또는 일괄 PDF로 다운로드
- **토지대장** — 정부24 본인출력 발급 PDF를 개별 또는 일괄 다운로드하고 동일 PNU는 캐시 재사용
- **조회 최적화** — 동일 PNU와 표제부의 세움터 응답을 요청 안에서 공유해 대규모 집합건물의 중복 호출 방지

---

## 데이터 출처

| 데이터 | 출처 | 경로 |
|---|---|---|
| 부동산고유번호 | 인터넷등기소(iros.go.kr) | 검색 API 직접 호출 |
| 법정동코드 (주소→PNU) | 행정안전부 행정표준코드 API | 실시간 원천 전량 수집 → KV 캐시 |
| 개별공시지가 | 국토부(온나라) | LH 씨:리얼 프록시 |
| 토지등급 | 국토부(NSDI) | LH 씨:리얼 프록시 |
| 토지이용계획 | 토지이음(eum.go.kr) | 인쇄용 HTML 조회 |
| 공동주택가격·개별주택가격 | 부동산공시가격알리미(realtyprice.kr) | 주소·동호 기반 조회 |
| 상가/오피스텔 기준시가 | 국세청 Hometax | 주소→PNU 후 건물·층·호 기준 실시간 조회 |
| 실거래가 | data.go.kr 국토교통부 실거래가 API | 최근 1년 매매 조회 |
| 건축물대장 | 세움터 | 존재 여부 조회·열람 PDF 생성 |
| 토지대장 | 정부24 (KT 디지털융합플랫폼·하이픈 대행) | 회원 로그인 본인출력 PDF 발급 |

> 공시지가·토지등급은 원래 V-World 공식 API로 붙이려 했으나, **Cloudflare Worker → api.vworld.kr 이 520으로 차단**되어(오렌지-투-오렌지) 동일 원천을 제공하는 LH 경로로 전환했다. 제공자는 코드에서 추상화(`worker/landinfo/`)돼 있어, 비-Cloudflare 프록시가 생기면 V-World로 되돌릴 수 있다.

---

## 아키텍처

```
Cloudflare Worker (정적 자산 + /api/*)
   React SPA (입력·검토·내보내기)
        │
        ├─ /api/collect    → iros.go.kr 검색 (고유번호 수집)
        ├─ /api/landinfo   → 주소 → PNU → LH (공시지가·토지등급)
        ├─ /api/eum/print-html → 주소 → PNU → 토지이음 인쇄 HTML
        ├─ /api/realty-prices → 부동산공시가격알리미 (공동/개별주택가격)
        ├─ /api/commercial-prices → 주소 → PNU → Hometax (상가/오피스 기준시가)
        ├─ /api/building-trades → data.go.kr 실거래가
        ├─ /api/building-register/status → 세움터 건축물대장 존재 여부
        ├─ /api/building-register/download → 세움터 열람 신청·PDF 생성
        ├─ /api/land-register/download → 정부24 토지대장 발급·PDF 병합
        └─ /api/pnu        → 주소 → PNU
                              │
                     [법정동코드 캐시] Cloudflare KV

건축물·토지대장 작업 상태·메타 ─ Cloudflare D1
건축물·토지대장 임시 PDF       ─ Cloudflare R2 (만료 후 정리)
```

- 브라우저는 등기소·LH를 직접 못 부르고(CORS/차단) V-World는 Cloudflare에서 막히므로, **Worker가 모든 외부 호출을 대행**한다.
- **주소→PNU 변환은 법정동코드 캐시로 오프라인 계산**(네트워크 0). `PNU(19) = 법정동코드(10) + 필지구분(1) + 본번(4) + 부번(4)`.
- 엑셀 생성은 클라이언트(SheetJS), 토지 PDF는 클라이언트 인쇄(→PDF 저장).
- 건축물대장 상태 조회는 요청당 세움터 로그인을 한 번만 수행하며, 동일 PNU·표제부 조회를 공유한다. PDF는 다운로드 시점에만 열람 신청하고 완료 후 세움터 신청 내역을 정리한다.
- 토지대장은 다운로드 시점에만 정부24 발급을 요청한다. 원본은 PNU별로 D1/R2에 캐시하고 일괄 다운로드는 `pdf-lib`로 병합한다.

### 법정동코드 캐시 갱신 조건
| 조건 | 트리거 |
|---|---|
| 정기 | 매일 04:00 KST Cron → 행정안전부 API 전량 재수집 |
| 부트스트랩 | KV 비어있으면 백그라운드 1회 빌드 |
| TTL | 3일 초과 시 요청 중 백그라운드 재빌드(응답 안 막음) |
| 수동 | `POST /api/admin/refresh-ldong` |

전체 수집 결과가 최소 기대 건수와 필수 기준 코드를 통과한 경우에만 KV를 교체한다. 갱신 실패 시 기존 캐시를 유지한다.

---

## API 엔드포인트

| 메서드·경로 | 설명 |
|---|---|
| `POST /api/collect` | `{address}` → 부동산고유번호 목록 |
| `POST /api/landinfo` | `{items:[{key,address}]}` → 토지별 공시지가·토지등급 |
| `POST /api/eum/print-html` | `{items:[{key,address,label}]}` → 토지이용계획 인쇄 HTML |
| `POST /api/realty-prices` | `{items:[{key,address,roadAddr,building,floor,room,type}]}` → 공동/개별주택가격 |
| `POST /api/commercial-prices` | `{items:[{key,address,roadAddr,building,floor,room,type}]}` → 상가/오피스 기준시가 |
| `POST /api/building-trades` | `{items:[{key,address,roadAddr,building,floor,room,type}]}` → 최근 1년 실거래가 |
| `POST /api/building-register/status` | 건축물대장 존재 여부·문서 유형 조회. 민원 신청 없음 |
| `POST /api/building-register/download` | 선택 건물의 건축물대장 PDF 생성·병합 |
| `POST /api/land-register/download` | `{items:[{key,address,pinFmt?}]}` → 정부24 토지대장 PDF 발급·병합 |
| `POST /api/pnu` | `{addresses:[]}` → PNU 목록 |
| `GET /api/ldong/status` | 법정동코드 캐시 상태(건수·빌드시각) |
| `POST /api/admin/refresh-ldong` | 캐시 강제 갱신 (`ADMIN_TOKEN` 보호) |

---

## 개발

### 환경 변수
`.env.example`을 참고해 `.dev.vars`(로컬)를 만든다. 실제 키는 커밋되지 않는다(gitignore).

```bash
# .dev.vars
ODCLOUD_API_KEY=...   # data.go.kr 일반 인증키 (법정동코드 캐시용)
VWORLD_API_KEY=...    # (현재 미사용 — V-World 제공자 되살릴 때)
EAIS_ID=...           # 세움터 계정
EAIS_PASS=...         # 세움터 비밀번호
KOREACONNECT_API_KEY=... # KT 디지털융합플랫폼 API 키
GOV24_ID=...          # 정부24 회원 아이디
GOV24_PW=...          # 정부24 회원 비밀번호
```

### 실행 / 배포
```bash
npm install

# 최초 1회: wrangler dev가 쓰는 로컬 D1에 캐시 테이블 생성
npx wrangler d1 execute iros-building-register --local --file=./migrations/0001_building_register_cache.sql
npx wrangler d1 execute iros-building-register --local --file=./migrations/0002_land_register_cache.sql

npm run dev          # 프론트(5173) + Worker(8787) 로컬 실행
npm run build        # 프론트 빌드 → dist/
npm run deploy       # 빌드 + Cloudflare 배포

# 프로덕션 시크릿
npx wrangler secret put ODCLOUD_API_KEY
npx wrangler secret put VWORLD_API_KEY
npx wrangler secret put EAIS_ID
npx wrangler secret put EAIS_PASS
npx wrangler secret put KOREACONNECT_API_KEY
npx wrangler secret put GOV24_ID
npx wrangler secret put GOV24_PW
npx wrangler secret put ADMIN_TOKEN
```

배포에는 KV 네임스페이스(`LDONG`), 건축물·토지대장이 함께 쓰는 D1/R2, Cron이 `wrangler.toml`에 설정돼 있다. 신규 환경에는 `migrations/0001_building_register_cache.sql`과 `migrations/0002_land_register_cache.sql`을 순서대로 적용한다. 상가/오피스 기준시가는 별도 적재 없이 Hometax를 실시간 조회하며, 지번 주소는 KV의 법정동코드로 도로명 검색 단계를 생략한다.

---

## 알려진 이슈 / 한계

- **매칭 분류**: 재개발·지번합병으로 지번이 바뀐 필지가 '주의'로 과분류됨 ([#1](../../issues/1))
- **PDF 다운로드**: 일부 PDF는 브라우저 인쇄(→PDF 저장) 방식 ([#2](../../issues/2))
- **LH 의존**: 공시지가·토지등급은 공식 API가 아닌 LH 사이트 프록시라 사이트 개편 시 영향받을 수 있음
- **기준시가 매칭**: 동일 필지에 여러 건물이 있을 수 있어, PNU만으로 붙이지 않고 등기부의 건물명·층·호와 Hometax의 건물·층·호가 맞는 경우만 표시한다.
- **세움터 의존**: 세움터 세션 초기화가 간헐적으로 5xx를 반환할 수 있어 부작용 없는 GET만 제한적으로 재시도한다. 민원 신청·PDF 생성·삭제 요청은 중복 방지를 위해 자동 재시도하지 않는다.
- **정부24 발급 의존**: 토지대장 발급은 실제 민원 발급 호출이므로 자동 재시도하지 않고, 요청당 50필지·동시 발급 2건으로 제한한다.

---

## 라이선스

GNU General Public License v3.0 or later. 자세한 내용은 [LICENSE](./LICENSE)를 참고한다.
