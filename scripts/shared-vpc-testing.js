#!/usr/bin/env node

/**
 * Uncomments the example route-table and subnet blocks inside each shared VPC
 * (shared-dev, shared-test, shared-prod) in network-config.yaml, wiring them
 * to real workload accounts or OUs so the CI pipeline can validate RAM-based
 * subnet sharing end-to-end.
 *
 * How it works:
 *   The source network-config.yaml ships with commented-out "Example Route Table"
 *   and "Example Subnet" blocks inside each shared VPC. This script performs a
 *   plain-text find-and-replace to uncomment those blocks and inject the correct
 *   shareTargets. Because it operates on raw strings (not yaml.load/dump), the
 *   {{ }} LZA replacement tokens are preserved.
 *
 * Sharing strategy (one per environment to test all RAM approaches):
 *   - shared-dev  → accounts: [Dev00001]           (account-name targeting)
 *   - shared-test → organizationalUnits: [Workloads/Test]  (OU targeting)
 *   - shared-prod → organizationalUnits: [Workloads/Prod]  (OU targeting)
 *
 * Gating:
 *   Each environment is only processed when its WORKLOAD_*_ACCOUNTS env var > 0,
 *   matching the accounts that index.js creates in accounts-config.yaml.
 *
 * Usage:
 *   WORKLOAD_DEV_ACCOUNTS=1 WORKLOAD_TEST_ACCOUNTS=1 WORKLOAD_PROD_ACCOUNTS=1 \
 *     node shared-vpc-testing.js <config-dir>
 */

const fs = require("fs");
const path = require("path");

const inputFolder = process.argv[2];

if (!inputFolder) {
  console.error("Usage: node shared-vpc-testing.js <config-dir>");
  process.exit(1);
}

const networkConfigPath = path.resolve(inputFolder, "network-config.yaml");

if (!fs.existsSync(networkConfigPath)) {
  console.log("No network-config.yaml found; skipping shared VPC testing setup.");
  process.exit(0);
}

// ── Environment configuration ───────────────────────────────────────
// Each entry maps a shared VPC environment to:
//   env        – the environment suffix (dev/test/prod)
//   pool       – the IPAM pool suffix used in the subnet's ipamAllocation
//   enableVar  – the env var that gates whether this environment is processed
//   shareTargets – the RAM sharing config injected into the uncommented subnet

const environments = [
  {
    env: "dev",
    pool: "dev",
    enableVar: "WORKLOAD_DEV_ACCOUNTS",
    shareTargets: {
      accounts: ["Dev00001"],
    },
  },
  {
    env: "test",
    pool: "test",
    enableVar: "WORKLOAD_TEST_ACCOUNTS",
    shareTargets: {
      organizationalUnits: ["Workloads/Test"],
    },
  },
  {
    env: "prod",
    pool: "prod",
    enableVar: "WORKLOAD_PROD_ACCOUNTS",
    shareTargets: {
      organizationalUnits: ["Workloads/Prod"],
    },
  },
];

// ── Helpers ──────────────────────────────────────────────────────────

/** Returns true when the given env var is set to a positive integer. */
function envEnabled(variableName) {
  return Number.parseInt(process.env[variableName] || "0", 10) > 0;
}

/**
 * Replaces a commented block with its uncommented equivalent.
 * - If the uncommented version already exists, it's a no-op (idempotent).
 * - If the commented version can't be found, it throws so CI fails loudly.
 */
function replaceCommentedBlock(source, commentedBlock, uncommentedBlock, label) {
  if (source.includes(uncommentedBlock)) {
    console.log(`${label} already enabled; skipping.`);
    return source;
  }

  if (!source.includes(commentedBlock)) {
    throw new Error(`Expected commented block not found for ${label}`);
  }

  console.log(`Enabling ${label}`);
  return source.replace(commentedBlock, uncommentedBlock);
}

/** Builds the shareTargets YAML fragment at the correct indentation (8 spaces). */
function buildShareTargetsBlock(shareTargets) {
  const lines = ["        shareTargets:"];

  if (shareTargets.accounts && shareTargets.accounts.length > 0) {
    lines.push("          accounts:");
    for (const account of shareTargets.accounts) {
      lines.push(`            - ${account}`);
    }
  }

  if (
    shareTargets.organizationalUnits &&
    shareTargets.organizationalUnits.length > 0
  ) {
    lines.push("          organizationalUnits:");
    for (const ou of shareTargets.organizationalUnits) {
      lines.push(`            - ${ou}`);
    }
  }

  return lines.join("\n");
}

// ── Block builders ──────────────────────────────────────────────────
// Each pair of functions produces the exact text that appears in the
// source YAML (commented) and the replacement text (uncommented).
// The indentation must match the source file precisely (6-space base
// indent for items inside routeTables/subnets arrays).

function buildCommentedRouteTableBlock(env) {
  return [
    "      ### Example Route Table",
    `      # - name: "{{ AcceleratorPrefix }}-{{ HomeRegion }}-shared-${env}-example-ai-a"`,
    "      #   routes:",
    "      #     - name: TgwRoute",
    '      #       destination: "{{ GlobalCidr }}"',
    "      #       type: transitGateway",
    '      #       target: "{{ AcceleratorPrefix }}-{{ HomeRegion }}-tgw"',
    "      #     - name: S3Gateway",
    "      #       type: gatewayEndpoint",
    "      #       target: s3",
    "      #     - name: DynamoDBGateway",
    "      #       type: gatewayEndpoint",
    "      #       target: dynamodb",
    "",
  ].join("\n");
}

function buildUncommentedRouteTableBlock(env) {
  return [
    "      ### Example Route Table",
    `      - name: "{{ AcceleratorPrefix }}-{{ HomeRegion }}-shared-${env}-example-ai-a"`,
    "        routes:",
    "          - name: TgwRoute",
    '            destination: "{{ GlobalCidr }}"',
    "            type: transitGateway",
    '            target: "{{ AcceleratorPrefix }}-{{ HomeRegion }}-tgw"',
    "          - name: S3Gateway",
    "            type: gatewayEndpoint",
    "            target: s3",
    "          - name: DynamoDBGateway",
    "            type: gatewayEndpoint",
    "            target: dynamodb",
    "",
  ].join("\n");
}

function buildCommentedSubnetBlock(env, pool) {
  const envLabel = env.charAt(0).toUpperCase() + env.slice(1);

  return [
    "      ### Example Subnet",
    `      # - name: "{{ AcceleratorPrefix }}-{{ HomeRegion }}-shared-${env}-example-ai-a"`,
    "      #   availabilityZone: a",
    `      #   routeTable: "{{ AcceleratorPrefix }}-{{ HomeRegion }}-shared-${env}-example-ai-a"`,
    "      #   ipamAllocation:",
    `      #     ipamPoolName: "{{ AcceleratorPrefix }}-{{ HomeRegion }}-ipam-workloads-${pool}-pool"`,
    "      #     netmaskLength: 26",
    "      #   shareTargets:",
    "      #     accounts:",
    `      #       - MyExampleAi${envLabel}Account`,
    "",
  ].join("\n");
}

function buildUncommentedSubnetBlock(env, pool, shareTargets) {
  return [
    "      ### Example Subnet",
    `      - name: "{{ AcceleratorPrefix }}-{{ HomeRegion }}-shared-${env}-example-ai-a"`,
    "        availabilityZone: a",
    `        routeTable: "{{ AcceleratorPrefix }}-{{ HomeRegion }}-shared-${env}-example-ai-a"`,
    "        ipamAllocation:",
    `          ipamPoolName: "{{ AcceleratorPrefix }}-{{ HomeRegion }}-ipam-workloads-${pool}-pool"`,
    "          netmaskLength: 26",
    buildShareTargetsBlock(shareTargets),
    "",
  ].join("\n");
}

// ── Main ────────────────────────────────────────────────────────────

let content = fs.readFileSync(networkConfigPath, "utf8");

for (const config of environments) {
  if (!envEnabled(config.enableVar)) {
    console.log(`Skipping shared-${config.env}; ${config.enableVar} is not enabled.`);
    continue;
  }

  // Uncomment the example route table for this environment
  content = replaceCommentedBlock(
    content,
    buildCommentedRouteTableBlock(config.env),
    buildUncommentedRouteTableBlock(config.env),
    `shared-${config.env} route table example`
  );

  // Uncomment the example subnet and wire it to the correct shareTargets
  content = replaceCommentedBlock(
    content,
    buildCommentedSubnetBlock(config.env, config.pool),
    buildUncommentedSubnetBlock(config.env, config.pool, config.shareTargets),
    `shared-${config.env} subnet example`
  );
}

fs.writeFileSync(networkConfigPath, content, "utf8");
console.log("Shared VPC testing setup complete.");
