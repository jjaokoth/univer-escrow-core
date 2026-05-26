import dotenv from 'dotenv';
dotenv.config();

export class MobileGatewayClient {
    private settlementAccount: string;

    constructor() {
        // Dynamically resolve the account route from our isolated local environment
        this.settlementAccount = process.env.SETTLEMENT_ACCOUNT || "FALLBACK_POOL";
    }

    public async initiateTransaction(amount: number, tenantId: string): Promise<object> {
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
