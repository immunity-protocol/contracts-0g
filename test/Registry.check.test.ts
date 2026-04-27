import { expect } from "chai";
import { setupRegistryFixture } from "./utils.js";

const ZERO_BYTES32 = "0x" + "00".repeat(32);
const CHECK_FEE = 2_000n;
const PUBLISH_STAKE = 1_000_000n;
const PUBLISHER_REWARD = (CHECK_FEE * 8000n) / 10000n;     // 1600
const TREASURY_REWARD  = CHECK_FEE - PUBLISHER_REWARD;     // 400

describe("Registry — check", function () {
  let ethers: any;
  let alice: any;       // publisher
  let bob: any;         // checker
  let carol: any;       // unfunded
  let usdc: any;
  let registry: any;
  let publishedId: string;

  function makeParams(overrides: Partial<any> = {}) {
    return {
      abType: 0, flavor: 0, verdict: 0, confidence: 80, severity: 60,
      primaryMatcherHash: ethers.id("primary"),
      evidenceCid:        ethers.id("evidence"),
      contextHash:        ethers.id("context"),
      embeddingHash:      ZERO_BYTES32,
      attestation:        ethers.id("attestation"),
      expiresAt: 0,
      reviewer: ethers.ZeroAddress,
      auxiliaryKey: ZERO_BYTES32,
      ...overrides,
    };
  }

  async function fundOperator(operator: any, amount: bigint) {
    await usdc.mint(operator.address, amount);
    await usdc.connect(operator).approve(await registry.getAddress(), amount);
    await registry.connect(operator).deposit(amount);
  }

  beforeEach(async function () {
    const env = await setupRegistryFixture();
    ethers  = env.ethers;
    alice   = env.alice;
    bob     = env.bob;
    carol   = env.carol;
    usdc    = env.usdc;
    registry = env.registry;

    await fundOperator(alice, 5_000_000n);  // enough for one publish + checks
    await fundOperator(bob,   1_000_000n);  // enough for many checks

    await registry.connect(alice).publish(makeParams());
    publishedId = await registry.computeKeccakId(0, 0, ethers.id("primary"), alice.address);
  });

  describe("no-match path", function () {
    it("debits the fee and routes 100% to the treasury for bytes32(0)", async function () {
      const treasuryBefore = await registry.treasuryBalance();
      const bobBefore = await registry.balances(bob.address);

      await registry.connect(bob).check(ZERO_BYTES32, ethers.ZeroAddress, 0n, 0n);

      expect(await registry.balances(bob.address)).to.equal(bobBefore - CHECK_FEE);
      expect(await registry.treasuryBalance()).to.equal(treasuryBefore + CHECK_FEE);
    });

    it("emits CheckSettled with wasMatch=false", async function () {
      await expect(registry.connect(bob).check(ZERO_BYTES32, ethers.ZeroAddress, 0n, 0n))
        .to.emit(registry, "CheckSettled")
        .withArgs(bob.address, ZERO_BYTES32, ethers.ZeroAddress, false, CHECK_FEE, 0n, 0n, anyUint());
    });

    it("does not emit AntibodyMatched", async function () {
      await expect(registry.connect(bob).check(ZERO_BYTES32, ethers.ZeroAddress, 0n, 0n))
        .to.not.emit(registry, "AntibodyMatched");
    });

    it("treats unknown antibodyId as no-match (permissive)", async function () {
      const unknown = ethers.id("does-not-exist");
      const treasuryBefore = await registry.treasuryBalance();

      await expect(registry.connect(bob).check(unknown, ethers.ZeroAddress, 0n, 0n))
        .to.emit(registry, "CheckSettled")
        .withArgs(bob.address, unknown, ethers.ZeroAddress, false, CHECK_FEE, 0n, 0n, anyUint());

      expect(await registry.treasuryBalance()).to.equal(treasuryBefore + CHECK_FEE);
    });
  });

  describe("match path", function () {
    it("settles 80% to publisher, 20% to treasury", async function () {
      const aliceBefore = await registry.balances(alice.address);
      const treasuryBefore = await registry.treasuryBalance();

      await registry.connect(bob).check(publishedId, ethers.ZeroAddress, 0n, 0n);

      expect(await registry.balances(alice.address)).to.equal(aliceBefore + PUBLISHER_REWARD);
      expect(await registry.treasuryBalance()).to.equal(treasuryBefore + TREASURY_REWARD);
    });

    it("emits AntibodyMatched with the right amounts", async function () {
      await expect(registry.connect(bob).check(publishedId, ethers.ZeroAddress, 0n, 0n))
        .to.emit(registry, "AntibodyMatched")
        .withArgs(
          publishedId,
          bob.address,
          alice.address,
          ethers.ZeroAddress,            // tokenAddress
          0n,                             // tokenAmount
          0n,                             // originChainId
          PUBLISHER_REWARD,
          TREASURY_REWARD,
          alice.address,                  // reviewer defaults to publisher
        );
    });

    it("emits CheckSettled with wasMatch=true", async function () {
      await expect(registry.connect(bob).check(publishedId, ethers.ZeroAddress, 0n, 0n))
        .to.emit(registry, "CheckSettled")
        .withArgs(bob.address, publishedId, ethers.ZeroAddress, true, CHECK_FEE, 0n, 0n, anyUint());
    });

    it("propagates SDK-supplied tokenAddress, tokenAmount, originChainId on both events", async function () {
      const TOKEN = ethers.getAddress("0x000000000000000000000000000000000000c0de");
      const AMOUNT = 1_500_000_000n; // 1500 USDC
      const ORIGIN = 8453n;          // Base mainnet

      await expect(registry.connect(bob).check(publishedId, TOKEN, AMOUNT, ORIGIN))
        .to.emit(registry, "CheckSettled")
        .withArgs(
          bob.address,
          publishedId,
          TOKEN,
          true,
          CHECK_FEE,
          ORIGIN,
          AMOUNT,
          anyUint(),
        );
    });

    it("propagates the same telemetry trio on AntibodyMatched", async function () {
      const TOKEN = ethers.getAddress("0x111122223333444455556666777788889999aaaa");
      const AMOUNT = 42n;
      const ORIGIN = 1n; // Ethereum

      await expect(registry.connect(bob).check(publishedId, TOKEN, AMOUNT, ORIGIN))
        .to.emit(registry, "AntibodyMatched")
        .withArgs(
          publishedId,
          bob.address,
          alice.address,
          TOKEN,
          AMOUNT,
          ORIGIN,
          PUBLISHER_REWARD,
          TREASURY_REWARD,
          alice.address,
        );
    });

    it("returns true on settle", async function () {
      const result = await registry.connect(bob).check.staticCall(publishedId, ethers.ZeroAddress, 0n, 0n);
      expect(result).to.equal(true);
    });

    it("increments publisher's totalEarned", async function () {
      await registry.connect(bob).check(publishedId, ethers.ZeroAddress, 0n, 0n);
      const stats = await registry.getPublisherStats(alice.address);
      expect(stats.totalEarned).to.equal(PUBLISHER_REWARD);
    });

    it("compounds across many checks", async function () {
      const aliceBefore = await registry.balances(alice.address);
      const treasuryBefore = await registry.treasuryBalance();

      for (let i = 0; i < 10; i++) {
        await registry.connect(bob).check(publishedId, ethers.ZeroAddress, 0n, 0n);
      }

      expect(await registry.balances(alice.address)).to.equal(aliceBefore + PUBLISHER_REWARD * 10n);
      expect(await registry.treasuryBalance()).to.equal(treasuryBefore + TREASURY_REWARD * 10n);
    });

    it("treats expired antibodies as no-match", async function () {
      // Publish a second antibody with an expiresAt 1 second after creation.
      const params = makeParams({
        primaryMatcherHash: ethers.id("expiring"),
        expiresAt: (await ethers.provider.getBlock("latest")).timestamp + 1,
      });
      await registry.connect(alice).publish(params);
      const expId = await registry.computeKeccakId(0, 0, ethers.id("expiring"), alice.address);

      // Advance time past expiry.
      await ethers.provider.send("evm_increaseTime", [10]);
      await ethers.provider.send("evm_mine", []);

      const aliceBefore = await registry.balances(alice.address);
      await registry.connect(bob).check(expId, ethers.ZeroAddress, 0n, 0n);
      // Publisher gets nothing; treasury gets full fee.
      expect(await registry.balances(alice.address)).to.equal(aliceBefore);
    });
  });

  describe("reverts", function () {
    it("InsufficientBalance when caller balance < CHECK_FEE", async function () {
      // carol has no balance
      await expect(registry.connect(carol).check(ZERO_BYTES32, ethers.ZeroAddress, 0n, 0n))
        .to.be.revertedWithCustomError(registry, "InsufficientBalance");
    });
  });

  describe("accounting", function () {
    it("preserves total funds across mixed checks", async function () {
      // After setup: alice = 5M - 1M stake = 4M, bob = 1M, treasury = 0.
      // 1 match check + 1 no-match check from bob.
      await registry.connect(bob).check(publishedId, ethers.ZeroAddress, 0n, 0n);
      await registry.connect(bob).check(ZERO_BYTES32, ethers.ZeroAddress, 0n, 0n);

      const aliceBal   = await registry.balances(alice.address);
      const bobBal     = await registry.balances(bob.address);
      const treasury   = await registry.treasuryBalance();
      const totalUSDC  = await usdc.balanceOf(await registry.getAddress());

      // 1M is locked in the stake queue (alice's published antibody).
      // sum of balances + treasury + locked = total USDC held.
      expect(aliceBal + bobBal + treasury + PUBLISH_STAKE).to.equal(totalUSDC);
    });
  });
});

// Chai matcher helper for unindexed timestamps in events.
function anyUint() {
  return (val: any) => typeof val === "bigint" || typeof val === "number";
}
