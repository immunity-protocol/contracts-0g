import hre from "hardhat";

/**
 * post-deploy-bootstrap.ts
 *
 * One-shot helper: mints demo USDC to a small list of wallets so they can
 * deposit/publish/check immediately after deploy. Skipped silently if no
 * MOCK_USDC_RECIPIENTS env var is set, so it is safe to run after every
 * deploy.
 *
 * Reads from env:
 *   REGISTRY_ADDRESS        — the deployed Registry (set by deploy.sh)
 *   USDC_ADDRESS            — the deployed (or canonical) USDC token
 *   MOCK_USDC_RECIPIENTS    — optional comma-separated list of addresses to fund
 *   MOCK_USDC_AMOUNT        — optional per-recipient amount in USDC units (6dp);
 *                             default 100_000_000 = 100 USDC.
 */
async function main() {
  const registryAddress = process.env.REGISTRY_ADDRESS;
  const usdcAddress = process.env.USDC_ADDRESS;
  const recipientsCsv = process.env.MOCK_USDC_RECIPIENTS ?? "";
  const amount = BigInt(process.env.MOCK_USDC_AMOUNT ?? "100000000");

  if (!registryAddress || !usdcAddress) {
    console.error("REGISTRY_ADDRESS and USDC_ADDRESS must be set");
    process.exit(1);
  }

  const recipients = recipientsCsv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (recipients.length === 0) {
    console.log("[bootstrap] no MOCK_USDC_RECIPIENTS set — skipping demo funding");
    return;
  }

  const connection = await hre.network.connect();
  const ethers = (connection as any).ethers;

  const usdc = await ethers.getContractAt("MockUSDC", usdcAddress);
  const code = await ethers.provider.getCode(usdcAddress);
  if (code === "0x") {
    console.error(`[bootstrap] no contract at ${usdcAddress} — aborting`);
    process.exit(1);
  }

  // Heuristic: only call mint if the token actually exposes it (i.e. it's a MockUSDC).
  let isMockable = false;
  try {
    await usdc.mint.staticCall(recipients[0], amount);
    isMockable = true;
  } catch {
    isMockable = false;
  }

  if (!isMockable) {
    console.log(`[bootstrap] USDC at ${usdcAddress} is not a MockUSDC — skipping`);
    return;
  }

  console.log(`[bootstrap] minting ${amount} USDC to ${recipients.length} recipient(s):`);
  for (const to of recipients) {
    const tx = await usdc.mint(to, amount);
    await tx.wait();
    console.log(`  ✓ ${to}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
