import Eth from "ethjs";
import { action, computed, when, observable, observe } from "mobx";
import Block from "./Block";
import withTimeout from "./util/withTimeout";

const NULL_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const DEFAULT_DELAY = 2000;

export default class EthStream {
  @observable headBlockNumber = 0;

  constructor(provider, props = {}) {
    // Check jsonRpcUrl
    if (!provider)
      throw new Error(
        "web3 provider must be specified (e.g. `new EthStream(new HttpProvider('http://localhost:8545'), {})`)"
      );
    // Check fromBlockNumber, fromBlockHash, fromSnapshot props
    const fromPropsCount = [
      props.fromBlockHash,
      props.fromBlockNumber,
      props.fromSnapshot
    ].filter(Boolean).length;
    if (fromPropsCount > 1)
      throw new Error(
        "only one allowed: fromBlockHash, fromBlockNumber, fromSnapshot"
      );
    this.eth = new Eth(provider);
    this.onAddBlock = props.onAddBlock || (() => true);
    this.onConfirmBlock = props.onConfirmBlock || (() => true);
    this.onRollbackBlock = props.onRollbackBlock || (() => true);
    this.fromBlockHash = props.fromBlockHash;
    this.fromBlockNumber = props.fromBlockNumber;
    this.fromBlockLoaded = false;
    // Start from snapshot
    if (props.fromSnapshot) {
      this.blocks = observable(
        new Map(
          props.fromSnapshot.map(block => [
            block.hash,
            Block.fromSnapshot(this, block)
          ])
        )
      );
    } else {
      this.blocks = observable(new Map());
    }
  }

  @computed
  get isEmpty() {
    return this.blocks.size === 0;
  }

  get fromBlockNeedsLoading() {
    return (
      this.fromBlockHash || (this.fromBlockNumber && !this.fromBlockLoaded)
    );
  }

  async loadFromBlock() {
    let fromBlock;
    if (this.fromBlockHash) {
      fromBlock = await this.eth.getBlockByHash(this.fromBlockHash, true);
    }
    if (this.fromBlockNumber) {
      fromBlock = await this.eth.getBlockByNumber(this.fromBlockNumber, true);
    }
    this.fromBlockLoaded = true;
    await this.addBlock(fromBlock);
    return true;
  }

  takeSnapshot() {
    const snapshot = [];
    this.blocks.forEach(block => snapshot.push(block.toSnapshot()));
    return snapshot;
  }

  async getLatestBlock(delay = DEFAULT_DELAY) {
    try {
      const latestBlock = await withTimeout(
        this.eth.getBlockByNumber("latest", true),
        2000
      );
      const addedBlock = await this.addBlock(latestBlock);
    } catch (err) {
      console.log("ERROR", err);
      // Silence getBlockByNumber errors
    }
    this.timer = setTimeout(() => this.getLatestBlock(delay), delay);
  }

  async start() {
    if (this.fromBlockNeedsLoading) await this.loadFromBlock();
    this.getLatestBlock();
  }

  stop() {
    clearTimeout(this.timer);
  }

  @action
  confirmBlock(hash) {
    this.onConfirmBlock(this.blocks.get(hash));
  }

  @action
  flushBlock(hash) {
    const flushBlock = this.blocks.get(hash);
    if (!flushBlock.isConfirmed) {
      this.onRollbackBlock(flushBlock);
    }
    this.blocks.delete(hash);
  }

  @action
  async addBlock(block) {
    // Return if block isn't complete
    if (!block || !block.hash || !block.number || !block.parentHash)
      return false;
    // Check for fromBlock
    if (this.fromBlockNeedsLoading) await this.loadFromBlock();
    // Return if block already in history
    if (this.blocks.has(block.hash)) return false;
    // Check for parent
    if (
      !this.isEmpty &&
      block.parentHash != NULL_HASH &&
      !this.blocks.has(block.parentHash)
    ) {
      const parentBlock = await this.eth.getBlockByHash(block.parentHash, true);
      await this.addBlock(parentBlock);
    }
    // Add block
    const newBlock = new Block(this, block);
    this.blocks.set(block.hash, newBlock);
    this.onAddBlock(newBlock);
    // Re-count depths
    newBlock.setChildrenDepth(0);
    // Update headBlockNumber
    const blockNumber = block.number.toNumber();
    if (blockNumber > this.headBlockNumber) {
      this.headBlockNumber = blockNumber;
    }
    return newBlock;
  }
}
