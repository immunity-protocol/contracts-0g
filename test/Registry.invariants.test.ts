import { expect } from "chai";
import { setupRegistryFixture } from "./utils.js";

const ZERO_BYTES32 = "0x" + "00".repeat(32);
const PUBLISH_STAKE = 1_000_000n;
const STAKE_LOCK_DURATION = 72n * 60n * 60n;

/// Property-style invariant tests. These exercise random sequences of
/// state-changing calls and assert the contract's accounting and FIFO
/// invariants hold after every step.
describe("Registry — invariants", function () {
  let ethers: any;
  let owner: any, alice: any, bob: any, carol: any;
  let usdc: any;
  let registry: any;

  function makeParams(label: string) {
    return {
      abType: 0, flavor: 0, verdict: 0, confidence: 80, severity: 60,
      primaryMatcherHash: ethers.id(label),
      evidenceCid:        ethers.id("e-" + label),
      contextHash:        ethers.id("c-" + label),
      embeddingHash:      ZERO_BYTES32,
      attestation:        ethers.id("a-" + label),
      expiresAt: 0,
      reviewer: ethers.ZeroAddress,
      auxiliaryKey: ZERO_BYTES32,
    };
  }

  async function fundOperator(operator: any, amount: bigint) {
    await usdc.mint(operator.address, amount);
    await usdc.connect(operator).approve(await registry.getAddress(), amount);
    await registry.connect(operator).deposit(amount);
  }

  // The accounting invariant: every USDC held by the contract is accounted
  // for either as an operator balance, as the treasury, or as a still-locked
  // stake on an ACTIVE antibody in the FIFO queue.
  async function assertAccountingInvariant(operators: any[]) {
    const contractUsdc = await usdc.balanceOf(await registry.getAddress());
    let summed = await registry.treasuryBalance();
    for (const op of operators) {
      summed += await registry.balances(op.address);
    }

    // Walk the active queue and sum stakes that haven't been swept or slashed.
    const head: bigint = await registry.stakeHead();
    const tail: bigint = await registry.stakeTail();
    const peek: string[] = await registry.getOldestExpiredStakes(tail - head);
    for (const id of peek) {
      const ab = await registry.getAntibody(id);
      summed += BigInt(ab.stakeAmount);
    }

    expect(summed).to.equal(contractUsdc);
  }

  beforeEach(async function () {
    const env = await setupRegistryFixture();
    ethers = env.ethers;
    owner = env.owner; alice = env.alice; bob = env.bob; carol = env.carol;
    usdc = env.usdc;
    registry = env.registry;

    await fundOperator(alice, 50_000_000n);
    await fundOperator(bob,   20_000_000n);
    await fundOperator(carol, 10_000_000n);
  });

  it("accounting invariant holds across 60 random operations", async function () {
    const operators = [alice, bob, carol];
    let publishCounter = 0;
    const knownIds: string[] = [];

    // Deterministic-ish PRNG so a flake gives us a reproducible seed to debug.
    let seed = 0xdeadbeef;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];

    for (let step = 0; step < 60; step++) {
      const op = pick(operators);
      const action = rng();

      try {
        if (action < 0.30) {
          // publish
          const label = `p-${publishCounter++}`;
          await registry.connect(op).publish(makeParams(label));
          knownIds.push(await registry.computeKeccakId(0, 0, ethers.id(label), op.address));
        } else if (action < 0.55) {
          // check (50/50 match vs no-match)
          const id = knownIds.length > 0 && rng() < 0.5 ? pick(knownIds) : ZERO_BYTES32;
          await registry.connect(op).check(id);
        } else if (action < 0.65) {
          // withdraw a small amount
          const bal: bigint = await registry.balances(op.address);
          if (bal > 0n) {
            const amt = bal > 100_000n ? 100_000n : bal;
            await registry.connect(op).withdraw(amt);
          }
        } else if (action < 0.75) {
          // deposit
          await fundOperator(op, 500_000n);
        } else if (action < 0.85) {
          // sweep
          await registry.connect(op).sweepExpired();
        } else if (action < 0.92) {
          // advance time so some sweeps actually find expired stakes
          await ethers.provider.send("evm_increaseTime", [Number(STAKE_LOCK_DURATION) / 4]);
          await ethers.provider.send("evm_mine", []);
        } else if (knownIds.length > 0) {
          // owner-slash a random known antibody (and tolerate already-slashed)
          const id = pick(knownIds);
          try { await registry.slash(id); } catch { /* AntibodyNotActive */ }
        }
      } catch (e: any) {
        // Some random calls hit known reverts (e.g. duplicate publish, low
        // balance). That's fine — we only care that the invariant holds.
      }

      await assertAccountingInvariant(operators);
    }
  });

  it("sweep bounty never exceeds treasury balance at sweep time", async function () {
    function findStakeSwept(receipt: any) {
      return receipt.logs
        .map((l: any) => { try { return registry.interface.parseLog(l); } catch { return null; } })
        .find((e: any) => e?.name === "StakeSwept");
    }

    // Phase 1: publish + sweep with empty treasury → bounty must be 0.
    for (let i = 0; i < 5; i++) {
      await registry.connect(alice).publish(makeParams(`s-${i}`));
    }
    await ethers.provider.send("evm_increaseTime", [Number(STAKE_LOCK_DURATION) + 1]);
    await ethers.provider.send("evm_mine", []);

    expect(await registry.treasuryBalance()).to.equal(0n);
    let receipt = await (await registry.connect(bob).sweepExpired()).wait();
    let swept = findStakeSwept(receipt);
    expect(swept.args.bountyPaid).to.equal(0n);

    // Phase 2: queue is empty; seed treasury via no-match checks (sweeps no-op).
    for (let i = 0; i < 10; i++) await registry.connect(bob).check(ZERO_BYTES32);
    const treasuryAfterSeeding = await registry.treasuryBalance();
    expect(treasuryAfterSeeding).to.be.gt(0n);

    // Phase 3: publish a fresh batch, advance time, sweep with a funded treasury.
    for (let i = 5; i < 10; i++) {
      await registry.connect(alice).publish(makeParams(`s-${i}`));
    }
    await ethers.provider.send("evm_increaseTime", [Number(STAKE_LOCK_DURATION) + 1]);
    await ethers.provider.send("evm_mine", []);

    const treasuryBeforeSweep = await registry.treasuryBalance();
    receipt = await (await registry.connect(bob).sweepExpired()).wait();
    swept = findStakeSwept(receipt);

    expect(swept.args.bountyPaid).to.be.gt(0n);
    expect(swept.args.bountyPaid).to.be.lte(treasuryBeforeSweep);
  });

  it("queue stays monotonic in stakeLockUntil across many publishes", async function () {
    // Publish, advance time a bit, publish, advance, ... and assert that each
    // newly enqueued stake has a stakeLockUntil >= the previous one.
    const lockTimes: bigint[] = [];
    for (let i = 0; i < 8; i++) {
      await registry.connect(alice).publish(makeParams(`q-${i}`));
      const id = await registry.computeKeccakId(0, 0, ethers.id(`q-${i}`), alice.address);
      const ab = await registry.getAntibody(id);
      lockTimes.push(BigInt(ab.stakeLockUntil));
      await ethers.provider.send("evm_increaseTime", [60]);
      await ethers.provider.send("evm_mine", []);
    }
    for (let i = 1; i < lockTimes.length; i++) {
      expect(lockTimes[i]).to.be.gte(lockTimes[i - 1]);
    }
  });

  it("settlement always sums to exactly CHECK_FEE on a match", async function () {
    await registry.connect(alice).publish(makeParams("settle"));
    const id = await registry.computeKeccakId(0, 0, ethers.id("settle"), alice.address);

    const tx = await registry.connect(bob).check(id);
    const receipt = await tx.wait();
    const matched = receipt.logs
      .map((l: any) => { try { return registry.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "AntibodyMatched");

    expect(matched.args.publisherReward + matched.args.treasuryReward).to.equal(2_000n);
  });
});
