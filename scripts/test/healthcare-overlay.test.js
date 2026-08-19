const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const yaml = require('js-yaml')
const { spawnSync } = require('child_process')
const { composeConfig, loadYamlDocument } = require('../lib/config-overlay')
const { validateGeneratedConfig } = require('../validate-generated-config')
const { loadMaterializedDocuments } = require('../validate-lza-schema')

const repositoryRoot = path.resolve(__dirname, '../..')
const baseDirectory = path.join(repositoryRoot, 'modules/base/default')
const networkDirectory = path.join(repositoryRoot, 'modules/network/hub-and-spoke')
const profileDirectory = path.join(repositoryRoot, 'modules/industry/healthcare')

const withTemporaryDirectory = async action => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lza-healthcare-test-'))
  try {
    return await action(directory)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

const compose = async outputDirectory => composeConfig({
  baseDirectory,
  networkDirectory,
  profileDirectory,
  outputDirectory,
})

test('composes and validates the healthcare hub-and-spoke profile', async () =>
  withTemporaryDirectory(async temporaryDirectory => {
    const outputDirectory = path.join(temporaryDirectory, 'generated')
    const report = await compose(outputDirectory)
    const errors = await validateGeneratedConfig({ configDirectory: outputDirectory, profileDirectory })

    assert.deepEqual(errors, [])
    assert.equal(report.profile.id, 'healthcare')

    const organization = (await loadYamlDocument(path.join(outputDirectory, 'organization-config.yaml'))).document
    const network = (await loadYamlDocument(path.join(outputDirectory, 'network-config.yaml'))).document
    const global = (await loadYamlDocument(path.join(outputDirectory, 'global-config.yaml'))).document
    const healthcarePolicy = organization.serviceControlPolicies.find(item => item.name.includes('Healthcare-Hipaa'))

    assert.deepEqual(healthcarePolicy.deploymentTargets.organizationalUnits, [])
    assert.equal(global.cloudwatchLogRetentionInDays, 3653)
    assert.equal(network.centralNetworkServices.delegatedAdminAccount, 'Network')
    assert.ok(organization.organizationalUnits.some(item => item.name === 'Workloads/Prod/Healthcare'))
  }))

test('identical inputs produce identical generated hashes', async () =>
  withTemporaryDirectory(async temporaryDirectory => {
    const first = await compose(path.join(temporaryDirectory, 'first'))
    const second = await compose(path.join(temporaryDirectory, 'second'))
    assert.deepEqual(first, second)
  }))

test('materializes replacement arrays and numbers before LZA schema validation', async () =>
  withTemporaryDirectory(async temporaryDirectory => {
    const outputDirectory = path.join(temporaryDirectory, 'generated')
    await compose(outputDirectory)
    const documents = await loadMaterializedDocuments(outputDirectory)
    assert.deepEqual(documents['global-config.yaml'].enabledRegions, ['us-east-1'])
    assert.equal(typeof documents['network-config.yaml'].transitGateways[0].asn, 'number')
  }))

test('refuses to compose into an existing output directory', async () =>
  withTemporaryDirectory(async temporaryDirectory => {
    const outputDirectory = path.join(temporaryDirectory, 'generated')
    await fs.mkdir(outputDirectory)
    await assert.rejects(() => compose(outputDirectory), /Output directory already exists/)
  }))

test('fails rather than replacing a conflicting named object', async () =>
  withTemporaryDirectory(async temporaryDirectory => {
    const modifiedBase = path.join(temporaryDirectory, 'base')
    await fs.cp(baseDirectory, modifiedBase, { recursive: true })
    const organizationPath = path.join(modifiedBase, 'organization-config.yaml')
    const content = await fs.readFile(organizationPath, 'utf8')
    await fs.writeFile(
      organizationPath,
      content.replace(
        '  - name: Workloads/Prod',
        '  - name: Workloads/Prod\n  - name: Workloads/Prod/Healthcare\n    ignore: true',
      ),
    )

    await assert.rejects(
      () => composeConfig({
        baseDirectory: modifiedBase,
        networkDirectory,
        profileDirectory,
        outputDirectory: path.join(temporaryDirectory, 'generated'),
      }),
      /Overlay collision/,
    )
    await assert.rejects(() => fs.access(path.join(temporaryDirectory, 'generated')), { code: 'ENOENT' })
  }))

test('fails when a guarded replacement sees unexpected base drift', async () =>
  withTemporaryDirectory(async temporaryDirectory => {
    const modifiedBase = path.join(temporaryDirectory, 'base')
    await fs.cp(baseDirectory, modifiedBase, { recursive: true })
    const globalPath = path.join(modifiedBase, 'global-config.yaml')
    const content = await fs.readFile(globalPath, 'utf8')
    await fs.writeFile(globalPath, content.replace('cloudwatchLogRetentionInDays: 365', 'cloudwatchLogRetentionInDays: 731'))

    await assert.rejects(
      () => composeConfig({
        baseDirectory: modifiedBase,
        networkDirectory,
        profileDirectory,
        outputDirectory: path.join(temporaryDirectory, 'generated'),
      }),
      /Refusing to overwrite/,
    )
  }))

test('detects edits made after composition', async () =>
  withTemporaryDirectory(async temporaryDirectory => {
    const outputDirectory = path.join(temporaryDirectory, 'generated')
    await compose(outputDirectory)
    const globalPath = path.join(outputDirectory, 'global-config.yaml')
    await fs.appendFile(globalPath, '\n# unexpected post-composition edit\n')
    const errors = await validateGeneratedConfig({ configDirectory: outputDirectory, profileDirectory })
    assert.ok(errors.some(error => error.includes('does not match composition-report.json')))
  }))

test('profile keeps CIS Level 1 target metadata and the service allow-list staged', async () => {
  const profile = yaml.load(await fs.readFile(path.join(profileDirectory, 'profile.yaml'), 'utf8'))
  const servicePolicyOperation = profile.operations.find(operation =>
    operation.file === 'organization-config.yaml' && operation.value?.name?.includes('Healthcare-Hipaa'),
  )

  assert.equal(profile.profile.cis.targetLevel, 1)
  assert.equal(profile.profile.cis.level2Controls, 'monitor')
  assert.deepEqual(servicePolicyOperation.value.deploymentTargets.organizationalUnits, [])
})

test('profile does not import historical healthcare permission boundaries', async () => {
  const profileFiles = await fs.readdir(profileDirectory, { recursive: true })
  assert.equal(profileFiles.some(filename => /boundary-policy\.json$/.test(filename)), false)
})

test('historical service allow-list remains a deny/not-action guardrail within the SCP size limit', async () => {
  const filename = path.join(profileDirectory, 'service-control-policies/healthcare-hipaa-eligible-services.json')
  const policy = JSON.parse(await fs.readFile(filename, 'utf8'))
  assert.equal(policy.Statement[0].Effect, 'Deny')
  assert.ok(Array.isArray(policy.Statement[0].NotAction))
  assert.ok(policy.Statement[0].NotAction.includes('healthlake:*'))
  assert.ok(Buffer.byteLength(JSON.stringify(policy)) <= 5120)
})

test('universal boundary retains delegated-role and network protections', async () => {
  const filename = path.join(baseDirectory, 'iam-policies/sample-end-user-policy.json')
  const policy = JSON.parse(await fs.readFile(filename, 'utf8'))
  const enforceBoundary = policy.Statement.find(statement => statement.Sid === 'EnforceBoundary')
  const denyNetwork = policy.Statement.find(statement => statement.Sid === 'DenyVPCChanges')
  assert.ok(enforceBoundary.Condition.ArnLike['iam:PermissionsBoundary'].includes('End-User-Policy'))
  assert.equal(denyNetwork.Effect, 'Deny')
  assert.ok(denyNetwork.Action.includes('ec2:CreateVpc*'))
})

test('legacy environment mutation script exits nonzero when transformation fails', () => {
  const result = spawnSync(process.execPath, [path.join(repositoryRoot, 'scripts/index.js'), '/directory/that/does/not/exist'], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
})

test('healthcare profile rejects the unsupported shared-vpc network model', async () =>
  withTemporaryDirectory(async temporaryDirectory => {
    await assert.rejects(
      () => composeConfig({
        baseDirectory,
        networkDirectory: path.join(repositoryRoot, 'modules/network/shared-vpc'),
        profileDirectory,
        outputDirectory: path.join(temporaryDirectory, 'generated'),
      }),
      /Selector|hub-and-spoke/,
    )
  }))

test('validator detects missing referenced assets', async () =>
  withTemporaryDirectory(async temporaryDirectory => {
    const outputDirectory = path.join(temporaryDirectory, 'generated')
    await compose(outputDirectory)
    await fs.rm(path.join(outputDirectory, 'tagging-policies/healthcare-data-classification.json'))
    const errors = await validateGeneratedConfig({ configDirectory: outputDirectory, profileDirectory })
    assert.ok(errors.some(error => error.includes('referenced file does not exist')))
  }))

test('validator detects unknown accounts and replacement tokens', async () =>
  withTemporaryDirectory(async temporaryDirectory => {
    const outputDirectory = path.join(temporaryDirectory, 'generated')
    await compose(outputDirectory)
    const networkPath = path.join(outputDirectory, 'network-config.yaml')
    const networkContent = await fs.readFile(networkPath, 'utf8')
    await fs.writeFile(networkPath, networkContent.replace('delegatedAdminAccount: Network', 'delegatedAdminAccount: MissingAccount'))
    const globalPath = path.join(outputDirectory, 'global-config.yaml')
    const globalContent = await fs.readFile(globalPath, 'utf8')
    await fs.writeFile(globalPath, globalContent.replace('{{ AcceleratorPrefix }}', '{{ MissingReplacement }}'))
    const errors = await validateGeneratedConfig({ configDirectory: outputDirectory, profileDirectory })
    assert.ok(errors.some(error => error.includes("unknown account 'MissingAccount'")))
    assert.ok(errors.some(error => error.includes("Unknown replacement token '{{ MissingReplacement }}'")))
  }))

test('validator detects duplicate named objects', async () =>
  withTemporaryDirectory(async temporaryDirectory => {
    const outputDirectory = path.join(temporaryDirectory, 'generated')
    await compose(outputDirectory)
    const organizationPath = path.join(outputDirectory, 'organization-config.yaml')
    const organizationContent = await fs.readFile(organizationPath, 'utf8')
    await fs.writeFile(
      organizationPath,
      organizationContent.replace(
        'organizationalUnits:',
        'organizationalUnits:\n  - name: Workloads/Prod/Healthcare',
      ),
    )
    const errors = await validateGeneratedConfig({ configDirectory: outputDirectory, profileDirectory })
    assert.ok(errors.some(error => error.includes("duplicate name 'Workloads/Prod/Healthcare'")))
  }))
