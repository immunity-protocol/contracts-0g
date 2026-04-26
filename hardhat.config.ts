import { defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { configVariable } from "hardhat/config";

// 0G Galileo testnet pins:
//   - chainId 16602 (NOT 16601 — that's a deprecated ThirdWeb listing)
//   - evmVersion "shanghai" — Galileo does not support Cancun opcodes
//     (no MCOPY, TLOAD, TSTORE, BLOBHASH, BLOBBASEFEE)
//   - default RPC: https://evmrpc-testnet.0g.ai (rate-limited dev endpoint)

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.24",
        settings: {
          evmVersion: "shanghai",
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
    },
  },
  networks: {
    ogGalileo: {
      type: "http",
      chainType: "l1",
      chainId: 16602,
      url: configVariable("IMMUNITY_GALILEO_RPC"),
      accounts: [configVariable("IMMUNITY_DEPLOYER_PK")],
    },
  },
});
