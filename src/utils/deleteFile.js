// function to delete file from system

const fs = require("fs");
const path = require("path");

exports.deleteFile = async (filePath) => {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    throw error;
  }
};