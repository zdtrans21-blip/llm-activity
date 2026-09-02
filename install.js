'use strict';

const axios = require('axios');

const BITRIX_DOMAIN = process.env.BITRIX_DOMAIN || 'aslz.bitrix24.ru';
const APP_URL = process.env.APP_URL || 'https://app-09458486e73d.vibecode.bitrix24.tech';

const ACTIVITY_CODE = 'llm_document_analyzer';
const HANDLER_URL = `${APP_URL}/handler`;

const ACTIVITY_PARAMS = {
  CODE: ACTIVITY_CODE,
  HANDLER: HANDLER_URL,
  AUTH_USER_ID: 1,
  NAME: { ru: '🤖 LLM: анализ документов' },
  DESCRIPTION: {
    ru: 'Скачивает документы из бизнес-процесса, извлекает текст, отправляет в выбранную LLM и возвращает результат в комментарий или переменную.'
  },
  PROPERTIES: {
    llm_provider: {
      Name: 'LLM провайдер',
      Description: 'openai | anthropic | openrouter | ollama | custom',
      Type: 'string',
      Required: 'Y',
      Default: 'openai'
    },
    llm_api_url: {
      Name: 'API URL провайдера',
      Description: 'Базовый URL API LLM. Например: https://api.openai.com/v1/chat/completions',
      Type: 'string',
      Required: 'Y',
      Default: 'https://api.openai.com/v1/chat/completions'
    },
    llm_model: {
      Name: 'Название модели',
      Description: 'Например: gpt-4o, claude-sonnet-4-6, mistral-large',
      Type: 'string',
      Required: 'Y',
      Default: 'gpt-4o'
    },
    llm_credential_user: {
      Name: 'Логин (для Basic Auth)',
      Description: 'Опционально, для Basic Auth провайдеров',
      Type: 'string',
      Required: 'N'
    },
    llm_credential_key: {
      Name: 'API-ключ LLM',
      Description: 'Секретный ключ для авторизации в LLM API',
      Type: 'string',
      Required: 'Y'
    },
    document_urls: {
      Name: 'Ссылки на документы',
      Description: 'ID файлов Диска или прямые URL. PDF, DOCX, TXT, PNG, JPG. Можно несколько.',
      Type: 'string',
      Required: 'N',
      Multiple: 'Y'
    },
    system_prompt: {
      Name: 'Системный промт (задание для LLM)',
      Description: 'Инструкция для LLM: что проверить, найти, сравнить в документах.',
      Type: 'string',
      Required: 'Y'
    },
    output_mode: {
      Name: 'Куда выводить результат',
      Description: 'comment — добавить комментарий к элементу | variable — записать в переменную БП',
      Type: 'string',
      Required: 'Y',
      Default: 'comment'
    },
    result_variable_name: {
      Name: 'Имя выходной переменной (если output_mode=variable)',
      Description: 'Имя переменной БП, куда записать ответ LLM',
      Type: 'string',
      Required: 'N'
    }
  },
  RETURN_PROPERTIES: {
    llm_result: {
      Name: 'Результат LLM',
      Description: 'Полный текст ответа LLM. Если задание предполагает разбивку на пункты, каждый пункт помечен эмодзи-статусом (✅/🟡/🛑) вместо служебных маркеров.',
      Type: 'string'
    },
    llm_status: {
      Name: 'Статус выполнения',
      Description: 'success | error',
      Type: 'string'
    },
    llm_error_message: {
      Name: 'Текст ошибки',
      Description: 'Заполняется если llm_status = error',
      Type: 'string'
    },
    llm_score: {
      Name: 'Числовая оценка LLM',
      Description: 'Число, которое LLM сама проставляет по итогам анализа согласно правилам из системного промта (например: -1 — критические ошибки, 0 — по умолчанию, 1 — ошибок нет). Диапазон и смысл значений задаются формулировкой системного промта. Если LLM не указала оценку — 0.',
      Type: 'double'
    },
    llm_issues: {
      Name: 'Замечания и ошибки',
      Description: 'Только пункты, которые LLM пометила как 🟡 (некритичное замечание) или 🛑 (критическая ошибка) — без пунктов "всё в порядке" (✅). Если LLM не нашла ни одного замечания — "✅ Ошибок и замечаний не обнаружено". Заполняется, только если задание в системном промте предполагает разбивку на отдельные пункты.',
      Type: 'string'
    }
  }
};

/**
 * Вызвать REST-метод Битрикс24 напрямую через токен локального приложения.
 *
 * ВАЖНО: SERVER_ENDPOINT из onAppInstall (https://oauth.bitrix24.tech/rest/)
 * — это центральный OAuth-шлюз Битрикс24, который понимает только методы
 * уровня приложения (app.info и т.п.) и возвращает ERROR_METHOD_NOT_FOUND
 * для портальных методов типа bizproc.activity.add. Для них нужен прямой
 * REST-адрес портала (client_endpoint), который мы знаем из BITRIX_DOMAIN.
 */
async function callBitrixRest(method, params, accessToken, restEndpoint) {
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
    throw new Error(`Битрикс24 REST [${method}]: ${data.error_description || data.error}`);
  }
  return data.result;
}

/**
 * Зарегистрировать активити в Битрикс24
 * @param {string} accessToken — AUTH_ID из onAppInstall (токен локального приложения)
 * @param {string} restEndpoint — SERVER_ENDPOINT из onAppInstall (база REST API)
 */
async function registerActivity(accessToken, restEndpoint) {
  console.log(`[install] Регистрирую активити "${ACTIVITY_CODE}"...`);
  console.log(`[install] Handler URL: ${HANDLER_URL}`);
  console.log(`[install] REST endpoint: ${restEndpoint || BITRIX_DOMAIN}`);

  // Сначала удалим старое активити если есть (игнорируем ошибку)
  try {
    await callBitrixRest('bizproc.activity.delete', { CODE: ACTIVITY_CODE }, accessToken, restEndpoint);
    console.log('[install] Старое активити удалено');
  } catch (e) {
    // Нормально — если не было зарегистрировано
  }

  const result = await callBitrixRest('bizproc.activity.add', ACTIVITY_PARAMS, accessToken, restEndpoint);
  console.log('[install] ✅ Активити успешно зарегистрировано:', JSON.stringify(result));
  return result;
}

module.exports = { registerActivity };
