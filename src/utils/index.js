const fs = require("fs");
const path = require("path");

const utils = {};
const basename = path.basename(__filename);

fs.readdirSync(__dirname)
  .filter((file) => file !== basename && file.endsWith(".js"))
  .forEach((file) => {
    const mod = require(path.join(__dirname, file));

    // If default export (future-proofing)
    if (mod?.default) {
      utils[mod.default.name || file.replace(".js", "")] = mod.default;
      return;
    }

    // If module.exports is an object, merge keys (common for util modules)
    if (mod && typeof mod === "object" && !Array.isArray(mod)) {
      Object.assign(utils, mod);
      return;
    }

    // Otherwise export under filename
    utils[file.replace(".js", "")] = mod;
  }); 

module.exports = utils;  

  