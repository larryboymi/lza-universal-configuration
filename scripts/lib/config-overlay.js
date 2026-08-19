const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const yaml = require('js-yaml')

const GENERATED_MARKER = '.lza-generated-config'
const REQUIRED_CONFIG_FILES = [
  'accounts-config.yaml',
  'global-config.yaml',
  'iam-config.yaml',
  'network-config.yaml',
  'organization-config.yaml',
  'security-config.yaml',
]

const protectReplacements = content => {
  const replacements = []
  const tokenByValue = new Map()
  const protectedContent = content.replace(/\{\{[^}]+\}\}/g, value => {
    const existingToken = tokenByValue.get(value)
    if (existingToken) return existingToken
    const token = `__LZA_REPLACEMENT_${replacements.length}__`
    replacements.push({ token, value })
    tokenByValue.set(value, token)
    return token
  })

  return { protectedContent, replacements }
}

const restoreReplacements = (content, replacements) =>
  replacements.reduce(
    (result, { token, value }) => result.replaceAll(token, value),
    content,
  )

const protectOperationPath = (operationPath, replacements) =>
  replacements.reduce(
    (result, { token, value }) => result.replaceAll(value, token),
    operationPath,
  )

const loadYamlDocument = async filename => {
  const content = await fs.readFile(filename, 'utf8')
  const { protectedContent, replacements } = protectReplacements(content)

  return {
    document: yaml.load(protectedContent),
    replacements,
  }
}

const writeYamlDocument = async (filename, document, replacements) => {
  const serialized = yaml.dump(document, {
    lineWidth: 120,
    noRefs: true,
    quotingType: '"',
  })
  await fs.writeFile(filename, restoreReplacements(serialized, replacements))
}

const decodeSegment = segment => decodeURIComponent(segment.replaceAll('~1', '/').replaceAll('~0', '~'))

const selectSegment = (current, rawSegment, operationPath) => {
  const segment = decodeSegment(rawSegment)
  if (!segment.startsWith('@')) {
    if (current === undefined || current === null || !(segment in current)) {
      throw new Error(`Path does not exist: ${operationPath} (missing '${segment}')`)
    }
    return current[segment]
  }

  if (!Array.isArray(current)) {
    throw new Error(`Selector '${segment}' requires an array at ${operationPath}`)
  }

  const separator = segment.indexOf('=')
  if (separator < 2) {
    throw new Error(`Invalid selector '${segment}' at ${operationPath}`)
  }
  const key = segment.slice(1, separator)
  const value = segment.slice(separator + 1)
  const matches = current.filter(item => item && String(item[key]) === value)
  if (matches.length !== 1) {
    throw new Error(`Selector '${segment}' matched ${matches.length} items at ${operationPath}`)
  }
  return matches[0]
}

const resolvePath = (document, operationPath) => {
  if (!operationPath.startsWith('/')) {
    throw new Error(`Overlay path must start with '/': ${operationPath}`)
  }
  return operationPath
    .slice(1)
    .split('/')
    .filter(Boolean)
    .reduce((current, segment) => selectSegment(current, segment, operationPath), document)
}

const valuesEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right)

const applyOperation = (document, operation) => {
  const target = resolvePath(document, operation.path)

  if (operation.op === 'appendUniqueObject') {
    if (!Array.isArray(target)) {
      throw new Error(`appendUniqueObject target is not an array: ${operation.path}`)
    }
    const identity = operation.identity
    const identityValue = operation.value?.[identity]
    if (!identity || identityValue === undefined) {
      throw new Error(`appendUniqueObject requires an identity present in value: ${operation.path}`)
    }
    const existing = target.find(item => item && item[identity] === identityValue)
    if (existing) {
      if (valuesEqual(existing, operation.value)) {
        return 'unchanged'
      }
      throw new Error(`Overlay collision at ${operation.path}: ${identity} '${identityValue}' already exists`)
    }
    target.push(operation.value)
    return 'added'
  }

  if (operation.op === 'appendUniqueScalar') {
    if (!Array.isArray(target)) {
      throw new Error(`appendUniqueScalar target is not an array: ${operation.path}`)
    }
    if (target.includes(operation.value)) {
      return 'unchanged'
    }
    target.push(operation.value)
    return 'added'
  }

  if (operation.op === 'set') {
    const parentPath = operation.path.split('/').slice(0, -1).join('/') || '/'
    const key = decodeSegment(operation.path.split('/').at(-1))
    const parent = parentPath === '/' ? document : resolvePath(document, parentPath)
    if (!valuesEqual(parent[key], operation.expected)) {
      throw new Error(
        `Refusing to overwrite ${operation.path}: expected ${JSON.stringify(operation.expected)}, found ${JSON.stringify(parent[key])}`,
      )
    }
    parent[key] = operation.value
    return valuesEqual(operation.expected, operation.value) ? 'unchanged' : 'updated'
  }

  throw new Error(`Unsupported overlay operation '${operation.op}'`)
}

const hashFile = async filename => crypto.createHash('sha256').update(await fs.readFile(filename)).digest('hex')

const listFiles = async directory => {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const absolute = path.join(directory, entry.name)
    return entry.isDirectory() ? listFiles(absolute) : [absolute]
  }))
  return nested.flat().sort()
}

const prepareOutput = async outputDirectory => {
  try {
    await fs.access(outputDirectory)
    throw new Error(`Output directory already exists: ${outputDirectory}`)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
  }
  await fs.mkdir(outputDirectory, { recursive: true })
  await fs.writeFile(path.join(outputDirectory, GENERATED_MARKER), 'Generated by scripts/compose-config.js\n')
}

const assertOutputDoesNotExist = async outputDirectory => {
  try {
    await fs.access(outputDirectory)
    throw new Error(`Output directory already exists: ${outputDirectory}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

const copyDirectoryContents = async (source, destination) => {
  const entries = await fs.readdir(source, { withFileTypes: true })
  await Promise.all(entries.map(async entry => {
    const sourcePath = path.join(source, entry.name)
    const destinationPath = path.join(destination, entry.name)
    if (entry.isDirectory()) {
      await fs.cp(sourcePath, destinationPath, { recursive: true, errorOnExist: true })
      return
    }
    try {
      await fs.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL)
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new Error(`Composition collision while copying '${entry.name}' from ${source}`)
      }
      throw error
    }
  }))
}

const loadProfile = async profileDirectory => {
  const manifestPath = path.join(profileDirectory, 'profile.yaml')
  const manifest = yaml.load(await fs.readFile(manifestPath, 'utf8'))
  if (manifest?.schemaVersion !== 1 || !manifest?.profile?.id || !Array.isArray(manifest.operations)) {
    throw new Error(`Invalid overlay manifest: ${manifestPath}`)
  }
  const isSafeRelativePath = value =>
    typeof value === 'string' && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..')
  for (const asset of manifest.assets ?? []) {
    if (!isSafeRelativePath(asset.source) || !isSafeRelativePath(asset.destination)) {
      throw new Error(`Overlay asset paths must remain inside their source and output directories: ${manifestPath}`)
    }
  }
  const supportedOperations = new Set(['appendUniqueObject', 'appendUniqueScalar', 'set'])
  for (const operation of manifest.operations) {
    if (!supportedOperations.has(operation.op) || !isSafeRelativePath(operation.file) || !operation.path?.startsWith('/')) {
      throw new Error(`Invalid overlay operation in ${manifestPath}`)
    }
  }
  return { manifest, manifestPath }
}

const composeConfig = async ({ baseDirectory, networkDirectory, profileDirectory, outputDirectory }) => {
  await assertOutputDoesNotExist(outputDirectory)
  const { manifest, manifestPath } = await loadProfile(profileDirectory)
  if (path.basename(networkDirectory) !== manifest.profile.preferredNetwork) {
    throw new Error(
      `Profile '${manifest.profile.id}' requires the '${manifest.profile.preferredNetwork}' network module`,
    )
  }
  const stagingDirectory = `${outputDirectory}.tmp-${crypto.randomUUID()}`
  try {
    await prepareOutput(stagingDirectory)
    await copyDirectoryContents(baseDirectory, stagingDirectory)
    await copyDirectoryContents(networkDirectory, stagingDirectory)

    const results = []

    for (const asset of manifest.assets ?? []) {
      const source = path.join(profileDirectory, asset.source)
      const destination = path.join(stagingDirectory, asset.destination)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL)
      results.push({ type: 'asset', source: asset.source, destination: asset.destination, result: 'added' })
    }

    const operationsByFile = manifest.operations.reduce((groups, operation) => ({
      ...groups,
      [operation.file]: [...(groups[operation.file] ?? []), operation],
    }), {})
    for (const [relativeFilename, operations] of Object.entries(operationsByFile)) {
      const filename = path.join(stagingDirectory, relativeFilename)
      const { document, replacements } = await loadYamlDocument(filename)
      for (const operation of operations) {
        const normalizedOperation = {
          ...operation,
          path: protectOperationPath(operation.path, replacements),
        }
        results.push({
          type: 'operation',
          file: relativeFilename,
          op: operation.op,
          path: operation.path,
          result: applyOperation(document, normalizedOperation),
        })
      }
      await writeYamlDocument(filename, document, replacements)
    }

    const missingFiles = []
    for (const filename of REQUIRED_CONFIG_FILES) {
      try {
        await fs.access(path.join(stagingDirectory, filename))
      } catch {
        missingFiles.push(filename)
      }
    }
    if (missingFiles.length > 0) {
      throw new Error(`Generated configuration is missing required files: ${missingFiles.join(', ')}`)
    }

    const outputFiles = (await listFiles(stagingDirectory))
      .filter(filename => path.basename(filename) !== 'composition-report.json')
    const hashes = Object.fromEntries(await Promise.all(outputFiles.map(async filename => [
      path.relative(stagingDirectory, filename),
      await hashFile(filename),
    ])))
    const report = {
      schemaVersion: 1,
      profile: manifest.profile,
      inputs: {
        baseModule: path.basename(baseDirectory),
        networkModule: path.basename(networkDirectory),
        profileManifest: path.basename(manifestPath),
        profileManifestSha256: await hashFile(manifestPath),
      },
      results,
      hashes,
    }
    await fs.writeFile(path.join(stagingDirectory, 'composition-report.json'), `${JSON.stringify(report, null, 2)}\n`)
    await fs.rename(stagingDirectory, outputDirectory)
    return report
  } catch (error) {
    await fs.rm(stagingDirectory, { recursive: true, force: true })
    throw error
  }
}

module.exports = {
  GENERATED_MARKER,
  REQUIRED_CONFIG_FILES,
  applyOperation,
  composeConfig,
  loadYamlDocument,
  protectReplacements,
  resolvePath,
  restoreReplacements,
}
