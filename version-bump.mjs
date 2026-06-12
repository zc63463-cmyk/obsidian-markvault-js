import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.argv[2];
if (!targetVersion) {
  console.error("Usage: node version-bump.mjs <version>");
  process.exit(1);
}

readFileSync("manifest.json", "utf8");
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
const { versions } = JSON.parse(readFileSync("versions.json", "utf8"));

versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify({ ...JSON.parse(readFileSync("versions.json", "utf8")), ...{ [targetVersion]: minAppVersion } }, null, "\t"));

console.log(`Bumped version to ${targetVersion}`);
