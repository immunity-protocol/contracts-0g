import { expect } from "chai";
import { setupRegistryFixture } from "./utils.js";

const ZERO_BYTES32 = "0x" + "00".repeat(32);
const PUBLISH_STAKE = 1_000_000n;
const STAKE_LOCK_DURATION = 72n * 60n * 60n;
const SWEEP_BOUNTY = 100n;
const SWEEP_BATCH_SIZE = 5n;
const CHECK_FEE = 2_000n;

describe("Registry — sweep", function () {
  let ethers: any;
  let alice: any;       // publisher
  let bob: any;         // sweeper
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

  let publishCounter = 0;
  async function publishMany(operator: any, count: number) {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const label = `ab-${operator.address}-${publishCounter++}`;
      await registry.connect(operator).publish(makeParams(label));
      ids.push(await registry.computeKeccakId(0, 0, ethers.id(label), operator.address));
    }
    return ids;
  }

  async function advanceTimeBy(seconds: bigint) {
    await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
    await ethers.provider.send("evm_mine", []);
  }

  beforeEach(async function () {
    const env = await setupRegistryFixture();
    ethers = env.ethers;
    alice = env.alice;
    bob = env.bob;
    usdc = env.usdc;
    registry = env.registry;

    await fundOperator(alice, 20_000_000n); // enough for many publishes
    await fundOperator(bob, 5_000_000n);
  });

  describe("sweepExpired", function () {
    it("returns 0 and emits nothing when queue is empty", async function () {
      const tx = await registry.connect(bob).sweepExpired();
      const receipt = await tx.wait();
      expect(receipt.logs.length).to.equal(0);
      expect(await registry.getActiveStakeCount()).to.equal(0n);
    });

    it("returns 0 when no stakes are yet expired", async function () {
      await publishMany(alice, 3);
      // No time advance.
      const result = await registry.connect(bob).sweepExpired.staticCall();
      expect(result).to.equal(0n);
    });

    it("releases one expired stake to the publisher's balance", async function () {
      const [id] = await publishMany(alice, 1);
      const aliceBefore = await registry.balances(alice.address);
      await advanceTimeBy(STAKE_LOCK_DURATION + 1n);

      const tx = await registry.connect(bob).sweepExpired();
      await expect(tx)
        .to.emit(registry, "StakeReleased")
        .withArgs(id, alice.address, PUBLISH_STAKE, anyUint());
      await expect(tx).to.emit(registry, "StakeSwept");

      expect(await registry.balances(alice.address)).to.equal(aliceBefore + PUBLISH_STAKE);
      expect(await registry.stakeHead()).to.equal(1n);
      expect(await registry.getActiveStakeCount()).to.equal(0n);
    });

    it("respects SWEEP_BATCH_SIZE (releases at most 5 per call)", async function () {
      await publishMany(alice, 7);
      await advanceTimeBy(STAKE_LOCK_DURATION + 1n);

      const released = await registry.connect(bob).sweepExpired.staticCall();
      expect(released).to.equal(SWEEP_BATCH_SIZE);

      await registry.connect(bob).sweepExpired();
      expect(await registry.stakeHead()).to.equal(SWEEP_BATCH_SIZE);
      expect(await registry.getActiveStakeCount()).to.equal(2n);

      // Second sweep clears the rest.
      const released2 = await registry.connect(bob).sweepExpired.staticCall();
      expect(released2).to.equal(2n);
    });

    it("releases stakes in FIFO order", async function () {
      const ids = await publishMany(alice, 3);
      await advanceTimeBy(STAKE_LOCK_DURATION + 1n);

      const tx = await registry.connect(bob).sweepExpired();
      const receipt = await tx.wait();

      const releaseEvents = receipt.logs
        .map((l: any) => { try { return registry.interface.parseLog(l); } catch { return null; } })
        .filter((e: any) => e && e.name === "StakeReleased");

      expect(releaseEvents.length).to.equal(3);
      expect(releaseEvents[0].args.keccakId).to.equal(ids[0]);
      expect(releaseEvents[1].args.keccakId).to.equal(ids[1]);
      expect(releaseEvents[2].args.keccakId).to.equal(ids[2]);
    });

    it("stops at the first not-yet-expired stake (FIFO monotonic)", async function () {
      await publishMany(alice, 2);          // both locked from t=0
      await advanceTimeBy(STAKE_LOCK_DURATION + 1n);
      await publishMany(alice, 2);          // locked much later

      const released = await registry.connect(bob).sweepExpired.staticCall();
      expect(released).to.equal(2n);

      await registry.connect(bob).sweepExpired();
      // Two newer stakes are not yet expired — sweep stopped at them.
      expect(await registry.stakeHead()).to.equal(2n);
      expect(await registry.getActiveStakeCount()).to.equal(2n);
    });

    it("pays the sweeper a bounty per released stake from treasury", async function () {
      // Seed treasury via a no-match check.
      await registry.connect(bob).check(ZERO_BYTES32, ethers.ZeroAddress, 0n, 0n);
      const treasuryBefore = await registry.treasuryBalance();
      const bobBefore = await registry.balances(bob.address);

      await publishMany(alice, 3);
      await advanceTimeBy(STAKE_LOCK_DURATION + 1n);

      await registry.connect(bob).sweepExpired();

      const expectedBounty = SWEEP_BOUNTY * 3n;
      expect(await registry.balances(bob.address)).to.equal(bobBefore + expectedBounty);
      expect(await registry.treasuryBalance()).to.equal(treasuryBefore - expectedBounty);
    });

    it("caps bounty at treasury balance", async function () {
      // Treasury is empty.
      expect(await registry.treasuryBalance()).to.equal(0n);
      const bobBefore = await registry.balances(bob.address);

      await publishMany(alice, 2);
      await advanceTimeBy(STAKE_LOCK_DURATION + 1n);

      const tx = await registry.connect(bob).sweepExpired();
      await expect(tx)
        .to.emit(registry, "StakeSwept")
        .withArgs(bob.address, 2n, 0n);  // no bounty paid

      expect(await registry.balances(bob.address)).to.equal(bobBefore); // unchanged
      // Stakes are still released even with no bounty.
      expect(await registry.stakeHead()).to.equal(2n);
    });

    it("emits StakeSwept once with the correct totals", async function () {
      await registry.connect(bob).check(ZERO_BYTES32, ethers.ZeroAddress, 0n, 0n);   // seeds treasury > 100 * 4
      await publishMany(alice, 4);
      await advanceTimeBy(STAKE_LOCK_DURATION + 1n);

      await expect(registry.connect(bob).sweepExpired())
        .to.emit(registry, "StakeSwept")
        .withArgs(bob.address, 4n, SWEEP_BOUNTY * 4n);
    });
  });

  describe("sweep wired into check()", function () {
    it("releases expired stakes opportunistically during a check", async function () {
      await publishMany(alice, 2);
      await advanceTimeBy(STAKE_LOCK_DURATION + 1n);
      const aliceBefore = await registry.balances(alice.address);

      const tx = await registry.connect(bob).check(ZERO_BYTES32, ethers.ZeroAddress, 0n, 0n);
      await expect(tx).to.emit(registry, "StakeSwept");

      // Both stakes released to alice, plus alice gets nothing else (bob's check was no-match).
      expect(await registry.balances(alice.address)).to.equal(aliceBefore + PUBLISH_STAKE * 2n);
      expect(await registry.stakeHead()).to.equal(2n);
    });

    it("does not emit StakeSwept on check() when nothing is releasable", async function () {
      await publishMany(alice, 1);  // not yet expired
      await expect(registry.connect(bob).check(ZERO_BYTES32, ethers.ZeroAddress, 0n, 0n))
        .to.not.emit(registry, "StakeSwept");
    });
  });

  describe("getOldestExpiredStakes view", function () {
    it("returns up to `limit` ids from the head of the queue", async function () {
      const ids = await publishMany(alice, 4);
      const peek = await registry.getOldestExpiredStakes(3);
      expect(peek.length).to.equal(3);
      expect(peek[0]).to.equal(ids[0]);
      expect(peek[1]).to.equal(ids[1]);
      expect(peek[2]).to.equal(ids[2]);
    });

    it("clamps when limit > active count", async function () {
      await publishMany(alice, 2);
      const peek = await registry.getOldestExpiredStakes(10);
      expect(peek.length).to.equal(2);
    });
  });
});

function anyUint() {
  return (val: any) => typeof val === "bigint" || typeof val === "number";
}
