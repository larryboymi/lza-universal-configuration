#!/usr/bin/env node

const fs = require('fs/promises')
const path = require('path')
const { LZA_COMMIT, LZA_VERSION, SCHEMAS, hashContent, schemaUrl } = require('./lib/lza-schema')

const main = async () => {
  const outputFlag = process.argv.indexOf('--output')
  if (outputFlag < 0 || !process.argv[outputFlag + 1]) {
    throw new Error('Usage: download-lza-schemas.js --output <directory>')
  }
  const outputDirectory = path.resolve(process.argv[outputFlag + 1])
  await fs.mkdir(outputDirectory, { recursive: true })

  for (const [filename, expectedHash] of Object.entries(SCHEMAS)) {
    const destination = path.join(outputDirectory, filename)
    try {
      const existing = await fs.readFile(destination)
      if (hashContent(existing) !== expectedHash) {
        throw new Error(`Existing schema has an unexpected hash: ${destination}`)
      }
      console.log(`Verified cached schema ${filename}`)
      continue
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }

    const response = await fetch(schemaUrl(filename))
    if (!response.ok) {
      throw new Error(`Unable to download ${filename}: HTTP ${response.status}`)
    }
    const content = Buffer.from(await response.arrayBuffer())
    const actualHash = hashContent(content)
    if (actualHash !== expectedHash) {
      throw new Error(`Hash mismatch for ${filename}: expected ${expectedHash}, received ${actualHash}`)
    }
    await fs.writeFile(destination, content, { flag: 'wx' })
    console.log(`Downloaded and verified ${filename}`)
  }

  await fs.writeFile(
    path.join(outputDirectory, 'source.json'),
    `${JSON.stringify({ lzaVersion: LZA_VERSION, lzaCommit: LZA_COMMIT, schemas: SCHEMAS }, null, 2)}\n`,
  )
}

main().catch(error => {
  console.error(`Schema download failed: ${error.message}`)
  process.exit(1)
})
