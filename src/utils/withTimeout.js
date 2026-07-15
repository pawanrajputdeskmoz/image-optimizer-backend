/**
 * Reject if promise does not settle within ms.
 */
function withTimeout(promise, ms, label = "Operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

module.exports = { withTimeout };
