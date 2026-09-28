import React, { useState, useRef, useEffect } from 'react';
import { 
  ArrowDown, 
  FileText, 
  Download, 
  CheckCircle2, 
  RotateCcw, 
  ShieldAlert, 
  Loader2,
  TrendingDown,
  Info,
  AlertCircle,
  X
} from 'lucide-react';
import { simulateDjangoProcessing } from '../utils/pdfSimulator';
import { CompressionResult } from '../types';

export const ModernVueCompressor: React.FC = () => {
  const [selectedFile, setSelectedFile] = useState<{ name: string; size: number; blob?: Blob } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<CompressionResult | null>(null);
  const [showConsentModal, setShowConsentModal] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [autoDownloaded, setAutoDownloaded] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [targetMode, setTargetMode] = useState<'target35' | 'balanced'>('target35');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const urlCleanupRef = useRef<string | null>(null);

  // Limpieza preventiva de URLs en memoria al desmontar
  useEffect(() => {
    return () => {
      if (urlCleanupRef.current) {
        URL.revokeObjectURL(urlCleanupRef.current);
      }
    };
  }, []);

  // Trigger file selection
  const handleTriggerInput = () => {
    fileInputRef.current?.click();
  };

  // Validación de seguridad de archivo: Extensión, tamaño y firma binaria (%PDF-)
  const validateAndSelectFile = async (file: File) => {
    setErrorMessage(null);

    // 1. Verificación de extensión
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setErrorMessage('Formato no permitido: Por favor selecciona un archivo con extensión .pdf');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    // 2. Verificación de tamaño máximo (100MB)
    if (file.size > 100 * 1024 * 1024) {
      setErrorMessage('Límite de seguridad: El archivo excede el tamaño máximo permitido de 100 MB.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    // 3. Verificación de tamaño mínimo
    if (file.size < 32) {
      setErrorMessage('Integridad: El archivo está vacío o dañado (tamaño inferior al mínimo de cabecera PDF).');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    // 4. Verificación binaria de cabecera mágica (%PDF-)
    try {
      const headerSlice = file.slice(0, 5);
      const buffer = await headerSlice.arrayBuffer();
      const signature = new TextDecoder('ascii').decode(buffer);
      if (!signature.startsWith('%PDF-')) {
        setErrorMessage('Seguridad: El archivo no es un documento PDF válido (la cabecera binaria %PDF- no coincide).');
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }
    } catch {
      // Si el navegador no permite slice directo, continuar con el flujo
    }

    setSelectedFile({
      name: file.name,
      size: file.size,
      blob: file,
    });
    setResult(null);
    setAutoDownloaded(false);
    // Mostrar modal de advertencia de firma digital
    setShowConsentModal(true);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    validateAndSelectFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    validateAndSelectFile(file);
  };

  // If user cancels consent
  const handleCancelConsent = () => {
    setShowConsentModal(false);
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // If user accepts consent -> proceed with compression request
  const handleConfirmConsent = async () => {
    setShowConsentModal(false);
    if (!selectedFile) return;

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const targetMb = targetMode === 'target35' ? 3.5 : undefined;
      const res = await simulateDjangoProcessing(selectedFile, false, undefined, targetMb);
      
      // Revocar URL previa de descarga para evitar fugas de memoria
      if (urlCleanupRef.current) {
        URL.revokeObjectURL(urlCleanupRef.current);
        urlCleanupRef.current = null;
      }

      setResult(res);

      // Automated download trigger if downloadUrl exists
      if (res.downloadUrl) {
        urlCleanupRef.current = res.downloadUrl;
        const link = document.createElement('a');
        link.href = res.downloadUrl;
        link.download = `comprimido_${selectedFile.name}`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setAutoDownloaded(true);
      }
    } catch (err: any) {
      console.error('Error al procesar PDF:', err);
      setErrorMessage(err?.message || 'Error en el procesamiento del documento.');
    } finally {
      setIsLoading(false);
    }
  };

  const resetAll = () => {
    if (urlCleanupRef.current) {
      URL.revokeObjectURL(urlCleanupRef.current);
      urlCleanupRef.current = null;
    }
    setSelectedFile(null);
    setResult(null);
    setAutoDownloaded(false);
    setErrorMessage(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const formatSize = (bytes: number) => {
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(2)} MB`;
  };

  return (
    <div className="w-full max-w-5xl mx-auto bg-white rounded-3xl p-8 sm:p-12 shadow-sm border border-slate-200/80 font-sans text-slate-800">
      {/* Header section matching exact specifications */}
      <div className="mb-8 text-left">
        {/* Category badge */}
        <span className="text-[11px] font-bold tracking-widest text-[#E0533C] uppercase block mb-2 font-mono">
          comprime tu pdf de forma segura
        </span>

        {/* Big bold title */}
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight leading-[1.1] text-slate-900">
          PDF COMPRESOR
        </h1>

        {/* Selector de Modo de Compresión: Versión Objetivo 3.5 MB */}
        <div className="mt-5 flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => setTargetMode('target35')}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all flex items-center gap-2 ${
              targetMode === 'target35'
                ? 'bg-[#E0533C] text-white shadow-sm ring-2 ring-orange-200'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${targetMode === 'target35' ? 'bg-white animate-pulse' : 'bg-slate-400'}`} />
            Modo Límite: ≤ 3.5 MB
          </button>
          <button
            type="button"
            onClick={() => setTargetMode('balanced')}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all ${
              targetMode === 'balanced'
                ? 'bg-slate-900 text-white shadow-sm ring-2 ring-slate-300'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            Compresión Estándar
          </button>
          <span className="text-xs text-slate-500 ml-1">
            {targetMode === 'target35'
              ? 'Calibra adaptativamente hasta situar el PDF bajo 3.5 MB preservando el 100% de páginas.'
              : 'Aplica reducción estándar balanceada de alta resolución.'}
          </span>
        </div>

        {/* Banner Permanente: Aviso Legal de Firmas Electrónicas */}
        <div className="mt-3.5 p-3 bg-amber-50/80 border border-amber-200/90 rounded-xl flex items-center gap-2.5 text-xs text-amber-900">
          <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0" />
          <span>
            <strong className="font-semibold text-amber-950">Aviso sobre Firmas Electrónicas:</strong> La optimización y recompresión reconstruye el árbol de objetos del documento, por lo que <u>invalida y remueve cualquier firma digital o certificado electrónico</u> incrustado.
          </span>
        </div>
      </div>

      {/* Security error alert banner */}
      {errorMessage && (
        <div className="mb-6 p-4 bg-rose-50 border border-rose-200 rounded-2xl flex items-start justify-between gap-3 text-sm text-rose-900 animate-in fade-in duration-150">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-rose-950">Aviso de Validación</p>
              <p className="text-rose-800 text-xs mt-0.5">{errorMessage}</p>
            </div>
          </div>
          <button 
            type="button" 
            onClick={() => setErrorMessage(null)} 
            className="text-rose-500 hover:text-rose-800 p-1 transition-colors"
            aria-label="Cerrar aviso"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Two columns layout */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-stretch">
        {/* =========================================================
            LEFT COLUMN: DRAG & DROP ZONE
        ========================================================= */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-2xl p-8 flex flex-col items-center justify-between text-center transition-all min-h-[380px] relative ${
            isDragOver
              ? 'border-[#E0533C] bg-orange-50/30'
              : 'border-slate-300 bg-slate-50/50 hover:bg-slate-50'
          }`}
        >
          {/* Hidden native input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            onChange={handleFileChange}
            className="hidden"
          />

          {isLoading ? (
            <div className="my-auto flex flex-col items-center justify-center space-y-4 py-12">
              <div className="w-14 h-14 rounded-full bg-slate-900 text-white flex items-center justify-center animate-spin">
                <Loader2 className="w-6 h-6 text-white" />
              </div>
              <div className="space-y-1">
                <p className="text-base font-bold text-slate-900">
                  Comprimiendo documento...
                </p>
                <p className="text-xs text-slate-500 max-w-xs">
                  Ejecutando pipeline seguro Ghostscript -dSAFER y optimización de flujos.
                </p>
              </div>
            </div>
          ) : (
            <>
              {/* Top empty spacing / icon center */}
              <div className="pt-6 flex flex-col items-center">
                {/* Circular dark blue icon with arrow pointing down */}
                <div className="w-14 h-14 rounded-full bg-[#1E293B] text-white flex items-center justify-center shadow-sm mb-5 transition-transform hover:scale-105">
                  <ArrowDown className="w-6 h-6 stroke-[2.5]" />
                </div>

                {/* Main text */}
                <h3 className="text-base font-bold text-slate-900 mb-1">
                  Suelta tu PDF aquí
                </h3>

                {/* Subtitle text */}
                <p className="text-xs text-slate-500 max-w-xs leading-relaxed">
                  o selecciónalo desde tu equipo. La descarga comienza automáticamente.
                </p>

                {selectedFile && !result && (
                  <div className="mt-4 px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-mono text-slate-700 flex items-center gap-2">
                    <FileText className="w-3.5 h-3.5 text-[#E0533C]" />
                    <span className="truncate max-w-[200px]">{selectedFile.name}</span>
                    <span className="text-slate-400">({formatSize(selectedFile.size)})</span>
                  </div>
                )}
              </div>

              {/* Bottom stylized button */}
              <div className="w-full pt-6">
                <button
                  type="button"
                  onClick={handleTriggerInput}
                  className="w-full sm:w-auto min-w-[180px] bg-white border border-slate-900 text-slate-900 hover:bg-slate-900 hover:text-white transition-colors duration-150 py-2.5 px-6 rounded-lg text-sm font-semibold shadow-xs"
                >
                  Elegir archivo
                </button>
              </div>
            </>
          )}
        </div>

        {/* =========================================================
            RIGHT COLUMN: RESULT & STATISTICS PANEL
        ========================================================= */}
        <div className="bg-slate-50/70 border border-slate-200/90 rounded-2xl p-8 flex flex-col justify-between min-h-[380px]">
          <div>
            {/* Header: RESULTADO */}
            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider block mb-6 font-mono">
              RESULTADO
            </span>

            {/* Content area: initial vs calculated */}
            {!result ? (
              <div className="py-20 text-center flex flex-col items-center justify-center">
                <p className="text-slate-400 text-sm font-medium italic">
                  Tus estadísticas aparecerán aquí.
                </p>
                <p className="text-xs text-slate-400/80 mt-1 max-w-xs">
                  Carga un archivo en la columna izquierda para iniciar la optimización.
                </p>
              </div>
            ) : (
              <div className="space-y-6 animate-in fade-in duration-200">
                {/* File details card */}
                <div className="flex items-center justify-between pb-4 border-b border-slate-200">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <FileText className="w-5 h-5 text-[#E0533C] shrink-0" />
                    <span className="text-sm font-bold text-slate-900 truncate">
                      {result.originalName}
                    </span>
                  </div>
                </div>

                {/* 3 Key Calculated Stats */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {/* Peso Original */}
                  <div className="bg-white p-4 rounded-xl border border-slate-200/80">
                    <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                      Peso Original
                    </span>
                    <p className="text-lg font-extrabold text-slate-800 font-mono tabular-nums">
                      {formatSize(result.originalSize)}
                    </p>
                  </div>

                  {/* Peso Comprimido */}
                  <div className="bg-white p-4 rounded-xl border border-slate-200/80">
                    <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                      Peso Comprimido
                    </span>
                    <p className="text-lg font-extrabold text-emerald-600 font-mono tabular-nums">
                      {formatSize(result.finalSize)}
                    </p>
                  </div>

                  {/* Porcentaje de Ahorro */}
                  <div className="bg-white p-4 rounded-xl border border-slate-200/80">
                    <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                      Ahorro
                    </span>
                    <p className="text-lg font-extrabold text-[#E0533C] font-mono tabular-nums flex items-center gap-1">
                      <TrendingDown className="w-4 h-4 stroke-[2.5]" />
                      <span>{result.reductionPercentage > 0 ? `-${result.reductionPercentage}%` : 'Óptimo (0%)'}</span>
                    </p>
                  </div>
                </div>

                {result.reductionPercentage === 0 && (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900 flex items-center gap-2">
                    <Info className="w-4 h-4 text-amber-600 shrink-0" />
                    <span>
                      Este archivo ya contaba con compresión máxima en sus imágenes. Se preservó el archivo original para garantizar que no suba de peso.
                    </span>
                  </div>
                )}

                {/* Nota recordatoria sobre firmas electrónicas */}
                <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-[11px] text-slate-500 flex items-center gap-2">
                  <ShieldAlert className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                  <span>Recordatorio: Las firmas digitales y certificados incrustados se han invalidado/removido para permitir la compactación de los objetos binarios.</span>
                </div>

                {/* Auto download confirmation banner */}
                <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center justify-between text-xs text-emerald-800">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span>
                      {autoDownloaded
                        ? 'La descarga automática se ha iniciado con éxito.'
                        : 'Archivo listo para descargar.'}
                    </span>
                  </div>
                  {result.downloadUrl && (
                    <a
                      href={result.downloadUrl}
                      download={`comprimido_${result.originalName}`}
                      className="font-bold underline text-emerald-900 hover:text-emerald-700"
                    >
                      Descargar de nuevo
                    </a>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Bottom actions */}
          {result && (
            <div className="pt-6 border-t border-slate-200 flex items-center justify-between">
              <button
                type="button"
                onClick={resetAll}
                className="text-xs font-semibold text-slate-600 hover:text-slate-900 flex items-center gap-1.5 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Comprimir otro archivo</span>
              </button>

              {result.downloadUrl && (
                <a
                  href={result.downloadUrl}
                  download={`comprimido_${result.originalName}`}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-[#1E293B] text-white hover:bg-slate-800 text-xs font-bold rounded-lg transition-colors shadow-sm"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Descargar PDF</span>
                </a>
              )}
            </div>
          )}
        </div>
      </div>

      {/* =========================================================
          CONSENT MODAL (STRICT WARNING)
      ========================================================= */}
      {showConsentModal && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs animate-in fade-in duration-150"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md bg-white rounded-2xl p-6 shadow-2xl border border-slate-200 space-y-4 text-left">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-amber-50 border border-amber-200 text-amber-600 flex items-center justify-center shrink-0">
                <ShieldAlert className="w-5 h-5" />
              </div>
              <h3 className="text-base font-bold text-slate-900">
                Confirmación de Seguridad
              </h3>
            </div>

            {selectedFile && (
              <div className="text-xs font-mono bg-slate-50 border border-slate-200 p-2.5 rounded-lg text-slate-600 truncate">
                Archivo: <span className="font-semibold text-slate-900">{selectedFile.name}</span> ({formatSize(selectedFile.size)})
              </div>
            )}

            {/* Exact required warning text */}
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl space-y-1.5 text-left">
              <div className="flex items-center gap-2 text-amber-900 font-bold text-xs uppercase tracking-wide">
                <ShieldAlert className="w-4 h-4 text-amber-600" />
                <span>Advertencia de Firmas y Certificados</span>
              </div>
              <p className="text-xs sm:text-sm text-slate-700 leading-relaxed font-medium">
                La compresión de este documento <strong>invalidará y removerá cualquier firma digital o certificado electrónico incrustado</strong> al reconstruir el flujo de datos. ¿Desea proseguir con la optimización?
              </p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={handleCancelConsent}
                className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleConfirmConsent}
                className="px-4 py-2 text-xs font-semibold text-white bg-[#E0533C] hover:bg-[#c94530] rounded-lg transition-colors shadow-sm"
              >
                Sí, Proseguir con la Optimización
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
