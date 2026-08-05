'use strict';

const axios = require('axios');
const https = require('https');
const crypto = require('crypto');

const LLM_TIMEOUT_MS = 120000; // 120 секунд

// ─── GigaChat OAuth ───────────────────────────────────────────────────────────
// Сбер использует собственный CA — отключаем проверку SSL для всех GigaChat-хостов.
// expires_at у GigaChat приходит в миллисекундах (не секундах).
const gigachatSslAgent = new https.Agent({ rejectUnauthorized: false });

let _gigachatTokenCache = { token: null, expiresAtMs: 0 };

async function getGigachatToken(authKey) {
  const nowMs = Date.now();
  if (_gigachatTokenCache.token && _gigachatTokenCache.expiresAtMs > nowMs + 60000) {
    return _gigachatTokenCache.token;
  }
  console.log('[llm] GigaChat: получение нового токена доступа...');
  const response = await axios.post(
    'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
    'scope=GIGACHAT_API_PERS',
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'RqUID': crypto.randomUUID(),
        'Authorization': `Basic ${authKey}`
      },
      httpsAgent: gigachatSslAgent,
      timeout: 15000
    }
  );
  const expiresAtMs = response.data.expires_at; // уже в миллисекундах
  _gigachatTokenCache = { token: response.data.access_token, expiresAtMs };
  console.log('[llm] GigaChat: токен получен, действителен до', new Date(expiresAtMs).toISOString());
  return _gigachatTokenCache.token;
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Вырезать блоки рассуждений thinking-моделей из ответа.
 * Модели типа gpt-5.5-thinking вставляют цепочку мыслей в теги <think>...</think>
 * прямо в content — инструкции в промте они игнорируют по архитектурным причинам.
 */
function stripThinkingBlocks(text) {
  if (!text) return text;
  const before = text.length;
  const result = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/`{3}thinking[\s\S]*?`{3}/gi, '')
    .trim();
  if (result.length < before) {
    console.log(`[llm] Удалены блоки рассуждений thinking-модели: ${before - result.length} символов`);
  }
  return result;
}



/**
 * Формирует заголовки авторизации для LLM API
 */
function buildAuthHeaders(provider, credentialUser, credentialKey) {
  if (credentialUser && credentialUser.trim()) {
    // Basic Auth
    const encoded = Buffer.from(`${credentialUser}:${credentialKey}`).toString('base64');
    return { 'Authorization': `Basic ${encoded}` };
  }

  if (provider === 'anthropic') {
    return {
      'x-api-key': credentialKey,
      'anthropic-version': '2023-06-01'
    };
  }

  // Bearer-токен (OpenAI, OpenRouter, Ollama, custom)
  return { 'Authorization': `Bearer ${credentialKey}` };
}

/**
 * Отправить запрос к LLM в OpenAI-совместимом формате
 * (openai, openrouter, ollama, custom)
 */
async function callOpenAICompatible(params) {
  const { apiUrl, model, systemPrompt, userMessage, credentialUser, credentialKey, images, provider } = params;

  // GigaChat требует OAuth-токен вместо прямого API-ключа
  let effectiveKey = credentialKey;
  if (provider === 'gigachat') {
    effectiveKey = await getGigachatToken(credentialKey);
  }

  const authHeaders = buildAuthHeaders('openai', credentialUser, effectiveKey);

  // Формируем user content
  let userContent;
  if (images && images.length > 0) {
    // Vision: смешанный контент (текст + изображения)
    userContent = [
      { type: 'text', text: userMessage }
    ];
    images.forEach((img, idx) => {
      if (!img.base64) return; // пропускаем страницы с ошибкой конвертации
      userContent.push({ type: 'text', text: `=== ${img.filename || `Изображение ${idx + 1}`} ===` });
      userContent.push({
        type: 'image_url',
        image_url: {
          url: `data:${img.mimeType};base64,${img.base64}`,
          detail: 'high'  // высокое качество (low/high/auto — стандарт OpenAI)
        }
      });
    });
  } else {
    userContent = userMessage;
  }

  const requestBody = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    max_tokens: 4096
  };

  console.log(`[llm] Отправка запроса к OpenAI-совместимому API: ${apiUrl}, модель: ${model}`);

  try {
    const requestConfig = {
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      timeout: LLM_TIMEOUT_MS
    };
    // GigaChat использует сберовский CA — нужен тот же агент что и для токена
    if (provider === 'gigachat') requestConfig.httpsAgent = gigachatSslAgent;

  const response = await axios.post(apiUrl, requestBody, requestConfig);

    const result = response.data;

    // Извлекаем текст ответа
    if (result.choices && result.choices[0] && result.choices[0].message) {
      const msg = result.choices[0].message;
      // Thinking-модели (gpt-5.5-thinking и др.) могут вернуть content: null
      // с реальным текстом в reasoning_content или аналогичном поле
      const content = msg.content;
      if (content !== null && content !== undefined) {
        const text = typeof content === 'string' ? content : JSON.stringify(content);
        return stripThinkingBlocks(text);
      }
      const fallback = msg.reasoning_content || msg.reasoning || msg.thinking;
      if (fallback) {
        console.warn('[llm] content: null — используем reasoning_content как ответ');
        return typeof fallback === 'string' ? fallback : JSON.stringify(fallback);
      }
      throw new Error('Модель вернула пустой ответ (content: null и нет reasoning_content)');
    }

    throw new Error(`Неожиданный формат ответа от LLM: ${JSON.stringify(result).substring(0, 500)}`);
  } catch (err) {
    if (err.response) {
      const errData = err.response.data;
      const errMsg = errData?.error?.message || errData?.message || JSON.stringify(errData).substring(0, 300);
      throw new Error(`LLM API ошибка (${err.response.status}): ${errMsg}`);
    }
    if (err.code === 'ECONNABORTED') {
      throw new Error(`Превышен таймаут ожидания ответа от LLM (${LLM_TIMEOUT_MS / 1000} сек). Попробуйте более быструю модель или уменьшите объём документов.`);
    }
    throw err;
  }
}

/**
 * Отправить запрос к Anthropic Messages API
 */
async function callAnthropic(params) {
  const { model, systemPrompt, userMessage, credentialKey, images } = params;

  const apiUrl = 'https://api.anthropic.com/v1/messages';

  // Формируем user content
  let userContent;
  if (images && images.length > 0) {
    userContent = [
      { type: 'text', text: userMessage }
    ];
    images.forEach((img, idx) => {
      if (!img.base64) return; // пропускаем страницы с ошибкой конвертации
      userContent.push({ type: 'text', text: `=== ${img.filename || `Изображение ${idx + 1}`} ===` });
      userContent.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mimeType || 'image/png',
          data: img.base64
        }
      });
    });
  } else {
    userContent = userMessage;
  }

  const requestBody = {
    model,
    system: systemPrompt,
    messages: [
      { role: 'user', content: userContent }
    ],
    max_tokens: 4096
  };

  console.log(`[llm] Отправка запроса к Anthropic API, модель: ${model}`);

  try {
    const response = await axios.post(apiUrl, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': credentialKey,
        'anthropic-version': '2023-06-01'
      },
      timeout: LLM_TIMEOUT_MS
    });

    const result = response.data;

    if (result.content && result.content[0] && result.content[0].text) {
      return result.content[0].text;
    }

    throw new Error(`Неожиданный формат ответа от Anthropic: ${JSON.stringify(result).substring(0, 500)}`);
  } catch (err) {
    if (err.response) {
      const errData = err.response.data;
      const errMsg = errData?.error?.message || JSON.stringify(errData).substring(0, 300);
      throw new Error(`Anthropic API ошибка (${err.response.status}): ${errMsg}`);
    }
    if (err.code === 'ECONNABORTED') {
      throw new Error(`Превышен таймаут ожидания ответа от Anthropic (${LLM_TIMEOUT_MS / 1000} сек).`);
    }
    throw err;
  }
}

/**
 * Главная функция отправки запроса к LLM
 * @param {object} params
 * @param {string} params.provider - openai | anthropic | openrouter | ollama | custom
 * @param {string} params.apiUrl - URL API
 * @param {string} params.model - название модели
 * @param {string} params.credentialUser - логин (или пустая строка)
 * @param {string} params.credentialKey - API-ключ
 * @param {string} params.systemPrompt - системный промт
 * @param {Array<{filename, text}>} params.documents - извлечённые документы
 * @param {Array<{base64, mimeType}>} params.images - изображения для Vision
 */
async function sendToLlm(params) {
  const { provider, apiUrl, model, credentialUser, credentialKey, systemPrompt, documents, images } = params;

  // Формируем сообщение пользователя
  let userMessage = 'Ниже представлены документы из бизнес-процесса для анализа:\n\n';

  if (documents && documents.length > 0) {
    for (const doc of documents) {
      userMessage += `=== ${doc.filename} ===\n${doc.text}\n\n`;
    }
  } else if (!images || images.length === 0) {
    userMessage += '[Документы не переданы. Выполни задание на основе системного промта.]';
  }

  if (images && images.length > 0) {
    userMessage += `\nТакже переданы ${images.length} изображени(е/я) для анализа (включая страницы сканированных документов):\n`;
    images.forEach((img, idx) => {
      userMessage += `${idx + 1}. ${img.filename || 'без названия'}\n`;
    });
  }

  const callParams = {
    provider,
    apiUrl,
    model,
    systemPrompt,
    userMessage,
    credentialUser,
    credentialKey,
    images: images || []
  };

  if (provider === 'anthropic') {
    return await callAnthropic(callParams);
  } else {
    // openai, openrouter, ollama, custom — всё через OpenAI-совместимый интерфейс
    return await callOpenAICompatible(callParams);
  }
}

module.exports = { sendToLlm };
