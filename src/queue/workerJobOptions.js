const appConfig = require("../config");

function getJobAttempts() {
  return Math.max(1, appConfig.workers?.jobAttempts ?? 3);
}

function getJobBackoffDelayMs() {
  return Math.max(100, appConfig.workers?.jobBackoffDelayMs ?? 5000);
}

function workerBackoff() {
  return { type: "exponential", delay: getJobBackoffDelayMs() };
}

function defaultWorkerJobOptions(overrides = {}) {
  return {
    removeOnComplete: 200,
    removeOnFail: 500,
    attempts: getJobAttempts(),
    backoff: workerBackoff(),
    ...overrides,
  };
}

function coordinatorWorkerJobOptions(overrides = {}) {
  return {
    removeOnComplete: 50,
    removeOnFail: 100,
    attempts: getJobAttempts(),
    backoff: workerBackoff(),
    ...overrides,
  };
}

/** Debounced webhook coordinator jobs */
function webhookWorkerJobOptions(overrides = {}) {
  return {
    removeOnComplete: true,
    removeOnFail: true,
    attempts: getJobAttempts(),
    backoff: workerBackoff(),
    ...overrides,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepBackoff(attemptIndex) {
  const delay = getJobBackoffDelayMs() * 2 ** Math.max(0, attemptIndex);
  await sleep(delay);
}

module.exports = {
  getJobAttempts,
  getJobBackoffDelayMs,
  workerBackoff,
  defaultWorkerJobOptions,
  coordinatorWorkerJobOptions,
  webhookWorkerJobOptions,
  sleepBackoff,
};
