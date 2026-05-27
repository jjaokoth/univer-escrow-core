import express, { Request, Response } from 'express';
import path from 'path';
import dotenv from 'dotenv';
import * as EscrowModule from './services/EscrowRouter';

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());

// Target the root public folder relative to the compiled app location
const publicPath = path.join(__dirname, '../../public');
app.use(express.static(publicPath));

// Inspect and safely extract the active middleware router instance
let routerMiddleware: any = null;

if (EscrowModule.EscrowRouter) {
  routerMiddleware = EscrowModule.EscrowRouter;
} else if ((EscrowModule as any).default) {
  routerMiddleware = (EscrowModule as any).default;
} else {
  routerMiddleware = EscrowModule;
}

// Extract nested properties if exported inside an object wrapper
if (routerMiddleware && routerMiddleware.router) {
  routerMiddleware = routerMiddleware.router;
}

// Mount verified middleware route tree safely
if (typeof routerMiddleware === 'function' || (routerMiddleware && typeof routerMiddleware.use === 'function')) {
  app.use('/api/escrow', routerMiddleware);
} else {
  console.error("CRITICAL: EscrowRouter could not be parsed as a valid middleware function.");
}

// Health check endpoint mapping
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
});

// Fallback route to serve the dashboard UI directly
app.get('*', (req: Request, res: Response) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

app.listen(port, () => {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event: "server_started",
    level: "INFO",
    port: Number(port),
    runtime: "node-http-native"
  }));
});
