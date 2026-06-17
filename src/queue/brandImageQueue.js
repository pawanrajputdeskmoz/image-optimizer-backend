const { Queue } = require("bullmq");
const { createRedisConnection } = require("../db/redis");

const QUEUE_NAME = "brand-image-optimization";
const connection = createRedisConnection("bullmq-brand-image-optimization");

const brandImageQueue = new Queue(QUEUE_NAME, { connection });

module.exports = {
  QUEUE_NAME,
  brandImageQueue,
};
