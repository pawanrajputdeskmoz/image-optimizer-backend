const fs = require("fs");
const path = require("path");

const models = {};
const basename = path.basename(__filename);

fs.readdirSync(__dirname)
  .filter((file) => {
    return (
      file !== basename &&
      file !== "constants.js" &&
      file.endsWith(".js")
    );
  })
  .forEach((file) => {
    const model = require(path.join(__dirname, file));

    // If default export
    if (model?.default) {
      models[model.default.name || file.replace(".js", "")] = model.default;
    } else {
      // Named export OR module.exports
      const name = file.replace(".js", "");
      models[name] = model;
    }
  });

module.exports = models;