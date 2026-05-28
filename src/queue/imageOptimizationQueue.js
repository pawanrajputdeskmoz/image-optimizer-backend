const { Queue } = require("bullmq");
const { createRedisConnection } = require("../db/redis");

const QUEUE_NAME = "image-optimization";
const connection = createRedisConnection("bullmq-image-optimization");

const imageOptimizationQueue = new Queue(QUEUE_NAME, { connection });

module.exports = {
  QUEUE_NAME,
  imageOptimizationQueue,
};
