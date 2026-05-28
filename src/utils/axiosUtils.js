const axios = require('axios');

const defaultTimeout = 20000;
const defaultRetries = 2; // total attempts = 1 + retries

const instance = axios.create({
  timeout: defaultTimeout,
  headers: {
    'Content-Type': 'application/json',
  },
});

instance.interceptors.response.use(
  (response) => response,
  (error) => Promise.reject(error)
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error) {
  const status = error?.response?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;

  const code = error?.code;
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN'
  );
}

async function withRetry(fn, { retries = defaultRetries, baseDelayMs = 250 } = {}) {
  let attempt = 0;
  // attempts: 0..retries (inclusive)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryableError(err)) throw err;

      const delay = baseDelayMs * Math.pow(2, attempt); // 250, 500...
      attempt += 1;
      await sleep(delay);
    }
  }
}

/**
 * Reusable GET – returns response.data by default.
 * @param {string} url
 * @param {import('axios').AxiosRequestConfig} [config]
 * @returns {Promise<unknown>} response.data
 */
async function get(url, headers = {}, config = {}) {
  const response = await withRetry(
    () => instance.get(url, { ...config, headers }),
    config?.retry
  );
  return response.data;
}

/**
 * Reusable POST – returns response.data by default.
 * @param {string} url
 * @param {unknown} [data]
 * @param {import('axios').AxiosRequestConfig} [config]
 * @returns {Promise<unknown>} response.data
 */
async function post(url, data, headers = {}, config = {}) {
  const response = await (config?.retry
    ? withRetry(() => instance.post(url, data, { ...config, headers }), config.retry)
    : instance.post(url, data, { ...config, headers }));
  return response.data;
}

/**
 * POST multipart/form-data using Node's built-in FormData (no `form-data` npm package).
 * Avoids `instance` default JSON Content-Type so axios can set the multipart boundary.
 * @param {string} url
 * @param {FormData} form
 * @param {Record<string, string>} [headers]
 * @returns {Promise<unknown>}
 */
async function postFormData(url, form, headers = {}) {
  const response = await axios.post(url, form, {
    timeout: defaultTimeout,
    headers: {
      Accept: 'application/json',
      ...headers,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return response.data;
}

/**
 * Reusable PUT – returns response.data by default.
 * @param {string} url
 * @param {unknown} [data]
 * @param {import('axios').AxiosRequestConfig} [config]
 * @returns {Promise<unknown>} response.data
 */
async function put(url, data, config = {}) {
  const response = await (config?.retry
    ? withRetry(() => instance.put(url, data, config), config.retry)
    : instance.put(url, data, config));
  return response.data;
}

/**
 * Reusable PATCH – returns response.data by default.
 * @param {string} url
 * @param {unknown} [data]
 * @param {import('axios').AxiosRequestConfig} [config]
 * @returns {Promise<unknown>} response.data
 */
async function patch(url, data, config = {}) {
  const response = await (config?.retry
    ? withRetry(() => instance.patch(url, data, config), config.retry)
    : instance.patch(url, data, config));
  return response.data;
}

/**
 * Reusable DELETE – returns response.data by default.
 * Same header shape as {@link get}: second arg is plain headers, not full Axios config.
 * @param {string} url
 * @param {Record<string, string>} [headers]
 * @param {import('axios').AxiosRequestConfig} [config]
 * @returns {Promise<unknown>} response.data
 */
async function del(url, headers = {}, config = {}) {
  const axiosConfig = { ...config, headers };
  const response = await (config?.retry
    ? withRetry(() => instance.delete(url, axiosConfig), config.retry)
    : instance.delete(url, axiosConfig));
  return response.data;
}

module.exports = {
  get,
  post,
  postFormData,
  put,
  patch,
  del,
  instance,
};
