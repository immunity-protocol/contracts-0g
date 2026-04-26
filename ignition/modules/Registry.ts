import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/// Deploys the Registry against an existing USDC token. Pass the USDC
/// address via Ignition parameters (see ignition/parameters/galileo.json).
/// On testnet, deploy.sh deploys MockUSDC first and writes its address
/// into the parameters file before running this module.
export default buildModule("Registry", (m) => {
  const usdc = m.getParameter("usdc");
  const registry = m.contract("Registry", [usdc]);
  return { registry };
});
