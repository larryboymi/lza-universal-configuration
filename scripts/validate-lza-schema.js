#!/usr/bin/env node

const fs = require('fs/promises')
const path = require('path')
const Ajv = require('ajv')
const { REQUIRED_CONFIG_FILES, loadYamlDocument } = require('./lib/config-overlay')
const { SCHEMAS, hashContent } = require('./lib/lza-schema')

const parseArguments = args => {
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    values.set(args[index]?.replace(/^--/, ''), args[index + 1])
  }
  if (!values.get('config') || !values.get('schemas')) {
    throw new Error('Usage: validate-lza-schema.js --config <directory> --schemas <directory>')
  }
  return {
    configDirectory: path.resolve(values.get('config')),
    schemaDirectory: path.resolve(values.get('schemas')),
  }
}

const materializeValue = (value, replacementValues, tokenDefinitions) => {
  if (Array.isArray(value)) {
    return value.flatMap(item => {
      const materialized = materializeValue(item, replacementValues, tokenDefinitions)
      return Array.isArray(materialized) ? materialized : [materialized]
    })
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, materializeValue(item, replacementValues, tokenDefinitions)]),
    )
  }
  if (typeof value !== 'string') return value

  const exactToken = tokenDefinitions.find(({ token }) => value === token)
  if (exactToken) {
    const key = exactToken.value.slice(2, -2).trim()
    return key in replacementValues ? replacementValues[key] : exactToken.value
  }
  return tokenDefinitions.reduce((result, { token, value: placeholder }) => {
    const key = placeholder.slice(2, -2).trim()
    const replacement = key in replacementValues ? replacementValues[key] : placeholder
    return result.replaceAll(token, String(replacement))
  }, value)
}

const loadMaterializedDocuments = async configDirectory => {
  const replacementsConfig = await loadYamlDocument(path.join(configDirectory, 'replacements-config.yaml'))
  const replacementValues = Object.fromEntries(
    (replacementsConfig.document.globalReplacements ?? []).map(item => [item.key, item.value]),
  )
  const filenames = [...REQUIRED_CONFIG_FILES, 'replacements-config.yaml']
  return Object.fromEntries(await Promise.all(filenames.map(async filename => {
    const loaded = filename === 'replacements-config.yaml'
      ? replacementsConfig
      : await loadYamlDocument(path.join(configDirectory, filename))
    return [filename, materializeValue(loaded.document, replacementValues, loaded.replacements)]
  })))
}

const validateLzaSchemas = async ({ configDirectory, schemaDirectory }) => {
  const documents = await loadMaterializedDocuments(configDirectory)
  const errors = []
  const ajv = new Ajv({ allErrors: true, strict: false })

  for (const [schemaFilename, expectedHash] of Object.entries(SCHEMAS)) {
    const schemaPath = path.join(schemaDirectory, schemaFilename)
    const schemaContent = await fs.readFile(schemaPath)
    if (hashContent(schemaContent) !== expectedHash) {
      errors.push(`${schemaFilename}: schema hash does not match the pinned LZA source`)
      continue
    }
    const configFilename = schemaFilename.replace(/\.json$/, '.yaml')
    const validate = ajv.compile(JSON.parse(schemaContent))
    if (!validate(documents[configFilename])) {
      errors.push(...validate.errors.map(error =>
        `${schemaFilename}${error.instancePath || '/'} ${error.message}`,
      ))
    }
  }
  return errors
}

const main = async () => {
  const args = parseArguments(process.argv.slice(2))
  const errors = await validateLzaSchemas(args)
  if (errors.length > 0) {
    errors.forEach(error => console.error(`Schema validation error: ${error}`))
    process.exit(1)
  }
  console.log('Pinned LZA v1.16.0 JSON Schema validation passed')
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Schema validation failed: ${error.message}`)
    process.exit(1)
  })
}

module.exports = {
  loadMaterializedDocuments,
  materializeValue,
  validateLzaSchemas,
}
