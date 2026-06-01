#!/usr/bin/env node

/**
 * Extends the hub-and-spoke network-config.yaml from home-region-only to all
 * regions listed in ENABLED_REGIONS.
 *
 * Layout produced:
 *   modules/temp/include/hub-spoke-multi-region/<region>/<resource>.yaml
 *
 * Usage:
 *   HOME_REGION=us-east-1 ENABLED_REGIONS=us-east-1,us-west-2 \
 *     node hub-spoke-multi-region.js ../modules/temp/
 */

const fs = require("fs");
const {
  initRegionContext,
  updateReplacementsConfig,
  extendTopLevel,
  extendNetworkFirewallList,
  extendIpamPools,
  extendDnsFirewallRuleGroups,
  linesToText,
  makeIncludeLineRe,
} = require("./lib/multi-region-utils");

const FRAGMENT_BASE_REL = "include/hub-spoke-multi-region";

function deriveHubSpokeFilename(sectionHint) {
  return function (nameAfterSubstitution, region) {
    let idx = nameAfterSubstitution.indexOf(`-${region}-`);
    let splitLen = `-${region}-`.length;
    if (idx === -1) {
      // Try {{ RegionN }} token pattern
      const tokenMatch = nameAfterSubstitution.match(/-(\{\{[^}]+\}\})-/);
      if (tokenMatch) {
        idx = tokenMatch.index;
        splitLen = tokenMatch[0].length;
      }
    }
    if (idx === -1) {
      throw new Error(
        `Could not locate region '${region}' in resource name '${nameAfterSubstitution}'`
      );
    }
    const suffix = nameAfterSubstitution.slice(idx + splitLen);

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
      case "dnsFirewallRuleGroups":
        return "dns-firewall-rule-group.yaml";
      case "vpcs":
        return `vpc-${suffix}.yaml`;
      case "vpcTemplates":
        return `vpc-template-${suffix}.yaml`;
      default:
        throw new Error(`Unknown section hint: ${sectionHint}`);
    }
  };
}

const ctx = initRegionContext("hub-spoke-multi-region.js");

console.log(
  `Extending hub-and-spoke config from home region '${ctx.homeRegion}' to: ${ctx.nonHomeRegions.join(", ")}`
);

fs.mkdirSync(`${ctx.inputFolder}/${FRAGMENT_BASE_REL}`, { recursive: true });

const includeLineRe = makeIncludeLineRe(FRAGMENT_BASE_REL);

// Map each non-home region to its {{ RegionN }} token so fragments use
// replacement variables (not literal region strings) — matching the existing
// deployed CloudFormation resources.
const regionTokenMap = {};
ctx.nonHomeRegions.forEach((region, idx) => {
  regionTokenMap[region] = `{{ Region${idx + 2} }}`;
});

const sectionCtx = {
  nonHomeRegions: ctx.nonHomeRegions,
  inputFolder: ctx.inputFolder,
  fragmentBaseRel: FRAGMENT_BASE_REL,
  includeLineRe,
  regionTokenMap,
  deriveFilename: deriveHubSpokeFilename,
};

try {
  updateReplacementsConfig(ctx.replacementsConfigPath, {
    ...ctx,
    regionKeyPrefix: (_region, index) => `Region${index + 1}`,
  });

  const originalText = fs.readFileSync(ctx.networkConfigPath, "utf8");
  let lines = originalText.split("\n");

  lines = extendTopLevel(lines, "transitGateways", sectionCtx);
  lines = extendIpamPools(lines, sectionCtx);
  lines = extendNetworkFirewallList(lines, "firewalls", sectionCtx);
  lines = extendNetworkFirewallList(lines, "policies", sectionCtx);
  lines = extendNetworkFirewallList(lines, "rules", sectionCtx);
  lines = extendDnsFirewallRuleGroups(lines, sectionCtx);
  lines = extendTopLevel(lines, "vpcs", sectionCtx);
  lines = extendTopLevel(lines, "vpcTemplates", sectionCtx);

  const fragmentDir = `${ctx.inputFolder}/${FRAGMENT_BASE_REL}`;
  for (const region of ctx.nonHomeRegions) {
    const regionDir = `${fragmentDir}/${region}`;
    const files = fs.readdirSync(regionDir).filter(f => f.startsWith("ipam-pool-"));
    const regionToken = regionTokenMap[region];
    for (const file of files) {
      const filePath = `${regionDir}/${file}`;
      let content = fs.readFileSync(filePath, "utf8");
      if (!content.includes("locale:")) {
        const lines = content.split("\n");
        lines.splice(1, 0, `locale: "${regionToken}"`);
        fs.writeFileSync(filePath, lines.join("\n"), "utf8");
      }
    }
  }

  fs.writeFileSync(ctx.networkConfigPath, linesToText(lines, originalText), "utf8");
  console.log("Updated network-config.yaml with per-region !include directives.");
  console.log("Hub-and-spoke multi-region extension complete.");
} catch (err) {
  console.error(`hub-spoke-multi-region.js failed: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}
