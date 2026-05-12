#!/usr/bin/env node

/**
 * Extends the shared-VPC network-config.yaml from home-region-only to all
 * regions listed in ENABLED_REGIONS.
 *
 * Layout produced:
 *   modules/temp/include/shared-vpc-multi-region/<region>/<resource>.yaml
 *
 * Each fragment file is a single object (no leading `- `). LZA resolves them
 * at deploy time via `- !include <relative-path>` directives appended to each
 * section of the main network-config.yaml.
 *
 * The home-region items stay inline in the main file; only non-home clones
 * are extracted to fragments. On every CI run the script re-reads the
 * current home-region content from the main file (or from fragments on a
 * re-run) and regenerates clones from scratch — home-region edits propagate
 * automatically, so there's no drift.
 *
 * Per-region ASN and CIDR slices are derived from each region's index in
 * ENABLED_REGIONS (home pinned at index 0); see chooseLayout() and
 * computeRegionCidrs() for the tiering rules. No region list is hardcoded.
 *
 * Token substitutions applied to each clone:
 *   {{ HomeRegion }}              → literal region name
 *   {{ HomeRegion<Scope>Cidr }}   → {{ <RegionSlug><Scope>Cidr }}
 *   {{ TransitGatewayASN }}       → {{ <RegionSlug>TransitGatewayASN }}
 *
 * Customer-facing release zips are unaffected: writes happen only inside
 * modules/temp/, and release-package.js packages from source.
 *
 * Usage:
 *   HOME_REGION=us-east-1 ENABLED_REGIONS=us-east-1,us-west-2 \
 *     node shared-vpc-multi-region.js ../modules/temp/
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

// ────────────────────────────────────────────────────────────────────
// Region CIDR + ASN layout (derived from ENABLED_REGIONS, not hardcoded)
//
// Layout is computed per-region from a stable index, eliminating any
// hardcoded region list. The home region is always assigned index 0;
// non-home regions take indexes 1, 2, 3, … in ENABLED_REGIONS order.
//
//   asn   = ASN_BASE + index   → 64512, 64513, 64514, …
//   baseB = index * regionOctets  (2nd octet of each per-region slice)
//
// Pool sizing scales with region count. Each region carves its
// /<regionPrefix> slice into 4 equal slots: one for core VPCs
// (ingress/egress/inspection/endpoints/sharedservices, all inside a
// fixed /19) and three for dev/test/prod workload pools. Smaller
// workload pools fit more regions in 10.0.0.0/8 at the cost of fewer
// workload VPCs per tier (workload VPCs are /22 each):
//
//   workload /14, region /12 →  16 regions max, 256 VPCs/tier
//   workload /15, region /13 →  32 regions max, 128 VPCs/tier
//   workload /16, region /14 →  64 regions max,  64 VPCs/tier
//
// chooseLayout() picks the smallest tier that fits enabledRegions.length.
// When the chosen tier differs from the base replacements-config defaults
// (i.e., region count > 16), the HomeRegion{Regional,Dev,Test,Prod}*Cidr
// keys are rewritten to match — see updateReplacementsConfig below.
//
// Stability: as long as ENABLED_REGIONS preserves order across runs (the
// same constraint already implied by WORKLOAD_*_ACCOUNTS account indexing),
// assignments are deterministic.
// ────────────────────────────────────────────────────────────────────

const ASN_BASE = 64512; // RFC 6996 private ASN range start

function chooseLayout(numRegions) {
  // Each tier: workloadOctets is the per-tier 2nd-octet width; region width
  // is 4× that (one slot for core, three for dev/test/prod). Tiers are
  // ordered smallest-first so /14 workloads (today's default) is preferred
  // when it fits.
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

// ────────────────────────────────────────────────────────────────────
// Input validation
// ────────────────────────────────────────────────────────────────────

const inputFolder = process.argv[2];
if (!inputFolder) {
  console.error("Usage: node shared-vpc-multi-region.js <config-dir>");
  process.exit(1);
}

const homeRegion = process.env.HOME_REGION;
const enabledRegionsRaw = process.env.ENABLED_REGIONS;

if (!homeRegion) {
  console.error("HOME_REGION environment variable is required.");
  process.exit(1);
}
if (!enabledRegionsRaw) {
  console.error("ENABLED_REGIONS environment variable is required.");
  process.exit(1);
}

const enabledRegions = enabledRegionsRaw
  .split(",")
  .map(r => r.trim())
  .filter(r => r.length > 0);

if (!enabledRegions.includes(homeRegion)) {
  console.error(
    `HOME_REGION (${homeRegion}) must appear in ENABLED_REGIONS (${enabledRegionsRaw}).`
  );
  process.exit(1);
}

let LAYOUT;
try {
  LAYOUT = chooseLayout(enabledRegions.length);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

console.log(
  `Pool layout: ${enabledRegions.length} region(s) → /${LAYOUT.regionPrefix} per region, ` +
    `/${LAYOUT.workloadPrefix} workload pools (max ${LAYOUT.maxRegions}).`
);

// Order regions so the home region always gets index 0 (matching the base
// replacements-config values when the default /14 workload tier is in
// effect), and non-home regions follow in their ENABLED_REGIONS order.
const orderedRegions = [
  homeRegion,
  ...enabledRegions.filter(r => r !== homeRegion),
];

function regionLayout(region) {
  const index = orderedRegions.indexOf(region);
  if (index === -1) {
    throw new Error(`Region '${region}' is not in ENABLED_REGIONS`);
  }
  return {
    baseB: index * LAYOUT.regionOctets,
    asn: ASN_BASE + index,
  };
}

const nonHomeRegions = orderedRegions.slice(1);

if (nonHomeRegions.length === 0) {
  console.log("Only the home region is enabled; nothing to clone. Exiting cleanly.");
  process.exit(0);
}

const networkConfigPath = path.resolve(inputFolder, "network-config.yaml");
const replacementsConfigPath = path.resolve(inputFolder, "replacements-config.yaml");

for (const p of [networkConfigPath, replacementsConfigPath]) {
  if (!fs.existsSync(p)) {
    console.error(`Required config file not found: ${p}`);
    process.exit(1);
  }
}

console.log(
  `Extending shared-VPC config from home region '${homeRegion}' to: ${nonHomeRegions.join(", ")}`
);

const FRAGMENT_BASE_REL = "include/shared-vpc-multi-region";
const FRAGMENT_BASE_ABS = path.resolve(inputFolder, FRAGMENT_BASE_REL);
fs.mkdirSync(FRAGMENT_BASE_ABS, { recursive: true });

// ────────────────────────────────────────────────────────────────────
// replacements-config.yaml: append per-region CIDR + ASN keys
// ────────────────────────────────────────────────────────────────────

function updateReplacementsConfig() {
  const raw = fs.readFileSync(replacementsConfigPath, "utf8");
  const doc = yaml.load(raw);

  if (!doc || !Array.isArray(doc.globalReplacements)) {
    throw new Error(
      "replacements-config.yaml: expected a top-level 'globalReplacements' array"
    );
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

  // When the chosen tier is smaller than /14 workload pools (i.e., region
  // count > 16), the base replacements-config defaults for the home region
  // no longer fit the regional /<regionPrefix> slice. Rewrite them to match.
  // For the default tier (/14 workloads, /12 region) these are no-ops.
  const homeBase = regionLayout(homeRegion).baseB;
  const homeCidrs = computeRegionCidrs(homeBase, LAYOUT);
  setKey("HomeRegionRegionalCidr", "String", homeCidrs.RegionalCidr);
  setKey("HomeRegionDevWorkloadsCidr", "String", homeCidrs.DevWorkloadsCidr);
  setKey("HomeRegionTestWorkloadsCidr", "String", homeCidrs.TestWorkloadsCidr);
  setKey("HomeRegionProdWorkloadsCidr", "String", homeCidrs.ProdWorkloadsCidr);

  for (const region of nonHomeRegions) {
    const { baseB, asn } = regionLayout(region);
    const cidrs = computeRegionCidrs(baseB, LAYOUT);
    const slug = regionSlug(region);

    setKey(`${slug}RegionalCidr`, "String", cidrs.RegionalCidr);
    setKey(`${slug}IngressCidr`, "String", cidrs.IngressCidr);
    setKey(`${slug}EgressCidr`, "String", cidrs.EgressCidr);
    setKey(`${slug}InspectionCidr`, "String", cidrs.InspectionCidr);
    setKey(`${slug}EndpointsCidr`, "String", cidrs.EndpointsCidr);
    setKey(`${slug}SharedServicesCidr`, "String", cidrs.SharedServicesCidr);
    setKey(`${slug}DevWorkloadsCidr`, "String", cidrs.DevWorkloadsCidr);
    setKey(`${slug}TestWorkloadsCidr`, "String", cidrs.TestWorkloadsCidr);
    setKey(`${slug}ProdWorkloadsCidr`, "String", cidrs.ProdWorkloadsCidr);
    setKey(`${slug}TransitGatewayASN`, "Number", asn);
  }

  fs.writeFileSync(replacementsConfigPath, yaml.dump(doc), "utf8");
  console.log(
    `Updated replacements-config.yaml with ${nonHomeRegions.length} non-home region(s).`
  );
}

// ────────────────────────────────────────────────────────────────────
// network-config.yaml text helpers
// ────────────────────────────────────────────────────────────────────

function buildSubstitutions(region) {
  const slug = regionSlug(region);
  return [
    [/\{\{\s*HomeRegion\s*\}\}/g, region],
    [/\{\{\s*HomeRegionRegionalCidr\s*\}\}/g, `{{ ${slug}RegionalCidr }}`],
    [/\{\{\s*HomeRegionIngressCidr\s*\}\}/g, `{{ ${slug}IngressCidr }}`],
    [/\{\{\s*HomeRegionEgressCidr\s*\}\}/g, `{{ ${slug}EgressCidr }}`],
    [/\{\{\s*HomeRegionInspectionCidr\s*\}\}/g, `{{ ${slug}InspectionCidr }}`],
    [/\{\{\s*HomeRegionEndpointsCidr\s*\}\}/g, `{{ ${slug}EndpointsCidr }}`],
    [
      /\{\{\s*HomeRegionSharedServicesCidr\s*\}\}/g,
      `{{ ${slug}SharedServicesCidr }}`,
    ],
    [
      /\{\{\s*HomeRegionDevWorkloadsCidr\s*\}\}/g,
      `{{ ${slug}DevWorkloadsCidr }}`,
    ],
    [
      /\{\{\s*HomeRegionTestWorkloadsCidr\s*\}\}/g,
      `{{ ${slug}TestWorkloadsCidr }}`,
    ],
    [
      /\{\{\s*HomeRegionProdWorkloadsCidr\s*\}\}/g,
      `{{ ${slug}ProdWorkloadsCidr }}`,
    ],
    [/\{\{\s*TransitGatewayASN\s*\}\}/g, `{{ ${slug}TransitGatewayASN }}`],
  ];
}

/**
 * Substitute region-varying tokens in a cloned YAML item.
 *
 * Applies token substitutions line by line so we can skip the single case
 * that must stay region-agnostic: any line referencing the IPAM global pool.
 *
 * The global pool is a singleton owned by the home region (AWS permits
 * exactly one global pool per IPAM). Every regional pool, regardless of its
 * own locale, references the home-region global pool via `sourceIpamPool`.
 * A naive text-wide `{{ HomeRegion }}` → `<region>` substitution would
 * rewrite that reference to a non-existent `<region>-ipam-global-pool` and
 * break validation. By skipping any line that mentions `-ipam-global-pool`,
 * the reference is preserved verbatim.
 *
 * @param {string} text    Raw YAML text of a single list item (with leading `- `).
 * @param {string} region  Target region identifier (e.g. "us-west-2").
 * @returns {string}       The same YAML text with tokens rewritten.
 */
function applySubstitutions(text, region) {
  const substitutions = buildSubstitutions(region);

  return text
    .split("\n")
    .map(line => {
      // Preserve any line that references the home-region global pool.
      if (line.includes("-ipam-global-pool")) return line;
      let out = line;
      for (const [pattern, replacement] of substitutions) {
        out = out.replace(pattern, replacement);
      }
      return out;
    })
    .join("\n");
}

/**
 * Extract one list item as raw text.
 *
 * Walks forward from a `- ` line and gathers every continuation line whose
 * indentation is strictly greater than `indent`. Blank lines inside the item
 * are preserved; trailing blanks are trimmed so the caller can splice clones
 * back in cleanly.
 *
 * @param {string[]} lines     The file split on "\n".
 * @param {number}   startIdx  Index of the line beginning with `- ` at `indent` columns.
 * @param {number}   indent    Column at which the item's `- ` marker appears.
 * @returns {{text: string, nextIdx: number}}
 *                             `text` is the captured item (leading `- ` included).
 *                             `nextIdx` points at the first line that is NOT part
 *                             of the item (next sibling, section end, or EOF).
 */
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


/**
 * Find the line where a column-0 YAML section begins (e.g. `vpcs:`).
 *
 * @param {string[]} lines        The file split on "\n".
 * @param {string}   sectionName  Unindented key to match exactly at column 0.
 * @returns {number}              Index of the matching line, or -1 if not found.
 */
function findSectionStart(lines, sectionName) {
  const pattern = new RegExp(`^${sectionName}:\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i;
  }
  return -1;
}

/**
 * Find the first line past a column-0 section, i.e. the next top-level key.
 *
 * A line is considered "past the section" when it is non-blank, non-comment,
 * and starts at column 0. Blank lines and comments are treated as still
 * inside the previous section.
 *
 * @param {string[]} lines              The file split on "\n".
 * @param {number}   sectionStartIdx    Index returned by `findSectionStart`.
 * @returns {number}                    Index of the first line after the section,
 *                                      or `lines.length` if the section runs to EOF.
 */
function findSectionEnd(lines, sectionStartIdx) {
  for (let i = sectionStartIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0 || line.startsWith(" ") || line.startsWith("#")) continue;
    return i;
  }
  return lines.length;
}

/**
 * Find a nested key line by exact indentation and name.
 *
 * Matches `<indent><keyName>:` where the next character is either a space,
 * carriage return, or end-of-line (so `foo:` doesn't match `fooBar:`).
 *
 * @param {string[]} lines    The file split on "\n".
 * @param {number}   from     First line index to search (inclusive).
 * @param {number}   to       Last line index to search (exclusive).
 * @param {number}   indent   Column at which the key must appear.
 * @param {string}   keyName  Literal key name (no colon).
 * @returns {number}          Index of the matching line, or -1 if not found.
 */
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

/**
 * Find the first line in `[from, to)` beginning with a `- ` list marker at
 * the given indent. Returns -1 if the range contains no such line.
 *
 * @param {string[]} lines   The file split on "\n".
 * @param {number}   from    First line index to search (inclusive).
 * @param {number}   to      Last line index to search (exclusive).
 * @param {number}   indent  Column at which the `- ` marker must appear.
 * @returns {number}         Index of the first matching line, or -1.
 */
function findItemStart(lines, from, to, indent) {
  const prefix = " ".repeat(indent) + "- ";
  for (let i = from; i < to; i++) {
    if (lines[i].startsWith(prefix)) return i;
  }
  return -1;
}

/**
 * Extract the `name:` value from the first line of a list item whose body
 * begins `- name: "<value>"` or `- name: <value>`.
 *
 * @param {string} firstLine  The first line of a captured list item.
 * @returns {string|null}     The unquoted `name` value, or `null` if the line
 *                            does not match the `- name: …` shape (e.g. a
 *                            plain-scalar list entry or a different first key).
 */
function itemNameFromFirstLine(firstLine) {
  const m = firstLine.match(/^\s*-\s+name:\s*"?([^"#\n]+?)"?\s*(?:#.*)?$/);
  return m ? m[1].trim() : null;
}

/**
 * Convert a captured list item into a single-object YAML document.
 *
 * LZA's `!include` directive inlines the referenced file in place of the
 * directive. When used as a list-item include (`- !include path/file.yaml`),
 * the file must contain a SINGLE object — not an array. This helper strips
 * the leading `- ` marker and dedents every continuation line by
 * (itemIndent + 2) columns so the object body starts at column 0.
 *
 * @param {string} itemText    The captured list item (with leading `- `).
 * @param {number} itemIndent  Column at which the `- ` marker originally sat.
 * @returns {string}           A standalone YAML object, newline-terminated.
 */
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


/**
 * Map a cloned resource's name to its per-region fragment filename.
 *
 * The caller specifies the kind of resource the name belongs to; the function
 * splits the name at `-<region>-` and applies a kind-specific rule to turn
 * the suffix into a stable filename under `<region>/`.
 *
 * @param {string} kind    One of "transitGateway" | "ipamPool" | "nfwFirewall"
 *                         | "nfwPolicy" | "nfwRules" | "vpc".
 * @param {string} nameAfterSubstitution  The resource's `name:` value after
 *                         region token substitution (e.g. "AWSAccelerator-us-west-2-tgw").
 * @param {string} region  The target region, used to find the split point.
 * @returns {string}       The fragment filename (e.g. "transit-gateway.yaml").
 * @throws {Error}         If the region is absent from the name, the IPAM pool
 *                         suffix is malformed, or the kind is unrecognised.
 */
function deriveFragmentFilename(kind, nameAfterSubstitution, region) {
  // The region token appears inside the name. Find it and take the suffix.
  const idx = nameAfterSubstitution.indexOf(`-${region}-`);
  if (idx === -1) {
    throw new Error(
      `Could not locate region '${region}' in resource name '${nameAfterSubstitution}'`
    );
  }
  const suffix = nameAfterSubstitution.slice(idx + `-${region}-`.length);

  switch (kind) {
    case "transitGateway":
      // Only expected suffix: "tgw"
      return "transit-gateway.yaml";
    case "ipamPool": {
      // "ipam-regional-pool" → "ipam-pool-regional"
      // "ipam-workloads-dev-pool" → "ipam-pool-workloads-dev"
      const m = suffix.match(/^ipam-(.+)-pool$/);
      if (!m) {
        throw new Error(`Unexpected IPAM pool suffix: ${suffix}`);
      }
      return `ipam-pool-${m[1]}.yaml`;
    }
    case "nfwFirewall":
      return "nfw-firewall.yaml";
    case "nfwPolicy":
      return "nfw-policy.yaml";
    case "nfwRules":
      // Source suffix is "nfw-stateful-rule-group" — normalize to "nfw-rule-group".
      return "nfw-rule-group.yaml";
    case "vpc":
      // suffix is the VPC role: endpoints, ingress, egress, inspection,
      // sharedservices, shared-dev, shared-test, shared-prod.
      return `vpc-${suffix}.yaml`;
    default:
      throw new Error(`Unknown fragment kind: ${kind}`);
  }
}

/**
 * Ensure the per-region fragment directory exists, creating parents as needed.
 *
 * @param {string} region  Region identifier (becomes the directory name).
 * @returns {string}       Absolute path to the region's fragment directory.
 */
function ensureRegionDir(region) {
  const dir = path.resolve(FRAGMENT_BASE_ABS, region);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fragmentRelPath(region, filename) {
  return `${FRAGMENT_BASE_REL}/${region}/${filename}`;
}

// ────────────────────────────────────────────────────────────────────
// Core: extract home-region items, write fragments, splice !include lines
// ────────────────────────────────────────────────────────────────────

const INCLUDE_LINE_RE = new RegExp(
  `!include\\s+(${FRAGMENT_BASE_REL.replace(/\//g, "\\/")}\\/[^\\s]+)`
);

/** Collect every home-region list item (first line contains `{{ HomeRegion }}`)
 *  in `[from, to)` at `itemIndent`. Returns the items and the set of
 *  !include paths already present (so re-runs are idempotent). */
function scanSection(lines, itemIndent, from, to) {
  const homeItems = [];
  const existingIncludes = new Set();
  const dashPrefix = " ".repeat(itemIndent) + "- ";

  let i = from;
  while (i < to) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }

    // Capture pre-existing !include lines so we don't re-add them.
    const m = line.match(INCLUDE_LINE_RE);
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

/** Process a section: generate clones for every (non-home region × home item),
 *  write each to its per-region fragment file, and splice `- !include …`
 *  lines into the main file at the end of the section. */
function processSection(lines, opts) {
  const { itemIndent, from, to, kind, label } = opts;

  const { homeItems, existingIncludes } = scanSection(lines, itemIndent, from, to);
  if (homeItems.length === 0) {
    console.log(`  ${label}: nothing to clone.`);
    return lines;
  }

  const includePrefix = " ".repeat(itemIndent) + "- !include ";
  const includeLinesToAdd = [];
  let fragmentsWritten = 0;

  for (const region of nonHomeRegions) {
    ensureRegionDir(region);
    for (const homeItem of homeItems) {
      const cloned = applySubstitutions(homeItem, region);
      const name = itemNameFromFirstLine(cloned.split("\n")[0]);
      if (!name) {
        throw new Error(
          `Cloned item in ${label} has no recognisable name. First line: ${cloned.split("\n")[0]}`
        );
      }
      const filename = deriveFragmentFilename(kind, name, region);
      const relPath = fragmentRelPath(region, filename);
      const absPath = path.resolve(inputFolder, relPath);

      // Fragment body: single object (leading `- ` stripped, body dedented).
      const body = listItemToSingleObject(cloned, itemIndent);
      fs.writeFileSync(absPath, body, "utf8");
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

  // Splice !include lines just before the section's end, skipping trailing blanks.
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

// ────────────────────────────────────────────────────────────────────
// Section wrappers
// ────────────────────────────────────────────────────────────────────

function extendTopLevel(lines, sectionName, kind) {
  const startIdx = findSectionStart(lines, sectionName);
  if (startIdx === -1) {
    throw new Error(`network-config.yaml: '${sectionName}' section not found`);
  }
  const endIdx = findSectionEnd(lines, startIdx);
  return processSection(lines, {
    itemIndent: 2,
    from: startIdx + 1,
    to: endIdx,
    kind,
    label: sectionName,
  });
}

function extendNetworkFirewallList(lines, listKey, kind) {
  const cnsIdx = findSectionStart(lines, "centralNetworkServices");
  const cnsEnd = findSectionEnd(lines, cnsIdx);
  const nfwIdx = findNestedKey(lines, cnsIdx + 1, cnsEnd, 2, "networkFirewall");
  if (nfwIdx === -1) return lines;
  const listIdx = findNestedKey(lines, nfwIdx + 1, cnsEnd, 4, listKey);
  if (listIdx === -1) return lines;

  // Bound: next sibling key at indent 4 or end of centralNetworkServices.
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
    kind,
    label: `networkFirewall.${listKey}`,
  });
}

function extendIpamPools(lines) {
  const cnsIdx = findSectionStart(lines, "centralNetworkServices");
  if (cnsIdx === -1) throw new Error("'centralNetworkServices' not found");
  const cnsEnd = findSectionEnd(lines, cnsIdx);
  const ipamsIdx = findNestedKey(lines, cnsIdx + 1, cnsEnd, 2, "ipams");
  if (ipamsIdx === -1) throw new Error("'centralNetworkServices.ipams' not found");
  const ipamStart = findItemStart(lines, ipamsIdx + 1, cnsEnd, 4);
  if (ipamStart === -1) throw new Error("no IPAM list item found");
  const { nextIdx: ipamEnd } = extractListItem(lines, ipamStart, 4);

  // Extend operatingRegions with missing non-home regions.
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
    const toAdd = nonHomeRegions.filter(r => !existing.has(r));
    if (toAdd.length > 0) {
      lines = [
        ...lines.slice(0, opEnd),
        ...toAdd.map(r => `        - "${r}"`),
        ...lines.slice(opEnd),
      ];
    }
  }

  // Re-resolve bounds after potential insert.
  const cnsIdx2 = findSectionStart(lines, "centralNetworkServices");
  const cnsEnd2 = findSectionEnd(lines, cnsIdx2);
  const ipamsIdx2 = findNestedKey(lines, cnsIdx2 + 1, cnsEnd2, 2, "ipams");
  const ipamStart2 = findItemStart(lines, ipamsIdx2 + 1, cnsEnd2, 4);
  const { nextIdx: ipamEnd2 } = extractListItem(lines, ipamStart2, 4);
  const poolsIdx = findNestedKey(lines, ipamStart2 + 1, ipamEnd2, 6, "pools");
  if (poolsIdx === -1) throw new Error("'pools' key not found inside IPAM");

  // Pools have a stricter predicate: the global pool is NOT cloned (one per IPAM).
  // We do this by wrapping processSection's extraction step: scan like normal,
  // then drop the global-pool item from homeItems before cloning.
  const poolsBodyStart = poolsIdx + 1;
  const poolsBodyEnd = ipamEnd2;
  const itemIndent = 8;

  const { homeItems, existingIncludes } = scanSection(
    lines, itemIndent, poolsBodyStart, poolsBodyEnd
  );
  const cloneable = homeItems.filter(item => {
    const name = itemNameFromFirstLine(item.split("\n")[0]);
    // Exclude only the global pool itself. Its name ends with `ipam-global-pool`;
    // scoped pools reference the global pool via `sourceIpamPool:` in their
    // body, so a substring match on the whole item would wrongly drop them.
    return !(name && name.endsWith("ipam-global-pool"));
  });

  if (cloneable.length === 0) {
    console.log(`  IPAM pools: nothing to clone.`);
    return lines;
  }

  const includePrefix = " ".repeat(itemIndent) + "- !include ";
  const includeLinesToAdd = [];
  let fragmentsWritten = 0;

  for (const region of nonHomeRegions) {
    ensureRegionDir(region);
    for (const homeItem of cloneable) {
      const cloned = applySubstitutions(homeItem, region);
      const name = itemNameFromFirstLine(cloned.split("\n")[0]);
      if (!name) throw new Error(`IPAM pool clone has no name`);
      const filename = deriveFragmentFilename("ipamPool", name, region);
      const relPath = fragmentRelPath(region, filename);
      const absPath = path.resolve(inputFolder, relPath);
      fs.writeFileSync(absPath, listItemToSingleObject(cloned, itemIndent), "utf8");
      fragmentsWritten++;
      if (!existingIncludes.has(relPath)) {
        includeLinesToAdd.push(`${includePrefix}${relPath}`);
      }
    }
  }

  if (includeLinesToAdd.length === 0) {
    console.log(`  IPAM pools: wrote ${fragmentsWritten} fragments, 0 new !include lines.`);
    return lines;
  }

  // Splice just before poolsBodyEnd, skipping trailing blanks.
  let insertAt = poolsBodyEnd;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;
  lines = [...lines.slice(0, insertAt), ...includeLinesToAdd, ...lines.slice(insertAt)];

  console.log(
    `  IPAM pools: wrote ${fragmentsWritten} fragments, added ${includeLinesToAdd.length} !include lines.`
  );
  return lines;
}

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────

function linesToText(lines, originalText) {
  let joined = lines.join("\n");
  if (originalText.endsWith("\n") && !joined.endsWith("\n")) joined += "\n";
  return joined;
}

function updateNetworkConfig() {
  const originalText = fs.readFileSync(networkConfigPath, "utf8");
  let lines = originalText.split("\n");

  lines = extendTopLevel(lines, "transitGateways", "transitGateway");
  lines = extendIpamPools(lines);
  lines = extendNetworkFirewallList(lines, "firewalls", "nfwFirewall");
  lines = extendNetworkFirewallList(lines, "policies", "nfwPolicy");
  lines = extendNetworkFirewallList(lines, "rules", "nfwRules");
  lines = extendTopLevel(lines, "vpcs", "vpc");

  fs.writeFileSync(networkConfigPath, linesToText(lines, originalText), "utf8");
  console.log("Updated network-config.yaml with per-region !include directives.");
}

try {
  updateReplacementsConfig();
  updateNetworkConfig();
  console.log("Shared-VPC multi-region extension complete.");
} catch (err) {
  console.error(`shared-vpc-multi-region.js failed: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}
