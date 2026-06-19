exports.up = async function(knex) {
  if (!await knex.schema.hasTable('t_external_work_review')) {
    await knex.schema.createTable('t_external_work_review', function(table) {
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
      table.index(['work_id', 'source'], 't_external_work_review_work_source_index');
    });
  }

  if (!await knex.schema.hasTable('t_external_work_review_translation')) {
    await knex.schema.createTable('t_external_work_review_translation', function(table) {
      table.string('source').notNullable();
      table.string('source_review_id').notNullable();
      table.string('target_language').notNullable();
      table.text('translated_title');
      table.text('translated_body');
      table.string('provider');
      table.string('model');
      table.boolean('confirmed').notNullable().defaultTo(false);
      table.timestamps(true, true);
      table.primary(['source', 'source_review_id', 'target_language']);
    });
  }
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('t_external_work_review_translation');
  await knex.schema.dropTableIfExists('t_external_work_review');
};
