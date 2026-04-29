import hre from "hardhat";

/**
 * seed-demo-block.ts
 *
 * One-shot helper: admin-seeds an ADDRESS antibody on the deployed Registry
 * that permanently blocks a single demo token. The relayer mirrors it to
 * Sepolia automatically; once mirrored, swaps involving that token on the
 * /dex protected pool will revert with `TokenBlocked`.
 *
 * Reads from env:
 *   REGISTRY_ADDRESS    deployed Registry on Galileo
 *   DEMO_BLOCK_TARGET   Sepolia ERC20 address to permanently block
 *                       (defaults to INT_TOK_B / ETH-T from the integration
 *                       pool — the destination token in the demo narrative)
 *   DEMO_BLOCK_CHAIN_ID chain id of the target address (defaults to Sepolia 11155111)
 *
 * Run once after redeploys:
 *   REGISTRY_ADDRESS=0x...  npx hardhat run scripts/seed-demo-block.ts --network ogGalileo
 */

const ANTIBODY_TYPE = {
    ADDRESS: 0,
} as const;
const VERDICT = {
    MALICIOUS: 0,
} as const;

async function main() {
    const registryAddress = process.env.REGISTRY_ADDRESS;
    if (!registryAddress) {
        throw new Error("REGISTRY_ADDRESS env required");
    }

    const target = (process.env.DEMO_BLOCK_TARGET ?? "0x479504943734d01548B2975227Bb6BfCF725c222").toLowerCase();
    const chainId = Number(process.env.DEMO_BLOCK_CHAIN_ID ?? 11155111);

    const connection = await hre.network.connect();
    const ethers = (connection as { ethers: typeof import("ethers") & { getSigners: () => Promise<unknown[]> } }).ethers;
    const [signer] = await ethers.getSigners();
    const signerAddr = await (signer as { getAddress: () => Promise<string> }).getAddress();
    console.log(`Seeding demo block from ${signerAddr}`);

    const Registry = await ethers.getContractFactory("Registry", signer);
    const registry = Registry.attach(registryAddress);

    // Canonical ADDRESS matcher hash format the SDK uses:
    //   keccak256(abi.encode(uint256 chainId, address target))
    // The Registry stores this opaque bytes32 and indexes by it.
    const matcherHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ["uint256", "address"],
            [BigInt(chainId), target],
        ),
    );

    const ZERO32 = "0x" + "00".repeat(32);
    const targetPadded = ethers.zeroPadValue(target, 32);

    const params = {
        abType: ANTIBODY_TYPE.ADDRESS,
        flavor: 0,
        verdict: VERDICT.MALICIOUS,
        confidence: 100,
        severity: 95,
        primaryMatcherHash: matcherHash,
        evidenceCid: ZERO32,
        contextHash: ZERO32,
        embeddingHash: ZERO32,
        attestation: ZERO32,
        expiresAt: 0,
        reviewer: ethers.ZeroAddress,
        auxiliaryKey: targetPadded,
    };

    console.log(`Target token: ${target} on chain ${chainId}`);
    console.log(`Matcher hash: ${matcherHash}`);

    const tx = await (registry as unknown as {
        seedAntibody: (p: typeof params) => Promise<{ wait: () => Promise<{ hash: string }> }>;
    }).seedAntibody(params);
    console.log(`seedAntibody tx: ${tx.hash ?? "-"}`);
    const receipt = await tx.wait();
    console.log(`Confirmed in block; tx hash ${receipt.hash}`);
    console.log("");
    console.log("The relayer will mirror this antibody to Sepolia within ~30 seconds.");
    console.log("After that, swaps on the protected /dex pool involving this token will revert.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
