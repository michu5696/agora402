/**
 * End-to-end test: simulate an autonomous agent discovering and paying
 * for Agora402's trust score API using the x402 protocol.
 *
 * Usage:
 *   EVM_PRIVATE_KEY=0x... npx tsx scripts/test-e2e.ts [address]
 *
 * This uses your wallet's USDC on Base mainnet to make a real $0.02 payment.
 */

import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const TRUST_API = "https://paycrow.fly.dev";
const TARGET_ADDRESS =
  process.argv[2] ?? "0x0326c9fa34e2270d3ec2befe497085c232dd536b";

async function main() {
  const pk = process.env.EVM_PRIVATE_KEY;
  if (!pk) {
    console.error("Set EVM_PRIVATE_KEY env var (hex private key with USDC on Base)");
    process.exit(1);
  }

  console.log("\n=== Agora402 End-to-End Test ===\n");

  // ── Step 1: Discovery ──
  console.log("1. Discovering services at", TRUST_API);
  const discoveryRes = await fetch(`${TRUST_API}/discovery/resources`);
  const discovery = (await discoveryRes.json()) as {
    resources: Array<{
      resource: string;
      description: string;
      maxAmountRequired: string;
      network: string;
    }>;
  };

  console.log(`   Found ${discovery.resources.length} resource(s):`);
  for (const r of discovery.resources) {
    const price = Number(r.maxAmountRequired) / 1e6;
    console.log(`   - ${r.resource} ($${price} USDC, ${r.network})`);
    console.log(`     ${r.description.slice(0, 100)}...`);
  }

  // ── Step 2: Try without payment (expect 402) ──
  console.log("\n2. Requesting trust score without payment...");
  const noPay = await fetch(`${TRUST_API}/trust/${TARGET_ADDRESS}`);
  console.log(`   Status: ${noPay.status} ${noPay.statusText}`);
  if (noPay.status === 402) {
    const requirements = await noPay.json();
    console.log(`   x402 Version: ${requirements.x402Version}`);
    console.log(`   Scheme: ${requirements.accepts[0].scheme}`);
    console.log(`   Network: ${requirements.accepts[0].network}`);
    console.log(`   Price: $${Number(requirements.accepts[0].amount) / 1e6} USDC`);
    console.log(`   PayTo: ${requirements.accepts[0].payTo}`);
    console.log(`   Facilitator: ${requirements.facilitatorUrl}`);
  }

  // ── Step 3: Pay with x402 ──
  console.log("\n3. Setting up x402 payment client...");
  const account = privateKeyToAccount(pk as `0x${string}`);
  console.log(`   Payer wallet: ${account.address}`);

  const publicClient = createPublicClient({ chain: base, transport: http() });
  const evmSigner = toClientEvmSigner(account, publicClient);

  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(evmSigner));
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  console.log("\n4. Requesting trust score WITH payment (auto-sign + settle)...");
  const paidRes = await fetchWithPayment(`${TRUST_API}/trust/${TARGET_ADDRESS}`, {
    method: "GET",
  });

  console.log(`   Status: ${paidRes.status} ${paidRes.statusText}`);

  if (paidRes.ok) {
    const trustScore = await paidRes.json();
    console.log("\n=== Trust Score Result ===");
    console.log(JSON.stringify(trustScore, null, 2));
    console.log("\n✅ End-to-end x402 payment flow succeeded!");
  } else {
    const errorBody = await paidRes.text();
    console.error("   Payment failed:", errorBody);
  }

  console.log("\n=== Test Complete ===\n");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
