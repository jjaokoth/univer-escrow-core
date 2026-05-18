"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PaymentFactory = void 0;
const MpesaAdapter_1 = require("../adapters/MpesaAdapter");
class PaymentFactory {
    /**
     * Resolves explicit implementation instances bound to unified contract definitions
     */
    static getProvider(providerType) {
        const canonicalType = providerType.toUpperCase().trim();
        switch (canonicalType) {
            case 'MPESA':
                return new MpesaAdapter_1.MpesaAdapter();
            default:
                throw new Error(`Execution Fault: Payment gateway provider [${providerType}] is unsupported or unauthorized.`);
        }
    }
}
exports.PaymentFactory = PaymentFactory;
