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
