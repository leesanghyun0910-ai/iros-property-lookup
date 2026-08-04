// 프론트엔드(Vite)와 Worker가 공유하는 타입

/** 정규화된 부동산 레코드 (IROS dataList → 우리 스키마) */
export interface PropertyRecord {
  pin: string;        // 14자리 부동산고유번호
  pinFmt: string;     // 4-4-6 하이픈 (1102-2004-010236)
  type: string;       // 토지 / 건물 / 집합건물 (real_cls_cd)
  address: string;    // 지번 주소 (real_indi_cont)
  roadAddr: string;   // 도로명 주소 (rd_addr)
  building: string;   // 건물명 (buld_name)
  floor: string;      // 층 (buld_no_floor)
  room: string;       // 호 (buld_no_room)
  useCls: string;     // 현행 / 폐쇄 (use_cls_cd)
}

/** POST /api/collect 요청 — 주소 한 줄 통째로 (시/도 불필요, admin_regn1 빈값으로 검색됨) */
export interface CollectRequest {
  address: string;    // 예: "서울특별시 송파구 석촌동 265-5" 또는 "송파구 석촌동 265-5" 둘 다 OK
}

/** POST /api/collect 응답 */
export interface CollectResponse {
  ok: boolean;
  total: number;               // IROS 보고 totalRecordCount
  collected: number;           // 실제 수집·중복제거 후 건수
  records: PropertyRecord[];
  error?: string;
}

// ── 토지 공시지가 + 토지등급 (V-World) ──────────────────────────
export interface JigaRow {
  year: string;        // 가격기준년도
  month: string;       // 기준월 (2자리)
  price: string;       // 개별공시지가(원/㎡)
  publishDate: string; // 공시일자
  jibun: string;       // 지번
  addr: string;        // 토지소재지
}
export interface GradeRow {
  kind: string;        // 등급구분 (토지/기준수확량)
  grade: string;       // 등급
  changeDate: string;  // 변동일
}
export interface LandInfo {
  key: string;         // 매칭용 (부동산고유번호 pin)
  address: string;
  pnu: string | null;
  jiga: JigaRow[];
  grade: GradeRow[];
  error?: string;
}

/** POST /api/landinfo 요청/응답 */
export interface LandInfoRequest {
  items: { key: string; address: string }[];
}
export interface LandInfoResponse {
  ok: boolean;
  results: LandInfo[];
  error?: string;
}

// ── 건물 실거래가 (공공데이터포털 RTMS) ───────────────────────
export type BuildingTradeSource = 'apt' | 'single' | 'rowhouse' | 'officetel';
export type BuildingTradeMatchLevel = 'lot' | 'candidate';

export interface BuildingTradeRequestItem {
  key: string;        // 매칭용 (부동산고유번호 pin)
  address: string;    // 지번 주소
  roadAddr?: string;  // 도로명 주소
  building?: string;  // 등기부 건물명
  floor?: string;     // 등기부 층
  room?: string;      // 등기부 호
  type?: string;      // 건물 / 집합건물
}

export interface BuildingTradeItem {
  source: BuildingTradeSource;
  sourceLabel: string;
  matchLevel: BuildingTradeMatchLevel;
  dealDate: string;             // YYYY-MM-DD
  dealAmount: string;           // 원문 거래금액(만원)
  dealAmountManwon: number | null;
  umdNm: string;
  jibun: string;
  buildingName: string;
  houseType: string;
  floor: string;
  area: string;                 // 전용면적 등 주 면적
  landArea: string;             // 대지권/대지면적
  plottageArea: string;         // 대지면적(단독/다가구)
  totalFloorArea: string;       // 연면적(단독/다가구)
  buildYear: string;
  dealingGbn: string;
  estateAgentSggNm: string;
  rgstDate: string;
  sellerGbn: string;
  buyerGbn: string;
  raw: Record<string, string>;
}

export interface BuildingTradeInfo {
  key: string;
  address: string;
  pnu: string | null;
  lawdCd?: string;
  targetJibun?: string;
  items: BuildingTradeItem[];
  error?: string;
}

export interface BuildingTradeRequest {
  items: BuildingTradeRequestItem[];
}

export interface BuildingTradeResponse {
  ok: boolean;
  results: BuildingTradeInfo[];
  error?: string;
}

// ── 상가/오피스텔 기준시가 (국세청 Hometax) ─────────────────────
export interface CommercialPriceRequestItem {
  key: string;        // 매칭용 (부동산고유번호 pin)
  address: string;    // 지번 주소
  roadAddr?: string;  // 도로명 주소
  building?: string;  // 등기부 건물명
  floor?: string;     // 등기부 층
  room?: string;      // 등기부 호
  type?: string;      // 건물 / 집합건물
}

export interface CommercialPriceItem {
  noticeDate: string;     // YYYY.MM.DD
  kind: string;           // 상가 / 오피스텔
  buildingName: string;   // 상가건물블록주소
  buildingDong: string;   // 상가건물동주소
  floorKind: string;      // 지상층 / 지하층
  floor: string;          // 상가건물층주소
  room: string;           // 상가건물호주소
  unitPrice: number | null;     // 단위면적당 기준시가(원/㎡)
  exclusiveArea: number | null; // 전용면적
  sharedArea: number | null;    // 공유면적
  buildingArea: number | null;  // 전용면적 + 공유면적
}

export interface CommercialPriceInfo {
  key: string;
  address: string;
  pnu: string | null;
  detailAddress: string;
  items: CommercialPriceItem[];
  error?: string;
}

export interface CommercialPriceRequest {
  items: CommercialPriceRequestItem[];
}

export interface CommercialPriceResponse {
  ok: boolean;
  results: CommercialPriceInfo[];
  error?: string;
}

// ── 공동주택가격 + 개별주택가격 (부동산공시가격 알리미) ─────────────
export interface RealtyPriceRequestItem {
  key: string;        // 매칭용 (부동산고유번호 pin)
  address: string;    // 지번 주소
  roadAddr?: string;  // 도로명 주소
  building?: string;  // 등기부 건물명
  floor?: string;     // 등기부 층
  room?: string;      // 등기부 호
  type?: string;      // 토지 / 건물 / 집합건물
}

export interface ApartmentOfficialPriceItem {
  baseDate: string;       // YYYY.M.D
  complexName: string;    // 단지명
  dongName: string;       // 동명
  roomName: string;       // 호명
  exclusiveArea: number | null;
  price: number | null;
}

export interface ApartmentOfficialPriceInfo {
  key: string;
  address: string;
  pnu: string | null;
  detailAddress: string;
  items: ApartmentOfficialPriceItem[];
  error?: string;
}

export interface IndividualHousePriceItem {
  baseDate: string;           // YYYY/MM/DD
  address: string;
  landAreaTotal: number | null;
  landAreaCalculated: number | null;
  buildingAreaTotal: number | null;
  buildingAreaCalculated: number | null;
  price: number | null;
}

export interface IndividualHousePriceInfo {
  key: string;
  address: string;
  pnu: string | null;
  items: IndividualHousePriceItem[];
  error?: string;
}

export interface RealtyPriceInfo {
  key: string;
  address: string;
  pnu: string | null;
  apartment: ApartmentOfficialPriceInfo;
  individual: IndividualHousePriceInfo;
}

export interface RealtyPriceRequest {
  items: RealtyPriceRequestItem[];
}

export interface RealtyPriceResponse {
  ok: boolean;
  results: RealtyPriceInfo[];
  error?: string;
}

// ── 토지이용계획 인쇄 HTML (EUM) ──────────────────────────────
export interface EumPrintItem {
  key: string;
  address: string;
  label?: string;
  jigaText?: string;
}

export interface EumPrintRequest {
  items: EumPrintItem[];
}

