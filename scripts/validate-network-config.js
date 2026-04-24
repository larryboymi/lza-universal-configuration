#!/usr/bin/env node

/**
 * Validates the generated network-config.yaml after CI transforms.
 *
 * Checks:
 *  1. The file is valid YAML (after neutralising {{ }} placeholders).
 *  2. Each shared VPC (dev, test, prod) exists with its required TGW
 *     route tables and subnets.
 *  3. Any subnet that declares shareTargets has at least one non-empty
 *     accounts or organizationalUnits list.
 *
 * Usage:
 *   node validate-network-config.js <config-dir>
 *
 * Exit codes:
 *   0 – validation passed
 *   1 – validation failed (errors printed to stderr)
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const inputFolder = process.argv[2];

if (!inputFolder) {
  console.error("Usage: node validate-network-config.js <config-dir>");
  process.exit(1);
}

const networkConfigPath = path.resolve(inputFolder, "network-config.yaml");

if (!fs.existsSync(networkConfigPath)) {
  console.error(`network-config.yaml not found: ${networkConfigPath}`);
  process.exit(1);
}

/** Print one or more errors to stderr and exit with code 1. */
function fail(errors) {
  const list = Array.isArray(errors) ? errors : [errors];
  for (const error of list) {
    console.error(`Validation error: ${error}`);
  }
  process.exit(1);
}

/**
 * Replace all {{ ... }} LZA replacement tokens with a safe literal so
 * js-yaml can parse the file without interpreting them as JS objects.
 */
function normalizePlaceholders(content) {
  return content.replace(/\{\{[^}]+\}\}/g, "PLACEHOLDER");
}

/** Find the first item in an array whose `name` property contains the needle. */
function findByNameContains(items, needle) {
  if (!Array.isArray(items)) {
    return undefined;
  }

  return items.find(
    item => item && typeof item.name === "string" && item.name.includes(needle)
  );
}

/** Return true when the value is a non-empty array. */
function hasNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

// ── Parse the config ────────────────────────────────────────────────

let parsedConfig;
const rawContent = fs.readFileSync(networkConfigPath, "utf8");
const normalizedContent = normalizePlaceholders(rawContent);

try {
  parsedConfig = yaml.load(normalizedContent);
} catch (error) {
  fail(`network-config.yaml is not valid YAML after placeholder normalization: ${error.message}`);
}

if (!parsedConfig || !Array.isArray(parsedConfig.vpcs)) {
  fail("Expected a top-level 'vpcs' array in network-config.yaml");
}

// ── Validate shared VPC structure ───────────────────────────────────

const errors = [];
const requiredEnvs = ["dev", "test", "prod"];

for (const env of requiredEnvs) {
  const vpc = findByNameContains(parsedConfig.vpcs, `shared-${env}`);

  if (!vpc) {
    errors.push(`Missing shared-${env} VPC`);
    continue;
  }

  // Every shared VPC must have its TGW attachment subnets (a + b)
  if (!Array.isArray(vpc.subnets)) {
    errors.push(`shared-${env} VPC is missing a subnets array`);
  } else {
    for (const subnetName of [`shared-${env}-tgw-a`, `shared-${env}-tgw-b`]) {
      if (!findByNameContains(vpc.subnets, subnetName)) {
        errors.push(`Missing required TGW subnet ${subnetName} in shared-${env}`);
      }
    }
  }

  // Every shared VPC must have its TGW route tables (a + b)
  if (!Array.isArray(vpc.routeTables)) {
    errors.push(`shared-${env} VPC is missing a routeTables array`);
  } else {
    for (const routeTableName of [
      `shared-${env}-rt-tgw-a`,
      `shared-${env}-rt-tgw-b`,
    ]) {
      if (!findByNameContains(vpc.routeTables, routeTableName)) {
        errors.push(`Missing required TGW route table ${routeTableName} in shared-${env}`);
      }
    }
  }
}

// ── Validate shareTargets are not empty when declared ───────────────
// A subnet with shareTargets but no accounts or OUs would create a
// broken RAM share that doesn't actually share with anyone.

for (const vpc of parsedConfig.vpcs) {
  if (!Array.isArray(vpc.subnets)) {
    continue;
  }

  for (const subnet of vpc.subnets) {
    if (!subnet.shareTargets) {
      continue;
    }

    const hasAccounts = hasNonEmptyArray(subnet.shareTargets.accounts);
    const hasOus = hasNonEmptyArray(subnet.shareTargets.organizationalUnits);

    if (!hasAccounts && !hasOus) {
      errors.push(
        `Subnet '${subnet.name}' has shareTargets but no non-empty accounts or organizationalUnits`
      );
    }
  }
}

// ── Report results ─────────────────────────────────────────────────

if (errors.length > 0) {
  fail(errors);
}

console.log("network-config validation passed.");
