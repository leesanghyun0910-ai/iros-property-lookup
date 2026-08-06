import type {
  BuildingRegisterDownloadRequest,
  BuildingRegisterStatusRequest, BuildingRegisterStatusResponse,
  BuildingTradeRequest, BuildingTradeResponse,
  CollectRequest, CollectResponse,
  CommercialPriceRequest, CommercialPriceResponse,
  EumPrintRequest,
  LandInfoRequest, LandInfoResponse,
  LandRegisterDownloadRequest,
  PropertyRegisterDownloadRequest,
  RealtyPriceRequest, RealtyPriceResponse,
} from '../shared/types';

export async function collect(req: CollectRequest): Promise<CollectResponse> {
  const res = await fetch('/api/collect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  return (await res.json()) as CollectResponse;
}

export async function fetchLandInfo(req: LandInfoRequest): Promise<LandInfoResponse> {
  const res = await fetch('/api/landinfo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  return (await res.json()) as LandInfoResponse;
}

export async function fetchBuildingTrades(req: BuildingTradeRequest): Promise<BuildingTradeResponse> {
  const res = await fetch('/api/building-trades', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  return (await res.json()) as BuildingTradeResponse;
}

export async function fetchCommercialPrices(req: CommercialPriceRequest): Promise<CommercialPriceResponse> {
  const res = await fetch('/api/commercial-prices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  return (await res.json()) as CommercialPriceResponse;
}

export async function fetchRealtyPrices(req: RealtyPriceRequest): Promise<RealtyPriceResponse> {
  const res = await fetch('/api/realty-prices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  return (await res.json()) as RealtyPriceResponse;
}

export async function fetchEumPrintHtml(req: EumPrintRequest): Promise<string> {
  const res = await fetch('/api/eum/print-html', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  const text = await res.text();
  if (!res.ok) {
    try {
      const data = JSON.parse(text) as { error?: string };
      throw new Error(data.error ?? '토지이용계획 인쇄 HTML 생성 실패');
    } catch (e: any) {
      if (e instanceof SyntaxError) throw new Error(text || '토지이용계획 인쇄 HTML 생성 실패');
      throw e;
    }
  }
  return text;
}

export async function fetchBuildingRegisterStatus(req: BuildingRegisterStatusRequest): Promise<BuildingRegisterStatusResponse> {
  const res = await fetch('/api/building-register/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  return (await res.json()) as BuildingRegisterStatusResponse;
}

async function downloadPdf(
  path: string,
  req: unknown,
  fallbackFilename: string,
  fallbackError: string,
): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  const blob = await res.blob();
  if (!res.ok) {
    const text = await blob.text();
    try {
      const data = JSON.parse(text) as { error?: string };
      throw new Error(data.error ?? fallbackError);
    } catch (e: any) {
      if (e instanceof SyntaxError) throw new Error(text || fallbackError);
      throw e;
    }
  }
  const disposition = res.headers.get('content-disposition') || '';
  const filename = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  return {
    blob,
    filename: filename ? decodeURIComponent(filename) : fallbackFilename,
  };
}

export async function downloadLandRegisterPdf(req: LandRegisterDownloadRequest): Promise<{ blob: Blob; filename: string }> {
  return downloadPdf('/api/land-register/download', req, '토지대장.pdf', '토지대장 PDF 발급 실패');
}

export async function downloadPropertyRegisterPdf(req: PropertyRegisterDownloadRequest): Promise<{ blob: Blob; filename: string }> {
  return downloadPdf('/api/property-register/download', req, '등기부등본.pdf', '등기부등본 PDF 열람 실패');
}

export async function downloadBuildingRegisterPdf(req: BuildingRegisterDownloadRequest): Promise<{ blob: Blob; filename: string }> {
  return downloadPdf('/api/building-register/download', req, '건축물대장.pdf', '건축물대장 PDF 생성 실패');
}
