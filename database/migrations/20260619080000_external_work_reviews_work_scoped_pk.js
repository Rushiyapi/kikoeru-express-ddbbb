async function hasWorkScopedPrimaryKey(knex) {
  const tableInfo = await knex.raw('PRAGMA table_info(t_external_work_review)');
  const rows = Array.isArray(tableInfo) ? tableInfo : tableInfo && tableInfo[0] || [];
  const workIdColumn = rows.find(row => row.name === 'work_id');
  return Boolean(workIdColumn && workIdColumn.pk);
}

async function createWorkScopedReviewTable(knex, tableName, indexName) {
  await knex.schema.createTable(tableName, function(table) {
    table.string('source').notNullable();
    table.string('source_review_id').notNullable();
    table.integer('work_id').notNullable();
    table.string('source_work_id');
    table.string('language');
    table.string('author');
    table.integer('rating');
    table.text('title');
    table.text('body').notNullable();
    table.string('posted_at');
    table.string('source_url');
    table.text('metadata');
    table.timestamps(true, true);
    table.foreign('work_id').references('id').inTable('t_work').onUpdate('CASCADE').onDelete('CASCADE');
    table.primary(['source', 'source_review_id', 'work_id']);
    table.index(['work_id', 'source'], indexName);
  });
}

exports.up = async function(knex) {
  if (!await knex.schema.hasTable('t_external_work_review')) return;
  if (await hasWorkScopedPrimaryKey(knex)) return;

  await knex.transaction(async trx => {
    await createWorkScopedReviewTable(trx, 't_external_work_review_new', 't_external_work_review_work_source_index_new');
    await trx.raw(`
      INSERT OR IGNORE INTO t_external_work_review_new
        (source, source_review_id, work_id, source_work_id, language, author, rating, title, body, posted_at, source_url, metadata, created_at, updated_at)
      SELECT source, source_review_id, work_id, source_work_id, language, author, rating, title, body, posted_at, source_url, metadata, created_at, updated_at
      FROM t_external_work_review
    `);
    await trx.schema.dropTable('t_external_work_review');
    await trx.schema.renameTable('t_external_work_review_new', 't_external_work_review');
    await trx.raw('DROP INDEX IF EXISTS t_external_work_review_work_source_index_new');
    await trx.raw('CREATE INDEX IF NOT EXISTS t_external_work_review_work_source_index ON t_external_work_review (work_id, source)');
  });
};

exports.down = async function() {
  // Keep the work-scoped key. Reverting would collapse shared language-edition reviews.
};
