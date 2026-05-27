import express, { Request, Response } from 'express';
import path from 'path';
import dotenv from 'dotenv';
import * as EscrowModule from './services/EscrowRouter';
import { AuditLogger } from './services/AuditLogger';

dotenv.config();
const app = express();
const port = process.env.PORT || 8080;
app.use(express.json());

const publicPath = path.join(__dirname, '../../public');
app.use(express.static(publicPath));

let routerMiddleware: any = EscrowModule.EscrowRouter || (EscrowModule as any).default || EscrowModule;
if (routerMiddleware && routerMiddleware.router) routerMiddleware = routerMiddleware.router;

if (typeof routerMiddleware === 'function' || (routerMiddleware && typeof routerMiddleware.use === 'function')) {
  app.use('/api/escrow', routerMiddleware);
}

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
});

app.get('*', (req: Request, res: Response) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

app.listen(port, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'server_started', level: 'INFO', port: Number(port), runtime: 'node-http-native' }));
});
