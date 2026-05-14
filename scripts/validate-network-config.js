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

/**
 * js-yaml custom tag that resolves LZA's `!include` directive.
 *
 * The path is relative to the file being parsed. We substitute `{{ }}`
 * placeholders with a safe literal before parsing the fragment so js-yaml
 * doesn't choke on them (same pre-processing we apply to the main file).
 *
 * Docs: https://awslabs.github.io/landing-zone-accelerator-on-aws/latest/user-guide/configuration-include/
 */
function makeIncludeSchema(baseDir) {
  const includeType = new yaml.Type("!include", {
    kind: "scalar",
    construct: relPath => {
      const absPath = path.resolve(baseDir, relPath);
      if (!fs.existsSync(absPath)) {
        throw new Error(`!include: file not found: ${absPath}`);
      }
      const rawFragment = fs.readFileSync(absPath, "utf8");
      const normalized = normalizePlaceholders(rawFragment);
      // Recursively support `!include` inside fragments (LZA permits this).
      return yaml.load(normalized, {
        schema: makeIncludeSchema(path.dirname(absPath)),
      });
    },
  });
  return yaml.DEFAULT_SCHEMA.extend([includeType]);
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

/** Find the first item whose `name` matches the needle. If `exactSuffix` is true,
 *  require the item's name to end with `needle`; otherwise, require it to contain
 *  `needle` as a substring. */
function findByName(items, needle, exactSuffix = false) {
  if (!Array.isArray(items)) {
    return undefined;
  }
  return items.find(item => {
    if (!item || typeof item.name !== "string") return false;
    return exactSuffix ? item.name.endsWith(needle) : item.name.includes(needle);
  });
}

/** Kept for backward compatibility: substring match on `name`. */
function findByNameContains(items, needle) {
  return findByName(items, needle, false);
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
  parsedConfig = yaml.load(normalizedContent, {
    schema: makeIncludeSchema(path.dirname(networkConfigPath)),
  });
} catch (error) {
  fail(`network-config.yaml is not valid YAML after placeholder normalization: ${error.message}`);
}

if (!parsedConfig || !Array.isArray(parsedConfig.vpcs)) {
  fail("Expected a top-level 'vpcs' array in network-config.yaml");
}

// ── Validate VPC structure per model ────────────────────────────────

const errors = [];

// Detect which network model is in use based on VPC naming patterns.
// Shared-VPC has `shared-dev/test/prod` VPCs; hub-and-spoke has
// `inspection/egress/ingress/endpoints/sharedservices` VPCs.
const hasSharedVpcs = parsedConfig.vpcs.some(
  v => v && typeof v.name === "string" && /-shared-(dev|test|prod)$/.test(v.name)
);
const hasHubSpokeVpcs = parsedConfig.vpcs.some(
  v => v && typeof v.name === "string" && /-(inspection|egress|ingress|endpoints|sharedservices)$/.test(v.name)
);

const requiredEnvs = ["dev", "test", "prod"];

// Determine which regions the config is expected to cover. If the env var
// is set (from CI), we enforce per-region presence; otherwise we fall back
// to the previous single-region check so local runs still work.
const expectedRegions = (process.env.ENABLED_REGIONS || "")
  .split(",")
  .map(r => r.trim())
  .filter(r => r.length > 0);

function regionMatchesHome(regionLiteral) {
  return regionLiteral === process.env.HOME_REGION;
}

function regionTokenFor(regionLiteral) {
  // After normalizePlaceholders(), both {{ HomeRegion }} and {{ RegionN }}
  // become "PLACEHOLDER". If the config uses {{ RegionN }} tokens (hub-and-spoke),
  // non-home regions also resolve to PLACEHOLDER. If it uses literal region
  // strings (shared-vpc), non-home regions keep their literal value.
  // We check which pattern the config uses by looking for the literal region in VPC names.
  return regionMatchesHome(regionLiteral) ? "PLACEHOLDER" : regionLiteral;
}

// ── Shared-VPC model checks ─────────────────────────────────────────
if (hasSharedVpcs) {
  if (expectedRegions.length > 0) {
    for (const region of expectedRegions) {
      const regionToken = regionTokenFor(region);
      for (const env of requiredEnvs) {
        const vpcNameSuffix = `${regionToken}-shared-${env}`;
        const vpc = findByName(parsedConfig.vpcs, vpcNameSuffix, true);
        if (!vpc) {
          errors.push(
            `Missing shared-${env} VPC for region '${region}' (expected name ending in '${vpcNameSuffix}')`
          );
        }
      }
    }
  } else {
    for (const env of requiredEnvs) {
      const vpc = findByNameContains(parsedConfig.vpcs, `shared-${env}`);
      if (!vpc) {
        errors.push(`Missing shared-${env} VPC`);
      }
    }
  }

  // Every shared-* VPC must have TGW route tables and subnets.
  for (const vpc of parsedConfig.vpcs || []) {
    if (!vpc || typeof vpc.name !== "string") continue;
    const m = vpc.name.match(/-shared-(dev|test|prod)$/);
    if (!m) continue;
    const baseName = vpc.name;

    if (!Array.isArray(vpc.subnets)) {
      errors.push(`${baseName}: missing subnets array`);
    } else {
      for (const suffix of ["-tgw-a", "-tgw-b"]) {
        if (!findByNameContains(vpc.subnets, `${baseName}${suffix}`)) {
          errors.push(`Missing required TGW subnet ${baseName}${suffix}`);
        }
      }
    }

    if (!Array.isArray(vpc.routeTables)) {
      errors.push(`${baseName}: missing routeTables array`);
    } else {
      for (const suffix of ["-rt-tgw-a", "-rt-tgw-b"]) {
        if (!findByNameContains(vpc.routeTables, `${baseName}${suffix}`)) {
          errors.push(`Missing required TGW route table ${baseName}${suffix}`);
        }
      }
    }
  }
}

// ── Hub-and-spoke model checks ──────────────────────────────────────
if (hasHubSpokeVpcs) {
  const hubSpokeVpcTypes = ["inspection", "egress", "ingress", "endpoints", "sharedservices"];

  if (expectedRegions.length > 0) {
    // Hub-and-spoke uses {{ RegionN }} tokens which all become PLACEHOLDER
    // after normalization. We validate by counting VPCs of each type.
    for (const vpcType of hubSpokeVpcTypes) {
      const count = parsedConfig.vpcs.filter(
        v => v && typeof v.name === "string" && v.name.endsWith(`-${vpcType}`)
      ).length;
      if (count < expectedRegions.length) {
        errors.push(
          `Expected ${expectedRegions.length} ${vpcType} VPC(s) (one per region), found ${count}`
        );
      }
    }
  } else {
    for (const vpcType of hubSpokeVpcTypes) {
      if (!findByNameContains(parsedConfig.vpcs, vpcType)) {
        errors.push(`Missing ${vpcType} VPC`);
      }
    }
  }

  // Every hub-and-spoke VPC with TGW attachment subnets must have them.
  for (const vpc of parsedConfig.vpcs || []) {
    if (!vpc || typeof vpc.name !== "string") continue;
    if (!/(inspection|egress|ingress|endpoints|sharedservices)$/.test(vpc.name)) continue;
    const baseName = vpc.name;

    if (!Array.isArray(vpc.subnets)) {
      errors.push(`${baseName}: missing subnets array`);
    } else {
      for (const suffix of ["-tgw-a", "-tgw-b"]) {
        if (!findByNameContains(vpc.subnets, `${baseName}${suffix}`)) {
          errors.push(`Missing required TGW subnet ${baseName}${suffix}`);
        }
      }
    }
  }
}

// Per-region Transit Gateway presence.
if (expectedRegions.length > 0 && Array.isArray(parsedConfig.transitGateways)) {
  if (hasSharedVpcs) {
    // Shared-VPC uses literal region strings in names
    for (const region of expectedRegions) {
      const regionToken = regionTokenFor(region);
      if (!findByName(parsedConfig.transitGateways, `${regionToken}-tgw`, true)) {
        errors.push(`Missing Transit Gateway for region '${region}'`);
      }
    }
  } else {
    // Hub-and-spoke uses {{ RegionN }} tokens — count TGWs instead
    const tgwCount = parsedConfig.transitGateways.filter(
      t => t && typeof t.name === "string" && t.name.endsWith("-tgw")
    ).length;
    if (tgwCount < expectedRegions.length) {
      errors.push(
        `Expected ${expectedRegions.length} Transit Gateway(s) (one per region), found ${tgwCount}`
      );
    }
  }
}

// Single IPAM with unique pool names.
const ipams =
  (parsedConfig.centralNetworkServices &&
    parsedConfig.centralNetworkServices.ipams) ||
  [];
if (ipams.length !== 1) {
  errors.push(
    `Expected exactly one IPAM entry under centralNetworkServices.ipams, found ${ipams.length}`
  );
} else if (Array.isArray(ipams[0].pools)) {
  const seen = new Set();
  for (const pool of ipams[0].pools) {
    if (!pool || typeof pool.name !== "string") continue;
    // Skip duplicate check for names that are entirely placeholders
    // ({{ RegionN }} tokens all normalize to the same string)
    if (pool.name === "PLACEHOLDER" || /^PLACEHOLDER-PLACEHOLDER/.test(pool.name)) continue;
    if (seen.has(pool.name)) {
      errors.push(`Duplicate IPAM pool name: ${pool.name}`);
    }
    seen.add(pool.name);
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
