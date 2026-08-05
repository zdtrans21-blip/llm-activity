'use strict';

require('dotenv').config();

const express = require('express');
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const APP_URL = process.env.APP_URL || 'https://app-09458486e73d.vibecode.bitrix24.tech';

// Кольцевой буфер последних логов — доступен через GET /debug/logs
const LOG_BUFFER = [];
const LOG_BUFFER_MAX = 300;
function pushLog(line) {
  LOG_BUFFER.push(`[${new Date().toISOString()}] ${line}`);
  if (LOG_BUFFER.length > LOG_BUFFER_MAX) LOG_BUFFER.shift();
}
const origLog = console.log.bind(console);
const origError = console.error.bind(console);
console.log = (...args) => { pushLog(args.join(' ')); origLog(...args); };
console.error = (...args) => { pushLog('ERROR: ' + args.join(' ')); origError(...args); };

// Лог каждого входящего запроса
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── Просмотр логов без exec/docker ───────────────────────────
app.get('/debug/logs', (req, res) => {
  res.type('text/plain').send(LOG_BUFFER.join('\n') || '(пусто)');
});

// ─── Healthcheck ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'llm-activity', timestamp: new Date().toISOString() });
});

// ─── Стартовая страница (Битрикс24 открывает её в iframe) ────
// Важно: НЕ делать редиректов через внешние домены — только простой HTML
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>LLM Activity</title></head>
<body style="font-family:sans-serif;padding:32px;max-width:600px">
<h2>🤖 LLM: Анализ документов</h2>
<p>Приложение запущено и готово к работе.</p>
<ul>
  <li>Handler: <code>${APP_URL}/handler</code></li>
  <li>Status: <strong style="color:green">OK</strong></li>
</ul>
<p><small>Для регистрации активити перейдите на <a href="/install">/install</a></small></p>
</body></html>`);
});

// ─── Установка (onAppInstall) — POST от Битрикс24 ────────────
// Локальное приложение Битрикс24 шлёт сюда AUTH_ID (токен) и
// SERVER_ENDPOINT (база REST API) при установке/переустановке.
app.post('/install', async (req, res) => {
  console.log('[onAppInstall] Тело запроса:', JSON.stringify(req.body).substring(0, 800));

  const body = req.body || {};
  const auth = body.auth || body.AUTH || {};

  // Поддержка обоих форматов: классический локальный (AUTH_ID/SERVER_ENDPOINT)
  // и событийный (auth.access_token/auth.server_endpoint)
  const accessToken = body.AUTH_ID || body.auth_id
    || auth.access_token || auth.ACCESS_TOKEN
    || body.access_token || body.ACCESS_TOKEN;

  const restEndpoint = body.SERVER_ENDPOINT || body.server_endpoint
    || auth.server_endpoint || auth.client_endpoint;

  if (!accessToken) {
    console.error('[onAppInstall] AUTH_ID/access_token не найден в запросе!');
    return res.status(200).send('ok'); // всегда 200 для Битрикс24
  }

  // Отвечаем сразу, регистрацию делаем асинхронно
  res.status(200).send('ok');

  try {
    const install = require('./install');
    await install.registerActivity(accessToken, restEndpoint);
    console.log('[onAppInstall] ✅ Активити зарегистрировано');
  } catch (err) {
    console.error('[onAppInstall] ❌ Ошибка регистрации:', err.message);
    if (err.response) console.error('   Ответ:', JSON.stringify(err.response.data));
  }
});

// ─── Ручная установка через GET (для отладки) ────────────────
// Используется когда нужно перерегистрировать активити вручную
// Требует передать ?token=ACCESS_TOKEN
app.get('/install', async (req, res) => {
  const token = req.query.token;
  const endpoint = req.query.endpoint;

  if (!token) {
    return res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Установка активити</title></head>
<body style="font-family:sans-serif;padding:32px;max-width:600px">
<h2>Ручная установка активити</h2>
<p>Передайте Битрикс24 access_token как параметр:</p>
<code>/install?token=ВАШ_ACCESS_TOKEN&amp;endpoint=https://aslz.bitrix24.ru/rest/</code>
<p>Токен можно получить из любого Битрикс24 webhook или через REST API.</p>
</body></html>`);
  }

  try {
    const install = require('./install');
    const result = await install.registerActivity(token, endpoint);
    res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;padding:32px;max-width:600px">
<h2>✅ Активити зарегистрировано!</h2>
<p>Откройте Битрикс24 → Бизнес-процессы → Конструктор → <b>"Действия приложений"</b></p>
<p>Там появится: <b>🤖 LLM: анализ документов</b></p>
<pre style="background:#f5f5f5;padding:12px;border-radius:6px;font-size:12px">${JSON.stringify(result, null, 2)}</pre>
</body></html>`);
  } catch (err) {
    res.status(500).send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;padding:32px;max-width:600px">
<h2>❌ Ошибка</h2><p>${err.message}</p>
<pre style="background:#fff0f0;padding:12px;border-radius:6px;font-size:12px">${JSON.stringify(err.response?.data || {}, null, 2)}</pre>
</body></html>`);
  }
});

// ─── Обработчик активити бизнес-процесса ─────────────────────
app.post('/handler', async (req, res) => {
  // Отвечаем сразу 200 — Битрикс24 не должен ждать
  res.status(200).json({ status: 'accepted' });

  const handler = require('./handler');
  handler.process(req.body).catch(err => {
    console.error('[handler] Необработанная ошибка:', err.message);
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 LLM Activity запущен на порту ${PORT}`);
  console.log(`   APP_URL: ${APP_URL}`);
  console.log(`   Handler: ${APP_URL}/handler`);
});
