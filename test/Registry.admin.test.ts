import { expect } from "chai";
import { setupRegistryFixture } from "./utils.js";

const ZERO_BYTES32 = "0x" + "00".repeat(32);
const PUBLISH_STAKE = 1_000_000n;
const STAKE_LOCK_DURATION = 72n * 60n * 60n;
const STATUS = { ACTIVE: 0, CHALLENGED: 1, SLASHED: 2, EXPIRED: 3 } as const;
const CHECK_FEE = 2_000n;
const PUBLISHER_REWARD = (CHECK_FEE * 8000n) / 10000n;
const TREASURY_REWARD = CHECK_FEE - PUBLISHER_REWARD;

describe("Registry — admin (slash, seedAntibody, withdrawTreasury)", function () {
  let ethers: any;
  let owner: any;
  let alice: any;       // publisher
  let bob: any;         // checker / non-admin caller
  let usdc: any;
  let registry: any;

  function makeParams(label: string, overrides: Partial<any> = {}) {
    return {
      abType: 0, flavor: 0, verdict: 0, confidence: 80, severity: 60,
      primaryMatcherHash: ethers.id(label),
      evidenceCid:        ethers.id("evidence-" + label),
      contextHash:        ethers.id("context-" + label),
      embeddingHash:      ZERO_BYTES32,
      attestation:        ethers.id("attestation-" + label),
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
    ethers = env.ethers;
    owner  = env.owner;
    alice  = env.alice;
    bob    = env.bob;
    usdc   = env.usdc;
    registry = env.registry;

    await fundOperator(alice, 5_000_000n);
    await fundOperator(bob, 1_000_000n);
  });

  describe("slash", function () {
    let id: string;

    beforeEach(async function () {
      await registry.connect(alice).publish(makeParams("a"));
      id = await registry.computeKeccakId(0, 0, ethers.id("a"), alice.address);
    });

    it("rejects non-owner callers", async function () {
      await expect(registry.connect(bob).slash(id))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("reverts AntibodyNotFound on unknown id", async function () {
      await expect(registry.slash(ethers.id("nope")))
        .to.be.revertedWithCustomError(registry, "AntibodyNotFound");
    });

    it("transitions ACTIVE → SLASHED, zeros stakeAmount, moves stake to treasury", async function () {
      const treasuryBefore = await registry.treasuryBalance();

      await expect(registry.slash(id))
        .to.emit(registry, "AntibodySlashed")
        .withArgs(id, alice.address, PUBLISH_STAKE);

      const ab = await registry.getAntibody(id);
      expect(ab.status).to.equal(STATUS.SLASHED);
      expect(ab.stakeAmount).to.equal(0n);
      expect(await registry.treasuryBalance()).to.equal(treasuryBefore + PUBLISH_STAKE);
    });

    it("increments publisher's slashedCount", async function () {
      await registry.slash(id);
      const stats = await registry.getPublisherStats(alice.address);
      expect(stats.slashedCount).to.equal(1n);
    });

    it("reverts AntibodyNotActive on double-slash", async function () {
      await registry.slash(id);
      await expect(registry.slash(id))
        .to.be.revertedWithCustomError(registry, "AntibodyNotActive");
    });

    it("a slashed antibody no longer matches in check()", async function () {
      await registry.slash(id);
      const aliceBefore = await registry.balances(alice.address);

      await registry.connect(bob).check(id, ethers.ZeroAddress, 0n, 0n);
      // No publisher reward — entire fee goes to treasury.
      expect(await registry.balances(alice.address)).to.equal(aliceBefore);
    });

    it("sweep skips a slashed entry (advances head without refund)", async function () {
      await registry.slash(id);
      const aliceBefore = await registry.balances(alice.address);
      await ethers.provider.send("evm_increaseTime", [Number(STAKE_LOCK_DURATION) + 1]);
      await ethers.provider.send("evm_mine", []);

      await registry.connect(bob).sweepExpired();

      // Head advanced past the slashed entry, but no StakeReleased and balance unchanged.
      expect(await registry.stakeHead()).to.equal(1n);
      expect(await registry.balances(alice.address)).to.equal(aliceBefore);
    });
  });

  describe("seedAntibody", function () {
    it("rejects non-owner callers", async function () {
      await expect(registry.connect(bob).seedAntibody(makeParams("seed-1")))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("publishes without debiting any stake", async function () {
      const ownerBalBefore = await registry.balances(owner.address);
      await registry.seedAntibody(makeParams("seed-1"));
      expect(await registry.balances(owner.address)).to.equal(ownerBalBefore);
    });

    it("marks the antibody isSeeded=1 with stakeAmount=0 and stakeLockUntil=0", async function () {
      await registry.seedAntibody(makeParams("seed-2"));
      const id = await registry.computeKeccakId(0, 0, ethers.id("seed-2"), owner.address);
      const ab = await registry.getAntibody(id);
      expect(ab.isSeeded).to.equal(1);
      expect(ab.stakeAmount).to.equal(0n);
      expect(ab.stakeLockUntil).to.equal(0n);
      expect(ab.publisher).to.equal(owner.address);
      expect(ab.status).to.equal(STATUS.ACTIVE);
    });

    it("does not enqueue for sweep", async function () {
      const tailBefore = await registry.stakeTail();
      await registry.seedAntibody(makeParams("seed-3"));
      expect(await registry.stakeTail()).to.equal(tailBefore);
    });

    it("emits both AntibodyPublished and Seeded", async function () {
      const tx = await registry.seedAntibody(makeParams("seed-4"));
      await expect(tx).to.emit(registry, "AntibodyPublished");
      await expect(tx).to.emit(registry, "Seeded");
    });

    it("a seeded antibody is matchable in check() (still pays publisher)", async function () {
      await registry.seedAntibody(makeParams("seed-5"));
      const id = await registry.computeKeccakId(0, 0, ethers.id("seed-5"), owner.address);
      const ownerBefore = await registry.balances(owner.address);

      await registry.connect(bob).check(id, ethers.ZeroAddress, 0n, 0n);

      expect(await registry.balances(owner.address)).to.equal(ownerBefore + PUBLISHER_REWARD);
    });
  });

  describe("withdrawTreasury", function () {
    beforeEach(async function () {
      // Seed treasury via three no-match checks → 3 * 2_000 = 6_000.
      await registry.connect(bob).check(ZERO_BYTES32, ethers.ZeroAddress, 0n, 0n);
      await registry.connect(bob).check(ZERO_BYTES32, ethers.ZeroAddress, 0n, 0n);
      await registry.connect(bob).check(ZERO_BYTES32, ethers.ZeroAddress, 0n, 0n);
    });

    it("rejects non-owner callers", async function () {
      await expect(registry.connect(bob).withdrawTreasury(1n, bob.address))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("reverts on zero address", async function () {
      await expect(registry.withdrawTreasury(1n, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("reverts on zero amount", async function () {
      await expect(registry.withdrawTreasury(0n, owner.address))
        .to.be.revertedWithCustomError(registry, "ZeroAmount");
    });

    it("reverts when amount > treasury balance", async function () {
      const tooMuch = (await registry.treasuryBalance()) + 1n;
      await expect(registry.withdrawTreasury(tooMuch, owner.address))
        .to.be.revertedWithCustomError(registry, "InsufficientBalance");
    });

    it("debits treasury, transfers USDC, emits event", async function () {
      const treasuryBefore = await registry.treasuryBalance();
      const ownerUsdcBefore = await usdc.balanceOf(owner.address);
      const amount = 4_000n;

      await expect(registry.withdrawTreasury(amount, owner.address))
        .to.emit(registry, "TreasuryWithdrawn")
        .withArgs(owner.address, amount);

      expect(await registry.treasuryBalance()).to.equal(treasuryBefore - amount);
      expect(await usdc.balanceOf(owner.address)).to.equal(ownerUsdcBefore + amount);
    });
  });
});
