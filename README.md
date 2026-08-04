# IROS 부동산고유번호 조회 서비스

주소를 대량으로 입력하면 **부동산고유번호(14자리)**를 일괄 조회하고, 인터넷등기소 **일괄열람 등록양식(.xls)**을 자동 생성하는 웹 서비스. 토지·건물 관련 가격과 이용계획 자료도 함께 조회해 PDF/XLSX로 묶어준다.

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

> **건축물대장(세움터) 기능은 현재 main에서 제외돼 있다.** 코드는 `feature/building-register` 브랜치에 보존돼 있고, 배포본에는 아직 살아있다. 자세한 내용은 [CHANGELOG](./CHANGELOG.md)를 참고한다.

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
        └─ /api/pnu        → 주소 → PNU
                              │
                     [법정동코드 캐시] Cloudflare KV
```

- 브라우저는 등기소·LH를 직접 못 부르고(CORS/차단) V-World는 Cloudflare에서 막히므로, **Worker가 모든 외부 호출을 대행**한다.
- **주소→PNU 변환은 법정동코드 캐시로 오프라인 계산**(네트워크 0). `PNU(19) = 법정동코드(10) + 필지구분(1) + 본번(4) + 부번(4)`.
- 엑셀 생성은 클라이언트(SheetJS), 토지 PDF는 클라이언트 인쇄(→PDF 저장).

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
```

### 실행 / 배포
```bash
npm install
npm run dev          # 프론트(5173) + Worker(8787) 로컬 실행
npm run build        # 프론트 빌드 → dist/
npm run deploy       # 확인 프롬프트 + 빌드 + Cloudflare 배포

# 프로덕션 시크릿
npx wrangler secret put ODCLOUD_API_KEY
npx wrangler secret put VWORLD_API_KEY
npx wrangler secret put ADMIN_TOKEN
```

배포에는 KV 네임스페이스(`LDONG`)와 Cron이 `wrangler.toml`에 설정돼 있다. 상가/오피스 기준시가는 별도 적재 없이 Hometax를 실시간 조회하며, 지번 주소는 KV의 법정동코드로 도로명 검색 단계를 생략한다.

> **`npm run deploy`는 확인 프롬프트를 거친다.** 배포본에는 건축물대장 기능이 살아있고 main에는 없어서, 무심코 배포하면 프로덕션에서 해당 기능이 사라진다. `scripts/confirm-deploy.sh`가 `deploy` 입력을 요구하고, 비대화형 환경(CI 등)에서는 기본적으로 중단한다. 건너뛰려면 `ALLOW_PRODUCTION_DEPLOY=1 npm run deploy`.

---

## 알려진 이슈 / 한계

- **매칭 분류**: 재개발·지번합병으로 지번이 바뀐 필지가 '주의'로 과분류됨 ([#1](../../issues/1))
- **PDF 다운로드**: 일부 PDF는 브라우저 인쇄(→PDF 저장) 방식 ([#2](../../issues/2))
- **LH 의존**: 공시지가·토지등급은 공식 API가 아닌 LH 사이트 프록시라 사이트 개편 시 영향받을 수 있음
- **기준시가 매칭**: 동일 필지에 여러 건물이 있을 수 있어, PNU만으로 붙이지 않고 등기부의 건물명·층·호와 Hometax의 건물·층·호가 맞는 경우만 표시한다.
- **배포본과 main의 차이**: 배포본에는 건축물대장 기능이 남아있고 main에는 없다. 배포 전 `CHANGELOG.md`를 확인한다.

---

## 라이선스

GNU General Public License v3.0 or later. 자세한 내용은 [LICENSE](./LICENSE)를 참고한다.
