#!/bin/bash
set -euo pipefail

#
# deploy.sh — orchestrates a full Immunity Registry deploy on 0G Galileo.
#
# Usage:
#   ./scripts/deploy.sh                      # deploys MockUSDC + Registry (testnet default)
#   ./scripts/deploy.sh --usdc 0xCANONICAL   # uses an existing USDC token (mainnet)
#
# Requires keystore secrets:
#   npx hardhat keystore set IMMUNITY_GALILEO_RPC
#   npx hardhat keystore set IMMUNITY_DEPLOYER_PK
#

NETWORK="ogGalileo"
CHAIN_ID="16602"
DEPLOY_DIR="ignition/deployments/chain-${CHAIN_ID}"
PARAMS_FILE="ignition/parameters/galileo.json"
OUTPUT_FILE=".deploy.json"

USDC_ADDRESS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --usdc) USDC_ADDRESS="$2"; shift 2 ;;
    -h|--help)
      sed -n '3,15p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

echo "=== Immunity Registry Deployment (network: ${NETWORK}, chainId: ${CHAIN_ID}) ==="
echo ""

# ------------------------------------------------------------------
# Step 1 — clean previous deployment artifacts
# ------------------------------------------------------------------
echo "Step 1: cleaning previous deployment state..."
rm -rf "${DEPLOY_DIR}"
echo "  Done."
echo ""

# ------------------------------------------------------------------
# Step 2 — deploy MockUSDC if no canonical address provided
# ------------------------------------------------------------------
if [[ -z "${USDC_ADDRESS}" ]]; then
  echo "Step 2: no --usdc flag provided; deploying MockUSDC..."
  npx hardhat ignition deploy ignition/modules/MockUSDC.ts --network "${NETWORK}"
  echo ""

  USDC_ADDRESS=$(jq -r '."MockUSDC#MockUSDC"' "${DEPLOY_DIR}/deployed_addresses.json")
  if [[ -z "${USDC_ADDRESS}" || "${USDC_ADDRESS}" == "null" ]]; then
    echo "ERROR: failed to read MockUSDC address from ${DEPLOY_DIR}/deployed_addresses.json" >&2
    exit 1
  fi
  echo "  MockUSDC deployed at: ${USDC_ADDRESS}"
else
  echo "Step 2: using provided USDC address: ${USDC_ADDRESS}"
fi
echo ""

# ------------------------------------------------------------------
# Step 3 — write the parameters file with the resolved USDC address
# ------------------------------------------------------------------
echo "Step 3: writing ${PARAMS_FILE} with USDC address..."
jq --arg usdc "${USDC_ADDRESS}" '.Registry.usdc = $usdc' "${PARAMS_FILE}" \
  > "${PARAMS_FILE}.tmp" && mv "${PARAMS_FILE}.tmp" "${PARAMS_FILE}"
echo "  Done."
echo ""

# ------------------------------------------------------------------
# Step 4 — deploy Registry
# ------------------------------------------------------------------
echo "Step 4: deploying Registry..."
npx hardhat ignition deploy ignition/modules/Registry.ts --network "${NETWORK}" \
  --parameters "${PARAMS_FILE}"
echo ""

REGISTRY_ADDRESS=$(jq -r '."Registry#Registry"' "${DEPLOY_DIR}/deployed_addresses.json")
if [[ -z "${REGISTRY_ADDRESS}" || "${REGISTRY_ADDRESS}" == "null" ]]; then
  echo "ERROR: failed to read Registry address from ${DEPLOY_DIR}/deployed_addresses.json" >&2
  exit 1
fi
echo "  Registry deployed at: ${REGISTRY_ADDRESS}"
echo ""

# ------------------------------------------------------------------
# Step 5 — write .deploy.json + network.json
# ------------------------------------------------------------------
# .deploy.json is the deploy receipt (addresses + tx + timestamp).
# network.json is the canonical 11-field NetworkConfig snippet — the SDK and
# app sync from this file rather than re-deriving values, so a redeploy is
# a one-file copy across the three repos.
cat > "${OUTPUT_FILE}" <<EOF
{
  "network": "${NETWORK}",
  "chainId": ${CHAIN_ID},
  "registry": "${REGISTRY_ADDRESS}",
  "usdc": "${USDC_ADDRESS}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "Step 5a: wrote ${OUTPUT_FILE}"

NETWORK_JSON="network.json"
cat > "${NETWORK_JSON}" <<EOF
{
  "name": "galileo-testnet",
  "chainId": ${CHAIN_ID},
  "rpcUrl": "https://evmrpc-testnet.0g.ai",
  "registryAddress": "${REGISTRY_ADDRESS}",
  "usdcAddress": "${USDC_ADDRESS}",
  "blockExplorerUrl": "https://chainscan-galileo.0g.ai",
  "storageIndexerUrl": "https://indexer-storage-testnet-turbo.0g.ai",
  "computeProvider": "0xa48f01287233509FD694a22Bf840225062E67836",
  "computeModel": "qwen-2.5-7b-instruct",
  "axlHubs": [],
  "ensRpcUrl": "https://eth.llamarpc.com"
}
EOF
echo "Step 5b: wrote ${NETWORK_JSON}"
echo ""

# ------------------------------------------------------------------
# Step 6 — optional bootstrap (demo wallet funding, seed antibodies)
# ------------------------------------------------------------------
if [[ -f "scripts/post-deploy-bootstrap.ts" ]]; then
  echo "Step 6: running post-deploy bootstrap..."
  REGISTRY_ADDRESS="${REGISTRY_ADDRESS}" USDC_ADDRESS="${USDC_ADDRESS}" \
    npx hardhat run scripts/post-deploy-bootstrap.ts --network "${NETWORK}"
  echo ""
fi

echo "=== Deployment Complete ==="
echo ""
echo "Registry: ${REGISTRY_ADDRESS}"
echo "USDC:     ${USDC_ADDRESS}"
echo "Explorer: https://chainscan-galileo.0g.ai/address/${REGISTRY_ADDRESS}"
echo ""
