import http from 'http';
import { URL } from 'url';

type WitnessSignature = { witnessId: string; signature: string };

type AnchorReq = {
  root: string;
  leafCount: number;
  localUpdatedAt: string;
};

type AnchorResp = {
  sequenceNumber: number;
  anchoringTimestamp: string;
  witnessSignatures: WitnessSignature[];
  root: string;
};

type AuthoritativeState = {
  sequenceNumber: number;
  anchoringTimestamp: string;
  witnessSignatures: WitnessSignature[];
  root: string;
};

const PORT = Number(process.env.MOCK_NOTARY_PORT ?? 8099);
const WITNESSES = Number(process.env.MOCK_NOTARY_WITNESSES ?? 3);

let sequenceNumber = 1;
let authoritative: AuthoritativeState = {
  sequenceNumber,
  anchoringTimestamp: new Date().toISOString(),
  witnessSignatures: [],
  root: ''
};

function buildWitnessSignatures(root: string): WitnessSignature[] {
  const arr: WitnessSignature[] = [];
  for (let i = 0; i < WITNESSES; i++) {
    arr.push({ witnessId: `witness-${i + 1}`, signature: `sig(${root.slice(0, 10)}...)#${sequenceNumber}#${i}` });
  }
  return arr;
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  req.setEncoding('utf8');

  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: string) => {
      data += chunk;
    });

    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : null);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {

  const u = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (req.method === 'POST' && u.pathname === '/notary/anchor') {
      const body = (await readJsonBody(req)) as AnchorReq | null;
      if (!body || typeof body !== 'object' || typeof body.root !== 'string') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid anchor request' }));
        return;
      }

      // Mock consensus behavior: once anchored, we treat the first root seen as authoritative
      // for subsequent requests unless env MOCK_NOTARY_UPDATE_ON_EACH_ANCHOR is set.
      const updateMode = String(process.env.MOCK_NOTARY_UPDATE_ON_EACH_ANCHOR ?? 'false') === 'true';

      if (authoritative.root === '' || updateMode) {
        authoritative.root = body.root;
        authoritative.sequenceNumber = sequenceNumber++;
        authoritative.anchoringTimestamp = new Date().toISOString();
        authoritative.witnessSignatures = buildWitnessSignatures(body.root);
      }

      const out: AnchorResp = {
        sequenceNumber: authoritative.sequenceNumber,
        anchoringTimestamp: authoritative.anchoringTimestamp,
        witnessSignatures: authoritative.witnessSignatures,
        root: authoritative.root
      };

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }

    if (req.method === 'GET' && u.pathname === '/notary/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(authoritative));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal error' }));
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ event: 'mock_notary_started', port: PORT, witnesses: WITNESSES }));
});

