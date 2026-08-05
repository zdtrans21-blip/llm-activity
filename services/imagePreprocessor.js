'use strict';

const sharp = require('sharp');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function hasPdftoppm() {
  try {
    const result = spawnSync('which', ['pdftoppm'], { stdio: 'pipe', timeout: 5000 });
    return result.status === 0 && result.stdout?.toString().trim().length > 0;
  } catch { return false; }
}

/**
 * Препроцессинг изображения для улучшения точности распознавания цифр LLM.
 * grayscale → normalize → sharpen → linear contrast → PNG без потерь.
 */
async function preprocessForOCR(inputBuffer) {
  return await sharp(inputBuffer)
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1.5, m1: 1.0, m2: 2.0 })
    .linear(1.3, -20)
    .png({ compressionLevel: 1 })
    .toBuffer();
}

/**
 * Конвертировать одну страницу PDF в высококачественный PNG.
 * Основной метод: pdftoppm (poppler-utils) 300 DPI.
 * Fallback: pdfjs-dist + @napi-rs/canvas (уже в зависимостях), scale=3.5 (~252 DPI).
 */
async function pdfPageToHighResPng(pdfBuffer, pageNumber = 1) {
  if (hasPdftoppm()) {
    console.log(`[imagePreprocessor] Используем pdftoppm (300 DPI) для стр. ${pageNumber}`);
    return await _convertWithPoppler(pdfBuffer, pageNumber);
  }
  console.warn(`[imagePreprocessor] pdftoppm не найден — pdfjs fallback (scale=3.5) для стр. ${pageNumber}`);
  return await _convertWithPdfjs(pdfBuffer, pageNumber);
}

async function _convertWithPoppler(pdfBuffer, pageNumber) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-ocr-'));
  const pdfPath = path.join(tmpDir, 'input.pdf');
  const outPrefix = path.join(tmpDir, 'page');
  try {
    fs.writeFileSync(pdfPath, pdfBuffer);
    const result = spawnSync('pdftoppm', [
      '-r', '300', '-png',
      '-f', String(pageNumber), '-l', String(pageNumber),
      '-aa', 'yes', pdfPath, outPrefix
    ], { stdio: 'pipe', timeout: 30000 });

    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`pdftoppm exit ${result.status}: ${result.stderr?.toString()}`);

    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.png')).sort();
    if (files.length === 0) throw new Error('pdftoppm не создал PNG файл');
    return fs.readFileSync(path.join(tmpDir, files[0]));
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function _convertWithPdfjs(pdfBuffer, pageNumber) {
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const { createCanvas } = require('@napi-rs/canvas');

  class NapiCanvasFactory {
    constructor(fn) { this._create = fn; }
    create(w, h) { const c = this._create(w, h); return { canvas: c, context: c.getContext('2d') }; }
    reset(cc, w, h) { cc.canvas.width = w; cc.canvas.height = h; }
    destroy(cc) { cc.canvas.width = 0; cc.canvas.height = 0; cc.canvas = null; cc.context = null; }
  }

  const canvasFactory = new NapiCanvasFactory(createCanvas);
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer), canvasFactory }).promise;
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 3.5 });
  const { canvas, context } = canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvasContext: context, viewport, canvasFactory }).promise;
  return canvas.toBuffer('image/png');
}

/**
 * Получить количество страниц в PDF.
 */
async function getPdfPageCount(pdfBuffer) {
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-info-'));
    const pdfPath = path.join(tmpDir, 'input.pdf');
    fs.writeFileSync(pdfPath, pdfBuffer);
    const result = spawnSync('pdfinfo', [pdfPath], { stdio: 'pipe', timeout: 10000 });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (!result.error && result.status === 0) {
      const match = result.stdout?.toString().match(/Pages:\s+(\d+)/);
      if (match) return parseInt(match[1]);
    }
  } catch {}
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(pdfBuffer);
    return data.numpages || 1;
  } catch {}
  return 1;
}

/**
 * Уменьшить PNG если превышает лимиты LLM API.
 * GPT-4o high detail: до 2048px по длинной стороне за тайл.
 * Claude: до 8000px, оптимально ~2800px.
 */
async function resizeIfNeeded(pngBuffer, maxSizeMb = 4, maxWidthPx = 2800) {
  const sizeMb = pngBuffer.length / 1024 / 1024;
  const meta = await sharp(pngBuffer).metadata();
  if (sizeMb <= maxSizeMb && (!meta.width || meta.width <= maxWidthPx)) return pngBuffer;
  console.log(`[imagePreprocessor] Ресайз: ${sizeMb.toFixed(1)}MB ${meta.width}px → max ${maxWidthPx}px`);
  return await sharp(pngBuffer)
    .resize({ width: maxWidthPx, withoutEnlargement: true })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

module.exports = { preprocessForOCR, pdfPageToHighResPng, getPdfPageCount, resizeIfNeeded };
