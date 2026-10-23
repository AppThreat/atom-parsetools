const { readFileSync } = require("node:fs");
const path = require("node:path");

const configText = readFileSync(path.join(__dirname, "config.json"), "utf8");
const encoded = Buffer.from(configText).toString("base64");
const workingDir = process.cwd();

module.exports = { configText, encoded, workingDir };
