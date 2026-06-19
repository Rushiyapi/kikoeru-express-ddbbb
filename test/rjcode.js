/* eslint-disable node/no-unpublished-require */
process.env.FREEZE_CONFIG_FILE = true;
process.env.NODE_ENV = 'test';

const chai = require('chai');
const cheerio = require('cheerio');
const expect = chai.expect;
const { extractRJCodeFromFolderName, formatID } = require('../filesystem/utils');
const { extractCoverIdsFromDLsitePage, extractRJIds, isDLsiteAdultAgeRating } = require('../scraper/dlsite');

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
});
