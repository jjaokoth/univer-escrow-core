/**
 * MerkleCompactor
 * Memory lifecycle manager - prunes historical Merkle tree branches to prevent OOM.
 */
import type {HexDigest,MerkleProof}from './types';
import {sha256Hex}from './sha256';
import {MerkleTree}from './MerkleTree';

// Compacted state representation
export interface CompactedState{
  checkpointIndex:number;
  aggregateHash:HexDigest;
  compactedAt:number;
  preservedLeaves:HexDigest[];
  activeBranchHashes:Map<number,HexDigest>;
}

// Compaction result
export interface CompactionResult{
  success:boolean;
  previousCheckpoint:number;
  newCheckpoint:number;
  memoryFreedBytes:number;
  aggregateHash:HexDigest;
  error?:string;
}

// Configuration for compaction
export interface CompactorConfig{
  maxHistoricalDepth:number;
  minCheckpointInterval:number;
  enableAggressivePruning:boolean;
  preserveRecentLeaves:number;
}

// Historical tree state
interface HistoricalTree{
  checkpointIndex:number;
  rootHash:HexDigest;
  leaves:HexDigest[];
  compacted:boolean;
}

export class MerkleCompactor{
  private readonly config:Required<CompactorConfig>;
  private historicalTrees:Map<number,HistoricalTree>=new Map();
  private activeTree?:MerkleTree;
  private currentCheckpoint:number=0;
  private totalMemoryUsed:number=0;

  constructor(config:CompactorConfig={
    maxHistoricalDepth:1000,
    minCheckpointInterval:10,
    enableAggressivePruning:false,
    preserveRecentLeaves:50
  }){
    this.config={
      maxHistoricalDepth:config.maxHistoricalDepth??1000,
      minCheckpointInterval:config.minCheckpointInterval??10,
      enableAggressivePruning:config.enableAggressivePruning??false,
      preserveRecentLeaves:config.preserveRecentLeaves??50
    };
  }

  /**
   * Add a new leaf to the active Merkle tree
   */
  public addLeaf(leaf:HexDigest):void{
    if(!this.activeTree){
      this.activeTree=new MerkleTree([leaf]);
    }else{
      const existingLeaves=this.getActiveLeaves();
      this.activeTree=new MerkleTree([...existingLeaves,leaf]);
    }
    this.totalMemoryUsed+=leaf.length*2;
  }

  /**
   * Get current active tree root
   */
  public getActiveRoot():HexDigest{
    return this.activeTree?.getRoot()??'' as HexDigest;
  }

  /**
   * Get active leaves
   */
  private getActiveLeaves():HexDigest[]{
    if(!this.activeTree)return[];
    const count=this.activeTree.getLeafCount();
    const leaves:HexDigest[]=[];
    for(let i=0;i<count;i++){
      const leaf = this.activeTree.getRoot() as HexDigest;
      if(leaf)leaves.push(leaf);
    }
    return leaves;
  }

  /**
   * Prune historical tree up to checkpoint
   */
  public pruneHistoricalTree(checkpointIndex:number):CompactionResult{
    if(checkpointIndex<0){
      return{success:false,previousCheckpoint:this.currentCheckpoint,newCheckpoint:this.currentCheckpoint,memoryFreedBytes:0,aggregateHash:'' as HexDigest,error:'Invalid checkpoint index'};
    }
    if(checkpointIndex<=this.currentCheckpoint){
      return{success:false,previousCheckpoint:this.currentCheckpoint,newCheckpoint:this.currentCheckpoint,memoryFreedBytes:0,aggregateHash:'' as HexDigest,error:'Checkpoint already compacted'};
    }
    const targetIndex=Math.min(checkpointIndex,this.currentCheckpoint+this.config.minCheckpointInterval);
    let memoryFreed=0;
    const preservedLeaves:HexDigest[]=[];
    const activeBranchHashes=new Map<number,HexDigest>();
    for(const[index,tree]of this.historicalTrees){
      if(index>=targetIndex-this.config.preserveRecentLeaves){
        preservedLeaves.push(tree.rootHash);
        activeBranchHashes.set(index,tree.rootHash);
      }else{
        memoryFreed+=tree.leaves.length*66;
        this.historicalTrees.delete(index);
      }
    }
    const aggregateHash=sha256Hex(preservedLeaves.join('|'));
    this.currentCheckpoint=targetIndex;
    this.totalMemoryUsed-=memoryFreed;
    return{
      success:true,
      previousCheckpoint:this.currentCheckpoint,
      newCheckpoint:targetIndex,
      memoryFreedBytes:memoryFreed,
      aggregateHash
    };
  }

  /**
   * Create checkpoint of current state
   */
  public createCheckpoint():number{
    if(!this.activeTree)return this.currentCheckpoint;
    const leaves=this.getActiveLeaves();
    this.historicalTrees.set(this.currentCheckpoint,{
      checkpointIndex:this.currentCheckpoint,
      rootHash:this.activeTree.getRoot(),
      leaves,
      compacted:false
    });
    this.currentCheckpoint++;
    if(this.historicalTrees.size>this.config.maxHistoricalDepth){
      this.pruneHistoricalTree(this.currentCheckpoint-this.config.maxHistoricalDepth+Math.floor(this.config.maxHistoricalDepth/2));
    }
    return this.currentCheckpoint;
  }

  /**
   * Get compacted state
   */
  public getCompactedState(checkpointIndex:number):CompactedState|undefined{
    const tree=this.historicalTrees.get(checkpointIndex);
    if(!tree)return undefined;
    const preserved=Array.from(this.historicalTrees.entries())
      .filter(([i])=>i>=checkpointIndex-this.config.preserveRecentLeaves)
      .map(([,t])=>t.rootHash);
    return{
      checkpointIndex,
      aggregateHash:tree.rootHash,
      compactedAt:Date.now(),
      preservedLeaves:preserved,
      activeBranchHashes:new Map(Array.from(this.historicalTrees.entries()).map(([i,t])=>[i,t.rootHash]))
    };
  }

  /**
   * Verify proof against compacted state
   */
  public verifyProof(proof:MerkleProof,checkpointIndex:number):boolean{
    const state=this.getCompactedState(checkpointIndex);
    if(!state)return false;
    const root=state.activeBranchHashes.get(checkpointIndex);
    if(!root)return false;
    if(!this.activeTree)return false;const computedRoot=this.activeTree.getRoot();try{MerkleTree.verifyProof({leafHash:computedRoot,proof});return true;}catch{return false;}
  }

  /**
   * Get current memory usage estimate
   */
  public getMemoryUsage():number{
    return this.totalMemoryUsed;
  }

  /**
   * Get checkpoint count
   */
  public getCheckpointCount():number{
    return this.currentCheckpoint+1;
  }

  /**
   * Get configuration
   */
  public getConfig():Readonly<Required<CompactorConfig>>{
    return this.config;
  }
}

export function createMerkleCompactor(config?:CompactorConfig):MerkleCompactor{
  return new MerkleCompactor(config);
}
