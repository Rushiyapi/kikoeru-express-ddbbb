exports.up = async function(knex) {
  if (!await knex.schema.hasTable('t_asmrone_tag')) {
    await knex.schema.createTable('t_asmrone_tag', function(table) {
      table.integer('id').primary();
      table.string('name').notNullable();
      table.timestamps(true, true);
    });
  }

  if (!await knex.schema.hasTable('r_asmrone_tag_work')) {
    await knex.schema.createTable('r_asmrone_tag_work', function(table) {
      table.integer('tag_id');
      table.integer('work_id');
      table.integer('vote_status');
      table.integer('upvote').notNullable().defaultTo(0);
      table.integer('downvote').notNullable().defaultTo(0);
      table.timestamps(true, true);
      table.foreign('tag_id').references('id').inTable('t_asmrone_tag').onUpdate('CASCADE').onDelete('CASCADE');
      table.foreign('work_id').references('id').inTable('t_work').onUpdate('CASCADE').onDelete('CASCADE');
      table.primary(['tag_id', 'work_id']);
    });
  }
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('r_asmrone_tag_work');
  await knex.schema.dropTableIfExists('t_asmrone_tag');
};
