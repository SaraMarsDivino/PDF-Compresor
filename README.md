# PDF COMPRESOR · Sistema de Optimización de Alta Eficiencia

Plataforma corporativa de compresión, compactación y optimización de documentos PDF con preservación estructural garantizada del 100% de páginas y pipeline híbrido de doble etapa (**PyMuPDF + Ghostscript Sandboxed**).

---

## Índice
1. [Descripción General y Principios de Diseño](#descripción-general-y-principios-de-diseño)
2. [Arquitectura del Sistema](#arquitectura-del-sistema)
3. [Flujo de Procesamiento Híbrido (PyMuPDF + Ghostscript)](#flujo-de-procesamiento-híbrido-pymupdf--ghostscript)
4. [Medidas de Seguridad Implementadas](#medidas-de-seguridad-implementadas)
5. [Instrucciones de Ejecución mediante Docker](#instrucciones-de-ejecución-mediante-docker)
6. [Ejecución en Entorno Local (sin Docker)](#ejecución-en-entorno-local-sin-docker)
7. [Variables de Entorno](#variables-de-entorno)

---

## Descripción General y Principios de Diseño

El sistema está diseñado para resolver las limitaciones críticas de los compresores de PDF convencionales:
1. **Preservación Estructural del 100% de Páginas:** Garantía matemática de cero páginas eliminadas, cortadas o truncadas, protegiendo documentos legales, contractuales y libros extensos.
2. **Modo Objetivo Inteligente (≤ 3.5 MB):** Pipeline multi-etapa adaptativo que calibra progresivamente la resolución y calidad de imágenes hasta situar el documento bajo la cota requerida (3.5 MB) para plataformas bancarias o gubernamentales, sin comprometer la legibilidad ni omitir páginas.
3. **Regla de Oro Anti-Inflación:** Nunca devuelve un archivo que pese más que el original. Si un documento ya fue optimizado al límite y una re-compresión aumentaría su peso en bytes, el motor preserva el original sin alteraciones.
4. **Advertencia de Firma Digital (PAdES / CMS):** Detección preventiva de firmas electrónicas avanzadas (`/SigFlags`, `/ByteRange`) con confirmación de consentimiento explícito al usuario antes de modificar estructuras criptográficas.

---

## Arquitectura del Sistema

El sistema implementa una arquitectura desacoplada y eficiente de tipo Full-Stack en un único artefacto reproducible:

```
┌────────────────────────────────────────────────────────────────────────┐
│                                CLIENTE                                 │
│  React 19 + TypeScript + Tailwind CSS (Vite SPA)                       │
│  - Zona Drag & Drop con validación previa de cabecera binaria (%PDF-)  │
│  - Modal de advertencia criptográfica ante firmas electrónicas         │
│  - Estadísticas de peso, ahorro porcentual y descarga automática       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP POST (application/pdf)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                         SERVIDOR NODE.JS / EXPRESS                     │
│  server.ts                                                             │
│  - Rate Limiter por IP & Semáforo de Concurrencia (Anti-OOM)           │
│  - Verificación estricta de Magic Bytes (%PDF-) y sanitización        │
│  - Invocación segura mediante child_process.execFile (Sin Shell)       │
│  - Purga de temporales con garantía de Cero Retención en Disco         │
└───────────────────┬────────────────────────────────┬───────────────────┘
                    │                                │
         (Paso 1)   ▼                                ▼   (Paso 2)
┌───────────────────────────────┐        ┌───────────────────────────────┐
│     ETAPA 1: PyMuPDF          │        │    ETAPA 2: GHOSTSCRIPT       │
│  optimizer.py                 │        │  Motor binario nativo (gs)    │
│  - Cirugía de XObjects raster │  ───►  │  - Sandbox aislado -dSAFER    │
│  - Re-muestreo inteligente    │        │  - Deflación de tablas XRef   │
│  - Control Decompression Bomb │        │  - Deduplicación de streams   │
└───────────────────────────────┘        └───────────────────────────────┘
```

### Componentes Principales:
* **Frontend (`src/components/ModernVueCompressor.tsx`):** Interfaz moderna y minimalista con soporte de arrastrar y soltar, cálculo dinámico de estadísticas y descarte de URLs en memoria para evitar fugas (*memory leaks*).
* **Servidor de Aplicación (`server.ts`):** Controlador Express que gestiona el endpoint `/api/compress`, orquesta los motores externos, aplica límites de seguridad y sirve la aplicación en producción.
* **Optimizador de Imágenes (`optimizer.py`):** Script auxiliar en Python que utiliza `PyMuPDF` (`fitz`) y `Pillow` para intervenir individualmente las imágenes incrustadas sin tocar el texto vectorial ni los gráficos nativos.

---

## Flujo de Procesamiento Híbrido (PyMuPDF + Ghostscript)

Cuando el usuario carga un documento, se ejecuta el siguiente pipeline secuencial:

### 1. Validación de Entrada y Detección de Firmas
* Se valida la firma mágica del archivo (`0x25 0x50 0x44 0x46 0x2D` = `%PDF-`).
* Se escanea la cabecera y cola del documento buscando marcadores de firma digital como `/Sig`, `/SigFlags` y `/ByteRange`.

### 2. Etapa 1: Cirugía de Imágenes con PyMuPDF (`optimizer.py`)
* Se recorren todas las páginas del árbol PDF y se inspecciona la lista de `XObject` de tipo imagen.
* **Filtro selectivo:** Se omiten íconos y gráficos pequeños (< 8 KB) para evitar distorsiones visuales.
* **Downsampling y Recompresión:**
  * Si la resolución supera las dimensiones máximas recomendadas, se reduce con interpolación de alta calidad `LANCZOS`.
  * Imágenes con transparencia (RGBA / canal alfa) se recomprimen en `PNG` optimizado.
  * Imágenes opacas se convierten a `JPEG` progresivo con cuantización balanceada (75-78%).
  * **Regla estricta:** Solo se sustituye el stream original si el nuevo flujo de bytes es estrictamente menor.
* Se guarda el archivo intermedio aplicando desfragmentación total (`garbage=4, deflate=True, clean=True`).

### 3. Etapa 2: Compactación Estructural con Ghostscript
* El archivo procesado (o el original si no requiere cirugía de imágenes) pasa al motor binario Ghostscript con los siguientes parámetros optimizados:
  * `-dSAFER`: Aislamiento en sandbox que bloquea operaciones de archivos en PostScript.
  * `-sDEVICE=pdfwrite`: Generador nativo de PDF.
  * `-dPDFSETTINGS=/ebook` (o `/screen` según el perfil seleccionado).
  * `-dCompressFonts=true` y `-dSubsetFonts=true`: Subsetting y compresión de tipografías incrustadas.
  * `-dDetectDuplicateImages=true`: Reemplaza imágenes duplicadas por referencias únicas.
  * `-dCreateJBig2Sections=true` y `-dOptimize=true`: Reordenamiento y linearización de streams.
* **Segundo Pase Adaptativo:** Si tras la primera pasada el archivo aumenta de tamaño debido a sobrecompresión de diccionarios, Ghostscript ejecuta automáticamente un pase secundario calibrado a 96 DPI.

### 4. Verificación de Integridad y Regla de Oro
* Se ejecuta un conteo de páginas exacto mediante `pdfpagecount` para verificar que el número de páginas resultante coincide 100% con el original.
* Si el tamaño final del archivo optimizado es menor al original, se envía el archivo comprimido. En caso contrario, se devuelve el buffer original sin modificaciones.
* Todos los archivos temporales generados en `/tmp` se destruyen de inmediato.

---

## Medidas de Seguridad Implementadas

El sistema cuenta con un blindaje multicapa tanto en el servidor como en el cliente:

| Medida de Seguridad | Implementación Técnica | Amenaza Mitigada |
| :--- | :--- | :--- |
| **Sandbox de Ghostscript** | Parámetro `-dSAFER` obligatorio en todas las ejecuciones de `gs`. | Ejecución remota de código (RCE) y lectura de archivos locales vía operadores PostScript maliciosos. |
| **Prevención de Inyección de Comandos** | Invocación estricta mediante `child_process.execFileAsync` pasando argumentos como arreglo sin crear subshells (`/bin/sh`). | Inyección de comandos en el sistema operativo host. |
| **Validación de Cabecera Mágica (`%PDF-`)** | Análisis de bytes binarios (`buffer.subarray(0, 5)`) en cliente y backend antes de escribir a disco. | Carga de archivos maliciosos renombrados a `.pdf` (ej. ejecutables ELF/PE, scripts PHP, shells). |
| **Sanitización de Nombres de Archivo** | Eliminación de null bytes (`\0`), saltos de línea (CRLF) y caracteres de salto de directorio (`../`, `..\`). | Ataques de *Path Traversal* y *HTTP Response Splitting*. |
| **Control de Concurrencia** | Semáforo de ejecución limitada (máximo 3 optimizaciones pesadas simultáneas). | Caída del servidor por agotamiento de memoria RAM (*Out-Of-Memory* / OOM). |
| **Rate Limiting por IP** | Ventana deslizante en memoria con un límite de 40 solicitudes por minuto por cliente IP. | Ataques de denegación de servicio (*DoS*) y fuerza bruta. |
| **Cero Retención en Disco** | Destrucción garantizada de archivos temporales en bloques `finally` y handlers de señales `SIGINT` / `SIGTERM`. | Fuga o persistencia no autorizada de documentos confidenciales de usuarios en el servidor. |
| **Anti-Decompression Bombs** | Configuración de `Image.MAX_IMAGE_PIXELS = 64_000_000` en Pillow. | Ataques de bomba de descompresión (*Zip/Pixel Bombs*) en imágenes incrustadas. |
| **Cabeceras HTTP OWASP** | Inclusión de `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Cache-Control: no-store` y desactivación de `X-Powered-By`. | Sniffing de tipos MIME, Clickjacking y almacenamiento accidental en cachés intermedias. |
| **Prevención de Memory Leaks en Cliente** | Revocación explícita de `URL.revokeObjectURL()` tras descargas y desmontaje de componentes. | Degradación del rendimiento de memoria en el navegador del usuario. |

---

## Instrucciones de Ejecución mediante Docker

El proyecto incluye un entorno Docker listo para producción basado en `Debian Bookworm` con todas las dependencias del sistema operativo (Ghostscript nativo, Python3, PyMuPDF, Pillow y Node.js 20).

### Requisitos Previos
* [Docker](https://docs.docker.com/get-docker/) (versión 20.10 o superior)
* [Docker Compose](https://docs.docker.com/compose/) (versión 2.0 o superior)

---

### Opción A: Ejecución Rápida con Docker Compose (Recomendada)

1. **Construir e iniciar el contenedor en segundo plano:**
   ```bash
   docker compose up -d --build
   ```

2. **Verificar el estado del servicio:**
   ```bash
   docker compose ps
   ```

3. **Ver los logs en tiempo real:**
   ```bash
   docker compose logs -f
   ```

4. **Detener y eliminar el contenedor:**
   ```bash
   docker compose down
   ```

La aplicación quedará disponible en: **`http://localhost:3000`**

---

### Opción B: Construcción y Ejecución con Docker CLI

1. **Construir la imagen Docker:**
   ```bash
   docker build -t pdf-compressor .
   ```

2. **Ejecutar el contenedor:**
   ```bash
   docker run -d \
     --name pdf-compressor-app \
     -p 3000:3000 \
     --restart unless-stopped \
     pdf-compressor
   ```

3. **Comprobar la salud del endpoint:**
   ```bash
   curl -I http://localhost:3000
   ```

4. **Detener y remover el contenedor:**
   ```bash
   docker stop pdf-compressor-app && docker rm pdf-compressor-app
   ```

---

## Ejecución en Entorno Local (sin Docker)

Si prefieres ejecutar el proyecto directamente en tu máquina de desarrollo:

### 1. Requisitos del Sistema
* **Node.js:** v20.x o superior
* **Ghostscript:** `gs` versión 9.50 o superior instalado en el PATH del sistema.
  * Ubuntu/Debian: `sudo apt-get install ghostscript python3 python3-pip`
  * macOS (Homebrew): `brew install ghostscript python3`
* **Python (Opcional para Etapa 1 de imágenes):**
  ```bash
  pip install pymupdf pillow
  ```

### 2. Instalación y Compilación
```bash
# Instalar dependencias de Node.js
npm install

# Modo Desarrollo (Hot-Reloading en Vite + Express en puerto 3000)
npm run dev

# Compilar para Producción
npm run build

# Iniciar Servidor de Producción
npm start
```

---

## Variables de Entorno

El servidor admite las siguientes variables de configuración en un archivo `.env` o a nivel de entorno:

| Variable | Tipo | Valor por Defecto | Descripción |
| :--- | :--- | :--- | :--- |
| `PORT` | Numérico | `3000` | Puerto TCP en el que escucha el servidor Express. |
| `NODE_ENV` | Cadena | `production` / `development` | Modo de ejecución del servidor Node.js. |
