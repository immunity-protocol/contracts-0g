import { expect } from "chai";
import { getEthers } from "./utils.js";

describe("Registry — reentrancy", function () {
  let ethers: any;
  let alice: any;
  let owner: any;
  let malicious: any;
  let registry: any;

  beforeEach(async function () {
    ethers = await getEthers();
    [owner, alice] = await ethers.getSigners();

    const MaliciousUSDC = await ethers.getContractFactory("MaliciousUSDC");
    malicious = await MaliciousUSDC.deploy();
    await malicious.waitForDeployment();

    const Registry = await ethers.getContractFactory("Registry");
    registry = await Registry.deploy(await malicious.getAddress());
    await registry.waitForDeployment();

    await malicious.setVictim(await registry.getAddress());

    // Fund alice and seed her registry balance.
    await malicious.mint(alice.address, 5_000_000n);
    await malicious.connect(alice).approve(await registry.getAddress(), 5_000_000n);
    await registry.connect(alice).deposit(5_000_000n);
  });

  it("blocks reentrancy through withdraw (nonReentrant guard fires)", async function () {
    await malicious.setAttacking(true);
    await expect(registry.connect(alice).withdraw(1_000n))
      .to.be.revertedWith("REENTRY_BLOCKED");
  });

  it("blocks reentrancy through withdrawTreasury", async function () {
    // Drive a treasury balance via no-match checks, then attempt reentry.
    await malicious.setAttacking(false);
    await registry.connect(alice).check("0x" + "00".repeat(32));
    await registry.connect(alice).check("0x" + "00".repeat(32));

    await malicious.setAttacking(true);
    await expect(registry.connect(owner).withdrawTreasury(100n, owner.address))
      .to.be.revertedWith("REENTRY_BLOCKED");
  });

  it("withdraw works normally when no attack is in progress", async function () {
    await malicious.setAttacking(false);
    await expect(registry.connect(alice).withdraw(1_000n))
      .to.emit(registry, "Withdrew")
      .withArgs(alice.address, 1_000n);
  });
});
