const { Queue } = require("bullmq");
const { createRedisConnection } = require("../db/redis");

const QUEUE_NAME = "brand-image-restore";
const connection = createRedisConnection("bullmq-brand-image-restore");

const brandImageRestoreQueue = new Queue(QUEUE_NAME, { connection });

module.exports = {
  QUEUE_NAME,
  brandImageRestoreQueue,
};
