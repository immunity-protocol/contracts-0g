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

export async function deployRegistry(ethers: any, usdcAddress: string) {
  const Registry = await ethers.getContractFactory("Registry");
  const registry = await Registry.deploy(usdcAddress);
  await registry.waitForDeployment();
  return registry;
}

export async function setupRegistryFixture() {
  const ethers = await getEthers();
  const [owner, alice, bob, carol] = await ethers.getSigners();
  const usdc = await deployMockUSDC(ethers);
  const registry = await deployRegistry(ethers, await usdc.getAddress());
  return { ethers, owner, alice, bob, carol, usdc, registry };
}
