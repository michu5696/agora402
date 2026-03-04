import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
  type Transport,
  type Chain,
  type Account,
  keccak256,
  toBytes,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  agora402EscrowAbi,
  type EscrowData,
  type CreateEscrowParams,
  EscrowState,
  USDC_ADDRESSES,
} from "@paycrow/core";

const erc20Abi = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export interface EscrowClientConfig {
  privateKey: Hash;
  escrowAddress: Address;
  rpcUrl?: string;
  chain?: Chain;
}

export class EscrowClient {
  public readonly publicClient: PublicClient<Transport, Chain>;
  public readonly walletClient: WalletClient<Transport, Chain, Account>;
  public readonly account: PrivateKeyAccount;
  public readonly escrowAddress: Address;
  public readonly chain: Chain;
  private readonly usdcAddress: Address;

  constructor(config: EscrowClientConfig) {
    this.chain = config.chain ?? baseSepolia;
    this.escrowAddress = config.escrowAddress;
    this.account = privateKeyToAccount(config.privateKey);

    const rpcUrl = config.rpcUrl ?? baseSepolia.rpcUrls.default.http[0];

    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: http(rpcUrl),
    });

    this.walletClient = createWalletClient({
      account: this.account,
      chain: this.chain,
      transport: http(rpcUrl),
    });

    const usdcAddr = USDC_ADDRESSES[this.chain.id];
    if (!usdcAddr) {
      throw new Error(`No USDC address configured for chain ${this.chain.id}`);
    }
    this.usdcAddress = usdcAddr;
  }

  async createAndFund(params: CreateEscrowParams): Promise<{
    escrowId: bigint;
    txHash: Hash;
  }> {
    // Check and set USDC allowance
    await this.ensureAllowance(params.amount);

    const txHash = await this.walletClient.writeContract({
      address: this.escrowAddress,
      abi: agora402EscrowAbi,
      functionName: "createAndFund",
      args: [
        params.seller,
        params.amount,
        params.timelockDuration,
        params.serviceHash,
      ],
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    // Parse the EscrowCreated event to get the escrowId
    const escrowCreatedLog = receipt.logs.find(
      (log) =>
        log.address.toLowerCase() === this.escrowAddress.toLowerCase() &&
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

    return { escrowId, txHash };
  }

  async release(escrowId: bigint): Promise<Hash> {
    return this.walletClient.writeContract({
      address: this.escrowAddress,
      abi: agora402EscrowAbi,
      functionName: "release",
      args: [escrowId],
    });
  }

  async dispute(escrowId: bigint): Promise<Hash> {
    return this.walletClient.writeContract({
      address: this.escrowAddress,
      abi: agora402EscrowAbi,
      functionName: "dispute",
      args: [escrowId],
    });
  }

  async getEscrow(escrowId: bigint): Promise<EscrowData> {
    const result = await this.publicClient.readContract({
      address: this.escrowAddress,
      abi: agora402EscrowAbi,
      functionName: "getEscrow",
      args: [escrowId],
    });

    const [buyer, seller, amount, createdAt, expiresAt, state, serviceHash] =
      result as [Address, Address, bigint, bigint, bigint, number, Hash];

    return {
      buyer,
      seller,
      amount,
      createdAt,
      expiresAt,
      state: state as EscrowState,
      serviceHash,
    };
  }

  async isExpired(escrowId: bigint): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.escrowAddress,
      abi: agora402EscrowAbi,
      functionName: "isExpired",
      args: [escrowId],
    }) as Promise<boolean>;
  }

  async getUsdcBalance(): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.usdcAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.account.address],
    }) as Promise<bigint>;
  }

  serviceHash(serviceUrl: string): Hash {
    return keccak256(toBytes(serviceUrl));
  }

  private async ensureAllowance(amount: bigint): Promise<void> {
    const allowance = (await this.publicClient.readContract({
      address: this.usdcAddress,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.account.address, this.escrowAddress],
    })) as bigint;

    if (allowance < amount) {
      const txHash = await this.walletClient.writeContract({
        address: this.usdcAddress,
        abi: erc20Abi,
        functionName: "approve",
        args: [this.escrowAddress, amount],
      });
      await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    }
  }
}
