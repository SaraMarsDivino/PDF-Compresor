export type CompressionRoute = 'bypass' | 'ghostscript' | 'pymupdf_fallback' | 'error';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'INFO' | 'WARNING' | 'ERROR' | 'DEBUG';
  message: string;
  module: string;
}

export interface CompressionResult {
  engine: CompressionRoute;
  originalName: string;
  originalSize: number;
  finalSize: number;
  reductionPercentage: number;
  durationMs: number;
  logs: LogEntry[];
  pdfBlob?: Blob;
  downloadUrl?: string;
  memoryPeakMb: number;
  memoryFreedMb: number;
  pageCount?: number;
}
