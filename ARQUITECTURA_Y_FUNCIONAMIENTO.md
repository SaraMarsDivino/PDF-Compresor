# Sistema Compresor de PDFs de Alta Eficiencia: Arquitectura y Funcionamiento

Documento técnico explicativo del sistema de compresión, su arquitectura híbrida, pipeline de procesamiento, seguridad y garantías estructurales.

---

## 1. Visión General del Sistema

El **Compresor PDF** es un sistema full-stack diseñado específicamente para reducir el peso en megabytes de documentos PDF complejos (libros digitalizados, expedientes con imágenes de alta resolución, folletos publicitarios y formularios oficiales) asegurando dos principios fundamentales:

1. **Preservación Estructural del 100% de las Páginas:** A diferencia de scripts básicos que truncan o corrompen tablas XRef o pierden páginas intermedias, este sistema verifica matemáticamente que la cantidad de páginas de entrada sea idéntica a la salida.
2. **Regla de Oro Anti-Inflación:** Ningún archivo resultante devuelto será más pesado que el original. Si un documento ya cuenta con compresión óptima previa, el sistema lo detecta y preserva el original sin alterarlo.

---

## 2. Arquitectura General del Sistema

El flujo sigue un modelo desacoplado y reactivo, con un frontend en dos columnas y un pipeline de dos etapas en el backend:

```text
[ Usuario: Arrastra o selecciona PDF ]
                  │
                  ▼
[ FRONTEND: Validación Binaria en Cliente (%PDF-) ]
                  │
                  ▼
[ MODAL DE CONSENTIMIENTO CRIPTOGRÁFICO ]
    ¿Desea proseguir invalidando firmas digitales?
         ├── CANCELAR ──► Detener flujo (0 peticiones)
         └── CONFIRMAR
                  │
                  ▼
[ POST /api/compress ] ── (Límite 100 MB, Rate Limiter IP & Concurrencia)
                  │
                  ▼
[ BACKEND: Inspección de Seguridad ]
    ├─ Verificación de Magic Bytes (%PDF-)
    ├─ Sanitización de Nombre (Anti Path Traversal / CRLF)
    └─ Detección de Firmas Digitales (/SigFlags, /ByteRange)
                  │
                  ▼
[ ETAPA 1: PyMuPDF - Cirugía de Imágenes ] (optimizer.py)
    ├─ Inspección de XObjects de imágenes rasterizadas
    ├─ Downsampling bicúbico a resolución óptima (1400px / 130 DPI)
    ├─ Re-compresión JPEG progresivo / PNG optimizado
    └─ Sustitución in-place en el árbol de objetos PDF
                  │
                  ▼
[ ETAPA 2: Ghostscript - Compactación Estructural ] (Sandboxed -dSAFER)
    ├─ Unificación de paletas de color
    ├─ Subsetting y compresión de fuentes tipográficas
    ├─ Deflación de flujos de texto y desfragmentación de tabla XRef
    └─ Removido de metadatos redundantes y thumbnails
                  │
                  ▼
[ CONTROL DE CALIDAD Y REGLA DE ORO ]
    ├─ ¿El archivo resultante es menor al original?
    │    ├── SÍ ──► Conservar archivo comprimido
    │    └── NO ──► Preservar archivo original intacto
    └─ Verificación exacta del conteo de páginas (gs page count)
                  │
                  ▼
[ PURGA INMEDIATA DE TEMPORALES (Anti-Leak) ]
    Destrucción de archivos temporales en memoria / disco
                  │
                  ▼
[ DESCARGA AUTOMÁTICA EN CLIENTE ]
    Recepción de response.blob() y disparo seguro de descarga
```

---

## 3. Detalle de Componentes

### 3.1. Frontend React / SPA
* **Diseño Minimalista en Dos Columnas:**
  * **Columna Izquierda (Área Dropzone):** Zona de arrastre de archivos con animación reactiva, selector manual y retroalimentación de estado durante el procesamiento.
  * **Columna Derecha (Panel de Métricas):** Visualización en tiempo real del peso original, peso final comprimido y porcentaje de ahorro logrado (`-X%`).
* **Modal de Advertencia de Integridad Criptográfica:**
  * Antes de despachar el archivo al backend, congela el flujo y advierte al usuario:
    > *"Advertencia: La compresión de este documento invalidará cualquier firma digital o certificado electrónico incrustado. ¿Desea proseguir con la optimización?"*
  * Esto previene que usuarios compriman inadvertidamente declaraciones juradas o contratos con firma digital PAdES/CMS que quedarían invalidados legalmente al reestructurar la tabla de objetos XRef.
* **Manejo Seguro del Blob de Descarga:**
  * Captura directamente el flujo binario `response.blob()` entregado por el backend con cabeceras `Content-Type: application/pdf` y `Content-Disposition`.
  * Genera el enlace de descarga automática y revoca preventivamente los Object URLs (`URL.revokeObjectURL`) para evitar fugas de memoria en el navegador.

### 3.2. Servidor Backend (`server.ts`)
* **Endpoint:** `POST /api/compress?name=<nombre>&level=<nivel>`
* **Cero Retención en Disco:**
  * Todos los archivos generados durante la compresión temporal (`input_*.pdf`, `output_*.pdf`, `pymupdf_*.pdf`, `agg_*.pdf`) son asignados con identificadores criptográficos aleatorios (`crypto.randomBytes(16)`) y eliminados rigurosamente dentro de un bloque `finally`.
  * Existen ganchos para señales de sistema (`SIGTERM`, `SIGINT`) que garantizan que el servidor nunca acumule archivos huérfanos en `/tmp`.
* **Motor Ghostscript y PyMuPDF:**
  * Ejecución desacoplada mediante llamadas de proceso asíncronas con temporizadores de desconexión por exceso de tiempo (`timeout`).

---

## 4. Pipeline Híbrido de Optimización

El problema típico de los compresores comunes es que tratan todo el PDF como imagen (destruyendo la nitidez del texto y haciendo que las páginas pierdan su formato) o simplemente no logran reducir nada porque las imágenes internas están embebidas en formatos complejos. Este sistema resuelve ese problema con dos fases complementarias:

### Fase 1: Cirugía de Imágenes con PyMuPDF (`optimizer.py`)
1. **Inspección Profunda:** Recorre el árbol de objetos del PDF y extrae las imágenes rasterizadas asociadas a cada página mediante referencias cruzadas `xref`.
2. **Filtrado Inteligente:** Ignora íconos pequeños o gráficos vectoriales menores a 8 KB para evitar degradar firmas o sellos.
3. **Optimización con Pillow:**
   * Imágenes a color: Convertidas a RGB y comprimidas como JPEG progresivo optimizado con calidad Q=75–78.
   * Imágenes con canal alfa o transparencias: Preservadas y optimizadas en PNG con deflación máxima.
4. **Sustitución Atómica:** Si el flujo comprimido es menor que el original, reemplaza el stream del objeto `xref`. Si no, lo mantiene intacto.

### Fase 2: Compactación Estructural con Ghostscript (`gs`)
Ghostscript toma el documento pre-procesado y realiza la optimización de bajo nivel:
```bash
gs \
  -sDEVICE=pdfwrite \
  -dCompatibilityLevel=1.4 \
  -dPDFSETTINGS=/ebook \
  -dSAFER \
  -dColorConversionStrategy=/LeaveColorUnchanged \
  -dAutoFilterColorImages=false \
  -dColorImageFilter=/DCTEncode \
  -dDownsampleColorImages=true \
  -dColorImageDownsampleType=/Bicubic \
  -dColorImageResolution=130 \
  -dAutoFilterGrayImages=false \
  -dGrayImageFilter=/DCTEncode \
  -dDownsampleGrayImages=true \
  -dGrayImageDownsampleType=/Bicubic \
  -dGrayImageResolution=130 \
  -dMonoImageResolution=300 \
  -dJPEGQ=78 \
  -dDetectDuplicateImages=true \
  -dCompressFonts=true \
  -dSubsetFonts=true \
  -dDoThumbnails=false \
  -dCreateJBig2Sections=true \
  -dOptimize=true \
  -dNOPAUSE \
  -dQUIET \
  -dBATCH \
  -sOutputFile="salida.pdf" \
  "entrada.pdf"
```

* **Deduplicación:** Si la misma imagen (ej. el membrete institucional o logo de la empresa) se repite en 100 páginas, Ghostscript almacena la imagen una sola vez y hace referencia a ella en las 99 restantes.
* **Subsetting de fuentes:** Se eliminan los glifos no utilizados de las fuentes tipográficas embebidas.
* **Deflación Flate:** Se comprimen los diccionarios de páginas, marcadores y árboles de contenido.

---

## 5. Medidas de Seguridad Implementadas

El sistema incorpora estándares de defensa en profundidad:

| Medida de Seguridad | Implementación Técnica | Amenaza Mitigada |
| :--- | :--- | :--- |
| **Sandboxing `-dSAFER`** | Parámetro obligatorio en Ghostscript | Ejecución remota de comandos y lectura no autorizada del sistema de archivos mediante operadores de PostScript maliciosos. |
| **Llamadas Seguras `execFile`** | Sustitución de `exec` por `execFile` sin invocación de shell (`/bin/sh`) | Inyección de comandos en el sistema operativo mediante nombres de archivo manipulados. |
| **Validación Binaria (`%PDF-`)** | Lectura de los primeros 5 bytes en frontend y backend | Archivos maliciosos camuflados como PDF (ejecutables, scripts bash, PHP, HTML con XSS). |
| **Sanitización de Nombres** | Regex de eliminación de caracteres nulos, saltos CRLF y path traversal (`../`) | Sobreescritura de archivos del sistema, directory traversal y HTTP Response Splitting. |
| **Protección Anti-DoS** | Rate Limiting por IP (40 req/min) con ventana deslizante | Ataques de denegación de servicio por envío masivo continuo de peticiones de compresión. |
| **Semáforo de Concurrencia** | Máximo 3 optimizaciones pesadas simultáneas con cola ordenada | Desbordamiento de memoria RAM (OOM Crash) y saturación de CPU por procesos paralelos. |
| **Cero Retención de Datos** | Destrucción forzada de temporales en bloque `finally` y handlers de terminación | Fuga de privacidad y almacenamiento indebido de documentos confidenciales de usuarios en el servidor. |
| **Anti-Decompression Bombs** | Límite estricto `Image.MAX_IMAGE_PIXELS = 64_000_000` en Pillow | Ataques por desbordamiento de memoria al abrir imágenes gigantes comprimidas (Zip/PDF bombs). |
| **Cabeceras HTTP OWASP** | `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `no-store` | MIME-sniffing, clickjacking y persistencia no deseada de copias en cachés intermedias. |

---

## 6. Estructura Limpia del Proyecto

Tras la depuración de código huérfano, el proyecto mantiene una estructura modular y directa:

```text
├── package.json               # Dependencias de producción y scripts de compilación
├── tsconfig.json              # Configuración estricta de TypeScript
├── vite.config.ts             # Configuración de empaquetado Vite
├── server.ts                  # Servidor Express Full-Stack, endpoints y seguridad
├── optimizer.py               # Pipeline Python para optimización quirúrgica de imágenes
├── index.html                 # Punto de entrada HTML
└── src/
    ├── App.tsx                # Contenedor raíz de la aplicación
    ├── main.tsx               # Bootstrap de React 19
    ├── index.css              # Configuración Tailwind CSS
    ├── components/
    │   ├── Navbar.tsx         # Barra superior con estado del servicio
    │   └── ModernVueCompressor.tsx  # Componente principal de compresión
    ├── types/
    │   └── index.ts           # Definiciones TypeScript de resultados y registros
    └── utils/
        └── pdfSimulator.ts    # Conexión al backend y motor cliente de respaldo
```

---

## 7. Ejecución y Despliegue

### Modo Desarrollo
```bash
npm run dev
```
Inicia el servidor Node.js/Express en el puerto 3000 con los middlewares de Vite montados para soporte full-stack inmediato.

### Modo Producción
```bash
npm run build
npm start
```
Compila los componentes cliente en la carpeta estática `dist/` y levanta el servidor Express sirviendo la API y la aplicación optimizada.
