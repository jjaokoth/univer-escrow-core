/**
 * VsockBridgeAdapter
 * Type-safe sockets multiplexer for AF_VSOCK channels (Confidential Computing environments).
 */
import*as net from 'net';
import*as crypto from 'crypto';

export type VsockCid=number&{readonly __brand:'VsockCid'};
export type VsockPort=number&{readonly __brand:'VsockPort'};
export type ConnectionId=string&{readonly __brand:'ConnectionId'};
export type VsockChannelState='CONNECTING'|'CONNECTED'|'DISCONNECTED'|'ERROR';

export interface VsockBridgeConfig{
  devMode?:boolean;
  localCid?:VsockCid;
  defaultPort?:VsockPort;
  connectionTimeoutMs?:number;
  keepAliveEnabled?:boolean;
  keepAliveIntervalMs?:number;
}

export interface VsockConnection{
  readonly connectionId:ConnectionId;
  readonly remoteCid:VsockCid;
  readonly remotePort:VsockPort;
  readonly state:VsockChannelState;
  readonly localAddress:string;
  readonly remoteAddress:string;
  readonly createdAt:number;
  readonly lastActivityAt:number;
}

export interface VsockFrame{
  readonly connectionId:ConnectionId;
  readonly sequenceNumber:number;
  readonly payload:Buffer;
  readonly timestamp:number;
  readonly checksum:string;
}

export interface VsockChannelEvent{
  readonly type:'CONNECTED'|'DISCONNECTED'|'ERROR'|'DATA'|'KEEPALIVE';
  readonly connectionId:ConnectionId;
  readonly timestamp:number;
  readonly data?:VsockFrame;
  readonly error?:Error;
}

export type VsockEventHandler=(event:VsockChannelEvent)=>void|Promise<void>;

interface InternalConnection{
  id:ConnectionId;
  socket:net.Socket;
  remoteCid:VsockCid;
  remotePort:VsockPort;
  state:VsockChannelState;
  createdAt:number;
  lastActivityAt:number;
  sequenceNumber:number;
  handler?:VsockEventHandler;
}

const FRAME_DOMAIN='VSOCK_FRAME_V1';

function generateConnectionId(remoteCid:VsockCid,remotePort:VsockPort):ConnectionId{
  const unique=crypto.randomBytes(8).toString('hex');
  return `${remoteCid}-${remotePort}-${unique}` as ConnectionId;
}

function isValidCid(cid:number):cid is VsockCid{
  return Number.isInteger(cid)&&cid>=0&&cid<=0xffffffff;
}

function isValidPort(port:number):port is VsockPort{
  return Number.isInteger(port)&&port>=1&&port<=0xffff;
}

function computeChecksum(frame:Omit<VsockFrame,'checksum'>):string{
  const data=Buffer.concat([
    Buffer.from(FRAME_DOMAIN),
    Buffer.from(frame.connectionId),
    Buffer.from(String(frame.sequenceNumber)),
    frame.payload,
    Buffer.from(String(frame.timestamp))
  ]);
  return crypto.createHash('sha256').update(data).digest('hex').substring(0,16);
}

export class VsockBridgeAdapter{
  private readonly config:Required<VsockBridgeConfig>;
  private readonly connections:Map<ConnectionId,InternalConnection>=new Map();
  private readonly eventHandlers:Set<VsockEventHandler>=new Set();
  private isRunning:boolean=false;
  private keepAliveTimer?:NodeJS.Timeout;
  private nextConnectionId:number=0;

  constructor(config:VsockBridgeConfig={}){
    this.config={
      devMode:config.devMode??false,
      localCid:(config.localCid as VsockCid) ?? 3,
      defaultPort:(config.defaultPort as VsockPort) ?? 5000,
      connectionTimeoutMs:config.connectionTimeoutMs??30000,
      keepAliveEnabled:config.keepAliveEnabled??true,
      keepAliveIntervalMs:config.keepAliveIntervalMs??10000
    };
  }

  public async start():Promise<void>{
    if(this.isRunning)return;
    this.isRunning=true;
    if(this.config.keepAliveEnabled)this.startKeepAlive();
    this.emitEvent({type:'KEEPALIVE',connectionId:'' as ConnectionId,timestamp:Date.now()});
  }

  public async stop():Promise<void>{
    if(!this.isRunning)return;
    if(this.keepAliveTimer){clearInterval(this.keepAliveTimer);this.keepAliveTimer=undefined;}
    for(const[,conn]of this.connections)this.closeConnection(conn.id,false);
    this.connections.clear();
    this.isRunning=false;
  }

  public async connect(remoteCid:VsockCid,remotePort:VsockPort):Promise<VsockConnection>{
    if(!this.isRunning)throw new Error('VsockBridgeAdapter not started');
    if(!isValidCid(remoteCid))throw new Error(`Invalid VSOCK CID: ${remoteCid}`);
    if(!isValidPort(remotePort))throw new Error(`Invalid VSOCK port: ${remotePort}`);
    const connectionId=generateConnectionId(remoteCid,remotePort);
    const connection:InternalConnection={
      id:connectionId,
      socket:new net.Socket(),
      remoteCid,remotePort,
      state:'CONNECTING',
      createdAt:Date.now(),
      lastActivityAt:Date.now(),
      sequenceNumber:0
    };
    this.connections.set(connectionId,connection);
    connection.socket.on('connect',()=>{
      connection.state='CONNECTED';
      connection.lastActivityAt=Date.now();
      this.emitEvent({type:'CONNECTED',connectionId,timestamp:Date.now()});
    });
    connection.socket.on('error',(err)=>{
      connection.state='ERROR';
      this.emitEvent({type:'ERROR',connectionId,timestamp:Date.now(),error:err});
    });
    connection.socket.on('close',()=>{
      const prevState=connection.state;
      connection.state='DISCONNECTED';
      this.connections.delete(connectionId);
      if(prevState!=='DISCONNECTED'){
        this.emitEvent({type:'DISCONNECTED',connectionId,timestamp:Date.now()});
      }
    });
    connection.socket.on('data',(data)=>{
      connection.lastActivityAt=Date.now();
      const frame:VsockFrame={
        connectionId,sequenceNumber:connection.sequenceNumber++,
        payload:data,timestamp:Date.now(),
        checksum:computeChecksum({connectionId,sequenceNumber:connection.sequenceNumber,payload:data,timestamp:Date.now()})
      };
      this.emitEvent({type:'DATA',connectionId,timestamp:Date.now(),data:frame});
    });
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{
        connection.socket.destroy();
        connection.state='ERROR';
        reject(new Error(`Connection timeout to ${remoteCid}:${remotePort}`));
      },this.config.connectionTimeoutMs);
      if(this.config.devMode){
        const devPort=this.config.defaultPort+ this.nextConnectionId++;
        connection.socket.connect(devPort,'127.0.0.1',()=>{
          clearTimeout(timeout);
          connection.state='CONNECTED';
          resolve(this.toVsockConnection(connection));
        });
      }else{
        const vsockHost=process.env.VSOCK_HOST||'127.0.0.1';
        connection.socket.connect(remotePort,vsockHost,()=>{
          clearTimeout(timeout);
          connection.state='CONNECTED';
          resolve(this.toVsockConnection(connection));
        });
      }
    });
  }

  public disconnect(connectionId:ConnectionId):void{
    const conn=this.connections.get(connectionId);
    if(conn)this.closeConnection(connectionId,true);
  }

  public send(connectionId:ConnectionId,data:Buffer):number{
    const conn=this.connections.get(connectionId);
    if(!conn||conn.state!=='CONNECTED')throw new Error(`Connection ${connectionId} not connected`);
    const written=conn.socket.write(data);
    if(written)conn.lastActivityAt=Date.now();
    return written?data.length:0;
  }

  public getConnections():VsockConnection[]{
    return Array.from(this.connections.values()).map(c=>this.toVsockConnection(c));
  }

  public getConnection(connectionId:ConnectionId):VsockConnection|undefined{
    const conn=this.connections.get(connectionId);
    return conn?this.toVsockConnection(conn):undefined;
  }

  public onEvent(handler:VsockEventHandler):void{this.eventHandlers.add(handler);}
  public offEvent(handler:VsockEventHandler):void{this.eventHandlers.delete(handler);}
  public getConfig():Readonly<Required<VsockBridgeConfig>>{return this.config;}
  public isActive():boolean{return this.isRunning;}
  public getConnectionCount():number{return this.connections.size;}

  private toVsockConnection(conn:InternalConnection):VsockConnection{
    const localAddress=conn.socket.localAddress||'127.0.0.1';
    const remoteAddress=conn.socket.remoteAddress||`${conn.remoteCid}:${conn.remotePort}`;
    return{
      connectionId:conn.id,remoteCid:conn.remoteCid,remotePort:conn.remotePort,
      state:conn.state,localAddress,remoteAddress,
      createdAt:conn.createdAt,lastActivityAt:conn.lastActivityAt
    };
  }

  private closeConnection(connectionId:ConnectionId,emit:boolean):void{
    const conn=this.connections.get(connectionId);
    if(!conn)return;
    conn.socket.destroy();
    conn.state='DISCONNECTED';
    this.connections.delete(connectionId);
    if(emit)this.emitEvent({type:'DISCONNECTED',connectionId,timestamp:Date.now()});
  }

  private emitEvent(event:VsockChannelEvent):void{
    for(const handler of this.eventHandlers){try{handler(event);}catch{}}
  }

  private startKeepAlive():void{
    this.keepAliveTimer=setInterval(()=>{
      this.emitEvent({type:'KEEPALIVE',connectionId:'' as ConnectionId,timestamp:Date.now()});
    },this.config.keepAliveIntervalMs);
  }
}

export function createVsockBridgeAdapter(config?:VsockBridgeConfig):VsockBridgeAdapter{
  return new VsockBridgeAdapter(config);
}

export const VSOCK_CID={LOCAL:2,HOST:3,ANY:0xffffffff}as const;
export const VSOCK_PORT={MIN:1,MAX:0xffff,EPHEMERAL_START:0x8000,EPHEMERAL_END:0xffff}as const;
