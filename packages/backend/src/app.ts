/**
 * © 2026 Securerise Solutions Limited
 * Lead Architect: Joshua Joel A Okoth (securerise@outlook.com)
 * 
 * PROPRIETARY AND CONFIDENTIAL: This code is the intellectual property of 
 * Securerise Solutions Limited. Unauthorized copying or distribution 
 * is strictly prohibited under the CC BY-NC-ND 4.0 International License.
 */

import express from 'express';

import cors from 'cors';

import helmet from 'helmet';
import { json } from 'body-parser';
import privacyMiddleware from './middleware/privacyMiddleware';
import apiKeyMiddleware from './middleware/apiKeyMiddleware';
import internalApiKeyMiddleware from './middleware/internalApiKeyMiddleware';
import { logger } from './lib/logger';
import { PayoutController } from './controllers/payoutController';
import { EscrowController } from './controllers/escrowController';
import { EscrowService } from './services/escrowService';
import { PayoutProofController } from './controllers/payoutProofController';
import paymentRouter from './routes/paymentRoutes';

export const app = express();


// BigInt serialization polyfill (prevents JSON.stringify errors)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

// Middleware
app.use(cors());
app.use(helmet());


app.use(json());
app.use(privacyMiddleware);
app.use('/api', apiKeyMiddleware);

// Payment routes (consolidated)
// Mount the tenant-protected handshake API under the v1 path.
// Web: POST /api/v1/handshake/create
// Mobile: POST /api/v1/handshake/verify
app.use('/api/v1/handshake', paymentRouter);


// Health
app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

// Routes
const escrowController = new EscrowController(new EscrowService());

app.post('/api/escrow', internalApiKeyMiddleware, (req, res) => escrowController.createEscrow(req, res));
app.get('/api/escrow/:id', internalApiKeyMiddleware, (req, res) => escrowController.getEscrow(req, res));
app.put('/api/escrow/:id', internalApiKeyMiddleware, (req, res) => escrowController.updateEscrow(req, res));
app.delete('/api/escrow/:id', internalApiKeyMiddleware, (req, res) => escrowController.deleteEscrow(req, res));

const payoutController = new PayoutController();
app.post('/api/payout/handshakes/:handshakeId/process', internalApiKeyMiddleware, (req, res) =>
  payoutController.processUniversal(req, res)
);

// Verify Proof-of-Delivery (AI Trust Service) then process handshake.
const payoutProofController = new PayoutProofController();
app.post(
  '/api/payout/handshakes/:handshakeId/verify-proof',
  internalApiKeyMiddleware,
  (req, res) => payoutProofController.verifyAndProcess(req, res)
);

// Error handling
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error({ message: err?.message, stack: err?.stack });
  res.status(500).json({ error: 'Internal Server Error' });
});

