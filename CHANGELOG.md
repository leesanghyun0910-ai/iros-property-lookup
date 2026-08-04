# Changelog

이 프로젝트의 주요 변경 사항을 기록한다.
형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따른다.

---

## [Unreleased]

### ⚠️ 배포본과 main이 갈라져 있음

프로덕션에 배포된 버전은 `9c78713` 기준이며 **건축물대장(세움터) 기능이 포함되어 있다.**
main에는 해당 기능이 없다. 이는 의도된 상태다.

`main`을 그대로 배포하면 프로덕션에서 다음이 제거된다:

- `POST /api/building-register/status`
- `POST /api/building-register/download`
- 건축물대장 조회 열 · 행별 PDF 버튼 · 일괄 PDF 버튼
- D1(`BUILDING_REGISTER_DB`) / R2(`BUILDING_REGISTER_PDFS`) 바인딩
- 건축물대장 임시 캐시 cleanup cron (`0 18 * * *`)

기능을 유지한 채 배포하려면 `feature/building-register`를 머지한 뒤 배포한다.

### Removed

- **건축물대장(세움터) 기능을 main에서 제외.** 코드는 `feature/building-register` 브랜치(`9c78713`)에 보존.
  - 삭제: `worker/eais/building-register.ts`, `worker/eais/building-register-config.ts`
  - 삭제: `migrations/0001_building_register_cache.sql`, `resources/eais-building-register-findings.md`
  - 삭제: `shared/types.ts`의 `BuildingRegister*` 타입, `src/api.ts`의 조회·다운로드 래퍼
  - 삭제: `src/App.tsx`의 건축물대장 상태·로딩 state, 조회 열(`th`/`td`), 행별 및 일괄 PDF 버튼
  - 삭제: `worker/index.ts`의 라우트 2개, `normalizeBuildingRegisterItems`, cleanup cron 분기, `Env`의 `EAIS_ID`/`EAIS_PASS`/`BUILDING_REGISTER_*`
  - 주석 처리: `wrangler.toml`의 D1/R2 바인딩 (`database_id` 보존), cron `0 18 * * *` 제거

  Cloudflare의 D1 데이터베이스, R2 버킷, `EAIS_ID`/`EAIS_PASS` 시크릿은 **삭제하지 않았다.**
  주석만 해제하면 되살릴 수 있다.

  `pdf-lib` 의존성도 **남겨두었다.** 현재 main에서는 사용처가 없지만(건축물대장 PDF 병합 전용),
  여기서 제거하면 `feature/building-register`를 머지할 때 브랜치가 `package.json`을 건드리지
  않았으므로 삭제가 그대로 유지되어 런타임에 조용히 깨진다.

### Added

- `scripts/confirm-deploy.sh` — 배포 사고 방지 가드. `npm run deploy` 실행 시 `deploy` 입력을 요구하고,
  비대화형 환경에서는 중단한다. 건너뛰려면 `ALLOW_PRODUCTION_DEPLOY=1`.

---

## 이전 이력

커밋 기준 요약. `CHANGELOG.md` 도입 이전이라 커밋 메시지에서 정리했다.

### 2026-07-14 — `9c78713`
- 법정동코드 갱신 로직 개선, 건축물대장 조회 안정화
- 세움터 GET 요청 제한적 재시도(5xx), 동일 PNU·표제부 응답 요청 내 공유

### 2026-07-09 — `5f71f40`, `5feefd2`
- 건축물대장 PDF 다운로드 추가 (일반건축물·다가구·전유부, D1/R2 캐시, 병합)
- 문서 정비 및 GPL v3 라이선스 적용

### 2026-07-08 — `2342ec4`, `a543033`, `091dab5`
- 통합 다운로드 컨트롤 정리
- 공동주택가격·개별주택가격 내보내기 추가
- 상가/오피스 기준시가, 실거래가 내보내기 추가

### 2026-07-07 — `d68a1b4` … `2bd3471`
- 토지이용계획(토지이음) 인쇄 HTML 연동
- 토지 공시지가·토지등급: 법정동코드 KV 캐시 기반 PNU 변환 + 합본 PDF
- 공시지가·토지등급 제공자를 V-World → LH로 교체 (Cloudflare egress 차단 회피)
- 유형 필터(전체/집합건물/건물/토지) 추가
- 조회 중 엑셀·인쇄 버튼 비활성화

### 2026-07-06 — `36d2ce2` … `f9eb12d`
- 수집 코어 + 웹 UI (Phase 0-1)
- 페이지 병렬 수집 버그 수정, flaky-0 대응
- 프로젝트 스캐폴드
