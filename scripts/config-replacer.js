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

// Configuration file replacer - applies pattern-based replacements to config files
const yaml = require("js-yaml");
const fs = require("fs");
const path = require("path");

function validateArguments(args) {
  if (args.includes('-h') || args.includes('--help') || args.length < 2) {
    showHelp();
    process.exit(0);
  }

  const writeMode = args.includes('-w') || args.includes('--write');
  const quietMode = args.includes('-q') || args.includes('--quiet');
  const nonFlagArgs = args.filter(arg => !arg.startsWith('-'));
  const [inputFolder, replacementsFile] = nonFlagArgs;

  if (!inputFolder || !replacementsFile) {
    throw new Error('Both input folder and replacements file are required');
  }

  return {
    inputFolder: path.resolve(inputFolder),
    replacementsFile: path.resolve(replacementsFile),
    writeMode,
    quietMode
  };
}

function validatePaths(inputFolder, replacementsFile) {
  if (!fs.existsSync(inputFolder)) {
    throw new Error(`Input folder does not exist: ${inputFolder}`);
  }

  if (!fs.existsSync(replacementsFile)) {
    throw new Error(`Replacements file does not exist: ${replacementsFile}`);
  }
}

function loadReplacements(filename) {
  try {
    return yaml.load(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    throw new Error(`Failed to load replacements file: ${error.message}`);
  }
}

function cleanQuotes(text) {
  return text.replace(/^["'](.*)["']$/gm, "$1");
}

function applyReplacements(content, items) {
  let result = content;

  for (const item of items) {
    if (item.type === 'deleteBlock') {
      // Delete all lines between startMarker and endMarker (inclusive)
      const lines = result.split('\n');
      const output = [];
      let deleting = false;
      let found = false;

      for (const line of lines) {
        if (!deleting && line.includes(item.startMarker)) {
          deleting = true;
          found = true;
          if (item.replacement) {
            output.push(item.replacement);
          }
          continue;
        }
        if (deleting) {
          if (line.includes(item.endMarker)) {
            deleting = false;
            if (item.endInclusive === false) {
              output.push(line); // exclusive - keep the endMarker line
            }
            continue;
          }
          continue;
        }
        output.push(line);
      }

      if (!found) {
        throw new Error(`deleteBlock startMarker not found: ${item.startMarker}`);
      }
      result = output.join('\n');
    } else {
      // Default: exact text pattern replacement
      const pattern = cleanQuotes(item.pattern);
      const replacement = cleanQuotes(item.replacement || '');

      if (result.includes(pattern)) {
        result = result.replaceAll(pattern, replacement);
      } else {
        // Try indentation-aware match: find the pattern with leading whitespace
        const patternLines = pattern.split('\n').filter(l => l.length > 0);
        const firstLine = patternLines[0].trim();
        const contentLines = result.split('\n');
        const matchIndex = contentLines.findIndex(l => l.trim() === firstLine);

        if (matchIndex === -1) {
          throw new Error(`Pattern not found: ${pattern}`);
        }

        // Detect the indentation from the actual file
        const indent = contentLines[matchIndex].match(/^(\s*)/)[1];

        // Build the indented pattern to match
        const indentedPattern = patternLines.map(l => indent + l).join('\n');
        const indentedReplacement = replacement.split('\n')
          .filter(l => l.length > 0)
          .map(l => indent + l)
          .join('\n');

        if (!result.includes(indentedPattern)) {
          throw new Error(`Pattern not found (even with detected indent): ${pattern}`);
        }

        result = result.replaceAll(indentedPattern, indentedReplacement);
      }
    }
  }

  return result;
}

function processConfigFile(inputFolder, fileConfig) {
  const filePath = path.join(inputFolder, fileConfig.filename);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Config file does not exist: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf8");
  return applyReplacements(content, fileConfig.items);
}

function showHelp() {
  console.log(`
Usage: node config-replacer.js [options] <input-folder> <replacements-file>

Applies pattern-based text replacements to configuration files.

Arguments:
  input-folder      Path to folder containing config files to modify
  replacements-file Path to YAML file containing replacement rules

Options:
  -h, --help       Show this help message
  -w, --write      Write modified content to files (default: output to console)
  -q, --quiet      Suppress status messages

Replacements file format:
  - filename: config-file.yaml
    items:
      - pattern: "old-text"
        replacement: "new-text"
      - type: deleteBlock
        startMarker: "# start of block"
        endMarker: "# end of block"
        replacement: "optional replacement text"`);
}

function main() {
  try {
    const args = process.argv.slice(2);
    const { inputFolder, replacementsFile, writeMode, quietMode } = validateArguments(args);

    validatePaths(inputFolder, replacementsFile);

    const replacements = loadReplacements(replacementsFile);

    for (const fileConfig of replacements) {
      if (!quietMode) console.log(`Processing: ${fileConfig.filename}`);

      const modifiedContent = processConfigFile(inputFolder, fileConfig);

      if (writeMode) {
        const filePath = path.join(inputFolder, fileConfig.filename);
        fs.writeFileSync(filePath, modifiedContent, 'utf8');
        if (!quietMode) console.log(`Updated: ${fileConfig.filename}`);
      } else {
        console.log(modifiedContent);
      }
    }

  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  validateArguments,
  validatePaths,
  loadReplacements,
  cleanQuotes,
  applyReplacements,
  processConfigFile
};