// 인터넷등기소 부동산등기부등본 열람 어댑터
// collect.ts의 iros.go.kr 직접 호출과 달리 KT 디지털융합플랫폼·하이픈을 경유한다.
// 배포된 세움터용 바인딩 이름을 바꾸지 않고 D1/R2를 함께 사용한다.
import { PDFDocument } from 'pdf-lib';
import type {
  PropertyRegisterDownloadRequest,
  PropertyRegisterRequestItem,
} from '../../shared/types';

const KOREACONNECT_ENDPOINT = 'https://api.koreaconnect.kr/01/1/2603101434213625838HYP/FINRE/in0004000948';
const DOCUMENT_TTL_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ITEMS_PER_DOWNLOAD = 30;
const ISSUE_CONCURRENCY = 2;
const PROCESSING_STALE_MS = 10 * 60 * 1000;
const EXTERNAL_REQUEST_TIMEOUT_MS = 30_000;

// PDF만 받고 공동담보 목록은 제외한다. 매매목록 포함과 유효사항만 표시는 명세 기본값과 반대로 고정한다.
const PROPERTY_REGISTER_OPTIONS = {
  pdfHex: 'Y',
  xmlYn: 'N',
  cmortCheck: 'N',
  tradeCheck: 'Y',
  display: '1',
} as const;

export interface PropertyRegisterEnv {
  KOREACONNECT_API_KEY?: string;
  IROS_ID?: string;
  IROS_PW?: string;
  MON_NO1?: string;
  MON_NO2?: string;
  MON_PW?: string;
  BUILDING_REGISTER_DB?: D1Database;
  BUILDING_REGISTER_PDFS?: R2Bucket;
}

interface KoreaConnectRequestParameters {
  userId: string;
  userPw: string;
  searchDiv: 'uniqNo';
  uniqNo: string;
  payDiv: '0';
  payNo: string;
  payPw: string;
  pdfHex: 'Y';
  xmlYn: 'N';
  cmortCheck: 'N';
  tradeCheck: 'Y';
  display: '1';
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
    dealNo?: string;
    dealDate?: string;
    apprNo?: string;
    pdfHexString?: string;
  };
  errorCode?: string;
  errorMessage?: string;
}

interface ResolvedItem {
  item: PropertyRegisterRequestItem;
  uniqNo: string;
}

interface IssuedPropertyRegister {
  pdfHexString: string;
  dealNo: string;
  dealDate: string;
  apprNo: string;
}

interface ReadyDocument {
  id: string;
  uniqNo: string;
  r2Key: string;
  byteSize: number;
  pageCount: number;
}

function buildRequestBody(parameters: KoreaConnectRequestParameters) {
  // 실측된 계약은 최상위 파라미터를 그대로 보내는 flat 봉투다.
  return parameters;
}

function requireConfiguration(env: PropertyRegisterEnv) {
  if (!env.KOREACONNECT_API_KEY) throw new Error('KOREACONNECT_API_KEY 설정이 필요합니다.');
  if (!env.IROS_ID || !env.IROS_PW) throw new Error('IROS_ID/IROS_PW 설정이 필요합니다.');
  if (!env.MON_NO1 || !env.MON_NO2 || !env.MON_PW) {
    throw new Error('MON_NO1/MON_NO2/MON_PW 설정이 필요합니다.');
  }
  // 전자민원캐시 번호는 앞 8자리에 영문자가 섞일 수 있다(실계정으로 확인). 뒤 4자리는 숫자다.
  // 길이 검증은 남긴다 — 자릿수가 틀린 채로 호출하면 건당 700원이 헛나간다.
  if (!/^[0-9A-Za-z]{8}$/.test(env.MON_NO1) || !/^\d{4}$/.test(env.MON_NO2)) {
    throw new Error('MON_NO1은 영문·숫자 8자리, MON_NO2는 숫자 4자리여야 합니다.');
  }
  if (!env.BUILDING_REGISTER_DB) throw new Error('BUILDING_REGISTER_DB D1 바인딩이 필요합니다.');
  if (!env.BUILDING_REGISTER_PDFS) throw new Error('BUILDING_REGISTER_PDFS R2 바인딩이 필요합니다.');
  return {
    apiKey: env.KOREACONNECT_API_KEY,
    irosId: env.IROS_ID,
    irosPw: env.IROS_PW,
    payNo: `${env.MON_NO1}${env.MON_NO2}`,
    payPw: env.MON_PW,
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

function itemLabel(resolved: ResolvedItem) {
  return resolved.item.address || resolved.item.pinFmt || resolved.uniqNo;
}

function safeFilename(value: string, fallback: string) {
  const safe = value.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return safe || fallback;
}

function hexNibble(code: number) {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

function hexToPdfBytes(value: string) {
  const hex = value.trim();
  if (!hex) throw new Error('인터넷등기소 응답에 PDF HEX가 없습니다.');
  if (hex.length % 2 !== 0) throw new Error('인터넷등기소 응답의 PDF HEX 길이가 올바르지 않습니다.');

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    const high = hexNibble(hex.charCodeAt(index));
    const low = hexNibble(hex.charCodeAt(index + 1));
    if (high < 0 || low < 0) throw new Error('인터넷등기소 응답의 PDF HEX에 잘못된 문자가 있습니다.');
    bytes[index / 2] = high * 16 + low;
  }

  if (bytes.length < 4 || bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) {
    throw new Error('인터넷등기소 응답이 PDF 파일이 아닙니다.');
  }
  return bytes;
}

async function responseJson(response: Response): Promise<KoreaConnectResponse> {
  const text = await response.text();
  if (!text) {
    if (!response.ok) throw new Error(`[등기부등본 열람 API] HTTP ${response.status}: 빈 응답`);
    return {};
  }
  try {
    return JSON.parse(text) as KoreaConnectResponse;
  } catch {
    const contentType = response.headers.get('content-type') || '';
    const responseType = /text\/html/i.test(contentType) || /^\s*</.test(text) ? 'HTML' : 'JSON이 아닌';
    // 게이트웨이 차단/점검 페이지를 식별할 수 있도록 자격증명이 없는 응답 앞부분만 남긴다.
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 300);
    throw new Error(
      `[등기부등본 열람 API] HTTP ${response.status}: ${responseType} 응답 (content-type=${contentType || '없음'}) ${snippet}`,
    );
  }
}

function errorCodeFromCommon(common: NonNullable<KoreaConnectResponse['common']>) {
  // 하이픈 오류 코드는 비어 있는 errCd가 아니라 "[CODE] 메시지" 형태의 errMsg에 들어온다.
  const message = String(common.errMsg ?? '').trim();
  return /^\s*\[([^\]]+)\]/.exec(message)?.[1]?.trim() || String(common.errCd ?? '').trim();
}

async function issuePropertyRegister(
  uniqNo: string,
  credentials: { apiKey: string; irosId: string; irosPw: string; payNo: string; payPw: string },
): Promise<IssuedPropertyRegister> {
  const parameters: KoreaConnectRequestParameters = {
    userId: credentials.irosId,
    userPw: credentials.irosPw,
    searchDiv: 'uniqNo',
    uniqNo,
    payDiv: '0',
    payNo: credentials.payNo,
    payPw: credentials.payPw,
    ...PROPERTY_REGISTER_OPTIONS,
  };
  let response: Response;
  try {
    response = await fetch(KOREACONNECT_ENDPOINT, {
      method: 'POST',
      headers: {
        api_user_key_id: credentials.apiKey,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify(buildRequestBody(parameters)),
      // 열람은 건당 과금되므로 시간 초과나 실패를 자동 재시도하지 않는다.
      signal: AbortSignal.timeout(EXTERNAL_REQUEST_TIMEOUT_MS),
    });
  } catch (error: any) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`[등기부등본 열람 API] ${EXTERNAL_REQUEST_TIMEOUT_MS / 1000}초 시간 초과`);
    }
    throw new Error(`[등기부등본 열람 API] 연결 실패: ${error?.message ?? '알 수 없는 오류'}`);
  }
  const payload = await responseJson(response);

  if (!response.ok) {
    const code = String(payload.errorCode ?? '').trim();
    const message = String(payload.errorMessage ?? '').trim() || `HTTP ${response.status}`;
    throw new Error(`[KT API 게이트웨이${code ? ` ${code}` : ''}] ${message}`);
  }

  const common = payload.common;
  if (common?.errYn === 'Y') {
    const code = errorCodeFromCommon(common);
    if (code === 'B1001-080') {
      throw new Error('인터넷등기소 전자지갑 잔액이 부족합니다. 충전 후 다시 시도해 주세요.');
    }
    const message = String(common.errMsg ?? '').trim() || '인터넷등기소 등기부등본 열람에 실패했습니다.';
    throw new Error(`[인터넷등기소 등기부등본 열람${code ? ` ${code}` : ''}] ${message}`);
  }
  if (!common || common.errYn !== 'N') {
    // 무엇을 받았는지 남긴다. 이게 없으면 errYn이 왜 Y도 N도 아닌지 좁힐 수 없다.
    // common에는 거래번호와 오류문구만 들어오고 자격증명은 포함되지 않는다.
    const seen = common ? JSON.stringify(common).slice(0, 300) : 'common 없음';
    throw new Error(`인터넷등기소 등기부등본 열람 응답의 처리 상태를 확인하지 못했습니다. ${seen}`);
  }

  return {
    pdfHexString: String(payload.data?.pdfHexString ?? '').trim(),
    dealNo: String(payload.data?.dealNo ?? '').trim(),
    dealDate: String(payload.data?.dealDate ?? '').trim(),
    apprNo: String(payload.data?.apprNo ?? '').trim(),
  };
}

async function existingReadyDocument(
  db: D1Database,
  bucket: R2Bucket,
  uniqNo: string,
): Promise<ReadyDocument | null> {
  const row = await db.prepare(
    `SELECT id, uniq_no, r2_key, byte_size, page_count
     FROM property_register_documents
     WHERE uniq_no = ? AND status = 'ready' AND expires_at > ? AND r2_key IS NOT NULL`,
  ).bind(uniqNo, isoNow()).first<any>();
  if (!row?.r2_key) return null;
  const head = await bucket.head(row.r2_key);
  if (!head) return null;
  return {
    id: row.id,
    uniqNo: row.uniq_no,
    r2Key: row.r2_key,
    byteSize: Number(row.byte_size || head.size || 0),
    pageCount: Number(row.page_count || 0),
  };
}

async function markDocumentError(
  db: D1Database,
  resolved: ResolvedItem,
  error: string,
  issued?: IssuedPropertyRegister,
) {
  const now = isoNow();
  await db.prepare(
    `INSERT INTO property_register_documents
      (id, uniq_no, pin, pin_fmt, address, status, deal_no, deal_date, appr_no,
       error_message, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'error', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uniq_no) DO UPDATE SET
      status = 'error', deal_no = excluded.deal_no, deal_date = excluded.deal_date,
      appr_no = excluded.appr_no, error_message = excluded.error_message,
      updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
  ).bind(
    crypto.randomUUID(),
    resolved.uniqNo,
    resolved.item.key,
    resolved.item.pinFmt || '',
    resolved.item.address || '',
    issued?.dealNo || null,
    issued?.dealDate || null,
    issued?.apprNo || null,
    error,
    now,
    now,
    isoAfter(DOCUMENT_TTL_MS),
  ).run();
}

async function claimDocument(db: D1Database, resolved: ResolvedItem) {
  const previous = await db.prepare(
    'SELECT id, status, r2_key, updated_at FROM property_register_documents WHERE uniq_no = ?',
  ).bind(resolved.uniqNo).first<any>();
  const now = isoNow();
  const expiresAt = isoAfter(DOCUMENT_TTL_MS);

  if (previous?.status === 'processing') {
    const updatedAt = Date.parse(String(previous.updated_at ?? ''));
    if (Number.isFinite(updatedAt) && Date.now() - updatedAt < PROCESSING_STALE_MS) {
      throw new Error(`${itemLabel(resolved)}: 등기부등본을 이미 열람 중입니다. 잠시 후 다시 시도해 주세요.`);
    }
  }

  if (!previous) {
    const result = await db.prepare(
      `INSERT OR IGNORE INTO property_register_documents
        (id, uniq_no, pin, pin_fmt, address, status, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      resolved.uniqNo,
      resolved.item.key,
      resolved.item.pinFmt || '',
      resolved.item.address || '',
      now,
      now,
      expiresAt,
    ).run();
    if (!result.meta.changes) {
      throw new Error(`${itemLabel(resolved)}: 등기부등본을 이미 열람 중입니다. 잠시 후 다시 시도해 주세요.`);
    }
    return { expiresAt, previousR2Key: '' };
  }

  const result = await db.prepare(
    `UPDATE property_register_documents
     SET pin = ?, pin_fmt = ?, address = ?, status = 'processing',
         deal_no = NULL, deal_date = NULL, appr_no = NULL, error_message = NULL,
         updated_at = ?, expires_at = ?
     WHERE uniq_no = ? AND updated_at = ?`,
  ).bind(
    resolved.item.key,
    resolved.item.pinFmt || '',
    resolved.item.address || '',
    now,
    expiresAt,
    resolved.uniqNo,
    previous.updated_at,
  ).run();
  if (!result.meta.changes) {
    throw new Error(`${itemLabel(resolved)}: 등기부등본을 이미 열람 중입니다. 잠시 후 다시 시도해 주세요.`);
  }
  return { expiresAt, previousR2Key: String(previous.r2_key ?? '') };
}

async function createReadyDocument(
  db: D1Database,
  bucket: R2Bucket,
  resolved: ResolvedItem,
  credentials: { apiKey: string; irosId: string; irosPw: string; payNo: string; payPw: string },
): Promise<ReadyDocument> {
  const existing = await existingReadyDocument(db, bucket, resolved.uniqNo);
  if (existing) return existing;

  const { expiresAt, previousR2Key } = await claimDocument(db, resolved);
  let issued: IssuedPropertyRegister | undefined;
  let newR2Key = '';

  try {
    issued = await issuePropertyRegister(resolved.uniqNo, credentials);
    const bytes = hexToPdfBytes(issued.pdfHexString);
    const pdf = await PDFDocument.load(bytes);
    newR2Key = `property-register/documents/${resolved.uniqNo}/${crypto.randomUUID()}.pdf`;
    await bucket.put(newR2Key, bytes, {
      httpMetadata: { contentType: 'application/pdf' },
      customMetadata: {
        uniqNo: resolved.uniqNo,
        dealNo: issued.dealNo,
        dealDate: issued.dealDate,
        apprNo: issued.apprNo,
      },
    });
    await db.prepare(
      `UPDATE property_register_documents
       SET status = 'ready', deal_no = ?, deal_date = ?, appr_no = ?, r2_key = ?,
           content_type = 'application/pdf', byte_size = ?, page_count = ?,
           error_message = NULL, updated_at = ?, expires_at = ?
       WHERE uniq_no = ?`,
    ).bind(
      issued.dealNo,
      issued.dealDate,
      issued.apprNo,
      newR2Key,
      bytes.byteLength,
      pdf.getPageCount(),
      isoNow(),
      expiresAt,
      resolved.uniqNo,
    ).run();
    if (previousR2Key && previousR2Key !== newR2Key) {
      await bucket.delete(previousR2Key).catch(() => undefined);
    }
    const ready = await existingReadyDocument(db, bucket, resolved.uniqNo);
    if (!ready) throw new Error('저장된 등기부등본 PDF를 확인하지 못했습니다.');
    return ready;
  } catch (error: any) {
    if (newR2Key) await bucket.delete(newR2Key).catch(() => undefined);
    await markDocumentError(db, resolved, error?.message ?? '등기부등본 PDF 열람 실패', issued);
    throw error;
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  let stopped = false;
  let firstError: unknown;
  const worker = async () => {
    while (!stopped && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]);
      } catch (error) {
        stopped = true;
        firstError ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (firstError) throw firstError;
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
    if (!object) throw new Error('R2에 저장된 등기부등본 PDF를 찾지 못했습니다.');
    const source = await PDFDocument.load(await object.arrayBuffer());
    const pages = await merged.copyPages(source, source.getPageIndices());
    pages.forEach((page) => merged.addPage(page));
  }
  return merged.save();
}

async function existingDownload(db: D1Database, bucket: R2Bucket, selectionHash: string) {
  const row = await db.prepare(
    `SELECT id, merged_r2_key, file_name, byte_size
     FROM property_register_downloads
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

function resolveRequestItems(items: PropertyRegisterRequestItem[]) {
  if (!items.length) throw new Error('items 배열 필수');
  if (items.length > MAX_ITEMS_PER_DOWNLOAD) {
    throw new Error(`한 번에 최대 ${MAX_ITEMS_PER_DOWNLOAD}건까지 등기부등본을 열람할 수 있습니다.`);
  }

  const resolved: ResolvedItem[] = [];
  const seenUniqNos = new Set<string>();
  for (const item of items) {
    const key = String(item.key ?? '').trim();
    const uniqNo = String(item.uniqNo ?? '').trim();
    if (!key) throw new Error('각 항목의 key가 필요합니다.');
    if (!/^\d{14}$/.test(uniqNo)) {
      throw new Error(`${item.address || item.pinFmt || key}: 부동산고유번호는 14자리 숫자여야 합니다.`);
    }
    if (seenUniqNos.has(uniqNo)) continue;
    seenUniqNos.add(uniqNo);
    resolved.push({ item: { ...item, key, uniqNo }, uniqNo });
  }
  return resolved;
}

export async function downloadPropertyRegisterPdf(
  request: PropertyRegisterDownloadRequest,
  env: PropertyRegisterEnv,
) {
  // 모든 입력을 먼저 검증해 일부만 과금된 뒤 요청 오류를 발견하는 일을 막는다.
  const resolved = resolveRequestItems(request.items);
  const { apiKey, irosId, irosPw, payNo, payPw, db, bucket } = requireConfiguration(env);
  const credentials = { apiKey, irosId, irosPw, payNo, payPw };
  const documents = await mapWithConcurrency(
    resolved,
    ISSUE_CONCURRENCY,
    (item) => createReadyDocument(db, bucket, item, credentials),
  );
  const selectionHash = await sha256Hex([
    'property-register-pdf-v1',
    ...documents.map((document) => document.uniqNo),
  ].join('\n'));
  const filename = documents.length === 1
    ? `${safeFilename(itemLabel(resolved[0]), resolved[0].uniqNo)}_등기부등본.pdf`
    : `등기부등본_${documents.length}건.pdf`;
  const cached = await existingDownload(db, bucket, selectionHash);
  if (cached) {
    const now = isoNow();
    await db.prepare('UPDATE property_register_downloads SET downloaded_at = ?, updated_at = ? WHERE id = ?')
      .bind(now, now, cached.row.id)
      .run();
    return pdfResponse(cached.bytes, cached.row.file_name || filename);
  }

  const bytes = await mergePdfDocuments(bucket, documents);
  const downloadId = crypto.randomUUID();
  const r2Key = `property-register/downloads/${selectionHash}/${downloadId}.pdf`;
  const previousDownload = await db.prepare(
    'SELECT merged_r2_key FROM property_register_downloads WHERE selection_hash = ? AND format = ?',
  ).bind(selectionHash, 'pdf').first<any>();
  await bucket.put(r2Key, bytes, {
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: { selectionHash },
  });
  const now = isoNow();
  await db.prepare(
    `INSERT INTO property_register_downloads
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
  await db.prepare(`UPDATE property_register_documents SET downloaded_at = ?, updated_at = ? WHERE uniq_no IN (${documents.map(() => '?').join(', ')})`)
    .bind(now, now, ...documents.map((document) => document.uniqNo))
    .run();

  return pdfResponse(bytes, filename);
}

export async function cleanupPropertyRegisterArtifacts(env: PropertyRegisterEnv) {
  if (!env.BUILDING_REGISTER_DB || !env.BUILDING_REGISTER_PDFS) return;
  const db = env.BUILDING_REGISTER_DB;
  const bucket = env.BUILDING_REGISTER_PDFS;
  const now = isoNow();
  const [documents, downloads] = await Promise.all([
    db.prepare('SELECT r2_key FROM property_register_documents WHERE expires_at <= ? AND r2_key IS NOT NULL').bind(now).all<any>(),
    db.prepare('SELECT merged_r2_key FROM property_register_downloads WHERE expires_at <= ? AND merged_r2_key IS NOT NULL').bind(now).all<any>(),
  ]);

  for (const row of documents.results || []) {
    if (row.r2_key) await bucket.delete(row.r2_key).catch(() => undefined);
  }
  for (const row of downloads.results || []) {
    if (row.merged_r2_key) await bucket.delete(row.merged_r2_key).catch(() => undefined);
  }

  await Promise.all([
    db.prepare('DELETE FROM property_register_documents WHERE expires_at <= ?').bind(now).run(),
    db.prepare('DELETE FROM property_register_downloads WHERE expires_at <= ?').bind(now).run(),
  ]);
}
