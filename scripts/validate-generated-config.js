#!/usr/bin/env node

const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const yaml = require('js-yaml')
const { REQUIRED_CONFIG_FILES, loadYamlDocument } = require('./lib/config-overlay')

const parseArguments = args => {
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!flag?.startsWith('--') || !value) {
      throw new Error('Arguments must be provided as --name value pairs')
    }
    values.set(flag.slice(2), path.resolve(value))
  }
  if (!values.has('config') || !values.has('profile')) {
    throw new Error('Usage: validate-generated-config.js --config <directory> --profile <directory>')
  }
  return Object.fromEntries(values)
}

const walk = (value, visitor, pointer = '') => {
  visitor(value, pointer)
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visitor, `${pointer}/${index}`))
    return
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => walk(item, visitor, `${pointer}/${key}`))
  }
}

const collectNamedDuplicates = (document, filename, errors) => {
  walk(document, (value, pointer) => {
    if (!Array.isArray(value)) return
    const names = value.filter(item => item && typeof item === 'object' && typeof item.name === 'string').map(item => item.name)
    const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))]
    duplicates.forEach(name => errors.push(`${filename}${pointer}: duplicate name '${name}'`))
  })
}

const collectDeploymentReferences = documents => {
  const references = []
  Object.entries(documents).forEach(([filename, document]) => {
    walk(document, (value, pointer) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return
      for (const targetKey of ['deploymentTargets', 'shareTargets']) {
        const targets = value[targetKey]
        if (!targets || typeof targets !== 'object') continue
        ;(targets.organizationalUnits ?? []).forEach(name => references.push({ filename, pointer, type: 'ou', name }))
        ;(targets.accounts ?? []).forEach(name => references.push({ filename, pointer, type: 'account', name }))
        ;(targets.excludedAccounts ?? []).forEach(name => references.push({ filename, pointer, type: 'account', name }))
      }
    })
  })
  return references
}

const validateReferences = (documents, errors) => {
  const organization = documents['organization-config.yaml']
  const accounts = documents['accounts-config.yaml']
  const knownOus = new Set(['Root', ...(organization.organizationalUnits ?? []).map(item => item.name)])
  const knownAccounts = new Set([
    ...(accounts.mandatoryAccounts ?? []).map(item => item.name),
    ...(accounts.workloadAccounts ?? []).map(item => item.name),
  ])
  collectDeploymentReferences(documents).forEach(reference => {
    const known = reference.type === 'ou' ? knownOus : knownAccounts
    if (!known.has(reference.name)) {
      errors.push(`${reference.filename}${reference.pointer}: unknown ${reference.type} '${reference.name}'`)
    }
  })
  for (const ou of knownOus) {
    if (ou === 'Root' || !ou.includes('/')) continue
    const parent = ou.split('/').slice(0, -1).join('/')
    if (!knownOus.has(parent)) {
      errors.push(`organization-config.yaml: OU '${ou}' has unknown parent '${parent}'`)
    }
  }
  Object.entries(documents).forEach(([filename, document]) => {
    walk(document, (value, pointer) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return
      for (const key of ['account', 'delegatedAdminAccount']) {
        if (typeof value[key] === 'string' && !knownAccounts.has(value[key])) {
          errors.push(`${filename}${pointer}: unknown account '${value[key]}'`)
        }
      }
      for (const name of value.excludedAccounts ?? []) {
        if (!knownAccounts.has(name)) {
          errors.push(`${filename}${pointer}: unknown excluded account '${name}'`)
        }
      }
    })
  })
}

const validateReplacementKeys = async (configDirectory, documents, errors) => {
  const replacements = documents['replacements-config.yaml'] ??
    (await loadYamlDocument(path.join(configDirectory, 'replacements-config.yaml'))).document
  const known = new Set((replacements.globalReplacements ?? []).map(item => item.key))
  const configText = (await Promise.all(REQUIRED_CONFIG_FILES.map(filename => fs.readFile(path.join(configDirectory, filename), 'utf8')))).join('\n')
  const tokens = [...configText.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map(match => match[1].trim())
  const runtimeAutomationParameters = new Set([
    'AutomationAssumeRole',
    'IamInstanceProfile',
    'InstanceId',
    'LoadBalancerArn',
    'LogDestination',
  ])
  const unknown = [...new Set(tokens.filter(token =>
    !token.startsWith('account ') && !known.has(token) && !runtimeAutomationParameters.has(token),
  ))]
  unknown.forEach(token => errors.push(`Unknown replacement token '{{ ${token} }}'`))
}

const collectReferencedFiles = documents => {
  const references = []
  Object.entries(documents).forEach(([filename, document]) => {
    walk(document, (value, pointer) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return
      for (const key of ['policy', 'template', 'rolePolicyFile', 'dynamicPartitioning']) {
        if (typeof value[key] === 'string') {
          references.push({ filename, pointer, target: value[key] })
        }
      }
    })
  })
  return references
}

const validateReferencedFiles = async (configDirectory, documents, errors) => {
  for (const reference of collectReferencedFiles(documents)) {
    try {
      await fs.access(path.join(configDirectory, reference.target))
    } catch {
      errors.push(`${reference.filename}${reference.pointer}: referenced file does not exist: ${reference.target}`)
    }
  }
}

const renderPolicyVariables = (content, documents) => {
  const replacements = Object.fromEntries(
    (documents['replacements-config.yaml'].globalReplacements ?? []).map(item => [item.key, item.value]),
  )
  const scalarVariables = {
    PARTITION: 'aws',
    ACCELERATOR_PREFIX: replacements.AcceleratorPrefix,
    ACCELERATOR_PREFIX_ND: String(replacements.AcceleratorPrefix).replace(/-$/, ''),
    ACCELERATOR_PREFIX_LND: String(replacements.AcceleratorPrefix).replace(/-$/, '').toLowerCase(),
    ACCELERATOR_DEFAULT_PREFIX_SHORTHAND: String(replacements.AcceleratorPrefix).slice(0, 4).toUpperCase(),
    ACCELERATOR_SSM_PREFIX: `/${replacements.AcceleratorPrefix}`,
    MANAGEMENT_ACCOUNT_ACCESS_ROLE: documents['global-config.yaml'].managementAccountAccessRole,
    HOME_REGION: replacements.HomeRegion,
    LOGARCHIVE_ACCOUNT_ID: '111122223333',
    MANAGEMENT_ACCOUNT_ID: '111122223333',
    AUDIT_ACCOUNT_ID: '111122223333',
    ACCOUNT_ID: '111122223333',
    ORG_ID: 'o-exampleorgid',
  }
  const withLookups = content.replace(/\$\{ACCEL_LOOKUP::CUSTOM:([^}]+)\}/g, (match, key, offset) => {
    const value = replacements[key]
    if (value === undefined) return match
    const precedingCharacter = content[offset - 1]
    return Array.isArray(value) && precedingCharacter !== '"' ? JSON.stringify(value) : String(value)
  })
  return Object.entries(scalarVariables).reduce(
    (result, [key, value]) => result.replaceAll(`\${${key}}`, String(value)),
    withLookups,
  )
}

const validateJsonPolicies = async (configDirectory, documents, errors) => {
  const organization = documents['organization-config.yaml']
  const groups = [
    ['serviceControlPolicies', 5120],
    ['resourceControlPolicies', 5120],
    ['declarativePolicies', 10000],
    ['taggingPolicies', 10000],
    ['backupPolicies', 10000],
  ]
  for (const [group, maximumSize] of groups) {
    for (const policy of organization[group] ?? []) {
      const filename = path.join(configDirectory, policy.policy)
      try {
        const content = renderPolicyVariables(await fs.readFile(filename, 'utf8'), documents)
        if (/\$\{[^}]+\}/.test(content)) {
          throw new Error('contains unresolved LZA policy variables')
        }
        const parsed = JSON.parse(content)
        const minifiedSize = Buffer.byteLength(JSON.stringify(parsed))
        if (minifiedSize > maximumSize) {
          errors.push(`${policy.policy}: minified policy is ${minifiedSize} bytes; maximum is ${maximumSize}`)
        }
      } catch (error) {
        errors.push(`${policy.policy}: invalid or unreadable JSON policy: ${error.message}`)
      }
    }
  }
}

const validateHealthcareInvariants = (documents, profile, errors) => {
  const organization = documents['organization-config.yaml']
  const global = documents['global-config.yaml']
  const iam = documents['iam-config.yaml']
  const network = documents['network-config.yaml']
  const security = documents['security-config.yaml']
  const policy = (organization.serviceControlPolicies ?? []).find(item => item.name.includes('Healthcare-Hipaa-Eligible-Services'))
  if (!policy || (policy.deploymentTargets?.organizationalUnits ?? []).length !== 0) {
    errors.push('HIPAA-eligible-services SCP must exist with an empty OU target list until live policy testing is approved')
  }
  if (global.cloudwatchLogRetentionInDays !== 3653) {
    errors.push('Healthcare profile must explicitly select the 3653-day CloudWatch Logs retention option')
  }
  if (profile.profile.cis?.targetLevel !== 1 || profile.profile.cis?.level2Controls !== 'monitor') {
    errors.push('Healthcare profile must declare CIS Level 1 as the target and Level 2 as monitor-only')
  }
  const cis = security.centralSecurityServices?.securityHub?.standards?.find(item => item.name === 'CIS AWS Foundations Benchmark v3.0.0')
  if (!cis?.enable) {
    errors.push('CIS AWS Foundations Benchmark v3.0.0 must remain enabled')
  }
  const transitGateways = network.transitGateways ?? []
  if (profile.profile.preferredNetwork !== 'hub-and-spoke' || transitGateways.length === 0) {
    errors.push('Healthcare profile currently supports the hub-and-spoke network model only')
  }
  if (network.centralNetworkServices?.delegatedAdminAccount !== 'Network' || transitGateways.some(item => item.account !== 'Network')) {
    errors.push("The Network account must own hub transit gateways and delegated central network services")
  }
  const boundaryPolicy = iam.policySets
    ?.flatMap(item => item.policies ?? [])
    .find(item => item.name.includes('End-User-Policy'))
  const boundedSsmRole = iam.roleSets
    ?.flatMap(item => item.roles ?? [])
    .find(item => item.name === 'EC2-Default-SSM-Role' && item.boundaryPolicy?.includes('End-User-Policy'))
  if (!boundaryPolicy || !boundedSsmRole) {
    errors.push('Universal permission-boundary policy and its EC2-Default-SSM-Role attachment must be retained')
  }
}

const validateReportHashes = async (configDirectory, errors) => {
  const reportPath = path.join(configDirectory, 'composition-report.json')
  try {
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'))
    for (const [relativeFilename, expectedHash] of Object.entries(report.hashes ?? {})) {
      const actualHash = crypto.createHash('sha256').update(await fs.readFile(path.join(configDirectory, relativeFilename))).digest('hex')
      if (actualHash !== expectedHash) {
        errors.push(`${relativeFilename}: content does not match composition-report.json`)
      }
    }
  } catch (error) {
    errors.push(`Unable to validate composition report: ${error.message}`)
  }
}

const validateGeneratedConfig = async ({ configDirectory, profileDirectory }) => {
  const errors = []
  const documents = {}
  for (const filename of [...REQUIRED_CONFIG_FILES, 'replacements-config.yaml']) {
    try {
      documents[filename] = (await loadYamlDocument(path.join(configDirectory, filename))).document
    } catch (error) {
      errors.push(`${filename}: invalid YAML: ${error.message}`)
    }
  }
  if (errors.length > 0) return errors

  Object.entries(documents).forEach(([filename, document]) => collectNamedDuplicates(document, filename, errors))
  validateReferences(documents, errors)
  await validateReplacementKeys(configDirectory, documents, errors)
  await validateReferencedFiles(configDirectory, documents, errors)
  await validateJsonPolicies(configDirectory, documents, errors)
  const profile = yaml.load(await fs.readFile(path.join(profileDirectory, 'profile.yaml'), 'utf8'))
  validateHealthcareInvariants(documents, profile, errors)
  await validateReportHashes(configDirectory, errors)
  return errors
}

const main = async () => {
  const args = parseArguments(process.argv.slice(2))
  const errors = await validateGeneratedConfig({ configDirectory: args.config, profileDirectory: args.profile })
  if (errors.length > 0) {
    errors.forEach(error => console.error(`Validation error: ${error}`))
    process.exit(1)
  }
  console.log('Generated healthcare configuration validation passed')
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Validation failed: ${error.message}`)
    process.exit(1)
  })
}

module.exports = {
  collectNamedDuplicates,
  validateGeneratedConfig,
  validateHealthcareInvariants,
}
