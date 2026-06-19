/* eslint-disable node/no-unpublished-require */
process.env.FREEZE_CONFIG_FILE = true;
process.env.NODE_ENV = 'test';

const chai = require('chai');
const cheerio = require('cheerio');
const expect = chai.expect;
const { extractRJCodeFromFolderName, formatID } = require('../filesystem/utils');
const {
  extractCoverIdsFromDLsitePage,
  extractRJIds,
  isDLsiteAdultAgeRating,
  aggregateDynamicEditionCounts,
  extractSupportedLanguagesFromDLsitePage,
  parseDlsiteLanguageOptions
} = require('../scraper/dlsite');

describe('RJ code handling', function() {
  it('extracts 6 to 8 digit RJ codes from folder names', function() {
    expect(extractRJCodeFromFolderName('[circle][RJ352228] title')).to.equal('352228');
    expect(extractRJCodeFromFolderName('[circle][RJ1175934] title')).to.equal('1175934');
    expect(extractRJCodeFromFolderName('[circle][RJ01175934] title')).to.equal('01175934');
    expect(extractRJCodeFromFolderName('[circle][rj01175934] title')).to.equal('01175934');
  });

  it('does not silently truncate overly long RJ-looking numbers', function() {
    expect(extractRJCodeFromFolderName('[circle][RJ011759349] title')).to.equal(null);
  });

  it('keeps DLsite formatting for old and new RJ ids', function() {
    expect(formatID(352228)).to.equal('352228');
    expect(formatID(1175934)).to.equal('01175934');
  });

  it('extracts cover source ids from DLsite image metadata', function() {
    const html = `
      <html>
        <head>
          <meta property="og:image" content="https://img.dlsite.jp/modpub/images2/work/doujin/RJ01173000/RJ01172409_img_main.jpg">
        </head>
        <body>
          <img src="//img.dlsite.jp/modpub/images2/parts/RJ01173000/RJ01172409/sample.jpg">
        </body>
      </html>
    `;
    const $ = cheerio.load(html);

    expect(extractCoverIdsFromDLsitePage($)).to.deep.equal(['01172409']);
  });

  it('extracts RJ ids without accepting extra trailing digits', function() {
    expect(extractRJIds('RJ01175934_img_main.jpg RJ352228_img_main.jpg')).to.deep.equal(['01175934', '352228']);
    expect(extractRJIds('RJ011759349_img_main.jpg')).to.deep.equal([]);
  });

  it('extracts same-work supported languages from DLsite option codes', function() {
    const languages = parseDlsiteLanguageOptions('SND#ENG#CHI#CHI_HANS#CHI_HANT#JPN#DLP#REV#TRI');
    expect(languages.map(item => item.lang)).to.deep.equal(['ENG', 'CHI_HANS', 'CHI_HANT', 'JPN']);
    expect(languages.every(item => item.source === 'same_work')).to.equal(true);
  });

  it('extracts same-work supported languages from the DLsite page outline', function() {
    const html = `
      <table id="work_outline">
        <tr>
          <th>対応言語</th>
          <td>
            <div class="work_genre">
              <a href="/options/CHI_HANS/from/icon.work"><span class="icon_CHI_HANS" title="中国語(簡体字)">中国語(簡体字)</span></a>
              <a href="/options/CHI_HANT/from/icon.work"><span class="icon_CHI_HANT" title="中国語(繁体字)">中国語(繁体字)</span></a>
              <a href="/options/JPN/from/icon.work"><span class="icon_JPN" title="日本語">日本語</span></a>
              <a href="/options/ENG/from/icon.work"><span class="icon_ENG" title="英語">英語</span></a>
            </div>
          </td>
        </tr>
      </table>
    `;
    const $ = cheerio.load(html);

    expect(extractSupportedLanguagesFromDLsitePage($).map(item => item.lang))
      .to.deep.equal(['CHI_HANS', 'CHI_HANT', 'JPN', 'ENG']);
  });

  it('recognizes current DLsite adult age rating labels', function() {
    expect(isDLsiteAdultAgeRating('R18')).to.equal(true);
    expect(isDLsiteAdultAgeRating('DLsite 同人 - R18')).to.equal(true);
    expect(isDLsiteAdultAgeRating('18禁')).to.equal(true);
    expect(isDLsiteAdultAgeRating('adult')).to.equal(true);
    expect(isDLsiteAdultAgeRating('rating: adult')).to.equal(true);
    expect(isDLsiteAdultAgeRating(3)).to.equal(true);
    expect(isDLsiteAdultAgeRating('全年龄')).to.equal(false);
    expect(isDLsiteAdultAgeRating(1)).to.equal(false);
  });
  it('aggregates review counts across language editions without duplicating shared rating buckets', function() {
    const sharedDetail = [
      { review_point: 1, count: 4 },
      { review_point: 2, count: 4 },
      { review_point: 3, count: 47 },
      { review_point: 4, count: 186 },
      { review_point: 5, count: 2166 }
    ];
    const aggregate = aggregateDynamicEditionCounts(
      ['RJ01305650', 'RJ01324192', 'RJ01324536'],
      {
        RJ01305650: {
          review_count: 30,
          rate_count_detail: sharedDetail
        },
        RJ01324192: {
          review_count: 0,
          rate_count_detail: sharedDetail
        },
        RJ01324536: {
          review_count: 1,
          rate_count_detail: [
            { review_point: 1, count: 0 },
            { review_point: 2, count: 0 },
            { review_point: 3, count: 0 },
            { review_point: 4, count: 0 },
            { review_point: 5, count: 5 }
          ]
        }
      }
    );

    expect(aggregate.review_count).to.equal(31);
    expect(aggregate.rate_count).to.equal(2412);
    expect(aggregate.rate_average_2dp).to.equal(4.87);
    expect(aggregate.rate_count_detail.map(item => item.count)).to.deep.equal([4, 4, 47, 186, 2171]);
  });
});
