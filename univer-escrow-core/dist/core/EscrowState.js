"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EscrowStatus = void 0;
var EscrowStatus;
(function (EscrowStatus) {
    EscrowStatus["PENDING"] = "PENDING";
    EscrowStatus["LOCKED"] = "LOCKED";
    EscrowStatus["DISPUTED"] = "DISPUTED";
    EscrowStatus["RELEASED"] = "RELEASED";
    EscrowStatus["REFUNDED"] = "REFUNDED";
})(EscrowStatus || (exports.EscrowStatus = EscrowStatus = {}));
