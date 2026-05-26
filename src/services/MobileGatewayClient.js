"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MobileGatewayClient = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
class MobileGatewayClient {
    constructor() {
        // Dynamically resolve the account route from our isolated local environment
        this.settlementAccount = process.env.SETTLEMENT_ACCOUNT || "FALLBACK_POOL";
    }
    async initiateTransaction(amount, tenantId) {
        console.log(`[INGRESS] Processing transaction of KSH ${amount} for Tenant: ${tenantId}`);
        if (this.settlementAccount === "FALLBACK_POOL") {
            throw new Error("CRITICAL: Settlement account environment variable is not configured.");
        }
        // Simulate secure transaction payload generation
        return {
            status: "VALIDATED",
            tenant: tenantId,
            routingTarget: this.settlementAccount,
            timestamp: new Date().toISOString()
        };
    }
}
exports.MobileGatewayClient = MobileGatewayClient;
