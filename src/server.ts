import express, { Request, Response } from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { EscrowRouter } from './services/EscrowRouter';

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());

// Target the root public folder from compiled dist/src/ location
const publicPath = path.join(__dirname, '../../public');

// Serve dashboard static assets
app.use(express.static(publicPath));

// Register API backend routes
app.use('/api/escrow', EscrowRouter);

// System health mapping
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
});

// Serve index.html as the root fallback route
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
