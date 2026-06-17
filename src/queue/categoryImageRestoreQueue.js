const { Queue } = require("bullmq");
const { createRedisConnection } = require("../db/redis");

const QUEUE_NAME = "category-image-restore";
const connection = createRedisConnection("bullmq-category-image-restore");

const categoryImageRestoreQueue = new Queue(QUEUE_NAME, { connection });

module.exports = {
  QUEUE_NAME,
  categoryImageRestoreQueue,
};
