const axios = require('axios');
const db = require('../database/db');
const { isReviewTextLikelyChinese } = require('../scraper/workReviews');

const TARGET_LANGUAGE = 'zh-cn';
const PROVIDER = 'openai';
const DEFAULT_MODEL = process.env.OPENAI_TRANSLATION_MODEL || 'gpt-4o-mini';
const DEFAULT_BATCH_SIZE = Number(process.env.REVIEW_TRANSLATION_BATCH_SIZE || 5);
const DEFAULT_MAX_CHARS = Number(process.env.REVIEW_TRANSLATION_MAX_CHARS || 12000);

function parseArgs(argv) {
  const args = {
    limit: Infinity,
    batchSize: DEFAULT_BATCH_SIZE,
    maxChars: DEFAULT_MAX_CHARS,
    model: DEFAULT_MODEL,
    dryRun: false
  };

  argv.forEach((arg, index) => {
    if (arg === '--dry-run') args.dryRun = true;
    if (arg === '--limit') args.limit = Number(argv[index + 1] || args.limit);
    if (arg.startsWith('--limit=')) args.limit = Number(arg.split('=')[1]);
    if (arg === '--batch') args.batchSize = Number(argv[index + 1] || args.batchSize);
    if (arg.startsWith('--batch=')) args.batchSize = Number(arg.split('=')[1]);
    if (arg === '--maxChars') args.maxChars = Number(argv[index + 1] || args.maxChars);
    if (arg.startsWith('--maxChars=')) args.maxChars = Number(arg.split('=')[1]);
    if (arg === '--model') args.model = argv[index + 1] || args.model;
    if (arg.startsWith('--model=')) args.model = arg.split('=')[1] || args.model;
  });

  if (!Number.isFinite(args.limit) || args.limit <= 0) args.limit = Infinity;
  if (!Number.isFinite(args.batchSize) || args.batchSize <= 0) args.batchSize = DEFAULT_BATCH_SIZE;
  if (!Number.isFinite(args.maxChars) || args.maxChars <= 0) args.maxChars = DEFAULT_MAX_CHARS;
  return args;
}

function getProxyConfig() {
  const raw = process.env.OPENAI_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  if (!raw) return false;

  const parsed = new URL(raw);
  return {
    protocol: parsed.protocol.replace(':', ''),
    host: parsed.hostname,
    port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
  };
}

function sanitizeErrorMessage(message) {
  return String(message || '').replace(/sk-[A-Za-z0-9_*.-]+/g, 'sk-***');
}

async function requestJson(path, body, apiKey) {
  try {
    const response = await axios.post(`https://api.openai.com${path}`, body, {
      timeout: Number(process.env.OPENAI_TRANSLATION_TIMEOUT_MS || 120000),
      proxy: getProxyConfig(),
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      }
    });

    return response.data;
  } catch (error) {
    if (error.response && error.response.data) {
      throw new Error(sanitizeErrorMessage(error.response.data.error && error.response.data.error.message || JSON.stringify(error.response.data)));
    }
    error.message = sanitizeErrorMessage(error.message);
    throw error;
  }
}

function getContentFromResponse(response) {
  const message = response && response.choices && response.choices[0] && response.choices[0].message;
  if (!message || !message.content) return '';
  return message.content;
}

async function translateBatch(items, options, apiKey) {
  const userPayload = {
    target_language: 'Simplified Chinese',
    items: items.map(item => ({
      source_review_id: item.source_review_id,
      title: item.title || '',
      body: item.body || ''
    }))
  };

  const response = await requestJson('/v1/chat/completions', {
    model: options.model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: [
          'You translate cached DLsite review text into Simplified Chinese.',
          'Return only valid JSON: {"translations":[{"source_review_id":"...","translated_title":"...","translated_body":"..."}]}.',
          'Preserve the reviewer voice and meaning. Do not summarize, omit, censor, add explanations, or add commentary.',
          'Adult sexual wording should remain direct when the source is direct, but do not make it more explicit than the source.',
          'The user dislikes 鸡巴 as the default translation. Prefer context-appropriate terms such as 肉棒, 阴茎, 下体, or natural action descriptions.',
          'Keep work names, character names, CV names, and product-specific proper nouns recognizable.'
        ].join('\n')
      },
      {
        role: 'user',
        content: JSON.stringify(userPayload)
      }
    ]
  }, apiKey);

  const content = getContentFromResponse(response);
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to parse translation JSON: ${content.slice(0, 500)}`);
  }

  const translations = Array.isArray(parsed.translations) ? parsed.translations : [];
  const byId = new Map(translations.map(item => [String(item.source_review_id), item]));

  return items.map(item => {
    const translation = byId.get(String(item.source_review_id));
    if (!translation || !translation.translated_body) {
      throw new Error(`Missing translation for review ${item.source_review_id}`);
    }

    return {
      source: item.source,
      source_review_id: item.source_review_id,
      translated_title: translation.translated_title || '',
      translated_body: translation.translated_body || ''
    };
  });
}

function makeBatches(rows, batchSize, maxChars) {
  const batches = [];
  let current = [];
  let currentChars = 0;

  rows.forEach((row) => {
    const itemChars = String(row.title || '').length + String(row.body || '').length;
    if (current.length && (current.length >= batchSize || currentChars + itemChars > maxChars)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(row);
    currentChars += itemChars;
  });

  if (current.length) batches.push(current);
  return batches;
}

async function loadPendingRows(limit) {
  await db.ensureWorkReviewTables();

  let query = db.knex('t_external_work_review as r')
    .select([
      'r.source',
      'r.source_review_id',
      db.knex.raw('MIN(r.title) AS title'),
      db.knex.raw('MIN(r.body) AS body'),
      db.knex.raw('MIN(r.language) AS language')
    ])
    .whereNotIn('r.language', ['zh', 'zh-cn', 'zh-tw'])
    .whereNotExists(function () {
      this.select(db.knex.raw('1'))
        .from('t_external_work_review_translation as t')
        .whereRaw('t.source = r.source')
        .whereRaw('t.source_review_id = r.source_review_id')
        .where('t.target_language', TARGET_LANGUAGE)
        .whereNotNull('t.translated_body')
        .whereNot('t.translated_body', '');
    })
    .groupBy('r.source', 'r.source_review_id')
    .orderBy('r.source_review_id', 'desc');

  if (Number.isFinite(limit)) query = query.limit(limit);

  const rows = await query;
  return rows.filter(row => !isReviewTextLikelyChinese(row.body || row.title || ''));
}

async function saveTranslations(translations, model) {
  const now = new Date().toISOString();
  await db.knex.transaction(async trx => {
    for (const item of translations) {
      await trx.raw(
        `INSERT OR REPLACE INTO t_external_work_review_translation
          (source, source_review_id, target_language, translated_title, translated_body, provider, model, confirmed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.source,
          item.source_review_id,
          TARGET_LANGUAGE,
          item.translated_title,
          item.translated_body,
          PROVIDER,
          model,
          0,
          now,
          now
        ]
      );
    }
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const rows = await loadPendingRows(options.limit);
  const batches = makeBatches(rows, options.batchSize, options.maxChars);
  console.log(JSON.stringify({
    pending: rows.length,
    batches: batches.length,
    model: options.model,
    dryRun: options.dryRun
  }));

  if (options.dryRun) {
    await db.knex.destroy();
    return;
  }

  let done = 0;
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    console.log(`Translating batch ${index + 1}/${batches.length}, reviews=${batch.length}`);
    const translations = await translateBatch(batch, options, apiKey);
    if (!options.dryRun) await saveTranslations(translations, options.model);
    done += translations.length;
    console.log(`Saved ${done}/${rows.length}`);
  }

  await db.knex.destroy();
}

main().catch(async (error) => {
  console.error(sanitizeErrorMessage(error && error.message || error));
  try {
    await db.knex.destroy();
  } catch {
    // Ignore cleanup errors.
  }
  process.exit(1);
});
