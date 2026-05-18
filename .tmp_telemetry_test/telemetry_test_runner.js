/* eslint-disable no-console */
const { TelemetryPublisherService } = require('../securerise/packages/backend/dist/services/TelemetryPublisherService');

(async () => {
  // If dist is not built, fallback to ts-node/register is not guaranteed.
  // So we require the TS file through ts-node if available.
})();
