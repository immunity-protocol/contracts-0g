import { expect } from "chai";
import { setupRegistryFixture } from "./utils.js";

describe("Registry — deposit / withdraw", function () {
  let ethers: any;
  let alice: any;
  let bob: any;
  let usdc: any;
  let registry: any;

  beforeEach(async function () {
    const env = await setupRegistryFixture();
    ethers = env.ethers;
    alice = env.alice;
    bob = env.bob;
    usdc = env.usdc;
    registry = env.registry;
  });

  describe("deposit", function () {
    it("pulls USDC and credits the operator balance", async function () {
      const amount = 5_000_000n; // 5 USDC
      await usdc.mint(alice.address, amount);
      await usdc.connect(alice).approve(await registry.getAddress(), amount);

      await expect(registry.connect(alice).deposit(amount))
        .to.emit(registry, "Deposited")
        .withArgs(alice.address, amount);

      expect(await registry.balances(alice.address)).to.equal(amount);
      expect(await usdc.balanceOf(await registry.getAddress())).to.equal(amount);
      expect(await usdc.balanceOf(alice.address)).to.equal(0n);
    });

    it("accumulates across multiple deposits", async function () {
      await usdc.mint(alice.address, 10_000_000n);
      await usdc.connect(alice).approve(await registry.getAddress(), 10_000_000n);

      await registry.connect(alice).deposit(3_000_000n);
      await registry.connect(alice).deposit(2_000_000n);

      expect(await registry.balances(alice.address)).to.equal(5_000_000n);
    });

    it("isolates balances between operators", async function () {
      await usdc.mint(alice.address, 4_000_000n);
      await usdc.mint(bob.address, 1_000_000n);
      await usdc.connect(alice).approve(await registry.getAddress(), 4_000_000n);
      await usdc.connect(bob).approve(await registry.getAddress(), 1_000_000n);

      await registry.connect(alice).deposit(4_000_000n);
      await registry.connect(bob).deposit(1_000_000n);

      expect(await registry.balances(alice.address)).to.equal(4_000_000n);
      expect(await registry.balances(bob.address)).to.equal(1_000_000n);
    });

    it("reverts on zero amount", async function () {
      await expect(registry.connect(alice).deposit(0n))
        .to.be.revertedWithCustomError(registry, "ZeroAmount");
    });

    it("reverts when allowance is missing", async function () {
      await usdc.mint(alice.address, 1_000_000n);
      // no approve
      await expect(registry.connect(alice).deposit(1_000_000n)).to.be.revert(ethers);
    });

    it("reverts when caller has insufficient USDC", async function () {
      await usdc.connect(alice).approve(await registry.getAddress(), 1_000_000n);
      await expect(registry.connect(alice).deposit(1_000_000n)).to.be.revert(ethers);
    });
  });

  describe("withdraw", function () {
    beforeEach(async function () {
      await usdc.mint(alice.address, 10_000_000n);
      await usdc.connect(alice).approve(await registry.getAddress(), 10_000_000n);
      await registry.connect(alice).deposit(10_000_000n);
    });

    it("debits the balance and transfers USDC back", async function () {
      const amount = 4_000_000n;

      await expect(registry.connect(alice).withdraw(amount))
        .to.emit(registry, "Withdrew")
        .withArgs(alice.address, amount);

      expect(await registry.balances(alice.address)).to.equal(6_000_000n);
      expect(await usdc.balanceOf(alice.address)).to.equal(amount);
    });

    it("supports full withdrawal", async function () {
      await registry.connect(alice).withdraw(10_000_000n);
      expect(await registry.balances(alice.address)).to.equal(0n);
      expect(await usdc.balanceOf(alice.address)).to.equal(10_000_000n);
    });

    it("reverts on zero amount", async function () {
      await expect(registry.connect(alice).withdraw(0n))
        .to.be.revertedWithCustomError(registry, "ZeroAmount");
    });

    it("reverts when balance is too low", async function () {
      await expect(registry.connect(alice).withdraw(10_000_001n))
        .to.be.revertedWithCustomError(registry, "InsufficientBalance");
    });

    it("reverts when caller has no balance", async function () {
      await expect(registry.connect(bob).withdraw(1n))
        .to.be.revertedWithCustomError(registry, "InsufficientBalance");
    });
  });

  describe("round-trip accounting", function () {
    it("preserves total USDC across many operations", async function () {
      await usdc.mint(alice.address, 8_000_000n);
      await usdc.mint(bob.address, 5_000_000n);
      await usdc.connect(alice).approve(await registry.getAddress(), 8_000_000n);
      await usdc.connect(bob).approve(await registry.getAddress(), 5_000_000n);

      await registry.connect(alice).deposit(7_000_000n);
      await registry.connect(bob).deposit(5_000_000n);
      await registry.connect(alice).withdraw(2_000_000n);
      await registry.connect(bob).withdraw(1_000_000n);

      const aliceBal = await registry.balances(alice.address);
      const bobBal = await registry.balances(bob.address);
      const contractUsdc = await usdc.balanceOf(await registry.getAddress());

      expect(aliceBal + bobBal).to.equal(contractUsdc);
      expect(aliceBal).to.equal(5_000_000n);
      expect(bobBal).to.equal(4_000_000n);
    });
  });
});
