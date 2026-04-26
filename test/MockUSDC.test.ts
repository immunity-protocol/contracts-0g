import { expect } from "chai";
import { getEthers, deployMockUSDC } from "./utils.js";

describe("MockUSDC", function () {
  let ethers: any;
  let usdc: any;
  let alice: any;
  let bob: any;

  beforeEach(async function () {
    ethers = await getEthers();
    [alice, bob] = await ethers.getSigners();
    usdc = await deployMockUSDC(ethers);
  });

  it("has the expected name and symbol", async function () {
    expect(await usdc.name()).to.equal("Mock USDC");
    expect(await usdc.symbol()).to.equal("USDC");
  });

  it("uses 6 decimals", async function () {
    expect(await usdc.decimals()).to.equal(6);
  });

  it("starts with zero total supply", async function () {
    expect(await usdc.totalSupply()).to.equal(0n);
  });

  it("mints to the recipient", async function () {
    const amount = 1_000_000n; // 1.0 USDC
    await usdc.mint(alice.address, amount);
    expect(await usdc.balanceOf(alice.address)).to.equal(amount);
    expect(await usdc.totalSupply()).to.equal(amount);
  });

  it("emits Transfer from the zero address on mint", async function () {
    const amount = 500_000n;
    await expect(usdc.mint(bob.address, amount))
      .to.emit(usdc, "Transfer")
      .withArgs(ethers.ZeroAddress, bob.address, amount);
  });

  it("allows any caller to mint (mock-only)", async function () {
    const amount = 250_000n;
    await usdc.connect(bob).mint(bob.address, amount);
    expect(await usdc.balanceOf(bob.address)).to.equal(amount);
  });

  it("transfers like a standard ERC20", async function () {
    await usdc.mint(alice.address, 1_000_000n);
    await usdc.connect(alice).transfer(bob.address, 400_000n);
    expect(await usdc.balanceOf(alice.address)).to.equal(600_000n);
    expect(await usdc.balanceOf(bob.address)).to.equal(400_000n);
  });
});
