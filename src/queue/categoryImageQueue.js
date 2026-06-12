const { Queue } = require("bullmq");
const { createRedisConnection } = require("../db/redis");

const QUEUE_NAME = "category-image-optimization";
const connection = createRedisConnection("bullmq-category-image-optimization");

const categoryImageQueue = new Queue(QUEUE_NAME, { connection });

module.exports = {
  QUEUE_NAME,
  categoryImageQueue,
};
