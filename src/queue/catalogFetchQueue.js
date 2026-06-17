const { Queue } = require("bullmq");
const { createRedisConnection } = require("../db/redis");

const QUEUE_NAME = "catalog-fetch";
const connection = createRedisConnection("bullmq-catalog-fetch");

const catalogFetchQueue = new Queue(QUEUE_NAME, { connection });

module.exports = {
  QUEUE_NAME,
  catalogFetchQueue,
};
