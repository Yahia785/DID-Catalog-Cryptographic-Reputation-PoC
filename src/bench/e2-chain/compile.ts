import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Compile CredentialRegistry.sol with the solc npm package (no other toolchain) and write
 * CredentialRegistry.json (abi, bytecode, compiler, source hash). Run: npx tsx src/bench/e2-chain/compile.ts
 */
const dir = path.dirname(fileURLToPath(import.meta.url));
const solc = createRequire(import.meta.url)('solc');
const source = fs.readFileSync(path.join(dir, 'CredentialRegistry.sol'), 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'CredentialRegistry.sol': { content: source } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
if (errors.length) { console.error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n')); process.exit(1); }
const c = out.contracts['CredentialRegistry.sol'].CredentialRegistry;
const artifact = {
  contract: 'CredentialRegistry', compiler: `solc ${solc.version()}`, optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
  sourceSha256: crypto.createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex'),
  abi: c.abi, bytecode: `0x${c.evm.bytecode.object}`,
};
fs.writeFileSync(path.join(dir, 'CredentialRegistry.json'), JSON.stringify(artifact, null, 1));
console.log(`wrote CredentialRegistry.json (${artifact.compiler}, ${(artifact.bytecode.length - 2) / 2} bytes of init code)`);
