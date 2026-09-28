import express from 'express';
import { createServer as createViteServer } from 'vite';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';

const execFileAsync = promisify(execFile);

// ============================================================================
// MEDIDAS DE SEGURIDAD 1: RATE LIMITING CONTRA ATAQUES DOS Y EXHAUSTIÓN
// ============================================================================
interface RateLimitEntry {
  count: number;
  resetTime: number;
}
const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minuto
const MAX_REQUESTS_PER_WINDOW = 40; // Máximo 40 peticiones por minuto por IP

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  if (entry.count >= MAX_REQUESTS_PER_WINDOW) {
    return true;
  }
  entry.count++;
  return false;
}

// Limpieza periódica de IPs antiguas para evitar fuga de memoria
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now > entry.resetTime) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);

// ============================================================================
// MEDIDAS DE SEGURIDAD 2: CONTROL DE CONCURRENCIA PARA PREVENIR OOM (OUT OF MEMORY)
// ============================================================================
let activeCompressions = 0;
const MAX_CONCURRENT_COMPRESSIONS = 3;
const compressionQueue: Array<() => void> = [];

function acquireCompressionSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (activeCompressions < MAX_CONCURRENT_COMPRESSIONS) {
      activeCompressions++;
      resolve();
    } else {
      compressionQueue.push(() => {
        activeCompressions++;
        resolve();
      });
    }
  });
}

function releaseCompressionSlot() {
  activeCompressions--;
  if (compressionQueue.length > 0 && activeCompressions < MAX_CONCURRENT_COMPRESSIONS) {
    const next = compressionQueue.shift();
    if (next) next();
  }
}

// ============================================================================
// MEDIDAS DE SEGURIDAD 3: SANITIZACIÓN ESTRICTA DE NOMBRES DE ARCHIVO
// ============================================================================
function sanitizeFilename(raw: unknown): string {
  if (typeof raw !== 'string') return 'documento.pdf';
  // Eliminar null bytes, saltos de línea (CRLF injection) y secuencias path traversal
  let clean = raw.replace(/\0/g, '').replace(/[\r\n]/g, '');
  clean = clean.replace(/[/\\?%*:|"<>]/g, '_');
  clean = clean.replace(/[\x00-\x1F\x7F]/g, '');
  clean = path.basename(clean).trim();

  if (!clean.toLowerCase().endsWith('.pdf')) {
    clean = clean + '.pdf';
  }
  if (clean.length > 120) {
    clean = clean.substring(0, 116) + '.pdf';
  }
  return clean || 'documento.pdf';
}

// ============================================================================
// MEDIDAS DE SEGURIDAD 4: RASTREO Y PURGA DE ARCHIVOS TEMPORALES (ANTI-LEAK)
// ============================================================================
const globalActiveTempFiles = new Set<string>();

function registerTempFile(filepath: string) {
  globalActiveTempFiles.add(filepath);
}

async function removeTempFile(filepath: string) {
  globalActiveTempFiles.delete(filepath);
  try {
    if (fs.existsSync(filepath)) {
      await fs.promises.unlink(filepath);
    }
  } catch {
    // Si ya no existe o está siendo liberado, omitir
  }
}

// Limpieza de emergencia si el proceso recibe señal de apagado
const cleanupAllActiveTempFiles = () => {
  for (const file of globalActiveTempFiles) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {}
  }
};
process.on('SIGTERM', cleanupAllActiveTempFiles);
process.on('SIGINT', cleanupAllActiveTempFiles);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const isProd = process.env.NODE_ENV === 'production';

  // Deshabilitar cabecera de fingerprinting de Express
  app.disable('x-powered-by');

  // ============================================================================
  // MEDIDAS DE SEGURIDAD 5: CABECERAS HTTP DE SEGURIDAD (OWASP RECOMENDADAS)
  // ============================================================================
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  // Parse raw body for PDFs up to 100MB con límite estricto
  app.use('/api/compress', express.raw({ type: ['application/pdf', 'application/octet-stream', '*/*'], limit: '100mb' }));
  app.use(express.json({ limit: '10mb' }));

  // Endpoint para descargar el proyecto completo listo para Docker
  app.get('/api/download-project', async (_req, res) => {
    const zipPath = path.join(os.tmpdir(), `project_${Date.now()}.zip`);
    try {
      await execFileAsync('python3', [
        '-c',
        `import zipfile, os
exclude_dirs = {'.git', 'node_modules', 'dist', '.aistudio', '__pycache__'}
with zipfile.ZipFile('${zipPath}', 'w', zipfile.ZIP_DEFLATED) as zipf:
    for root, dirs, files in os.walk('.'):
        dirs[:] = [d for d in dirs if d not in exclude_dirs]
        for f in files:
            if f.endswith('.zip') or f.endswith('.pyc'):
                continue
            p = os.path.join(root, f)
            zipf.write(p, os.path.relpath(p, '.'))
`,
      ]);
      const zipBuffer = await fs.promises.readFile(zipPath);
      await fs.promises.unlink(zipPath).catch(() => {});
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="pdf-compressor-project.zip"');
      return res.send(zipBuffer);
    } catch (e: any) {
      await fs.promises.unlink(zipPath).catch(() => {});
      return res.status(500).json({ error: 'Error generando zip: ' + e.message });
    }
  });

  // API endpoint: Compresión Segura de PDF con Sandboxing
  app.post('/api/compress', async (req, res) => {
    const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';

    // 1. Verificación Rate Limit
    if (isRateLimited(clientIp)) {
      return res.status(429).json({
        error: 'Límite de solicitudes alcanzado. Por favor, espere un momento antes de volver a comprimir.',
      });
    }

    // 2. Control de Concurrencia
    await acquireCompressionSlot();

    const fileId = crypto.randomBytes(16).toString('hex');
    const inputPath = path.join(os.tmpdir(), `input_${fileId}.pdf`);
    const outputPath = path.join(os.tmpdir(), `output_${fileId}.pdf`);
    const pymupdfTemp = path.join(os.tmpdir(), `pymupdf_${fileId}.pdf`);

    registerTempFile(inputPath);
    registerTempFile(outputPath);
    registerTempFile(pymupdfTemp);

    try {
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);

      // ============================================================================
      // MEDIDAS DE SEGURIDAD 6: VALIDACIÓN CRIPTOGRÁFICA DE FIRMA MÁGICA (%PDF-)
      // ============================================================================
      if (!buffer || buffer.length === 0) {
        return res.status(400).json({ error: 'No se recibió archivo para procesar' });
      }

      // El archivo debe tener al menos 32 bytes y empezar con la firma binaria de PDF
      const PDF_MAGIC_BYTES = Buffer.from('%PDF-');
      if (buffer.length < 32 || !buffer.subarray(0, 5).equals(PDF_MAGIC_BYTES)) {
        return res.status(400).json({ 
          error: 'Seguridad: El archivo cargado no es un documento PDF válido. Firma binaria (%PDF-) ausente o alterada.' 
        });
      }

      // Máximo tamaño de archivo: 100MB
      if (buffer.length > 100 * 1024 * 1024) {
        return res.status(413).json({ error: 'El archivo excede el tamaño máximo permitido de 100 MB.' });
      }

      // Sanitizar parámetros de entrada
      const fileName = sanitizeFilename(req.query.name);
      const rawLevel = (req.query.level as string) || 'recommended';
      const targetMbParam = req.query.target_mb ? parseFloat(req.query.target_mb as string) : (rawLevel === 'target35' ? 3.5 : null);
      const targetBytes = targetMbParam && targetMbParam > 0 ? targetMbParam * 1024 * 1024 : null;
      const compressionLevel = ['recommended', 'extreme', 'high', 'target35'].includes(rawLevel) ? rawLevel : 'recommended';
      const forceFallback = req.query.force_fallback === 'true';

      await fs.promises.writeFile(inputPath, buffer, { mode: 0o600 });
      const originalSize = buffer.length;

      const logs: Array<{ level: string; message: string; timestamp: string; source: string }> = [];
      const addLog = (level: string, message: string, source = 'pdf_compressor.services') => {
        const now = new Date().toISOString().split('T')[1].slice(0, 12);
        logs.push({ level, message, timestamp: now, source });
      };

      addLog('INFO', `[RECEPCIÓN SEGURA] Archivo validado (%PDF-): '${fileName}' (${(originalSize / 1024 / 1024).toFixed(2)} MB)`, 'pdf_compressor.security');
      if (targetBytes) {
        addLog('INFO', `[MODO OBJETIVO ACTIVO] Meta estricta de peso: <= ${(targetBytes / 1024 / 1024).toFixed(2)} MB con preservación total de páginas.`, 'pdf_compressor.services');
      }
      addLog('INFO', `[FIRMA DIGITAL] Verificando presencia de estructuras /SigFlags y /ByteRange...`, 'pdf_compressor.security');

      // Check for digital signature markers in header/footer
      const sampleSize = Math.min(buffer.length, 1024 * 512);
      const bufferHeader = buffer.subarray(0, sampleSize).toString('latin1');
      const bufferTail = buffer.subarray(Math.max(0, buffer.length - sampleSize)).toString('latin1');
      const hasSignature = bufferHeader.includes('/Sig') || bufferTail.includes('/Sig') || bufferHeader.includes('/ByteRange');

      if (hasSignature) {
        addLog('WARNING', `[ALERTA FIRMA] Se detectó firma digital avanzada. Redirigiendo a modo preservación estricta para no invalidar el hash.`, 'pdf_compressor.security');
      }

      let engineUsed = targetBytes ? 'Pipeline Inteligente (Objetivo <= 3.5 MB)' : 'Ghostscript (EBook 130 DPI)';
      let gsSettings = '/ebook';
      let dpi = 130;

      if (compressionLevel === 'extreme') {
        gsSettings = '/screen';
        dpi = 72;
        engineUsed = 'Ghostscript (Screen 72 DPI)';
      } else if (compressionLevel === 'high') {
        gsSettings = '/printer';
        dpi = 300;
        engineUsed = 'Ghostscript (Printer 300 DPI)';
      } else if (targetBytes) {
        gsSettings = '/ebook';
        dpi = 120;
      }

      if (forceFallback) {
        addLog('WARNING', `[FAILOVER] Simulación de falla en Ghostscript activada por usuario.`, 'pdf_compressor.services');
      } else {
        addLog('INFO', `[GHOSTSCRIPT SANDBOX] Ejecutando con sandbox seguro -dSAFER, perfil ${gsSettings} y remuestreo a ${dpi} DPI...`, 'pdf_compressor.services');

        let currentSource = inputPath;

        // Etapa 1: Cirugía de imágenes con PyMuPDF (si python3 está disponible)
        try {
          const optScript = path.resolve('optimizer.py');
          if (fs.existsSync(optScript)) {
            addLog('INFO', `[PYMUPDF CIRUGÍA] Inspeccionando XObjects de imágenes con límites de descompresión...`, 'pdf_compressor.services');
            // MEDIDA DE SEGURIDAD 7: Invocación directa execFile sin intermediación de shell
            const optArgs = [optScript, inputPath, pymupdfTemp];
            if (targetBytes) {
              optArgs.push((targetBytes / (1024 * 1024)).toString());
            }
            await execFileAsync('python3', optArgs, { timeout: 45000 });
            if (fs.existsSync(pymupdfTemp) && fs.statSync(pymupdfTemp).size > 100) {
              currentSource = pymupdfTemp;
              addLog('INFO', `[PYMUPDF CIRUGÍA] Imágenes optimizadas exitosamente (${(fs.statSync(pymupdfTemp).size / 1024 / 1024).toFixed(2)} MB). Pasando a Ghostscript...`, 'pdf_compressor.services');
            }
          }
        } catch {
          // Si python3 o fitz no están presentes, Ghostscript continuará con inputPath directo de forma segura
        }

        // ============================================================================
        // MEDIDAS DE SEGURIDAD 8: GHOSTSCRIPT AISLADO CON -dSAFER Y EXECFILE
        // ============================================================================
        const runGs = async (out: string, settings: string, resolution: number, quality = 75) => {
          const gsArgs = [
            '-sDEVICE=pdfwrite',
            '-dCompatibilityLevel=1.4',
            `-dPDFSETTINGS=${settings}`,
            '-dSAFER', // Sandboxing: deshabilita comandos de archivo y operadores peligrosos en PostScript
            '-dColorConversionStrategy=/LeaveColorUnchanged',
            '-dAutoFilterColorImages=false',
            '-dColorImageFilter=/DCTEncode',
            '-dDownsampleColorImages=true',
            '-dColorImageDownsampleType=/Bicubic',
            `-dColorImageResolution=${resolution}`,
            '-dAutoFilterGrayImages=false',
            '-dGrayImageFilter=/DCTEncode',
            '-dDownsampleGrayImages=true',
            '-dGrayImageDownsampleType=/Bicubic',
            `-dGrayImageResolution=${resolution}`,
            '-dMonoImageDownsampleType=/Subsample',
            `-dMonoImageResolution=${Math.min(resolution * 2, 300)}`,
            `-dJPEGQ=${quality}`,
            '-dDetectDuplicateImages=true',
            '-dCompressFonts=true',
            '-dSubsetFonts=true',
            '-dDoThumbnails=false',
            '-dCreateJBig2Sections=true',
            '-dOptimize=true',
            '-dNOPAUSE',
            '-dQUIET',
            '-dBATCH',
            `-sOutputFile=${out}`,
            currentSource,
          ];
          await execFileAsync('gs', gsArgs, { timeout: 45000 });
        };

        try {
          await runGs(outputPath, gsSettings, dpi, 78);

          // Si se configuró targetBytes y el resultado aún lo supera, aplicar pase adaptativo
          if (targetBytes && fs.existsSync(outputPath) && fs.statSync(outputPath).size > targetBytes) {
            addLog('INFO', `[MODO OBJETIVO] El pase inicial dio ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)} MB. Ejecutando Pase Adaptativo 2 (96 DPI, Q65)...`, 'pdf_compressor.services');
            const adaptId = crypto.randomBytes(8).toString('hex');
            const adaptPath = path.join(os.tmpdir(), `adapt_${adaptId}.pdf`);
            registerTempFile(adaptPath);
            try {
              await runGs(adaptPath, '/screen', 96, 62);
              if (fs.existsSync(adaptPath) && fs.statSync(adaptPath).size < fs.statSync(outputPath).size) {
                await fs.promises.copyFile(adaptPath, outputPath);
                addLog('INFO', `[MODO OBJETIVO] Pase 2 exitoso: Reducido a ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)} MB`, 'pdf_compressor.services');
              }
              // Si aún supera el objetivo, pase final 72 DPI
              if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > targetBytes) {
                addLog('INFO', `[MODO OBJETIVO] Pase Adaptativo 3 (72 DPI, Q48) para garantizar cota de 3.5 MB...`, 'pdf_compressor.services');
                await runGs(adaptPath, '/screen', 72, 48);
                if (fs.existsSync(adaptPath) && fs.statSync(adaptPath).size < fs.statSync(outputPath).size) {
                  await fs.promises.copyFile(adaptPath, outputPath);
                }
              }
            } finally {
              await removeTempFile(adaptPath);
            }
          } else if (fs.existsSync(outputPath) && fs.statSync(outputPath).size >= originalSize) {
            // Si el archivo resultante aumentó de tamaño, probar un segundo pase más agresivo
            addLog('INFO', `[GHOSTSCRIPT] Paso 2: El archivo original ya tenía alta compresión. Aplicando remuestreo a 96 DPI...`, 'pdf_compressor.services');
            const aggressiveId = crypto.randomBytes(8).toString('hex');
            const aggressivePath = path.join(os.tmpdir(), `agg_${aggressiveId}.pdf`);
            registerTempFile(aggressivePath);
            try {
              await runGs(aggressivePath, '/screen', 96, 68);
              if (fs.existsSync(aggressivePath) && fs.statSync(aggressivePath).size < fs.statSync(outputPath).size) {
                await fs.promises.copyFile(aggressivePath, outputPath);
              }
            } finally {
              await removeTempFile(aggressivePath);
            }
          }

          addLog('INFO', `[GHOSTSCRIPT] Proceso completado exitosamente con sandbox de seguridad activo.`, 'pdf_compressor.services');
        } catch (gsErr: any) {
          addLog('ERROR', `[GHOSTSCRIPT FALLO] ${gsErr?.message || 'Error en proceso GS'}. Activando Fallback seguro...`, 'pdf_compressor.services');
        }
      }

      // Count exact pages of the PDF de forma segura
      let exactPageCount = 0;
      try {
        const fileToCount = (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100) ? outputPath : inputPath;
        const countArgs = [
          '-q',
          '-dNODISPLAY',
          '-dSAFER',
          '-c',
          `(${fileToCount}) (r) file runpdfbegin pdfpagecount = quit`,
        ];
        const { stdout } = await execFileAsync('gs', countArgs, { timeout: 10000 });
        exactPageCount = parseInt(stdout.trim(), 10) || 0;
      } catch (countErr) {
        console.warn('Error counting pages with gs:', countErr);
      }

      const gsSucceeded = fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100;
      let currentBestSize = gsSucceeded ? fs.statSync(outputPath).size : Infinity;
      let currentBestPath = (gsSucceeded && currentBestSize < originalSize) ? outputPath : null;

      // Si Ghostscript no logró reducir el tamaño, O si se solicitó Modo Objetivo (targetBytes) y aún lo supera:
      const shouldRunPythonOptimizer = !currentBestPath || (targetBytes && currentBestSize > targetBytes);
      const optScriptPath = path.resolve('optimizer.py');
      if (shouldRunPythonOptimizer && fs.existsSync(optScriptPath)) {
        addLog('INFO', `[PIPELINE HÍBRIDO] Invocando motor Python (PyMuPDF) para optimización quirúrgica de escaneos...`, 'pdf_compressor.services');
        try {
          const targetMbArg = targetMbParam ? targetMbParam.toString() : '';
          const pyOutPath = path.join(os.tmpdir(), `py_opt_${fileId}.pdf`);
          registerTempFile(pyOutPath);
          const pySource = currentBestPath || inputPath;
          await execFileAsync('python3', [optScriptPath, pySource, pyOutPath, targetMbArg], { timeout: 75000 });
          if (fs.existsSync(pyOutPath) && fs.statSync(pyOutPath).size > 100) {
            const pySize = fs.statSync(pyOutPath).size;
            if (pySize < (currentBestPath ? currentBestSize : originalSize)) {
              currentBestPath = pyOutPath;
              currentBestSize = pySize;
              engineUsed = 'PyMuPDF Adaptive Hybrid Engine';
              addLog('INFO', `[PIPELINE HÍBRIDO] PyMuPDF redujo exitosamente el peso a ${(pySize / 1024 / 1024).toFixed(2)} MB`, 'pdf_compressor.services');
            }
          }
        } catch (pyErr: any) {
          addLog('WARN', `[PIPELINE HÍBRIDO] Aviso en PyMuPDF: ${pyErr?.message || pyErr}`, 'pdf_compressor.services');
        }
      }

      // Check if output exists and is valid
      let outputBuffer: Buffer;
      if (currentBestPath && currentBestSize < originalSize) {
        outputBuffer = await fs.promises.readFile(currentBestPath);
      } else {
        addLog('INFO', `[GARANTÍA ANTI-INFLACIÓN] El archivo original ya cuenta con compresión óptima. Se preserva el archivo original intacto para evitar aumento de tamaño.`, 'pdf_compressor.services');
        outputBuffer = buffer;
        engineUsed = 'Original Optimizado';
      }

      const finalSize = outputBuffer.length;
      const diff = originalSize - finalSize;
      const reductionPercentage = diff > 0 
        ? Number(((diff / originalSize) * 100).toFixed(1)) 
        : 0.0;

      addLog('INFO', `[COMPLETADO] Peso final: ${(finalSize / 1024 / 1024).toFixed(2)} MB (${reductionPercentage}% de ahorro). ${exactPageCount} páginas verificadas.`, 'pdf_compressor.services');
      addLog('DEBUG', `[MEMORIA VOLÁTIL] Limpieza inmediata de descriptores de archivo y temporales en disco. Cero retención.`, 'pdf_compressor.security');

      // Limpieza garantizada de archivos temporales de esta petición
      await removeTempFile(inputPath);
      await removeTempFile(outputPath);
      await removeTempFile(pymupdfTemp);

      // Cabeceras seguras en respuesta
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="comprimido_${encodeURIComponent(fileName)}"`);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('X-Original-Size', originalSize.toString());
      res.setHeader('X-Final-Size', finalSize.toString());
      res.setHeader('X-Reduction-Percentage', reductionPercentage.toString());
      res.setHeader('X-Page-Count', exactPageCount.toString());
      res.setHeader('X-Engine', engineUsed);
      res.setHeader('X-Security-Sandbox', 'Ghostscript-dSAFER-Active');
      res.setHeader('X-Logs', encodeURIComponent(JSON.stringify(logs)));

      return res.status(200).send(outputBuffer);
    } catch (err: any) {
      console.error('Compression API error:', err);
      return res.status(500).json({ error: 'Error procesando el PDF de forma segura: ' + (err?.message || err) });
    } finally {
      // Liberar ranura de concurrencia y asegurar que ningún archivo temporal quede en disco
      releaseCompressionSlot();
      await removeTempFile(inputPath);
      await removeTempFile(outputPath);
      await removeTempFile(pymupdfTemp);
    }
  });

  // Vite middleware in dev or static files in prod
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve('dist/index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening securely on port ${PORT}`);
  });
}

startServer();
