const cheerio = require('cheerio'); // 解析器

const axios = require('./axios'); // 数据请求
const { nameToUUID, hasLetter } = require('./utils');
const { scrapeWorkMetadataFromHVDB } = require('./hvdb');
const { formatID } = require('../filesystem/utils');

const extractRJIds = text => {
  const ids = [];
  const regexp = /RJ(\d{6,8})(?!\d)/ig;
  let match;

  while ((match = regexp.exec(String(text || ''))) !== null) {
    ids.push(match[1]);
  }

  return ids;
};

const unique = list => Array.from(new Set(list));

const toNumber = value => {
  if (value === null || value === undefined || value === '') return 0;
  return Number(String(value).replace(/,/g, '')) || 0;
};

const normalizeDlCountItems = items => (items || []).map(item => ({
  workno: item.workno,
  label: item.display_label || item.label || item.lang || item.workno,
  lang: item.lang,
  dl_count: toNumber(item.dl_count)
})).filter(item => item.workno || item.label);

const normalizeWorkno = workno => {
  const id = String(workno || '').replace(/^RJ/i, '');
  return id ? `RJ${id}` : '';
};

const DLSITE_LANGUAGE_LABELS = {
  JPN: '\u65e5\u672c\u8a9e',
  CHI: '\u4e2d\u6587',
  CHI_HANS: '\u7b80\u4f53\u4e2d\u6587',
  CHI_HANT: '\u7e41\u9ad4\u4e2d\u6587',
  ENG: '\u82f1\u8a9e',
  KO_KR: '\u97d3\u56fd\u8a9e',
  THA: '\u30bf\u30a4\u8a9e',
  SPA: '\u30b9\u30da\u30a4\u30f3\u8a9e',
  GER: '\u30c9\u30a4\u30c4\u8a9e',
  FRE: '\u30d5\u30e9\u30f3\u30b9\u8a9e',
  ITA: '\u30a4\u30bf\u30ea\u30a2\u8a9e',
  POR: '\u30dd\u30eb\u30c8\u30ac\u30eb\u8a9e',
  IND: '\u30a4\u30f3\u30c9\u30cd\u30b7\u30a2\u8a9e',
  VIE: '\u30d9\u30c8\u30ca\u30e0\u8a9e'
};

const normalizeDlsiteLanguageCode = value => String(value || '')
  .trim()
  .toUpperCase()
  .replace(/-/g, '_');

const normalizeDlsiteLanguageItem = item => {
  const lang = normalizeDlsiteLanguageCode(item && item.lang);
  if (!lang || !DLSITE_LANGUAGE_LABELS[lang]) return null;

  const normalized = {
    lang,
    label: item.label || DLSITE_LANGUAGE_LABELS[lang],
    source: item.source || 'same_work'
  };
  const workno = normalizeWorkno(item.workno);
  if (workno) normalized.workno = workno;
  return normalized;
};

const mergeDlsiteLanguages = (...lists) => {
  const merged = [];
  const seen = new Set();

  lists.forEach((list) => {
    (list || []).forEach((item) => {
      const normalized = normalizeDlsiteLanguageItem(item);
      if (!normalized) return;
      const key = [
        normalized.lang,
        normalized.workno || '',
        normalized.source || ''
      ].join(':');
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(normalized);
    });
  });

  const hasSpecificChinese = merged.some(item => item.lang === 'CHI_HANS' || item.lang === 'CHI_HANT');
  return hasSpecificChinese
    ? merged.filter(item => item.lang !== 'CHI')
    : merged;
};

const parseDlsiteLanguageOptions = options => mergeDlsiteLanguages(
  String(options || '')
    .split('#')
    .map(code => ({
      lang: code,
      source: 'same_work'
    }))
);

const normalizeDlsiteLanguageEditions = editions => mergeDlsiteLanguages(
  (editions || []).map(edition => ({
    workno: edition.workno,
    lang: edition.lang,
    label: edition.display_label || edition.label,
    source: 'language_edition'
  }))
);

const extractSupportedLanguagesFromDLsitePage = $ => {
  const candidates = [];
  const headerPattern = /(\u5bfe\u5fdc\u8a00\u8a9e|\u5bfe\u5fdc\u8a9e\u8a00|\u652f\u6301\u7684\u8bed\u8a00|Supported languages)/i;

  $('#work_outline tr').each((i, tr) => {
    const row = $(tr);
    const headerText = row.children('th').text().trim();
    if (!headerPattern.test(headerText)) return;

    row.children('td').find('a, span').each((j, element) => {
      const el = $(element);
      const text = [
        el.attr('class'),
        el.attr('href'),
        el.attr('title'),
        el.text()
      ].filter(Boolean).join(' ');
      const match = text.match(/(?:icon_|options\/)(CHI_HANS|CHI_HANT|KO_KR|JPN|ENG|THA|SPA|GER|FRE|ITA|POR|IND|VIE|CHI)\b/i);
      if (match) {
        candidates.push({
          lang: match[1],
          label: el.attr('title') || el.text().trim(),
          source: 'same_work'
        });
      }
    });
  });

  return mergeDlsiteLanguages(candidates);
};

const normalizeDlsiteLanguagesFromProductJson = data => mergeDlsiteLanguages(
  parseDlsiteLanguageOptions(data && data.options),
  normalizeDlsiteLanguageEditions(data && data.language_editions)
);

const normalizeRateCountDetail = detail => {
  const buckets = [1, 2, 3, 4, 5].map(reviewPoint => ({
    review_point: reviewPoint,
    count: 0,
    ratio: 0
  }));

  (detail || []).forEach((item) => {
    const reviewPoint = toNumber(item.review_point);
    if (reviewPoint >= 1 && reviewPoint <= 5) {
      buckets[reviewPoint - 1].count = toNumber(item.count);
    }
  });

  return buckets;
};

const rateCountDetailTotal = detail => normalizeRateCountDetail(detail)
  .reduce((sum, item) => sum + item.count, 0);

const rateCountDetailSignature = detail => normalizeRateCountDetail(detail)
  .map(item => item.count)
  .join(',');

const aggregateDynamicEditionCounts = (worknos, dynamicMap) => {
  const uniqueWorknos = unique((worknos || []).map(normalizeWorkno).filter(Boolean));
  const rateDetailSignatures = new Set();
  const rateCountDetail = normalizeRateCountDetail([]);

  let reviewCount = 0;
  let ratePointTotal = 0;
  let rateCount = 0;

  uniqueWorknos.forEach((workno) => {
    const data = dynamicMap[workno];
    if (!data) return;

    reviewCount += toNumber(data.review_count);

    const detail = normalizeRateCountDetail(data.rate_count_detail);
    const detailTotal = rateCountDetailTotal(detail);
    if (!detailTotal) return;

    const signature = rateCountDetailSignature(detail);
    if (rateDetailSignatures.has(signature)) return;
    rateDetailSignatures.add(signature);

    detail.forEach((item, index) => {
      rateCountDetail[index].count += item.count;
      ratePointTotal += item.review_point * item.count;
      rateCount += item.count;
    });
  });

  if (rateCount) {
    rateCountDetail.forEach((item) => {
      item.ratio = Math.floor(item.count * 100 / rateCount);
    });
  }

  return {
    review_count: reviewCount,
    rate_count: rateCount,
    rate_average_2dp: rateCount ? Number((ratePointTotal / rateCount).toFixed(2)) : 0.0,
    rate_count_detail: rateCountDetail
  };
};

const requestDynamicWorkMap = rjcodes => {
  const productIds = rjcodes.map(rjcode => `RJ${rjcode}`).join(',');
  const url = `https://www.dlsite.com/maniax-touch/product/info/ajax?product_id=${productIds}`;
  return axios.retryGet(url, { retry: {} }).then(response => response.data || {});
};

const scrapeLanguageEditionsFromDLsiteJson = (rjcode, language = 'zh-cn') => {
  const url = `https://www.dlsite.com/maniax/api/=/product.json?workno=RJ${rjcode}`;
  return axios.retryGet(url, {
    retry: {},
    headers: { "cookie": `locale=${language}` }
  })
    .then(response => response.data && response.data[0])
    .then(data => ({
      editions: data && data.language_editions ? data.language_editions : [],
      translationInfo: data && data.translation_info ? data.translation_info : {},
      dlsiteLanguages: normalizeDlsiteLanguagesFromProductJson(data)
    }));
};

const applyRatingFallback = (work, data) => {
  if (!data) return;
  if (work.rate_average_2dp && work.rate_count) return;

  if (!work.rate_average_2dp && data.rate_average_2dp) {
    work.rate_average_2dp = data.rate_average_2dp;
  }
  if (!work.rate_count && data.rate_count) {
    work.rate_count = data.rate_count;
  }
  if ((!work.rate_count_detail || !work.rate_count_detail.length) && data.rate_count_detail) {
    work.rate_count_detail = data.rate_count_detail;
  }
  if (!work.review_count && data.review_count) {
    work.review_count = data.review_count;
  }
};

const enrichDynamicMetadataWithLanguageEditions = async (work, rjcode, data) => {
  const needsLanguageCounts = !work.dl_count_items.length;
  const needsRatingFallback = !work.rate_average_2dp || !work.rate_count;

  const editionInfo = await scrapeLanguageEditionsFromDLsiteJson(rjcode);
  const editions = editionInfo.editions || [];
  const currentWorkno = normalizeWorkno(rjcode);
  work.dlsite_languages = mergeDlsiteLanguages(
    work.dlsite_languages,
    editionInfo.dlsiteLanguages
  );
  if (!editions.length) {
    if (needsRatingFallback) applyRatingFallback(work, data);
    return work;
  }

  const editionRjcodes = editions
    .map(edition => String(edition.workno || '').replace(/^RJ/i, ''))
    .filter(Boolean);
  const dynamicMap = await requestDynamicWorkMap(editionRjcodes);
  if (currentWorkno && data) dynamicMap[currentWorkno] = data;

  if (needsLanguageCounts) {
    work.dl_count_items = editions.map(edition => {
      const editionData = dynamicMap[edition.workno] || {};
      return {
        workno: edition.workno,
        label: edition.display_label || edition.label || edition.lang || edition.workno,
        lang: edition.lang,
        dl_count: toNumber(editionData.dl_count)
      };
    }).filter(item => item.workno || item.label);

    const total = work.dl_count_items.reduce((sum, item) => sum + toNumber(item.dl_count), 0);
    if (total) work.dl_count = total;
  }

  const aggregate = aggregateDynamicEditionCounts(
    editions.map(edition => edition.workno).concat(currentWorkno),
    dynamicMap
  );
  if (aggregate.review_count) work.review_count = aggregate.review_count;
  if (aggregate.rate_count) {
    work.rate_count = aggregate.rate_count;
    work.rate_average_2dp = aggregate.rate_average_2dp;
    work.rate_count_detail = aggregate.rate_count_detail;
  }

  const originalWorkno = editionInfo.translationInfo && editionInfo.translationInfo.original_workno;
  const originalData = originalWorkno ? dynamicMap[originalWorkno] : null;
  const ratedCandidates = Object.keys(dynamicMap)
    .map(key => dynamicMap[key])
    .filter(Boolean)
    .filter(item => item.rate_average_2dp || item.rate_count)
    .sort((a, b) => toNumber(b.rate_count) - toNumber(a.rate_count));
  const fallbackData = originalData && (originalData.rate_average_2dp || originalData.rate_count)
    ? originalData
    : ratedCandidates[0];
  applyRatingFallback(work, fallbackData || data);
  if (fallbackData) {
    work.rate_average_2dp = work.rate_average_2dp || fallbackData.rate_average_2dp || 0.0;
    work.rate_count = work.rate_count || fallbackData.rate_count || 0;
    work.rate_count_detail = work.rate_count_detail && work.rate_count_detail.length
      ? work.rate_count_detail
      : (fallbackData.rate_count_detail || []);
    work.review_count = work.review_count || fallbackData.review_count || 0;
  }
  if ((!work.rate_average_2dp || !work.rate_count) && originalWorkno) {
    const originalMap = await requestDynamicWorkMap([String(originalWorkno).replace(/^RJ/i, '')]);
    const originalFallback = originalMap[originalWorkno];
    applyRatingFallback(work, originalFallback);
    if (originalFallback) {
      work.rate_average_2dp = work.rate_average_2dp || originalFallback.rate_average_2dp || 0.0;
      work.rate_count = work.rate_count || originalFallback.rate_count || 0;
      work.rate_count_detail = work.rate_count_detail && work.rate_count_detail.length
        ? work.rate_count_detail
        : (originalFallback.rate_count_detail || []);
      work.review_count = work.review_count || originalFallback.review_count || 0;
    }
  }
  return work;
};

const isDLsiteAdultAgeRating = value => {
  const text = String(value || '').trim().toLowerCase();
  return text === '3'
    || text === 'r18'
    || text === 'r-18'
    || text === '18禁'
    || text === 'adult'
    || text.indexOf('adult') !== -1
    || /\br-?18\b/.test(text)
    || text.indexOf('18') !== -1 && text.indexOf('禁') !== -1;
};

const extractCoverWorkIds = text => {
  const ids = [];
  const patterns = [
    /\/RJ\d{6,8}\/RJ(\d{6,8})(?=[/_])/ig,
    /RJ(\d{6,8})_img_/ig,
  ];

  patterns.forEach((regexp) => {
    let match;
    while ((match = regexp.exec(String(text || ''))) !== null) {
      ids.push(match[1]);
    }
  });

  return ids.length ? ids : extractRJIds(text);
};

const extractCoverIdsFromDLsitePage = $ => {
  const imageRefs = [];
  const ogImage = $('meta[property="og:image"]').attr('content');

  if (ogImage) imageRefs.push(ogImage);

  $('img').each((i, e) => {
    if (!e.attribs) return;
    ['src', 'data-src', 'srcset'].forEach((attr) => {
      if (e.attribs[attr]) imageRefs.push(e.attribs[attr]);
    });
  });

  return unique(imageRefs.flatMap(extractCoverWorkIds));
};

const getDLsitePageAgeRatingText = $ => {
  const candidates = [
    $('meta[name="rating"]').attr('content'),
    $('title').text(),
    $('meta[name="description"]').attr('content'),
  ];

  $('#work_outline tr').each((i, tr) => {
    candidates.push($(tr).children('td').text());
  });

  return candidates.filter(Boolean).join(' ');
};

const scrapeNSFWFromDLsite = (id, language) => new Promise((resolve, reject) => {
  const rjcode = formatID(id);
  const url = `https://www.dlsite.com/maniax/work/=/product_id/RJ${rjcode}.html`;
  const COOKIE_LOCALE = `locale=${language}`;

  axios.retryGet(url, {
    retry: {},
    headers: { "cookie": COOKIE_LOCALE }
  })
    .then(response => response.data)
    .then(async (data) => {
      const $ = cheerio.load(data);
      resolve({
        id,
        nsfw: isDLsiteAdultAgeRating(getDLsitePageAgeRatingText($))
      });
    })
    .catch(reject);
});

/**
 * Scrapes static work metadata from public DLsite page HTML.
 * @param {number} id Work id.
 * @param {String} language 标签语言，'ja-jp', 'zh-tw' or 'zh-cn'，默认'zh-cn'
 */
const scrapeStaticWorkMetadataFromDLsite = (id, language) => new Promise((resolve, reject) => {
  const rjcode = formatID(id);
  const url = `https://www.dlsite.com/maniax/work/=/product_id/RJ${rjcode}.html`;

  const work = { id, tags: [], vas: [] };
  let AGE_RATINGS, VA, GENRE, RELEASE, SERIES, COOKIE_LOCALE;
  switch(language) {
    case 'ja-jp':
      COOKIE_LOCALE = 'locale=ja-jp';
      AGE_RATINGS = '年齢指定';
      GENRE = 'ジャンル';
      VA = '声優';
      RELEASE = '販売日';
      SERIES = 'シリーズ名';
      break;
    case 'zh-tw':
      COOKIE_LOCALE = 'locale=zh-tw';
      AGE_RATINGS = '年齡指定';
      GENRE = '分類';
      VA = '聲優';
      RELEASE = '販賣日';
      SERIES = '系列名';
      break;
    default:
      COOKIE_LOCALE = 'locale=zh-cn';
      AGE_RATINGS = '年龄指定';
      GENRE = '分类';
      VA = '声优';
      RELEASE = '贩卖日';
      SERIES = '系列名';
  }

  axios.retryGet(url, {
    retry: {},
    headers: { "cookie": COOKIE_LOCALE } // 自定义请求头
  })
    .then(response => response.data)
    .then((data) => { // 解析
      // 转换成 jQuery 对象
      const $ = cheerio.load(data);
      work.dlsite_languages = extractSupportedLanguagesFromDLsitePage($);

      // 标题
      work.title = $('meta[property="og:title"]').attr('content');
      // fallback
      if (work.title === undefined) {
        work.title = $(`a[href="${url}"] span`).text();
      }
      
      // 'xxxxx [circle_name] | DLsite' => 'xxxxx'
      const titlePattern = / \[.+\] \| DLsite$/;
      work.title = work.title.replace(titlePattern, '');

      // 社团
      const circleElement = $('span[class="maker_name"]').children('a');
      const circleUrl = circleElement.attr('href');
      const circleName = circleElement.text();
      work.circle = (circleUrl && circleName)
        ? { id: parseInt(circleUrl.substr(-10,5)), name: circleName }
        : {};

      const workOutline = $('#work_outline');
      // NSFW
      const R18 = workOutline.children('tbody').children('tr').children('th')
        .filter(function() {
          return $(this).text() === AGE_RATINGS;
        }).parent().children('td').find('span:first').text();
      work.nsfw = isDLsiteAdultAgeRating(R18);

      // 贩卖日 (YYYY-MM-DD)
      const release = workOutline.children('tbody').children('tr').children('th')
        .filter(function() {
          return [RELEASE, '发售日', '贩卖日', '販売日', '販賣日'].includes($(this).text().trim());
        }).parent().children('td').text().replace(/[^0-9]/ig,'');
      work.release = (release.length >= 8)
        ? `${release.slice(0, 4)}-${release.slice(4, 6)}-${release.slice(6, 8)}`
        : '';

      // 系列
      const seriesElement = workOutline.children('tbody').children('tr').children('th')
        .filter(function() {
          return $(this).text() === SERIES;
        }).parent().children('td').children('a');
      if (seriesElement.length) {
        const seriesUrl = seriesElement.attr('href');
        if (seriesUrl.match(/SRI(\d{10})/)) {
          work.series = {
            id: parseInt(seriesUrl.match(/SRI(\d{10})/)[1]),
            name: seriesElement.text()
          };
        }
      }
      
      // 标签
        workOutline.children('tbody').children('tr').children('th')
        .filter(function() {
          return $(this).text() === GENRE;
        }).parent().children('td').children('div').children('a').each(function() {
          const tagUrl = $(this).attr('href');
          const tagName = $(this).text();
          if (tagUrl.match(/genre\/(\d{3})/)) {
            work.tags.push({
              id: parseInt(tagUrl.match(/genre\/(\d{3})/)[1]),
              name: tagName
            });
          }
        });
      
      // 声优
        workOutline.children('tbody').children('tr').children('th')
        .filter(function() {
          return $(this).text() === VA;
        }).parent().children('td').children('a').each(function() {
          const vaName = $(this).text().trim();
          work.vas.push({
            id: nameToUUID(vaName),
            name: vaName
          });
        });

      if (work.tags.length === 0 && work.vas.length === 0) {
        reject(new Error('Couldn\'t parse data from DLsite work page.'));
      }
    })
    .then(() => {
      if (work.vas.length === 0) { 
        // 从 DLsite 抓不到声优信息时, 从 HVDB 抓取声优信息
        scrapeWorkMetadataFromHVDB(id)
          .then((metadata) => {
            if (metadata.vas.length <= 1) {
              // N/A
              work.vas = metadata.vas;
            } else {
              // 过滤掉英文的声优名
              metadata.vas.forEach(function(va) {
                if (!hasLetter(va.name)) {
                  work.vas.push(va);
                }
              });
            }
  
            resolve(work);
          })
          .catch((error) => {
            reject(new Error(error.message));
          });
      } else {
        resolve(work);
      } 
    })
    .catch((error) => {
      if (error.response) {
        // 请求已发出，但服务器响应的状态码不在 2xx 范围内
        reject(new Error(`Couldn't request work page HTML (${url}), received: ${error.response.status}.`));
      } else {
        reject(error);
      }
    });
});

const scrapeStaticWorkMetadataFromDLsiteJson = (id, language) => new Promise((resolve, reject) => {
  const rjcode = formatID(id);
  const url = `https://www.dlsite.com/maniax/api/=/product.json?workno=RJ${rjcode}`;

  const work = { id, tags: [], vas: [] };
  const COOKIE_LOCALE = `locale=${language}`;
  axios.retryGet(url, {
    retry: {},
    headers: { "cookie": COOKIE_LOCALE } // 自定义请求头
  })
    .then(response => response.data)
    .then((jsonObj) => { // 解析
      const data = jsonObj[0];
      work.dlsite_languages = normalizeDlsiteLanguagesFromProductJson(data);

      // 标题
      work.title = data.product_name;

      // 'xxxxx [circle_name] | DLsite' => 'xxxxx'
      const titlePattern = / \[.+\] \| DLsite$/;
      work.title = work.title.replace(titlePattern, '');

      // 社团
      work.circle = {
        id: parseInt(data.maker_id.replace("RG", "")),
        name: data.maker_name
      };

      // NSFW
      work.nsfw = isDLsiteAdultAgeRating(data.age_category || data.age_category_string); // 3/adult for R18, 1 for all ages, 2 for R15

      // 贩卖日 (YYYY-MM-DD)
      const releaseMatch = /\d{4}-\d{2}-\d{2}/.exec(data.regist_date || '');
      work.release = releaseMatch ? releaseMatch[0] : '';

      // 忽略系列，外面都没有用这个，有些作品也根本没有系列
      
      // 标签
      work.tags = data.genres.map((v) => ({
        id: v.id,
        name: v.name
      }));
      
      // 声优
      work.vas = data.creaters.voice_by.map((v) => ({
        id: nameToUUID(v.name),
        name: v.name
      }));

      if (work.tags.length === 0 && work.vas.length === 0) {
        reject(new Error('Couldn\'t parse data from DLsite work page.'));
      }
    })
    .then(() => {
      if (work.vas.length === 0) { 
        // 从 DLsite 抓不到声优信息时, 从 HVDB 抓取声优信息
        scrapeWorkMetadataFromHVDB(id)
          .then((metadata) => {
            if (metadata.vas.length <= 1) {
              // N/A
              work.vas = metadata.vas;
            } else {
              // 过滤掉英文的声优名
              metadata.vas.forEach(function(va) {
                if (!hasLetter(va.name)) {
                  work.vas.push(va);
                }
              });
            }
  
            resolve(work);
          })
          .catch((error) => {
            reject(new Error(error.message));
          });
      } else {
        resolve(work);
      } 
    })
    .catch((error) => {
      if (error.response) {
        // 请求已发出，但服务器响应的状态码不在 2xx 范围内
        reject(new Error(`Couldn't request work json (${url}), received: ${error.response.status}.`));
      } else {
        reject(error);
      }
    });
});

/**
 * Requests dynamic work metadata from public DLsite API.
 * @param {number} id Work id.
 */
const scrapeDynamicWorkMetadataFromDLsite = id => new Promise((resolve, reject) => {
  const rjcode = formatID(id);
  const url = `https://www.dlsite.com/maniax-touch/product/info/ajax?product_id=RJ${rjcode}`;

  axios.retryGet(url, { retry: {} })
    .then(response => response.data[`RJ${rjcode}`])
    .then(async (data) => {
      if (!data) {
        throw new Error(`Couldn't parse dynamic data from DLsite response for RJ${rjcode}.`);
      }
      const work = {};
      work.rate_average_2dp = data.rate_average_2dp ? data.rate_average_2dp : 0.0;
      work.dl_count = data.dl_count ? data.dl_count : "0"; // 售出数
      work.rate_average_2dp = data.rate_average_2dp ? data.rate_average_2dp : 0.0; // 平均评价
      work.rate_count = data.rate_count ? data.rate_count : 0; // 评价数量
      work.rate_count_detail = data.rate_count_detail; // 评价分布明细
      work.review_count = data.review_count; // 评论数量
      work.price = data.price; // 价格
      work.dl_count_items = normalizeDlCountItems(data.dl_count_items);
      work.dl_count = data.dl_count_total ? toNumber(data.dl_count_total) : toNumber(data.dl_count);
      await enrichDynamicMetadataWithLanguageEditions(work, rjcode, data);
      if (data.rank.length) {
        work.rank = data.rank; // 成绩
      }
      console.log(`[RJ${rjcode}] 成功从 DLSite 抓取Dynamic元数据...`);
      resolve(work);
    })
    .catch((error) => {
      if (error.response) {
        // 请求已发出，但服务器响应的状态码不在 2xx 范围内
        reject(new Error(`Couldn't request work page HTML (${url}), received: ${error.response.status}.`));
      } else {
        reject(error);
      }
    });
});

/**
 * Scrapes work metadata from public DLsite page HTML.
 * @param {number} id Work id.
 * @param {String} language 标签语言，'ja-jp', 'zh-tw' or 'zh-cn'，默认'zh-cn'
 */
const scrapeWorkMetadataFromDLsite = (id, language) => {
  return Promise.all([
    scrapeStaticWorkMetadataFromDLsite(id, language),
    scrapeDynamicWorkMetadataFromDLsite(id)
  ])
    .then((res) => {
      const work = {};
      return Object.assign(work, res[0], res[1]);
    });
};

/**
 * Scrapes work metadata from public DLsite project json api.
 * https://www.dlsite.com/maniax/api/=/product.json?workno=RJ00000000
 * @param {number} id Work id.
 * @param {String} language 标签语言，'ja-jp', 'zh-tw' or 'zh-cn'，默认'zh-cn'
 */
const scrapeWorkMetadataFromDLsiteJson = (id, language) => {
  return Promise.all([
    scrapeStaticWorkMetadataFromDLsiteJson(id, language),
    scrapeDynamicWorkMetadataFromDLsite(id)
  ])
    .then((res) => {
      const work = {};
      return Object.assign(work, res[0], res[1]);
    });
};

/**
 * Scrapes the source cover work id which holds the cover image, 
 * since some translated work(id_translated) in dlsite do not has its own cover, 
 * but share the cover from original cover work(id_source).
 * @param {number} id_translated Work id.
 * @param {String} language 标签语言，'ja-jp', 'zh-tw' or 'zh-cn'，默认'zh-cn'
 */
const scrapeCoverIdForTranslatedWorkFromDLsite = (id_translated, language) => new Promise((resolve, reject) => {
  const rjcode = formatID(id_translated);
  const url = `https://www.dlsite.com/maniax/work/=/product_id/RJ${rjcode}.html`;

  let COOKIE_LOCALE;
  switch(language) {
    case 'ja-jp':
      COOKIE_LOCALE = 'locale=ja-jp';
      break;
    case 'zh-tw':
      COOKIE_LOCALE = 'locale=zh-tw';
      break;
    default:
      COOKIE_LOCALE = 'locale=zh-cn';
  }

  axios.retryGet(url, {
    retry: {},
    headers: { "cookie": COOKIE_LOCALE } // 自定义请求头
  })
    .then(response => response.data)
    .then((data) => { // 解析
      // 转换成 jQuery 对象
      const $ = cheerio.load(data);

      // 所有关联的作品id，包括日文、各种语种翻译的作品id
      const linked_id_list = $('.work_edition_linklist.type_trans a.work_edition_linklist_item').get()
        .map(l => l.attribs['href'])
        .filter(h => typeof h === 'string')
        .flatMap(extractRJIds);
      
      let isNoImgMain = false;

      // 当前页面中使用到的一些图像链接id，用来判断当前作品的cover究竟来自哪一个作品
      const possible_image_id_list = $('img').get()
        .flatMap(e => e.attribs ? [e.attribs['src'], e.attribs['data-src'], e.attribs['srcset']] : [])
        .filter(h => typeof h === 'string')
        .map(h => {
          // 检查一下有没有 不包含图像的链接，一般srcset都是作品封面图，
          // 但是dlsite有些作品没有图片，比如RJ166657
          if (h.includes('no_img_main')) {
            isNoImgMain = true;
          }

          return extractCoverWorkIds(h);
        })
        .flat();

      const page_cover_id_list = extractCoverIdsFromDLsitePage($);
      const hit_id_list = linked_id_list.filter(id => possible_image_id_list.includes(id));

      const result = {
        coverFromId: page_cover_id_list.length > 0
          ? page_cover_id_list[0]
          : (hit_id_list.length > 0 ? hit_id_list[0] : id_translated),
        isNoImgMain,
      };
      resolve(result);
    })
    .catch((error) => {
      if (error.response) {
        // 请求已发出，但服务器响应的状态码不在 2xx 范围内
        reject(new Error(`Couldn't request work page HTML (${url}), received: ${error.response.status}.`));
      } else {
        reject(error);
      }
    });
});

module.exports = {
  scrapeStaticWorkMetadataFromDLsite,
  scrapeStaticWorkMetadataFromDLsiteJson,
  scrapeNSFWFromDLsite,
  scrapeWorkMetadataFromDLsite,
  scrapeWorkMetadataFromDLsiteJson,
  scrapeDynamicWorkMetadataFromDLsite,
  scrapeCoverIdForTranslatedWorkFromDLsite,
  extractCoverIdsFromDLsitePage,
  extractRJIds,
  isDLsiteAdultAgeRating,
  aggregateDynamicEditionCounts,
  extractSupportedLanguagesFromDLsitePage,
  mergeDlsiteLanguages,
  normalizeDlsiteLanguagesFromProductJson,
  parseDlsiteLanguageOptions,
};
