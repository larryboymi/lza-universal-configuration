#!/usr/bin/env node

/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const https = require("https");
const { URL } = require("url");

/**
 * Validates and parses command line arguments
 * @param {string[]} args - Command line arguments
 * @returns {{networkType: string, version: string, replacementsFile?: string, output: string}} Parsed arguments
 * @throws {Error} When required arguments are missing or invalid
 */
function validateArguments(args) {
  if (args.includes("-h") || args.includes("--help")) {
    showHelp();
    process.exit(0);
  }

  // Find network-type option
  let networkType;
  const nIndex = args.findIndex(
    (arg) => arg === "-n" || arg === "--network-type"
  );
  if (nIndex !== -1 && args[nIndex + 1]) {
    networkType = args[nIndex + 1];
  }

  // Find version option
  let version;
  const vIndex = args.findIndex((arg) => arg === "-v" || arg === "--version");
  if (vIndex !== -1 && args[vIndex + 1]) {
    version = args[vIndex + 1];
  }

  // Find replacements file option
  let replacementsFile;
  const rIndex = args.findIndex(
    (arg) => arg === "-r" || arg === "--replacements"
  );
  if (rIndex !== -1 && args[rIndex + 1]) {
    replacementsFile = args[rIndex + 1];
  }

  // Find output option
  let output;
  const oIndex = args.findIndex((arg) => arg === "-o" || arg === "--output");
  if (oIndex !== -1 && args[oIndex + 1]) {
    output = args[oIndex + 1];
  }

  // Find upload option
  const upload = args.includes("-u") || args.includes("--upload");

  if (!networkType) {
    throw new Error("Network type is required (-n or --network-type)");
  }

  if (!version) {
    throw new Error("Version is required (-v or --version)");
  }

  if (!output) {
    throw new Error("Output filename is required (-o or --output)");
  }

  if (!["hub-and-spoke", "shared-vpc"].includes(networkType)) {
    throw new Error("network-type must be either hub-and-spoke or shared-vpc");
  }

  return { networkType, version, replacementsFile, output, upload };
}

/**
 * Displays help information and usage instructions
 */
function showHelp() {
  console.log(`
Usage: node release-package.js [options]

Builds and uploads LZA Universal Configuration release packages.

Options:
  -n, --network-type <type>  Network configuration type (hub-and-spoke or shared-vpc) [required]
  -v, --version <version>    Release version [required]
  -o, --output <path>        Output file path [required]
  -r, --replacements <file>  YAML file for config replacements
  -u, --upload               Upload package to GitLab registry
  -h, --help                 Show this help message`);
}

const args = process.argv.slice(2);
const { networkType, version, replacementsFile, output, upload } =
  validateArguments(args);

/**
 * Recursively copies a directory and its contents
 * @param {string} src - Source directory path
 * @param {string} dest - Destination directory path
 */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Recursively deletes a directory and its contents (compatible with Node.js 10+)
 * @param {string} dirPath - Directory path to delete
 */
function removeDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.readdirSync(dirPath).forEach((file) => {
      const curPath = path.join(dirPath, file);
      if (fs.lstatSync(curPath).isDirectory()) {
        removeDir(curPath);
      } else {
        fs.unlinkSync(curPath);
      }
    });
    fs.rmdirSync(dirPath);
  }
}

/**
 * Executes a command with arguments in a specified directory
 * @param {string} cmd - Command to execute
 * @param {string[]} args - Command arguments
 * @param {string} cwd - Working directory
 * @returns {Promise<void>} Promise that resolves when command completes successfully
 */
function runCommand(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Command failed: ${code}`))
    );
  });
}

/**
 * Uploads a file to a URL using HTTPS PUT request
 * @param {string} filePath - Path to file to upload
 * @param {string} url - Upload URL
 * @param {string} token - Authentication token
 * @returns {Promise<void>} Promise that resolves when upload completes successfully
 */
function uploadFile(filePath, url, token) {
  return new Promise((resolve, reject) => {
    const fileSize = fs.statSync(filePath).size;
    console.log(`Uploading ${path.basename(filePath)} (${(fileSize / 1024 / 1024).toFixed(2)} MB) to ${url}`);
    const startTime = Date.now();
    const parsedUrl = new URL(url);
    const fileStream = fs.createReadStream(filePath);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "PUT",
      headers: {
        "JOB-TOKEN": token,
        "Content-Length": fileSize,
      },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('error', (err) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        reject(new Error(`Response stream error after ${elapsed}s: ${err.message}`));
      });
      res.on('end', () => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        if (res.statusCode < 400) {
          console.log(`Upload complete: HTTP ${res.statusCode} (${elapsed}s)`);
          resolve();
        } else {
          reject(new Error(`Upload failed: HTTP ${res.statusCode} - ${body} (${elapsed}s)`));
        }
      });
    });
    req.on("error", (err) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      reject(new Error(`Upload error after ${elapsed}s: ${err.message}`));
    });
    fileStream.pipe(req);
  });
}

/**
 * Main function that builds and uploads the release package
 * @returns {Promise<void>} Promise that resolves when package is built and uploaded
 */
async function main() {
  const zipFilename = output;

  const tempDir = path.join("..", "modules", "temp");
  fs.mkdirSync(path.join(tempDir, "config"), { recursive: true });

  copyDir("../modules/base/default", path.join(tempDir, "config"));
  copyDir(`../modules/network/${networkType}`, path.join(tempDir, "config"));

  if (replacementsFile && fs.existsSync(replacementsFile)) {
    const {
      loadReplacements,
      processConfigFile,
    } = require("./config-replacer.js");
    const replacements = loadReplacements(replacementsFile);

    for (const fileConfig of replacements) {
      const configDir = path.join(tempDir, "config");
      const modifiedContent = processConfigFile(configDir, fileConfig);
      const filePath = path.join(configDir, fileConfig.filename);
      fs.writeFileSync(filePath, modifiedContent, "utf8");
    }
  }

  fs.mkdirSync(path.join(tempDir, "docs"), { recursive: true });
  copyDir("../docs", path.join(tempDir, "docs"));

  await runCommand("zip", ["-r", `../${zipFilename}`, "."], tempDir);

  removeDir(tempDir);

  if (upload) {
    const uploadUrl = `${process.env.CI_API_V4_URL}/projects/${process.env.CI_PROJECT_ID
      }/packages/generic/lza-universal-config/${version}/${path.basename(
        zipFilename
      )}`;
    await uploadFile(zipFilename, uploadUrl, process.env.CI_JOB_TOKEN);
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
