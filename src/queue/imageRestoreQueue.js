const { Queue } = require("bullmq");
const { createRedisConnection } = require("../db/redis");

const QUEUE_NAME = "image-restore";
const connection = createRedisConnection("bullmq-image-restore");

const imageRestoreQueue = new Queue(QUEUE_NAME, { connection });

module.exports = {
  QUEUE_NAME,
  imageRestoreQueue,
};
