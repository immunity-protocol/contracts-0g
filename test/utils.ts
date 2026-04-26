import hre from "hardhat";

export async function getEthers() {
  const connection = await hre.network.connect();
  return (connection as any).ethers;
}

export async function deployMockUSDC(ethers: any) {
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();
  return usdc;
}

export async function deployTestRegistry(ethers: any, usdcAddress: string) {
  const TestRegistry = await ethers.getContractFactory("TestRegistry");
  const registry = await TestRegistry.deploy(usdcAddress);
  await registry.waitForDeployment();
  return registry;
}

export async function setupRegistryFixture() {
  const ethers = await getEthers();
  const [owner, alice, bob, carol] = await ethers.getSigners();
  const usdc = await deployMockUSDC(ethers);
  const registry = await deployTestRegistry(ethers, await usdc.getAddress());
  return { ethers, owner, alice, bob, carol, usdc, registry };
}
