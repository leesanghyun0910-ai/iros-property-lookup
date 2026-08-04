// Cloudflare Worker — /api/* 처리 + 정적 자산 서빙
import { collectAddress } from './iros/collect';
import { refreshLdong, KV_META, type LdongMeta } from './ldong/refresh';
import { addressesToPnu } from './ldong/lookup';
import { fetchLandInfos } from './landinfo';
import { fetchBuildingTrades } from './trade';
import { fetchCommercialPrices } from './commercial-price';
import { fetchRealtyPrices } from './realty-price';
import { buildEumPrintHtml } from './eum/print';
import type {
  BuildingTradeRequest,
  CollectRequest,
  CommercialPriceRequest,
  EumPrintItem,
  EumPrintRequest,
  RealtyPriceRequest,
} from '../shared/types';

export interface Env {
  ASSETS: Fetcher;
  LDONG: KVNamespace;
  ODCLOUD_API_KEY: string;
  VWORLD_API_KEY: string;
  ADMIN_TOKEN?: string; // 수동 갱신 엔드포인트 보호 (선택)
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=UTF-8', ...CORS },
  });

const html = (content: string, status = 200) =>
  new Response(content, {
    status,
    headers: { 'Content-Type': 'text/html; charset=UTF-8', ...CORS },
  });

function normalizeEumItems(value: unknown): EumPrintItem[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .map((item: any) => ({
      key: String(item?.key ?? '').trim(),
      address: String(item?.address ?? '').trim(),
      label: item?.label == null ? undefined : String(item.label).trim(),
      jigaText: item?.jigaText == null ? undefined : String(item.jigaText).trim(),
    }))
    .filter((item) => item.key && item.address);
}

function normalizeBuildingTradeItems(value: unknown): BuildingTradeRequest['items'] | null {
  if (!Array.isArray(value)) return null;
  return value
    .map((item: any) => ({
      key: String(item?.key ?? '').trim(),
      address: String(item?.address ?? '').trim(),
      roadAddr: item?.roadAddr == null ? undefined : String(item.roadAddr).trim(),
      building: item?.building == null ? undefined : String(item.building).trim(),
      floor: item?.floor == null ? undefined : String(item.floor).trim(),
      room: item?.room == null ? undefined : String(item.room).trim(),
      type: item?.type == null ? undefined : String(item.type).trim(),
    }))
    .filter((item) => item.key && item.address);
}

function normalizeCommercialPriceItems(value: unknown): CommercialPriceRequest['items'] | null {
  if (!Array.isArray(value)) return null;
  return value
    .map((item: any) => ({
      key: String(item?.key ?? '').trim(),
      address: String(item?.address ?? '').trim(),
      roadAddr: item?.roadAddr == null ? undefined : String(item.roadAddr).trim(),
      building: item?.building == null ? undefined : String(item.building).trim(),
      floor: item?.floor == null ? undefined : String(item.floor).trim(),
      room: item?.room == null ? undefined : String(item.room).trim(),
      type: item?.type == null ? undefined : String(item.type).trim(),
    }))
    .filter((item) => item.key && item.address);
}

function normalizeRealtyPriceItems(value: unknown): RealtyPriceRequest['items'] | null {
  if (!Array.isArray(value)) return null;
  return value
    .map((item: any) => ({
      key: String(item?.key ?? '').trim(),
      address: String(item?.address ?? '').trim(),
      roadAddr: item?.roadAddr == null ? undefined : String(item.roadAddr).trim(),
      building: item?.building == null ? undefined : String(item.building).trim(),
      floor: item?.floor == null ? undefined : String(item.floor).trim(),
      room: item?.room == null ? undefined : String(item.room).trim(),
      type: item?.type == null ? undefined : String(item.type).trim(),
    }))
    .filter((item) => item.key && item.address);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (url.pathname === '/api/health') {
      return json({ ok: true, service: 'iros-property-lookup' });
    }

    // 법정동코드 캐시 상태
    if (url.pathname === '/api/ldong/status') {
      const metaStr = await env.LDONG.get(KV_META);
      const meta: LdongMeta | null = metaStr ? JSON.parse(metaStr) : null;
      return json({ ok: true, cached: Boolean(meta), meta });
    }

    // ④ 수동 강제 갱신 (ADMIN_TOKEN 설정 시 보호)
    if (url.pathname === '/api/admin/refresh-ldong' && request.method === 'POST') {
      if (env.ADMIN_TOKEN && request.headers.get('x-admin-token') !== env.ADMIN_TOKEN) {
        return json({ ok: false, error: '인증 실패' }, 401);
      }
      try {
        const meta = await refreshLdong(env);
        return json({ ok: true, meta });
      } catch (e: any) {
        return json({ ok: false, error: e?.message ?? '갱신 실패' }, 502);
      }
    }

    // 주소 → PNU 일괄 변환 (부트스트랩/TTL 갱신 포함)
    if (url.pathname === '/api/pnu' && request.method === 'POST') {
      let body: { addresses?: string[] };
      try {
        body = (await request.json()) as { addresses?: string[] };
      } catch {
        return json({ ok: false, error: '잘못된 요청 본문' }, 400);
      }
      if (!Array.isArray(body?.addresses)) {
        return json({ ok: false, error: 'addresses 배열 필수' }, 400);
      }
      try {
        const results = await addressesToPnu(body.addresses, env, ctx);
        return json({ ok: true, results });
      } catch (e: any) {
        return json({ ok: false, error: e?.message ?? 'PNU 변환 실패' }, 502);
      }
    }

    if (url.pathname === '/api/collect' && request.method === 'POST') {
      let body: CollectRequest;
      try {
        body = (await request.json()) as CollectRequest;
      } catch {
        return json({ ok: false, error: '잘못된 요청 본문' }, 400);
      }
      if (!body?.address) {
        return json({ ok: false, error: 'address 필수' }, 400);
      }
      try {
        const result = await collectAddress(body);
        return json(result);
      } catch (e: any) {
        return json({ ok: false, total: 0, collected: 0, records: [], error: e?.message ?? '수집 실패' }, 502);
      }
    }

    // 선택된 토지 → EUM 부분인쇄 HTML 일괄 생성
    if (url.pathname === '/api/eum/print-html' && request.method === 'POST') {
      let body: EumPrintRequest;
      try {
        body = (await request.json()) as EumPrintRequest;
      } catch {
        return json({ ok: false, error: '잘못된 요청 본문' }, 400);
      }
      const items = normalizeEumItems(body?.items);
      if (!items?.length) {
        return json({ ok: false, error: 'items 배열 필수' }, 400);
      }
      if (items.length > 50) {
        return json({ ok: false, error: '한 번에 최대 50필지까지 인쇄할 수 있습니다.' }, 400);
      }
      try {
        return html(await buildEumPrintHtml(items, env, ctx));
      } catch (e: any) {
        return json({ ok: false, error: e?.message ?? '토지이용계획 인쇄 HTML 생성 실패' }, 502);
      }
    }

    // 토지 공시지가 + 토지등급 조회 (주소 → PNU → V-World)
    if (url.pathname === '/api/landinfo' && request.method === 'POST') {
      let body: { items?: { key: string; address: string }[] };
      try {
        body = (await request.json()) as { items?: { key: string; address: string }[] };
      } catch {
        return json({ ok: false, error: '잘못된 요청 본문' }, 400);
      }
      if (!Array.isArray(body?.items)) {
        return json({ ok: false, error: 'items 배열 필수' }, 400);
      }
      try {
        const results = await fetchLandInfos(body.items, env, ctx);
        return json({ ok: true, results });
      } catch (e: any) {
        return json({ ok: false, error: e?.message ?? '조회 실패' }, 502);
      }
    }

    // 선택된 건물/집합건물 → 최근 1년 매매 실거래가 4종 조회
    if (url.pathname === '/api/building-trades' && request.method === 'POST') {
      let body: BuildingTradeRequest;
      try {
        body = (await request.json()) as BuildingTradeRequest;
      } catch {
        return json({ ok: false, error: '잘못된 요청 본문' }, 400);
      }
      const items = normalizeBuildingTradeItems(body?.items);
      if (!items) {
        return json({ ok: false, error: 'items 배열 필수' }, 400);
      }
      if (items.length > 1000) {
        return json({ ok: false, error: '한 번에 최대 1000개 건물까지 조회할 수 있습니다.' }, 400);
      }
      try {
        const results = await fetchBuildingTrades(items, env, ctx);
        return json({ ok: true, results });
      } catch (e: any) {
        return json({ ok: false, error: e?.message ?? '실거래가 조회 실패' }, 502);
      }
    }

    // 건물/집합건물 → Hometax 상가/오피스텔 기준시가 조회
    if (url.pathname === '/api/commercial-prices' && request.method === 'POST') {
      let body: CommercialPriceRequest;
      try {
        body = (await request.json()) as CommercialPriceRequest;
      } catch {
        return json({ ok: false, error: '잘못된 요청 본문' }, 400);
      }
      const items = normalizeCommercialPriceItems(body?.items);
      if (!items) {
        return json({ ok: false, error: 'items 배열 필수' }, 400);
      }
      if (items.length > 1000) {
        return json({ ok: false, error: '한 번에 최대 1000개 건물까지 조회할 수 있습니다.' }, 400);
      }
      try {
        const results = await fetchCommercialPrices(items, env, ctx);
        return json({ ok: true, results });
      } catch (e: any) {
        return json({ ok: false, error: e?.message ?? '상가/오피스 기준시가 조회 실패' }, 502);
      }
    }

    // 토지/건물/집합건물 → 부동산공시가격 알리미 공동주택가격 + 개별주택가격 조회
    if (url.pathname === '/api/realty-prices' && request.method === 'POST') {
      let body: RealtyPriceRequest;
      try {
        body = (await request.json()) as RealtyPriceRequest;
      } catch {
        return json({ ok: false, error: '잘못된 요청 본문' }, 400);
      }
      const items = normalizeRealtyPriceItems(body?.items);
      if (!items) {
        return json({ ok: false, error: 'items 배열 필수' }, 400);
      }
      if (items.length > 1000) {
        return json({ ok: false, error: '한 번에 최대 1000개까지 조회할 수 있습니다.' }, 400);
      }
      try {
        const results = await fetchRealtyPrices(items, env, ctx);
        return json({ ok: true, results });
      } catch (e: any) {
        return json({ ok: false, error: e?.message ?? '공시가격 조회 실패' }, 502);
      }
    }

    // 그 외 → 정적 자산 (SPA)
    return env.ASSETS.fetch(request);
  },

  // ① 정기 갱신 — 법정동코드는 매일 04:00 KST 재수집
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === '0 19 * * *') {
      ctx.waitUntil(refreshLdong(env).catch((e) => console.error('cron refresh 실패:', e?.message)));
    }
  },
};
