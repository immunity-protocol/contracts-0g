import hre from "hardhat";

const REGISTRY = "0x6FfB52ea1a01ABDe2793f6fca2Ea6661ca75903c";
const USDC     = "0x53d4Df2832A97Ec455D1d0ACe9242baE78f19eC9";

async function main() {
  const connection = await hre.network.connect();
  const ethers = (connection as any).ethers;
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  console.log("wallet:", me);

  const reg = await ethers.getContractAt("Registry", REGISTRY, signer);
  const usdc = await ethers.getContractAt("MockUSDC", USDC, signer);

  console.log("minting 10 USDC...");
  await (await usdc.mint(me, 10_000_000n)).wait();
  console.log("approving Registry...");
  await (await usdc.approve(REGISTRY, 10_000_000n)).wait();
  console.log("depositing 5 USDC...");
  await (await reg.deposit(5_000_000n)).wait();
  console.log("balance in registry:", (await reg.balances(me)).toString());

  const bad = "0x000000000000000000000000000000000000bAd1";
  const matcherHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address"], [bad])
  );
  const params = {
    abType: 0,
    flavor: 0,
    verdict: 0,
    confidence: 95,
    severity: 80,
    primaryMatcherHash: matcherHash,
    evidenceCid: ethers.id("smoke-evidence"),
    contextHash: ethers.id("smoke-context"),
    embeddingHash: "0x" + "00".repeat(32),
    attestation: ethers.id("smoke-attestation"),
    expiresAt: 0,
    reviewer: ethers.ZeroAddress,
    auxiliaryKey: ethers.zeroPadValue(bad, 32),
  };
  console.log("seeding antibody...");
  const seedRcpt = await (await reg.seedAntibody(params)).wait();
  const id = await reg.computeKeccakId(0, 0, matcherHash, me);
  console.log("seeded id:", id, "tx:", seedRcpt.hash);

  const usdcMainnet = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const tokenAmt = 1_500_000_000n;
  const chainId = 1n;

  console.log(`calling check(id, ${usdcMainnet}, ${tokenAmt}, ${chainId})...`);
  const checkRcpt = await (await reg.check(id, usdcMainnet, tokenAmt, chainId)).wait();
  console.log("check tx:", checkRcpt.hash);

  for (const log of checkRcpt.logs) {
    try {
      const p = reg.interface.parseLog({ topics: log.topics, data: log.data });
      if (p) {
        console.log(" event:", p.name, JSON.stringify(p.args, (_: any, v: any) =>
          typeof v === "bigint" ? v.toString() : v
        ));
      }
    } catch {}
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
