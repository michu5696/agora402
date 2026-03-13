import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  type Address,
  type Hash,
  type PublicClient,
  type Chain,
  type Transport,
  type Account,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { payCrowRouterAbi } from "@paycrow/core";

// ─── Types ────────────────────────────────────────────────────────────────

/** x402 PaymentRequirements (subset relevant to verification) */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

/** x402 PaymentPayload with EIP-3009 authorization data */
export interface PaymentPayload {
  x402Version: number;
  accepted: PaymentRequirements;
  payload: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
    v: number;
    r: string;
    s: string;
  };
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
  escrowId?: string;
}

export interface SupportedResponse {
  kinds: Array<{ scheme: string; network: string }>;
  signers: string[];
}

export interface PayCrowFacilitatorConfig {
  /** Private key of the facilitator (pays gas for settlement) */
  privateKey: Hash;
  /** Address of the PayCrowEscrowRouter contract */
  routerAddress: Address;
  /** RPC URL for the target chain */
  rpcUrl?: string;
  /** Chain configuration (defaults to Base Sepolia) */
  chain?: Chain;
  /** Default escrow timelock in seconds (defaults to 30 min) */
  defaultTimelockSeconds?: number;
}

// ─── ERC20 balance check ABI ──────────────────────────────────────────────

const erc20BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// ─── Facilitator ──────────────────────────────────────────────────────────

/**
 * PayCrow x402 Facilitator.
 *
 * Drop-in replacement for the default x402.org facilitator.
 * Instead of settling payments directly to sellers, routes USDC through
 * the PayCrowEscrowRouter for buyer protection.
 *
 * Resource servers point their facilitator URL here instead of x402.org.
 * Clients (buyers) sign the same EIP-3009 authorizations — zero changes needed.
 */
export class PayCrowFacilitator {
  private readonly publicClient: PublicClient;
  private readonly walletClient: ReturnType<typeof createWalletClient<Transport, Chain, PrivateKeyAccount>>;
  private readonly routerAddress: Address;
  private readonly chain: Chain;
  private readonly defaultTimelockSeconds: number;
  private readonly signerAddress: Address;

  constructor(config: PayCrowFacilitatorConfig) {
    const account = privateKeyToAccount(config.privateKey);
    this.chain = config.chain ?? baseSepolia;
    this.routerAddress = config.routerAddress;
    this.defaultTimelockSeconds = config.defaultTimelockSeconds ?? 1800;
    this.signerAddress = account.address;

    const transport = http(config.rpcUrl);

    this.publicClient = createPublicClient({
      chain: this.chain,
      transport,
    });

    this.walletClient = createWalletClient({
      account,
      chain: this.chain,
      transport,
    });
  }

  /**
   * Verify a payment payload without executing.
   * Checks: signature validity window, payer balance, amount matches requirements.
   */
  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements
  ): Promise<VerifyResponse> {
    const { payload } = paymentPayload;
    const payer = payload.from as Address;

    // Check validity window
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now <= BigInt(payload.validAfter)) {
      return {
        isValid: false,
        invalidReason: "Authorization not yet valid",
        payer,
      };
    }
    if (now >= BigInt(payload.validBefore)) {
      return {
        isValid: false,
        invalidReason: "Authorization expired",
        payer,
      };
    }

    // Check amount matches requirements
    if (payload.value !== paymentRequirements.amount) {
      return {
        isValid: false,
        invalidReason: `Amount mismatch: payload=${payload.value}, required=${paymentRequirements.amount}`,
        payer,
      };
    }

    // Check `to` points to our router (buyer signed auth to transfer to router)
    if (payload.to.toLowerCase() !== this.routerAddress.toLowerCase()) {
      return {
        isValid: false,
        invalidReason: `Payment destination must be the escrow router (${this.routerAddress})`,
        payer,
      };
    }

    // Check payer USDC balance
    const balance = await this.publicClient.readContract({
      address: paymentRequirements.asset as Address,
      abi: erc20BalanceAbi,
      functionName: "balanceOf",
      args: [payer],
    });

    if (balance < BigInt(paymentRequirements.amount)) {
      return {
        isValid: false,
        invalidReason: `Insufficient USDC balance: has ${balance}, needs ${paymentRequirements.amount}`,
        payer,
      };
    }

    return { isValid: true, payer };
  }

  /**
   * Settle a payment by routing through the PayCrowEscrowRouter.
   *
   * Instead of direct transfer, this:
   * 1. Calls Router.settleToEscrow() which executes the EIP-3009 transfer
   * 2. Creates an escrow with buyer = the original payer
   * 3. Returns the escrow ID along with the settlement tx
   *
   * The buyer can then release/dispute via the MCP server.
   */
  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements
  ): Promise<SettleResponse> {
    const { payload } = paymentPayload;
    const payer = payload.from as Address;
    const seller = paymentRequirements.payTo as Address;

    // Build the service hash from the resource URL (if available)
    const resourceUrl =
      (paymentPayload as unknown as Record<string, unknown>).resource?.toString() ?? seller;
    const serviceHash = keccak256(toBytes(resourceUrl));

    try {
      const txHash = await this.walletClient.writeContract({
        address: this.routerAddress,
        abi: payCrowRouterAbi,
        functionName: "settleToEscrow",
        chain: this.chain,
        args: [
          payer,
          BigInt(payload.value),
          BigInt(payload.validAfter),
          BigInt(payload.validBefore),
          payload.nonce as Hash,
          payload.v,
          payload.r as Hash,
          payload.s as Hash,
          seller,
          BigInt(this.defaultTimelockSeconds),
          serviceHash,
        ],
      });

      // Wait for confirmation
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
      });

      // Extract escrowId from SettledToEscrow event
      let escrowId: string | undefined;
      for (const log of receipt.logs) {
        try {
          // SettledToEscrow event topic
          if (
            log.address.toLowerCase() === this.routerAddress.toLowerCase() &&
            log.topics[0] ===
              "0xa7e9dee608a8ea1679811e1d338e1e64e30570ddbcb1d4988a2da9d32738ec2c"
          ) {
            escrowId = BigInt(log.topics[1] ?? "0").toString();
          }
        } catch {
          // Skip unparseable logs
        }
      }

      return {
        success: true,
        payer,
        transaction: txHash,
        network: `eip155:${this.chain.id}`,
        escrowId,
      };
    } catch (error) {
      return {
        success: false,
        errorReason: error instanceof Error ? error.message : String(error),
        payer,
        transaction: "",
        network: `eip155:${this.chain.id}`,
      };
    }
  }

  /** Return supported payment schemes and networks */
  getSupported(): SupportedResponse {
    return {
      kinds: [
        {
          scheme: "exact",
          network: `eip155:${this.chain.id}`,
        },
      ],
      signers: [this.signerAddress],
    };
  }
}
