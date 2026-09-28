# Imagen base con Node.js 20 sobre Debian Bookworm
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Instalar Ghostscript nativo y Python3 con PyMuPDF + Pillow para el pipeline híbrido
RUN apt-get update && \
    apt-get install -y --no-install-recommends ghostscript python3 python3-pip && \
    pip install --no-cache-dir --break-system-packages pymupdf pillow && \
    rm -rf /var/lib/apt/lists/*

# Definir directorio de trabajo dentro del contenedor
WORKDIR /app

# Copiar definiciones de dependencias
COPY package*.json ./

# Instalar dependencias con compatibilidad de versiones
RUN npm install --legacy-peer-deps

# Copiar el código fuente completo del proyecto
COPY . .

# Compilar el frontend para producción
RUN npm run build

# Variables de entorno
ENV NODE_ENV=production
ENV PORT=3000

# Exponer el puerto 3000
EXPOSE 3000

# Comando para iniciar el servidor
CMD ["npm", "start"]
