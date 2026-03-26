/**
 * BCRRS Deployment Script
 * =======================
 * Deploys all four BCRRS smart contracts in dependency order:
 *   1. ContractorRegistry  (no dependencies)
 *   2. ReputationLedger    (depends on: authority, milestone placeholder)
 *   3. ProjectMilestone    (depends on: registry, ledger)
 *   4. DisputeRegistry     (depends on: authority, ledger)
 *   5. Wire up: update ReputationLedger with real milestone address
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js --network hardhat
 *   npx hardhat run scripts/deploy.js --network besu
 *
 * After deployment run gas report:
 *   npm run gas
 */

const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("=".repeat(60));
  console.log("  BCRRS Deployment (v2 — four contracts)");
  console.log("=".repeat(60));
  console.log(`  Deployer : ${deployer.address}`);
  console.log(
    `  Balance  : ${ethers.formatEther(
      await ethers.provider.getBalance(deployer.address)
    )} ETH`
  );

  // 1. ContractorRegistry
  console.log("\n[1/5] Deploying ContractorRegistry...");
  const registry = await (
    await ethers.getContractFactory("ContractorRegistry")
  ).deploy(deployer.address);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log(`      ContractorRegistry : ${registryAddress}`);

  // 2. ReputationLedger (placeholder milestone)
  console.log("\n[2/5] Deploying ReputationLedger...");
  const ledger = await (
    await ethers.getContractFactory("ReputationLedger")
  ).deploy(deployer.address, deployer.address);
  await ledger.waitForDeployment();
  const ledgerAddress = await ledger.getAddress();
  console.log(`      ReputationLedger   : ${ledgerAddress}`);

  // 3. ProjectMilestone
  console.log("\n[3/5] Deploying ProjectMilestone...");
  const milestone = await (
    await ethers.getContractFactory("ProjectMilestone")
  ).deploy(deployer.address, registryAddress, ledgerAddress);
  await milestone.waitForDeployment();
  const milestoneAddress = await milestone.getAddress();
  console.log(`      ProjectMilestone   : ${milestoneAddress}`);

  // 4. DisputeRegistry — NEW
  console.log("\n[4/5] Deploying DisputeRegistry...");
  const disputeReg = await (
    await ethers.getContractFactory("DisputeRegistry")
  ).deploy(deployer.address, ledgerAddress);
  await disputeReg.waitForDeployment();
  const disputeAddress = await disputeReg.getAddress();
  console.log(`      DisputeRegistry    : ${disputeAddress}`);

  // 5. Wire up milestone address
  console.log("\n[5/5] Wiring ReputationLedger → ProjectMilestone...");
  const tx = await ledger.setMilestoneContract(milestoneAddress);
  await tx.wait();
  console.log(`      milestoneContract  : ${milestoneAddress}`);

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("  Deployment Complete");
  console.log("=".repeat(60));
  console.log(`  ContractorRegistry : ${registryAddress}`);
  console.log(`  ReputationLedger   : ${ledgerAddress}`);
  console.log(`  ProjectMilestone   : ${milestoneAddress}`);
  console.log(`  DisputeRegistry    : ${disputeAddress}`);
  console.log(`  Authority          : ${deployer.address}`);
  console.log("=".repeat(60));
  console.log("\n  Copy these to your .env then run: npm run gas\n");

  return { registry, ledger, milestone, disputeReg };
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
