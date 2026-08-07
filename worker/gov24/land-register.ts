// 정부24 토지대장 발급 어댑터
// 이번 스코프에서는 배포된 세움터용 바인딩 이름을 바꾸지 않고 D1/R2를 함께 사용한다.
import { PDFDocument } from 'pdf-lib';
import type {
  LandRegisterDownloadRequest,
  LandRegisterRequestItem,
} from '../../shared/types';
import { addressToPnu } from '../ldong/lookup';

const KOREACONNECT_ENDPOINT = 'https://api.koreaconnect.kr/01/1/2603101434213625838HYP/PUBAD/in0005000203';
const DOCUMENT_TTL_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ITEMS_PER_DOWNLOAD = 50;
const ISSUE_CONCURRENCY = 2;
const PROCESSING_STALE_MS = 10 * 60 * 1000;
const EXTERNAL_REQUEST_TIMEOUT_MS = 30_000;
const KOREACONNECT_RETRY_DELAYS_MS = [500, 1_000];

// 소유권 변동 연혁은 포함하되 주민등록번호 뒷자리는 숨기고, 일반대장과 최근 7년 공시지가를 발급한다.
const LAND_REGISTER_OPTIONS = {
  printGb: '01',
  noGb: '02',
  closureGb: '01',
  priceYearGb: '01',
} as const;

export interface LandRegisterEnv {
  LDONG: KVNamespace;
  ODCLOUD_API_KEY: string;
  KOREACONNECT_API_KEY?: string;
  GOV24_ID?: string;
  GOV24_PW?: string;
  BUILDING_REGISTER_DB?: D1Database;
  BUILDING_REGISTER_PDFS?: R2Bucket;
}

interface KoreaConnectRequestParameters {
  nonMemberYn: 'N';
  loginMethod: 'ID';
  userId: string;
  userPw: string;
  pnuCd: string;
  printGb: '01';
  noGb: '02';
  closureGb: '01';
  priceYearGb: '01';
  requestType: '02';
}

interface KoreaConnectResponse {
  common?: {
    userTrNo?: string;
    hyphenTrNo?: string;
    errYn?: string;
    errCd?: string;
    errMsg?: string;
  };
  data?: {
    hexString?: string;
    cappReqNo?: string;
    CappReqNo?: string;
  };
  errorCode?: string;
  errorMessage?: string;
}

interface ParsedKoreaConnectResponse {
  payload: KoreaConnectResponse | null;
  parseError: Error | null;
}

interface ResolvedItem {
  item: LandRegisterRequestItem;
  pnu: string;
}

interface ReadyDocument {
  id: string;
  pnu: string;
  r2Key: string;
  byteSize: number;
  pageCount: number;
}

function buildRequestBody(parameters: KoreaConnectRequestParameters) {
  // 실측: flat + 실제 PNU는 성공했고, body로 감싸면 필드를 읽지 못해 VALID-999가 발생했다.
  return parameters;
}

function requireConfiguration(env: LandRegisterEnv) {
  if (!env.KOREACONNECT_API_KEY) throw new Error('KOREACONNECT_API_KEY 설정이 필요합니다.');
  if (!env.GOV24_ID || !env.GOV24_PW) throw new Error('GOV24_ID/GOV24_PW 설정이 필요합니다.');
  if (!env.BUILDING_REGISTER_DB) throw new Error('BUILDING_REGISTER_DB D1 바인딩이 필요합니다.');
  if (!env.BUILDING_REGISTER_PDFS) throw new Error('BUILDING_REGISTER_PDFS R2 바인딩이 필요합니다.');
  return {
    apiKey: env.KOREACONNECT_API_KEY,
    gov24Id: env.GOV24_ID,
    gov24Pw: env.GOV24_PW,
    db: env.BUILDING_REGISTER_DB,
    bucket: env.BUILDING_REGISTER_PDFS,
  };
}

function isoNow() {
  return new Date().toISOString();
}

function isoAfter(ms: number) {
  return new Date(Date.now() + ms).toISOString();
}

function safeFilename(value: string, fallback: string) {
  const safe = value.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return safe || fallback;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hexNibble(code: number) {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

function hexToPdfBytes(value: string) {
  const hex = value.trim();
  if (!hex || hex.length % 2 !== 0) throw new Error('정부24 응답의 PDF HEX 길이가 올바르지 않습니다.');

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    const high = hexNibble(hex.charCodeAt(index));
    const low = hexNibble(hex.charCodeAt(index + 1));
    if (high < 0 || low < 0) throw new Error('정부24 응답의 PDF HEX에 잘못된 문자가 있습니다.');
    bytes[index / 2] = high * 16 + low;
  }

  if (bytes.length < 4 || bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) {
    throw new Error('정부24 응답이 PDF 파일이 아닙니다.');
  }
  return bytes;
}

async function responseJson(response: Response): Promise<ParsedKoreaConnectResponse> {
  const text = await response.text();
  if (!text) {
    return {
      payload: null,
      parseError: new Error(`[토지대장 발급 API] HTTP ${response.status}: 빈 응답`),
    };
  }
  try {
    const payload = JSON.parse(text);
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return { payload: payload as KoreaConnectResponse, parseError: null };
    }
    return {
      payload: null,
      parseError: new Error(`[토지대장 발급 API] HTTP ${response.status}: JSON 객체가 아닌 응답`),
    };
  } catch {
    const contentType = response.headers.get('content-type') || '';
    const responseType = /text\/html/i.test(contentType) || /^\s*</.test(text) ? 'HTML' : 'JSON이 아닌';
    // 본문 앞부분을 남긴다. 게이트웨이가 JSON 대신 차단/점검 페이지를 돌려줄 때
    // 이게 없으면 원인을 전혀 좁힐 수 없다. 자격증명은 응답에 들어가지 않는다.
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 300);
    return {
      payload: null,
      parseError: new Error(
        `[토지대장 발급 API] HTTP ${response.status}: ${responseType} 응답 (content-type=${contentType || '없음'}) ${snippet}`,
      ),
    };
  }
}

async function issueLandRegister(
  pnu: string,
  credentials: { apiKey: string; gov24Id: string; gov24Pw: string },
) {
  const parameters: KoreaConnectRequestParameters = {
    nonMemberYn: 'N',
    loginMethod: 'ID',
    userId: credentials.gov24Id,
    userPw: credentials.gov24Pw,
    pnuCd: pnu,
    ...LAND_REGISTER_OPTIONS,
    requestType: '02',
  };
  const maxAttempts = KOREACONNECT_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetch(KOREACONNECT_ENDPOINT, {
        method: 'POST',
        headers: {
          api_user_key_id: credentials.apiKey,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify(buildRequestBody(parameters)),
        // 시간 초과·연결 실패는 요청 접수 여부를 알 수 없으므로 자동 재시도하지 않는다.
        signal: AbortSignal.timeout(EXTERNAL_REQUEST_TIMEOUT_MS),
      });
    } catch (error: any) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new Error(`[토지대장 발급 API] ${EXTERNAL_REQUEST_TIMEOUT_MS / 1000}초 시간 초과`);
      }
      throw new Error(`[토지대장 발급 API] 연결 실패: ${error?.message ?? '알 수 없는 오류'}`);
    }
    const parsed = await responseJson(response);
    const payload = parsed.payload;
    const hyphenTrNo = String(payload?.common?.hyphenTrNo ?? '').trim();

    // hyphenTrNo가 없으면 하이픈이 요청을 접수하지 못한 것이므로 민원 발급도 일어나지 않았다.
    // 실제 응답에서 이 사실을 확인한 경우에만 재시도해 중복 민원이 생기지 않게 한다.
    // 바뀔 수 있는 HTML 방화벽 문구는 안전성 판별에 사용하지 않는다.
    if (!hyphenTrNo && attempt < maxAttempts) {
      const delay = KOREACONNECT_RETRY_DELAYS_MS[attempt - 1] + Math.floor(Math.random() * 250);
      const responseType = parsed.parseError ? 'JSON 아님' : 'JSON';
      console.log(
        `[토지대장 발급 API] 재시도 ${attempt}/${KOREACONNECT_RETRY_DELAYS_MS.length}: hyphenTrNo 없음 (${responseType}, ${delay}ms 후)`,
      );
      await sleep(delay);
      continue;
    }

    if (parsed.parseError) throw parsed.parseError;
    if (!payload) throw new Error('[토지대장 발급 API] 응답 내용을 확인하지 못했습니다.');

    if (!response.ok) {
      // 실측: 키가 없거나 유효하지 않으면 HTTP 401 + AGW-E40102가 내려온다.
      const code = String(payload.errorCode ?? '').trim();
      const message = String(payload.errorMessage ?? '').trim() || `HTTP ${response.status}`;
      throw new Error(`[KT API 게이트웨이${code ? ` ${code}` : ''}] ${message}`);
    }

    const common = payload.common;
    if (common?.errYn === 'Y') {
      const code = String(common.errCd ?? '').trim();
      const message = String(common.errMsg ?? '').trim() || '정부24 토지대장 발급에 실패했습니다.';
      throw new Error(`[정부24 토지대장 발급${code ? ` ${code}` : ''}] ${message}`);
    }
    if (!common || common.errYn !== 'N') {
      if (hyphenTrNo) {
        console.warn(`[토지대장 발급 API] 처리 상태 불확실: ${JSON.stringify(common).slice(0, 300)}`);
        throw new Error(
          `처리 결과가 불확실합니다. 정부24 민원 신청 내역을 확인한 뒤 다시 시도해 주세요. (거래번호 ${hyphenTrNo})`,
        );
      }
      throw new Error('정부24 토지대장 발급 응답의 처리 상태를 확인하지 못했습니다.');
    }
    if (!hyphenTrNo) {
      throw new Error(`정부24 토지대장 발급 API가 ${maxAttempts}회 모두 거래번호 없는 응답을 반환했습니다.`);
    }

    const hexString = String(payload.data?.hexString ?? '').trim();
    if (!hexString) throw new Error('정부24 토지대장 발급 응답에 PDF HEX가 없습니다.');
    // 실측 성공 응답은 소문자 cappReqNo다. 형제 API 호환을 위해 대문자 표기도 방어적으로 수용한다.
    const cappReqNo = String(payload.data?.cappReqNo ?? payload.data?.CappReqNo ?? '').trim();
    return { bytes: hexToPdfBytes(hexString), cappReqNo };
  }

  throw new Error('[토지대장 발급 API] 응답을 확인하지 못했습니다.');
}

async function existingReadyDocument(
  db: D1Database,
  bucket: R2Bucket,
  pnu: string,
): Promise<ReadyDocument | null> {
  const row = await db.prepare(
    `SELECT id, pnu, r2_key, byte_size, page_count
     FROM land_register_documents
     WHERE pnu = ? AND status = 'ready' AND expires_at > ? AND r2_key IS NOT NULL`,
  ).bind(pnu, isoNow()).first<any>();
  if (!row?.r2_key) return null;
  const head = await bucket.head(row.r2_key);
  if (!head) return null;
  return {
    id: row.id,
    pnu: row.pnu,
    r2Key: row.r2_key,
    byteSize: Number(row.byte_size || head.size || 0),
    pageCount: Number(row.page_count || 0),
  };
}

async function markDocumentError(db: D1Database, resolved: ResolvedItem, error: string) {
  const now = isoNow();
  await db.prepare(
    `INSERT INTO land_register_documents
      (id, pnu, pin, pin_fmt, address, status, error_message, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'error', ?, ?, ?, ?)
     ON CONFLICT(pnu) DO UPDATE SET
      status = 'error', error_message = excluded.error_message,
      updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
  ).bind(
    crypto.randomUUID(),
    resolved.pnu,
    resolved.item.key,
    resolved.item.pinFmt || '',
    resolved.item.address,
    error,
    now,
    now,
    isoAfter(DOCUMENT_TTL_MS),
  ).run();
}

async function claimDocument(db: D1Database, resolved: ResolvedItem) {
  const previous = await db.prepare(
    'SELECT id, status, r2_key, updated_at FROM land_register_documents WHERE pnu = ?',
  ).bind(resolved.pnu).first<any>();
  const now = isoNow();
  const expiresAt = isoAfter(DOCUMENT_TTL_MS);

  if (previous?.status === 'processing') {
    const updatedAt = Date.parse(String(previous.updated_at ?? ''));
    if (Number.isFinite(updatedAt) && Date.now() - updatedAt < PROCESSING_STALE_MS) {
      throw new Error(`${resolved.item.address}: 토지대장을 이미 발급 중입니다. 잠시 후 다시 시도해 주세요.`);
    }
  }

  if (!previous) {
    const result = await db.prepare(
      `INSERT OR IGNORE INTO land_register_documents
        (id, pnu, pin, pin_fmt, address, status, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      resolved.pnu,
      resolved.item.key,
      resolved.item.pinFmt || '',
      resolved.item.address,
      now,
      now,
      expiresAt,
    ).run();
    if (!result.meta.changes) {
      throw new Error(`${resolved.item.address}: 토지대장을 이미 발급 중입니다. 잠시 후 다시 시도해 주세요.`);
    }
    return { expiresAt, previousR2Key: '' };
  }

  const result = await db.prepare(
    `UPDATE land_register_documents
     SET pin = ?, pin_fmt = ?, address = ?, status = 'processing', capp_req_no = NULL,
         error_message = NULL, updated_at = ?, expires_at = ?
     WHERE pnu = ? AND updated_at = ?`,
  ).bind(
    resolved.item.key,
    resolved.item.pinFmt || '',
    resolved.item.address,
    now,
    expiresAt,
    resolved.pnu,
    previous.updated_at,
  ).run();
  if (!result.meta.changes) {
    throw new Error(`${resolved.item.address}: 토지대장을 이미 발급 중입니다. 잠시 후 다시 시도해 주세요.`);
  }
  return { expiresAt, previousR2Key: String(previous.r2_key ?? '') };
}

async function createReadyDocument(
  db: D1Database,
  bucket: R2Bucket,
  resolved: ResolvedItem,
  credentials: { apiKey: string; gov24Id: string; gov24Pw: string },
): Promise<ReadyDocument> {
  const existing = await existingReadyDocument(db, bucket, resolved.pnu);
  if (existing) return existing;

  const { expiresAt, previousR2Key } = await claimDocument(db, resolved);
  let newR2Key = '';

  try {
    const issued = await issueLandRegister(resolved.pnu, credentials);
    const pdf = await PDFDocument.load(issued.bytes);
    newR2Key = `land-register/documents/${resolved.pnu}/${crypto.randomUUID()}.pdf`;
    await bucket.put(newR2Key, issued.bytes, {
      httpMetadata: { contentType: 'application/pdf' },
      customMetadata: { pnu: resolved.pnu, cappReqNo: issued.cappReqNo },
    });
    await db.prepare(
      `UPDATE land_register_documents
       SET status = 'ready', capp_req_no = ?, r2_key = ?, content_type = 'application/pdf',
           byte_size = ?, page_count = ?, error_message = NULL, updated_at = ?, expires_at = ?
       WHERE pnu = ?`,
    ).bind(
      issued.cappReqNo,
      newR2Key,
      issued.bytes.byteLength,
      pdf.getPageCount(),
      isoNow(),
      expiresAt,
      resolved.pnu,
    ).run();
    if (previousR2Key && previousR2Key !== newR2Key) {
      await bucket.delete(previousR2Key).catch(() => undefined);
    }
    const ready = await existingReadyDocument(db, bucket, resolved.pnu);
    if (!ready) throw new Error('저장된 토지대장 PDF를 확인하지 못했습니다.');
    return ready;
  } catch (error: any) {
    if (newR2Key) await bucket.delete(newR2Key).catch(() => undefined);
    await markDocumentError(db, resolved, error?.message ?? '토지대장 PDF 발급 실패');
    throw error;
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function sha256Hex(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function mergePdfDocuments(bucket: R2Bucket, documents: ReadyDocument[]) {
  const merged = await PDFDocument.create();
  for (const document of documents) {
    const object = await bucket.get(document.r2Key);
    if (!object) throw new Error('R2에 저장된 토지대장 PDF를 찾지 못했습니다.');
    const source = await PDFDocument.load(await object.arrayBuffer());
    const pages = await merged.copyPages(source, source.getPageIndices());
    pages.forEach((page) => merged.addPage(page));
  }
  return merged.save();
}

async function existingDownload(db: D1Database, bucket: R2Bucket, selectionHash: string) {
  const row = await db.prepare(
    `SELECT id, merged_r2_key, file_name, byte_size
     FROM land_register_downloads
     WHERE selection_hash = ? AND format = 'pdf' AND status = 'ready'
       AND expires_at > ? AND merged_r2_key IS NOT NULL`,
  ).bind(selectionHash, isoNow()).first<any>();
  if (!row?.merged_r2_key) return null;
  const object = await bucket.get(row.merged_r2_key);
  if (!object) return null;
  return { row, bytes: new Uint8Array(await object.arrayBuffer()) };
}

function pdfResponse(bytes: Uint8Array, filename: string) {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    },
  });
}

export async function downloadLandRegisterPdf(
  request: LandRegisterDownloadRequest,
  env: LandRegisterEnv,
  ctx?: ExecutionContext,
) {
  const items = request.items.filter((item) => item.key && item.address).slice(0, MAX_ITEMS_PER_DOWNLOAD);
  if (!items.length) throw new Error('items 배열 필수');
  const { apiKey, gov24Id, gov24Pw, db, bucket } = requireConfiguration(env);

  const resolved: ResolvedItem[] = [];
  const seenPnus = new Set<string>();
  for (const item of items) {
    const pnu = await addressToPnu(item.address, env, ctx);
    if (!pnu) throw new Error(`${item.address}: PNU 변환 실패`);
    if (seenPnus.has(pnu)) continue;
    seenPnus.add(pnu);
    resolved.push({ item, pnu });
  }

  const credentials = { apiKey, gov24Id, gov24Pw };
  const documents = await mapWithConcurrency(
    resolved,
    ISSUE_CONCURRENCY,
    (item) => createReadyDocument(db, bucket, item, credentials),
  );
  const selectionHash = await sha256Hex([
    'land-register-only-v1',
    ...documents.map((document) => document.pnu),
  ].join('\n'));
  const filename = documents.length === 1
    ? `${safeFilename(resolved[0].item.address, resolved[0].item.key)}_토지대장.pdf`
    : `토지대장_${documents.length}건.pdf`;
  const cached = await existingDownload(db, bucket, selectionHash);
  if (cached) {
    await db.prepare('UPDATE land_register_downloads SET downloaded_at = ?, updated_at = ? WHERE id = ?')
      .bind(isoNow(), isoNow(), cached.row.id)
      .run();
    return pdfResponse(cached.bytes, cached.row.file_name || filename);
  }

  const bytes = await mergePdfDocuments(bucket, documents);
  const downloadId = crypto.randomUUID();
  const r2Key = `land-register/downloads/${selectionHash}/${downloadId}.pdf`;
  const previousDownload = await db.prepare(
    'SELECT merged_r2_key FROM land_register_downloads WHERE selection_hash = ? AND format = ?',
  ).bind(selectionHash, 'pdf').first<any>();
  await bucket.put(r2Key, bytes, {
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: { selectionHash },
  });
  const now = isoNow();
  await db.prepare(
    `INSERT INTO land_register_downloads
      (id, selection_hash, format, status, merged_r2_key, file_name, source_document_ids,
       byte_size, created_at, updated_at, expires_at, downloaded_at)
     VALUES (?, ?, 'pdf', 'ready', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(selection_hash, format) DO UPDATE SET
      status = 'ready', merged_r2_key = excluded.merged_r2_key, file_name = excluded.file_name,
      source_document_ids = excluded.source_document_ids, byte_size = excluded.byte_size,
      error_message = NULL, updated_at = excluded.updated_at,
      expires_at = excluded.expires_at, downloaded_at = excluded.downloaded_at`,
  ).bind(
    downloadId,
    selectionHash,
    r2Key,
    filename,
    JSON.stringify(documents.map((document) => document.id)),
    bytes.byteLength,
    now,
    now,
    isoAfter(DOWNLOAD_TTL_MS),
    now,
  ).run();
  const previousDownloadR2Key = String(previousDownload?.merged_r2_key ?? '');
  if (previousDownloadR2Key && previousDownloadR2Key !== r2Key) {
    await bucket.delete(previousDownloadR2Key).catch(() => undefined);
  }
  await db.prepare(`UPDATE land_register_documents SET downloaded_at = ?, updated_at = ? WHERE pnu IN (${documents.map(() => '?').join(', ')})`)
    .bind(now, now, ...documents.map((document) => document.pnu))
    .run();

  return pdfResponse(bytes, filename);
}

export async function cleanupLandRegisterArtifacts(env: LandRegisterEnv) {
  if (!env.BUILDING_REGISTER_DB || !env.BUILDING_REGISTER_PDFS) return;
  const db = env.BUILDING_REGISTER_DB;
  const bucket = env.BUILDING_REGISTER_PDFS;
  const now = isoNow();
  const [documents, downloads] = await Promise.all([
    db.prepare('SELECT r2_key FROM land_register_documents WHERE expires_at <= ? AND r2_key IS NOT NULL').bind(now).all<any>(),
    db.prepare('SELECT merged_r2_key FROM land_register_downloads WHERE expires_at <= ? AND merged_r2_key IS NOT NULL').bind(now).all<any>(),
  ]);

  for (const row of documents.results || []) {
    if (row.r2_key) await bucket.delete(row.r2_key).catch(() => undefined);
  }
  for (const row of downloads.results || []) {
    if (row.merged_r2_key) await bucket.delete(row.merged_r2_key).catch(() => undefined);
  }

  await Promise.all([
    db.prepare('DELETE FROM land_register_documents WHERE expires_at <= ?').bind(now).run(),
    db.prepare('DELETE FROM land_register_downloads WHERE expires_at <= ?').bind(now).run(),
  ]);
}
