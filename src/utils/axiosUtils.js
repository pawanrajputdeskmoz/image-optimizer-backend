const axios = require('axios');

const defaultTimeout = 20000;

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

/**
 * Reusable GET – returns response.data by default.
 * @param {string} url
 * @param {import('axios').AxiosRequestConfig} [config]
 * @returns {Promise<unknown>} response.data
 */
async function get(url, headers = {}, config = {}) {
  const response = await instance.get(url, { ...config, headers });
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
  const response = await instance.post(url, data, { ...config, headers });
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
  const response = await instance.put(url, data, config);
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
  const response = await instance.patch(url, data, config);
  return response.data;
}

/**
 * Reusable DELETE – returns response.data by default.
 * @param {string} url
 * @param {import('axios').AxiosRequestConfig} [config]
 * @returns {Promise<unknown>} response.data
 */
async function del(url, config = {}) {
  const response = await instance.delete(url, config);
  return response.data;
}

module.exports = {
  get,
  post,
  put,
  patch,
  del,
  instance,
};
