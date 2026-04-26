import { expect } from "chai";
import { setupRegistryFixture } from "./utils.js";

const ZERO_BYTES32 = "0x" + "00".repeat(32);

describe("Registry — view functions", function () {
  let ethers: any;
  let owner: any;
  let alice: any;
  let bob: any;
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
  });

  describe("getAntibody", function () {
    it("returns an empty struct for unknown ids", async function () {
      const ab = await registry.getAntibody(ethers.id("unknown"));
      expect(ab.publisher).to.equal(ethers.ZeroAddress);
      expect(ab.stakeAmount).to.equal(0n);
      expect(ab.createdAt).to.equal(0n);
    });
  });

  describe("getAntibodyByImmSeq", function () {
    it("resolves the antibody by its sequence number", async function () {
      await registry.connect(alice).publish(makeParams("first"));
      await registry.connect(alice).publish(makeParams("second"));

      const ab1 = await registry.getAntibodyByImmSeq(1);
      const ab2 = await registry.getAntibodyByImmSeq(2);

      expect(ab1.primaryMatcherHash).to.equal(ethers.id("first"));
      expect(ab2.primaryMatcherHash).to.equal(ethers.id("second"));
    });

    it("returns empty for an unused sequence", async function () {
      const ab = await registry.getAntibodyByImmSeq(99);
      expect(ab.publisher).to.equal(ethers.ZeroAddress);
    });
  });

  describe("getPublisherStats", function () {
    it("returns zero stats for an unknown publisher", async function () {
      const stats = await registry.getPublisherStats(bob.address);
      expect(stats.totalStaked).to.equal(0n);
      expect(stats.totalEarned).to.equal(0n);
      expect(stats.publishedCount).to.equal(0n);
      expect(stats.slashedCount).to.equal(0n);
    });

    it("aggregates publishedCount across many publishes", async function () {
      await registry.connect(alice).publish(makeParams("p1"));
      await registry.connect(alice).publish(makeParams("p2"));
      await registry.connect(alice).publish(makeParams("p3"));

      const stats = await registry.getPublisherStats(alice.address);
      expect(stats.publishedCount).to.equal(3n);
      expect(stats.totalStaked).to.equal(3_000_000n); // 3 * 1 USDC
    });
  });

  describe("getActiveStakeCount", function () {
    it("starts at zero", async function () {
      expect(await registry.getActiveStakeCount()).to.equal(0n);
    });

    it("matches stakeTail - stakeHead", async function () {
      await registry.connect(alice).publish(makeParams("a"));
      await registry.connect(alice).publish(makeParams("b"));

      const tail = await registry.stakeTail();
      const head = await registry.stakeHead();
      expect(await registry.getActiveStakeCount()).to.equal(tail - head);
    });
  });

  describe("computeKeccakId", function () {
    it("is pure (no state read) and matches the contract's internal hash", async function () {
      const params = makeParams("hashable");
      const expected = await registry.computeKeccakId(
        params.abType,
        params.flavor,
        params.primaryMatcherHash,
        alice.address,
      );

      // Reproduce off-chain to confirm the canonicalization.
      const offchain = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint8", "uint8", "bytes32", "address"],
          [params.abType, params.flavor, params.primaryMatcherHash, alice.address],
        ),
      );
      expect(expected).to.equal(offchain);
    });

    it("produces distinct ids for different publishers", async function () {
      const a = await registry.computeKeccakId(0, 0, ethers.id("m"), alice.address);
      const b = await registry.computeKeccakId(0, 0, ethers.id("m"), bob.address);
      expect(a).to.not.equal(b);
    });

    it("produces distinct ids for different abTypes", async function () {
      const a = await registry.computeKeccakId(0, 0, ethers.id("m"), alice.address);
      const b = await registry.computeKeccakId(1, 0, ethers.id("m"), alice.address);
      expect(a).to.not.equal(b);
    });

    it("matches the keccakId used during publish", async function () {
      await registry.connect(alice).publish(makeParams("predict"));
      const predicted = await registry.computeKeccakId(0, 0, ethers.id("predict"), alice.address);
      const ab = await registry.getAntibody(predicted);
      expect(ab.publisher).to.equal(alice.address);
    });
  });
});
