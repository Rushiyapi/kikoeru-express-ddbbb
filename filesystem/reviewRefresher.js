const db = require('../database/db');
const {
  scrapeWorkReviews,
  DLSITE_REVIEW_SOURCE,
  getReviewCacheTargetCount,
  withReviewCacheAttemptMetadata,
  isConfirmedShortReviewCache
} = require('../scraper/workReviews');
const { formatID } = require('./utils');

process.send = process.send || function () {};

const tasks = [];
const failedTasks = [];
const mainLogs = [];
const results = [];
let shouldExit = false;

const LOG = {
  finish(message) {
    console.log(` * ${message}`);
    process.send({
      event: 'SCAN_FINISHED',
      payload: { message }
    });
  },
  main: {
    __internal__(level, message) {
      console[level]('main log', message);
      mainLogs.push({ level, message });
      process.send({ event: 'SCAN_MAIN_LOGS', payload: { mainLogs } });
    },
    info(message) { this.__internal__('info', message); },
    warn(message) { this.__internal__('warn', message); },
    error(message) { this.__internal__('error', message); },
  },
  result: {
    add(rjcode, result, count) {
      results.push({ rjcode, result, count });
      process.send({
        event: 'SCAN_RESULTS',
        payload: { results }
      });
    }
  },
  task: {
    add(rjcode) {
      tasks.push({
        rjcode,
        result: null,
        logs: []
      });
      process.send({ event: 'SCAN_TASKS', payload: { tasks } });
    },
    remove(rjcode, result) {
      const index = tasks.findIndex(task => task.rjcode === rjcode);
      if (index === -1) return;

      const removedTask = tasks[index];
      removedTask.result = result;
      tasks.splice(index, 1);
      process.send({ event: 'SCAN_TASKS', payload: { tasks } });

      if (result === 'failed') {
        failedTasks.push(removedTask);
        process.send({ event: 'SCAN_FAILED_TASKS', payload: { failedTasks } });
      }
    },
    __internal__(rjcode, level, message) {
      console[level](`task[RJ${rjcode}] log`, message);
      const task = tasks.find(item => item.rjcode === rjcode);
      if (task) {
        task.logs.push({ level, message });
        process.send({ event: 'SCAN_TASKS', payload: { tasks } });
      }
    },
    info(rjcode, message) { this.__internal__(rjcode, 'info', message); },
    warn(rjcode, message) { this.__internal__(rjcode, 'warn', message); },
    error(rjcode, message) { this.__internal__(rjcode, 'error', message); },
  }
};

process.on('message', (message) => {
  if (message.emit === 'SCAN_INIT_STATE') {
    process.send({
      event: 'SCAN_INIT_STATE',
      payload: {
        tasks,
        failedTasks,
        mainLogs,
        results
      }
    });
  } else if (message.exit) {
    shouldExit = true;
    LOG.main.error('终止赏析正文更新进程。');
  }
});

function toNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function listReviewRefreshTargets() {
  await db.ensureWorkReviewTables();

  const cacheCountQuery = db.knex('t_external_work_review')
    .select('work_id')
    .count('* as cached_review_count')
    .where('source', DLSITE_REVIEW_SOURCE)
    .groupBy('work_id')
    .as('review_cache');

  const rows = await db.knex('t_work')
    .leftJoin(cacheCountQuery, 'review_cache.work_id', 't_work.id')
    .select([
      't_work.id',
      't_work.review_count',
      db.knex.raw('COALESCE(review_cache.cached_review_count, 0) AS cached_review_count')
    ])
    .where(function () {
      this.where('t_work.review_count', '>', 0)
        .orWhereNotNull('review_cache.cached_review_count');
    })
    .orderBy('t_work.id', 'desc');

  const candidates = rows
    .map(row => {
      const reviewCount = toNumber(row.review_count);
      return {
        id: row.id,
        review_count: reviewCount,
        cached_review_count: toNumber(row.cached_review_count),
        target_cached_review_count: getReviewCacheTargetCount(reviewCount)
      };
    })
    .filter(row => row.cached_review_count !== row.target_cached_review_count);

  const targets = [];
  for (const row of candidates) {
    if (row.cached_review_count > 0 && row.cached_review_count < row.target_cached_review_count) {
      const reviewState = await db.getExternalWorkReviewState(row.id);
      if (isConfirmedShortReviewCache(reviewState.items, row.target_cached_review_count)) continue;
    }
    targets.push(row);
  }

  return targets;
}

async function refreshOneWork(work, index, total) {
  const rjcode = formatID(work.id);
  LOG.task.add(rjcode);
  LOG.task.info(
    rjcode,
    `更新赏析正文 (${index}/${total})，元数据赏析数 ${work.review_count}，目标缓存 ${work.target_cached_review_count}，本地缓存 ${work.cached_review_count}`
  );

  try {
    const reviews = work.target_cached_review_count > 0
      ? await scrapeWorkReviews(work.id, {
        expectedReviewCount: work.review_count,
        limitReviews: work.target_cached_review_count
      })
      : [];
    const annotatedReviews = withReviewCacheAttemptMetadata(reviews, work.target_cached_review_count);
    await db.replaceExternalWorkReviews(work.id, annotatedReviews, [DLSITE_REVIEW_SOURCE]);
    const nextCount = reviews.length;
    const result = nextCount === work.target_cached_review_count || (nextCount > 0 && nextCount < work.target_cached_review_count)
      ? 'updated'
      : 'failed';

    if (nextCount > 0 && nextCount < work.target_cached_review_count) {
      LOG.task.warn(rjcode, `抓取完成但 DLsite 实际只返回 ${nextCount} 条，少于目标缓存 ${work.target_cached_review_count} 条；已按实际可抓数量缓存。`);
    } else if (result === 'failed') {
      LOG.task.warn(rjcode, `抓取完成但数量仍不一致：抓到 ${nextCount}，目标缓存 ${work.target_cached_review_count}，元数据赏析数 ${work.review_count}`);
    } else {
      LOG.task.info(rjcode, `赏析正文缓存完成：${nextCount} 条`);
    }

    LOG.task.remove(rjcode, result);
    LOG.result.add(rjcode, result, results.filter(item => item.result === result).length + 1);
    return result;
  } catch (error) {
    LOG.task.error(rjcode, `赏析正文更新失败: ${error.message}`);
    LOG.task.remove(rjcode, 'failed');
    LOG.result.add(rjcode, 'failed', results.filter(item => item.result === 'failed').length + 1);
    return 'failed';
  }
}

async function performReviewRefresh() {
  LOG.main.info('开始检查需要更新赏析正文的作品...');
  const targets = await listReviewRefreshTargets();
  LOG.main.info(`共 ${targets.length} 个作品需要更新赏析正文`);

  const counts = {
    updated: 0,
    failed: 0,
    skipped: 0
  };

  for (let index = 0; index < targets.length; index += 1) {
    if (shouldExit) {
      counts.skipped = targets.length - index;
      break;
    }

    const result = await refreshOneWork(targets[index], index + 1, targets.length);
    counts[result] += 1;
  }

  const message = `赏析正文更新完成: 更新 ${counts.updated} 个，失败 ${counts.failed} 个，跳过 ${counts.skipped} 个`;
  LOG.finish(message);
  await db.knex.destroy();
  if (counts.failed) process.exit(1);
}

performReviewRefresh()
  .then(() => process.exit(0))
  .catch(async (error) => {
    LOG.main.error(`赏析正文更新失败: ${error.message}`);
    try {
      await db.knex.destroy();
    } catch {
      // Ignore cleanup failures.
    }
    process.exit(1);
  });
