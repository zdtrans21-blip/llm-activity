'use strict';

const { pdfPageToHighResPng, preprocessForOCR, getPdfPageCount, resizeIfNeeded } = require('./imagePreprocessor');

/**
 * Извлечение текста из файлов различных форматов
 */

/**
 * Определить тип файла по имени и content-type
 */
function detectFileType(filename, contentType) {
  const name = (filename || '').toLowerCase();
  const ct = (contentType || '').toLowerCase();

  if (name.endsWith('.pdf') || ct.includes('pdf')) return 'pdf';
  if (name.endsWith('.docx') || ct.includes('wordprocessingml.document') || ct.includes('docx')) return 'docx';
  if (name.endsWith('.doc') || ct.includes('msword')) return 'doc';
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm') || name.endsWith('.xls')
    || ct.includes('spreadsheetml') || ct.includes('ms-excel')) return 'excel';
  if (name.endsWith('.txt') || ct.includes('text/plain')) return 'txt';
  if (name.endsWith('.png') || ct.includes('png')) return 'image';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg') || ct.includes('jpeg')) return 'image';
  if (name.endsWith('.gif') || ct.includes('gif')) return 'image';
  if (name.endsWith('.webp') || ct.includes('webp')) return 'image';
  if (name.endsWith('.csv') || ct.includes('csv')) return 'txt';
  if (name.endsWith('.html') || ct.includes('html')) return 'html';
  return 'unknown';
}

/**
 * Извлечь текст из PDF-буфера
 * Возвращает также numpages — нужно, чтобы решить, является ли PDF
 * сканом (мало текста на много страниц) и нужен ли рендер в картинки.
 */
async function extractFromPdf(buffer) {
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    return { text: data.text || '', numPages: data.numpages || 1 };
  } catch (err) {
    throw new Error(`Ошибка при разборе PDF: ${err.message}`);
  }
}

/**
 * Рендеринг страниц PDF-скана в высококачественные PNG для Vision LLM.
 * Использует pdftoppm (300 DPI) если доступен, иначе pdfjs (scale=3.5 ≈ 252 DPI).
 * После рендеринга каждая страница проходит препроцессинг: grayscale + normalize +
 * sharpen + linear contrast — для устранения путаницы цифр (3↔9, 0↔8 и т.п.).
 */
async function renderHighResScannedPages(buffer, maxPages = 10) {
  const pageCount = await getPdfPageCount(buffer);
  const total = Math.min(pageCount, maxPages);
  console.log(`[extractor] PDF-скан: ${pageCount} стр., обрабатываем первые ${total}`);

  const images = [];
  for (let pageNum = 1; pageNum <= total; pageNum++) {
    try {
      const rawPng = await pdfPageToHighResPng(buffer, pageNum);
      const processedPng = await preprocessForOCR(rawPng);
      const finalPng = await resizeIfNeeded(processedPng);
      console.log(`[extractor] Стр. ${pageNum}/${total}: готово, ${(finalPng.length / 1024).toFixed(0)} KB`);
      images.push({ base64: finalPng.toString('base64'), mimeType: 'image/png', page: pageNum });
    } catch (err) {
      console.error(`[extractor] Ошибка рендера стр. ${pageNum}: ${err.message}`);
    }
  }
  return images;
}

/**
 * Извлечь текст из DOCX-буфера
 */
async function extractFromDocx(buffer) {
  try {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    if (result.messages && result.messages.length > 0) {
      console.warn('[extractor] Предупреждения mammoth:', result.messages.map(m => m.message).join('; '));
    }
    return result.value || '';
  } catch (err) {
    throw new Error(`Ошибка при разборе DOCX: ${err.message}`);
  }
}

/**
 * Извлечь текст из Excel-буфера (.xlsx, .xls, .xlsm).
 * Каждый лист конвертируется в CSV-подобный текст с заголовком "=== Лист: <имя> ===",
 * чтобы LLM видела табличные данные постранично, а не одной слипшейся строкой.
 */
async function extractFromExcel(buffer) {
  try {
    const XLSX = require('xlsx');
    const workbook = XLSX.read(buffer, { type: 'buffer' });

    const parts = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
      if (csv.trim()) {
        parts.push(`--- Лист: ${sheetName} ---\n${csv.trim()}`);
      }
    }

    return parts.join('\n\n');
  } catch (err) {
    throw new Error(`Ошибка при разборе Excel-файла: ${err.message}`);
  }
}

/**
 * Извлечь текст из TXT/CSV/HTML-буфера
 */
function extractFromText(buffer) {
  try {
    return buffer.toString('utf-8');
  } catch (err) {
    // Попробовать latin1 как fallback
    try {
      return buffer.toString('latin1');
    } catch {
      throw new Error(`Ошибка при чтении текстового файла: ${err.message}`);
    }
  }
}

/**
 * Конвертировать буфер изображения в base64 для Vision API
 */
function imageToBase64(buffer, contentType) {
  const mimeType = contentType && contentType.includes('/')
    ? contentType.split(';')[0].trim()
    : 'image/jpeg';
  return {
    isImage: true,
    base64: buffer.toString('base64'),
    mimeType
  };
}

/**
 * Основная функция извлечения текста из файла
 * @param {Buffer} buffer - бинарные данные файла
 * @param {string} filename - имя файла
 * @param {string} contentType - MIME-тип
 * @returns {Promise<{text: string, isImage: boolean, base64?: string, mimeType?: string}>}
 */
async function extractText(buffer, filename, contentType) {
  const fileType = detectFileType(filename, contentType);

  console.log(`[extractor] Обработка файла: ${filename} (тип: ${fileType}, размер: ${buffer.length} байт)`);

  switch (fileType) {
    case 'pdf': {
      const { text, numPages } = await extractFromPdf(buffer);
      console.log(`[extractor] PDF извлечено ${text.length} символов (страниц: ${numPages})`);

      // Меньше ~15 символов текста на страницу — почти наверняка скан без
      // текстового слоя. pdf-parse тут бессилен — рендерим страницы в
      // картинки и отдаём LLM через Vision.
      const avgCharsPerPage = text.trim().length / Math.max(numPages, 1);
      if (avgCharsPerPage < 15) {
        console.log(`[extractor] Похоже на сканированный PDF (${avgCharsPerPage.toFixed(1)} симв/стр) — рендерю страницы в изображения для Vision`);
        try {
          const images = await renderHighResScannedPages(buffer);
          console.log(`[extractor] Отрендерено ${images.length} страниц(ы) PDF в изображения`);
          return { text, isImage: false, images };
        } catch (renderErr) {
          console.error(`[extractor] Не удалось отрендерить PDF в изображения: ${renderErr.message}`);
          return {
            text: text || `[PDF "${filename}" — сканированный документ без текстового слоя, рендер в изображение не удался: ${renderErr.message}]`,
            isImage: false
          };
        }
      }

      return { text, isImage: false };
    }

    case 'docx': {
      const text = await extractFromDocx(buffer);
      console.log(`[extractor] DOCX извлечено ${text.length} символов`);
      return { text, isImage: false };
    }

    case 'excel': {
      const text = await extractFromExcel(buffer);
      console.log(`[extractor] Excel извлечено ${text.length} символов`);
      return { text, isImage: false };
    }

    case 'doc': {
      // .doc (старый формат) — возвращаем предупреждение
      console.warn(`[extractor] Файл ${filename}: формат .doc (старый Word) не поддерживается, пропускаем`);
      return {
        text: `[Файл "${filename}" имеет формат .doc (старый Microsoft Word). Пожалуйста, конвертируйте в .docx или .pdf для анализа.]`,
        isImage: false
      };
    }

    case 'txt':
    case 'html': {
      const text = extractFromText(buffer);
      console.log(`[extractor] Текст извлечён: ${text.length} символов`);
      return { text, isImage: false };
    }

    case 'image': {
      console.log(`[extractor] Файл ${filename} является изображением — передаём как base64`);
      const imgData = imageToBase64(buffer, contentType);
      return { text: '', isImage: true, base64: imgData.base64, mimeType: imgData.mimeType };
    }

    default: {
      console.warn(`[extractor] Неизвестный тип файла: ${filename} (${contentType})`);
      return {
        text: `[Файл "${filename}" имеет неподдерживаемый формат. Текст не извлечён.]`,
        isImage: false
      };
    }
  }
}

module.exports = { extractText, detectFileType };
