const { Queue } = require("bullmq");
const { createRedisConnection } = require("../db/redis");

const QUEUE_NAME = "home-image-optimization";
const connection = createRedisConnection("bullmq-home-image-optimization");

const homeImageQueue = new Queue(QUEUE_NAME, { connection });

module.exports = {
  QUEUE_NAME,
  homeImageQueue,
};
