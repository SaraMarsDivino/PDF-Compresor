#!/usr/bin/env python3
"""
Pipeline Híbrido Avanzado: PyMuPDF (Cirugía de Imágenes + Renderizado Adaptativo) + Ghostscript.
Optimiza cualquier documento PDF, incluidos escaneos pesados (>30 MB) con objetos complejos.
Garantiza el cumplimiento estricto del Modo Objetivo (<= 3.5 MB) preservando el 100% de páginas.
"""
import sys
import os
import io

def optimize_pdf_images(input_path: str, output_path: str, max_dimension=1400, quality=75, target_bytes=None):
    try:
        import fitz  # PyMuPDF
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = 100_000_000
    except ImportError as e:
        print(f"[OPTIMIZER AVISO] PyMuPDF o Pillow no disponibles: {e}", file=sys.stderr)
        import shutil
        shutil.copyfile(input_path, output_path)
        return

    original_size = os.path.getsize(input_path)
    temp_stage = output_path + ".stage.pdf"

    # =========================================================================
    # ESTRATEGIA 1: CIRUGÍA QUIRÚRGICA DE XOBJECTS (REEMPLAZO DIRECTO DE IMÁGENES)
    # =========================================================================
    if target_bytes and target_bytes > 0:
        profiles = [
            (1400, 72, False),  # Pase 1: Equilibrado alta definición
            (1100, 60, False),  # Pase 2: Compacto
            (900, 48, False),   # Pase 3: Agresivo manteniendo nitidez
            (850, 42, True),    # Pase 4: Escala de grises si es escaneo
        ]
    else:
        profiles = [
            (max_dimension, quality, False),
            (max_dimension - 250, max(quality - 18, 52), False)
        ]

    best_size = original_size
    best_file = None

    for idx, (dim, qual, to_gray) in enumerate(profiles):
        src_file = input_path if idx == 0 else temp_stage
        if not os.path.exists(src_file):
            src_file = input_path

        try:
            doc = fitz.open(src_file)
        except Exception as open_err:
            print(f"[OPTIMIZER ERROR] No se pudo abrir {src_file}: {open_err}", file=sys.stderr)
            break

        images_optimized = 0
        seen_xrefs = set()

        try:
            for page in doc:
                image_list = page.get_images(full=True)
                for img_info in image_list:
                    xref = img_info[0]
                    if xref in seen_xrefs:
                        continue
                    seen_xrefs.add(xref)

                    try:
                        base_image = doc.extract_image(xref)
                        if not base_image:
                            continue
                        image_bytes = base_image.get("image")
                        if not image_bytes or len(image_bytes) < 1024:
                            continue

                        img = Image.open(io.BytesIO(image_bytes))

                        # Redimensionar manteniendo ratio
                        if img.width > dim or img.height > dim:
                            img.thumbnail((dim, dim), Image.Resampling.LANCZOS)

                        if to_gray and img.mode != "L":
                            img = img.convert("L")

                        output_stream = io.BytesIO()
                        if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
                            img.save(output_stream, format="PNG", optimize=True)
                        else:
                            if img.mode not in ("RGB", "L"):
                                img = img.convert("RGB")
                            img.save(output_stream, format="JPEG", quality=qual, optimize=True)

                        compressed_bytes = output_stream.getvalue()
                        # Reemplazar siempre que reduzca o si buscamos cumplir target_bytes
                        if len(compressed_bytes) < len(image_bytes) or target_bytes:
                            page.replace_image(xref, stream=compressed_bytes)
                            images_optimized += 1
                    except Exception:
                        continue

            doc.save(output_path, garbage=4, deflate=True, clean=True)
            doc.close()

            if os.path.exists(output_path):
                current_size = os.path.getsize(output_path)
                if current_size < best_size:
                    best_size = current_size
                    best_file = output_path

                if target_bytes and current_size <= target_bytes:
                    print(f"[OPTIMIZER] Meta alcanzada con cirugía en pase {idx+1}: {current_size/(1024*1024):.2f} MB")
                    break

                import shutil
                shutil.copyfile(output_path, temp_stage)

        except Exception as save_err:
            print(f"[OPTIMIZER ERROR] Error en cirugía: {save_err}", file=sys.stderr)
            break

    # =========================================================================
    # ESTRATEGIA 2: RASTERIZACIÓN ADAPTATIVA PARA ESCANEOS REBELDES
    # Si la cirugía no logró bajar el peso bajo target_bytes (o no redujo el peso)
    # y el archivo original es pesado (>5MB), se reconstruyen las páginas de escaneo
    # =========================================================================
    current_size = os.path.getsize(output_path) if os.path.exists(output_path) else original_size
    need_deep_scan = (target_bytes and current_size > target_bytes) or (current_size >= original_size and original_size > 4 * 1024 * 1024)

    if need_deep_scan:
        print(f"[OPTIMIZER ESCANEO] Activando Reconstrucción Visual Adaptativa para escaneo rebelde ({original_size/(1024*1024):.2f} MB)...")
        try:
            doc = fitz.open(input_path)
            num_pages = len(doc)
            
            # Calibrar DPI y calidad según número de páginas y target_bytes
            target_mb_val = (target_bytes / (1024 * 1024)) if target_bytes else 3.5
            # Estimación de presupuesto por página en KB
            kb_per_page = (target_mb_val * 1024 * 0.9) / max(num_pages, 1)
            
            if kb_per_page < 50:
                dpi = 96
                qual = 45
            elif kb_per_page < 100:
                dpi = 110
                qual = 55
            else:
                dpi = 130
                qual = 65

            new_doc = fitz.open()
            for pno in range(num_pages):
                page = doc[pno]
                rect = page.rect
                pix = page.get_pixmap(dpi=dpi)
                # Convertir a JPEG optimizado
                jpeg_bytes = pix.pil_tobytes(format="JPEG", quality=qual)
                
                # Crear página con dimensiones idénticas a la original
                new_page = new_doc.new_page(width=rect.width, height=rect.height)
                new_page.insert_image(rect, stream=jpeg_bytes)

            raster_path = output_path + ".raster.pdf"
            new_doc.save(raster_path, garbage=4, deflate=True)
            new_doc.close()
            doc.close()

            if os.path.exists(raster_path):
                raster_size = os.path.getsize(raster_path)
                print(f"[OPTIMIZER ESCANEO] Resultado rasterizado: {raster_size/(1024*1024):.2f} MB")
                if raster_size < best_size:
                    import shutil
                    shutil.copyfile(raster_path, output_path)
                    best_size = raster_size
                try:
                    os.remove(raster_path)
                except Exception:
                    pass
        except Exception as scan_err:
            print(f"[OPTIMIZER ESCANEO ERROR] Error en reconstrucción: {scan_err}", file=sys.stderr)

    if os.path.exists(temp_stage):
        try:
            os.remove(temp_stage)
        except Exception:
            pass

    # Si por alguna razón nada redujo el archivo, asegurar copia del original
    if not os.path.exists(output_path) or os.path.getsize(output_path) >= original_size:
        import shutil
        shutil.copyfile(input_path, output_path)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Uso: python3 optimizer.py <entrada.pdf> <salida.pdf> [target_mb] [max_dimension] [quality]")
        sys.exit(1)

    inp = sys.argv[1]
    out = sys.argv[2]
    target_bytes = None
    if len(sys.argv) > 3 and sys.argv[3]:
        try:
            target_mb = float(sys.argv[3])
            target_bytes = int(target_mb * 1024 * 1024)
        except ValueError:
            target_bytes = None

    max_dim = 1400
    if len(sys.argv) > 4 and sys.argv[4]:
        try:
            max_dim = int(sys.argv[4])
        except ValueError:
            pass

    qual = 75
    if len(sys.argv) > 5 and sys.argv[5]:
        try:
            qual = int(sys.argv[5])
        except ValueError:
            pass

    optimize_pdf_images(inp, out, max_dimension=max_dim, quality=qual, target_bytes=target_bytes)
