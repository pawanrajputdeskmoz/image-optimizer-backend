const crypto = require("node:crypto");

const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!password || !storedHash || !String(storedHash).includes(":")) {
    return false;
  }

  const [salt, expectedHash] = String(storedHash).split(":");
  if (!salt || !expectedHash) {
    return false;
  }

  const actualHash = crypto
    .scryptSync(String(password), salt, SCRYPT_KEYLEN)
    .toString("hex");

  const expectedBuf = Buffer.from(expectedHash, "hex");
  const actualBuf = Buffer.from(actualHash, "hex");

  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

module.exports = { hashPassword, verifyPassword };
