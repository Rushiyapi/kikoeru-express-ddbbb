const axios = require('./axios');
const { formatID } = require('../filesystem/utils');
const { scrapeWorkMetadataFromAsmrOne } = require('./asmrOne');

const DLSITE_REVIEW_SOURCE = 'dlsite';
const DEFAULT_MAX_PAGES = 30;
const DEFAULT_REVIEW_CACHE_LIMIT = 10;
const DLSITE_LOCALES = ['ja-jp', 'zh-cn', 'zh-tw', 'en-us', 'ko-kr'];

function toInt(value, fallback = null) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function countMatches(text, pattern) {
  const matches = String(text || '').match(pattern);
  return matches ? matches.length : 0;
}

function getScriptStats(text) {
  const value = String(text || '');
  return {
    cjkCount: countMatches(value, /[\u3400-\u9fff]/g),
    kanaCount: countMatches(value, /[\u3040-\u30ff]/g),
    hangulCount: countMatches(value, /[\uac00-\ud7af]/g),
    latinCount: countMatches(value, /[A-Za-z]/g)
  };
}

function isReviewTextLikelyChinese(text) {
  const stats = getScriptStats(text);
  if (stats.cjkCount < 20) return false;
  if (stats.hangulCount >= 6) return false;

  const cjkAndKana = stats.cjkCount + stats.kanaCount;
  const kanaRatio = cjkAndKana ? stats.kanaCount / cjkAndKana : 0;
  if (stats.kanaCount <= Math.max(8, Math.floor(stats.cjkCount * 0.08)) && kanaRatio <= 0.08) {
    return true;
  }

  if (stats.cjkCount >= 100 && stats.kanaCount <= Math.floor(stats.cjkCount * 0.16) && kanaRatio <= 0.16) {
    return true;
  }

  return stats.kanaCount <= 16 && stats.cjkCount >= stats.kanaCount * 3;
}

function detectReviewLanguage(title, body) {
  const bodyStats = getScriptStats(body);

  if (bodyStats.hangulCount >= 6) {
    return 'ko';
  }

  if (isReviewTextLikelyChinese(body)) {
    return 'zh-cn';
  }

  if (bodyStats.kanaCount >= 3) {
    return 'ja';
  }

  if (bodyStats.latinCount > bodyStats.cjkCount + bodyStats.kanaCount) {
    return 'en';
  }

  const textStats = getScriptStats(`${title || ''}\n${body || ''}`);
  if (textStats.hangulCount >= 6) return 'ko';
  if (isReviewTextLikelyChinese(`${title || ''}\n${body || ''}`)) return 'zh-cn';
  if (textStats.kanaCount >= 3) return 'ja';
  if (textStats.latinCount > textStats.cjkCount + textStats.kanaCount) return 'en';

  return 'ja';
}

function normalizeWorkno(value) {
  const raw = String(value || '').trim().toUpperCase();
  const match = raw.match(/RJ\d{6,10}/);
  if (match) return match[0];
  const digits = raw.replace(/\D/g, '');
  return digits ? `RJ${formatID(digits)}` : '';
}

function languageFromDlsiteCode(code) {
  switch (String(code || '').toUpperCase()) {
    case 'JPN':
      return 'ja';
    case 'CHI_HANS':
      return 'zh-cn';
    case 'CHI_HANT':
      return 'zh-tw';
    case 'KO_KR':
      return 'ko';
    case 'ENG':
      return 'en';
    default:
      return '';
  }
}

function addWorkno(target, workno, metadata = {}) {
  const normalized = normalizeWorkno(workno);
  if (!normalized) return;

  const existing = target.get(normalized) || {};
  target.set(normalized, Object.assign({}, existing, metadata));
}

function addTranslationWorknos(target, translationInfo) {
  if (!translationInfo) return;

  addWorkno(target, translationInfo.original_workno, {
    edition_role: 'original',
    edition_language: languageFromDlsiteCode(translationInfo.lang)
  });
  addWorkno(target, translationInfo.parent_workno, {
    edition_role: 'parent',
    edition_language: languageFromDlsiteCode(translationInfo.lang)
  });
  (translationInfo.child_worknos || []).forEach((workno) => {
    addWorkno(target, workno, {
      edition_role: 'child',
      edition_language: languageFromDlsiteCode(translationInfo.lang)
    });
  });
}

async function fetchDlsiteProductInfo(workno, locale) {
  const normalized = normalizeWorkno(workno);
  const url = `https://www.dlsite.com/maniax-touch/product/info/ajax?product_id=${normalized}`;
  const response = await axios.retryGet(url, {
    retry: {},
    headers: {
      'user-agent': 'Mozilla/5.0',
      cookie: `locale=${locale}`
    }
  });

  return response.data && response.data[normalized];
}

function getReviewCountFromProductInfo(data) {
  const value = data && data.review_count;
  const parsed = parseInt(String(value || '0').replace(/,/g, ''), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function getReviewCacheTargetCount(reviewCount, limit = DEFAULT_REVIEW_CACHE_LIMIT) {
  const count = toInt(reviewCount, 0);
  const max = toInt(limit, DEFAULT_REVIEW_CACHE_LIMIT);
  return Math.max(0, Math.min(count, max));
}

async function resolveDlsiteReviewWorknos(workId) {
  const initialWorkno = normalizeWorkno(`RJ${formatID(workId)}`);
  const worknos = new Map();

  addWorkno(worknos, initialWorkno, { edition_role: 'current' });

  for (const locale of DLSITE_LOCALES) {
    try {
      const data = await fetchDlsiteProductInfo(initialWorkno, locale);
      addTranslationWorknos(worknos, data && data.translation_info);
    } catch {
      // Keep the current workno even if one localized metadata request fails.
    }
  }

  for (const workno of Array.from(worknos.keys())) {
    try {
      const data = await fetchDlsiteProductInfo(workno, 'zh-cn');
      addTranslationWorknos(worknos, data && data.translation_info);
    } catch {
      // Some parent worknos are metadata-only wrappers. They can still be skipped safely.
    }
  }

  try {
    const asmrOneData = await scrapeWorkMetadataFromAsmrOne(workId);
    (asmrOneData.language_editions || []).forEach((edition) => {
      addWorkno(worknos, edition.workno, {
        edition_role: 'language_edition',
        edition_language: languageFromDlsiteCode(edition.lang),
        edition_label: edition.label || ''
      });
    });
    (asmrOneData.other_language_editions_in_db || []).forEach((edition) => {
      addWorkno(worknos, edition.source_id, {
        edition_role: edition.is_original ? 'original' : 'language_edition',
        edition_language: edition.lang || '',
        edition_label: edition.lang || ''
      });
    });
  } catch {
    // asmr.one is supplementary; DLsite translation_info remains the baseline.
  }

  return Array.from(worknos.entries()).map(([workno, metadata]) => ({
    workno,
    metadata
  }));
}

function findExactCountSubset(items, expectedCount) {
  const expected = toInt(expectedCount, 0);
  if (!expected) return null;

  const positives = items.filter(item => item.review_count > 0);
  const bySum = new Map();
  bySum.set(0, []);

  for (const item of positives) {
    const currentSums = Array.from(bySum.keys());
    for (const sum of currentSums) {
      const nextSum = sum + item.review_count;
      if (nextSum > expected || bySum.has(nextSum)) continue;
      const subset = bySum.get(sum).concat(item);
      if (nextSum === expected) return subset;
      bySum.set(nextSum, subset);
    }
  }

  return null;
}

async function resolveDlsiteReviewWorknosForExpectedCount(workId, expectedCount) {
  const reviewWorknos = await resolveDlsiteReviewWorknos(workId);
  const expected = toInt(expectedCount, 0);
  if (!expected || reviewWorknos.length <= 1) return reviewWorknos;

  const withCounts = [];
  for (const item of reviewWorknos) {
    try {
      const data = await fetchDlsiteProductInfo(item.workno, 'zh-cn');
      withCounts.push(Object.assign({}, item, {
        review_count: getReviewCountFromProductInfo(data)
      }));
    } catch {
      withCounts.push(Object.assign({}, item, {
        review_count: 0
      }));
    }
  }

  const exactSubset = findExactCountSubset(withCounts, expected);
  if (exactSubset && exactSubset.length) {
    return exactSubset.map(item => ({
      workno: item.workno,
      metadata: Object.assign({}, item.metadata, {
        expected_review_count: expected,
        source_review_count: item.review_count,
        review_count_match_strategy: 'exact_subset'
      })
    }));
  }

  return reviewWorknos;
}

function normalizeDlsiteReview(raw, workId, sourceWorkno, editionMetadata = {}, sortMetadata = {}) {
  const sourceReviewId = String(raw.member_review_id || '').trim();
  if (!sourceReviewId) return null;

  const workno = normalizeWorkno(raw.workno || sourceWorkno || `RJ${formatID(workId)}`);
  const title = raw.review_title || '';
  const body = raw.review_text || '';
  const detectedLanguage = detectReviewLanguage(title, body);
  const editionLanguage = editionMetadata.edition_language && !/[\u4e00-\u9fff]/.test(editionMetadata.edition_language)
    ? editionMetadata.edition_language
    : '';

  return {
    source: DLSITE_REVIEW_SOURCE,
    source_review_id: sourceReviewId,
    work_id: workId,
    source_work_id: workno,
    language: detectedLanguage || editionLanguage || '',
    author: raw.nick_name || '',
    rating: toInt(raw.rate, null),
    title,
    body,
    posted_at: raw.entry_date || raw.regist_date || '',
    source_url: `https://www.dlsite.com/maniax/work/reviewlist/=/product_id/${workno}.html`,
    metadata: {
      reviewer_id: raw.reviewer_id || '',
      good_review: toInt(raw.good_review, 0),
      bad_review: toInt(raw.bad_review, 0),
      recommend: raw.recommend === '1',
      spoiler: raw.spoiler === '1',
      purchased: raw.is_purchased === '1',
      reviewer_rank: raw.reviewer_rank || '',
      reviewer_status: raw.reviewer_status || '',
      popularity: toInt(raw.popularity, null),
      rate_num: toInt(raw.rate_num, null),
      top_sort_key: toInt(raw.top_sort_key, null),
      genre: raw.genre || {},
      edition_role: editionMetadata.edition_role || '',
      edition_language: editionLanguage,
      edition_label: editionMetadata.edition_label || '',
      dlsite_best_order: sortMetadata.dlsite_best_order,
      source_work_order: sortMetadata.source_work_order,
      page: sortMetadata.page,
      page_index: sortMetadata.page_index
    }
  };
}

async function fetchDlsiteReviewPage(workno, page, locale = 'zh-cn') {
  const pageSuffix = page > 1 ? `/page/${page}` : '';
  const url = `https://www.dlsite.com/maniax/api/review/=/product_id/${normalizeWorkno(workno)}${pageSuffix}`;
  const response = await axios.retryGet(url, {
    retry: {},
    headers: {
      'user-agent': 'Mozilla/5.0',
      cookie: `locale=${locale}`
    }
  });

  if (!response.data || response.data.is_success === false) {
    throw new Error(response.data && response.data.error_msg || 'DLsite review API failed');
  }

  return response.data;
}

async function scrapeWorkReviews(workId, options = {}) {
  const maxPages = options.maxPages || DEFAULT_MAX_PAGES;
  const limitReviews = typeof options.limitReviews === 'number'
    ? options.limitReviews
    : getReviewCacheTargetCount(options.expectedReviewCount, DEFAULT_REVIEW_CACHE_LIMIT) || DEFAULT_REVIEW_CACHE_LIMIT;
  const reviewWorknos = options.worknos
    ? options.worknos.map((workno) => ({ workno: normalizeWorkno(workno), metadata: {} })).filter((item) => item.workno)
    : options.expectedReviewCount
      ? await resolveDlsiteReviewWorknosForExpectedCount(workId, options.expectedReviewCount)
      : await resolveDlsiteReviewWorknos(workId);
  const output = [];
  const seen = new Set();

  for (let sourceWorkIndex = 0; sourceWorkIndex < reviewWorknos.length; sourceWorkIndex += 1) {
    const reviewWorkno = reviewWorknos[sourceWorkIndex];
    for (let page = 1; page <= maxPages; page += 1) {
      const data = await fetchDlsiteReviewPage(reviewWorkno.workno, page);
      const list = data.review_list || [];

      list.forEach((raw, pageIndex) => {
        const review = normalizeDlsiteReview(raw, workId, reviewWorkno.workno, reviewWorkno.metadata, {
          source_work_order: sourceWorkIndex,
          dlsite_best_order: sourceWorkIndex * 100000 + (page - 1) * Number(data.limit || 10) + pageIndex,
          page,
          page_index: pageIndex
        });
        if (!review || !review.body) return;

        const key = `${review.source}:${review.source_review_id}`;
        if (seen.has(key)) return;
        seen.add(key);
        output.push(review);
      });

      if (limitReviews && output.length >= limitReviews) return output.slice(0, limitReviews);
      if (!list.length || list.length < Number(data.limit || 10)) break;
    }
  }

  return limitReviews ? output.slice(0, limitReviews) : output;
}

module.exports = {
  scrapeWorkReviews,
  resolveDlsiteReviewWorknos,
  resolveDlsiteReviewWorknosForExpectedCount,
  getReviewCacheTargetCount,
  isReviewTextLikelyChinese,
  DEFAULT_REVIEW_CACHE_LIMIT,
  DLSITE_REVIEW_SOURCE
};
