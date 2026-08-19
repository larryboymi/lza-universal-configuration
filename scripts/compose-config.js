#!/usr/bin/env node

const path = require('path')
const { composeConfig } = require('./lib/config-overlay')

const parseArguments = args => {
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!flag?.startsWith('--') || !value) {
      throw new Error('Arguments must be provided as --name value pairs')
    }
    values.set(flag.slice(2), value)
  }
  const required = ['base', 'network', 'profile', 'output']
  const missing = required.filter(name => !values.has(name))
  if (missing.length > 0) {
    throw new Error(`Missing required arguments: ${missing.map(name => `--${name}`).join(', ')}`)
  }
  return Object.fromEntries(required.map(name => [name, path.resolve(values.get(name))]))
}

const main = async () => {
  const args = parseArguments(process.argv.slice(2))
  const report = await composeConfig({
    baseDirectory: args.base,
    networkDirectory: args.network,
    profileDirectory: args.profile,
    outputDirectory: args.output,
  })
  console.log(`Composed profile '${report.profile.id}' at ${args.output}`)
  console.log(`Applied ${report.results.length} overlay actions`)
}

main().catch(error => {
  console.error(`Composition failed: ${error.message}`)
  process.exit(1)
})
