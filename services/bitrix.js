'use strict';

const axios = require('axios');

const BITRIX_DOMAIN = process.env.BITRIX_DOMAIN || 'aslz.bitrix24.ru';

/**
 * Вызов REST-метода Битрикс24 напрямую (без посредников).
 * @param {string} method - метод REST API (например, crm.timeline.comment.add)
 * @param {object} params - параметры метода
 * @param {string} accessToken - токен авторизации (access_token / AUTH_ID)
 * @param {string} [restEndpoint] - база REST API (auth.server_endpoint из запроса БП)
 */
async function callBitrix(method, params = {}, accessToken, restEndpoint) {
  // oauth.bitrix24.tech — центральный OAuth-шлюз, понимает только app.*-методы.
  // Для портальных методов (bizproc.*, crm.*, disk.*) нужен прямой адрес портала.
  const isOAuthGateway = restEndpoint && restEndpoint.includes('oauth.bitrix24.tech');
  const endpoint = (!restEndpoint || isOAuthGateway)
    ? `https://${BITRIX_DOMAIN}/rest/`
    : restEndpoint;
  const url = `${endpoint}${method}.json`;

  const response = await axios.post(
    url,
    { ...params, auth: accessToken },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
  );

  const data = response.data;
  if (data.error) {
    throw new Error(`Битрикс24 [${method}]: ${data.error_description || data.error}`);
  }
  return data.result;
}

/**
 * Добавить auth-токен к URL как query-параметр (если его там ещё нет)
 */
function withAuthParam(url, accessToken) {
  if (!url || !accessToken) return url;
  if (url.includes('auth=')) return url;
  return url.includes('?') ? `${url}&auth=${accessToken}` : `${url}?auth=${accessToken}`;
}

/**
 * Скачать произвольный файл по уже готовой ссылке.
 * Если сервер не отдаёт бинарные данные (Content-Type text/html и т.п.) —
 * это явный признак того, что ссылка требует авторизации/сессии,
 * а не реального файла на этой ссылке нет.
 */
async function downloadFromUrl(url, fallbackFilename) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000,
    maxContentLength: 100 * 1024 * 1024
  });

  let filename = fallbackFilename;
  const cd = response.headers['content-disposition'];
  if (cd) {
    const m = cd.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    if (m) filename = decodeURIComponent(m[1].replace(/['"]/g, ''));
  }

  const contentType = response.headers['content-type'] || 'application/octet-stream';

  // Если вместо файла пришла HTML-страница (логин/ошибка/превью) — это не файл.
  // Бросаем понятную ошибку вместо того, чтобы молча "скормить" HTML в LLM.
  if (contentType.includes('text/html') || contentType.includes('text/plain')) {
    const preview = Buffer.from(response.data).toString('utf-8').slice(0, 300);
    throw new Error(
      `По ссылке вернулась страница (Content-Type: ${contentType}), а не бинарный файл. ` +
      `Похоже, ссылка требует авторизации в браузере и не подходит для серверного скачивания. ` +
      `Начало ответа: ${preview.replace(/\s+/g, ' ')}`
    );
  }

  return {
    buffer: Buffer.from(response.data),
    filename: filename || 'document',
    contentType
  };
}

/**
 * Найти файл по ID среди полей CRM/SPA-элемента (crm.item.get).
 *
 * Поля типа "Файл" в карточках CRM/SPA возвращают значения вида
 * { id, url, urlMachine, name, ... } — это НЕ disk.file ID и НЕ disk.attachedObject ID
 * (оба метода отвечают ERROR_NOT_FOUND на такой id, проверено живым запросом).
 * Единственный рабочий способ скачать такой файл — пройти по полям элемента
 * и забрать готовую ссылку urlMachine/url, добавив к ней auth-токен (она требует
 * авторизации точно так же, как обычная ссылка скачивания с Диска).
 */
async function findCrmItemFile(fileId, entityTypeId, entityId, accessToken, restEndpoint) {
  if (!entityTypeId || !entityId) return null;

  const result = await callBitrix('crm.item.get', { entityTypeId, id: entityId }, accessToken, restEndpoint);
  const item = result && result.item;
  if (!item) return null;

  for (const value of Object.values(item)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (entry && typeof entry === 'object' && String(entry.id) === String(fileId)) {
        return entry;
      }
    }
  }
  return null;
}

/**
 * Скачать файл из Битрикс24 по fileId.
 * @param {object} [document] - { entityTypeId, entityId } документа БП — используется как
 *   fallback, когда fileId не находится через disk.file.get (см. findCrmItemFile выше)
 */
async function downloadFile(fileId, accessToken, restEndpoint, document = {}) {
  try {
    const fileMeta = await callBitrix('disk.file.get', { id: fileId }, accessToken, restEndpoint);
    const downloadUrl = fileMeta.DOWNLOAD_URL || fileMeta.downloadUrl;
    if (!downloadUrl) {
      throw new Error(`disk.file.get вернул файл без ссылки на скачивание (ID=${fileId})`);
    }
    return await downloadFromUrl(withAuthParam(downloadUrl, accessToken), fileMeta.NAME || `file_${fileId}`);
  } catch (diskErr) {
    console.warn(`[bitrix] disk.file.get не нашёл ID=${fileId} (${diskErr.message}) — пробую найти как файл в полях CRM-элемента`);
  }

  const crmFile = await findCrmItemFile(fileId, document.entityTypeId, document.entityId, accessToken, restEndpoint);
  if (!crmFile) {
    throw new Error(`Файл с ID=${fileId} не найден ни на Диске, ни в полях CRM-элемента`);
  }

  console.log(`[bitrix] Найден файл в полях CRM-элемента: ${JSON.stringify(crmFile).substring(0, 300)}`);

  const rawUrl = crmFile.urlMachine || crmFile.url || crmFile.downloadUrl;
  if (!rawUrl) {
    throw new Error(`Файл с ID=${fileId} найден в полях CRM-элемента, но не содержит ссылки (поля: ${Object.keys(crmFile).join(', ')})`);
  }

  return await downloadFromUrl(withAuthParam(rawUrl, accessToken), crmFile.name || crmFile.NAME || `file_${fileId}`);
}

/**
 * Резолвить публичную share-ссылку Яндекс.Диска в прямую download-ссылку
 * через официальный Public API. Прямой GET по share-ссылке (disk.yandex.ru/i|d/...)
 * отдаёт анти-бот страницу "Вы не робот?" вместо файла — это не баг с нашей
 * стороны, а защита Яндекса от автоматического скачивания.
 */
async function resolveYandexDiskUrl(shareUrl) {
  const apiUrl = `https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=${encodeURIComponent(shareUrl)}`;
  const response = await axios.get(apiUrl, { timeout: 15000 });
  const href = response.data && response.data.href;
  if (!href) {
    throw new Error('Яндекс.Диск Public API не вернул прямую ссылку на скачивание');
  }
  return href;
}

function isYandexDiskLink(url) {
  return url.includes('disk.yandex.') || url.includes('yadi.sk');
}

/**
 * Скачать файл по прямой URL
 */
async function downloadFileByUrl(url, accessToken) {
  const parts = url.split('?')[0].split('/');
  const fallbackFilename = decodeURIComponent(parts[parts.length - 1]) || 'document';

  if (isYandexDiskLink(url)) {
    console.log(`[bitrix] Ссылка Яндекс.Диска — резолвлю через Public API: ${url}`);
    const directUrl = await resolveYandexDiskUrl(url);
    return await downloadFromUrl(directUrl, fallbackFilename);
  }

  const fetchUrl = (accessToken && (url.includes('bitrix24') || url.includes(BITRIX_DOMAIN)))
    ? withAuthParam(url, accessToken)
    : url;

  return await downloadFromUrl(fetchUrl, fallbackFilename);
}

/**
 * Добавить комментарий к CRM-элементу (таймлайн)
 */
async function addCrmComment(entityType, entityId, comment, accessToken, restEndpoint) {
  return await callBitrix('crm.timeline.comment.add', {
    fields: {
      ENTITY_ID: entityId,
      ENTITY_TYPE: entityType,
      COMMENT: comment
    }
  }, accessToken, restEndpoint);
}

/**
 * Завершить активити бизнес-процесса
 */
async function completeBizprocActivity(eventToken, returnValues = {}, logMessage = '', accessToken, restEndpoint) {
  const params = {
    event_token: eventToken,
    return_values: returnValues
  };
  if (logMessage) params.log_message = logMessage;

  return await callBitrix('bizproc.event.send', params, accessToken, restEndpoint);
}

module.exports = {
  callBitrix,
  downloadFile,
  downloadFileByUrl,
  addCrmComment,
  completeBizprocActivity
};
