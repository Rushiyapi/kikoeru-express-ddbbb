const cheerio = require('cheerio'); // 解析器

const axios = require('./axios'); // 数据请求
const { nameToUUID, hasLetter } = require('./utils');
const { formatID } = require('../filesystem/utils');

let asmrOneApiUrl = '';

function getCurrentLocalizedName(item) {
  if (!item || !item.i18n) return item && item.name;

  return item.i18n['zh-cn'] && item.i18n['zh-cn'].name
    || item.i18n['zh-tw'] && item.i18n['zh-tw'].name
    || item.i18n['ja-jp'] && item.i18n['ja-jp'].name
    || item.i18n['en-us'] && item.i18n['en-us'].name
    || item.name;
}

function normalizeLocalizedNames(items) {
  (items || []).forEach((item) => {
    const name = getCurrentLocalizedName(item);
    if (name) item.name = name;
  });
}

async function updateAsmrOneApiUrl() {
  const url = `https://asmr.one/index.html`;
  try {
    const response = await axios.retryGet(url, {
      retry: {},
      headers: { "cookie": 'locale=zh-cn' },
    });

    const $ = cheerio.load(response.data)

    asmrOneApiUrl = $('link[rel="preconnect"][as="fetch"]').attr('href');

    console.log('asmr one api url = ', asmrOneApiUrl);
  } catch {
    console.warn("获取ASMROne api url失败");
  }
}

async function scrapeWorkMetadataFromAsmrOne(id) {
  if (asmrOneApiUrl === '') await updateAsmrOneApiUrl();

  const rjcode = formatID(id);
  const url = `https://api.asmr-200.com/api/workInfo/${rjcode}`;
  const response = await axios.retryGet(url, {
    retry: {},
    headers: { "cookie": 'locale=zh-cn' },
  });
  // console.log(`RJ${rjcode} asmr one data = `, response.data);
  // const data = JSON.parse(response.data);
  const data = response.data;

  // va的UUID可能和asmrOne不同，这里做一次强制转换
  data.vas.forEach((va) => {
    va.id = nameToUUID(va.name);
  });
  normalizeLocalizedNames(data.tags);
  normalizeLocalizedNames(data.vas);

  return data;
}

module.exports = {
  scrapeWorkMetadataFromAsmrOne,
}
