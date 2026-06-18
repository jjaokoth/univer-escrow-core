/**
 * ClusterMembershipManager
 * Node-lifecycle coordinator for BFT consensus cluster eviction.
 */
import type {NodeId}from './EnclaveBftVerifyEngine.js';

// Node status
export type NodeStatus='ACTIVE'|'OFFLINE'|'SUSPECTED'|'EVICTED'|'JOINING';

// Cluster node representation
export interface ClusterNode{
  nodeId:NodeId;
  status:NodeStatus;
  joinedAt:number;
  lastHeartbeat:number;
  failureCount:number;
  attestationValid:boolean;
}

// Eviction proposal
export interface EvictionProposal{
  proposalId:string;
  targetNodeId:NodeId;
  proposerNodeId:NodeId;
  reason:string;
  timestamp:number;
  approved:boolean;
  approvalVotes:NodeId[];
  rejectionVotes:NodeId[];
}

// Cluster state
export interface ClusterState{
  clusterSize:number;
  f:number;
  threshold:number;
  activeNodes:ClusterNode[];
  currentTerm:number;
}

// Configuration
export interface MembershipConfig{
  maxFailureCount:number;
  heartbeatTimeoutMs:number;
  evictionApprovalThreshold:number;
  enableAutoEviction:boolean;
}

// Domain separator
const MEMBER_DOMAIN='CLUSTER_MEMBER_V1';

function hashNode(nodeId:NodeId,term:number):string{
  return Buffer.from(`${MEMBER_DOMAIN}|${nodeId}|${term}`).toString('hex');
}

export class ClusterMembershipManager{
  private readonly config:Required<MembershipConfig>;
  private nodes:Map<NodeId,ClusterNode>=new Map();
  private evictionProposals:Map<string,EvictionProposal>=new Map();
  private currentTerm:number=0;
  private leaderNodeId?:NodeId;
  private localNodeId?:NodeId;

  constructor(config:MembershipConfig={
    maxFailureCount:3,
    heartbeatTimeoutMs:30000,
    evictionApprovalThreshold:0.67,
    enableAutoEviction:true
  }){
    this.config={
      maxFailureCount:config.maxFailureCount??3,
      heartbeatTimeoutMs:config.heartbeatTimeoutMs??30000,
      evictionApprovalThreshold:config.evictionApprovalThreshold??0.67,
      enableAutoEviction:config.enableAutoEviction??true
    };
  }

  /**
   * Initialize local node
   */
  public initializeLocalNode(nodeId:NodeId):void{
    this.localNodeId=nodeId;
    this.nodes.set(nodeId,{
      nodeId,status:'ACTIVE',joinedAt:Date.now(),
      lastHeartbeat:Date.now(),failureCount:0,attestationValid:true
    });
  }

  /**
   * Register a new node
   */
  public registerNode(nodeId:NodeId,attestationValid:boolean=true):void{
    if(this.nodes.has(nodeId))return;
    this.nodes.set(nodeId,{
      nodeId,status:'JOINING',joinedAt:Date.now(),
      lastHeartbeat:Date.now(),failureCount:0,attestationValid
    });
  }

  /**
   * Update node heartbeat
   */
  public updateHeartbeat(nodeId:NodeId):void{
    const node=this.nodes.get(nodeId);
    if(!node)return;
    node.lastHeartbeat=Date.now();
    node.failureCount=0;
    if(node.status==='SUSPECTED')node.status='ACTIVE';
  }

  /**
   * Record node failure
   */
  public recordFailure(nodeId:NodeId):void{
    const node=this.nodes.get(nodeId);
    if(!node)return;
    node.failureCount++;
    if(node.failureCount>=this.config.maxFailureCount){
      node.status='SUSPECTED';
    }
  }

  /**
   * Propose node eviction
   */
  public proposeNodeEviction(nodeId:NodeId,reason:string='attestation_failure'):EvictionProposal{
    if(!this.localNodeId)throw new Error('Local node not initialized');
    const target=this.nodes.get(nodeId);
    if(!target)throw new Error(`Node ${nodeId} not found`);
    if(target.status==='EVICTED')throw new Error(`Node ${nodeId} already evicted`);
    const proposalId=`evict-${nodeId}-${Date.now()}`;
    const proposal:EvictionProposal={
      proposalId,targetNodeId:nodeId,proposerNodeId:this.localNodeId,
      reason,timestamp:Date.now(),approved:false,approvalVotes:[],rejectionVotes:[]
    };
    this.evictionProposals.set(proposalId,proposal);
    return proposal;
  }

  /**
   * Vote on eviction proposal
   */
  public voteEviction(proposalId:NodeId,approve:boolean):boolean{
    const proposal=this.evictionProposals.get(proposalId);
    if(!proposal)return false;
    if(approve){
      proposal.approvalVotes.push(this.localNodeId!);
    }else{
      proposal.rejectionVotes.push(this.localNodeId!);
    }
    const totalVoters=this.getActiveNodeCount();
    const approvalRatio=proposal.approvalVotes.length/totalVoters;
    if(approvalRatio>=this.config.evictionApprovalThreshold){
      proposal.approved=true;
      this.evictNode(proposal.targetNodeId);
    }
    return proposal.approved;
  }

  /**
   * Execute node eviction
   */
  private evictNode(nodeId:NodeId):void{
    const node=this.nodes.get(nodeId);
    if(node){
      node.status='EVICTED';
    }
  }

  /**
   * Finalize eviction after quorum
   */
  public finalizeEviction(proposalId:string):boolean{
    const proposal=this.evictionProposals.get(proposalId);
    if(!proposal||!proposal.approved)return false;
    this.evictNode(proposal.targetNodeId);
    return true;
  }

  /**
   * Calculate BFT threshold (2f+1)
   */
  public calculateThreshold():{clusterSize:number,f:number,threshold:number}{
    const clusterSize=this.getActiveNodeCount();
    const f=Math.floor((clusterSize-1)/3);
    const threshold=2*f+1;
    return{clusterSize,f,threshold};
  }

  /**
   * Get active node count
   */
  public getActiveNodeCount():number{
    return Array.from(this.nodes.values()).filter(n=>n.status==='ACTIVE'||n.status==='JOINING').length;
  }

  /**
   * Get cluster state
   */
  public getClusterState():ClusterState{
    const{clusterSize,f,threshold}=this.calculateThreshold();
    return{
      clusterSize,f,threshold,
      activeNodes:Array.from(this.nodes.values()).filter(n=>n.status!=='EVICTED'),
      currentTerm:this.currentTerm
    };
  }

  /**
   * Get node by ID
   */
  public getNode(nodeId:NodeId):ClusterNode|undefined{
    return this.nodes.get(nodeId);
  }

  /**
   * Get all active nodes
   */
  public getActiveNodes():ClusterNode[]{
    return Array.from(this.nodes.values()).filter(n=>n.status==='ACTIVE');
  }

  /**
   * Set leader
   */
  public setLeader(nodeId:NodeId):void{
    this.leaderNodeId=nodeId;
    this.currentTerm++;
  }

  /**
   * Get leader
   */
  public getLeader():NodeId|undefined{
    return this.leaderNodeId;
  }

  /**
   * Check if node is active
   */
  public isNodeActive(nodeId:NodeId):boolean{
    const node=this.nodes.get(nodeId);
    return node?.status==='ACTIVE';
  }

  /**
   * Get config
   */
  public getConfig():Readonly<Required<MembershipConfig>>{
    return this.config;
  }
}

export function createClusterMembershipManager(config?:MembershipConfig):ClusterMembershipManager{
  return new ClusterMembershipManager(config);
}
