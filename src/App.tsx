import { useEffect, useMemo, useRef, useState } from 'react';
import {
  collect,
  downloadBuildingRegisterPdf,
  downloadLandRegisterPdf,
  downloadPropertyRegisterPdf,
  fetchBuildingRegisterStatus,
  fetchBuildingTrades,
  fetchCommercialPrices,
  fetchEumPrintHtml,
  fetchLandInfo,
  fetchRealtyPrices,
} from './api';
import { downloadBatches } from './lib/excel';
import { buildLandBundlePdfHtml, buildLandBundlePdfHtmlMany } from './lib/landBundlePdf';
import {
  downloadBuildingBundleWorkbook,
  downloadBuildingBundleZip,
  hasBuildingBundleData,
  printBuildingBundlePdf,
} from './lib/buildingBundleExport';
import type {
  BuildingRegisterAvailability,
  BuildingRegisterRequestItem,
  BuildingTradeInfo,
  BuildingTradeRequestItem,
  CommercialPriceInfo,
  CommercialPriceRequestItem,
  EumPrintItem,
  LandInfo,
  LandRegisterRequestItem,
  PropertyRecord,
  PropertyRegisterRequestItem,
  RealtyPriceInfo,
  RealtyPriceRequestItem,
} from '../shared/types';

const won = (n: string) => (n ? Number(n).toLocaleString('ko-KR') : '');

const escapeHtml = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function writeWindowMessage(w: Window, title: string, message: string) {
  w.document.open();
  w.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
    <style>
      body { margin:0; min-height:100vh; display:grid; place-items:center; background:#f7f8fb;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic',sans-serif; color:#111827; }
      main { width:min(520px, calc(100vw - 40px)); padding:28px; border:1px solid #e5e7eb; border-radius:12px; background:#fff; }
      h1 { margin:0 0 10px; font-size:18px; }
      p { margin:0; color:#6b7280; font-size:14px; line-height:1.6; white-space:pre-wrap; }
    </style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`);
  w.document.close();
  w.focus();
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function waitForPrintableAssets(w: Window, timeoutMs = 8000) {
  const images = Array.from(w.document.images);
  const pending = images
    .filter((img) => !img.complete)
    .map((img) => new Promise<void>((resolve) => {
      const done = () => resolve();
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    }));

  return Promise.race([
    Promise.all(pending).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function writeAndPrintWindow(w: Window, html: string) {
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();

  const trigger = () => {
    waitForPrintableAssets(w).then(() => setTimeout(() => w.print(), 400));
  };

  if (w.document.readyState === 'complete') trigger();
  else w.addEventListener('load', trigger, { once: true });
}

type Row = {
  address: string;
  status: 'pending' | 'loading' | 'done' | 'error';
  records: PropertyRecord[];
  selectedPins: string[];
  total: number;
  error?: string;
};

// IROS 검색 백엔드는 동시 요청 시 불안정하게 0을 반환한다(false "결과 없음" 유발).
// → 직렬 처리 + 주소 간 페이싱으로 신뢰성 확보 (실측: 직렬은 100% 정확, 동시성은 누락 발생).
const CONCURRENCY = 1;
const PACE_MS = 800;                      // 주소 간 간격
type MatchKind = 'exact' | 'related' | 'caution' | 'review';

const MATCH_LABELS: Record<MatchKind, string> = {
  exact: '정확',
  related: '관련',
  caution: '주의',
  review: '검토',
};
const MATCH_ORDER: MatchKind[] = ['exact', 'related', 'caution', 'review'];
type ResultFilter = 'all' | 'selected' | MatchKind;
const FILTER_OPTIONS: { value: ResultFilter; label: string }[] = [
  { value: 'all', label: '전체' },
  { value: 'selected', label: '선택' },
  { value: 'exact', label: '정확' },
  { value: 'related', label: '관련' },
  { value: 'caution', label: '주의' },
  { value: 'review', label: '검토' },
];

// 유형 필터 (부동산구분)
type TypeFilter = 'all' | '집합건물' | '건물' | '토지';
const TYPE_FILTER_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: '전체' },
  { value: '집합건물', label: '집합건물' },
  { value: '건물', label: '건물' },
  { value: '토지', label: '토지' },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isBuildingRecord(rec: PropertyRecord) {
  return rec.type !== '토지';
}

type ParsedLot = {
  dong?: string;
  mountain: boolean;
  bun: string;
  ji: string;
  tail?: string;
};

type ParsedRoad = {
  roadName: string;
  mainNo: string;
  subNo: string;
  buildingNo?: string;
  roomNo?: string;
};

function normalizeAddress(value: string) {
  return value
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactAddress(value: string) {
  return normalizeAddress(value).replace(/\s+/g, '');
}

function extractDong(value: string): string | undefined {
  const matches = Array.from(normalizeAddress(value).matchAll(/([가-힣0-9]+(?:읍|면|동|리|가))/g));
  return matches.length ? matches[matches.length - 1][1] : undefined;
}

function extractRoadAddress(value: string): ParsedRoad | null {
  const normalized = normalizeAddress(value);
  const match = /([가-힣0-9]+?(?:로(?:\d+길)?|길))\s*(\d+)(?:-(\d+))?/.exec(normalized);
  if (!match) return null;

  const tail = normalized.slice(match.index + match[0].length);
  const buildingNo = /(?:제\s*)?(\d+)\s*동/.exec(tail)?.[1];
  const roomNo = /(?:제\s*)?(\d+)\s*호/.exec(tail)?.[1];
  const looseNumbers = Array.from(tail.matchAll(/\d+/g)).map((m) => m[0]);

  return {
    roadName: match[1],
    mainNo: match[2],
    subNo: match[3] ?? '',
    buildingNo: buildingNo ?? (looseNumbers.length >= 2 ? looseNumbers[0] : undefined),
    roomNo: roomNo ?? (looseNumbers.length >= 2 ? looseNumbers[looseNumbers.length - 1] : undefined),
  };
}

function extractQueryLot(value: string): ParsedLot | null {
  const normalized = normalizeAddress(value);
  const compactMatches = Array.from(
    normalized.matchAll(/([가-힣0-9]+?(?:읍|면|동|리|가))\s*(산\s*)?(\d+)(?:-(\d+))?/g),
  );
  const lotMatches = compactMatches.filter((match) => !/^\d+동$/.test(match[1]));
  const compactMatch = lotMatches.length ? lotMatches[lotMatches.length - 1] : compactMatches.at(-1);
  if (compactMatch) {
    return {
      dong: compactMatch[1],
      mountain: Boolean(compactMatch[2]),
      bun: compactMatch[3],
      ji: compactMatch[4] ?? '',
    };
  }

  const matches = Array.from(normalized.matchAll(/(?:^|\s)(산\s*)?(\d+)(?:-(\d+))?(?=$|\s|번지|호|,|\))/g));
  const dong = extractDong(normalized);
  let match = matches.length ? matches[matches.length - 1] : undefined;

  if (!match && dong) {
    const afterDong = normalized.slice(normalized.lastIndexOf(dong) + dong.length).trim();
    match = /^(산\s*)?(\d+)(?:-(\d+))?/.exec(afterDong) ?? undefined;
  }

  if (!match) return null;
  return {
    dong,
    mountain: Boolean(match[1]),
    bun: match[2],
    ji: match[3] ?? '',
  };
}

function extractPrimaryLot(address: string, queryDong?: string): ParsedLot | null {
  const normalized = normalizeAddress(address);
  let source = normalized;
  if (queryDong) {
    const dongIndex = normalized.lastIndexOf(queryDong);
    if (dongIndex >= 0) source = normalized.slice(dongIndex + queryDong.length).trim();
  }

  const match = /(?:^|\s)(산\s*)?(\d+)(?:-(\d+))?/.exec(source);
  if (!match) return null;

  return {
    mountain: Boolean(match[1]),
    bun: match[2],
    ji: match[3] ?? '',
    tail: source.slice(match.index + match[0].length).trim(),
  };
}

function classifyRoadRecord(queryAddress: string, record: PropertyRecord): MatchKind | null {
  const queryRoad = extractRoadAddress(queryAddress);
  if (!queryRoad) return null;

  const recordRoad = extractRoadAddress(record.roadAddr);
  if (!recordRoad) return 'caution';

  const sameRoad =
    compactAddress(recordRoad.roadName) === compactAddress(queryRoad.roadName) &&
    recordRoad.mainNo === queryRoad.mainNo &&
    recordRoad.subNo === queryRoad.subNo;
  if (!sameRoad) return 'caution';

  if (queryRoad.buildingNo && recordRoad.buildingNo !== queryRoad.buildingNo) return 'caution';
  if (queryRoad.roomNo && recordRoad.roomNo !== queryRoad.roomNo) return 'caution';

  return queryRoad.buildingNo || queryRoad.roomNo ? 'exact' : 'related';
}

function classifyRecord(queryAddress: string, record: PropertyRecord): MatchKind {
  const roadKind = classifyRoadRecord(queryAddress, record);
  if (roadKind) return roadKind;

  const queryLot = extractQueryLot(queryAddress);
  if (!queryLot) return 'review';

  if (queryLot.dong && !normalizeAddress(record.address).includes(queryLot.dong)) return 'caution';

  const primaryLot = extractPrimaryLot(record.address, queryLot.dong);
  if (!primaryLot) return 'review';

  const sameLot = primaryLot.bun === queryLot.bun && primaryLot.ji === queryLot.ji;
  if (!sameLot || primaryLot.mountain !== queryLot.mountain) return 'caution';

  return primaryLot.tail ? 'related' : 'exact';
}

function shouldSelectByDefault(kind: MatchKind) {
  return kind === 'exact' || kind === 'related';
}

function countMatches(kinds: MatchKind[]) {
  return kinds.reduce<Record<MatchKind, number>>(
    (acc, kind) => ({ ...acc, [kind]: acc[kind] + 1 }),
    { exact: 0, related: 0, caution: 0, review: 0 },
  );
}

function shouldExpandByDefault(kinds: MatchKind[], selectedCount: number) {
  const counts = countMatches(kinds);
  return selectedCount === 0 || counts.caution > 0 || counts.review > 0;
}

function searchText(value: string) {
  const normalized = normalizeAddress(value).toLowerCase();
  return `${normalized} ${normalized.replace(/\s+/g, '')}`;
}

function matchesSearch(value: string, query: string) {
  if (!query) return true;
  const needle = searchText(query);
  return searchText(value).includes(needle);
}

function recordSearchText(rowAddress: string, record: PropertyRecord, kind: MatchKind) {
  return [
    rowAddress,
    record.pin,
    record.pinFmt,
    record.type,
    record.address,
    record.roadAddr,
    record.building,
    record.floor,
    record.room,
    record.useCls,
    MATCH_LABELS[kind],
  ].join(' ');
}

function matchesResultFilter(kind: MatchKind, selected: boolean, filter: ResultFilter) {
  if (filter === 'all') return true;
  if (filter === 'selected') return selected;
  return kind === filter;
}

export default function App() {
  const [input, setInput] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({});
  const [searchTerm, setSearchTerm] = useState('');
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [running, setRunning] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [landInfo, setLandInfo] = useState<Record<string, LandInfo>>({}); // pin → 공시지가·토지등급
  const [landLoading, setLandLoading] = useState(false);
  const [landDownloading, setLandDownloading] = useState(false);
  const [tradeInfo, setTradeInfo] = useState<Record<string, BuildingTradeInfo>>({}); // pin → 최근 1년 실거래가
  const [tradeLoading, setTradeLoading] = useState(false);
  const [commercialPriceInfo, setCommercialPriceInfo] = useState<Record<string, CommercialPriceInfo>>({});
  const [commercialPriceLoading, setCommercialPriceLoading] = useState(false);
  const [realtyPriceInfo, setRealtyPriceInfo] = useState<Record<string, RealtyPriceInfo>>({});
  const [realtyPriceLoading, setRealtyPriceLoading] = useState(false);
  const [buildingRegisterInfo, setBuildingRegisterInfo] = useState<Record<string, BuildingRegisterAvailability>>({});
  const [buildingRegisterLoading, setBuildingRegisterLoading] = useState(false);
  const [bundleDownloadingKey, setBundleDownloadingKey] = useState<string | null>(null);
  const [bundlePdfPrintingKey, setBundlePdfPrintingKey] = useState<string | null>(null);
  const [buildingRegisterPdfKey, setBuildingRegisterPdfKey] = useState<string | null>(null);
  const [landRegisterPdfKey, setLandRegisterPdfKey] = useState<string | null>(null);
  const [propertyRegisterPdfKey, setPropertyRegisterPdfKey] = useState<string | null>(null);
  const [eumPrintingKey, setEumPrintingKey] = useState<string | null>(null);
  const [buildingMenuOpen, setBuildingMenuOpen] = useState(false);
  const [allExpandedOverride, setAllExpandedOverride] = useState<boolean | null>(null);
  const buildingMenuRef = useRef<HTMLDetailsElement | null>(null);

  useEffect(() => {
    if (!buildingMenuOpen) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && buildingMenuRef.current?.contains(target)) return;
      setBuildingMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setBuildingMenuOpen(false);
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [buildingMenuOpen]);

  // 전체 주소 통합 레코드 (고유번호 기준 중복 제거) — 다운로드용
  const exportRecords = useMemo(() => {
    const seen = new Set<string>();
    const records: PropertyRecord[] = [];
    for (const r of rows) {
      const selected = new Set(r.selectedPins);
      for (const rec of r.records)
        if (selected.has(rec.pin) && !seen.has(rec.pin)) { seen.add(rec.pin); records.push(rec); }
    }
    return records;
  }, [rows]);

  const selectedLandRecords = useMemo(
    () => exportRecords.filter((rec) => rec.type === '토지'),
    [exportRecords],
  );

  const selectedBuildingRecords = useMemo(
    () => exportRecords.filter(isBuildingRecord),
    [exportRecords],
  );

  const allBuildingRecords = useMemo(() => {
    const seen = new Set<string>();
    const records: PropertyRecord[] = [];
    for (const row of rows) {
      for (const rec of row.records) {
        if (!isBuildingRecord(rec) || seen.has(rec.pin)) continue;
        seen.add(rec.pin);
        records.push(rec);
      }
    }
    return records;
  }, [rows]);

  const selectedBuildingRegisterRecords = useMemo(
    () => selectedBuildingRecords.filter((rec) => buildingRegisterInfo[rec.pin]?.status === 'available'),
    [selectedBuildingRecords, buildingRegisterInfo],
  );

  const done = rows.filter((r) => r.status === 'done' || r.status === 'error').length;

  async function onCollect() {
    const addresses = input.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!addresses.length) return;
    setRunning(true);
    setExpandedRows({});
    setAllExpandedOverride(null);
    setBuildingMenuOpen(false);
    setLandInfo({});
    setTradeInfo({});
    setCommercialPriceInfo({});
    setRealtyPriceInfo({});
    setBuildingRegisterInfo({});
    setRows(addresses.map((a) => ({ address: a, status: 'pending', records: [], selectedPins: [], total: 0 })));

    const update = (i: number, patch: Partial<Row>) =>
      setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

    const landItems: { key: string; address: string }[] = [];
    const buildingRecords: PropertyRecord[] = [];
    const realtyRecords: PropertyRecord[] = [];

    let next = 0;
    const worker = async () => {
      while (next < addresses.length) {
        const i = next++;
        update(i, { status: 'loading' });
        try {
          const res = await collect({ address: addresses[i] });
          if (res.ok) {
            const kinds = res.records.map((rec) => classifyRecord(addresses[i], rec));
            const selectedPins = res.records
              .filter((_, idx) => shouldSelectByDefault(kinds[idx]))
              .map((rec) => rec.pin);
            setExpandedRows((prev) => ({ ...prev, [i]: shouldExpandByDefault(kinds, selectedPins.length) }));
            update(i, { status: 'done', records: res.records, selectedPins, total: res.total });
            // 토지만 공시지가·토지등급 대상으로 수집
            for (const rec of res.records) {
              if (isBuildingRecord(rec)) realtyRecords.push(rec);
              if (rec.type === '토지') landItems.push({ key: rec.pin, address: rec.address });
              else buildingRecords.push(rec);
            }
          }
          else {
            setExpandedRows((prev) => ({ ...prev, [i]: true }));
            update(i, { status: 'error', error: res.error });
          }
        } catch (e: any) {
          setExpandedRows((prev) => ({ ...prev, [i]: true }));
          update(i, { status: 'error', error: e?.message ?? '오류' });
        }
        if (next < addresses.length) await sleep(PACE_MS); // 주소 간 페이싱
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, addresses.length) }, worker));
    setRunning(false);

    await Promise.all([
      loadLandInfo(landItems),
      loadBuildingTrades(buildingRecords),
      loadCommercialPrices(buildingRecords),
      loadRealtyPrices(realtyRecords),
      loadBuildingRegisters(buildingRecords),
    ]);
  }

  async function loadLandInfo(items: { key: string; address: string }[]) {
    if (!items.length) return {};
    setLandLoading(true);
    try {
      const res = await fetchLandInfo({ items });
      if (res.ok) {
        const next = Object.fromEntries(res.results.map((r) => [r.key, r]));
        setLandInfo((prev) => ({ ...prev, ...next }));
        return next;
      }
      return {};
    } finally {
      setLandLoading(false);
    }
  }

  function toBuildingTradeItem(rec: PropertyRecord): BuildingTradeRequestItem {
    return {
      key: rec.pin,
      address: rec.address,
      roadAddr: rec.roadAddr,
      building: rec.building,
      floor: rec.floor,
      room: rec.room,
      type: rec.type,
    };
  }

  async function loadBuildingTrades(records: PropertyRecord[]) {
    const seen = new Set<string>();
    const items = records
      .filter(isBuildingRecord)
      .filter((rec) => {
        if (seen.has(rec.pin)) return false;
        seen.add(rec.pin);
        return true;
      })
      .map(toBuildingTradeItem);

    if (!items.length) return {};

    setTradeLoading(true);
    try {
      const res = await fetchBuildingTrades({ items });
      if (!res.ok) {
        alert(res.error ?? '실거래가 조회에 실패했습니다.');
        return {};
      }
      const next = Object.fromEntries(res.results.map((r) => [r.key, r]));
      setTradeInfo((prev) => ({ ...prev, ...next }));
      return next;
    } finally {
      setTradeLoading(false);
    }
  }

  function toCommercialPriceItem(rec: PropertyRecord): CommercialPriceRequestItem {
    return {
      key: rec.pin,
      address: rec.address,
      roadAddr: rec.roadAddr,
      building: rec.building,
      floor: rec.floor,
      room: rec.room,
      type: rec.type,
    };
  }

  async function loadCommercialPrices(records: PropertyRecord[]) {
    const seen = new Set<string>();
    const items = records
      .filter(isBuildingRecord)
      .filter((rec) => {
        if (seen.has(rec.pin)) return false;
        seen.add(rec.pin);
        return true;
      })
      .map(toCommercialPriceItem);

    if (!items.length) return {};

    setCommercialPriceLoading(true);
    try {
      const res = await fetchCommercialPrices({ items });
      if (!res.ok) {
        alert(res.error ?? '상가/오피스 기준시가 조회에 실패했습니다.');
        return {};
      }
      const next = Object.fromEntries(res.results.map((r) => [r.key, r]));
      setCommercialPriceInfo((prev) => ({ ...prev, ...next }));
      return next;
    } finally {
      setCommercialPriceLoading(false);
    }
  }

  function toRealtyPriceItem(rec: PropertyRecord): RealtyPriceRequestItem {
    return {
      key: rec.pin,
      address: rec.address,
      roadAddr: rec.roadAddr,
      building: rec.building,
      floor: rec.floor,
      room: rec.room,
      type: rec.type,
    };
  }

  function toBuildingRegisterItem(rec: PropertyRecord): BuildingRegisterRequestItem {
    return {
      key: rec.pin,
      pinFmt: rec.pinFmt,
      address: rec.address,
      roadAddr: rec.roadAddr,
      building: rec.building,
      floor: rec.floor,
      room: rec.room,
      type: rec.type,
    };
  }

  function toLandRegisterItem(rec: PropertyRecord): LandRegisterRequestItem {
    return {
      key: rec.pin,
      pinFmt: rec.pinFmt,
      address: rec.address,
    };
  }

  function toPropertyRegisterItem(rec: PropertyRecord): PropertyRegisterRequestItem {
    return {
      key: rec.pin,
      uniqNo: rec.pin,
      pinFmt: rec.pinFmt,
      address: rec.address,
    };
  }

  async function loadBuildingRegisters(records: PropertyRecord[]) {
    const seen = new Set<string>();
    const items = records
      .filter(isBuildingRecord)
      .filter((rec) => {
        if (seen.has(rec.pin)) return false;
        seen.add(rec.pin);
        return true;
      })
      .map(toBuildingRegisterItem);

    if (!items.length) return {};

    setBuildingRegisterLoading(true);
    try {
      const res = await fetchBuildingRegisterStatus({ items });
      let next: Record<string, BuildingRegisterAvailability>;
      if (res.ok) {
        next = Object.fromEntries(res.results.map((result) => [result.key, result]));
      } else {
        const error = res.error ?? '건축물대장 조회에 실패했습니다.';
        next = Object.fromEntries(items.map((item) => [item.key, {
          key: item.key,
          address: item.address,
          pnu: null,
          status: 'error',
          matchConfirmed: false,
          error,
        } satisfies BuildingRegisterAvailability]));
      }
      setBuildingRegisterInfo((prev) => ({ ...prev, ...next }));
      return next;
    } catch (error: any) {
      const message = error?.message ?? '건축물대장 조회에 실패했습니다.';
      const next = Object.fromEntries(items.map((item) => [item.key, {
        key: item.key,
        address: item.address,
        pnu: null,
        status: 'error',
        matchConfirmed: false,
        error: message,
      } satisfies BuildingRegisterAvailability]));
      setBuildingRegisterInfo((prev) => ({ ...prev, ...next }));
      return next;
    } finally {
      setBuildingRegisterLoading(false);
    }
  }

  async function loadRealtyPrices(records: PropertyRecord[]) {
    const seen = new Set<string>();
    const items = records
      .filter(isBuildingRecord)
      .filter((rec) => {
        if (seen.has(rec.pin)) return false;
        seen.add(rec.pin);
        return true;
      })
      .map(toRealtyPriceItem);

    if (!items.length) return {};

    setRealtyPriceLoading(true);
    try {
      const res = await fetchRealtyPrices({ items });
      if (!res.ok) {
        alert(res.error ?? '공시가격 조회에 실패했습니다.');
        return {};
      }
      const next = Object.fromEntries(res.results.map((r) => [r.key, r]));
      setRealtyPriceInfo((prev) => ({ ...prev, ...next }));
      return next;
    } finally {
      setRealtyPriceLoading(false);
    }
  }

  function toEumPrintItem(rec: PropertyRecord, landInfoByPin = landInfo): EumPrintItem {
    const jiga = landInfoByPin[rec.pin]?.jiga?.[0];
    return {
      key: rec.pin,
      label: rec.pinFmt,
      address: rec.address,
      jigaText: jiga ? `${won(jiga.price)}원 (${jiga.year}/${jiga.month})` : undefined,
    };
  }

  async function onLandBundlePdfOne(rec: PropertyRecord) {
    if (eumPrintingKey || landRegisterPdfKey || propertyRegisterPdfKey || running || landLoading) return;

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('팝업이 차단되었습니다. 팝업 허용 후 다시 시도해 주세요.');
      return;
    }

    writeWindowMessage(printWindow, '토지 통합 PDF 생성 중', '공시지가, 토지등급, 토지이용계획 문서를 하나로 만들고 있습니다.');
    setEumPrintingKey(rec.pin);

    try {
      const loaded = landInfo[rec.pin] ? {} : await loadLandInfo([{ key: rec.pin, address: rec.address }]);
      const mergedLandInfo = { ...landInfo, ...loaded };
      const html = await fetchEumPrintHtml({
        items: [toEumPrintItem(rec, mergedLandInfo)],
      });
      const combined = buildLandBundlePdfHtml(rec, mergedLandInfo[rec.pin] ?? null, html);
      if (!combined) throw new Error('출력할 토지 자료가 없습니다.');
      writeAndPrintWindow(printWindow, combined);
    } catch (e: any) {
      writeWindowMessage(printWindow, '토지 통합 PDF 생성 실패', e?.message ?? '토지 통합 PDF 생성에 실패했습니다.');
    } finally {
      setEumPrintingKey(null);
    }
  }

  function currentBuildingBundleSources() {
    return { realtyPriceInfo, commercialPriceInfo, tradeInfo };
  }

  function renderDataStatus(loading: boolean, hasItems: boolean, error?: string) {
    if (loading) return <span className="data-status loading">조회 중…</span>;
    if (error && !hasItems) return <span className="data-status error" title={error}>error</span>;
    return <span className={`data-status ${hasItems ? 'ok' : 'empty'}`}>{hasItems ? 'O' : '-'}</span>;
  }

  function renderTradeCell(rec: PropertyRecord) {
    const info = tradeInfo[rec.pin];
    const hasItems = Boolean(info?.items.length);
    return renderDataStatus(tradeLoading && !info, hasItems, info?.error);
  }

  function renderCommercialPriceCell(rec: PropertyRecord) {
    const info = commercialPriceInfo[rec.pin];
    const hasItems = Boolean(info?.items.length);
    return renderDataStatus(commercialPriceLoading && !info, hasItems, info?.error);
  }

  function renderApartmentPriceCell(rec: PropertyRecord) {
    const info = realtyPriceInfo[rec.pin]?.apartment;
    const hasItems = Boolean(info?.items.length);
    return renderDataStatus(realtyPriceLoading && !info, hasItems, info?.error);
  }

  function renderIndividualPriceCell(rec: PropertyRecord) {
    const info = realtyPriceInfo[rec.pin]?.individual;
    const hasItems = Boolean(info?.items.length);
    return renderDataStatus(realtyPriceLoading && !info, hasItems, info?.error);
  }

  function renderBuildingRegisterCell(rec: PropertyRecord) {
    const info = buildingRegisterInfo[rec.pin];
    if (buildingRegisterLoading && !info) return renderDataStatus(true, false);
    if (info?.status === 'error') return renderDataStatus(false, false, info.error);

    const generalCount = info?.generalRegisterCount ?? 0;
    const hasMultipleGeneralRegisters = generalCount > 1;
    const registerDescriptions = info?.generalRegisterRows?.map((row, index) => {
      const area = row.totalArea ? `${row.totalArea}㎡` : '';
      return [area, row.mainPurpose].filter(Boolean).join(' ') || `${index + 1}번 대장`;
    }) ?? [];
    const registerSummary = generalCount > 0
      ? `이 지번의 건축물대장 ${generalCount}개${registerDescriptions.length ? ` — ${registerDescriptions.join(' / ')}` : ''}`
      : '';

    if (info?.status === 'available') {
      const ambiguous = !info.matchConfirmed;
      const ratio = hasMultipleGeneralRegisters && info.generalRegisterIndex
        ? ` (${info.generalRegisterIndex}/${generalCount})`
        : '';
      const title = [
        ambiguous ? '동일 지번에 건축물이 여러 동 있어 자동 확정되지 않았습니다. 발급물을 열어 확인하세요' : '',
        registerSummary,
      ].filter(Boolean).join('\n');
      return (
        <span
          className={`data-status ${ambiguous ? 'ambiguous' : 'ok'}${ratio ? ' with-count' : ''}`}
          title={title || undefined}
        >
          {ambiguous ? 'O?' : 'O'}{ratio}
        </span>
      );
    }
    if (info?.status === 'none' && generalCount > 0) {
      return (
        <span className="data-status empty" title={registerSummary}>
          {hasMultipleGeneralRegisters ? `- (${generalCount})` : '-'}
        </span>
      );
    }
    return renderDataStatus(false, false);
  }

  function renderLandJigaCell(rec: PropertyRecord) {
    const info = landInfo[rec.pin];
    return renderDataStatus(landLoading && !info, Boolean(info?.jiga.length), info?.error);
  }

  function renderLandGradeCell(rec: PropertyRecord) {
    const info = landInfo[rec.pin];
    return renderDataStatus(landLoading && !info, Boolean(info?.grade.length), info?.error);
  }

  function renderDownloadCell(rec: PropertyRecord) {
    if (rec.type === '토지') {
      const registerBusy = landRegisterPdfKey === rec.pin;
      const propertyRegisterBusy = propertyRegisterPdfKey === rec.pin;
      const pdfBusy = eumPrintingKey === rec.pin;
      const busy = running || landLoading || Boolean(eumPrintingKey) || Boolean(landRegisterPdfKey) || Boolean(propertyRegisterPdfKey);
      return (
        <div className="download-actions">
          <button
            type="button"
            className="row-action download-button paid"
            onClick={() => onPropertyRegisterPdfOne(rec)}
            disabled={busy}
            title="인터넷등기소 등기부등본 열람은 캐시가 없으면 건당 700원이 전자지갑에서 차감됩니다."
          >
            {propertyRegisterBusy ? '열람 중…' : '등기부 700원'}
          </button>
          <button
            type="button"
            className="row-action download-button"
            onClick={() => onLandRegisterPdfOne(rec)}
            disabled={busy}
            title="정부24에서 이 필지의 토지대장을 발급해 저장합니다."
          >
            {registerBusy ? '발급 중…' : '토지대장'}
          </button>
          <button
            type="button"
            className="row-action download-button"
            onClick={() => onLandBundlePdfOne(rec)}
            disabled={busy}
            title="이 필지의 공시지가, 토지등급, 토지이용계획을 하나의 PDF로 저장합니다."
          >
            {pdfBusy ? '생성 중…' : 'PDF'}
          </button>
          <button
            type="button"
            className="row-action download-button"
            disabled
            title="토지는 엑셀 다운로드를 지원하지 않습니다."
          >
            EXCEL
          </button>
        </div>
      );
    }

    const sources = currentBuildingBundleSources();
    const hasRegister = buildingRegisterInfo[rec.pin]?.status === 'available';
    const hasBundleData = hasBuildingBundleData(rec, sources);
    const registerBusy = buildingRegisterPdfKey === rec.pin;
    const propertyRegisterBusy = propertyRegisterPdfKey === rec.pin;
    const pdfBusy = bundlePdfPrintingKey === rec.pin;
    const excelBusy = bundleDownloadingKey === rec.pin;
    const busy = running ||
      tradeLoading ||
      commercialPriceLoading ||
      realtyPriceLoading ||
      buildingRegisterLoading ||
      Boolean(buildingRegisterPdfKey) ||
      Boolean(propertyRegisterPdfKey) ||
      Boolean(bundleDownloadingKey) ||
      Boolean(bundlePdfPrintingKey);
    const registerTitle = hasRegister ? '세움터 건축물대장 PDF만 저장합니다.' : '건축물대장을 찾지 못했습니다.';
    const pdfTitle = hasBundleData ? '건물 통합자료 PDF를 별도로 출력합니다.' : '내보낼 건물 통합자료가 없습니다.';
    const excelTitle = hasBundleData ? '있는 건물 자료만 묶어 저장합니다.' : '내보낼 엑셀 자료가 없습니다.';

    return (
      <div className="download-actions">
        <button
          type="button"
          className="row-action download-button paid"
          onClick={() => onPropertyRegisterPdfOne(rec)}
          disabled={busy}
          title="인터넷등기소 등기부등본 열람은 캐시가 없으면 건당 700원이 전자지갑에서 차감됩니다."
        >
          {propertyRegisterBusy ? '열람 중…' : '등기부 700원'}
        </button>
        <button
          type="button"
          className="row-action download-button"
          onClick={() => onBuildingRegisterPdfOne(rec)}
          disabled={busy || !hasRegister}
          title={registerTitle}
        >
          {registerBusy ? '생성 중…' : '건축물대장'}
        </button>
        <button
          type="button"
          className="row-action download-button"
          onClick={() => onBuildingBundlePdfOne(rec)}
          disabled={busy || !hasBundleData}
          title={pdfTitle}
        >
          {pdfBusy ? '생성 중…' : 'PDF'}
        </button>
        <button
          type="button"
          className="row-action download-button"
          onClick={() => onBuildingBundleExcelOne(rec)}
          disabled={busy || !hasBundleData}
          title={excelTitle}
        >
          {excelBusy ? '생성 중…' : 'EXCEL'}
        </button>
      </div>
    );
  }

  function setSelectedPins(rowIndex: number, selectedPins: string[]) {
    setRows((prev) => prev.map((r, idx) => (idx === rowIndex ? { ...r, selectedPins } : r)));
  }

  function toggleExpanded(rowIndex: number) {
    setAllExpandedOverride(null);
    setExpandedRows((prev) => ({ ...prev, [rowIndex]: !prev[rowIndex] }));
  }

  function togglePin(rowIndex: number, pin: string) {
    const row = rows[rowIndex];
    if (!row) return;
    const selected = new Set(row.selectedPins);
    if (selected.has(pin)) selected.delete(pin);
    else selected.add(pin);
    setSelectedPins(rowIndex, Array.from(selected));
  }

  function selectSuggested(rowIndex: number) {
    const row = rows[rowIndex];
    if (!row) return;
    setSelectedPins(
      rowIndex,
      row.records
        .filter((rec) => shouldSelectByDefault(classifyRecord(row.address, rec)))
        .map((rec) => rec.pin),
    );
  }

  function selectAll(rowIndex: number) {
    const row = rows[rowIndex];
    if (!row) return;
    setSelectedPins(rowIndex, row.records.map((rec) => rec.pin));
  }

  function clearSelection(rowIndex: number) {
    setSelectedPins(rowIndex, []);
  }

  async function onDownload() {
    if (!exportRecords.length || running) return;
    setDownloading(true);
    try {
      await downloadBatches(exportRecords);
    } finally {
      setDownloading(false);
    }
  }

  async function ensureLandInfoData(records: PropertyRecord[]) {
    const missing = records
      .filter((rec) => rec.type === '토지')
      .filter((rec) => !landInfo[rec.pin])
      .map((rec) => ({ key: rec.pin, address: rec.address }));
    const loaded = missing.length ? await loadLandInfo(missing) : {};
    return { ...landInfo, ...loaded };
  }

  async function onLandBundlePdfDownload() {
    if (!selectedLandRecords.length || selectedLandRecords.length > 50 || landDownloading || eumPrintingKey || landRegisterPdfKey || propertyRegisterPdfKey || running) return;

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('팝업이 차단되었습니다. 팝업 허용 후 다시 시도해 주세요.');
      return;
    }

    writeWindowMessage(printWindow, '토지 다운로드 생성 중', '선택한 토지를 토지이용계획서, 공시지가, 토지등급 순서로 병합하고 있습니다.');
    setLandDownloading(true);
    setEumPrintingKey('bulk');

    try {
      const mergedLandInfo = await ensureLandInfoData(selectedLandRecords);
      const html = await fetchEumPrintHtml({
        items: selectedLandRecords.map((rec) => toEumPrintItem(rec, mergedLandInfo)),
      });
      const combined = buildLandBundlePdfHtmlMany(selectedLandRecords, mergedLandInfo, html);
      if (!combined) throw new Error('출력할 토지 자료가 없습니다.');
      writeAndPrintWindow(printWindow, combined);
    } catch (e: any) {
      writeWindowMessage(printWindow, '토지 다운로드 생성 실패', e?.message ?? '토지 통합 PDF 생성에 실패했습니다.');
    } finally {
      setLandDownloading(false);
      setEumPrintingKey(null);
    }
  }

  async function onLandRegisterPdfOne(rec: PropertyRecord) {
    if (running || landLoading || eumPrintingKey || landRegisterPdfKey || propertyRegisterPdfKey) return;

    setLandRegisterPdfKey(rec.pin);
    try {
      const { blob, filename } = await downloadLandRegisterPdf({ items: [toLandRegisterItem(rec)] });
      triggerBlobDownload(blob, filename);
    } catch (e: any) {
      alert(e?.message ?? '토지대장 PDF 발급에 실패했습니다.');
    } finally {
      setLandRegisterPdfKey(null);
    }
  }

  async function onLandRegisterPdfDownload() {
    if (!selectedLandRecords.length || selectedLandRecords.length > 50 || running || landLoading || eumPrintingKey || landRegisterPdfKey || propertyRegisterPdfKey) return;

    setLandRegisterPdfKey('bulk');
    try {
      const { blob, filename } = await downloadLandRegisterPdf({
        items: selectedLandRecords.map(toLandRegisterItem),
      });
      triggerBlobDownload(blob, filename);
    } catch (e: any) {
      alert(e?.message ?? '토지대장 PDF 발급에 실패했습니다.');
    } finally {
      setLandRegisterPdfKey(null);
    }
  }

  async function onPropertyRegisterPdfOne(rec: PropertyRecord) {
    if (running || propertyRegisterPdfKey || landRegisterPdfKey || buildingRegisterPdfKey || eumPrintingKey || bundleDownloadingKey || bundlePdfPrintingKey) return;

    setPropertyRegisterPdfKey(rec.pin);
    try {
      const { blob, filename } = await downloadPropertyRegisterPdf({ items: [toPropertyRegisterItem(rec)] });
      triggerBlobDownload(blob, filename);
    } catch (e: any) {
      alert(e?.message ?? '등기부등본 PDF 열람에 실패했습니다.');
    } finally {
      setPropertyRegisterPdfKey(null);
    }
  }

  async function onPropertyRegisterPdfDownload() {
    if (!exportRecords.length || exportRecords.length > 30 || running || propertyRegisterPdfKey || landRegisterPdfKey || buildingRegisterPdfKey || eumPrintingKey || bundleDownloadingKey || bundlePdfPrintingKey) return;

    setPropertyRegisterPdfKey('bulk');
    try {
      const { blob, filename } = await downloadPropertyRegisterPdf({
        items: exportRecords.map(toPropertyRegisterItem),
      });
      triggerBlobDownload(blob, filename);
    } catch (e: any) {
      alert(e?.message ?? '등기부등본 PDF 열람에 실패했습니다.');
    } finally {
      setPropertyRegisterPdfKey(null);
    }
  }

  async function ensureBuildingBundleData(records: PropertyRecord[]) {
    const [loadedTrade, loadedCommercial, loadedRealty] = await Promise.all([
      loadBuildingTrades(records.filter((rec) => !tradeInfo[rec.pin])),
      loadCommercialPrices(records.filter((rec) => !commercialPriceInfo[rec.pin])),
      loadRealtyPrices(records.filter((rec) => !realtyPriceInfo[rec.pin])),
    ]);

    return {
      tradeInfo: { ...tradeInfo, ...loadedTrade },
      commercialPriceInfo: { ...commercialPriceInfo, ...loadedCommercial },
      realtyPriceInfo: { ...realtyPriceInfo, ...loadedRealty },
    };
  }

  async function ensureBuildingRegisterData() {
    // PNU 배정은 선택에 따라 달라지면 안 되므로 캐시 유무와 무관하게 전체 건물 형제를 함께 보낸다.
    const loaded = allBuildingRecords.length ? await loadBuildingRegisters(allBuildingRecords) : {};
    return { ...buildingRegisterInfo, ...loaded };
  }

  async function onBuildingRegisterPdfOne(rec: PropertyRecord) {
    if (running || bundleDownloadingKey || bundlePdfPrintingKey || buildingRegisterPdfKey || propertyRegisterPdfKey) return;

    setBuildingRegisterPdfKey(rec.pin);
    try {
      const info = await ensureBuildingRegisterData();
      if (info[rec.pin]?.status !== 'available') {
        alert('이 건물의 건축물대장을 찾지 못했습니다.');
        return;
      }
      const { blob, filename } = await downloadBuildingRegisterPdf({
        items: allBuildingRecords.map(toBuildingRegisterItem),
        selectedKeys: [rec.pin],
      });
      triggerBlobDownload(blob, filename);
    } catch (e: any) {
      alert(e?.message ?? '건축물대장 PDF 생성에 실패했습니다.');
    } finally {
      setBuildingRegisterPdfKey(null);
    }
  }

  async function onBuildingBundleExcelOne(rec: PropertyRecord) {
    if (running || bundleDownloadingKey || bundlePdfPrintingKey || buildingRegisterPdfKey || propertyRegisterPdfKey) return;

    setBundleDownloadingKey(rec.pin);
    try {
      const sources = await ensureBuildingBundleData([rec]);
      const downloaded = downloadBuildingBundleWorkbook(rec, sources);
      if (!downloaded) alert('이 건물의 내보낼 자료가 없습니다.');
    } finally {
      setBundleDownloadingKey(null);
    }
  }

  async function onBuildingBundlePdfOne(rec: PropertyRecord) {
    if (running || bundleDownloadingKey || bundlePdfPrintingKey || buildingRegisterPdfKey || propertyRegisterPdfKey) return;

    setBundlePdfPrintingKey(rec.pin);
    try {
      const sources = await ensureBuildingBundleData([rec]);
      const printed = printBuildingBundlePdf(rec, sources);
      if (!printed) alert('이 건물의 내보낼 자료가 없습니다.');
    } finally {
      setBundlePdfPrintingKey(null);
    }
  }

  async function onBuildingBundleZipDownload() {
    if (!selectedBuildingRecords.length || running || bundleDownloadingKey || bundlePdfPrintingKey || buildingRegisterPdfKey || propertyRegisterPdfKey) return;

    setBundleDownloadingKey('bulk');
    try {
      const sources = await ensureBuildingBundleData(selectedBuildingRecords);
      const downloaded = await downloadBuildingBundleZip(selectedBuildingRecords, sources);
      if (!downloaded) alert('선택된 건물의 내보낼 자료가 없습니다.');
    } finally {
      setBundleDownloadingKey(null);
    }
  }

  async function onBuildingBundlePdfDownload() {
    if (!selectedBuildingRecords.length || running || bundleDownloadingKey || bundlePdfPrintingKey || buildingRegisterPdfKey || propertyRegisterPdfKey) return;

    setBundlePdfPrintingKey('bulk');
    try {
      const sources = await ensureBuildingBundleData(selectedBuildingRecords);
      const printed = printBuildingBundlePdf(selectedBuildingRecords, sources);
      if (!printed) alert('선택된 건물의 내보낼 자료가 없습니다.');
    } finally {
      setBundlePdfPrintingKey(null);
    }
  }

  async function onBuildingRegisterPdfDownload() {
    if (!selectedBuildingRecords.length || running || bundleDownloadingKey || bundlePdfPrintingKey || buildingRegisterPdfKey || propertyRegisterPdfKey) return;

    setBuildingRegisterPdfKey('bulk');
    try {
      const registerInfo = await ensureBuildingRegisterData();
      const registerRecords = selectedBuildingRecords.filter((rec) => registerInfo[rec.pin]?.status === 'available');
      if (!registerRecords.length) {
        alert('선택된 건물의 건축물대장을 찾지 못했습니다.');
        return;
      }
      const { blob, filename } = await downloadBuildingRegisterPdf({
        items: allBuildingRecords.map(toBuildingRegisterItem),
        selectedKeys: registerRecords.map((rec) => rec.pin),
      });
      triggerBlobDownload(blob, filename);
    } catch (e: any) {
      alert(e?.message ?? '건축물대장 PDF 생성에 실패했습니다.');
    } finally {
      setBuildingRegisterPdfKey(null);
    }
  }

  const query = searchTerm.trim();
  const filtersActive = Boolean(query) || resultFilter !== 'all' || typeFilter !== 'all';
  const visibleRows = rows
    .map((r, i) => {
      const selected = new Set(r.selectedPins);
      const selectedCount = r.records.filter((rec) => selected.has(rec.pin)).length;
      const classifiedRecords = r.records.map((rec) => ({ rec, kind: classifyRecord(r.address, rec) }));
      const visibleClassifiedRecords = classifiedRecords.filter(({ rec, kind }) =>
        matchesResultFilter(kind, selected.has(rec.pin), resultFilter) &&
        (typeFilter === 'all' || rec.type === typeFilter) &&
        matchesSearch(recordSearchText(r.address, rec, kind), query),
      );
      const matchCounts = countMatches(classifiedRecords.map((x) => x.kind));
      const noFilterActive = resultFilter === 'all' && typeFilter === 'all';
      const rowMatches = r.status === 'done'
        ? (r.records.length === 0
          ? noFilterActive && matchesSearch(`${r.address} 결과 없음`, query)
          : visibleClassifiedRecords.length > 0)
        : noFilterActive && matchesSearch(`${r.address} ${r.error ?? ''} ${r.status}`, query);
      const expanded = allExpandedOverride ?? (filtersActive || (expandedRows[i] ?? false));

      return {
        row: r,
        index: i,
        selected,
        selectedCount,
        classifiedRecords,
        visibleClassifiedRecords,
        matchCounts,
        expanded,
        visible: rowMatches,
      };
    })
    .filter((item) => item.visible);

  function clearFilters() {
    setSearchTerm('');
    setResultFilter('all');
    setTypeFilter('all');
    setAllExpandedOverride(null);
  }

  const allVisibleRowsExpanded = visibleRows.length > 0 && visibleRows.every((item) => item.expanded);

  function toggleAllExpanded() {
    if (!visibleRows.length) return;
    const shouldExpand = !allVisibleRowsExpanded;
    setAllExpandedOverride(shouldExpand);
    setExpandedRows((prev) => {
      const next = { ...prev };
      for (const item of visibleRows) next[item.index] = shouldExpand;
      return next;
    });
  }

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <div className="title-row">
            <h1>부동산고유번호 조회</h1>
            <a
              className="guide-link"
              href="https://merciful-situation-70f.notion.site/4-39632a11691780318f21f3303af62f52"
              target="_blank"
              rel="noreferrer"
            >
              4종세트 일괄다운로드 방법
            </a>
          </div>
          <p className="sub">주소를 줄바꿈으로 여러 건 입력하세요. 시·도 없이 주소만 넣어도 됩니다.</p>
        </div>
        <div className="top-actions">
          <button
            className="dl"
            onClick={onDownload}
            disabled={!exportRecords.length || running || downloading}
            title={running ? '전체 조회가 끝난 뒤 엑셀 다운로드를 사용할 수 있습니다.' : undefined}
          >
            {running
              ? '조회 완료 후 다운로드'
              : downloading
                ? '생성 중…'
                : `고유번호 (${exportRecords.length}건)`}
          </button>
          <button
            className="dl paid"
            onClick={onPropertyRegisterPdfDownload}
            disabled={!exportRecords.length || exportRecords.length > 30 || running || Boolean(propertyRegisterPdfKey) || Boolean(landRegisterPdfKey) || Boolean(buildingRegisterPdfKey) || Boolean(eumPrintingKey) || Boolean(bundleDownloadingKey) || Boolean(bundlePdfPrintingKey)}
            title={exportRecords.length > 30
              ? '유료 열람은 한 번에 최대 30건까지 가능합니다.'
              : `캐시가 없는 등기부등본은 건당 700원이 차감됩니다. 선택 ${exportRecords.length}건의 최대 비용은 ${(exportRecords.length * 700).toLocaleString('ko-KR')}원입니다.`}
          >
            {propertyRegisterPdfKey === 'bulk'
              ? '유료 열람 중…'
              : `등기부등본 PDF (${exportRecords.length}건 · 건당 700원)`}
          </button>
          <button
            className="dl land"
            onClick={onLandBundlePdfDownload}
            disabled={!selectedLandRecords.length || selectedLandRecords.length > 50 || running || landLoading || landDownloading || Boolean(eumPrintingKey) || Boolean(landRegisterPdfKey) || Boolean(propertyRegisterPdfKey)}
            title={selectedLandRecords.length > 50 ? '한 번에 최대 50필지까지 인쇄할 수 있습니다.' : '선택한 토지를 토지이용계획서, 공시지가, 토지등급 순서로 병합합니다.'}
          >
            {landDownloading || eumPrintingKey === 'bulk' || landLoading ? '생성 중…' : `토지 다운로드 (${selectedLandRecords.length}건)`}
          </button>
          <button
            className="dl land"
            onClick={onLandRegisterPdfDownload}
            disabled={!selectedLandRecords.length || selectedLandRecords.length > 50 || running || landLoading || landDownloading || Boolean(eumPrintingKey) || Boolean(landRegisterPdfKey) || Boolean(propertyRegisterPdfKey)}
            title={selectedLandRecords.length > 50 ? '한 번에 최대 50필지까지 발급할 수 있습니다.' : '선택한 토지의 정부24 토지대장을 발급해 하나의 PDF로 병합합니다.'}
          >
            {landRegisterPdfKey === 'bulk' ? 'PDF 발급 중…' : `토지대장 PDF (${selectedLandRecords.length}건)`}
          </button>
          <details className="download-menu" open={buildingMenuOpen} ref={buildingMenuRef}>
            <summary
              className="dl menu-summary building"
              onClick={(event) => {
                event.preventDefault();
                setBuildingMenuOpen((open) => !open);
              }}
            >
              건물 다운로드
            </summary>
            <div className="download-menu-panel">
              <button
                type="button"
                onClick={() => {
                  setBuildingMenuOpen(false);
                  onBuildingBundleZipDownload();
                }}
                disabled={!selectedBuildingRecords.length || running || tradeLoading || commercialPriceLoading || realtyPriceLoading || buildingRegisterLoading || Boolean(bundleDownloadingKey) || Boolean(bundlePdfPrintingKey) || Boolean(buildingRegisterPdfKey) || Boolean(propertyRegisterPdfKey)}
              >
                {bundleDownloadingKey === 'bulk' ? '생성 중…' : `EXCEL(ZIP) (${selectedBuildingRecords.length}건)`}
              </button>
              <button
                type="button"
                onClick={() => {
                  setBuildingMenuOpen(false);
                  onBuildingBundlePdfDownload();
                }}
                disabled={!selectedBuildingRecords.length || running || tradeLoading || commercialPriceLoading || realtyPriceLoading || buildingRegisterLoading || Boolean(bundleDownloadingKey) || Boolean(bundlePdfPrintingKey) || Boolean(buildingRegisterPdfKey) || Boolean(propertyRegisterPdfKey)}
              >
                {bundlePdfPrintingKey === 'bulk' ? 'PDF 생성 중…' : `통합자료 PDF (${selectedBuildingRecords.length}건)`}
              </button>
              <button
                type="button"
                onClick={() => {
                  setBuildingMenuOpen(false);
                  onBuildingRegisterPdfDownload();
                }}
                disabled={!selectedBuildingRegisterRecords.length || running || buildingRegisterLoading || Boolean(bundleDownloadingKey) || Boolean(bundlePdfPrintingKey) || Boolean(buildingRegisterPdfKey) || Boolean(propertyRegisterPdfKey)}
              >
                {buildingRegisterPdfKey === 'bulk' ? 'PDF 생성 중…' : `건축물대장 PDF (${selectedBuildingRegisterRecords.length}건)`}
              </button>
            </div>
          </details>
        </div>
      </header>

      <div className="form">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={'서울특별시 송파구 석촌동 265-5\n서울특별시 서초구 반포동 20-1\n...'}
          rows={5}
        />
        <button className="go" onClick={onCollect} disabled={running}>
          {running ? `조회 중… (${done}/${rows.length})` : '조회'}
        </button>
      </div>

      {rows.length > 0 && (
        <div className="filters">
          <input
            className="filter-search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="주소, 도로명, 고유번호, 동/호"
          />
          <div className="filter-segments" role="group" aria-label="유형 필터">
            {TYPE_FILTER_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={typeFilter === option.value ? 'active' : undefined}
                onClick={() => setTypeFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="filter-segments" role="group" aria-label="결과 필터">
            {FILTER_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={resultFilter === option.value ? 'active' : undefined}
                onClick={() => setResultFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button type="button" className="filter-reset" onClick={clearFilters} disabled={!filtersActive}>
            초기화
          </button>
          <button type="button" className="filter-toggle" onClick={toggleAllExpanded} disabled={!visibleRows.length}>
            {allVisibleRowsExpanded ? '전체접기' : '전체펼치기'}
          </button>
        </div>
      )}

      <div className="results">
        {visibleRows.length === 0 && rows.length > 0 && (
          <div className="empty-filter">조건에 맞는 결과가 없습니다.</div>
        )}

        {visibleRows.map(({ row: r, index: i, selected, selectedCount, visibleClassifiedRecords, matchCounts, expanded }) => {
          return (
            <section key={i} className={`card ${r.status} ${expanded ? 'expanded' : 'collapsed'}`}>
              <button
                type="button"
                className="card-head"
                onClick={() => toggleExpanded(i)}
                aria-expanded={expanded}
                aria-controls={`result-panel-${i}`}
              >
                <div className="head-main">
                  <span className="addr">{r.address}</span>
                  {r.status === 'done' && r.records.length > 0 && (
                    <span className="select-summary">선택 {selectedCount}/{r.records.length}건</span>
                  )}
                  {r.status === 'done' && r.records.length > 0 && (
                    <span className="match-counts">
                      {MATCH_ORDER.filter((kind) => matchCounts[kind] > 0).map((kind) => (
                        <span key={kind} className={`match-count ${kind}`}>
                          {MATCH_LABELS[kind]} {matchCounts[kind]}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                <span className="head-side">
                  <span className={`badge ${r.status}`}>
                    {r.status === 'pending' && '대기'}
                    {r.status === 'loading' && '조회 중…'}
                    {r.status === 'done' && `${r.records.length}건`}
                    {r.status === 'error' && '실패'}
                  </span>
                  <span className="chevron" aria-hidden="true" />
                </span>
              </button>

              {expanded && (
                <div id={`result-panel-${i}`} className="card-panel">
                  {r.status === 'error' && <div className="err-msg">{r.error}</div>}

                  {r.status === 'done' && r.records.length === 0 && <div className="err-msg">결과 없음</div>}

                  {r.status === 'done' && r.records.length > 0 && (
                    <>
                      <div className="record-toolbar">
                        <span>정확·관련 결과가 기본 선택됩니다.</span>
                        <div className="record-actions">
                          <button type="button" onClick={() => selectSuggested(i)}>정확·관련 선택</button>
                          <button type="button" onClick={() => selectAll(i)}>전체선택</button>
                          <button type="button" onClick={() => clearSelection(i)}>전체해제</button>
                        </div>
                      </div>

                      <div className="table-wrap">
                        <table className="records-table">
                          <colgroup>
                            <col className="col-check" />
                            <col className="col-property" />
                            <col className="col-type" />
                            <col span={8} className="col-status" />
                            <col className="col-download" />
                          </colgroup>
                          <thead>
                            <tr>
                              <th className="check-col">선택</th>
                              <th className="property-col">
                                부동산표시
                                <span className="column-hint">(고유번호)</span>
                              </th>
                              <th className="type-col">
                                유형
                                <span className="column-hint">(매칭)</span>
                              </th>
                              <th className="status-col">공시지가</th>
                              <th className="status-col">토지등급</th>
                              <th className="status-col">토지이용계획</th>
                              <th className="status-col">공동주택가격</th>
                              <th className="status-col">개별주택가격</th>
                              <th className="status-col">상가/오피스 기준시가</th>
                              <th className="status-col">실거래가</th>
                              <th className="status-col">건축물대장</th>
                              <th className="download-col">다운로드</th>
                            </tr>
                          </thead>
                          <tbody>
                            {visibleClassifiedRecords.map(({ rec, kind }) => {
                              const checked = selected.has(rec.pin);
                              return (
                                <tr key={rec.pin} className={checked ? 'selected-row' : undefined}>
                                  <td className="check-col">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => togglePin(i, rec.pin)}
                                      aria-label={`${rec.pinFmt} 선택`}
                                    />
                                  </td>
                                  <td className="property-col property-cell">
                                    <div className="property-address">{rec.address}</div>
                                    {(rec.roadAddr || rec.floor || rec.room) && (
                                      <div className="record-meta">
                                        {[rec.roadAddr, rec.floor && `${rec.floor}층`, rec.room && `${rec.room}호`]
                                          .filter(Boolean)
                                          .join(' · ')}
                                      </div>
                                    )}
                                    <div className="property-pin">({rec.pinFmt})</div>
                                  </td>
                                  <td className="type-col">
                                    <div className="type-stack">
                                      <span className="type-value">{rec.type}</span>
                                      <span className={`match ${kind}`}>{MATCH_LABELS[kind]}</span>
                                    </div>
                                  </td>
                                  {(() => {
                                    if (rec.type !== '토지') {
                                      return (
                                        <>
                                          <td className="land-cell">-</td>
                                          <td className="land-cell">-</td>
                                          <td className="eum-cell">-</td>
                                          <td className="realty-price-cell">{renderApartmentPriceCell(rec)}</td>
                                          <td className="realty-price-cell">{renderIndividualPriceCell(rec)}</td>
                                          <td className="commercial-price-cell">{renderCommercialPriceCell(rec)}</td>
                                          <td className="trade-cell">{renderTradeCell(rec)}</td>
                                          <td className="building-register-cell">{renderBuildingRegisterCell(rec)}</td>
                                          <td className="download-col">{renderDownloadCell(rec)}</td>
                                        </>
                                      );
                                    }
                                    const li = landInfo[rec.pin];
                                    if (!li) return (
                                      <>
                                        <td className="land-cell">{renderLandJigaCell(rec)}</td>
                                        <td className="land-cell">{renderLandGradeCell(rec)}</td>
                                        <td className="eum-cell">{renderDataStatus(false, true)}</td>
                                        <td className="realty-price-cell">-</td>
                                        <td className="realty-price-cell">-</td>
                                        <td className="commercial-price-cell">-</td>
                                        <td className="trade-cell">-</td>
                                        <td className="building-register-cell">-</td>
                                        <td className="download-col">{renderDownloadCell(rec)}</td>
                                      </>
                                    );
                                    return (
                                      <>
                                        <td className="land-cell">{renderLandJigaCell(rec)}</td>
                                        <td className="land-cell">{renderLandGradeCell(rec)}</td>
                                        <td className="eum-cell">{renderDataStatus(false, true)}</td>
                                        <td className="realty-price-cell">-</td>
                                        <td className="realty-price-cell">-</td>
                                        <td className="commercial-price-cell">-</td>
                                        <td className="trade-cell">-</td>
                                        <td className="building-register-cell">-</td>
                                        <td className="download-col">{renderDownloadCell(rec)}</td>
                                      </>
                                    );
                                  })()}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </main>
  );
}
