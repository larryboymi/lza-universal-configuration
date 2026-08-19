const crypto = require('crypto')

const LZA_VERSION = '1.16.0'
const LZA_COMMIT = '6b9b2551b3cffd078f7b30dcc4d633109cfeec25'
const SCHEMAS = {
  'accounts-config.json': '85b60e87cd1065772242b47076c96d188c3bdd793cc1751a71914173031a146b',
  'global-config.json': '27e60f86b0ae7180b39e1fb8d4b2cd64dedc724ae9f8da5544abae39e661d154',
  'iam-config.json': '34644fe897c8f1463283dd59ac0ce95f13e9353634cfbc41b60c3daa9a700eb3',
  'network-config.json': 'f504797dce425a0b3798878aea485a191c0ff0b1232dcd027c7831b18e98fc7c',
  'organization-config.json': 'ffa30a350d53afcb450c8f50e9b0a0cdd7ef9950de3c4e7166951d022ed73c44',
  'replacements-config.json': 'df6661e50eb1a68edf5ed1f9886b2bfc980f848d9a63218c95ba9151e283ad01',
  'security-config.json': 'b6e25a7ac958bbb741b28f7eb298b5bf90f5395e192c846a28901ad1e9ebfb53',
}

const hashContent = content => crypto.createHash('sha256').update(content).digest('hex')

const schemaUrl = filename =>
  `https://raw.githubusercontent.com/awslabs/landing-zone-accelerator-on-aws/${LZA_COMMIT}/source/packages/@aws-accelerator/config/lib/schemas/${filename}`

module.exports = {
  LZA_COMMIT,
  LZA_VERSION,
  SCHEMAS,
  hashContent,
  schemaUrl,
}
