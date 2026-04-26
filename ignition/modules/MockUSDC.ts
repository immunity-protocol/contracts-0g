import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/// Standalone MockUSDC deploy. Used on testnet (no canonical USDC on Galileo).
/// `deploy.sh` runs this first and feeds the resulting address into the
/// Registry module's `usdc` parameter.
export default buildModule("MockUSDC", (m) => {
  const usdc = m.contract("MockUSDC");
  return { usdc };
});
