'use strict';

/**
 * Локальный OAuth-скрипт для регистрации активити.
 * Запуск: node oauth-install.js
 *
 * Что делает:
 * 1. Поднимает временный HTTP-сервер на localhost:3000
 * 2. Открывает браузер для авторизации через Битрикс24
 * 3. Ловит callback с code
 * 4. Обменивает code на session token
 * 5. Регистрирует активити bizproc.activity.add
 * 6. Выходит
 */

const http = require('http');
const axios = require('axios');
const { exec } = require('child_process');
const crypto = require('crypto');
const url = require('url');

const VIBE_API_KEY = 'vibe_app_local_6a3980a57f9e21_62538899_xfI14B1H3vBDPgDCx4XAu9C27F0y5JYDBTLlaYtyhSKTkwb6Qe_5646dd';
const APP_URL = 'https://app-09458486e73d.vibecode.bitrix24.tech';
const VIBEBASE = 'https://vibecode.bitrix24.tech';
const BITRIX_DOMAIN = 'aslz.bitrix24.ru';
const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

const state = crypto.randomBytes(16).toString('hex');

// ─── Параметры активити ───────────────────────────────────────
const activityParams = {
  CODE: 'llm_document_analyzer',
  HANDLER: `${APP_URL}/handler`,
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
      Description: 'Базовый URL API LLM',
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
      Description: 'ID файлов Disk или прямые URL. PDF, DOCX, TXT, PNG, JPG.',
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
      Description: 'comment — добавить комментарий | variable — записать в переменную БП',
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
    llm_result: { Name: 'Результат LLM', Description: 'Полный текст ответа LLM', Type: 'string' },
    llm_status: { Name: 'Статус', Description: 'success | error', Type: 'string' },
    llm_error_message: { Name: 'Текст ошибки', Description: 'Если llm_status=error', Type: 'string' }
  }
};

// ─── Открыть браузер ─────────────────────────────────────────
function openBrowser(url) {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, err => { if (err) console.error('Не удалось открыть браузер автоматически:', err.message); });
}

// ─── Регистрация через VibeCode Entity API ───────────────────
async function registerViaEntityApi(sessionToken) {
  console.log('\n📋 Регистрирую активити через bizproc-activities...');
  const headers = {
    'X-Api-Key': VIBE_API_KEY,
    'Authorization': `Bearer ${sessionToken}`,
    'Content-Type': 'application/json'
  };
  const resp = await axios.post(`${VIBEBASE}/v1/bizproc-activities`, activityParams, { headers, timeout: 30000 });
  return resp.data;
}

// ─── Fallback: прямой REST Битрикс24 ────────────────────────
async function registerViaBitrixRest(sessionToken) {
  console.log('\n📋 Регистрирую активити через Битрикс24 REST API напрямую...');
  const restUrl = `https://${BITRIX_DOMAIN}/rest/bizproc.activity.add`;
  const resp = await axios.post(restUrl, activityParams, {
    headers: {
      'Authorization': `Bearer ${sessionToken}`,
      'Content-Type': 'application/json'
    },
    timeout: 30000
  });
  if (resp.data && resp.data.error) {
    throw new Error(`Битрикс24 REST ошибка: ${resp.data.error_description || resp.data.error}`);
  }
  return resp.data;
}

// ─── Основной запуск ─────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname !== '/callback') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<p>Ожидаю OAuth callback...</p>');
    return;
  }

  const { code, state: returnedState, error } = parsed.query;

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>❌ Ошибка OAuth: ${error}</h2><p>Запустите скрипт снова.</p>`);
    server.close();
    process.exit(1);
  }

  if (returnedState !== state) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>❌ Неверный state (CSRF-защита)</h2>');
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>❌ Не получен code от OAuth</h2>');
    server.close();
    process.exit(1);
  }

  console.log('\n✅ Получен OAuth code:', code.substring(0, 20) + '...');

  try {
    // Обмен code на session token
    console.log('🔑 Обмениваю code на session token...');
    const tokenResp = await axios.post(`${VIBEBASE}/v1/oauth/token`, {
      app_key: VIBE_API_KEY,
      code,
      redirect_uri: REDIRECT_URI
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });

    const sessionToken = tokenResp.data.access_token;
    if (!sessionToken) throw new Error('session token не получен: ' + JSON.stringify(tokenResp.data));
    console.log('🔑 Session token получен:', sessionToken.substring(0, 25) + '...');

    // Регистрируем активити
    let result;
    try {
      result = await registerViaEntityApi(sessionToken);
    } catch (e1) {
      console.warn('   Entity API:', e1.response?.data?.error?.message || e1.message);
      console.log('   Пробуем прямой REST...');
      result = await registerViaBitrixRest(sessionToken);
    }

    console.log('\n🎉 ГОТОВО! Активити успешно зарегистрировано.');
    console.log('   Откройте Битрикс24 → Бизнес-процессы → Конструктор → "Действия приложений"');
    console.log('   Там появится: 🤖 LLM: анализ документов\n');
    console.log('Результат:', JSON.stringify(result, null, 2));

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!DOCTYPE html><html><head><meta charset="UTF-8">
      <title>Установка завершена</title>
      <style>body{font-family:sans-serif;padding:40px;max-width:700px;margin:0 auto}
      pre{background:#f5f5f5;padding:16px;border-radius:8px;font-size:12px;overflow:auto}</style></head>
      <body>
      <h2>✅ Активити зарегистрировано!</h2>
      <p>Откройте <b>Битрикс24 → Бизнес-процессы → Конструктор</b> → раздел <b>"Действия приложений"</b></p>
      <p>Там появится: <b>🤖 LLM: анализ документов</b></p>
      <p>Handler URL: <code>${APP_URL}/handler</code></p>
      <pre>${JSON.stringify(result, null, 2)}</pre>
      </body></html>
    `);
  } catch (err) {
    console.error('\n❌ Ошибка:', err.message);
    if (err.response) console.error('   Ответ:', JSON.stringify(err.response.data, null, 2));
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>❌ Ошибка</h2><p>${err.message}</p>
      <pre>${JSON.stringify(err.response?.data || {}, null, 2)}</pre>
      <p><a href="javascript:window.close()">Закрыть</a></p>`);
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 1000);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const authUrl = `${VIBEBASE}/v1/oauth/authorize` +
    `?app_key=${encodeURIComponent(VIBE_API_KEY)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&state=${state}`;

  console.log('═══════════════════════════════════════════════════');
  console.log('  LLM Activity — установка активити в Битрикс24');
  console.log('═══════════════════════════════════════════════════');
  console.log(`\n🌐 Временный сервер запущен на http://localhost:${PORT}`);
  console.log('\n🔗 Открываю браузер для авторизации...');
  console.log('   Если браузер не открылся, перейдите вручную:');
  console.log('   ' + authUrl);
  console.log('\n⏳ Ожидаю завершения авторизации...\n');

  openBrowser(authUrl);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Порт ${PORT} занят. Закройте другие приложения на этом порту и запустите снова.`);
  } else {
    console.error('❌ Ошибка сервера:', err.message);
  }
  process.exit(1);
});
