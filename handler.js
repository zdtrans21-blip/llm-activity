'use strict';

require('dotenv').config();

const bitrix = require('./services/bitrix');
const extractor = require('./services/extractor');
const llm = require('./services/llm');

// Скрытая инструкция, которая добавляется к системному промту пользователя,
// чтобы LLM всегда проставляла числовую оценку в распознаваемом формате.
const SCORE_INSTRUCTION = '\n\n---\nВ самом конце ответа добавь отдельной новой строкой маркер строго в формате [[SCORE: число]], ' +
  'где число — это числовая оценка результата анализа согласно правилам, указанным выше в задании ' +
  '(целое или дробное, может быть отрицательным). Если в задании выше не описано, как именно выставлять оценку, укажи [[SCORE: 0]]. ' +
  'Этот маркер обязателен и не показывается пользователю напрямую.';

const SCORE_MARKER_RE = /\[\[\s*SCORE\s*:\s*(-?\d+(?:[.,]\d+)?)\s*\]\]/gi;

/**
 * Извлечь числовую оценку LLM из её ответа и вернуть очищенный текст.
 * Если маркер не найден или не парсится — оценка по умолчанию 0.
 */
function extractScore(llmResult) {
  if (!llmResult) return { score: 0, cleanText: '' };
  const matches = [...llmResult.matchAll(SCORE_MARKER_RE)];
  if (matches.length === 0) {
    console.warn('[handler] Маркер [[SCORE: ...]] не найден в ответе LLM — использую значение по умолчанию 0');
    return { score: 0, cleanText: llmResult };
  }

  const last = matches[matches.length - 1];
  const score = parseFloat(last[1].replace(',', '.'));
  const cleanText = llmResult.replace(SCORE_MARKER_RE, '').trim();

  console.log(`[handler] Извлечена числовая оценка LLM: ${score}`);
  return { score: Number.isFinite(score) ? score : 0, cleanText };
}

// Скрытая инструкция про поэтапную разметку пунктов — та же идея, что
// SCORE_INSTRUCTION, но по каждому отдельному пункту/замечанию, а не по
// ответу целиком. Структура ответа не фиксирована (зависит от системного
// промта пользователя), поэтому просим LLM саму размечать то, что она и так
// перечисляет построчно.
const ITEM_MARKER_INSTRUCTION = '\n\n---\nЕсли задание выше предполагает перечисление отдельных пунктов проверки, ' +
  'замечаний, расхождений или ошибок — оформи каждый такой пункт отдельной строкой и в начале строки поставь ' +
  'один из трёх маркеров строго в двойных квадратных скобках: [[OK]] — пункт в порядке, замечаний нет; ' +
  '[[WARN]] — незначительное, некритичное замечание; [[ERROR]] — критическая ошибка или существенное расхождение. ' +
  'Если задание не предполагает разбивку на отдельные пункты (например, просят просто написать резюме или ответить ' +
  'одним предложением) — маркеры не используй вообще.';

const SEVERITY_EMOJI = { OK: '✅', WARN: '🟡', ERROR: '🛑' };
const SEVERITY_LINE_RE = /^[ \t]*\[\[\s*(OK|WARN|ERROR)\s*\]\][ \t]*(.*)$/;

/**
 * Заменяет маркеры [[OK]]/[[WARN]]/[[ERROR]] в начале строк на эмодзи и
 * отдельно собирает строки с замечаниями/ошибками (WARN и ERROR) — для
 * вывода в отдельную переменную БП.
 */
function applySeverityMarkers(text) {
  if (!text) return { formattedText: text || '', issues: [] };
  const issues = [];
  const lines = text.split('\n').map((line) => {
    const m = line.match(SEVERITY_LINE_RE);
    if (!m) return line;
    const [, level, rest] = m;
    const formatted = `${SEVERITY_EMOJI[level]} ${rest}`.trimEnd();
    if (level === 'WARN' || level === 'ERROR') issues.push(formatted);
    return formatted;
  });
  return { formattedText: lines.join('\n'), issues };
}

/**
 * Парсить document_id из формата Битрикс24
 * Примеры: ["LISTS", "73", "73"], ["CRM", "DEAL", "12"], ["bizproc", "0", "XXX"]
 */
function parseDocumentId(documentId) {
  if (!documentId) return { entityType: null, entityId: null };

  const parts = Array.isArray(documentId) ? documentId : [documentId];

  if (parts.length >= 3) {
    const module = parts[0];
    const entityType = parts[1];
    const entityId = parts[2];

    // CRM сущности
    if (module === 'crm') {
      // Смарт-процессы (SPA) и пользовательские типы: ID элемента приходит в формате
      // DYNAMIC_<entityTypeId>_<itemId> — реальный entityTypeId лежит прямо в этой строке,
      // а не в parts[1] (там — полное имя PHP-класса документа, не годится для REST).
      const dynamicMatch = String(entityId).match(/^DYNAMIC_(\d+)_(\d+)$/);
      if (dynamicMatch) {
        return {
          entityType: `dynamic_${dynamicMatch[1]}`,
          entityTypeId: parseInt(dynamicMatch[1], 10),
          entityId: parseInt(dynamicMatch[2], 10)
        };
      }

      const typeMap = {
        'DEAL': { typeId: 2, name: 'deal' },
        'LEAD': { typeId: 1, name: 'lead' },
        'CONTACT': { typeId: 3, name: 'contact' },
        'COMPANY': { typeId: 4, name: 'company' },
        'QUOTE': { typeId: 7, name: 'quote' },
        'INVOICE': { typeId: 31, name: 'invoice' }
      };
      const mapped = typeMap[entityType.toUpperCase()];
      return {
        entityType: mapped ? mapped.name : entityType.toLowerCase(),
        entityTypeId: mapped ? mapped.typeId : null,
        entityId: parseInt(entityId) || entityId
      };
    }
  }

  return { entityType: String(parts[0] || ''), entityId: String(parts[parts.length - 1] || '') };
}

/**
 * Нормализовать ссылки на документы
 * Может быть строка, массив, или JSON-строка с массивом
 */
function normalizeDocumentUrls(rawUrls) {
  if (!rawUrls) return [];

  if (typeof rawUrls === 'string') {
    // Попробовать разобрать как JSON
    if (rawUrls.trim().startsWith('[')) {
      try {
        return JSON.parse(rawUrls);
      } catch { /* ignored */ }
    }
    // Разбить по переносам строки или запятым
    return rawUrls.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
  }

  if (Array.isArray(rawUrls)) {
    return rawUrls.filter(Boolean);
  }

  return [];
}

/**
 * Похоже ли значение на ссылку/идентификатор файла (а не на произвольный текст)?
 * Если БП передаёт в document_urls обычное текстовое поле (например, выписку
 * из договора), его нужно подать в LLM как текст напрямую, а не пытаться
 * "скачать" — иначе значение молча потеряется.
 */
function looksLikeFileReference(value) {
  const v = value.trim();
  return v.startsWith('disk://') || /^\d+$/.test(v) || v.startsWith('http://') || v.startsWith('https://');
}

/**
 * Скачать документ по URL или ID
 * @param {object} document - { entityTypeId, entityId } текущего документа БП — нужны как
 *   fallback, если ID файла не найден через disk.file.get (см. downloadFile в services/bitrix.js)
 */
async function fetchDocument(urlOrId, accessToken, restEndpoint, document) {
  // Файл Битрикс24 по ID (disk://)
  if (urlOrId.startsWith('disk://')) {
    const fileId = urlOrId.replace('disk://', '').trim();
    console.log(`[handler] Скачивание файла из Disk по ID: ${fileId}`);
    return await bitrix.downloadFile(fileId, accessToken, restEndpoint, document);
  }

  // Числовой ID — прямое обращение к disk.file.get (с fallback на поля CRM-элемента)
  if (/^\d+$/.test(urlOrId.trim())) {
    console.log(`[handler] Скачивание файла из Disk по числовому ID: ${urlOrId}`);
    return await bitrix.downloadFile(urlOrId.trim(), accessToken, restEndpoint, document);
  }

  // URL
  if (urlOrId.startsWith('http://') || urlOrId.startsWith('https://')) {
    console.log(`[handler] Скачивание файла по URL: ${urlOrId.substring(0, 100)}...`);
    return await bitrix.downloadFileByUrl(urlOrId, accessToken);
  }

  // Может быть внутренний путь или переменная — пропускаем
  console.warn(`[handler] Непонятный формат ссылки на документ: ${urlOrId} — пропускаем`);
  return null;
}

/**
 * Основной обработчик активити
 */
async function process(body) {
  // ════════════════════════════════════════════════════
  // Логируем входящие данные
  // ════════════════════════════════════════════════════
  const eventToken = body.event_token || body.EVENT_TOKEN;
  const documentId = body.document_id || body.DOCUMENT_ID;
  const propertiesRaw = body.properties || body.PROPERTIES || {};
  const auth = body.auth || body.AUTH || {};
  const accessToken = auth.access_token || auth.ACCESS_TOKEN || null;
  const restEndpoint = auth.server_endpoint || auth.client_endpoint
    || auth.SERVER_ENDPOINT || auth.CLIENT_ENDPOINT || null;

  console.log('\n══════════════════════════════════════════');
  console.log('[handler] Pipeline версия: v2-highres-preprocessed');
  console.log('[handler] ВХОДЯЩИЙ ЗАПРОС ОТ БИТРИКС24');
  console.log(`  event_token: ${eventToken}`);
  console.log(`  document_id: ${JSON.stringify(documentId)}`);
  console.log(`  properties: ${JSON.stringify(propertiesRaw).substring(0, 2000)}`);
  console.log('══════════════════════════════════════════\n');

  // Функция безопасного завершения активити с ошибкой
  async function failActivity(errorMessage) {
    console.error(`[handler] ❌ Ошибка: ${errorMessage}`);
    if (eventToken) {
      try {
        await bitrix.completeBizprocActivity(
          eventToken,
          { llm_result: '', llm_status: 'error', llm_error_message: errorMessage, llm_score: 0, llm_issues: `🛑 ${errorMessage}` },
          '',
          accessToken,
          restEndpoint
        );
      } catch (err) {
        console.error('[handler] Не удалось отправить ошибку в Битрикс24:', err.message);
      }
    }
  }

  if (!eventToken) {
    console.error('[handler] event_token отсутствует — невозможно завершить активити');
    return;
  }

  try {
    // Нормализуем свойства (Битрикс24 может передавать их в разных регистрах)
    const props = {};
    for (const key of Object.keys(propertiesRaw)) {
      props[key.toLowerCase()] = propertiesRaw[key];
    }

    const provider = props.llm_provider || 'openai';
    const apiUrl = props.llm_api_url || 'https://api.openai.com/v1/chat/completions';
    const model = props.llm_model || 'gpt-4o';
    const credentialUser = props.llm_credential_user || '';
    const credentialKey = props.llm_credential_key || '';
    const systemPrompt = props.system_prompt || 'Проанализируй документ и дай краткое резюме.';
    const outputMode = props.output_mode || 'comment';
    const resultVariableName = props.result_variable_name || '';
    const rawDocumentUrls = props.document_urls;

    if (!credentialKey || !credentialKey.trim()) {
      return await failActivity('API-ключ LLM (llm_credential_key) не задан в параметрах активити.');
    }

    // Документ БП (CRM/SPA-элемент) — нужен и для скачивания файлов из его полей,
    // и для добавления комментария на ШАГ 5. Вычисляем один раз.
    const { entityType, entityTypeId, entityId } = parseDocumentId(documentId);

    // ════════════════════════════════════════════════════
    // ШАГ 1: Получаем ссылки на документы
    // ════════════════════════════════════════════════════
    const documentUrls = normalizeDocumentUrls(rawDocumentUrls);
    console.log(`[handler] ШАГ 1: найдено ${documentUrls.length} ссылок на документы`);

    // ════════════════════════════════════════════════════
    // ШАГ 2: Скачиваем и извлекаем текст из документов
    // ════════════════════════════════════════════════════
    const documents = [];   // { filename, text }
    const images = [];      // { filename, base64, mimeType }

    let plainTextCounter = 0;

    for (const rawItem of documentUrls) {
      const item = String(rawItem);

      // Значение само является текстом (не ссылкой/ID) — добавляем как есть,
      // без попытки "скачать" несуществующий файл.
      if (!looksLikeFileReference(item)) {
        plainTextCounter += 1;
        documents.push({ filename: `Текстовое поле ${plainTextCounter}`, text: item });
        console.log(`[handler] Текстовое поле ${plainTextCounter} добавлено напрямую (${item.length} символов)`);
        continue;
      }

      try {
        const fileData = await fetchDocument(item, accessToken, restEndpoint, { entityTypeId, entityId });
        if (!fileData) continue;

        const extracted = await extractor.extractText(fileData.buffer, fileData.filename, fileData.contentType);

        if (extracted.isImage) {
          images.push({ filename: fileData.filename, base64: extracted.base64, mimeType: extracted.mimeType });
          console.log(`[handler] Изображение подготовлено: ${fileData.filename}`);
        } else if (extracted.images && extracted.images.length) {
          // Сканированный PDF без текстового слоя
          // GigaChat лучше читает оригинальный PDF напрямую, чем конвертированный PNG
          if (provider === 'gigachat' && fileData.contentType && fileData.contentType.includes('pdf')) {
            images.push({
              filename: fileData.filename,
              base64: fileData.buffer.toString('base64'),
              mimeType: 'application/pdf'
            });
            console.log(`[handler] GigaChat: передаём оригинальный PDF "${fileData.filename}" (${fileData.buffer.length} байт)`);
          } else {
            for (const pageImg of extracted.images) {
              images.push({
                filename: `${fileData.filename} (стр. ${pageImg.page})`,
                base64: pageImg.base64,
                mimeType: pageImg.mimeType
              });
            }
            console.log(`[handler] PDF "${fileData.filename}" передан как ${extracted.images.length} изображени(й) (Vision)`);
          }
          if (extracted.text && extracted.text.trim()) {
            documents.push({ filename: fileData.filename, text: extracted.text });
          }
        } else {
          documents.push({ filename: fileData.filename, text: extracted.text });
          console.log(`[handler] Текст извлечён из: ${fileData.filename} (${extracted.text.length} символов)`);
        }
      } catch (docErr) {
        console.error(`[handler] Ошибка при обработке файла ${item}: ${docErr.message}`);
        // Продолжаем, не останавливаем весь процесс из-за одного файла
        documents.push({
          filename: item,
          text: `[Ошибка загрузки файла: ${docErr.message}]`
        });
      }
    }

    console.log(`[handler] ШАГ 2: подготовлено ${documents.length} текстов и ${images.length} изображений`);

    // ════════════════════════════════════════════════════
    // ШАГ 3–4: Отправляем в LLM и получаем ответ
    // ════════════════════════════════════════════════════
    console.log(`[handler] ШАГ 3: отправка в ${provider} (${model})...`);

    const rawLlmResult = await llm.sendToLlm({
      provider,
      apiUrl,
      model,
      credentialUser,
      credentialKey,
      systemPrompt: systemPrompt + SCORE_INSTRUCTION + ITEM_MARKER_INSTRUCTION,
      documents,
      images
    });

    console.log(`[handler] ШАГ 4: ответ LLM получен (${rawLlmResult.length} символов)`);

    const { score: llmScore, cleanText: scoredText } = extractScore(rawLlmResult);
    const { formattedText: llmResult, issues } = applySeverityMarkers(scoredText);
    const llmIssues = issues.length > 0 ? issues.join('\n') : '✅ Ошибок и замечаний не обнаружено';
    console.log(`[handler] Найдено пунктов с замечаниями/ошибками: ${issues.length}`);

    // ════════════════════════════════════════════════════
    // ШАГ 5: Выводим результат
    // ════════════════════════════════════════════════════
    if (outputMode === 'comment') {
      // Добавляем комментарий к CRM-элементу
      if (entityId && entityType) {
        try {
          await bitrix.addCrmComment(entityTypeId || entityType, entityId, llmResult, accessToken, restEndpoint);
          console.log(`[handler] ШАГ 5: комментарий добавлен к ${entityType} ID=${entityId}`);
        } catch (commentErr) {
          // Не фатальная ошибка — результат всё равно вернём через return_values
          console.warn(`[handler] Не удалось добавить комментарий: ${commentErr.message}`);
        }
      } else {
        console.warn(`[handler] ШАГ 5: не удалось определить CRM-сущность для комментария (documentId: ${JSON.stringify(documentId)})`);
      }
    } else if (outputMode === 'variable') {
      // Для записи в переменную БП — передаём через return_values с кастомным именем
      if (resultVariableName) {
        console.log(`[handler] ШАГ 5: результат будет записан в переменную БП: ${resultVariableName}`);
      }
    }

    // ════════════════════════════════════════════════════
    // ШАГ 6: Завершаем активити
    // ════════════════════════════════════════════════════
    const returnValues = {
      llm_result: llmResult,
      llm_status: 'success',
      llm_error_message: '',
      llm_score: llmScore,
      llm_issues: llmIssues
    };

    // Если нужно записать в переменную БП — добавляем с кастомным ключом
    if (outputMode === 'variable' && resultVariableName) {
      returnValues[resultVariableName] = llmResult;
    }

    await bitrix.completeBizprocActivity(
      eventToken,
      returnValues,
      'LLM анализ завершён успешно',
      accessToken,
      restEndpoint
    );

    console.log('[handler] ✅ Активити завершено успешно');

  } catch (err) {
    console.error('[handler] Критическая ошибка:', err.message);
    if (err.stack) console.error(err.stack);
    await failActivity(err.message);
  }
}

module.exports = { process };
