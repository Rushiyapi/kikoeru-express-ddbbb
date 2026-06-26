const path = require('path');
const express = require('express');
const router = express.Router();
const { param, query} = require('express-validator');
const fs = require('fs');
const db = require('../database/db');
const { getTrackList, toTree } = require('../filesystem/utils');
const { config } = require('../config');
const normalize = require('./utils/normalize');
const { isValidRequest } = require('./utils/validate');
const { formatID, scrapeWorkMemo } = require('../filesystem/utils');
const { scrapeWorkMetadataFromAsmrOne } = require('../scraper/asmrOne');
const {
  scrapeWorkReviews,
  DLSITE_REVIEW_SOURCE,
  DEFAULT_REVIEW_CACHE_LIMIT,
  getReviewCacheTargetCount,
  withReviewCacheAttemptMetadata,
  isConfirmedShortReviewCache
} = require('../scraper/workReviews');

const PAGE_SIZE = config.pageSize || 12;
const LOCAL_SUBTITLE_META_FILE = path.join(__dirname, '..', 'config', 'local-subtitle-meta.json');
const LOCAL_SUBTITLE_META_LABEL = 'config/local-subtitle-meta.json';

function emptyLocalSubtitleMeta() {
  return {
    version: 1,
    sourceFile: LOCAL_SUBTITLE_META_LABEL,
    exists: false,
    status: null,
    badges: [],
    tracks: {}
  };
}

function normalizeLocalMetaPath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .trim();
}

function getLocalMetaTrackMap(meta) {
  return Object.assign({}, meta && meta.tracks || {}, meta && meta.files || {});
}

function getDisplayTitleFromMeta(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return String(entry.displayTitle || entry.titleZh || entry.title_zh || entry.zh || '').trim();
}

function getDisplayTitleFromValue(value) {
  if (typeof value === 'string') return value.trim();
  return getDisplayTitleFromMeta(value);
}

function normalizeLocalSubtitleStatus(meta) {
  const status = Object.assign(
    {},
    meta && meta.subtitleStatus || {},
    meta && meta.defaultSubtitle || {},
    meta && meta.status || {}
  );

  return Object.keys(status).length ? status : null;
}

function buildLocalSubtitleBadges(meta) {
  const explicitBadges = Array.isArray(meta && meta.badges) ? meta.badges : [];
  const output = explicitBadges.map((badge) => {
    if (typeof badge === 'string') return { label: badge, description: '' };
    return {
      label: String(badge && badge.label || '').trim(),
      description: String(badge && badge.description || badge.title || '').trim()
    };
  }).filter((badge) => badge.label);

  if (output.length) return output;

  const status = normalizeLocalSubtitleStatus(meta);
  if (!status) return [];

  const textSource = String(status.textSource || status.text_source || '').toLowerCase();
  const timingSource = String(status.timingSource || status.timing_source || '').toLowerCase();
  const reviewStatus = String(status.reviewStatus || status.review_status || '').toLowerCase();

  if ((textSource === 'official_zh' || textSource === 'official_zh_cn' || textSource === 'dlsite_official_zh')
    && timingSource === 'ai_aligned') {
    output.push({
      label: '官中对轴',
      description: '官方中文文本，本地根据日文音频制作时间轴'
    });
  } else if (textSource === 'ai_translation') {
    output.push({
      label: 'AI字幕',
      description: '中文文本由 AI 翻译或整理生成'
    });
  } else if (timingSource === 'ai_aligned') {
    output.push({
      label: 'AI对轴',
      description: '字幕时间轴由 AI 或自动化工具对齐'
    });
  }

  if (reviewStatus === 'checked' || reviewStatus === 'proofread') {
    output.push({
      label: '已校对',
      description: '字幕已经过人工检查或校对'
    });
  }

  return output;
}

function normalizeLocalSubtitleMetaEntry(entry, sourceFile) {
  const parsed = entry || {};
  const trackMap = getLocalMetaTrackMap(parsed);
  const tracks = {};

  Object.keys(trackMap).forEach((key) => {
    const normalizedKey = normalizeLocalMetaPath(key);
    if (!normalizedKey) return;
    tracks[normalizedKey] = trackMap[key];
  });

  return {
    version: Number(parsed.version || 1),
    sourceFile: sourceFile || LOCAL_SUBTITLE_META_LABEL,
    exists: true,
    status: normalizeLocalSubtitleStatus(parsed),
    badges: buildLocalSubtitleBadges(parsed),
    preserveOriginalTitle: parsed.preserveOriginalTitle !== false,
    separator: parsed.separator || '｜',
    tracks,
    workTitle: getDisplayTitleFromValue(parsed.workTitle || parsed.title) || null
  };
}

async function readLocalSubtitleMetaStore() {
  try {
    const raw = await fs.promises.readFile(LOCAL_SUBTITLE_META_FILE, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    console.error(`Failed to read ${LOCAL_SUBTITLE_META_LABEL}:`, err);
    throw err;
  }
}

function getLocalSubtitleMetaKeys(work, workId) {
  const keys = [];
  const idText = String(workId || '').trim();
  if (idText) {
    keys.push(idText);
    keys.push('RJ' + formatID(idText));
  }

  const text = [work && work.dir, work && work.title].filter(Boolean).join(' ');
  const match = text.match(/RJ(\d{6,8})(?!\d)/i);
  if (match) keys.push('RJ' + match[1]);

  return keys.filter((key, index) => key && keys.indexOf(key) === index);
}

async function readLocalSubtitleMetaForWork(work, workId) {
  try {
    const store = await readLocalSubtitleMetaStore();
    if (!store) return emptyLocalSubtitleMeta();

    const works = store.works || {};
    const keys = getLocalSubtitleMetaKeys(work, workId);
    for (const key of keys) {
      if (works[key]) {
        return normalizeLocalSubtitleMetaEntry(works[key], LOCAL_SUBTITLE_META_LABEL + '#works.' + key);
      }
    }

    return emptyLocalSubtitleMeta();
  } catch (err) {
    return Object.assign(emptyLocalSubtitleMeta(), {
      error: err && err.message || String(err)
    });
  }
}

function composeDisplayTitle(displayTitle, originalTitle, localMeta) {
  const display = String(displayTitle || '').trim();
  const original = String(originalTitle || '').trim();
  if (!display) return '';
  if (!original || !localMeta || localMeta.preserveOriginalTitle === false || display === original) return display;
  return display + (localMeta.separator || '｜') + original;
}

function applyLocalWorkDisplayTitle(work, localMeta) {
  if (!work || !localMeta || !localMeta.workTitle) return work;
  if (!work.originalTitle) {
    work.originalTitle = work.title;
  }
  work.displayTitle = localMeta.workTitle;
  work.title = localMeta.workTitle;
  work.localTitleSource = 'local_meta';
  return work;
}

async function applyLocalWorkDisplayTitles(works) {
  const list = Array.isArray(works) ? works : [works];
  await Promise.all(list.filter(Boolean).map(async (work) => {
    const localMeta = await readLocalSubtitleMetaForWork(work, work.id);
    applyLocalWorkDisplayTitle(work, localMeta);
  }));
  return works;
}

function findTrackLocalMeta(localMeta, relativePath, title) {
  const tracks = localMeta && localMeta.tracks || {};
  const keys = [
    normalizeLocalMetaPath(relativePath),
    normalizeLocalMetaPath(title)
  ].filter(Boolean);

  for (const key of keys) {
    if (tracks[key]) return tracks[key];
  }
  return null;
}

function applyLocalSubtitleMetaToTree(items, localMeta, folderParts = []) {
  const workDisplayTitle = localMeta && localMeta.workTitle;

  (items || []).forEach((item) => {
    if (!item) return;
    if (item.type === 'folder') {
      applyLocalSubtitleMetaToTree(item.children, localMeta, folderParts.concat(item.title));
      return;
    }

    if (workDisplayTitle && item.workTitle) {
      item.originalWorkTitle = item.workTitle;
      item.workTitle = workDisplayTitle;
    }

    if (item.type !== 'audio') return;

    const relativePath = folderParts.concat(item.title || '').join('/');
    const entry = findTrackLocalMeta(localMeta, relativePath, item.title);
    const displayTitle = getDisplayTitleFromMeta(entry);
    if (!displayTitle) return;

    item.originalTitle = item.title;
    item.displayTitle = displayTitle;
    item.title = composeDisplayTitle(displayTitle, item.title, localMeta);
    item.localTitleSource = entry.titleSource || entry.title_source || 'local_meta';
  });
}

// GET work cover image
router.get('/cover/:id',
  param('id').isInt(),
  (req, res, next) => {
    if(!isValidRequest(req, res)) return;

    const rjcode = formatID(req.params.id);
    const type = req.query.type || 'main'; // 'main', 'sam', '240x240', '360x360'
    res.sendFile(path.join(config.coverFolderDir, `RJ${rjcode}_img_${type}.jpg`), (err) => {
      if (err) {
        res.sendFile(path.join(__dirname, '../static/no-image.jpg'), (err2) => {
          if (err2) {
            next(err2);
          }
        });
      }
    });
});

// GET work metadata
router.get('/work/:id',
  param('id').isInt(),
  (req, res, next) => {
    if(!isValidRequest(req, res)) return;

    let username = 'admin';
    if (config.auth) {
      username = req.user.name;
    }
    db.getWorkMetadata(req.params.id, username)
      .then(work => {
        // work is an Array of length 1
        normalize(work);
        return applyLocalWorkDisplayTitles(work).then(() => {
          res.send(work[0]);
        });
      })
      .catch(err => next(err));
  });

// GET supplemental metadata from asmr.one for richer local detail-page tags.
router.get('/work/:id/asmrone',
  param('id').isInt(),
  async (req, res) => {
    if(!isValidRequest(req, res)) return;

    try {
      const metadata = await scrapeWorkMetadataFromAsmrOne(parseInt(req.params.id));
      await db.upsertAsmrOneTags(parseInt(req.params.id), metadata.tags || []);
      res.send({
        id: metadata.id,
        release: metadata.release,
        create_date: metadata.create_date,
        dl_count: metadata.dl_count,
        duration: metadata.duration,
        has_subtitle: Boolean(metadata.has_subtitle),
        language_editions: metadata.language_editions || [],
        other_language_editions_in_db: metadata.other_language_editions_in_db || [],
        tags: metadata.tags || [],
        vas: metadata.vas || []
      });
    } catch (err) {
      res.status(502).send({error: '获取 asmr.one 补充信息失败'});
    }
  });

async function sendWorkReviews(req, res, options = {}) {
  if(!isValidRequest(req, res)) return;

  const workId = parseInt(req.params.id);
  const forceRefresh = Boolean(options.forceRefresh);

  try {
    await db.ensureWorkReviewTables();
    const work = await db.knex('t_work')
      .select('review_count')
      .where('id', workId)
      .first();
    const metadataReviewCount = Number(work && work.review_count || 0);
    const targetCachedReviewCount = getReviewCacheTargetCount(metadataReviewCount);
    let reviewState = await db.getExternalWorkReviewState(workId);
    let shortCacheConfirmed = isConfirmedShortReviewCache(reviewState.items, targetCachedReviewCount);
    let countMismatch = Number.isFinite(metadataReviewCount)
      && targetCachedReviewCount !== reviewState.count
      && !shortCacheConfirmed;
    const hasLegacyReviewCache = reviewState.items.some((item) => {
      return !item.metadata
        || typeof item.metadata.edition_role === 'undefined'
        || typeof item.metadata.dlsite_best_order === 'undefined';
    });

    if (forceRefresh || (targetCachedReviewCount > 0 && reviewState.count === 0) || hasLegacyReviewCache || countMismatch) {
      const reviews = targetCachedReviewCount > 0
        ? await scrapeWorkReviews(workId, {
          expectedReviewCount: metadataReviewCount,
          limitReviews: targetCachedReviewCount
        })
        : [];
      const annotatedReviews = withReviewCacheAttemptMetadata(reviews, targetCachedReviewCount);
      await db.replaceExternalWorkReviews(workId, annotatedReviews, [DLSITE_REVIEW_SOURCE]);
      reviewState = await db.getExternalWorkReviewState(workId);
      shortCacheConfirmed = isConfirmedShortReviewCache(reviewState.items, targetCachedReviewCount);
      countMismatch = Number.isFinite(metadataReviewCount)
        && targetCachedReviewCount !== reviewState.count
        && !shortCacheConfirmed;
      if (reviewState.count === 0) {
        reviewState.status = metadataReviewCount > 0 ? 'stale' : 'empty';
      }
    }

    reviewState.metadataReviewCount = metadataReviewCount;
    reviewState.targetCachedReviewCount = targetCachedReviewCount;
    reviewState.effectiveReviewCount = shortCacheConfirmed ? reviewState.count : metadataReviewCount;
    reviewState.cacheLimit = DEFAULT_REVIEW_CACHE_LIMIT;
    reviewState.countMismatch = countMismatch;
    reviewState.shortCacheConfirmed = shortCacheConfirmed;
    if (countMismatch && reviewState.status === 'ready') {
      reviewState.status = 'stale';
      reviewState.staleReason = 'review_cache_count_mismatch';
    }

    res.send(reviewState);
  } catch (err) {
    try {
      const reviewState = await db.getExternalWorkReviewState(workId);
      const work = await db.knex('t_work')
        .select('review_count')
        .where('id', workId)
        .first();
      const metadataReviewCount = Number(work && work.review_count || 0);
      const targetCachedReviewCount = getReviewCacheTargetCount(metadataReviewCount);
      const shortCacheConfirmed = isConfirmedShortReviewCache(reviewState.items, targetCachedReviewCount);
      reviewState.metadataReviewCount = metadataReviewCount;
      reviewState.targetCachedReviewCount = targetCachedReviewCount;
      reviewState.effectiveReviewCount = shortCacheConfirmed ? reviewState.count : metadataReviewCount;
      reviewState.cacheLimit = DEFAULT_REVIEW_CACHE_LIMIT;
      reviewState.countMismatch = Number.isFinite(metadataReviewCount)
        && targetCachedReviewCount !== reviewState.count
        && !shortCacheConfirmed;
      reviewState.shortCacheConfirmed = shortCacheConfirmed;
      if (reviewState.count > 0) {
        reviewState.status = 'stale';
        reviewState.error = '刷新赏析失败，显示本地缓存';
        res.send(reviewState);
        return;
      }
    } catch (cacheErr) {
      // Fall through to the explicit error response below.
    }

    res.status(502).send({
      count: 0,
      status: 'error',
      error: '获取赏析失败',
      items: []
    });
  }
}

router.get('/work/:id/reviews',
  param('id').isInt(),
  async (req, res) => sendWorkReviews(req, res));

router.post('/work/:id/reviews/refresh',
  param('id').isInt(),
  async (req, res) => sendWorkReviews(req, res, { forceRefresh: true }));

router.get('/work/:id/subtitle-meta',
  param('id').isInt(),
  async (req, res, next) => {
    if(!isValidRequest(req, res)) return;
    const work_id = req.params.id;

    try {
      const work = await db.knex('t_work')
        .select('root_folder', 'dir')
        .where('id', '=', work_id)
        .first();

      if (!work) {
        res.status(404).send({ error: 'work not found' });
        return;
      }

      res.send(await readLocalSubtitleMetaForWork(work, work_id));
    } catch (err) {
      next(err);
    }
});

// GET track list in work folder
router.get('/tracks/:id',
  param('id').isInt(),
  async (req, res, next) => {
    if(!isValidRequest(req, res)) return;
    const work_id = req.params.id;

    try {
      const work = await db.knex('t_work')
        .select('title', 'root_folder', 'dir', 'memo')
        .where('id', '=', work_id)
        .first();

      const rootFolder = config.rootFolders.find(rootFolder => rootFolder.name === work.root_folder);
      if (rootFolder) {
        try {
          const tracks = await getTrackList(work_id, path.join(rootFolder.path, work.dir), JSON.parse(work.memo))
          const tree = toTree(tracks, work.title, work.dir, rootFolder);
          const localSubtitleMeta = await readLocalSubtitleMetaForWork(work, work_id);
          applyLocalSubtitleMetaToTree(tree, localSubtitleMeta);
          res.send(tree);
        } catch (err) {
          res.status(500).send({error: '获取文件列表失败，请检查文件是否存在或重新扫描清理'});
        }
      } else {
        res.status(500).send({error: `找不到文件夹: "${work.root_folder}"，请尝试重启服务器或重新扫描.`});
      }
    } catch (err) {
      next(err);
    }
});

// GET list of work ids without any search
router.get('/works', 
  query('page').optional({nullable: true}).isInt(),
  query('order').optional({nullable: true}).isIn(["release", "rating", "dl_count", "price", "rate_average_2dp", "review_count", "id", "created_at", "random", "betterRandom"]),
  query('sort').optional({nullable: true}).isIn(['desc', 'asc']),
  query('nsfw').optional({nullable: true}).isInt().isIn([0/* 无年龄限制 */, 1 /* 全年龄 */, 2 /* 仅R18 */]),
  query('seed').optional({nullable: true}).isInt(),
  // eslint-disable-next-line no-unused-vars
  async (req, res, next) => {
    if(!isValidRequest(req, res)) return;

    const currentPage = parseInt(req.query.page) || 1;
    // 通过 "音声id, 贩卖日, 评价, 用户评价, 售出数, 评论数量, 价格, 平均评价, 全年龄新作， 入库时间， 随机， 随机一个" 排序
    // ['id', 'release', 'rating', 'dl_count', 'review_count', 'price', 'rate_average_2dp', 'nsfw', 'created_at']
    const order = req.query.order || 'release';
    const sort = req.query.sort || 'desc';
    const nsfw = parseInt(req.query.nsfw || '0');
    const lyric = req.query.lyric || '';
    const offset = (currentPage - 1) * PAGE_SIZE;
    const username = config.auth ? req.user.name : 'admin';
    const shuffleSeed = req.query.seed ? req.query.seed : 7;

    try {
      const query = () => db.lyricFilter(lyric, db.nsfwFilter(nsfw, db.getWorksBy({username: username})));
      const totalCount = await query().count('id as count');

      let works = null;

      if (order === 'random') {
        // 随机排序+分页 hack
        works = await query().offset(offset).limit(PAGE_SIZE).orderBy(db.knex.raw('id % ?', shuffleSeed));
      } else if (order === 'betterRandom') {
        // 随心听专用，不支持分页
        works = await query().limit(1).orderBy(db.knex.raw('random()'));
      } else {
        works = await query().offset(offset).limit(PAGE_SIZE).orderBy(order, sort)
        .orderBy([{ column: 'release', order: 'desc'}, { column: 'id', order: 'desc' }]);
      }

      works = normalize(works);
      await applyLocalWorkDisplayTitles(works);
    
      res.send({
        works,
        pagination: {
          currentPage,
          pageSize: PAGE_SIZE,
          totalCount: totalCount[0]['count']
        }
      });
    } catch(err) {
      res.status(500).send({error: '服务器错误'});
      console.error(err);
      // next(err);
    }
});

// GET name of a circle/tag/VA
router.get('/:field(circle|tag|va)s/:id',
  param('field').isIn(['circle', 'tag', 'va']),
  (req, res, next) => {
    // In case regex matching goes wrong
    if(!isValidRequest(req, res)) return;

    return db.getMetadata({field: req.params.field, id: req.params.id})
      .then(item => {
        if (item) {
          res.send(item); 
        } else {
          const errorMessage= {
            'circle': `社团${req.params.id}不存在`,
            'tag': `标签${req.params.id}不存在`,
            'va': `声优${req.params.id}不存在`
          };
          res.status(404).send({error: errorMessage[req.params.field]});
        }
      })
      .catch(err => next(err));
});

// eslint-disable-next-line no-unused-vars
router.get('/search', async (req, res, next) => {
  // const keyword = req.params.keyword ? req.params.keyword.trim() : '';
  const keyword = req.query.keyword ? req.query.keyword.trim() : '';
  const isAdvance = 1 === parseInt(req.query.isAdvance || "0") // 是否开启高级搜索模式

  const currentPage = parseInt(req.query.page) || 1;
  // 通过 "音声id, 贩卖日, 用户评价， 售出数, 评论数量, 价格, 平均评价, 全年龄新作" 排序
  // ['id', 'release', 'rating', 'dl_count', 'review_count', 'price', 'rate_average_2dp', 'nsfw']
  const order = req.query.order || 'release';
  const sort = req.query.sort || 'desc';
  const nsfw = parseInt(req.query.nsfw || '0'); 
  const lyric = req.query.lyric || '';
  const offset = (currentPage - 1) * PAGE_SIZE;
  const username = config.auth ? req.user.name : 'admin';
  const shuffleSeed = req.query.seed ? req.query.seed : 7;
  
  try {
    await db.ensureAsmrOneTagIndex();
    let query = null;
    if (isAdvance) {
      // 临时测试，如果keyword是json字符串，则强制进入高级测试内容
      const conditions = JSON.parse(keyword);
      // console.warn(`in advance mode(page = ${currentPage}), search for: `, conditions)
      query = () => db.lyricFilter(lyric, db.nsfwFilter(nsfw, 
        db.advanceSearch(conditions, username)
      ))
    } else {
      // console.warn("normal keyword search, keyword = ", keyword)
      query = () => db.lyricFilter(lyric, db.nsfwFilter(nsfw, db.getWorksByKeyWord({keyword: keyword, username: username})));
    }

    const totalCount = await query().count('id as count');

    let works = null;

    if (order === 'random') {
      works = await query().offset(offset).limit(PAGE_SIZE).orderBy(db.knex.raw('id % ?', shuffleSeed));
    } else {
      works = await query().offset(offset).limit(PAGE_SIZE).orderBy(order, sort)
        .orderBy([{ column: 'release', order: 'desc'}, { column: 'id', order: 'desc' }]);
    }

    works = normalize(works);
    await applyLocalWorkDisplayTitles(works);

    res.send({
      works,
      pagination: {
        currentPage,
        pageSize: PAGE_SIZE,
        totalCount: totalCount[0]['count']
      }
    });
  } catch(err) {
    res.status(500).send({error: '查询过程中出错'});
    console.error(err);
    // next(err);
  }
});

// GET list of work ids, restricted by circle/tag/VA
router.get('/:field(circle|tag|va)s/:id/works',
  param('field').isIn(['circle', 'tag', 'va']),
  // eslint-disable-next-line no-unused-vars
  async (req, res, next) => {
    // In case regex matching goes wrong
    if(!isValidRequest(req, res)) return;

    const currentPage = parseInt(req.query.page) || 1;
    // 通过 "音声id, 贩卖日, 用户评价, 售出数, 评论数量, 价格, 平均评价, 全年龄新作" 排序
    // ['id', 'release', 'rating', 'dl_count', 'review_count', 'price', 'rate_average_2dp, 'nsfw']
    const order = req.query.order || 'release';
    const sort = req.query.sort || 'desc'; // ['desc', 'asc]
    const nsfw = parseInt(req.query.nsfw || '0'); 
    const lyric = req.query.lyric || '';
    const offset = (currentPage - 1) * PAGE_SIZE;
    const username = config.auth ? req.user.name : 'admin';
    const shuffleSeed = req.query.seed ? req.query.seed : 7;

    try {
      const query = () => db.lyricFilter(lyric, db.nsfwFilter(nsfw, db.getWorksBy({id: req.params.id, field: req.params.field, username: username})));
      const totalCount = await query().count('id as count');

      let works = null;

      if (order === 'random') {
        works = await query().offset(offset).limit(PAGE_SIZE).orderBy(db.knex.raw('id % ?', shuffleSeed));
      } else {
        works = await query().offset(offset).limit(PAGE_SIZE).orderBy(order, sort)
        .orderBy([{ column: 'release', order: 'desc'}, { column: 'id', order: 'desc' }]);
      }

      works = normalize(works);
      await applyLocalWorkDisplayTitles(works);

      res.send({
        works,
        pagination: {
          currentPage,
          pageSize: PAGE_SIZE,
          totalCount: totalCount[0]['count']
        }
      });
    } catch(err) {
      res.status(500).send({error: '查询过程中出错'});
      console.error(err);
      // next(err);
    }
});

// GET list of circles/tags/VAs
router.get('/:field(circle|tag|va)s/',
  param('field').isIn(['circle', 'tag', 'va']),
  (req, res, next) => {
    // In case regex matching goes wrong
    if(!isValidRequest(req, res)) return;

    const field = req.params.field;
    db.getLabels(field)
      .orderBy(`name`, 'asc')
      .then(list => res.send(list))
      .catch(err => next(err));
});

// 刷新单个作品文件夹中的文件信息记录，例如音频文件发生变动后，通过这个请求重新扫描音频文件时长
router.post('/work/scan/:id',
  param('id').isInt(),
  async function(req, res) {
    if(!isValidRequest(req, res)) return;

    const work_id = parseInt(req.params.id);
    try {
      const work = await db.knex('t_work')
        .select('root_folder', 'dir', 'lyric_status', 'memo')
        .where('id', '=', work_id)
        .first();
      const rootFolder = config.rootFolders.find(rootFolder => rootFolder.name === work.root_folder);
      if (!rootFolder) {
        res.status(500).send({error: "扫描作品文件失败，没有找到rootFolder: " + work.root_folder})
        return;
      }
      const memo = await scrapeWorkMemo(work_id, path.join(rootFolder.path, work.dir), JSON.parse(work.memo));
      await db.setWorkMemo(work_id, memo);
      await db.updateWorkLocalLyricStatus(memo.isContainLyric, work.lyric_status, work_id); // 尝试更新歌词状态
      res.send({ memo });
    } catch (err) {
      console.error(err);
      res.status(500).send({error: "重试翻译任务失败：" + err.message})
    }
  } 
)

module.exports = router;
