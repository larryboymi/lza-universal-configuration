#!/usr/bin/env node

/**
 * Extends the shared-VPC network-config.yaml from home-region-only to all
 * regions listed in ENABLED_REGIONS.
 *
 * Layout produced:
 *   modules/temp/include/shared-vpc-multi-region/<region>/<resource>.yaml
 *
 * Usage:
 *   HOME_REGION=us-east-1 ENABLED_REGIONS=us-east-1,us-west-2 \
 *     node shared-vpc-multi-region.js ../modules/temp/
 */

const fs = require("fs");
const {
  initRegionContext,
  updateReplacementsConfig,
  extendTopLevel,
  extendNetworkFirewallList,
  extendIpamPools,
  linesToText,
  makeIncludeLineRe,
} = require("./lib/multi-region-utils");

const FRAGMENT_BASE_REL = "include/shared-vpc-multi-region";

function deriveSharedVpcFilename(sectionHint) {
  return function (nameAfterSubstitution, region) {
    const idx = nameAfterSubstitution.indexOf(`-${region}-`);
    if (idx === -1) {
      throw new Error(
        `Could not locate region '${region}' in resource name '${nameAfterSubstitution}'`
      );
    }
    const suffix = nameAfterSubstitution.slice(idx + `-${region}-`.length);

    switch (sectionHint) {
      case "transitGateways":
        return "transit-gateway.yaml";
      case "ipamPool": {
        const m = suffix.match(/^ipam-(.+)-pool$/);
        if (!m) throw new Error(`Unexpected IPAM pool suffix: ${suffix}`);
        return `ipam-pool-${m[1]}.yaml`;
      }
      case "firewalls":
        return "nfw-firewall.yaml";
      case "policies":
        return "nfw-policy.yaml";
      case "rules":
        return "nfw-rule-group.yaml";
      case "vpcs":
        return `vpc-${suffix}.yaml`;
      default:
        throw new Error(`Unknown section hint: ${sectionHint}`);
    }
  };
}

const ctx = initRegionContext("shared-vpc-multi-region.js");

console.log(
  `Extending shared-VPC config from home region '${ctx.homeRegion}' to: ${ctx.nonHomeRegions.join(", ")}`
);

fs.mkdirSync(`${ctx.inputFolder}/${FRAGMENT_BASE_REL}`, { recursive: true });

const includeLineRe = makeIncludeLineRe(FRAGMENT_BASE_REL);

const sectionCtx = {
  nonHomeRegions: ctx.nonHomeRegions,
  inputFolder: ctx.inputFolder,
  fragmentBaseRel: FRAGMENT_BASE_REL,
  includeLineRe,
  deriveFilename: deriveSharedVpcFilename,
};

try {
  updateReplacementsConfig(ctx.replacementsConfigPath, ctx);

  const originalText = fs.readFileSync(ctx.networkConfigPath, "utf8");
  let lines = originalText.split("\n");

  lines = extendTopLevel(lines, "transitGateways", sectionCtx);
  lines = extendIpamPools(lines, sectionCtx);
  lines = extendNetworkFirewallList(lines, "firewalls", sectionCtx);
  lines = extendNetworkFirewallList(lines, "policies", sectionCtx);
  lines = extendNetworkFirewallList(lines, "rules", sectionCtx);
  lines = extendTopLevel(lines, "vpcs", sectionCtx);

  fs.writeFileSync(ctx.networkConfigPath, linesToText(lines, originalText), "utf8");
  console.log("Updated network-config.yaml with per-region !include directives.");
  console.log("Shared-VPC multi-region extension complete.");
} catch (err) {
  console.error(`shared-vpc-multi-region.js failed: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}
