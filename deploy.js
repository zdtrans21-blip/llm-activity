'use strict';

/**
 * Скрипт деплоя на VibeCode Galaxy App
 * Запуск: node deploy.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const axios = require('axios');

require('dotenv').config();

const VIBE_API_KEY = process.env.VIBE_API_KEY;
const BITRIX_DOMAIN = process.env.BITRIX_DOMAIN || 'aslz.bitrix24.ru';

if (!VIBE_API_KEY) {
  console.error('❌ Переменная окружения VIBE_API_KEY не задана. Скопируйте .env.example в .env и заполните её.');
  process.exit(1);
}
const BASE_URL = 'https://vibecode.bitrix24.tech';

const headers = {
  'X-Api-Key': VIBE_API_KEY,
  'Content-Type': 'application/json'
};

async function deploy() {
  console.log('🚀 Начинаю деплой LLM Activity на VibeCode Galaxy...\n');

  // 1. Создаём архив проекта
  const archivePath = path.join(__dirname, '..', 'llm-activity-deploy.tar.gz');
  console.log('📦 Создаю архив проекта...');

  execSync(
    `tar -czf "${archivePath}" --exclude=node_modules --exclude=.env --exclude="*.tar.gz" -C "${__dirname}" .`,
    { stdio: 'pipe' }
  );

  const archiveSize = fs.statSync(archivePath).size;
  console.log(`   Архив: ${(archiveSize / 1024).toFixed(1)} KB\n`);

  // 2. Кодируем в base64
  const archiveBase64 = fs.readFileSync(archivePath).toString('base64');

  // 3. Проверяем существующие серверы
  console.log('🔍 Проверяю существующие серверы...');
  const serversResp = await axios.get(`${BASE_URL}/v1/infra/servers`, { headers });
  const servers = serversResp.data.data || serversResp.data || [];
  const existing = (Array.isArray(servers) ? servers : servers.items || [])
    .find(s => s.name === 'llm-activity');

  let serverId, serverUrl;

  if (existing) {
    console.log(`   Найден существующий сервер: ${existing.id} (${existing.name})`);
    serverId = existing.id;

    // Передеплоиваем
    console.log('\n🔄 Передеплоиваю приложение...');
    const deployResp = await axios.post(
      `${BASE_URL}/v1/infra/servers/${serverId}/deploy`,
      {
        source: { content: archiveBase64 },
        runtime: 'node20',
        start: 'node index.js',
        install: 'npm install',
        env: {
          VIBE_API_KEY,
          BITRIX_DOMAIN,
          PORT: '3000'
        }
      },
      { headers, timeout: 300000 }
    );
    console.log('   Результат деплоя:', JSON.stringify(deployResp.data).substring(0, 300));
    serverUrl = existing.url || existing.subdomain;
  } else {
    // Создаём новый Galaxy App
    console.log('\n🆕 Создаю новый Galaxy App...');
    const createResp = await axios.post(
      `${BASE_URL}/v1/infra/servers`,
      {
        name: 'llm-activity',
        source: { content: archiveBase64 },
        runtime: 'node20',
        start: 'node index.js',
        install: 'npm install',
        env: {
          VIBE_API_KEY,
          BITRIX_DOMAIN,
          PORT: '3000'
        }
      },
      { headers, timeout: 300000 }
    );

    const serverData = createResp.data.data || createResp.data;
    serverId = serverData.id;
    serverUrl = serverData.url || serverData.subdomain || serverData.domain;
    console.log(`   Сервер создан: ${serverId}`);
    console.log(`   URL: ${serverUrl}`);
    console.log('   Ответ:', JSON.stringify(createResp.data).substring(0, 500));
  }

  // 4. Ждём запуска
  console.log('\n⏳ Ожидаю запуск приложения...');
  let attempts = 0;
  const maxAttempts = 20;

  while (attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 5000));
    attempts++;

    try {
      const statusResp = await axios.get(`${BASE_URL}/v1/infra/servers/${serverId}`, { headers });
      const srv = statusResp.data.data || statusResp.data;
      const status = srv.blackholeStatus || srv.status || 'unknown';
      const url = srv.url || srv.subdomain || srv.domain || serverUrl;

      console.log(`   [${attempts}/${maxAttempts}] Статус: ${status}, URL: ${url}`);

      if (status === 'CONNECTED' || status === 'RUNNING') {
        serverUrl = url;
        console.log(`\n✅ Приложение запущено!`);
        console.log(`   URL: ${serverUrl}`);
        break;
      }

      if (status === 'ERROR' || status === 'FAILED') {
        // Получаем логи
        try {
          const logsResp = await axios.get(`${BASE_URL}/v1/infra/servers/${serverId}/logs?limit=50`, { headers });
          console.error('\n❌ Лог сборки:');
          console.error(JSON.stringify(logsResp.data).substring(0, 2000));
        } catch { /* ignored */ }
        throw new Error(`Деплой завершился с ошибкой: ${status}`);
      }
    } catch (err) {
      if (err.message.includes('Деплой завершился')) throw err;
      console.log(`   [${attempts}] Ожидание... (${err.message})`);
    }
  }

  if (!serverUrl) {
    // Последняя попытка получить URL
    const finalResp = await axios.get(`${BASE_URL}/v1/infra/servers/${serverId}`, { headers });
    const srv = finalResp.data.data || finalResp.data;
    serverUrl = srv.url || srv.subdomain || srv.domain;
  }

  const appUrl = serverUrl && serverUrl.startsWith('http') ? serverUrl : `https://${serverUrl}`;

  console.log('\n════════════════════════════════════════');
  console.log('✅ ДЕПЛОЙ ЗАВЕРШЁН');
  console.log(`   App URL: ${appUrl}`);
  console.log(`   Handler: ${appUrl}/handler`);
  console.log(`   Install: ${appUrl}/install`);
  console.log(`   Health:  ${appUrl}/health`);
  console.log('════════════════════════════════════════\n');

  // Регистрация активити происходит только через onAppInstall (POST /install,
  // который шлёт сам Битрикс24 при установке/переустановке локального
  // приложения) — деплой кода её не запускает и не должен запускать.
  console.log('ℹ️  Регистрация активити не требуется при обычном деплое — она уже сделана');
  console.log('   и обновляется автоматически при переустановке приложения в Битрикс24.');

  // Чистим архив
  try { fs.unlinkSync(archivePath); } catch { /* ignored */ }

  return { serverId, appUrl };
}

deploy().catch(err => {
  console.error('\n❌ Ошибка деплоя:', err.message);
  if (err.response) {
    console.error('   Ответ сервера:', JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
