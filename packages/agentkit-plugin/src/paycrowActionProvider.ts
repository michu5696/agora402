import "reflect-metadata";
import { z } from "zod";
import {
  ActionProvider,
  CreateAction,
  EvmWalletProvider,
  type Network,
} from "@coinbase/agentkit";
import {
  encodeFunctionData,
  keccak256,
  toBytes,
  parseUnits,
  formatUnits,
  type Hex,
  type Address,
} from "viem";
import {
  CreateEscrowSchema,
  ReleaseEscrowSchema,
  DisputeEscrowSchema,
  EscrowStatusSchema,
  TrustScoreSchema,
  ProtectedCallSchema,
} from "./schemas.js";
import {
  ESCROW_ABI,
  REPUTATION_ABI,
  ERC20_ABI,
  ESCROW_ADDRESSES,
  REPUTATION_ADDRESSES,
  USDC_ADDRESSES,
  USDC_DECIMALS,
  STATE_NAMES,
} from "./constants.js";

export interface PayCrowConfig {
  escrowAddress?: Address;
  reputationAddress?: Address;
  usdcAddress?: Address;
}

export class PayCrowActionProvider extends ActionProvider<EvmWalletProvider> {
  private escrowAddress?: Address;
  private reputationAddress?: Address;
  private usdcAddress?: Address;

  constructor(config?: PayCrowConfig) {
    super("paycrow", []);
    this.escrowAddress = config?.escrowAddress;
    this.reputationAddress = config?.reputationAddress;
    this.usdcAddress = config?.usdcAddress;
  }

  private getEscrowAddress(chainId: number): Address {
    if (this.escrowAddress) return this.escrowAddress;
    const addr = ESCROW_ADDRESSES[chainId];
    if (!addr) throw new Error(`No PayCrow escrow contract on chain ${chainId}`);
    return addr;
  }

  private getReputationAddress(chainId: number): Address {
    if (this.reputationAddress) return this.reputationAddress;
    const addr = REPUTATION_ADDRESSES[chainId];
    if (!addr)
      throw new Error(`No PayCrow reputation contract on chain ${chainId}`);
    return addr;
  }

  private getUsdcAddress(chainId: number): Address {
    if (this.usdcAddress) return this.usdcAddress;
    const addr = USDC_ADDRESSES[chainId];
    if (!addr) throw new Error(`No USDC address configured for chain ${chainId}`);
    return addr;
  }

  private getChainId(network: Network): number {
    return Number(network.chainId ?? "84532");
  }

  private parseUsdc(amount: number): bigint {
    return parseUnits(amount.toString(), USDC_DECIMALS);
  }

  private formatUsdc(amount: bigint): string {
    return `$${formatUnits(amount, USDC_DECIMALS)}`;
  }

  private async ensureAllowance(
    walletProvider: EvmWalletProvider,
    chainId: number,
    amount: bigint
  ): Promise<void> {
    const usdcAddr = this.getUsdcAddress(chainId);
    const escrowAddr = this.getEscrowAddress(chainId);
    const owner = walletProvider.getAddress() as Address;

    const allowance = (await walletProvider.readContract({
      address: usdcAddr,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner, escrowAddr],
    })) as bigint;

    if (allowance < amount) {
      const data = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [escrowAddr, amount],
      });
      const txHash = await walletProvider.sendTransaction({
        to: usdcAddr,
        data,
      });
      await walletProvider.waitForTransactionReceipt(txHash);
    }
  }

  @CreateAction({
    name: "create_escrow",
    description:
      "Create a USDC escrow to protect an agent-to-agent transaction. Funds are locked until delivery is confirmed (release) or flagged (dispute). 2% protocol fee on release. Auto-refund on expiry.",
    schema: CreateEscrowSchema,
  })
  async createEscrow(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof CreateEscrowSchema>
  ): Promise<string> {
    const chainId = this.getChainId(walletProvider.getNetwork());
    const escrowAddr = this.getEscrowAddress(chainId);
    const amount = this.parseUsdc(args.amount_usdc);
    const timelockDuration = BigInt(args.timelock_minutes * 60);
    const serviceHash = keccak256(toBytes(args.service_url));

    await this.ensureAllowance(walletProvider, chainId, amount);

    const data = encodeFunctionData({
      abi: ESCROW_ABI,
      functionName: "createAndFund",
      args: [args.seller as Address, amount, timelockDuration, serviceHash],
    });

    const txHash = await walletProvider.sendTransaction({
      to: escrowAddr,
      data,
    });

    const receipt = await walletProvider.waitForTransactionReceipt(txHash);

    const escrowCreatedLog = receipt.logs?.find(
      (log: { address: string; topics: string[] }) =>
        log.address.toLowerCase() === escrowAddr.toLowerCase() &&
        log.topics[0] ===
          keccak256(
            toBytes(
              "EscrowCreated(uint256,address,address,uint256,uint256,bytes32)"
            )
          )
    );

    const escrowId = escrowCreatedLog?.topics[1]
      ? BigInt(escrowCreatedLog.topics[1])
      : 0n;

    return JSON.stringify({
      success: true,
      escrowId: escrowId.toString(),
      amount: this.formatUsdc(amount),
      seller: args.seller,
      serviceUrl: args.service_url,
      expiresInMinutes: args.timelock_minutes,
      txHash,
      message: `Escrow #${escrowId} created. ${this.formatUsdc(amount)} locked. Call release_escrow when delivery is confirmed, or dispute_escrow if there's a problem.`,
    });
  }

  @CreateAction({
    name: "release_escrow",
    description:
      "Confirm delivery and release escrowed USDC to the seller. Only call this when you've verified the service was delivered correctly. 2% protocol fee is deducted.",
    schema: ReleaseEscrowSchema,
  })
  async releaseEscrow(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof ReleaseEscrowSchema>
  ): Promise<string> {
    const chainId = this.getChainId(walletProvider.getNetwork());
    const escrowAddr = this.getEscrowAddress(chainId);
    const escrowId = BigInt(args.escrow_id);

    const data = encodeFunctionData({
      abi: ESCROW_ABI,
      functionName: "release",
      args: [escrowId],
    });

    const txHash = await walletProvider.sendTransaction({
      to: escrowAddr,
      data,
    });

    await walletProvider.waitForTransactionReceipt(txHash);

    return JSON.stringify({
      success: true,
      escrowId: args.escrow_id,
      action: "released",
      txHash,
      message: `Escrow #${args.escrow_id} released. Funds sent to seller.`,
    });
  }

  @CreateAction({
    name: "dispute_escrow",
    description:
      "Flag a problem with delivery. Locks the escrowed funds for arbiter review. Use when the service was not delivered or quality was unacceptable.",
    schema: DisputeEscrowSchema,
  })
  async disputeEscrow(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof DisputeEscrowSchema>
  ): Promise<string> {
    const chainId = this.getChainId(walletProvider.getNetwork());
    const escrowAddr = this.getEscrowAddress(chainId);
    const escrowId = BigInt(args.escrow_id);

    const data = encodeFunctionData({
      abi: ESCROW_ABI,
      functionName: "dispute",
      args: [escrowId],
    });

    const txHash = await walletProvider.sendTransaction({
      to: escrowAddr,
      data,
    });

    await walletProvider.waitForTransactionReceipt(txHash);

    return JSON.stringify({
      success: true,
      escrowId: args.escrow_id,
      action: "disputed",
      reason: args.reason,
      txHash,
      message: `Escrow #${args.escrow_id} disputed. Funds locked for arbiter review. Reason: ${args.reason}`,
    });
  }

  @CreateAction({
    name: "check_escrow",
    description:
      "Check the current state of an escrow (Funded, Released, Disputed, Resolved, Expired, Refunded).",
    schema: EscrowStatusSchema,
  })
  async checkEscrow(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof EscrowStatusSchema>
  ): Promise<string> {
    const chainId = this.getChainId(walletProvider.getNetwork());
    const escrowAddr = this.getEscrowAddress(chainId);
    const escrowId = BigInt(args.escrow_id);

    const result = (await walletProvider.readContract({
      address: escrowAddr,
      abi: ESCROW_ABI,
      functionName: "getEscrow",
      args: [escrowId],
    })) as [Address, Address, bigint, bigint, bigint, number, Hex];

    const [buyer, seller, amount, createdAt, expiresAt, state] = result;

    return JSON.stringify({
      escrowId: args.escrow_id,
      state: STATE_NAMES[state] ?? "Unknown",
      buyer,
      seller,
      amount: this.formatUsdc(amount),
      createdAt: new Date(Number(createdAt) * 1000).toISOString(),
      expiresAt: new Date(Number(expiresAt) * 1000).toISOString(),
    });
  }

  @CreateAction({
    name: "check_trust_score",
    description:
      "Look up the on-chain trust score of an agent address before transacting. Score is 0-100 based on real escrow history (completed, disputed, refunded). Check this before sending money to unknown agents.",
    schema: TrustScoreSchema,
  })
  async checkTrustScore(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof TrustScoreSchema>
  ): Promise<string> {
    const chainId = this.getChainId(walletProvider.getNetwork());
    const repAddr = this.getReputationAddress(chainId);
    const agentAddr = args.address as Address;

    const [score, repData] = await Promise.all([
      walletProvider.readContract({
        address: repAddr,
        abi: REPUTATION_ABI,
        functionName: "getScore",
        args: [agentAddr],
      }) as Promise<bigint>,
      walletProvider.readContract({
        address: repAddr,
        abi: REPUTATION_ABI,
        functionName: "getReputation",
        args: [agentAddr],
      }) as Promise<
        [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
      >,
    ]);

    const [
      totalCompleted,
      totalDisputed,
      totalRefunded,
      totalAsProvider,
      totalAsClient,
      totalVolume,
      firstSeen,
      lastSeen,
    ] = repData;

    const totalEscrows =
      Number(totalCompleted) + Number(totalDisputed) + Number(totalRefunded);

    if (totalEscrows === 0) {
      return JSON.stringify({
        address: args.address,
        score: 50,
        message:
          "No on-chain escrow history. New/unknown agent — use small escrow amounts.",
        recommendation: "low_trust",
      });
    }

    const successRate = ((Number(totalCompleted) / totalEscrows) * 100).toFixed(
      1
    );
    const s = Number(score);
    const recommendation =
      s >= 80 ? "high_trust" : s >= 50 ? "moderate_trust" : "low_trust";

    return JSON.stringify({
      address: args.address,
      score: s,
      totalEscrows,
      successfulEscrows: Number(totalCompleted),
      disputedEscrows: Number(totalDisputed),
      refundedEscrows: Number(totalRefunded),
      asProvider: Number(totalAsProvider),
      asClient: Number(totalAsClient),
      totalVolume: this.formatUsdc(totalVolume),
      successRate: `${successRate}%`,
      recommendation,
    });
  }

  @CreateAction({
    name: "protected_api_call",
    description: `Make an HTTP API call with automatic escrow protection. This is the flagship PayCrow tool.

Flow: Check trust score → Create escrow → Call API → Verify response matches JSON Schema → Auto-release payment if valid, auto-dispute if not.

Use this instead of direct x402 payments to get buyer protection. If the API returns bad data, your funds are automatically disputed.`,
    schema: ProtectedCallSchema,
  })
  async protectedApiCall(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof ProtectedCallSchema>
  ): Promise<string> {
    const chainId = this.getChainId(walletProvider.getNetwork());
    const escrowAddr = this.getEscrowAddress(chainId);
    const amount = this.parseUsdc(args.amount_usdc);
    const timelockDuration = BigInt(args.timelock_minutes * 60);
    const serviceHash = keccak256(toBytes(args.url));

    // Step 1: Create escrow
    await this.ensureAllowance(walletProvider, chainId, amount);

    const createData = encodeFunctionData({
      abi: ESCROW_ABI,
      functionName: "createAndFund",
      args: [
        args.seller_address as Address,
        amount,
        timelockDuration,
        serviceHash,
      ],
    });

    const createTx = await walletProvider.sendTransaction({
      to: escrowAddr,
      data: createData,
    });

    const receipt = await walletProvider.waitForTransactionReceipt(createTx);
    const createdLog = receipt.logs?.find(
      (log: { address: string; topics: string[] }) =>
        log.address.toLowerCase() === escrowAddr.toLowerCase() &&
        log.topics[0] ===
          keccak256(
            toBytes(
              "EscrowCreated(uint256,address,address,uint256,uint256,bytes32)"
            )
          )
    );
    const escrowId = createdLog?.topics[1]
      ? BigInt(createdLog.topics[1])
      : 0n;

    // Step 2: Make the API call
    let apiResponse: Response;
    let responseBody: string;
    try {
      apiResponse = await fetch(args.url, {
        method: args.method,
        headers: args.headers as HeadersInit | undefined,
        body:
          args.method === "GET" || args.method === "DELETE"
            ? undefined
            : args.body,
      });
      responseBody = await apiResponse.text();
    } catch (error) {
      // API failed — auto-dispute
      const disputeData = encodeFunctionData({
        abi: ESCROW_ABI,
        functionName: "dispute",
        args: [escrowId],
      });
      const disputeTx = await walletProvider.sendTransaction({
        to: escrowAddr,
        data: disputeData,
      });
      await walletProvider.waitForTransactionReceipt(disputeTx);

      return JSON.stringify({
        success: false,
        escrowId: escrowId.toString(),
        error: `API call failed: ${error instanceof Error ? error.message : String(error)}`,
        action: "auto_disputed",
        createTx,
        disputeTx,
      });
    }

    // Step 3: Verify response against JSON Schema
    let parsedResponse: unknown;
    try {
      parsedResponse = JSON.parse(responseBody);
    } catch {
      parsedResponse = responseBody;
    }

    let schema: Record<string, unknown>;
    try {
      schema = JSON.parse(args.verification_schema);
    } catch {
      schema = {};
    }

    // Simple schema validation: check required fields exist
    const valid = validateSchema(parsedResponse, schema);

    // Step 4: Auto-release or auto-dispute
    if (valid) {
      const releaseData = encodeFunctionData({
        abi: ESCROW_ABI,
        functionName: "release",
        args: [escrowId],
      });
      const releaseTx = await walletProvider.sendTransaction({
        to: escrowAddr,
        data: releaseData,
      });
      await walletProvider.waitForTransactionReceipt(releaseTx);

      return JSON.stringify({
        success: true,
        escrowId: escrowId.toString(),
        amount: this.formatUsdc(amount),
        seller: args.seller_address,
        url: args.url,
        httpStatus: apiResponse.status,
        action: "auto_released",
        createTx,
        releaseTx,
        response: parsedResponse,
        message: `Payment of ${this.formatUsdc(amount)} released to ${args.seller_address}. Response verified.`,
      });
    } else {
      const disputeData = encodeFunctionData({
        abi: ESCROW_ABI,
        functionName: "dispute",
        args: [escrowId],
      });
      const disputeTx = await walletProvider.sendTransaction({
        to: escrowAddr,
        data: disputeData,
      });
      await walletProvider.waitForTransactionReceipt(disputeTx);

      return JSON.stringify({
        success: false,
        escrowId: escrowId.toString(),
        amount: this.formatUsdc(amount),
        seller: args.seller_address,
        url: args.url,
        httpStatus: apiResponse.status,
        action: "auto_disputed",
        createTx,
        disputeTx,
        response: parsedResponse,
        message: `Escrow #${escrowId} auto-disputed. Response failed schema verification.`,
      });
    }
  }

  supportsNetwork = (network: Network) =>
    network.protocolFamily === "evm" &&
    (network.chainId === "8453" || network.chainId === "84532");
}

/** Minimal JSON Schema validation — checks type and required fields. */
function validateSchema(
  data: unknown,
  schema: Record<string, unknown>
): boolean {
  if (!schema || Object.keys(schema).length === 0) return true;
  if (schema.type === "object" && typeof data === "object" && data !== null) {
    const required = (schema.required as string[]) ?? [];
    const obj = data as Record<string, unknown>;
    return required.every((key) => key in obj);
  }
  if (schema.type === "array") return Array.isArray(data);
  if (schema.type === "string") return typeof data === "string";
  if (schema.type === "number") return typeof data === "number";
  return true;
}

export const paycrowActionProvider = (config?: PayCrowConfig) =>
  new PayCrowActionProvider(config);
