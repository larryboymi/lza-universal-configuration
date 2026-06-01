/**
 * Shared utilities for multi-region network-config.yaml extension scripts.
 *
 * Both shared-vpc-multi-region.js and hub-spoke-multi-region.js use these
 * functions to clone home-region YAML items across enabled regions, write
 * per-region fragment files, and splice `!include` directives back into the
 * main config.
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");


const ASN_BASE = 64512;

function chooseLayout(numRegions) {
  const tiers = [
    { workloadOctets: 4, workloadPrefix: 14 }, //  16 regions
    { workloadOctets: 2, workloadPrefix: 15 }, //  32 regions
    { workloadOctets: 1, workloadPrefix: 16 }, //  64 regions
  ];
  for (const t of tiers) {
    const regionOctets = t.workloadOctets * 4;
    const regionPrefix = 16 - Math.log2(regionOctets);
    const maxRegions = 256 / regionOctets;
    if (numRegions <= maxRegions) {
      return { ...t, regionOctets, regionPrefix, maxRegions };
    }
  }
  throw new Error(
    `Cannot fit ${numRegions} regions in 10.0.0.0/8: max 64 (with /16 workload pools).`
  );
}

function computeRegionCidrs(baseB, layout) {
  const { workloadOctets, workloadPrefix, regionPrefix } = layout;
  return {
    RegionalCidr: `10.${baseB}.0.0/${regionPrefix}`,
    IngressCidr: `10.${baseB}.0.0/20`,
    EgressCidr: `10.${baseB}.16.0/24`,
    InspectionCidr: `10.${baseB}.17.0/24`,
    EndpointsCidr: `10.${baseB}.20.0/22`,
    SharedServicesCidr: `10.${baseB}.24.0/21`,
    DevWorkloadsCidr: `10.${baseB + workloadOctets}.0.0/${workloadPrefix}`,
    TestWorkloadsCidr: `10.${baseB + 2 * workloadOctets}.0.0/${workloadPrefix}`,
    ProdWorkloadsCidr: `10.${baseB + 3 * workloadOctets}.0.0/${workloadPrefix}`,
  };
}

function regionSlug(region) {
  return region
    .split("-")
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function buildSubstitutions(region, regionToken) {
  // regionToken is e.g. "{{ Region2 }}" or the literal region string.
  // When provided, we substitute {{ HomeRegion }} with the token (keeping it
  // as a replacement variable for LZA to resolve). When not provided, we
  // fall back to the literal region string.
  const regionReplacement = regionToken || region;
  const prefix = regionToken
    ? regionToken.replace(/\{\{\s*/, "").replace(/\s*\}\}/, "")
    : regionSlug(region);
  return [
    [/\{\{\s*HomeRegion\s*\}\}/g, regionReplacement],
    [/\{\{\s*HomeRegionRegionalCidr\s*\}\}/g, `{{ ${prefix}RegionalCidr }}`],
    [/\{\{\s*HomeRegionIngressCidr\s*\}\}/g, `{{ ${prefix}IngressCidr }}`],
    [/\{\{\s*HomeRegionEgressCidr\s*\}\}/g, `{{ ${prefix}EgressCidr }}`],
    [/\{\{\s*HomeRegionInspectionCidr\s*\}\}/g, `{{ ${prefix}InspectionCidr }}`],
    [/\{\{\s*HomeRegionEndpointsCidr\s*\}\}/g, `{{ ${prefix}EndpointsCidr }}`],
    [/\{\{\s*HomeRegionSharedServicesCidr\s*\}\}/g, `{{ ${prefix}SharedServicesCidr }}`],
    [/\{\{\s*HomeRegionDevWorkloadsCidr\s*\}\}/g, `{{ ${prefix}DevWorkloadsCidr }}`],
    [/\{\{\s*HomeRegionTestWorkloadsCidr\s*\}\}/g, `{{ ${prefix}TestWorkloadsCidr }}`],
    [/\{\{\s*HomeRegionProdWorkloadsCidr\s*\}\}/g, `{{ ${prefix}ProdWorkloadsCidr }}`],
    [/\{\{\s*TransitGatewayASN\s*\}\}/g, `{{ ${prefix}TransitGatewayASN }}`],
  ];
}

function applySubstitutions(text, region, regionToken) {
  const substitutions = buildSubstitutions(region, regionToken);
  return text
    .split("\n")
    .map(line => {
      if (line.includes("-ipam-global-pool")) return line;
      let out = line;
      for (const [pattern, replacement] of substitutions) {
        out = out.replace(pattern, replacement);
      }
      return out;
    })
    .join("\n");
}

function extractListItem(lines, startIdx, indent) {
  const itemLines = [lines[startIdx]];
  let i = startIdx + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { itemLines.push(line); i++; continue; }
    const leading = line.length - line.trimStart().length;
    if (leading <= indent) break;
    itemLines.push(line);
    i++;
  }
  while (itemLines.length && itemLines[itemLines.length - 1].trim() === "") {
    itemLines.pop();
  }
  return { text: itemLines.join("\n"), nextIdx: i };
}

function findSectionStart(lines, sectionName) {
  const pattern = new RegExp(`^${sectionName}:\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i;
  }
  return -1;
}

function findSectionEnd(lines, sectionStartIdx) {
  for (let i = sectionStartIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0 || line.startsWith(" ") || line.startsWith("#")) continue;
    return i;
  }
  return lines.length;
}

function findNestedKey(lines, from, to, indent, keyName) {
  const prefix = " ".repeat(indent) + keyName + ":";
  for (let i = from; i < to; i++) {
    const line = lines[i];
    if (line.startsWith(prefix)) {
      const after = line[prefix.length];
      if (after === undefined || after === " " || after === "\r") return i;
    }
  }
  return -1;
}

function findItemStart(lines, from, to, indent) {
  const prefix = " ".repeat(indent) + "- ";
  for (let i = from; i < to; i++) {
    if (lines[i].startsWith(prefix)) return i;
  }
  return -1;
}

function itemNameFromFirstLine(firstLine) {
  const m = firstLine.match(/^\s*-\s+name:\s*"?([^"#\n]+?)"?\s*(?:#.*)?$/);
  return m ? m[1].trim() : null;
}

function listItemToSingleObject(itemText, itemIndent) {
  const lines = itemText.split("\n");
  const strip = itemIndent + 2;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0) {
      out.push(line.replace(/^(\s*)-\s/, ""));
    } else if (line.trim() === "") {
      out.push("");
    } else {
      out.push(line.startsWith(" ".repeat(strip)) ? line.slice(strip) : line);
    }
  }
  return out.join("\n") + "\n";
}

function scanSection(lines, itemIndent, from, to, includeLineRe) {
  const homeItems = [];
  const existingIncludes = new Set();
  const dashPrefix = " ".repeat(itemIndent) + "- ";

  let i = from;
  while (i < to) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    const m = line.match(includeLineRe);
    if (m) { existingIncludes.add(m[1]); i++; continue; }
    if (!line.startsWith(dashPrefix)) { i++; continue; }
    const { text, nextIdx } = extractListItem(lines, i, itemIndent);
    if (text.split("\n")[0].includes("{{ HomeRegion }}")) {
      homeItems.push(text);
    }
    i = nextIdx;
  }
  return { homeItems, existingIncludes };
}

/**
 * Process a section: clone home-region items for each non-home region,
 * write fragments, and splice !include lines.
 *
 * @param {string[]} lines           The file split on "\n".
 * @param {object}   opts
 * @param {number}   opts.itemIndent  Column of the `- ` markers.
 * @param {number}   opts.from        First line of the section body.
 * @param {number}   opts.to          First line past the section body.
 * @param {string}   opts.label       Human-readable label for logging.
 * @param {string[]} opts.nonHomeRegions  Regions to clone into.
 * @param {string}   opts.inputFolder     Absolute path to config dir.
 * @param {string}   opts.fragmentBaseRel Relative path for fragments.
 * @param {RegExp}   opts.includeLineRe   Regex to detect existing !include lines.
 * @param {function} opts.deriveFilename  (name, region) => filename string.
 * @param {function} [opts.filterItems]   Optional filter on homeItems before cloning.
 */
function processSection(lines, opts) {
  const {
    itemIndent, from, to, label, nonHomeRegions, inputFolder,
    fragmentBaseRel, includeLineRe, deriveFilename, filterItems,
    regionTokenMap,
  } = opts;

  const { homeItems, existingIncludes } = scanSection(lines, itemIndent, from, to, includeLineRe);

  const cloneable = filterItems ? homeItems.filter(filterItems) : homeItems;
  if (cloneable.length === 0) {
    console.log(`  ${label}: nothing to clone.`);
    return lines;
  }

  const fragmentBaseAbs = path.resolve(inputFolder, fragmentBaseRel);
  const includePrefix = " ".repeat(itemIndent) + "- !include ";
  const includeLinesToAdd = [];
  let fragmentsWritten = 0;

  for (const region of nonHomeRegions) {
    const regionDir = path.resolve(fragmentBaseAbs, region);
    fs.mkdirSync(regionDir, { recursive: true });

    for (const homeItem of cloneable) {
      const regionToken = regionTokenMap ? regionTokenMap[region] : undefined;
      const cloned = applySubstitutions(homeItem, region, regionToken);
      const name = itemNameFromFirstLine(cloned.split("\n")[0]);
      if (!name) {
        throw new Error(
          `Cloned item in ${label} has no recognisable name. First line: ${cloned.split("\n")[0]}`
        );
      }
      const filename = deriveFilename(name, region);
      const relPath = `${fragmentBaseRel}/${region}/${filename}`;
      const absPath = path.resolve(inputFolder, relPath);
      fs.writeFileSync(absPath, listItemToSingleObject(cloned, itemIndent), "utf8");
      fragmentsWritten++;
      if (!existingIncludes.has(relPath)) {
        includeLinesToAdd.push(`${includePrefix}${relPath}`);
      }
    }
  }

  if (includeLinesToAdd.length === 0) {
    console.log(`  ${label}: wrote ${fragmentsWritten} fragments, 0 new !include lines.`);
    return lines;
  }

  let insertAt = to;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;

  const spliced = [
    ...lines.slice(0, insertAt),
    "",
    ...includeLinesToAdd,
    ...lines.slice(insertAt),
  ];

  console.log(
    `  ${label}: wrote ${fragmentsWritten} fragments, added ${includeLinesToAdd.length} !include lines.`
  );
  return spliced;
}

function extendTopLevel(lines, sectionName, ctx) {
  const startIdx = findSectionStart(lines, sectionName);
  if (startIdx === -1) {
    throw new Error(`network-config.yaml: '${sectionName}' section not found`);
  }
  const endIdx = findSectionEnd(lines, startIdx);
  return processSection(lines, {
    itemIndent: 2,
    from: startIdx + 1,
    to: endIdx,
    label: sectionName,
    ...ctx,
    deriveFilename: ctx.deriveFilename(sectionName),
  });
}

function extendNetworkFirewallList(lines, listKey, ctx) {
  const cnsIdx = findSectionStart(lines, "centralNetworkServices");
  const cnsEnd = findSectionEnd(lines, cnsIdx);
  const nfwIdx = findNestedKey(lines, cnsIdx + 1, cnsEnd, 2, "networkFirewall");
  if (nfwIdx === -1) return lines;
  const listIdx = findNestedKey(lines, nfwIdx + 1, cnsEnd, 4, listKey);
  if (listIdx === -1) return lines;

  let listEnd = cnsEnd;
  for (let i = listIdx + 1; i < cnsEnd; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    const leading = line.length - line.trimStart().length;
    if (leading === 4 && !line.startsWith("    -")) { listEnd = i; break; }
    if (leading < 4) { listEnd = i; break; }
  }

  return processSection(lines, {
    itemIndent: 6,
    from: listIdx + 1,
    to: listEnd,
    label: `networkFirewall.${listKey}`,
    ...ctx,
    deriveFilename: ctx.deriveFilename(listKey),
  });
}

function extendIpamPools(lines, ctx) {
  const cnsIdx = findSectionStart(lines, "centralNetworkServices");
  if (cnsIdx === -1) throw new Error("'centralNetworkServices' not found");
  const cnsEnd = findSectionEnd(lines, cnsIdx);
  const ipamsIdx = findNestedKey(lines, cnsIdx + 1, cnsEnd, 2, "ipams");
  if (ipamsIdx === -1) throw new Error("'centralNetworkServices.ipams' not found");
  const ipamStart = findItemStart(lines, ipamsIdx + 1, cnsEnd, 4);
  if (ipamStart === -1) throw new Error("no IPAM list item found");
  const { nextIdx: ipamEnd } = extractListItem(lines, ipamStart, 4);

  // Extend operatingRegions
  const opIdx = findNestedKey(lines, ipamStart + 1, ipamEnd, 6, "operatingRegions");
  if (opIdx !== -1) {
    let opEnd = ipamEnd;
    for (let i = opIdx + 1; i < ipamEnd; i++) {
      const line = lines[i];
      if (line.trim() === "") continue;
      const leading = line.length - line.trimStart().length;
      if (leading <= 6) { opEnd = i; break; }
    }
    const existing = new Set();
    for (let i = opIdx + 1; i < opEnd; i++) {
      const m = lines[i].match(/^\s*-\s*"?([^"\s]+)"?\s*$/);
      if (m) existing.add(m[1]);
    }
    const toAdd = ctx.nonHomeRegions.filter(r => !existing.has(r));
    if (toAdd.length > 0) {
      lines = [
        ...lines.slice(0, opEnd),
        ...toAdd.map(r => `        - "${r}"`),
        ...lines.slice(opEnd),
      ];
    }
  }

  // Re-resolve bounds after potential insert
  const cnsIdx2 = findSectionStart(lines, "centralNetworkServices");
  const cnsEnd2 = findSectionEnd(lines, cnsIdx2);
  const ipamsIdx2 = findNestedKey(lines, cnsIdx2 + 1, cnsEnd2, 2, "ipams");
  const ipamStart2 = findItemStart(lines, ipamsIdx2 + 1, cnsEnd2, 4);
  const { nextIdx: ipamEnd2 } = extractListItem(lines, ipamStart2, 4);
  const poolsIdx = findNestedKey(lines, ipamStart2 + 1, ipamEnd2, 6, "pools");
  if (poolsIdx === -1) throw new Error("'pools' key not found inside IPAM");

  return processSection(lines, {
    itemIndent: 8,
    from: poolsIdx + 1,
    to: ipamEnd2,
    label: "IPAM pools",
    ...ctx,
    deriveFilename: ctx.deriveFilename("ipamPool"),
    filterItems: item => {
      const name = itemNameFromFirstLine(item.split("\n")[0]);
      return !(name && name.endsWith("ipam-global-pool"));
    },
  });
}

function updateReplacementsConfig(replacementsConfigPath, { homeRegion, nonHomeRegions, orderedRegions, layout, regionKeyPrefix }) {
  const raw = fs.readFileSync(replacementsConfigPath, "utf8");
  const doc = yaml.load(raw);

  if (!doc || !Array.isArray(doc.globalReplacements)) {
    throw new Error("replacements-config.yaml: expected a top-level 'globalReplacements' array");
  }

  const existing = new Map(doc.globalReplacements.map(item => [item.key, item]));

  function setKey(key, type, value) {
    const existingItem = existing.get(key);
    if (existingItem) {
      existingItem.type = type;
      existingItem.value = value;
    } else {
      const newItem = { key, type, value };
      doc.globalReplacements.push(newItem);
      existing.set(key, newItem);
    }
  }

  const homeIndex = orderedRegions.indexOf(homeRegion);
  const homeBaseB = homeIndex * layout.regionOctets;
  const homeCidrs = computeRegionCidrs(homeBaseB, layout);
  setKey("HomeRegionRegionalCidr", "String", homeCidrs.RegionalCidr);
  setKey("HomeRegionDevWorkloadsCidr", "String", homeCidrs.DevWorkloadsCidr);
  setKey("HomeRegionTestWorkloadsCidr", "String", homeCidrs.TestWorkloadsCidr);
  setKey("HomeRegionProdWorkloadsCidr", "String", homeCidrs.ProdWorkloadsCidr);

  for (const region of nonHomeRegions) {
    const index = orderedRegions.indexOf(region);
    const baseB = index * layout.regionOctets;
    const asn = ASN_BASE + index;
    const cidrs = computeRegionCidrs(baseB, layout);
    // Use custom prefix if provided (e.g. "Region2"), otherwise default to slug (e.g. "UsWest2")
    const prefix = regionKeyPrefix ? regionKeyPrefix(region, index) : regionSlug(region);

    setKey(`${prefix}`, "String", region);
    setKey(`${prefix}RegionalCidr`, "String", cidrs.RegionalCidr);
    setKey(`${prefix}IngressCidr`, "String", cidrs.IngressCidr);
    setKey(`${prefix}EgressCidr`, "String", cidrs.EgressCidr);
    setKey(`${prefix}InspectionCidr`, "String", cidrs.InspectionCidr);
    setKey(`${prefix}EndpointsCidr`, "String", cidrs.EndpointsCidr);
    setKey(`${prefix}SharedServicesCidr`, "String", cidrs.SharedServicesCidr);
    setKey(`${prefix}DevWorkloadsCidr`, "String", cidrs.DevWorkloadsCidr);
    setKey(`${prefix}TestWorkloadsCidr`, "String", cidrs.TestWorkloadsCidr);
    setKey(`${prefix}ProdWorkloadsCidr`, "String", cidrs.ProdWorkloadsCidr);
    setKey(`${prefix}TransitGatewayASN`, "Number", asn);
  }

  fs.writeFileSync(replacementsConfigPath, yaml.dump(doc), "utf8");
  console.log(`Updated replacements-config.yaml with ${nonHomeRegions.length} non-home region(s).`);
}

function initRegionContext(scriptName) {
  const inputFolder = process.argv[2];
  if (!inputFolder) {
    console.error(`Usage: node ${scriptName} <config-dir>`);
    process.exit(1);
  }

  const homeRegion = process.env.HOME_REGION;
  const enabledRegionsRaw = process.env.ENABLED_REGIONS;

  if (!homeRegion) { console.error("HOME_REGION environment variable is required."); process.exit(1); }
  if (!enabledRegionsRaw) { console.error("ENABLED_REGIONS environment variable is required."); process.exit(1); }

  const enabledRegions = enabledRegionsRaw.split(",").map(r => r.trim()).filter(r => r.length > 0);

  if (!enabledRegions.includes(homeRegion)) {
    console.error(`HOME_REGION (${homeRegion}) must appear in ENABLED_REGIONS (${enabledRegionsRaw}).`);
    process.exit(1);
  }

  const layout = chooseLayout(enabledRegions.length);
  const orderedRegions = [homeRegion, ...enabledRegions.filter(r => r !== homeRegion)];
  const nonHomeRegions = orderedRegions.slice(1);

  if (nonHomeRegions.length === 0) {
    console.log("Only the home region is enabled; nothing to clone. Exiting cleanly.");
    process.exit(0);
  }

  console.log(
    `Pool layout: ${enabledRegions.length} region(s) → /${layout.regionPrefix} per region, ` +
    `/${layout.workloadPrefix} workload pools (max ${layout.maxRegions}).`
  );

  const networkConfigPath = path.resolve(inputFolder, "network-config.yaml");
  const replacementsConfigPath = path.resolve(inputFolder, "replacements-config.yaml");

  for (const p of [networkConfigPath, replacementsConfigPath]) {
    if (!fs.existsSync(p)) { console.error(`Required config file not found: ${p}`); process.exit(1); }
  }

  return {
    inputFolder: path.resolve(inputFolder),
    homeRegion,
    enabledRegions,
    orderedRegions,
    nonHomeRegions,
    layout,
    networkConfigPath,
    replacementsConfigPath,
  };
}

function linesToText(lines, originalText) {
  let joined = lines.join("\n");
  if (originalText.endsWith("\n") && !joined.endsWith("\n")) joined += "\n";
  return joined;
}

function makeIncludeLineRe(fragmentBaseRel) {
  return new RegExp(`!include\\s+(${fragmentBaseRel.replace(/\//g, "\\/")}\\/[^\\s]+)`);
}

/**
 * Extends route53Resolver.firewallRuleGroups[].regions arrays with non-home regions.
 * DNS Firewall rule groups are defined with only the home region; this function
 * appends all non-home regions so the rule group is deployed to every enabled region.
 */
function extendDnsFirewallRegions(lines, ctx) {
  const cnsIdx = findSectionStart(lines, "centralNetworkServices");
  if (cnsIdx === -1) return lines;
  const cnsEnd = findSectionEnd(lines, cnsIdx);
  const resolverIdx = findNestedKey(lines, cnsIdx + 1, cnsEnd, 2, "route53Resolver");
  if (resolverIdx === -1) return lines;

  const result = [...lines];
  let offset = 0;

  for (let i = resolverIdx + 1; i < cnsEnd; i++) {
    const line = lines[i];
    if (/^\s{8}regions:\s*$/.test(line)) {
      let regionsEnd = i + 1;
      while (regionsEnd < cnsEnd && /^\s{10}-\s/.test(lines[regionsEnd])) {
        regionsEnd++;
      }
      const newLines = ctx.nonHomeRegions.map(region => `          - "${region}"`);
      result.splice(regionsEnd + offset, 0, ...newLines);
      offset += newLines.length;
    }
  }

  if (offset > 0) {
    console.log(`  route53Resolver.firewallRuleGroups: added ${ctx.nonHomeRegions.length} region(s) to DNS Firewall rule groups.`);
  }
  return result;
}

module.exports = {
  ASN_BASE,
  chooseLayout,
  computeRegionCidrs,
  regionSlug,
  buildSubstitutions,
  applySubstitutions,
  extractListItem,
  findSectionStart,
  findSectionEnd,
  findNestedKey,
  findItemStart,
  itemNameFromFirstLine,
  listItemToSingleObject,
  scanSection,
  processSection,
  extendTopLevel,
  extendNetworkFirewallList,
  extendIpamPools,
  extendDnsFirewallRegions,
  updateReplacementsConfig,
  initRegionContext,
  linesToText,
  makeIncludeLineRe,
};
