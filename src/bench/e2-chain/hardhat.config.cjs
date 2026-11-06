// Config for the local Ethereum node that src/bench/e2.ts starts (`hardhat node`). Nothing is compiled by Hardhat:
// the contract is compiled by compile.ts with the solc npm package. Cache and artifacts go to a scratch folder.
const path = require('node:path');
const scratch = path.resolve(__dirname, '../../../output/e2/hardhat');
module.exports = {
  solidity: '0.8.28',
  paths: { sources: path.resolve(__dirname, 'no-sources'), cache: path.join(scratch, 'cache'), artifacts: path.join(scratch, 'artifacts') },
  networks: { hardhat: { chainId: 31337, mining: { auto: true, interval: 0 } } },
};
