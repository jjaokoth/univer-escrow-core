"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecureStorageService = void 0;
function assertNonEmptyString(value, name) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new TypeError(`${name} must be a non-empty string`);
    }
}
function assertKeychainLoaded(value) {
    if (!value || typeof value !== "object") {
        throw new Error("react-native-keychain is not available in this runtime");
    }
}
async function loadKeychain() {
    const mod = await Promise.resolve().then(() => __importStar(require("react-native-keychain")));
    assertKeychainLoaded(mod);
    return mod;
}
class SecureStorageService {
    constructor(accountId = "univer-escrow-session") {
        this.accountId = accountId;
        assertNonEmptyString(accountId, "accountId");
    }
    async lock(token) {
        assertNonEmptyString(token, "token");
        const Keychain = await loadKeychain();
        await Keychain.setGenericPassword(this.accountId, token, {
            service: this.accountId
        });
    }
    async retrieve() {
        const Keychain = await loadKeychain();
        const result = await Keychain.getGenericPassword({ service: this.accountId });
        if (!result)
            return null;
        if (typeof result.password !== "string" || result.password.trim().length === 0)
            return null;
        return result.password;
    }
    async wipe() {
        const Keychain = await loadKeychain();
        await Keychain.resetGenericPassword({ service: this.accountId });
    }
}
exports.SecureStorageService = SecureStorageService;
