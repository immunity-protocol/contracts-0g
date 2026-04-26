import { expect } from "chai";
import { setupRegistryFixture } from "./utils.js";

const ZERO_BYTES32 = "0x" + "00".repeat(32);

const ABTYPE = {
  ADDRESS: 0,
  CALL_PATTERN: 1,
  BYTECODE: 2,
  GRAPH: 3,
  SEMANTIC: 4,
} as const;

const VERDICT = { MALICIOUS: 0, SUSPICIOUS: 1 } as const;
const STATUS = { ACTIVE: 0, CHALLENGED: 1, SLASHED: 2, EXPIRED: 3 } as const;

const PUBLISH_STAKE = 1_000_000n;
const STAKE_LOCK_DURATION = 72n * 60n * 60n;

describe("Registry — publish", function () {
  let ethers: any;
  let alice: any;
  let bob: any;
  let usdc: any;
  let registry: any;

  function makeParams(overrides: Partial<any> = {}) {
    return {
      abType: ABTYPE.ADDRESS,
      flavor: 0,
      verdict: VERDICT.MALICIOUS,
      confidence: 80,
      severity: 60,
      primaryMatcherHash: ethers.id("primary"),
      evidenceCid: ethers.id("evidence"),
      contextHash: ethers.id("context"),
      embeddingHash: ZERO_BYTES32,
      attestation: ethers.id("attestation"),
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
    alice = env.alice;
    bob = env.bob;
    usdc = env.usdc;
    registry = env.registry;
    await fundOperator(alice, 10_000_000n);
  });

  describe("happy path", function () {
    it("debits the stake from the publisher's balance", async function () {
      const before = await registry.balances(alice.address);
      await registry.connect(alice).publish(makeParams());
      const after = await registry.balances(alice.address);
      expect(before - after).to.equal(PUBLISH_STAKE);
    });

    it("stores the antibody envelope as ACTIVE with the right fields", async function () {
      const params = makeParams({ confidence: 95, severity: 75, expiresAt: 9_999_999_999 });
      const tx = await registry.connect(alice).publish(params);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      const keccakId = await registry.computeKeccakId(
        params.abType,
        params.flavor,
        params.primaryMatcherHash,
        alice.address,
      );

      const ab = await registry.getAntibody(keccakId);
      expect(ab.publisher).to.equal(alice.address);
      expect(ab.reviewer).to.equal(alice.address); // defaults to publisher
      expect(ab.abType).to.equal(params.abType);
      expect(ab.verdict).to.equal(params.verdict);
      expect(ab.confidence).to.equal(95);
      expect(ab.severity).to.equal(75);
      expect(ab.status).to.equal(STATUS.ACTIVE);
      expect(ab.isSeeded).to.equal(0);
      expect(ab.stakeAmount).to.equal(PUBLISH_STAKE);
      expect(ab.createdAt).to.equal(BigInt(block!.timestamp));
      expect(ab.stakeLockUntil).to.equal(BigInt(block!.timestamp) + STAKE_LOCK_DURATION);
      expect(ab.expiresAt).to.equal(BigInt(params.expiresAt));
      expect(ab.primaryMatcherHash).to.equal(params.primaryMatcherHash);
      expect(ab.evidenceCid).to.equal(params.evidenceCid);
      expect(ab.contextHash).to.equal(params.contextHash);
      expect(ab.attestation).to.equal(params.attestation);
    });

    it("uses the explicit reviewer when provided", async function () {
      const params = makeParams({ reviewer: bob.address });
      await registry.connect(alice).publish(params);
      const id = await registry.computeKeccakId(
        params.abType, params.flavor, params.primaryMatcherHash, alice.address,
      );
      const ab = await registry.getAntibody(id);
      expect(ab.reviewer).to.equal(bob.address);
    });

    it("assigns sequential immSeq starting at 1", async function () {
      await registry.connect(alice).publish(makeParams({ primaryMatcherHash: ethers.id("a") }));
      await registry.connect(alice).publish(makeParams({ primaryMatcherHash: ethers.id("b") }));
      await registry.connect(alice).publish(makeParams({ primaryMatcherHash: ethers.id("c") }));

      const idA = await registry.computeKeccakId(0, 0, ethers.id("a"), alice.address);
      const idB = await registry.computeKeccakId(0, 0, ethers.id("b"), alice.address);
      const idC = await registry.computeKeccakId(0, 0, ethers.id("c"), alice.address);

      expect((await registry.getAntibody(idA)).immSeq).to.equal(1);
      expect((await registry.getAntibody(idB)).immSeq).to.equal(2);
      expect((await registry.getAntibody(idC)).immSeq).to.equal(3);

      expect(await registry.immSeqToKeccakId(1)).to.equal(idA);
      expect(await registry.immSeqToKeccakId(2)).to.equal(idB);
      expect(await registry.immSeqToKeccakId(3)).to.equal(idC);
    });

    it("emits AntibodyPublished with the full envelope", async function () {
      const params = makeParams();
      await expect(registry.connect(alice).publish(params))
        .to.emit(registry, "AntibodyPublished");
      // Field-by-field assertion via withArgs is brittle for large tuples;
      // exhaustive field checks live in "stores the antibody envelope".
    });

    it("returns (keccakId, immSeq)", async function () {
      const params = makeParams();
      const expectedId = await registry.computeKeccakId(
        params.abType, params.flavor, params.primaryMatcherHash, alice.address,
      );
      const result = await registry.connect(alice).publish.staticCall(params);
      expect(result[0]).to.equal(expectedId);
      expect(result[1]).to.equal(1n);
    });

    it("enqueues the stake (tail++, head unchanged)", async function () {
      expect(await registry.stakeHead()).to.equal(0n);
      expect(await registry.stakeTail()).to.equal(0n);

      await registry.connect(alice).publish(makeParams());

      expect(await registry.stakeHead()).to.equal(0n);
      expect(await registry.stakeTail()).to.equal(1n);
      expect(await registry.getActiveStakeCount()).to.equal(1n);
    });

    it("updates publisher stats", async function () {
      await registry.connect(alice).publish(makeParams());
      const stats = await registry.getPublisherStats(alice.address);
      expect(stats.totalStaked).to.equal(PUBLISH_STAKE);
      expect(stats.totalEarned).to.equal(0n);
      expect(stats.publishedCount).to.equal(1n);
      expect(stats.slashedCount).to.equal(0n);
    });

    it("allows different publishers to publish the same matcher (ensemble)", async function () {
      await fundOperator(bob, 5_000_000n);
      const params = makeParams();

      await expect(registry.connect(alice).publish(params)).to.not.be.revert(ethers);
      await expect(registry.connect(bob).publish(params)).to.not.be.revert(ethers);

      // Both produce distinct keccakIds (publisher is part of the canonical input).
      const idA = await registry.computeKeccakId(0, 0, params.primaryMatcherHash, alice.address);
      const idB = await registry.computeKeccakId(0, 0, params.primaryMatcherHash, bob.address);
      expect(idA).to.not.equal(idB);
    });
  });

  describe("reverts", function () {
    it("InsufficientBalance when publisher balance < stake", async function () {
      await expect(registry.connect(bob).publish(makeParams()))
        .to.be.revertedWithCustomError(registry, "InsufficientBalance");
    });

    it("AntibodyExists on duplicate (same publisher + type + flavor + matcher)", async function () {
      const params = makeParams();
      await registry.connect(alice).publish(params);
      await expect(registry.connect(alice).publish(params))
        .to.be.revertedWithCustomError(registry, "AntibodyExists");
    });

    it("InvalidAntibodyType when abType > SEMANTIC (4)", async function () {
      await expect(registry.connect(alice).publish(makeParams({ abType: 5 })))
        .to.be.revertedWithCustomError(registry, "InvalidAntibodyType");
    });

    it("InvalidVerdict when verdict > SUSPICIOUS (1)", async function () {
      await expect(registry.connect(alice).publish(makeParams({ verdict: 2 })))
        .to.be.revertedWithCustomError(registry, "InvalidVerdict");
    });

    it("InvalidConfidence when confidence > 100", async function () {
      await expect(registry.connect(alice).publish(makeParams({ confidence: 101 })))
        .to.be.revertedWithCustomError(registry, "InvalidConfidence");
    });

    it("InvalidSeverity when severity > 100", async function () {
      await expect(registry.connect(alice).publish(makeParams({ severity: 101 })))
        .to.be.revertedWithCustomError(registry, "InvalidSeverity");
    });
  });

  describe("auxiliary events per type", function () {
    it("emits AddressBlocked for ADDRESS type", async function () {
      const target = "0x000000000000000000000000000000000000dEaD";
      const auxiliaryKey = ethers.zeroPadValue(target, 32);
      const params = makeParams({ abType: ABTYPE.ADDRESS, auxiliaryKey });

      const expectedId = await registry.computeKeccakId(
        ABTYPE.ADDRESS, 0, params.primaryMatcherHash, alice.address,
      );

      await expect(registry.connect(alice).publish(params))
        .to.emit(registry, "AddressBlocked")
        .withArgs(target, expectedId, alice.address);
    });

    it("emits CallPatternBlocked for CALL_PATTERN type", async function () {
      const selector = "0x12345678";
      // bytes4 left-aligned in bytes32
      const auxiliaryKey = selector + "00".repeat(28);
      const params = makeParams({ abType: ABTYPE.CALL_PATTERN, auxiliaryKey });

      const expectedId = await registry.computeKeccakId(
        ABTYPE.CALL_PATTERN, 0, params.primaryMatcherHash, alice.address,
      );

      await expect(registry.connect(alice).publish(params))
        .to.emit(registry, "CallPatternBlocked")
        .withArgs(selector, expectedId, alice.address);
    });

    it("emits BytecodeBlocked for BYTECODE type", async function () {
      const bytecodeHash = ethers.id("malicious-bytecode");
      const params = makeParams({ abType: ABTYPE.BYTECODE, auxiliaryKey: bytecodeHash });

      const expectedId = await registry.computeKeccakId(
        ABTYPE.BYTECODE, 0, params.primaryMatcherHash, alice.address,
      );

      await expect(registry.connect(alice).publish(params))
        .to.emit(registry, "BytecodeBlocked")
        .withArgs(bytecodeHash, expectedId, alice.address);
    });

    it("emits GraphTaintAdded for GRAPH type", async function () {
      const taintSetId = ethers.id("taint-cluster-42");
      const params = makeParams({ abType: ABTYPE.GRAPH, auxiliaryKey: taintSetId });

      const expectedId = await registry.computeKeccakId(
        ABTYPE.GRAPH, 0, params.primaryMatcherHash, alice.address,
      );

      await expect(registry.connect(alice).publish(params))
        .to.emit(registry, "GraphTaintAdded")
        .withArgs(taintSetId, expectedId, alice.address);
    });

    it("emits SemanticPatternAdded for SEMANTIC type with flavor as indexed key", async function () {
      const params = makeParams({ abType: ABTYPE.SEMANTIC, flavor: 2 });

      const expectedId = await registry.computeKeccakId(
        ABTYPE.SEMANTIC, 2, params.primaryMatcherHash, alice.address,
      );

      await expect(registry.connect(alice).publish(params))
        .to.emit(registry, "SemanticPatternAdded")
        .withArgs(2, expectedId, alice.address);
    });
  });
});
