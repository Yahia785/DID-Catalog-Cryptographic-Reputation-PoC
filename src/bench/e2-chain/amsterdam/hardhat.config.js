// Hardhat 3 config for the local node that src/bench/e2.ts starts with --chain=local-amsterdam (`hardhat node`).
// Same settings as ../hardhat.config.cjs (Hardhat 2, --chain=local) except the hardfork: amsterdam (Sepolia's current rules).
// Nothing is compiled by Hardhat: the contract is compiled by ../compile.ts (solc 0.8.28, optimizer 200, evmVersion paris).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.resolve(here, '../../../../output/e2/hardhat-amsterdam');

export default {
  solidity: '0.8.28',
  paths: { sources: path.resolve(here, 'no-sources'), cache: path.join(scratch, 'cache'), artifacts: path.join(scratch, 'artifacts') },
  networks: {
    default: {
      type: 'edr-simulated', chainType: 'l1', hardfork: 'amsterdam', chainId: 31337,
      blockGasLimit: 30_000_000, initialBaseFeePerGas: 1_000_000_000n,
      mining: { auto: true, interval: 0 },
    },
  },
};
